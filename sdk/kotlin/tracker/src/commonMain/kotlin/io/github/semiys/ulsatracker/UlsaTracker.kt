package io.github.semiys.ulsatracker

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.CoroutineContext
import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.Instant

/** One owner per queue. All disk and delivery work is performed outside callers' UI thread. */
class UlsaTracker internal constructor(
    private val config: TrackerConfig,
    private val storage: TrackerStorage,
    private val transport: TrackerTransport,
    private val platform: String,
    context: CoroutineContext = Dispatchers.Default,
    private val clockMillis: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    private val nextId: () -> String = ::newEventId,
    private val jitter: (Long) -> Long = { Random.nextLong(it / 4 + 1) },
    private val afterClose: () -> Unit = {},
) {
    companion object {
        /** Custom adapters are useful for additional platforms; Android has createAndroidTracker. */
        fun create(config: TrackerConfig, storage: TrackerStorage, transport: TrackerTransport, platform: String): UlsaTracker =
            UlsaTracker(config, storage, transport, platform)
    }

    private sealed interface Command {
        data class Track(val id: String, val at: Long, val name: String, val screen: String?, val properties: JsonObject) : Command
        data object Flush : Command
        data object Foreground : Command
        data object Background : Command
        data class Enable(val enabled: Boolean) : Command
        data object Tick : Command
        data object Retry : Command
        data class Delivered(val epoch: Long, val batch: List<TrackerEvent>, val result: DeliveryResponse) : Command
        data class Close(val done: CompletableDeferred<Unit>) : Command
    }

    private val owner = SupervisorJob(context[Job])
    private val scope = CoroutineScope(context + owner)
    private val commands = Channel<Command>(256)
    private val requestedEnabled = MutableStateFlow(config.initiallyEnabled)
    private val enableTouched = MutableStateFlow(false)
    private val inputDrops = MutableStateFlow(0L)
    private val closing = MutableStateFlow(false)
    private val statusState = MutableStateFlow(TrackerStatus(enabled = config.initiallyEnabled))
    val status: StateFlow<TrackerStatus> = statusState.asStateFlow()

    // Only the command worker mutates delivery and persisted state.
    private var state = QueueState(enabled = config.initiallyEnabled)
    private var storageReady = false
    private var loaded = false
    private var foreground = false
    private var backgroundAt: Long? = null
    private var sessionId = nextId()
    private var timer: Job? = null
    private var sender: Job? = null
    private var retry: Job? = null
    private var epoch = 0L
    private var flushRequested = false
    private var unauthorized = false
    private var attempts = 0
    private var nextRetryAt = 0L
    private var effectiveBatchSize = config.batchSize

    init { require(platform in listOf("android", "ios", "web")) }

    private val worker = scope.launch {
        try {
            initialize()
            for (command in commands) {
                when (command) {
                    is Command.Track -> record(command)
                    Command.Flush -> { flushRequested = true; startDelivery(newCycle = true) }
                    Command.Tick -> startDelivery(newCycle = true)
                    Command.Retry -> startDelivery()
                    Command.Foreground -> {
                        if (!foreground) {
                            if (backgroundAt?.let { clockMillis() - it >= 30 * 60_000 } == true) sessionId = nextId()
                            foreground = true
                            timer = scope.launch { while (isActive) { delay(config.flushIntervalMillis); commands.send(Command.Tick) } }
                        }
                        startDelivery(newCycle = true)
                    }
                    Command.Background -> {
                        if (foreground) backgroundAt = clockMillis()
                        foreground = false; timer?.cancel(); timer = null
                        flushRequested = true; startDelivery(newCycle = true)
                    }
                    is Command.Enable -> changeEnabled(command.enabled)
                    is Command.Delivered -> if (command.epoch == epoch) delivered(command)
                    is Command.Close -> {
                        sender?.cancelAndJoin(); timer?.cancel(); retry?.cancel()
                        command.done.complete(Unit)
                        break
                    }
                }
            }
        } finally {
            commands.close()
            sender?.cancel(); timer?.cancel(); retry?.cancel()
            try { transport.close() }
            finally {
                try { withContext(NonCancellable) { storage.close() } }
                finally { try { afterClose() } finally { owner.cancel() } }
            }
        }
    }

    /** Returns false when disabled, invalid or when the bounded input queue is full. */
    fun track(name: String, screen: String? = null, properties: Map<String, Any?> = emptyMap()): Boolean {
        if (!owner.isActive || closing.value || !requestedEnabled.value) return false
        val values = try {
            require(eventName.matches(name) && (screen == null || eventName.matches(screen)))
            encodeProperties(properties)
        } catch (_: Exception) {
            statusState.update { it.copy(lastError = TrackerError.INVALID_EVENT) }
            return false
        }
        val command = Command.Track(nextId(), clockMillis(), name, screen, values)
        if (commands.trySend(command).isSuccess) return true
        inputDrops.update { it + 1 }
        statusState.update { it.copy(dropped = it.dropped + 1, lastError = TrackerError.INPUT_QUEUE_FULL) }
        return false
    }

    fun screen(name: String): Boolean = track("screen_view", name)
    fun click(button: String, screen: String? = null): Boolean = track("button_click", screen, mapOf("button" to button))
    fun flush() = control(Command.Flush)
    fun onForeground() = control(Command.Foreground)
    fun onBackground() = control(Command.Background)

    fun setCollectionEnabled(enabled: Boolean) {
        enableTouched.value = true
        requestedEnabled.value = enabled
        control(Command.Enable(enabled))
    }

    suspend fun close() {
        if (!closing.compareAndSet(false, true)) { worker.join(); return }
        if (!worker.isActive) { worker.join(); return }
        val done = CompletableDeferred<Unit>()
        try { commands.send(Command.Close(done)); done.await() }
        catch (_: kotlinx.coroutines.channels.ClosedSendChannelException) { }
        worker.join()
    }

    private fun control(command: Command) {
        if (!owner.isActive || closing.value) return
        if (commands.trySend(command).isSuccess) return
        scope.launch {
            try { commands.send(command) } catch (_: kotlinx.coroutines.channels.ClosedSendChannelException) { }
        }
    }

    private suspend fun initialize() {
        try {
            val saved = storage.read()?.let { trackerJson.decodeFromString<QueueState>(it) } ?: state
            require(saved.schemaVersion == 1 && saved.dropped >= 0 && saved.rejected >= 0)
            require(saved.events.size <= 10_000 && saved.events.map { it.eventId }.distinct().size == saved.events.size)
            saved.events.forEach {
                require(eventName.matches(it.name) && (it.screen == null || eventName.matches(it.screen)))
                require(it.platform in listOf("android", "ios", "web") && it.appVersion.length in 1..32)
                Instant.parse(it.occurredAt)
                require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(it.eventId))
            }
            state = saved; loaded = true
            if (!enableTouched.value) requestedEnabled.value = requestedEnabled.value && saved.enabled
            val initial = if (!requestedEnabled.value) saved.copy(enabled = false, events = emptyList()) else prune(saved)
            commit(initial)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { storageReady = false; publish(TrackerError.STORAGE) }
    }

    private fun prune(source: QueueState): QueueState {
        val earliest = clockMillis() - config.retentionMillis
        val fresh = source.events.filter { Instant.parse(it.occurredAt).toEpochMilliseconds() >= earliest }
        val retained = fresh.takeLast(config.maxQueuedEvents)
        return source.copy(events = retained, dropped = source.dropped + source.events.size - retained.size)
    }

    private suspend fun commit(candidate: QueueState): Boolean {
        return try {
            storage.write(trackerJson.encodeToString(candidate))
            state = candidate; storageReady = true; publish()
            true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { storageReady = false; publish(TrackerError.STORAGE); false }
    }

    private fun publish(error: TrackerError? = null) {
        statusState.update { it.copy(ready = storageReady, enabled = requestedEnabled.value && state.enabled, queued = state.events.size, dropped = state.dropped + inputDrops.value, rejected = state.rejected, sending = sender != null, lastError = error) }
    }

    private suspend fun record(command: Command.Track) {
        if (!requestedEnabled.value || !state.enabled) return
        if (!storageReady) { inputDrops.update { it + 1 }; publish(TrackerError.STORAGE); return }
        val event = TrackerEvent(command.id, sessionId, Instant.fromEpochMilliseconds(command.at).toString(), command.name, command.screen, platform, config.appVersion, command.properties)
        if (!commit(prune(state.copy(events = state.events + event)))) {
            inputDrops.update { it + 1 }; publish(TrackerError.STORAGE); return
        }
        if (foreground && state.events.size >= effectiveBatchSize) startDelivery()
    }

    private suspend fun changeEnabled(enabled: Boolean) {
        epoch++
        sender?.cancelAndJoin(); sender = null; retry?.cancel(); retry = null
        flushRequested = false; unauthorized = false; attempts = 0; nextRetryAt = 0
        if (enabled && !loaded) { publish(TrackerError.STORAGE); return }
        if (!enabled) loaded = true // Explicit opt out clears even an unreadable journal.
        if (enabled) sessionId = nextId()
        commit(state.copy(enabled = enabled, events = if (enabled) state.events else emptyList()))
        if (enabled && foreground) startDelivery()
    }

    private suspend fun startDelivery(newCycle: Boolean = false) {
        if (!loaded) return
        // Keep the slot until the worker processes ACK, even if the HTTP coroutine already finished.
        if (!requestedEnabled.value || !state.enabled || unauthorized || sender != null) return
        if ((!foreground && !flushRequested) || clockMillis() < nextRetryAt) return
        if (!storageReady || prune(state) != state) if (!commit(prune(state))) return
        if (state.events.isEmpty()) { flushRequested = false; publish(); return }
        if (newCycle) attempts = 0
        if (attempts >= 3) return
        var batch = state.events.take(effectiveBatchSize)
        var json = trackerJson.encodeToString(EventBatch(events = batch))
        while (json.encodeToByteArray().size > 60 * 1_024 && batch.size > 1) {
            batch = batch.dropLast(1); json = trackerJson.encodeToString(EventBatch(events = batch))
        }
        val currentEpoch = epoch
        attempts++
        sender = scope.launch {
            val result = try { transport.send(json) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { DeliveryResponse.Retry(TrackerError.NETWORK) }
            commands.send(Command.Delivered(currentEpoch, batch, result))
        }
        publish()
    }

    private suspend fun delivered(command: Command.Delivered) {
        sender = null
        when (val response = command.result) {
            is DeliveryResponse.Acknowledged -> {
                val ids = command.batch.map { it.eventId }.toSet()
                val valid = response.schemaVersion == 1 && response.accepted >= 0 && response.duplicates >= 0 && response.accepted.toLong() + response.duplicates == command.batch.size.toLong() && response.ids.size == ids.size && response.ids.toSet() == ids
                if (!valid) { scheduleRetry(TrackerError.INVALID_ACK); return }
                if (!commit(state.copy(events = state.events.filterNot { it.eventId in ids }))) { scheduleRetry(TrackerError.STORAGE); return }
                attempts = 0; nextRetryAt = 0; retry?.cancel(); retry = null
                startDelivery()
            }
            is DeliveryResponse.Retry -> scheduleRetry(response.reason, response.afterMillis)
            DeliveryResponse.InvalidAcknowledgement -> scheduleRetry(TrackerError.INVALID_ACK)
            DeliveryResponse.Unauthorized -> { unauthorized = true; flushRequested = false; publish(TrackerError.UNAUTHORIZED) }
            DeliveryResponse.TooLarge -> {
                if (command.batch.size > 1) { effectiveBatchSize = (command.batch.size / 2).coerceAtLeast(1); attempts = 0; startDelivery() }
                else reject(command.batch.first().eventId)
            }
            is DeliveryResponse.Rejected -> {
                val invalid = response.eventIndex?.let { command.batch.getOrNull(it) }
                if (invalid != null || command.batch.size == 1) reject((invalid ?: command.batch.first()).eventId)
                else { effectiveBatchSize = 1; attempts = 0; startDelivery() }
            }
        }
    }

    private suspend fun reject(id: String) {
        val removed = state.events.count { it.eventId == id }
        if (!commit(state.copy(events = state.events.filterNot { it.eventId == id }, rejected = state.rejected + removed))) { scheduleRetry(TrackerError.STORAGE); return }
        attempts = 0; publish(TrackerError.REJECTED_EVENT); startDelivery()
    }

    private fun scheduleRetry(error: TrackerError, afterMillis: Long = 0) {
        val base = 1_000L * (1L shl (attempts - 1).coerceIn(0, 5))
        val pause = maxOf(afterMillis.coerceAtLeast(0), base + jitter(base), if (attempts >= 3) config.flushIntervalMillis else 0)
        nextRetryAt = clockMillis() + pause
        publish(error)
        retry?.cancel()
        if (attempts < 3) retry = scope.launch { delay(pause); commands.send(Command.Retry) }
    }
}

internal expect fun newEventId(): String

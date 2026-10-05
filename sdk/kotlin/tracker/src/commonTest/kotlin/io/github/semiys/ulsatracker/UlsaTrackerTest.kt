package io.github.semiys.ulsatracker

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

internal class MemoryStorage : TrackerStorage {
    var value: String? = null
    var failWrites = false
    override suspend fun read() = value
    override suspend fun write(state: String) { check(!failWrites); value = state }
    fun events() = value?.let { trackerJson.decodeFromString<QueueState>(it).events }.orEmpty()
}

internal class RecordingTransport : TrackerTransport {
    val requests = mutableListOf<String>()
    var respond: suspend (List<TrackerEvent>) -> DeliveryResponse = { events ->
        DeliveryResponse.Acknowledged(events.map { it.eventId }, events.size, 0, 1)
    }
    override suspend fun send(json: String): DeliveryResponse {
        requests += json
        return respond(trackerJson.decodeFromString<EventBatch>(json).events)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class UlsaTrackerTest {
    private fun TestScope.tracker(storage: MemoryStorage, transport: RecordingTransport, config: TrackerConfig = config()) =
        UlsaTracker(config, storage, transport, "android", backgroundScope.coroutineContext,
            clockMillis = { 1_790_000_000_000 + testScheduler.currentTime }, jitter = { 0 })

    private fun config(batch: Int = 2, capacity: Int = 100, retention: Long = 604_800_000) =
        TrackerConfig("https://example.com", "x".repeat(64), "1.0", batchSize = batch, maxQueuedEvents = capacity, retentionMillis = retention)

    @Test fun `batch is persisted before delivery and only matching ACK removes it`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport)
        transport.respond = { events ->
            assertEquals(events, storage.events())
            DeliveryResponse.Acknowledged(events.map { it.eventId }, events.size, 0, 1)
        }
        tracker.onForeground(); runCurrent()
        assertTrue(tracker.screen("collection")); runCurrent()
        assertEquals(1, storage.events().size); assertEquals(0, transport.requests.size)
        tracker.click("add_model", "collection"); runCurrent()
        assertEquals(1, transport.requests.size); assertEquals(0, storage.events().size)
        tracker.close()
    }

    @Test fun `completed response is acknowledged before another batch starts`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport, config(batch = 1))
        transport.respond = { events ->
            // New input arrives before Delivered reaches the worker.
            if (transport.requests.size == 1) repeat(5) { tracker.click("while_ack_is_pending") }
            DeliveryResponse.Acknowledged(events.map { it.eventId }, events.size, 0, 1)
        }
        tracker.onForeground(); tracker.screen("collection"); runCurrent()
        val ids = transport.requests.flatMap { trackerJson.decodeFromString<EventBatch>(it).events }.map { it.eventId }
        assertEquals(6, ids.size)
        assertEquals(6, ids.distinct().size)
        assertEquals(0, storage.events().size)
        tracker.close()
    }

    @Test fun `lost response and restart retry the same IDs and timestamp`() = runTest {
        val storage = MemoryStorage(); val firstTransport = RecordingTransport()
        firstTransport.respond = { DeliveryResponse.Retry(TrackerError.NETWORK) }
        val first = tracker(storage, firstTransport, config(batch = 1))
        first.onForeground(); first.click("add_model"); runCurrent()
        val original = firstTransport.requests.single()
        first.close()
        val secondTransport = RecordingTransport()
        val second = tracker(storage, secondTransport, config(batch = 1))
        second.onForeground(); runCurrent()
        assertEquals(original, secondTransport.requests.single())
        assertEquals(0, storage.events().size)
        second.close()
    }

    @Test fun `429 respects delay even when flush is requested repeatedly`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        transport.respond = { DeliveryResponse.Retry(TrackerError.RATE_LIMIT, 16_000) }
        val tracker = tracker(storage, transport, config(batch = 1))
        tracker.onForeground(); tracker.screen("collection"); runCurrent()
        repeat(5) { tracker.flush() }; runCurrent()
        advanceTimeBy(15_999); runCurrent(); assertEquals(1, transport.requests.size)
        advanceTimeBy(1); runCurrent(); assertEquals(2, transport.requests.size)
        assertEquals(transport.requests[0], transport.requests[1])
        tracker.close()
    }

    @Test fun `wrong acknowledgement retains queue and retries only three times per cycle`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        transport.respond = { DeliveryResponse.Acknowledged(listOf("unknown-id"), 1, 0, 1) }
        val tracker = tracker(storage, transport, config(batch = 1))
        tracker.onForeground(); tracker.screen("collection"); runCurrent()
        advanceTimeBy(1_000); runCurrent(); advanceTimeBy(2_000); runCurrent()
        assertEquals(3, transport.requests.size); assertEquals(1, storage.events().size)
        advanceTimeBy(10_000); runCurrent(); assertEquals(3, transport.requests.size)
        assertEquals(TrackerError.INVALID_ACK, tracker.status.value.lastError)
        tracker.close()
    }

    @Test fun `invalid row is isolated while later events are delivered`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        transport.respond = { events ->
            if (events.any { it.name == "bad_event" }) DeliveryResponse.Rejected(events.indexOfFirst { it.name == "bad_event" })
            else DeliveryResponse.Acknowledged(events.map { it.eventId }, events.size, 0, 1)
        }
        val tracker = tracker(storage, transport)
        tracker.onForeground(); tracker.track("bad_event"); tracker.screen("collection"); runCurrent()
        assertEquals(2, transport.requests.size); assertEquals(0, storage.events().size)
        assertEquals(1L, tracker.status.value.rejected)
        tracker.close()
    }

    @Test fun `opt out cancels delivery clears persisted queue and survives restart`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val pending = CompletableDeferred<DeliveryResponse>()
        transport.respond = { pending.await() }
        val tracker = tracker(storage, transport, config(batch = 1))
        tracker.onForeground(); tracker.screen("collection"); runCurrent()
        tracker.setCollectionEnabled(false)
        assertFalse(tracker.screen("profile"))
        runCurrent(); assertEquals(0, storage.events().size)
        assertFalse(tracker.status.value.enabled)
        tracker.close()
        val secondTransport = RecordingTransport()
        val second = tracker(storage, secondTransport)
        second.onForeground(); runCurrent()
        assertFalse(second.click("add_model")); assertEquals(0, secondTransport.requests.size)
        second.setCollectionEnabled(true); runCurrent()
        assertTrue(second.screen("collection")); second.flush(); runCurrent()
        assertEquals(1, secondTransport.requests.size)
        second.close()
    }

    @Test fun `queue capacity and expiry discard old events with visible counters`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport, config(batch = 1, capacity = 2, retention = 1_000))
        repeat(3) { tracker.track("test_event", properties = mapOf("index" to it)) }; runCurrent()
        assertEquals(2, storage.events().size); assertEquals(1L, tracker.status.value.dropped)
        advanceTimeBy(1_001); tracker.flush(); runCurrent()
        assertEquals(0, storage.events().size); assertEquals(3L, tracker.status.value.dropped)
        assertEquals(0, transport.requests.size)
        tracker.close()
    }

    @Test fun `long background gap starts a new session and recomposition is not automatic`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport, config(batch = 100))
        tracker.onForeground(); tracker.screen("collection"); runCurrent()
        val firstSession = storage.events().single().sessionId
        tracker.onBackground(); runCurrent()
        advanceTimeBy(30 * 60_000); tracker.onForeground(); tracker.screen("profile"); runCurrent()
        val nextSession = storage.events().single().sessionId
        assertFalse(firstSession == nextSession)
        tracker.close()
    }

    @Test fun `invalid event and failed journal write do not send or crash caller`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport, config(batch = 1))
        tracker.onForeground(); runCurrent()
        assertFalse(tracker.track("bad name"))
        assertFalse(tracker.track("test", properties = mapOf("nested" to listOf(1))))
        storage.failWrites = true
        tracker.screen("collection"); runCurrent()
        assertEquals(0, transport.requests.size); assertEquals(1L, tracker.status.value.dropped)
        assertEquals(TrackerError.STORAGE, tracker.status.value.lastError)
        storage.failWrites = false; tracker.flush(); runCurrent()
        tracker.screen("collection"); runCurrent()
        assertEquals(1, transport.requests.size)
        tracker.close()
    }

    @Test fun `closed tracker stops timer and collection`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val tracker = tracker(storage, transport)
        tracker.onForeground(); runCurrent(); tracker.close()
        assertFalse(tracker.screen("collection"))
        advanceTimeBy(60_000); runCurrent(); assertEquals(0, transport.requests.size)
    }

    @Test fun `unsupported journal remains unchanged when delivery is requested`() = runTest {
        val storage = MemoryStorage(); val transport = RecordingTransport()
        val original = "{\"schemaVersion\":2,\"events\":[]}"
        storage.value = original
        val tracker = tracker(storage, transport)
        tracker.onForeground(); tracker.flush(); runCurrent()
        assertEquals(original, storage.value); assertEquals(0, transport.requests.size)
        assertEquals(TrackerError.STORAGE, tracker.status.value.lastError)
        tracker.close()
    }
}

package io.github.semiys.ulsatracker

import io.ktor.http.URLProtocol
import io.ktor.http.Url

data class TrackerConfig(
    val endpoint: String,
    val ingestKey: String,
    val appVersion: String,
    val allowHttp: Boolean = false,
    val batchSize: Int = 20,
    val flushIntervalMillis: Long = 30_000,
    val maxQueuedEvents: Int = 1_000,
    val retentionMillis: Long = 7 * 24 * 60 * 60 * 1_000L,
    val initiallyEnabled: Boolean = true,
) {
    init {
        val url = Url(endpoint)
        require(url.protocol == URLProtocol.HTTPS || (allowHttp && url.protocol == URLProtocol.HTTP)) { "HTTPS is required; allowHttp is for local development" }
        require(url.host.isNotBlank() && url.user == null && url.password == null && url.parameters.isEmpty() && url.fragment.isEmpty() && url.encodedPath in listOf("", "/")) { "Use a server origin without credentials, query or path" }
        require(Regex("[A-Za-z0-9_-]{32,128}").matches(ingestKey)) { "Invalid ingestion key" }
        require(appVersion.length in 1..32) { "Invalid app version" }
        require(batchSize in 1..100 && maxQueuedEvents in batchSize..10_000)
        require(flushIntervalMillis in 1_000..3_600_000)
        require(retentionMillis in 1_000..365 * 86_400_000L)
    }
}

enum class TrackerError { INVALID_EVENT, INPUT_QUEUE_FULL, STORAGE, NETWORK, RATE_LIMIT, SERVER, UNAUTHORIZED, REJECTED_EVENT, INVALID_ACK }

data class TrackerStatus(
    val ready: Boolean = false,
    val enabled: Boolean = true,
    val queued: Int = 0,
    val dropped: Long = 0,
    val rejected: Long = 0,
    val sending: Boolean = false,
    val lastError: TrackerError? = null,
)

/** Implementations must replace the entire state atomically and own one queue. */
interface TrackerStorage {
    suspend fun read(): String?
    suspend fun write(state: String)
    suspend fun close() {}
}

sealed interface DeliveryResponse {
    data class Acknowledged(val ids: List<String>, val accepted: Int, val duplicates: Int, val schemaVersion: Int) : DeliveryResponse
    data class Retry(val reason: TrackerError, val afterMillis: Long = 0) : DeliveryResponse
    data class Rejected(val eventIndex: Int? = null) : DeliveryResponse
    data object Unauthorized : DeliveryResponse
    data object TooLarge : DeliveryResponse
    data object InvalidAcknowledgement : DeliveryResponse
}

interface TrackerTransport {
    suspend fun send(json: String): DeliveryResponse
    fun close() {}
}

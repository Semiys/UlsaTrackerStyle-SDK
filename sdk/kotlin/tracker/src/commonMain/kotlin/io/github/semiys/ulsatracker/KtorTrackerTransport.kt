package io.github.semiys.ulsatracker

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.time.Clock

internal class KtorTrackerTransport(
    private val config: TrackerConfig,
    private val client: HttpClient,
    private val clockMillis: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) : TrackerTransport {
    override suspend fun send(json: String): DeliveryResponse {
        try {
            val response = client.post(config.endpoint.trimEnd('/') + "/api/v1/events") {
                header(HttpHeaders.Authorization, "Bearer " + config.ingestKey)
                contentType(ContentType.Application.Json)
                setBody(json)
            }
            val status = response.status.value
            if (status == 401 || status == 403) return DeliveryResponse.Unauthorized
            if (status == 413) return DeliveryResponse.TooLarge
            if (status == 429 || status >= 500) {
                val raw = response.headers[HttpHeaders.RetryAfter]
                val seconds = raw?.toLongOrNull()?.takeIf { it >= 0 }
                val after = if (seconds != null) seconds.coerceAtMost(604_800) * 1_000 else retryAfterDate(raw, clockMillis())
                return DeliveryResponse.Retry(if (status == 429) TrackerError.RATE_LIMIT else TrackerError.SERVER, after)
            }
            // Error messages and arbitrary response contents are never exposed in logs.
            val body = response.bodyAsText()
            if (body.encodeToByteArray().size > 64 * 1_024) return DeliveryResponse.InvalidAcknowledgement
            val objectBody = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            if (status == 400 || status == 409) {
                val error = objectBody?.get("error") as? JsonObject
                val field = (error?.get("field") as? kotlinx.serialization.json.JsonPrimitive)?.content
                val index = field?.let { Regex("events\\[(\\d+)](?:\\..*)?").matchEntire(it)?.groupValues?.get(1)?.toIntOrNull() }
                return DeliveryResponse.Rejected(index)
            }
            if (status != 200 || objectBody == null) return DeliveryResponse.InvalidAcknowledgement
            return runCatching {
                DeliveryResponse.Acknowledged(
                    ids = (objectBody.getValue("acknowledgedEventIds") as JsonArray).map { it.jsonPrimitive.content },
                    accepted = objectBody.getValue("accepted").jsonPrimitive.intOrNull ?: error("accepted"),
                    duplicates = objectBody.getValue("duplicates").jsonPrimitive.intOrNull ?: error("duplicates"),
                    schemaVersion = objectBody.getValue("schemaVersion").jsonPrimitive.intOrNull ?: error("schemaVersion"),
                )
            }.getOrDefault(DeliveryResponse.InvalidAcknowledgement)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { return DeliveryResponse.Retry(TrackerError.NETWORK) }
    }

    override fun close() = client.close()
}

internal fun configureTrackerClient(client: io.ktor.client.HttpClientConfig<*>) {
    client.expectSuccess = false
    client.followRedirects = false
    client.install(HttpTimeout) { requestTimeoutMillis = 10_000; connectTimeoutMillis = 5_000; socketTimeoutMillis = 10_000 }
}

// HTTP dates are parsed on JVM/Android; common code still compiles without Java APIs.
internal expect fun retryAfterDate(value: String?, nowMillis: Long): Long

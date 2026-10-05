package io.github.semiys.ulsatracker

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.coroutines.test.runTest

class KtorTrackerTransportTest {
    private val config = TrackerConfig("https://example.com", "k".repeat(64), "1.0")

    @Test fun `HTTP sends the whole bearer key once and parses acknowledgement`() = runTest {
        val client = HttpClient(MockEngine { request ->
            assertEquals("Bearer " + config.ingestKey, request.headers[HttpHeaders.Authorization])
            assertEquals("https://example.com/api/v1/events", request.url.toString())
            respond("""{"schemaVersion":1,"accepted":1,"duplicates":0,"acknowledgedEventIds":["a"]}""",
                HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { configureTrackerClient(this) }
        val transport = KtorTrackerTransport(config, client)
        try {
            val ack = assertIs<DeliveryResponse.Acknowledged>(transport.send("{}"))
            assertEquals(listOf("a"), ack.ids); assertEquals(1, ack.accepted)
        } finally { transport.close() }
    }

    @Test fun `429 seconds and HTTP date produce bounded retry delay`() = runTest {
        val now = java.time.Instant.parse("2026-10-04T12:00:00Z").toEpochMilli()
        for (value in listOf("16", "Sun, 04 Oct 2026 12:00:16 GMT")) {
            val client = HttpClient(MockEngine { respond("", HttpStatusCode.TooManyRequests, headersOf(HttpHeaders.RetryAfter, value)) }) { configureTrackerClient(this) }
            val transport = KtorTrackerTransport(config, client) { now }
            try { assertEquals(16_000L, assertIs<DeliveryResponse.Retry>(transport.send("{}")).afterMillis) }
            finally { transport.close() }
        }
    }

    @Test fun `bad JSON and redirect never become an acknowledgement`() = runTest {
        for (status in listOf(HttpStatusCode.OK, HttpStatusCode.Found)) {
            var requests = 0
            val client = HttpClient(MockEngine { requests++; respond("not JSON", status, headersOf(HttpHeaders.Location, "https://other.example.com")) }) { configureTrackerClient(this) }
            val transport = KtorTrackerTransport(config, client)
            try { assertIs<DeliveryResponse.InvalidAcknowledgement>(transport.send("{}")); assertEquals(1, requests) }
            finally { transport.close() }
        }
    }

    @Test fun `validation field identifies the rejected row`() = runTest {
        val client = HttpClient(MockEngine { respond("""{"error":{"code":"invalid_event","field":"events[2].eventId"}}""", HttpStatusCode.BadRequest) }) { configureTrackerClient(this) }
        val transport = KtorTrackerTransport(config, client)
        try { assertEquals(2, assertIs<DeliveryResponse.Rejected>(transport.send("{}")).eventIndex) }
        finally { transport.close() }
    }
}

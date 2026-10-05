package io.github.semiys.ulsatracker

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.Assume.assumeTrue

class DockerIntegrationTest {
    @Test fun `SDK recovers lost response against the real Docker API without double counting`() = runBlocking {
        val endpoint = System.getenv("ULSA_TEST_ENDPOINT")
        val ingest = System.getenv("ULSA_TEST_INGEST_KEY")
        val read = System.getenv("ULSA_TEST_READ_KEY")
        assumeTrue("Requires an isolated Docker test project", endpoint != null && ingest != null && read != null)
        val config = TrackerConfig(endpoint, ingest, "sdk-test-0.2.0", allowHttp = true)
        val root = Files.createTempDirectory("ulsa-jvm-test-").toFile()
        val http = java.net.http.HttpClient.newHttpClient()
        fun count(): Int {
            val response = http.send(HttpRequest.newBuilder(URI.create(endpoint + "/api/v1/stats")).header("Authorization", "Bearer " + read).build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, response.statusCode())
            return Json.parseToJsonElement(response.body()).jsonObject.getValue("totals").jsonObject.getValue("events").jsonPrimitive.int
        }
        assertEquals(0, count(), "Use a new disposable test project")
        val real = KtorTrackerTransport(config, HttpClient(OkHttp) { configureTrackerClient(this) })
        val loseResponse = object : TrackerTransport {
            override suspend fun send(json: String): DeliveryResponse {
                real.send(json)
                return DeliveryResponse.Retry(TrackerError.NETWORK, 60_000)
            }
            override fun close() = real.close()
        }
        val path = java.io.File(root, queueIdentity(config))
        val first = UlsaTracker(config, FileTrackerStorage(path), loseResponse, "web")
        try {
            first.onForeground(); first.screen("collection"); first.click("add_model", "collection")
            withTimeout(20_000) { first.status.first { it.ready && it.queued == 2 } }
            first.flush()
            withTimeout(20_000) { first.status.first { it.lastError == TrackerError.NETWORK } }
            assertEquals(2, count())
        } finally { first.close() }
        val second = createJvmTracker(config, root)
        try {
            second.onForeground()
            withTimeout(20_000) { second.status.first { it.ready && it.queued == 0 } }
            assertEquals(2, count())
        } finally {
            second.close()
            check(root.canonicalFile.parentFile == java.io.File(System.getProperty("java.io.tmpdir")).canonicalFile && root.name.startsWith("ulsa-jvm-test-"))
            root.deleteRecursively()
        }
    }
}

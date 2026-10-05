package io.github.semiys.ulsatracker

import java.io.File
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp

/** JVM factory also serves as an end-to-end client for the real Docker API. */
fun createJvmTracker(config: TrackerConfig, storageDirectory: File, platform: String = "web"): UlsaTracker =
    UlsaTracker(config, FileTrackerStorage(File(storageDirectory, queueIdentity(config))),
        KtorTrackerTransport(config, HttpClient(OkHttp) { configureTrackerClient(this) }), platform)

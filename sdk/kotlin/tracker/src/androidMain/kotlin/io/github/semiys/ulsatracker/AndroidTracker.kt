package io.github.semiys.ulsatracker

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import java.io.File
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp

/** Create once in Application.onCreate. Queue stays in noBackupFilesDir, outside the gallery. */
fun createAndroidTracker(context: Context, config: TrackerConfig): UlsaTracker {
    val application = context.applicationContext as Application
    lateinit var tracker: UlsaTracker
    val lifecycle = object : Application.ActivityLifecycleCallbacks {
        var started = 0
        override fun onActivityStarted(activity: Activity) { if (started++ == 0) tracker.onForeground() }
        override fun onActivityStopped(activity: Activity) { if (--started == 0) tracker.onBackground() }
        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
    tracker = UlsaTracker(config,
        FileTrackerStorage(File(application.noBackupFilesDir, "ulsatracker/" + queueIdentity(config))),
        KtorTrackerTransport(config, HttpClient(OkHttp) { configureTrackerClient(this) }), "android",
        afterClose = { application.unregisterActivityLifecycleCallbacks(lifecycle) })
    application.registerActivityLifecycleCallbacks(lifecycle)
    return tracker
}

// Copyable examples use explicit placeholders, never account credentials.
export function guideExamples(endpoint) {
  const origin = JSON.stringify(endpoint);
  const localHttp = endpoint.startsWith('http:');
  const port = new URL(endpoint).port || (localHttp ? '80' : '443');
  return {
    clone: 'git clone https://github.com/Semiys/UlsaTrackerStyle-SDK.git',
    settings: `// settings.gradle.kts вашего Android-проекта
includeBuild("../UlsaTrackerStyle-SDK/sdk/kotlin") {
    dependencySubstitution {
        substitute(module("io.github.semiys.ulsatracker:tracker"))
            .using(project(":tracker"))
    }
}`,
    dependency: `// build.gradle.kts модуля приложения
dependencies {
    implementation("io.github.semiys.ulsatracker:tracker:0.2.0")
}`,
    application: `package com.example.app

import android.app.Application
import io.github.semiys.ulsatracker.TrackerConfig
import io.github.semiys.ulsatracker.UlsaTracker
import io.github.semiys.ulsatracker.createAndroidTracker

class AnalyticsApplication : Application() {
    lateinit var tracker: UlsaTracker
        private set

    override fun onCreate() {
        super.onCreate()
        tracker = createAndroidTracker(
            context = this,
            config = TrackerConfig(
                endpoint = ${origin},
                ingestKey = "ВАШ_КЛЮЧ_ОТПРАВКИ",
                appVersion = "1.0.0"${localHttp ? ',\n                allowHttp = true // только локальная разработка' : ''}
            )
        )
    }
}`,
    manifest: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:name="com.example.app.AnalyticsApplication">
        <!-- Существующие Activity и остальные настройки приложения. -->
    </application>
</manifest>`,
    debugManifest: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:usesCleartextTraffic="true" />
</manifest>`,
    compose: `package com.example.app

import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import io.github.semiys.ulsatracker.UlsaTracker

@Composable
fun HomeScreen(tracker: UlsaTracker, onAddItem: () -> Unit) {
    LaunchedEffect(tracker) {
        tracker.screen("home")
    }
    Button(onClick = {
        tracker.click(button = "add_item", screen = "home")
        onAddItem()
    }) {
        Text("Добавить предмет")
    }
}`,
    activity: `import androidx.activity.compose.setContent

// Внутри onCreate вашей Activity, наследующей ComponentActivity:
val tracker = (application as AnalyticsApplication).tracker
setContent {
    HomeScreen(tracker = tracker, onAddItem = {
        // Откройте форму добавления вашего приложения.
    })
}`,
    reverse: `adb reverse tcp:${port} tcp:${port}`,
    prepared: `# local.properties приложения с подготовленным адаптером
ulsaTracker.sdkPath=/путь/к/UlsaTrackerStyle-SDK/sdk/kotlin
ulsaTracker.endpoint=${endpoint}
ulsaTracker.ingestKey=ВАШ_КЛЮЧ_ОТПРАВКИ`,
    html: `<button id="add-item" type="button">Добавить предмет</button>
<script src="${endpoint}/sdk/ulsa-tracker.js" defer></script>
<script src="/analytics.js" defer></script>`,
    javascript: `// analytics.js — отдельный файл вашего сайта
const tracker = UlsaTracker.create({
  endpoint: ${origin},
  ingestKey: 'ВАШ_КЛЮЧ_ОТПРАВКИ',
  appVersion: '1.0.0'${localHttp ? ',\n  allowHttp: true // только локальная разработка' : ''}
});

tracker.screen('home');
document.getElementById('add-item').addEventListener('click', () => {
  tracker.click('add_item', 'home');
  // Выполните обычное действие кнопки вашего сайта.
});`,
    module: `import { createTracker } from '${endpoint}/sdk/index.mjs';

const tracker = createTracker({
  endpoint: ${origin},
  ingestKey: 'ВАШ_КЛЮЧ_ОТПРАВКИ',
  appVersion: '1.0.0'${localHttp ? ',\n  allowHttp: true // только локальная разработка' : ''}
});
tracker.screen('home');`,
    successAndroid: `// Выполните после подтверждённого сохранения в вашем приложении:
tracker.track(
    name = "action_success",
    screen = "add_item",
    properties = mapOf("action" to "item_saved")
)`,
    successWeb: `// Выполните после успешного завершения операции вашего сайта:
tracker.track('action_success', {
  screen: 'add_item',
  properties: { action: 'item_saved' }
});`,
  };
}

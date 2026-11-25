# UlsaTracker Kotlin SDK 0.2.0

Библиотека на Kotlin Multiplatform с опубликованными вариантами Android (API 26+) и JVM. Исходники находятся в `sdk/kotlin`, модуль `:tracker`, пакет `io.github.semiys.ulsatracker`. Добавление цели iOS в SDK запланировано.

## Подключение из Maven Central

Версия **0.2.0** опубликована для Android и JVM. Добавьте `mavenCentral()` в существующий блок репозиториев зависимостей. [Maven Central](https://repo.maven.apache.org/maven2/io/github/semiys/ulsatracker/tracker/0.2.0/)

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}
```

В `build.gradle.kts` модуля приложения добавьте зависимость и выполните Gradle Sync.

```kotlin
dependencies {
    implementation("io.github.semiys.ulsatracker:tracker:0.2.0")
}
```

Gradle выбирает вариант библиотеки для Android или JVM. Для Android создайте `createAndroidTracker(this, TrackerConfig(...))` один раз в `Application`. Используйте `screen`, `click` и `track` в нужных обработчиках. Android-адаптер сам отмечает переходы приложения в фон и обратно. Полный пример и методы JVM описаны в [справочнике SDK](../../docs/SDK_API.md). Лицензия [MIT](tracker/src/commonMain/resources/META-INF/LICENSE-ulsa-tracker).

Ключ приёма разрешает отправку и не даёт читать статистику. Он извлекаем из APK; для публичного запуска нужны серверные ограничения запросов. `readKey` в приложение не вставляйте.

## Подготовленная интеграция в «Дом Коллекционера»

Мобильный проект загружает опубликованную SDK в debug-сборку. Чтобы включить отправку, добавьте параметры в игнорируемый `local.properties` приложения.

```properties
ulsaTracker.endpoint=http://127.0.0.1:8080
ulsaTracker.ingestKey=ВСТАВЬТЕ_ПОЛНЫЙ_КЛЮЧ_ПРИЁМА
```

Возьмите полный ключ Android-приложения в кабинете, вставьте его без кавычек и пересоберите debug APK. [Создание проекта и ключа](../../docs/CONSOLE.md)

Телефон по USB:

```powershell
adb devices
adb reverse tcp:8080 tcp:8080
.\gradlew.bat :androidApp:assembleDebug --max-workers=2
adb install -r 'androidApp\build\outputs\apk\debug\androidApp-debug.apk'
```

При двух телефонах добавьте `-s СЕРИЙНЫЙ_НОМЕР` перед `reverse` и `install`. Если Docker выбрал 8082, используйте `reverse tcp:8080 tcp:8082`; endpoint телефона остаётся с 8080. USB reverse повторите после переподключения.

Локальный HTTP разрешён в debug-сборке. Release использует пустой адаптер. [Чеклист проверок](../../docs/SDK_CHECKLIST.md)

## Сборка SDK из исходников

Для разработки SDK используйте JDK 21 и Android SDK 37. В проекте закреплены Kotlin 2.4.0, Gradle 9.3.1, AGP 9.1.1 и Ktor 3.6.0. Задайте `ANDROID_HOME` или `sdk.dir` в игнорируемом `sdk/kotlin/local.properties`. Выполните команду из `sdk/kotlin`.

```powershell
.\gradlew.bat :tracker:jvmTest :tracker:assemble --max-workers=2
```

На Linux и macOS используйте `./gradlew`. Результаты сборки находятся в `tracker/build/outputs/aar` и `tracker/build/libs`, отчёт тестов — в `tracker/build/reports/tests/jvmTest/index.html`.

Тесты ядра и адаптеров выполняются на JVM. Для интеграционного теста доставки задайте `ULSA_TEST_ENDPOINT`, `ULSA_TEST_INGEST_KEY` и `ULSA_TEST_READ_KEY` отдельного тестового стенда. [Публикация новой версии](../../docs/SDK_PUBLISHING.md)

# UlsaTracker Kotlin SDK 0.2.0

Самостоятельная Gradle-библиотека в `sdk/kotlin`, модуль `:tracker`, пакет `io.github.semiys.ulsatracker`. Android (API 26+) и JVM, общее ядро Kotlin Multiplatform. Kotlin 2.4.0, Gradle 9.3.1, AGP 9.1.1, Ktor 3.6.0. iOS-адаптера пока нет.

## Сборка и тесты

Нужны существующие JDK 21 и Android SDK 37. Gradle wrapper включён; программы и Node.js в SDK не устанавливаются. Android SDK укажите через `ANDROID_HOME` или игнорируемый `sdk/kotlin/local.properties` (`sdk.dir=...`).

Для сборки из Android Studio настройте **отдельный** `sdk/kotlin/local.properties`: composite build библиотеки не наследует `sdk.dir` мобильного проекта. На этом ноутбуке файл уже создан:

```properties
sdk.dir=D:/sdkad
```

На втором ПК задайте путь к его Android SDK в этом же файле. Файл игнорируется Git; копировать весь `local.properties` мобильного приложения с ключами в библиотеку не нужно.

PowerShell на этом ноутбуке:

```powershell
Set-Location 'D:\MyTracer SDK CopyStyle\sdk\kotlin'
$env:JAVA_HOME = 'D:\ProgramsCity\jbr'
$env:ANDROID_HOME = 'D:\sdkad'
$env:GRADLE_USER_HOME = 'D:\AndroidProjectGradle\DomCollectionGradle'
.\gradlew.bat :tracker:jvmTest :tracker:assemble --max-workers=2
```

На другом ПК замените пути. macOS/Linux: `sh ./gradlew :tracker:jvmTest :tracker:assemble` с настроенными JDK/Android SDK. Для сборки SDK Docker не требуется.

Результаты: `tracker/build/outputs/aar/tracker.aar`, `tracker/build/libs/tracker-jvm-0.2.0.jar`, HTML тестов в `tracker/build/reports/tests/jvmTest/index.html`. AAR/JAR не включают все зависимости: используйте Gradle composite или Maven-публикацию.

Тесты ядра запускаются на JVM из `commonTest`; транспорт и файловое хранилище — `jvmTest`. Docker-тест пропускается без `ULSA_TEST_ENDPOINT`, `ULSA_TEST_INGEST_KEY`, `ULSA_TEST_READ_KEY`. Он требует отдельную пустую БД и проверяет потерянный ответ после записи на сервер и повтор после пересоздания клиента. Не используйте рабочую статистику для этого теста.

## Локальное подключение к Android-проекту

Пока библиотека не опубликована в Maven, подключайте исходники composite build.

`settings.gradle.kts` приложения:

```kotlin
includeBuild("/path/to/UlsaTrackerStyle-SDK/sdk/kotlin") {
    dependencySubstitution {
        substitute(module("io.github.semiys.ulsatracker:tracker")).using(project(":tracker"))
    }
}
```

Android-модуль:

```kotlin
dependencies {
    implementation("io.github.semiys.ulsatracker:tracker:0.2.0")
}
```

Создайте один `createAndroidTracker(this, TrackerConfig(...))` в Application, затем вызывайте `screen`, `click`, `track`. Android-адаптер сам отмечает foreground/background. Полный пример и ограничения — [SDK_API.md](../../docs/SDK_API.md). Manifest SDK содержит только `INTERNET`, без разрешений галереи, телефона и хранилища.

Ключ приёма разрешает отправку и не даёт читать статистику. Он извлекаем из APK; для публичного запуска нужны серверные ограничения запросов. `readKey` в приложение не вставляйте.

## Подготовленная интеграция в «Дом Коллекционера»

В **игнорируемом** `D:\AndroidDekstops\DomCollection\local.properties`:

```properties
ulsaTracker.sdkPath=D:/MyTracer SDK CopyStyle/sdk/kotlin
ulsaTracker.endpoint=http://127.0.0.1:8080
ulsaTracker.ingestKey=ВСТАВЬТЕ_ПОЛНЫЙ_КЛЮЧ_ПРИЁМА
```

Путь — именно вложенная папка `sdk/kotlin`, с прямыми слешами. Ключ берётся из `docker exec ulsa-tracker-dev node src/show-access.js`: вставьте без кавычек, префикса Bearer и добавочных символов.

На этом ноутбуке поля уже настроены. На втором ПК задайте его пути и ключ его Docker-проекта. Удаление `ulsaTracker.sdkPath` отключает зависимость SDK: приложение собирается с пустым адаптером. После изменения пути выполните Gradle Sync в Android Studio.

Телефон по USB:

```powershell
& 'D:\sdkad\platform-tools\adb.exe' devices
& 'D:\sdkad\platform-tools\adb.exe' reverse tcp:8080 tcp:8080
Set-Location 'D:\AndroidDekstops\DomCollection'
.\gradlew.bat :androidApp:assembleDebug --max-workers=2
& 'D:\sdkad\platform-tools\adb.exe' install -r 'androidApp\build\outputs\apk\debug\androidApp-debug.apk'
```

При двух телефонах добавьте `-s СЕРИЙНЫЙ_НОМЕР` перед `reverse` и `install`. Если Docker выбрал 8082, используйте `reverse tcp:8080 tcp:8082`; endpoint телефона остаётся с 8080. USB reverse повторите после переподключения.

Cleartext разрешён только debug manifest; Release имеет пустые поля локального ключа и выключенный сбор. Ручные проверки — [чеклист](../../docs/SDK_CHECKLIST.md).

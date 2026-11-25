# Публикация UlsaTracker SDK

Опубликованы [JavaScript SDK 0.1.1](https://www.npmjs.com/package/@semiys/ulsa-tracker/v/0.1.1) в npm и [Kotlin SDK 0.2.0](https://repo.maven.apache.org/maven2/io/github/semiys/ulsatracker/tracker/0.2.0/) для Android и JVM в Maven Central. Лицензия обеих библиотек — MIT. Для подключения используйте руководства [JavaScript](../sdk/js/README.md) и [Kotlin](../sdk/kotlin/README.md). Ниже порядок выпуска новой версии для сопровождающего.

## npm

Публикуйте из аккаунта npm `semiys` с включённой двухфакторной защитой. Перед публикацией обновите `version` в `sdk/js/package.json`. [Настройка двухфакторной защиты npm](https://docs.npmjs.com/configuring-two-factor-authentication/)

Откройте PowerShell в корне репозитория.

```powershell
npm.cmd login --registry https://registry.npmjs.org/
npm.cmd whoami --registry https://registry.npmjs.org/
node --test test/js-sdk.test.js
Set-Location sdk/js
npm.cmd pack --dry-run
npm.cmd publish --access public
npm.cmd view '@semiys/ulsa-tracker' version --registry https://registry.npmjs.org/
```

Команда `whoami` должна показать `semiys`. Просмотрите состав архива перед публикацией. В нём должны быть README, LICENSE, package.json, index.mjs и ulsa-tracker.js. Подтвердите публикацию в запросе npm. Пароль и код двухфакторной проверки вводятся в npm и остаются у владельца аккаунта.

Из пустого каталога установите пакет с новым номером версии и проверьте импорт `import { createTracker } from '@semiys/ulsa-tracker'`.

## Maven Central

1. Войдите в Central Portal через GitHub-аккаунт `Semiys`. В **Namespaces** убедитесь, что подтверждено пространство `io.github.semiys`. Пакет будет опубликован в его подпакете `io.github.semiys.ulsatracker`. [Подтверждение namespace](https://central.sonatype.org/register/namespace/)
2. В профиле Central Portal создайте **User Token**. Он выдаёт отдельные имя и пароль для загрузки артефактов. [Токены Central Portal](https://central.sonatype.org/publish/generate-portal-token/)
3. Выберите ключ GPG для подписи или создайте отдельный ключ. Опубликуйте публичную часть на поддерживаемом сервере ключей и сохраните отпечаток. [Подпись для Maven Central](https://central.sonatype.org/publish/requirements/gpg/)

Перед выпуском измените версию в `sdk/kotlin/tracker/build.gradle.kts`. На Windows можно использовать GPG из Git. `cygpath` преобразует путь к хранилищу ключей в формат GPG-агента.

```powershell
$gitTools = 'C:/Program Files/Git/usr/bin'
$gpgPath = Join-Path $gitTools 'gpg.exe'
$keyDirectory = Join-Path $env:USERPROFILE '.gnupg'
New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
$env:GNUPGHOME = & (Join-Path $gitTools 'cygpath.exe') -u $keyDirectory
& $gpgPath --list-secret-keys --keyid-format long --fingerprint
```

Если подходящего ключа пока нет, запустите `& $gpgPath --full-generate-key` и затем снова выведите отпечаток. Отправьте публичную часть выбранного ключа.

```powershell
$signingFingerprint = Read-Host 'Отпечаток ключа GPG'
& $gpgPath --keyserver hkps://keyserver.ubuntu.com --send-keys $signingFingerprint
```

В том же PowerShell откройте `sdk/kotlin` и укажите пути к JDK и Android SDK на своём ПК.

```powershell
$env:JAVA_HOME = 'D:/ProgramsCity/jbr'
$env:ANDROID_HOME = 'D:/sdkad'
$env:ORG_GRADLE_PROJECT_mavenCentralUsername = Read-Host 'Имя из User Token'
$env:ORG_GRADLE_PROJECT_mavenCentralPassword = Read-Host 'Пароль из User Token' -MaskInput

try {
    .\gradlew.bat --gradle-user-home 'D:/AndroidProjectGradle/DomCollectionGradle' --no-configuration-cache "-Psigning.gnupg.executable=$gpgPath" "-Psigning.gnupg.keyName=$signingFingerprint" -PcentralRelease=true :tracker:publishToMavenCentral
} finally {
    Remove-Item Env:ORG_GRADLE_PROJECT_mavenCentralUsername,Env:ORG_GRADLE_PROJECT_mavenCentralPassword -ErrorAction SilentlyContinue
}
```

Gradle подписывает артефакты через установленный GPG и загружает их в Central Portal для проверки. После статуса **Validated** откройте **Deployments** и нажмите **Publish**. [Публикация релиза через Gradle](https://vanniktech.github.io/gradle-maven-publish-plugin/central/#publishing-releases)

Дождитесь статуса **Published**. Проверьте доступность AAR для Android и JAR для JVM в Maven Central. Подключите новую версию в отдельной debug-сборке и подтвердите получение событий на сервере.

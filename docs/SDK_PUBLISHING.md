# Публикация UlsaTracker SDK

JavaScript SDK выпускается в npm как `@semiys/ulsa-tracker@0.1.1`. Kotlin SDK выпускается в Maven Central как `io.github.semiys.ulsatracker:tracker:0.2.0` для Android и JVM. Лицензия обеих библиотек — MIT.

## npm

Первый релиз публикуется из аккаунта npm `semiys`. Создайте аккаунт или войдите в существующий и включите двухфакторную защиту. [Настройка двухфакторной защиты npm](https://docs.npmjs.com/configuring-two-factor-authentication/)

Откройте PowerShell в корне репозитория.

```powershell
npm.cmd login --registry https://registry.npmjs.org/
npm.cmd whoami --registry https://registry.npmjs.org/
node --test test/js-sdk.test.js
Set-Location sdk/js
npm.cmd pack --dry-run
npm.cmd publish --access public
npm.cmd view '@semiys/ulsa-tracker@0.1.1' version --registry https://registry.npmjs.org/
```

Команда `whoami` должна показать `semiys`. Просмотрите состав архива перед публикацией. В нём должны быть README, LICENSE, package.json, index.mjs и ulsa-tracker.js. Подтвердите публикацию в запросе npm. Пароль и код двухфакторной проверки вводятся в npm и остаются у владельца аккаунта.

Проверьте установку из пустого каталога командой `npm install @semiys/ulsa-tracker@0.1.1` и импортом `import { createTracker } from '@semiys/ulsa-tracker'`.

## Maven Central

1. Войдите в Central Portal через GitHub-аккаунт `Semiys`. В **Namespaces** убедитесь, что подтверждено пространство `io.github.semiys`. Пакет будет опубликован в его подпакете `io.github.semiys.ulsatracker`. [Подтверждение namespace](https://central.sonatype.org/register/namespace/)
2. В профиле Central Portal создайте **User Token**. Он выдаёт отдельные имя и пароль для загрузки артефактов. [Токены Central Portal](https://central.sonatype.org/publish/generate-portal-token/)
3. Выберите ключ GPG для подписи или создайте отдельный ключ. Опубликуйте публичную часть на поддерживаемом сервере ключей и сохраните отпечаток. [Подпись для Maven Central](https://central.sonatype.org/publish/requirements/gpg/)

На Windows можно использовать GPG из Git. `cygpath` преобразует путь к хранилищу ключей в формат, который принимает этот GPG-агент.

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

После появления релиза подключите `mavenCentral()` и зависимость `implementation("io.github.semiys.ulsatracker:tracker:0.2.0")` в отдельном Android-проекте. Gradle выберет Android-артефакт по метаданным библиотеки.

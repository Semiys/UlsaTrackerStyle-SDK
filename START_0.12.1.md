# Запуск UlsaTrackerStyle SDK 0.12.1

Комплект содержит исходники коммита b380e0fa2c5cf65a1fc16a73422bf5219a0128db и дополнительный файл docker-compose.published.yml. Этот файл закрепляет опубликованные Docker-образы по digest. Локальная сборка и установка Node.js на хост не нужны.

Нужны запущенный Docker с Linux-контейнерами, Docker Compose с поддержкой !reset и !override, доступ в интернет для первого скачивания. Поддерживаются linux/amd64 и linux/arm64; на Windows и macOS используется Docker Desktop. Физический ARM-компьютер в проверке выпуска не участвовал.

Распакуйте архив и откройте терминал внутри папки UlsaTrackerStyle-SDK-0.12.1, где лежат файлы docker-compose.yml и START_0.12.1.md. Для первого локального запуска используются порты 8080 для сайта, 9091 для Prometheus и 3100 для Grafana оператора. Если порт занят, задайте свободный номер соответствующей переменной, как описано ниже.

## Первый запуск в PowerShell на Windows

Проверьте, что docker version показывает Client и Server:

```powershell
docker version
docker compose version
```

Создайте локальные пароли. Команда сохраняет существующие значения и не печатает их:

```powershell
docker run --rm --user 0 --mount "type=bind,source=$($PWD.Path),target=/workspace" -w /workspace node:24.22.2-bookworm-slim node scripts/init-monitoring.mjs
```

Скачайте все образы и запустите шесть сервисов. Каждая команда вводится одной строкой:

```powershell
docker compose -p ulsa-tracker -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.react.yml -f docker-compose.published.yml pull
docker compose -p ulsa-tracker -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.react.yml -f docker-compose.published.yml up -d --no-build --wait
docker compose -p ulsa-tracker -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.react.yml -f docker-compose.published.yml ps
```

Откройте http://localhost:8080 . Проверка API: http://localhost:8080/health . Ожидаются версия 0.12.1, status ok и storage clickhouse. Создайте собственный аккаунт, проект и приложение. В комплекте нет пользовательских аккаунтов, ключей и коллекций.

## Первый запуск в Linux или macOS

В bash или zsh команда подготовки паролей имеет следующий вид:

```bash
docker run --rm --user 0 --mount "type=bind,source=$(pwd),target=/workspace" -w /workspace node:24.22.2-bookworm-slim node scripts/init-monitoring.mjs
```

Затем выполните те же три команды docker compose из раздела Windows; их синтаксис одинаковый.

## Если порт занят

В PowerShell задайте переменные в том же окне до запуска Compose:

```powershell
$env:FRONTEND_PORT='18096'
$env:PUBLIC_URL='http://localhost:18096'
$env:PROMETHEUS_PORT='18097'
$env:MONITORING_PORT='18098'
```

В bash/zsh:

```bash
export FRONTEND_PORT=18096 PUBLIC_URL=http://localhost:18096 PROMETHEUS_PORT=18097 MONITORING_PORT=18098
```

После этого сайт открывается на http://localhost:18096 . Это отдельные публикации портов, а не диапазон. Учитывайте, что имя проекта ulsa-tracker использует собственные тома; для второго независимого стенда последовательно замените -p ulsa-tracker на другое имя во всех командах.

## Проверка SDK

Для Web-приложения укажите origin открытого сайта, например http://localhost:8080 . Перейдите на /sdk-demo, подключите ключ Web-приложения и отправьте открытие экрана и нажатие. Статистику смотрите в том же приложении кабинета. Подробности: sdk/js/README.md и docs/SDK_API.md.

Android подключается Kotlin SDK 0.2.0; инструкция – sdk/kotlin/README.md. Для тестового телефона через USB укажите endpoint http://127.0.0.1:8080 и выполните adb reverse tcp:8080 tcp:8080 . Если сайт ноутбука работает на 18096, команда перенаправления – adb reverse tcp:8080 tcp:18096 . Используйте ключ Android-приложения этого стенда. После изменения endpoint или ключа пересоберите debug APK. Локальные HTTP-настройки демонстрации не являются настройками публикации приложения в магазине.

Кнопка тестового события в кабинете проверяет серверный путь. Работу Android или Web SDK проверяйте действиями соответствующего клиента.

## Остановка и повторный запуск

```powershell
docker compose -p ulsa-tracker -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.react.yml -f docker-compose.published.yml stop
docker compose -p ulsa-tracker -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.react.yml -f docker-compose.published.yml up -d --no-build --wait
```

Остановка сохраняет данные. Для диагностики используйте те же файлы и имя проекта с командой logs --tail 80 app frontend db dashboard . Локальные файлы .monitoring-secrets и тома с данными не входят в публичный комплект; не удаляйте их при обычной остановке. Резервирование описано в docs/BACKUP_AND_RESTORE.md.

## Состав выпуска

- API: semiys/ulsatrackerstyle-sdk:0.12.1.
- React-фронтенд: semiys/ulsatrackerstyle-frontend:0.12.1.
- Grafana: semiys/ulsatrackerstyle-sdk:0.12.1-grafana, сервер Grafana 13.3.0.
- ClickHouse 26.8.34.13, Prometheus 3.13.5.
- Kotlin SDK 0.2.0 и JavaScript SDK 0.1.1. HTTP schemaVersion 1.

images.json содержит полные digest и поддерживаемые платформы. START_0.12.1.md и docker-compose.published.yml добавлены в комплект поверх неизменённого git archive указанного коммита. Исходники из автоматического архива GitHub по тегу остаются исходным деревом Git; дополнительный release override входит именно в этот комплект.

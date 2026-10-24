# Сборка, проверки и публикация

Все команды выполняются из корня репозитория. Для запуска готовых опубликованных образов используйте [README](../README.md).

## Текущий выпуск ЛР4

Сервер 0.7.1, образ 0.0.4. Локальная сборка: `docker build -t semiys/ulsatrackerstyle-sdk:0.0.4 .`. Изолированный набор из 40 проверок запускается по [инструкции ЛР4](LAB4.md#проверки). Публикация обеих архитектур:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t semiys/ulsatrackerstyle-sdk:0.0.4 --push .
```

В выпуск входят JavaScript SDK, кабинет и Grafana. Нижеследующие команды ЛР3 — исторические: для воспроизведения используйте исходники ветки lab3, а не текущий Compose ЛР4.

## Локальная сборка и проверки ЛР3

Версия сервера ЛР3 — **0.5.0**. Сборка по умолчанию — приложение ЛР3 с клиентом ClickHouse, без встроенной DuckDB:

```bash
docker build -t semiys/ulsatrackerstyle-sdk:0.0.3 .
```

```bash
docker compose up -d
```

Проверки на отдельном томе:

```bash
docker compose -p mispisit-sarantsev-lab3-tests -f docker-compose.yml -f docker-compose.test.yml build app
```

```bash
docker compose -p mispisit-sarantsev-lab3-tests -f docker-compose.yml -f docker-compose.test.yml run --rm app
```

```bash
docker compose -p mispisit-sarantsev-lab3-tests -f docker-compose.yml -f docker-compose.test.yml down
```

Это 21 проверка с настоящим ClickHouse и прежними JSON/HTTP-функциями. [Результаты и ограничения](LAB3.md). Файл `docker-compose.test.yml` используется только для разработки.

## Локальная сборка ЛР2

Приведённые ниже локальные имена тегов сохранены из этапа 0.4.2. Сборка выполняется из текущих исходников 0.5.0 в режиме JSON; публичный тег ЛР2 `0.0.2` содержит прежний сервер **0.4.1**.

```bash
docker build --target lab2 -t ulsatrackerstyle-sdk:0.4.2 .
```

```bash
docker run --rm -p 8080:8080 ulsatrackerstyle-sdk:0.4.2
```

В сборке `lab2` используются Express, EJS и JSON. Пакет DuckDB не устанавливается. Контейнер работает от пользователя `node` и слушает порт 8080.

## Автоматические проверки

JSON, HTTP и страницы — 12 проверок:

```bash
docker build --target lab2-test -t ulsa-lab2-tests:0.4.2 .
```

```bash
docker run --rm --memory 512m --cpus 2 ulsa-lab2-tests:0.4.2
```

Полный набор, включая реализацию DuckDB:

```bash
docker build --target test -t ulsa-tracker-all-tests:0.4.2 .
```

```bash
docker run --rm --memory 512m --cpus 2 ulsa-tracker-all-tests:0.4.2
```

Проверки используют временные данные внутри контейнера. Рабочий том к ним не подключается.

## Реализация DuckDB

Исходники `src/store.js` и `src/schema.sql` сохранены отдельно. Сборка `duckdb-runtime` устанавливает `@duckdb/node-api`; режим хранения выбирается явно:

```bash
docker build --target duckdb-runtime -t ulsatrackerstyle-sdk:duckdb-0.5.0 .
```

```bash
docker run -d --name ulsa-tracker-duckdb --memory 512m --cpus 2 -e STORAGE_BACKEND=duckdb -p 127.0.0.1:8082:8080 --mount type=volume,source=ulsa-tracker-dev-data,target=/app/data ulsatrackerstyle-sdk:duckdb-0.5.0
```

Откройте http://localhost:8082. Перед использованием прежнего тома остановите сервер, который уже пишет в него. Имя контейнера должно быть свободно. Ключи обычного проекта можно посмотреть локально:

```bash
docker exec ulsa-tracker-duckdb node src/show-access.js
```

Эти ключи не добавляются в Git. Для демонстрационного JSON-проекта и обычного DuckDB-проекта используются отдельные тома.

## Публикация двух архитектур

Перед публикацией выполните проверки. Публикация заменяет содержимое указанного тега в Docker Hub.

Образ ЛР3 опубликован 14.10.2026 следующей командой:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t semiys/ulsatrackerstyle-sdk:0.0.3 --push .
```

Теги ЛР1 и ЛР2 уже опубликованы и при выпуске ЛР3 не перезаписываются. Команды ниже описывают исходные варианты сборки этих работ.

ЛР1 собирается из сохранённого исходника первой страницы:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t semiys/ulsatrackerstyle-sdk:0.0.1 --push ./labs/lab1
```

ЛР2 собирается из корня:

```bash
docker buildx build --platform linux/amd64,linux/arm64 --target lab2 -t semiys/ulsatrackerstyle-sdk:0.0.2 --push .
```

Проверка опубликованных платформ:

```bash
docker buildx imagetools inspect semiys/ulsatrackerstyle-sdk:0.0.3
```

В одном теге должны присутствовать `linux/amd64` и `linux/arm64`. Дополнительные аттестации `unknown/unknown` не заменяют их. Не отправляйте образ одной платформы поверх общего тега. На Docker Desktop с containerd image store Buildx также может загрузить обе платформы локально с `--load`.

Для ЛР3 используйте блок клонирования ветки `lab3` и запуска Compose из README. Команды `docker pull` и `docker run` в разделах ЛР1/ЛР2 относятся к прежним работам с одним контейнером. Запуск ЛР3 выполнен на Intel; ARM-приложение дополнительно проверено через эмуляцию с базой на Intel.

## Описание Docker Hub

Текст публичного Overview хранится в [DOCKER_HUB.md](DOCKER_HUB.md). При обновлении опубликованных версий проверьте соответствие этой страницы и таблицы версий в README. Обновление описания и публикация образа выполняются отдельно.

# Сборка, проверки и публикация

Все команды выполняются из корня репозитория. Для запуска готовых опубликованных образов используйте [README](../README.md).

## Локальная сборка ЛР2

Текущая версия исходников сервера — **0.4.2**. Локальный тег показывает версию сборки; публичный тег ЛР2 `0.0.2` пока содержит сервер **0.4.1**.

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

Исходники `src/store.js` и `src/schema.sql` сохранены для дальнейшего развития. Обычная сборка `runtime` устанавливает `@duckdb/node-api`; режим хранения выбирается явно:

```bash
docker build --target runtime -t ulsatrackerstyle-sdk:0.4.2 .
```

```bash
docker run -d --name ulsa-tracker-duckdb --memory 512m --cpus 2 -e STORAGE_BACKEND=duckdb -p 127.0.0.1:8082:8080 --mount type=volume,source=ulsa-tracker-dev-data,target=/app/data ulsatrackerstyle-sdk:0.4.2
```

Откройте http://localhost:8082. Перед использованием прежнего тома остановите сервер, который уже пишет в него. Имя контейнера должно быть свободно. Ключи обычного проекта можно посмотреть локально:

```bash
docker exec ulsa-tracker-duckdb node src/show-access.js
```

Эти ключи не добавляются в Git. Для демонстрационного JSON-проекта и обычного DuckDB-проекта используются отдельные тома.

## Публикация двух архитектур

Перед публикацией выполните проверки. Публикация заменяет содержимое указанного тега в Docker Hub.

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
docker buildx imagetools inspect semiys/ulsatrackerstyle-sdk:0.0.2
```

В одном теге должны присутствовать `linux/amd64` и `linux/arm64`. Дополнительные аттестации `unknown/unknown` не заменяют их. Не отправляйте образ одной платформы поверх общего тега. На Docker Desktop с containerd image store Buildx также может загрузить обе платформы локально с `--load`.

Для проверки опубликованного образа используйте точные команды `docker pull` и `docker run` из README. Запуск выполняется на Intel; ARM можно дополнительно проверить на ARM-хосте или через эмуляцию, указав это в результатах.

## Описание Docker Hub

Текст публичного Overview хранится в [DOCKER_HUB.md](DOCKER_HUB.md). При обновлении опубликованных версий проверьте соответствие этой страницы и таблицы версий в README. Обновление описания и публикация образа выполняются отдельно.

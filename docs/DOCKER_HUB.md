# UlsaTrackerStyle SDK

Сервис продуктовой аналитики для мобильных приложений. SDK отправляет события об открытии экранов, нажатиях кнопок и успешных действиях; сервер сохраняет их, а веб-панель показывает счётчики и графики. Первый клиент — **«Дом Коллекционера»**, Android/KMP.

## Опубликованные версии

| Тег | Работа | Содержимое |
|---|---|---|
| `0.0.2` | ЛР2 | Сервер 0.4.1: форма события, статистика, объяснение отказа; Express, EJS и JSON |
| `0.0.1` | ЛР1 | Первая страница: название, описание, версия и статус разработки |

Оба тега содержат **linux/amd64 и linux/arm64**. Docker выбирает архитектуру автоматически. На Windows/macOS нужен Docker Desktop с Linux-контейнерами, на Linux — Docker Engine. Node.js и зависимости находятся внутри образа.

## Запуск ЛР2

**1. Скачайте образ:**

```bash
docker pull semiys/ulsatrackerstyle-sdk:0.0.2
```

**2. Запустите контейнер:**

```bash
docker run --rm -p 8080:8080 semiys/ulsatrackerstyle-sdk:0.0.2
```

**3. Откройте [http://localhost:8080](http://localhost:8080).** Порт 8080 должен быть свободен. Остановка — **Ctrl+C**. В этом коротком запуске контейнер и его данные удаляются после остановки.

### Что проверить

1. Нажмите **«Отправить событие»**, сохраните предложенные значения. Откроется статистика с подтверждением и новой записью.
2. Посмотрите счётчики, дневной график, последние события и период 7/30 дней.
3. Откройте **«Пример отказа»**, вернитесь к форме и отправьте пустое название. Сервер объяснит причину отказа; число событий останется прежним.

ЛР2 включает отдельный демонстрационный проект с публичными учебными ключами и предназначена для локального показа. Статистика на первом запуске пуста.

## Запуск ЛР1

**1. Скачайте образ:**

```bash
docker pull semiys/ulsatrackerstyle-sdk:0.0.1
```

**2. Запустите контейнер:**

```bash
docker run --rm -p 8080:8080 semiys/ulsatrackerstyle-sdk:0.0.1
```

**3. Откройте [http://localhost:8080](http://localhost:8080).** Если ранее запущена ЛР2 на 8080, сначала остановите её. На странице видны название, описание, версия 0.0.1 и статус разработки.

## Если порт занят

Используйте другой порт компьютера, например 8081:

```bash
docker run --rm -p 8081:8080 semiys/ulsatrackerstyle-sdk:0.0.2
```

Откройте [http://localhost:8081](http://localhost:8081). Для ЛР1 замените тег на `0.0.1`.

## Сохранение событий

После остановки короткой проверки запустите контейнер с Docker volume:

```bash
docker run -d --name ulsa-tracker-lab2 --memory 512m --cpus 2 -p 8080:8080 --mount type=volume,source=ulsa-tracker-lab2-data,target=/app/data semiys/ulsatrackerstyle-sdk:0.0.2
```

События и настройки остаются в томе `ulsa-tracker-lab2-data`. На одном томе должен работать один сервер. Имя контейнера должно быть свободно. Подробности повторного запуска и подключения телефона приведены в инструкции ниже.

## Исходники и документация

Репозиторий: [https://github.com/Semiys/UlsaTrackerStyle-SDK](https://github.com/Semiys/UlsaTrackerStyle-SDK)

Pull Request ЛР1: [https://github.com/Semiys/UlsaTrackerStyle-SDK/pull/2](https://github.com/Semiys/UlsaTrackerStyle-SDK/pull/2)

Pull Request ЛР2: [https://github.com/Semiys/UlsaTrackerStyle-SDK/pull/1](https://github.com/Semiys/UlsaTrackerStyle-SDK/pull/1)

- [README и инструкции запуска](https://github.com/Semiys/UlsaTrackerStyle-SDK#readme).
- [Ручные проверки ЛР2](https://github.com/Semiys/UlsaTrackerStyle-SDK/blob/main/docs/LAB2_CHECKLIST.md).
- [Подключение демонстрационного APK](https://github.com/Semiys/UlsaTrackerStyle-SDK/blob/main/docs/LAB2_ANDROID.md).
- [Kotlin SDK](https://github.com/Semiys/UlsaTrackerStyle-SDK/blob/main/sdk/kotlin/README.md).

## Состояние SDK и хранения

Kotlin SDK 0.2.0 реализована для Android и JVM: постоянная очередь, пакетная отправка, повторы и подтверждения. Демонстрационный APK имеет версию 1.2 и передаётся отдельно. iOS и JavaScript SDK запланированы.

ЛР2 хранит события в JSON: предел 10 000 событий или 16 МиБ. Реализация DuckDB сохранена в исходниках для следующих этапов; пакет DuckDB в образ ЛР2 не включён. Фотографии, содержимое коллекции, пользовательский ввод и рекламные ID SDK не собирает.

Текущие исходники сервера имеют версию **0.4.2**. Их новые оформленные списки темы и периода доступны после локальной сборки; опубликованный тег **0.0.2** содержит сервер **0.4.1**.

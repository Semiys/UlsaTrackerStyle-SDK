# DuckDB / Quack: сетевой прототип 0.1.0

Проверяет пригодность DuckDB для отдельного сервиса хранения в ЛР3. Это эксперимент, а не опубликованная версия ЛР3. Сайт и SDK не переключаются на него.

**Статус на 13.10.2026:** запись в новую базу проходит. После пересоздания база сохраняет событие, однако присоединение заполненного каталога завершается ошибкой Quack. Полная проверка `read` не пройдена. Подробности — [RESULTS.md](RESULTS.md).

## Устройство

- `db`: готовый официальный `duckdb/duckdb:1.5.6`, расширение Quack, именованный том `dbdata`.
- `app`: Node.js с закреплённым `@duckdb/node-api` из основного lockfile. Клиент подключается к `quack:db:9494` и использует существующий `AnalyticsStore`.
- У приложения нет доступа к файлу базы. Его DuckDB работает только в памяти как сетевой клиент. Файлы аналитики принадлежат исключительно `db`.
- Порты на компьютер не публикуются. `app-demo` — учебный токен подключения из переменной окружения; для внешнего развёртывания он не подходит.
- При первом старте Quack скачивается из официального репозитория расширений. Нужен доступ к сети. Расширение пока имеет статус beta.

## Запуск из корня репозитория

Требуется Docker Desktop / Docker Engine с Compose. Node.js и СУБД на компьютер устанавливать не нужно.

```bash
docker compose -f experiments/quack/compose.yml build app
docker compose -f experiments/quack/compose.yml up -d db
docker compose -f experiments/quack/compose.yml run --rm app
```

Первый запуск `write` требует пустой базы прототипа. Он создаёт схему, проверяет запись, пять повторов, конфликт идентификатора, откат транзакции, статистику и неверный токен. Ошибка проверки завершает процесс с ненулевым кодом.

Проверка сохранности после удаления и пересоздания контейнеров:

```bash
docker compose -f experiments/quack/compose.yml down
docker compose -f experiments/quack/compose.yml up -d db
docker compose -f experiments/quack/compose.yml run --rm app node /app/experiment/probe.mjs read
docker compose -f experiments/quack/compose.yml down
```

Команда `down` сохраняет том. Флаг `-v` удалил бы данные, поэтому в этих командах его нет. Имя Compose-проекта — `mispisit-sarantsev-quack-probe`, отдельное от демонстрации ЛР2.

Для чтения сохранённого счётчика и отдельной проверки ошибки присоединения:

```bash
docker compose -f experiments/quack/compose.yml up -d db
docker compose -f experiments/quack/compose.yml run --rm app node /app/experiment/diagnose.mjs
docker compose -f experiments/quack/compose.yml down
```

Диагностика только читает данные. При воспроизведении ошибки ATTACH возвращает ненулевой код, даже если чтение счётчика успешно.

Режим `read` проверяет ровно одно ранее записанное событие. Повторный `write` на заполненном томе намеренно отклоняется. Для новой записи используйте отдельное имя проекта через `-p`, одинаковое во всех командах выбранного прогона.

## Ограничение beta

Обычное обращение к присоединённому каталогу не выполняет `INSERT ... ON CONFLICT`: Quack 1.5.6 возвращает `GetStorageInfo not implemented yet`. В эксперименте используется официальный вызов `remote.query()`, который выполняет SQL непосредственно на сервере. Временный `ServerQueryConnection` приспосабливает фиксированные запросы существующего `AnalyticsStore` к этому вызову. Это не готовый универсальный драйвер базы данных; перед переносом в основной сервер нужны дополнительные проверки параметров и восстановления соединения.

## Источники

- https://duckdb.org/docs/current/operations_manual/duckdb_docker
- https://duckdb.org/docs/current/quack/overview
- https://duckdb.org/docs/current/quack/reference

Результаты запуска и оставшиеся проверки фиксируются в `RESULTS.md`.

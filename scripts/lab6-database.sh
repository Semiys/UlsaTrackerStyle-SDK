#!/bin/sh
set -eu
umask 077

file=${BACKUP_FILE:-clickhouse.tar.gz}
case "$file" in
  .*|*[!a-zA-Z0-9._-]*) echo "Invalid backup file name" >&2; exit 1 ;;
  *.tar.gz) ;;
  *) echo "The backup file name must end in .tar.gz" >&2; exit 1 ;;
esac
archive="/backup/$file"

client() {
  clickhouse-client --host db --database "$CLICKHOUSE_DB" --user "$CLICKHOUSE_USER" \
    --password "$CLICKHOUSE_PASSWORD" --max_threads 2 --max_memory_usage 268435456 "$@"
}

tables() {
  client --query "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name FORMAT TSVRaw"
}

baseline='events
ingestion_receipts
schema_version'
migrated='events
ingestion_receipts
schema_migrations
schema_version'

check_tables() {
  if [ "$1" != "$baseline" ] && [ "$1" != "$migrated" ]; then
    echo "Unexpected ClickHouse table set" >&2
    exit 1
  fi
}

case "${1:-}" in
  backup)
    work=$(mktemp -d /backup/.backup.XXXXXX)
    trap 'rm -rf "$work"' EXIT
    names=$(tables)
    check_tables "$names"
    cd "$work"
    printf '%s\n' "$names" > tables.txt
    for table in $names; do
      client --query "SHOW CREATE TABLE $table FORMAT TSVRaw" > "$table.sql"
      client --query "SELECT * FROM $table FORMAT Native" > "$table.native"
    done
    if [ "$(tables)" != "$names" ]; then
      echo "Schema changed during backup" >&2
      exit 1
    fi
    sha256sum tables.txt ./*.sql ./*.native > checksums.sha256
    tar -czf bundle.tar.gz tables.txt checksums.sha256 ./*.sql ./*.native
    mv -f bundle.tar.gz "$archive"
    echo "Backup saved to $archive"
    ;;
  restore)
    if [ ! -s "$archive" ]; then echo "Backup file missing: $archive" >&2; exit 1; fi
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    cd "$work"
    tar -xOzf "$archive" tables.txt > tables.txt
    names=$(cat tables.txt)
    check_tables "$names"
    tar -xOzf "$archive" checksums.sha256 > checksums.sha256
    for table in $names; do
      tar -xOzf "$archive" "./$table.sql" > "$table.sql"
      tar -xOzf "$archive" "./$table.native" > "$table.native"
    done
    sha256sum tables.txt ./*.sql ./*.native > actual.sha256
    cmp -s checksums.sha256 actual.sha256 || { echo "Backup checksum mismatch" >&2; exit 1; }
    if [ -n "$(tables)" ]; then
      echo "Restore requires an empty ClickHouse database. Keep the application stopped." >&2
      exit 1
    fi
    for table in $names; do
      client --queries-file "$table.sql"
      if [ -s "$table.native" ]; then
        client --query "INSERT INTO $table FORMAT Native" < "$table.native"
      fi
    done
    echo "ClickHouse database restored from $archive"
    ;;
  *) echo "Expected backup or restore" >&2; exit 1 ;;
esac

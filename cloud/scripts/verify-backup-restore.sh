#!/bin/sh
set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cloud_directory="$(dirname "$script_directory")"
backup_directory="$cloud_directory/backups"
restore_database="remind_restore_check_$$"

cd "$cloud_directory"
. "$cloud_directory/.env"

mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_directory/remind-manual-${timestamp}.dump"

cleanup() {
  docker compose exec -T postgres \
    dropdb --if-exists -U "$REMIND_POSTGRES_USER" "$restore_database" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose exec -T postgres \
  pg_dump -U "$REMIND_POSTGRES_USER" -d "$REMIND_POSTGRES_DB" \
  --format=custom --no-owner > "$backup_file"

docker compose exec -T postgres \
  createdb -U "$REMIND_POSTGRES_USER" "$restore_database"

docker compose exec -T postgres \
  pg_restore -U "$REMIND_POSTGRES_USER" -d "$restore_database" \
  --no-owner < "$backup_file"

source_tables="$(
  docker compose exec -T postgres \
    psql -U "$REMIND_POSTGRES_USER" -d "$REMIND_POSTGRES_DB" -Atc \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
)"
restored_tables="$(
  docker compose exec -T postgres \
    psql -U "$REMIND_POSTGRES_USER" -d "$restore_database" -Atc \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
)"
source_migrations="$(
  docker compose exec -T postgres \
    psql -U "$REMIND_POSTGRES_USER" -d "$REMIND_POSTGRES_DB" -Atc \
    "SELECT count(*) FROM schema_migrations"
)"
restored_migrations="$(
  docker compose exec -T postgres \
    psql -U "$REMIND_POSTGRES_USER" -d "$restore_database" -Atc \
    "SELECT count(*) FROM schema_migrations"
)"

if [ "$source_tables" != "$restored_tables" ]; then
  echo "Restore verification failed: table count mismatch" >&2
  exit 1
fi

if [ "$source_migrations" != "$restored_migrations" ]; then
  echo "Restore verification failed: migration count mismatch" >&2
  exit 1
fi

echo "Backup restore verified: $source_tables tables, $source_migrations migrations"

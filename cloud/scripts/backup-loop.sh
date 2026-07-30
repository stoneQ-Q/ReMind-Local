#!/bin/sh
set -eu
umask 077

interval="${REMIND_BACKUP_INTERVAL_SECONDS:-86400}"
retention_days="${REMIND_BACKUP_RETENTION_DAYS:-7}"

case "$interval" in
  *[!0-9]*|'') echo "Invalid backup interval" >&2; exit 1 ;;
esac

case "$retention_days" in
  *[!0-9]*|'') echo "Invalid backup retention" >&2; exit 1 ;;
esac

mkdir -p /backups

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  pending="/backups/remind-${timestamp}.dump.partial"
  completed="/backups/remind-${timestamp}.dump"

  pg_dump --format=custom --no-owner --file="$pending"
  mv "$pending" "$completed"
  find /backups -type f -name 'remind-*.dump' -mtime "+$retention_days" -delete
  echo "Created PostgreSQL backup remind-${timestamp}.dump"

  sleep "$interval"
done

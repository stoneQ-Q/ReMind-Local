#!/bin/sh

set -u

public_url="${REMIND_HEALTH_PUBLIC_URL:-https://remind.43-129-237-189.sslip.io}"
data_path="${REMIND_HEALTH_DATA_PATH:-/opt/remind/shared}"
backup_directory="${REMIND_HEALTH_BACKUP_DIR:-/opt/remind/shared/backups}"
disk_limit="${REMIND_HEALTH_DISK_LIMIT_PERCENT:-80}"
memory_limit="${REMIND_HEALTH_MEMORY_LIMIT_PERCENT:-90}"
backup_max_age="${REMIND_HEALTH_BACKUP_MAX_AGE_SECONDS:-108000}"
failures=0

fail() {
  failures=$((failures + 1))
  printf 'remind_health_alert check=%s detail=%s\n' "$1" "$2" >&2
}

check_container() {
  container="$1"
  require_health="$2"
  state="$(
    docker inspect \
      --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' \
      "$container" 2>/dev/null
  )" || {
    fail container "${container}_missing"
    return
  }

  status=$(printf '%s' "$state" | cut -d '|' -f 1)
  health=$(printf '%s' "$state" | cut -d '|' -f 2)
  if [ "$status" != "running" ]; then
    fail container "${container}_status_${status}"
  fi
  if [ "$require_health" = "yes" ] && [ "$health" != "healthy" ]; then
    fail container "${container}_health_${health}"
  fi
}

check_container remind-cloud-postgres-1 yes
check_container remind-cloud-api-1 yes
check_container remind-cloud-worker-1 no
check_container remind-cloud-backup-1 no
check_container remind-cloud-caddy-1 yes

ready_response="$(
  curl --fail --silent --show-error --max-time 10 \
    "${public_url%/}/ready" 2>/dev/null
)" || ready_response=""
case "$ready_response" in
  *'"ok":true'*'"database":"ready"'*) ;;
  *) fail https_ready unavailable ;;
esac

disk_percent="$(
  df -P "$data_path" 2>/dev/null |
    awk 'NR == 2 { value = $5; sub(/%$/, "", value); print value }'
)"
case "$disk_percent" in
  ''|*[!0-9]*) fail disk invalid_usage ;;
  *)
    if [ "$disk_percent" -ge "$disk_limit" ]; then
      fail disk "usage_${disk_percent}_percent"
    fi
    ;;
esac

memory_percent="$(
  awk '
    $1 == "MemTotal:" { total = $2 }
    $1 == "MemAvailable:" { available = $2 }
    END {
      if (total > 0 && available >= 0) {
        printf "%d\n", ((total - available) * 100) / total
      }
    }
  ' /proc/meminfo 2>/dev/null
)"
case "$memory_percent" in
  ''|*[!0-9]*) fail memory invalid_usage ;;
  *)
    if [ "$memory_percent" -ge "$memory_limit" ]; then
      fail memory "usage_${memory_percent}_percent"
    fi
    ;;
esac

latest_backup="$(
  find "$backup_directory" -maxdepth 1 -type f \
    -name 'remind-*.dump' ! -name '*.partial' -print 2>/dev/null |
    sort |
    tail -n 1
)"
if [ -z "$latest_backup" ]; then
  fail backup missing
else
  backup_modified="$(
    stat -c %Y "$latest_backup" 2>/dev/null ||
      stat -f %m "$latest_backup" 2>/dev/null
  )"
  now="$(date +%s)"
  case "$backup_modified" in
    ''|*[!0-9]*) fail backup invalid_timestamp ;;
    *)
      backup_age=$((now - backup_modified))
      if [ "$backup_age" -lt 0 ] || [ "$backup_age" -gt "$backup_max_age" ]; then
        fail backup "age_${backup_age}_seconds"
      fi
      ;;
  esac
fi

if [ "$failures" -gt 0 ]; then
  printf 'remind_health_failed failures=%s\n' "$failures" >&2
  exit 1
fi

printf 'remind_health_ok disk_percent=%s memory_percent=%s\n' \
  "$disk_percent" "$memory_percent"

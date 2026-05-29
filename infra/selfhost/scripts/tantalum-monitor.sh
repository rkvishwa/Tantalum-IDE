#!/usr/bin/env bash
set -euo pipefail

BACKUP_STATE_DIR="${TANTALUM_BACKUP_STATE_DIR:-/var/lib/tantalum/backup}"
DISK_THRESHOLD="${TANTALUM_MONITOR_DISK_THRESHOLD:-80}"
MEMORY_THRESHOLD="${TANTALUM_MONITOR_MEMORY_THRESHOLD:-85}"
BACKUP_MAX_AGE_MINUTES="${TANTALUM_MONITOR_BACKUP_MAX_AGE_MINUTES:-1800}"

required_containers=(
  appwrite
  appwrite-console
  appwrite-mongodb
  appwrite-redis
  appwrite-traefik
  appwrite-realtime
  appwrite-worker-functions
  appwrite-worker-builds
  openruntimes-executor
)

failures=0

emit() {
  local metric="$1"
  local value="$2"
  local threshold="$3"
  local status="$4"
  shift 4
  local detail="$*"
  logger -t tantalum-monitor "metric=$metric value=$value threshold=$threshold status=$status $detail"
  echo "metric=$metric value=$value threshold=$threshold status=$status $detail"
  [[ "$status" == "pass" ]] || failures=$((failures + 1))
}

disk_pct() {
  df -P "$1" | awk 'NR==2 {gsub(/%/, "", $5); print $5}'
}

root_pct="$(disk_pct /)"
if (( root_pct >= DISK_THRESHOLD )); then
  emit disk_root "$root_pct" "$DISK_THRESHOLD" fail "path=/"
else
  emit disk_root "$root_pct" "$DISK_THRESHOLD" pass "path=/"
fi

data_pct="$(disk_pct /srv/tantalum)"
if (( data_pct >= DISK_THRESHOLD )); then
  emit disk_data "$data_pct" "$DISK_THRESHOLD" fail "path=/srv/tantalum"
else
  emit disk_data "$data_pct" "$DISK_THRESHOLD" pass "path=/srv/tantalum"
fi

read -r mem_total mem_available < <(awk '
  /^MemTotal:/ {total=$2}
  /^MemAvailable:/ {available=$2}
  END {print total, available}
' /proc/meminfo)
memory_pct=$(( (100 * (mem_total - mem_available)) / mem_total ))
if (( memory_pct >= MEMORY_THRESHOLD )); then
  emit memory "$memory_pct" "$MEMORY_THRESHOLD" fail "source=/proc/meminfo"
else
  emit memory "$memory_pct" "$MEMORY_THRESHOLD" pass "source=/proc/meminfo"
fi

bad_containers=()
for container in "${required_containers[@]}"; do
  inspect="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
  if [[ -z "$inspect" ]]; then
    bad_containers+=("$container:missing")
    continue
  fi
  status="${inspect%% *}"
  health="${inspect#* }"
  if [[ "$status" != "running" || "$health" == "unhealthy" ]]; then
    bad_containers+=("$container:${status}/${health}")
  fi
done

if (( ${#bad_containers[@]} > 0 )); then
  emit container_health "${#bad_containers[@]}" 0 fail "containers=$(IFS=,; echo "${bad_containers[*]}")"
else
  emit container_health 0 0 pass "containers=required"
fi

now_epoch="$(date -u +%s)"
success_epoch_file="$BACKUP_STATE_DIR/last_success_epoch"
if [[ -f "$success_epoch_file" ]]; then
  last_success_epoch="$(cat "$success_epoch_file")"
  backup_age_minutes=$(( (now_epoch - last_success_epoch) / 60 ))
else
  backup_age_minutes=999999
fi

if (( backup_age_minutes > BACKUP_MAX_AGE_MINUTES )); then
  emit backup_age "$backup_age_minutes" "$BACKUP_MAX_AGE_MINUTES" fail "state=$success_epoch_file"
else
  emit backup_age "$backup_age_minutes" "$BACKUP_MAX_AGE_MINUTES" pass "state=$success_epoch_file"
fi

exit "$failures"

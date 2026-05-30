#!/usr/bin/env bash
set -euo pipefail

BACKUP_STATE_DIR="${TANTALUM_BACKUP_STATE_DIR:-/var/lib/tantalum/backup}"
DISK_THRESHOLD="${TANTALUM_MONITOR_DISK_THRESHOLD:-80}"
MEMORY_THRESHOLD="${TANTALUM_MONITOR_MEMORY_THRESHOLD:-85}"
BACKUP_MAX_AGE_MINUTES="${TANTALUM_MONITOR_BACKUP_MAX_AGE_MINUTES:-1800}"
ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
ENV_FILE="${TANTALUM_ENV_FILE:-$ROOT_DIR/appwrite/tantalum.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

APPWRITE_FUNCTION_WARM_ENABLED="${TANTALUM_MONITOR_AGENT_SETTINGS_WARM_ENABLED:-true}"
APPWRITE_FUNCTION_WARM_MAX_SECONDS="${TANTALUM_MONITOR_AGENT_SETTINGS_WARM_MAX_SECONDS:-25}"
APPWRITE_FUNCTION_ASYNC_WARM_ENABLED="${TANTALUM_MONITOR_AGENT_SETTINGS_ASYNC_WARM_ENABLED:-auto}"
APPWRITE_FUNCTION_ASYNC_WARM_MAX_SECONDS="${TANTALUM_MONITOR_AGENT_SETTINGS_ASYNC_WARM_MAX_SECONDS:-95}"
APPWRITE_FUNCTION_ASYNC_WARM_POLL_SECONDS="${TANTALUM_MONITOR_AGENT_SETTINGS_ASYNC_WARM_POLL_SECONDS:-2}"
APPWRITE_MONITOR_API_KEY="${TANTALUM_MONITOR_APPWRITE_API_KEY:-${APPWRITE_API_KEY:-}}"
AGENT_SETTINGS_FUNCTION_ID="${TANTALUM_AGENT_SETTINGS_FUNCTION_ID:-agent-settings}"

required_containers=(
  appwrite
  appwrite-console
  appwrite-mongodb
  appwrite-redis
  appwrite-traefik
  appwrite-realtime
  appwrite-worker-functions
  appwrite-worker-executions
  appwrite-worker-builds
  appwrite-task-scheduler-functions
  appwrite-task-scheduler-executions
  appwrite-task-scheduler-messages
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

if [[ "$APPWRITE_FUNCTION_WARM_ENABLED" == "true" ]]; then
  if [[ -z "${APPWRITE_ENDPOINT:-}" || -z "${APPWRITE_PROJECT_ID:-}" ]]; then
    emit agent_settings_warm 1 0 fail "reason=missing_endpoint_or_project env=$ENV_FILE"
  else
    appwrite_base="${APPWRITE_ENDPOINT%/}"
    if [[ "$appwrite_base" != */v1 ]]; then
      appwrite_base="${appwrite_base}/v1"
    fi

    warm_payload='{"body":"{\"reason\":\"vm-monitor\"}","async":false,"path":"/warm","method":"POST","headers":{"content-type":"application/json"}}'
    warm_response="$(curl --silent --show-error --max-time "$APPWRITE_FUNCTION_WARM_MAX_SECONDS" \
      -X POST \
      -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
      -H "X-Appwrite-Response-Format: 1.4.0" \
      -H "Content-Type: application/json" \
      --data "$warm_payload" \
      "$appwrite_base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions" 2>&1)" || {
        curl_status=$?
        emit agent_settings_warm "$curl_status" 0 fail "reason=curl_error function=$AGENT_SETTINGS_FUNCTION_ID detail=$(printf '%s' "$warm_response" | tr '[:space:]' '_' | cut -c1-160)"
        exit "$failures"
      }

    warm_status="$(printf '%s' "$warm_response" | jq -r '.status // ""' 2>/dev/null || true)"
    warm_response_code="$(printf '%s' "$warm_response" | jq -r '.responseStatusCode // 0' 2>/dev/null || true)"
    warm_duration="$(printf '%s' "$warm_response" | jq -r '.duration // 0' 2>/dev/null || true)"
    if [[ "$warm_status" == "completed" && "$warm_response_code" == "200" ]]; then
      emit agent_settings_warm 0 0 pass "function=$AGENT_SETTINGS_FUNCTION_ID duration=$warm_duration"
    else
      emit agent_settings_warm 1 0 fail "function=$AGENT_SETTINGS_FUNCTION_ID status=${warm_status:-unknown} responseStatusCode=${warm_response_code:-0} duration=${warm_duration:-0}"
    fi
  fi
fi

if [[ "$APPWRITE_FUNCTION_ASYNC_WARM_ENABLED" == "auto" ]]; then
  if [[ -n "$APPWRITE_MONITOR_API_KEY" ]]; then
    APPWRITE_FUNCTION_ASYNC_WARM_ENABLED="true"
  else
    APPWRITE_FUNCTION_ASYNC_WARM_ENABLED="false"
  fi
fi

if [[ "$APPWRITE_FUNCTION_ASYNC_WARM_ENABLED" == "true" ]]; then
  if [[ -z "${APPWRITE_ENDPOINT:-}" || -z "${APPWRITE_PROJECT_ID:-}" || -z "$APPWRITE_MONITOR_API_KEY" ]]; then
    emit agent_settings_async_warm 1 0 fail "reason=missing_endpoint_project_or_monitor_key env=$ENV_FILE"
  else
    appwrite_base="${APPWRITE_ENDPOINT%/}"
    if [[ "$appwrite_base" != */v1 ]]; then
      appwrite_base="${appwrite_base}/v1"
    fi

    async_payload='{"body":"{\"reason\":\"vm-monitor-async\"}","async":true,"path":"/warm","method":"POST","headers":{"content-type":"application/json"}}'
    async_response="$(curl --silent --show-error --max-time 15 \
      -X POST \
      -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
      -H "X-Appwrite-Key: ${APPWRITE_MONITOR_API_KEY}" \
      -H "X-Appwrite-Response-Format: 1.4.0" \
      -H "Content-Type: application/json" \
      --data "$async_payload" \
      "$appwrite_base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions" 2>&1)" || {
        curl_status=$?
        emit agent_settings_async_warm "$curl_status" 0 fail "reason=create_curl_error function=$AGENT_SETTINGS_FUNCTION_ID detail=$(printf '%s' "$async_response" | tr '[:space:]' '_' | cut -c1-160)"
        exit "$failures"
      }

    execution_id="$(printf '%s' "$async_response" | jq -r '."$id" // .id // ""' 2>/dev/null || true)"
    if [[ -z "$execution_id" ]]; then
      emit agent_settings_async_warm 1 0 fail "reason=missing_execution_id function=$AGENT_SETTINGS_FUNCTION_ID"
    else
      deadline=$(( $(date -u +%s) + APPWRITE_FUNCTION_ASYNC_WARM_MAX_SECONDS ))
      async_status=""
      async_response_code="0"
      async_duration="0"
      while (( $(date -u +%s) < deadline )); do
        poll_response="$(curl --silent --show-error --max-time 15 \
          -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
          -H "X-Appwrite-Key: ${APPWRITE_MONITOR_API_KEY}" \
          -H "X-Appwrite-Response-Format: 1.4.0" \
          "$appwrite_base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions/$execution_id" 2>&1)" || {
            curl_status=$?
            emit agent_settings_async_warm "$curl_status" 0 fail "reason=poll_curl_error function=$AGENT_SETTINGS_FUNCTION_ID execution=$execution_id detail=$(printf '%s' "$poll_response" | tr '[:space:]' '_' | cut -c1-160)"
            exit "$failures"
          }
        async_status="$(printf '%s' "$poll_response" | jq -r '.status // ""' 2>/dev/null || true)"
        async_response_code="$(printf '%s' "$poll_response" | jq -r '.responseStatusCode // 0' 2>/dev/null || true)"
        async_duration="$(printf '%s' "$poll_response" | jq -r '.duration // 0' 2>/dev/null || true)"
        if [[ "$async_status" == "completed" || "$async_status" == "failed" || "$async_status" == "timeout" ]]; then
          break
        fi
        sleep "$APPWRITE_FUNCTION_ASYNC_WARM_POLL_SECONDS"
      done

      if [[ "$async_status" == "completed" && "$async_response_code" == "200" ]]; then
        emit agent_settings_async_warm 0 0 pass "function=$AGENT_SETTINGS_FUNCTION_ID execution=$execution_id duration=$async_duration"
      else
        emit agent_settings_async_warm 1 0 fail "function=$AGENT_SETTINGS_FUNCTION_ID execution=$execution_id status=${async_status:-waiting} responseStatusCode=${async_response_code:-0} duration=${async_duration:-0}"
      fi
    fi
  fi
fi

exit "$failures"

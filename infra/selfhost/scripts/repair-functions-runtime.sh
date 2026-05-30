#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
APPWRITE_DIR="${TANTALUM_APPWRITE_DIR:-$ROOT_DIR/appwrite}"
ENV_FILE="${TANTALUM_ENV_FILE:-$APPWRITE_DIR/tantalum.env}"
AGENT_SETTINGS_FUNCTION_ID="${TANTALUM_AGENT_SETTINGS_FUNCTION_ID:-agent-settings}"
SYNC_WARM_MAX_SECONDS="${TANTALUM_REPAIR_AGENT_SETTINGS_WARM_MAX_SECONDS:-35}"
SYNC_WARM_RETRY_SECONDS="${TANTALUM_REPAIR_AGENT_SETTINGS_WARM_RETRY_SECONDS:-90}"
ASYNC_WARM_MAX_SECONDS="${TANTALUM_REPAIR_AGENT_SETTINGS_ASYNC_WARM_MAX_SECONDS:-95}"
ASYNC_WARM_POLL_SECONDS="${TANTALUM_REPAIR_AGENT_SETTINGS_ASYNC_WARM_POLL_SECONDS:-2}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

APPWRITE_MONITOR_API_KEY="${TANTALUM_MONITOR_APPWRITE_API_KEY:-${APPWRITE_API_KEY:-}}"
run_compose_up=true
restart_runtime=false
run_async_check="${TANTALUM_REPAIR_AGENT_SETTINGS_ASYNC_WARM:-auto}"

usage() {
  cat <<'EOF'
Usage: repair-functions-runtime.sh [--restart] [--skip-up] [--async] [--no-async]

Repairs and verifies the Appwrite function runtime path used by Tantalum AI:
function workers, function schedulers, builds, and openruntimes executor.

Options:
  --restart   Restart function runtime containers after docker compose up -d.
  --skip-up   Do not run docker compose up -d before verification.
  --async     Require async /warm execution polling. Needs TANTALUM_MONITOR_APPWRITE_API_KEY.
  --no-async  Skip async execution polling.
EOF
}

while (($#)); do
  case "$1" in
    --restart)
      restart_runtime=true
      ;;
    --skip-up)
      run_compose_up=false
      ;;
    --async)
      run_async_check=true
      ;;
    --no-async)
      run_async_check=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

runtime_services=(
  appwrite-worker-functions
  appwrite-worker-executions
  appwrite-worker-builds
  appwrite-task-scheduler-functions
  appwrite-task-scheduler-executions
  appwrite-task-scheduler-messages
  openruntimes-executor
)

compose_cmd=()
if docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  echo "Docker Compose is required." >&2
  exit 1
fi

container_status() {
  local container="$1"
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true
}

print_statuses() {
  local title="$1"
  echo ""
  echo "$title"
  for service in "${runtime_services[@]}"; do
    status="$(container_status "$service")"
    if [[ -z "$status" ]]; then
      echo "  $service missing"
    else
      echo "  $service $status"
    fi
  done
}

show_runtime_logs() {
  echo ""
  echo "Recent function-runtime logs:"
  for service in "${runtime_services[@]}"; do
    if docker inspect "$service" >/dev/null 2>&1; then
      echo ""
      echo "== $service =="
      docker logs --tail 80 "$service" 2>&1 || true
    fi
  done
}

ensure_worker_executions_service() {
  local compose_file=""
  local candidate

  for candidate in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [[ -f "$APPWRITE_DIR/$candidate" ]]; then
      compose_file="$APPWRITE_DIR/$candidate"
      break
    fi
  done

  if [[ -z "$compose_file" ]]; then
    echo "No Docker Compose file found in $APPWRITE_DIR." >&2
    return 1
  fi

  if grep -q '^  appwrite-worker-executions:' "$compose_file"; then
    return 0
  fi

  if ! grep -q '^  appwrite-worker-functions:' "$compose_file"; then
    echo "Cannot add appwrite-worker-executions because appwrite-worker-functions was not found in $compose_file." >&2
    return 1
  fi

  local appwrite_image
  appwrite_image="$(awk '
    /^  appwrite-worker-functions:/ { in_service = 1; next }
    in_service && /^  [^[:space:]].*:/ { in_service = 0 }
    in_service && /^[[:space:]]*image:/ {
      sub(/^[[:space:]]*image:[[:space:]]*/, "")
      print
      exit
    }
  ' "$compose_file")"

  if [[ -z "$appwrite_image" ]]; then
    appwrite_image="appwrite/appwrite:1.9.0"
  fi

  local backup_file
  local tmp_file
  backup_file="${compose_file}.pre-worker-executions-$(date -u +%Y%m%dT%H%M%SZ)"
  tmp_file="$(mktemp)"

  echo "Adding missing appwrite-worker-executions service to $(basename "$compose_file")..."
  cp "$compose_file" "$backup_file"
  awk -v image="$appwrite_image" '
    /^  appwrite-worker-functions:/ && !inserted {
      print "  appwrite-worker-executions:"
      print "    image: " image
      print "    entrypoint: worker-executions"
      print "    <<: *x-logging"
      print "    container_name: appwrite-worker-executions"
      print "    restart: unless-stopped"
      print "    networks:"
      print "      - appwrite"
      print "    depends_on:"
      print "      redis:"
      print "        condition: service_healthy"
      print "      mongodb:"
      print "        condition: service_healthy"
      print "    environment:"
      print "      - _APP_ENV"
      print "      - _APP_WORKER_PER_CORE"
      print "      - _APP_OPENSSL_KEY_V1"
      print "      - _APP_DOMAIN"
      print "      - _APP_OPTIONS_FORCE_HTTPS"
      print "      - _APP_REDIS_HOST"
      print "      - _APP_REDIS_PORT"
      print "      - _APP_REDIS_USER"
      print "      - _APP_REDIS_PASS"
      print "      - _APP_DB_ADAPTER"
      print "      - _APP_DB_HOST"
      print "      - _APP_DB_PORT"
      print "      - _APP_DB_SCHEMA"
      print "      - _APP_DB_USER"
      print "      - _APP_DB_PASS"
      print "      - _APP_DB_ADAPTER"
      print "      - _APP_LOGGING_CONFIG"
      print ""
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        exit 42
      }
    }
  ' "$compose_file" > "$tmp_file" || {
    rm -f "$tmp_file"
    echo "Failed to generate updated Docker Compose file." >&2
    return 1
  }

  mv "$tmp_file" "$compose_file"
  echo "Backed up previous compose file to $backup_file."

  (cd "$APPWRITE_DIR" && "${compose_cmd[@]}" config --quiet)
}

normalize_appwrite_base() {
  local base="${APPWRITE_ENDPOINT:-}"
  if [[ -z "$base" ]]; then
    base="http://127.0.0.1/v1"
  fi
  base="${base%/}"
  if [[ "$base" != */v1 ]]; then
    base="${base}/v1"
  fi
  printf '%s' "$base"
}

require_project() {
  if [[ -z "${APPWRITE_PROJECT_ID:-}" ]]; then
    echo "APPWRITE_PROJECT_ID is required in $ENV_FILE or the environment." >&2
    exit 1
  fi
}

warm_sync() {
  require_project
  local base="$1"
  local payload='{"body":"{\"reason\":\"repair-functions-runtime\"}","async":false,"path":"/warm","method":"POST","headers":{"content-type":"application/json"}}'
  local response
  response="$(curl --silent --show-error --max-time "$SYNC_WARM_MAX_SECONDS" \
    -X POST \
    -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
    -H "X-Appwrite-Response-Format: 1.4.0" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions")"
  echo "$response" | jq .
  local status
  local response_status_code
  status="$(echo "$response" | jq -r '.status // ""')"
  response_status_code="$(echo "$response" | jq -r '.responseStatusCode // 0')"
  [[ "$status" == "completed" && "$response_status_code" == "200" ]]
}

warm_sync_with_retry() {
  local base="$1"
  local deadline
  local attempt=1
  deadline=$(( $(date -u +%s) + SYNC_WARM_RETRY_SECONDS ))

  while true; do
    echo "sync /warm attempt $attempt..."
    if warm_sync "$base"; then
      return 0
    fi

    if (( $(date -u +%s) >= deadline )); then
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 5
  done
}

warm_async() {
  require_project
  if [[ -z "$APPWRITE_MONITOR_API_KEY" ]]; then
    echo "TANTALUM_MONITOR_APPWRITE_API_KEY or APPWRITE_API_KEY is required for async execution polling." >&2
    return 1
  fi

  local base="$1"
  local payload='{"body":"{\"reason\":\"repair-functions-runtime-async\"}","async":true,"path":"/warm","method":"POST","headers":{"content-type":"application/json"}}'
  local response
  response="$(curl --silent --show-error --max-time 15 \
    -X POST \
    -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
    -H "X-Appwrite-Key: ${APPWRITE_MONITOR_API_KEY}" \
    -H "X-Appwrite-Response-Format: 1.4.0" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions")"
  echo "$response" | jq .

  local execution_id
  execution_id="$(echo "$response" | jq -r '."$id" // .id // ""')"
  if [[ -z "$execution_id" ]]; then
    echo "Appwrite did not return an async execution ID." >&2
    return 1
  fi

  local deadline
  local poll_response
  local status=""
  local response_status_code="0"
  local duration="0"
  deadline=$(( $(date -u +%s) + ASYNC_WARM_MAX_SECONDS ))
  while (( $(date -u +%s) < deadline )); do
    poll_response="$(curl --silent --show-error --max-time 15 \
      -H "X-Appwrite-Project: ${APPWRITE_PROJECT_ID}" \
      -H "X-Appwrite-Key: ${APPWRITE_MONITOR_API_KEY}" \
      -H "X-Appwrite-Response-Format: 1.4.0" \
      "$base/functions/$AGENT_SETTINGS_FUNCTION_ID/executions/$execution_id")"
    status="$(echo "$poll_response" | jq -r '.status // ""')"
    response_status_code="$(echo "$poll_response" | jq -r '.responseStatusCode // 0')"
    duration="$(echo "$poll_response" | jq -r '.duration // 0')"
    echo "async execution $execution_id status=${status:-waiting} responseStatusCode=$response_status_code duration=$duration"
    if [[ "$status" == "completed" || "$status" == "failed" || "$status" == "timeout" ]]; then
      break
    fi
    sleep "$ASYNC_WARM_POLL_SECONDS"
  done

  [[ "$status" == "completed" && "$response_status_code" == "200" ]]
}

if [[ ! -d "$APPWRITE_DIR" ]]; then
  echo "Appwrite directory not found: $APPWRITE_DIR" >&2
  exit 1
fi

print_statuses "Before repair:"

ensure_worker_executions_service

if [[ "$run_compose_up" == "true" ]]; then
  echo ""
  echo "Reconciling Appwrite function runtime services..."
  (cd "$APPWRITE_DIR" && "${compose_cmd[@]}" up -d "${runtime_services[@]}")
fi

if [[ "$restart_runtime" == "true" ]]; then
  echo ""
  echo "Restarting Appwrite function runtime containers..."
  for service in "${runtime_services[@]}"; do
    if docker inspect "$service" >/dev/null 2>&1; then
      docker restart "$service" >/dev/null
    fi
  done
fi

print_statuses "After repair:"

bad=()
for service in "${runtime_services[@]}"; do
  inspect="$(container_status "$service")"
  if [[ -z "$inspect" ]]; then
    bad+=("$service:missing")
    continue
  fi
  status="${inspect%% *}"
  health="${inspect#* }"
  if [[ "$status" != "running" || "$health" == "unhealthy" ]]; then
    bad+=("$service:${status}/${health}")
  fi
done

if (( ${#bad[@]} > 0 )); then
  echo "Function runtime containers are not healthy: $(IFS=,; echo "${bad[*]}")" >&2
  show_runtime_logs
  exit 1
fi

base="$(normalize_appwrite_base)"
echo ""
echo "Verifying sync /warm execution at $base..."
if ! warm_sync_with_retry "$base"; then
  echo "Sync /warm execution failed." >&2
  show_runtime_logs
  exit 1
fi

if [[ "$run_async_check" == "auto" ]]; then
  if [[ -n "$APPWRITE_MONITOR_API_KEY" ]]; then
    run_async_check=true
  else
    run_async_check=false
  fi
fi

if [[ "$run_async_check" == "true" ]]; then
  echo ""
  echo "Verifying async /warm execution polling..."
  if ! warm_async "$base"; then
    echo "Async /warm execution did not complete successfully." >&2
    show_runtime_logs
    exit 1
  fi
else
  echo ""
  echo "Skipping async polling because no monitor API key is configured."
fi

echo ""
echo "Appwrite function runtime repair and verification completed."

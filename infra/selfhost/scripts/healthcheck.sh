#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
ENV_FILE="${TANTALUM_ENV_FILE:-$ROOT_DIR/appwrite/tantalum.env}"
ENDPOINT="${1:-}"

if [[ -z "$ENDPOINT" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ENDPOINT="${APPWRITE_ENDPOINT:-}"
fi

if [[ -z "$ENDPOINT" ]]; then
  ENDPOINT="http://127.0.0.1/v1"
fi

base="${ENDPOINT%/}"
if [[ "$base" != */v1 ]]; then
  base="${base}/v1"
fi

echo "Endpoint: $base"
curl --fail --show-error --silent "$base/health" | jq . || curl --fail --show-error --silent "$base/health"

if command -v docker >/dev/null 2>&1; then
  echo ""
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E '(^NAMES|appwrite)' || true
fi

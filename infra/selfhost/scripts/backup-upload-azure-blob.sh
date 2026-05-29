#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
BACKUP_SCRIPT="${TANTALUM_BACKUP_SCRIPT:-$ROOT_DIR/bin/backup.sh}"
STATE_DIR="${TANTALUM_BACKUP_STATE_DIR:-/var/lib/tantalum/backup}"
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:?AZURE_STORAGE_ACCOUNT is required}"
STORAGE_CONTAINER="${AZURE_STORAGE_CONTAINER:?AZURE_STORAGE_CONTAINER is required}"
BLOB_PREFIX="${AZURE_STORAGE_BLOB_PREFIX:-scheduled}"

mkdir -p "$STATE_DIR"

log() {
  local level="$1"
  shift
  echo "level=$level event=backup_upload $*"
  logger -t tantalum-backup "level=$level event=backup_upload $*"
}

mark_failure() {
  local message="$1"
  date -u +%s >"$STATE_DIR/last_failure_epoch"
  printf '%s\n' "$message" >"$STATE_DIR/last_failure"
  log error "status=fail message=\"$message\""
}

trap 'mark_failure "unexpected_error line=$LINENO"' ERR

archive_path="$("$BACKUP_SCRIPT" --print-path | tail -n 1)"
if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  mark_failure "backup_archive_missing"
  exit 1
fi

token_json="$(curl --fail --silent --show-error --retry 5 --retry-delay 3 \
  -H Metadata:true \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F")"
access_token="$(printf '%s' "$token_json" | jq -r '.access_token // empty')"
if [[ -z "$access_token" ]]; then
  mark_failure "managed_identity_token_missing"
  exit 1
fi

blob_name="$(basename "$archive_path")"
if [[ -n "$BLOB_PREFIX" ]]; then
  blob_name="${BLOB_PREFIX%/}/$blob_name"
fi
encoded_blob_name="$(printf '%s' "$blob_name" | jq -sRr @uri | sed 's|%2F|/|g')"
blob_url="https://${STORAGE_ACCOUNT}.blob.core.windows.net/${STORAGE_CONTAINER}/${encoded_blob_name}"

curl --fail --silent --show-error --retry 5 --retry-delay 5 \
  -X PUT \
  -H "Authorization: Bearer ${access_token}" \
  -H "x-ms-date: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')" \
  -H "x-ms-version: 2023-11-03" \
  -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: application/gzip" \
  --data-binary "@${archive_path}" \
  "$blob_url" >/dev/null

now_epoch="$(date -u +%s)"
date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE_DIR/last_success_at"
printf '%s\n' "$now_epoch" >"$STATE_DIR/last_success_epoch"
printf '%s\n' "$archive_path" >"$STATE_DIR/last_archive_path"
printf '%s\n' "$blob_name" >"$STATE_DIR/last_blob_name"
rm -f "$STATE_DIR/last_failure" "$STATE_DIR/last_failure_epoch"

bytes="$(stat -c '%s' "$archive_path")"
log info "status=pass archive=\"$archive_path\" blob=\"$blob_name\" bytes=$bytes"

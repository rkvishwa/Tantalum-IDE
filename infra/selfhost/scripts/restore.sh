#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
APPWRITE_DIR="${TANTALUM_APPWRITE_DIR:-$ROOT_DIR/appwrite}"
BACKUP_PATH="${1:-}"
FORCE=false

shift || true
for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: restore.sh <backup.tar.gz|backup.tar.gz.enc> --force

Restores Appwrite compose config and Appwrite Docker volumes from a backup created by backup.sh.
Set BACKUP_ENCRYPTION_PASSPHRASE or /srv/tantalum/backup.passphrase when restoring encrypted backups.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BACKUP_PATH" ]]; then
  echo "Backup path is required." >&2
  exit 2
fi
if [[ "$FORCE" != true ]]; then
  echo "Refusing to restore without --force." >&2
  exit 2
fi
if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "Backup file not found: $BACKUP_PATH" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for restore." >&2
  exit 1
fi

restore_dir="$(mktemp -d "$ROOT_DIR/restore.XXXXXX")"
decrypted_path=""

cleanup() {
  rm -rf "$restore_dir"
  if [[ -n "$decrypted_path" ]]; then
    rm -f "$decrypted_path"
  fi
}
trap cleanup EXIT

source_archive="$BACKUP_PATH"
if [[ "$BACKUP_PATH" == *.enc ]]; then
  passphrase="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
  if [[ -z "$passphrase" && -f "$ROOT_DIR/backup.passphrase" ]]; then
    passphrase="$(cat "$ROOT_DIR/backup.passphrase")"
  fi
  if [[ -z "$passphrase" ]]; then
    echo "Encrypted backup requires BACKUP_ENCRYPTION_PASSPHRASE or $ROOT_DIR/backup.passphrase." >&2
    exit 1
  fi
  export BACKUP_ENCRYPTION_PASSPHRASE="$passphrase"
  decrypted_path="$restore_dir/backup.tar.gz"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$BACKUP_PATH" \
    -out "$decrypted_path" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE
  source_archive="$decrypted_path"
fi

tar -C "$restore_dir" -xzf "$source_archive"
mkdir -p "$APPWRITE_DIR"

if [[ -d "$APPWRITE_DIR" ]]; then
  (
    cd "$APPWRITE_DIR"
    docker compose down || true
  )
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
for file_name in appwrite.env tantalum.env docker-compose.yml docker-compose.override.yml; do
  if [[ -f "$APPWRITE_DIR/$file_name" ]]; then
    cp -a "$APPWRITE_DIR/$file_name" "$APPWRITE_DIR/${file_name}.pre-restore-${timestamp}"
  fi
done

[[ -f "$restore_dir/appwrite.env" ]] && cp -a "$restore_dir/appwrite.env" "$APPWRITE_DIR/.env"
[[ -f "$restore_dir/tantalum.env" ]] && cp -a "$restore_dir/tantalum.env" "$APPWRITE_DIR/tantalum.env"
[[ -f "$restore_dir/docker-compose.yml" ]] && cp -a "$restore_dir/docker-compose.yml" "$APPWRITE_DIR/docker-compose.yml"
[[ -f "$restore_dir/docker-compose.override.yml" ]] && cp -a "$restore_dir/docker-compose.override.yml" "$APPWRITE_DIR/docker-compose.override.yml"

if [[ -s "$restore_dir/volumes.tsv" ]]; then
  while IFS=$'\t' read -r archive_name volume_name; do
    [[ -n "$archive_name" && -n "$volume_name" ]] || continue
    archive_file="$restore_dir/volumes/$archive_name"
    if [[ ! -f "$archive_file" ]]; then
      echo "Skipping missing volume archive: $archive_file" >&2
      continue
    fi
    docker volume create "$volume_name" >/dev/null
    docker run --rm \
      --volume "${volume_name}:/volume" \
      --volume "${restore_dir}/volumes:/backup:ro" \
      alpine:3.20 \
      sh -c "rm -rf /volume/* /volume/.[!.]* /volume/..?* 2>/dev/null || true; cd /volume && tar -xzf /backup/${archive_name}"
  done <"$restore_dir/volumes.tsv"
fi

if [[ -f "$APPWRITE_DIR/docker-compose.yml" ]]; then
  (
    cd "$APPWRITE_DIR"
    docker compose up -d
  )
else
  echo "Restore completed, but docker-compose.yml was not present in the backup." >&2
fi

echo "Restore completed from: $BACKUP_PATH"

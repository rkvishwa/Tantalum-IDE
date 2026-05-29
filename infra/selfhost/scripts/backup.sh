#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
APPWRITE_DIR="${TANTALUM_APPWRITE_DIR:-$ROOT_DIR/appwrite}"
BACKUP_DIR="${TANTALUM_BACKUP_DIR:-$ROOT_DIR/backups}"
PRINT_PATH=false

for arg in "$@"; do
  case "$arg" in
    --print-path)
      PRINT_PATH=true
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: backup.sh [--print-path]

Creates a compressed Appwrite host backup under /srv/tantalum/backups by default.
Set BACKUP_ENCRYPTION_PASSPHRASE or /srv/tantalum/backup.passphrase to encrypt the archive.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
stage_dir="$(mktemp -d "${BACKUP_DIR}/stage-${timestamp}.XXXXXX")"
archive_path="${BACKUP_DIR}/tantalum-appwrite-${timestamp}.tar.gz"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

copy_if_exists() {
  local source_path="$1"
  local target_name="$2"
  if [[ -e "$source_path" ]]; then
    cp -a "$source_path" "$stage_dir/$target_name"
  fi
}

container_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Fxq "$1"
}

volume_archive_name() {
  printf '%s' "$1" | tr '/:' '__'
}

copy_if_exists "$APPWRITE_DIR/.env" "appwrite.env"
copy_if_exists "$APPWRITE_DIR/tantalum.env" "tantalum.env"
copy_if_exists "$APPWRITE_DIR/docker-compose.yml" "docker-compose.yml"
copy_if_exists "$APPWRITE_DIR/docker-compose.override.yml" "docker-compose.override.yml"

{
  echo "createdAt=$timestamp"
  echo "rootDir=$ROOT_DIR"
  echo "appwriteDir=$APPWRITE_DIR"
  echo "hostname=$(hostname)"
  docker --version 2>/dev/null || true
  docker compose version 2>/dev/null || true
} >"$stage_dir/backup-manifest.txt"

if command -v docker >/dev/null 2>&1; then
  docker ps -a >"$stage_dir/docker-ps.txt" 2>&1 || true
  docker volume ls >"$stage_dir/docker-volumes.txt" 2>&1 || true

  if [[ -d "$APPWRITE_DIR" ]]; then
    (
      cd "$APPWRITE_DIR"
      docker compose ps >"$stage_dir/docker-compose-ps.txt" 2>&1 || true
    )
  fi

  mkdir -p "$stage_dir/volumes"
  : >"$stage_dir/volumes.tsv"
  while IFS= read -r volume_name; do
    [[ -n "$volume_name" ]] || continue
    archive_name="$(volume_archive_name "$volume_name").tgz"
    echo -e "${archive_name}\t${volume_name}" >>"$stage_dir/volumes.tsv"
    docker run --rm \
      --volume "${volume_name}:/volume:ro" \
      --volume "${stage_dir}/volumes:/backup" \
      alpine:3.20 \
      sh -c "cd /volume && tar -czf /backup/${archive_name} ." >/dev/null
  done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)appwrite(_|$)' || true)

  if container_exists appwrite-mongodb; then
    docker exec appwrite-mongodb sh -lc \
      'mongodump --archive --gzip ${MONGO_INITDB_ROOT_USERNAME:+--username "$MONGO_INITDB_ROOT_USERNAME"} ${MONGO_INITDB_ROOT_PASSWORD:+--password "$MONGO_INITDB_ROOT_PASSWORD"} ${MONGO_INITDB_ROOT_USERNAME:+--authenticationDatabase admin}' \
      >"$stage_dir/mongodb.archive.gz" 2>"$stage_dir/mongodb.dump.log" || true
  fi

  if container_exists appwrite-mariadb; then
    docker exec appwrite-mariadb sh -lc \
      'mariadb-dump -uroot ${MYSQL_ROOT_PASSWORD:+-p"$MYSQL_ROOT_PASSWORD"} --all-databases --single-transaction' \
      2>"$stage_dir/mariadb.dump.log" | gzip >"$stage_dir/mariadb.sql.gz" || true
  fi
fi

tar -C "$stage_dir" -czf "$archive_path" .
final_path="$archive_path"

passphrase="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
if [[ -z "$passphrase" && -f "$ROOT_DIR/backup.passphrase" ]]; then
  passphrase="$(cat "$ROOT_DIR/backup.passphrase")"
fi

if [[ -n "$passphrase" ]]; then
  export BACKUP_ENCRYPTION_PASSPHRASE="$passphrase"
  encrypted_path="${archive_path}.enc"
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -in "$archive_path" \
    -out "$encrypted_path" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE
  rm -f "$archive_path"
  final_path="$encrypted_path"
fi

echo "Backup created: $final_path"
if [[ "$PRINT_PATH" == true ]]; then
  printf '%s\n' "$final_path"
fi

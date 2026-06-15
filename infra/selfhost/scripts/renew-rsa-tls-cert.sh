#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TANTALUM_ROOT_DIR:-/srv/tantalum}"
ENV_FILE="${TANTALUM_ENV_FILE:-$ROOT_DIR/appwrite/tantalum.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DOMAIN="${TANTALUM_TLS_DOMAIN:-${APP_DOMAIN:-}}"
if [[ -z "$DOMAIN" ]]; then
  echo "TANTALUM_TLS_DOMAIN or APP_DOMAIN is required." >&2
  exit 1
fi

CERT_VOLUME="${TANTALUM_APPWRITE_CERT_VOLUME:-/var/lib/docker/volumes/appwrite_appwrite-certificates/_data}"
CERT_DIR="${TANTALUM_TLS_CERT_DIR:-$CERT_VOLUME/$DOMAIN}"
WORK_DIR="${TANTALUM_CERTBOT_WORK_DIR:-$ROOT_DIR/certbot-rsa-$DOMAIN}"
CERTBOT_IMAGE="${TANTALUM_CERTBOT_IMAGE:-certbot/certbot:latest}"
TRAEFIK_CONTAINER="${TANTALUM_TRAEFIK_CONTAINER:-appwrite-traefik}"
RENEW_WINDOW_DAYS="${TANTALUM_TLS_RENEW_WINDOW_DAYS:-30}"
RSA_KEY_SIZE="${TANTALUM_TLS_RSA_KEY_SIZE:-2048}"
RENEW_WINDOW_SECONDS=$((RENEW_WINDOW_DAYS * 24 * 60 * 60))

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required." >&2
    exit 1
  fi
}

cert_is_rsa() {
  [[ -f "$CERT_DIR/fullchain.pem" ]] &&
    openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text |
      grep -q "Public Key Algorithm: rsaEncryption"
}

cert_is_outside_renewal_window() {
  [[ -f "$CERT_DIR/fullchain.pem" ]] &&
    openssl x509 -checkend "$RENEW_WINDOW_SECONDS" -noout -in "$CERT_DIR/fullchain.pem" >/dev/null
}

restart_traefik() {
  docker start "$TRAEFIK_CONTAINER" >/dev/null 2>&1 || true
}

require_command docker
require_command openssl

if cert_is_rsa && cert_is_outside_renewal_window; then
  echo "$DOMAIN certificate is RSA and outside the ${RENEW_WINDOW_DAYS}-day renewal window."
  exit 0
fi

mkdir -p "$CERT_DIR" "$WORK_DIR/config" "$WORK_DIR/work" "$WORK_DIR/logs"
if [[ -f "$CERT_DIR/fullchain.pem" || -f "$CERT_DIR/privkey.pem" ]]; then
  backup_dir="$CERT_DIR.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$CERT_DIR" "$backup_dir"
  echo "Backed up current certs to $backup_dir"
fi

trap restart_traefik EXIT
echo "Stopping $TRAEFIK_CONTAINER for HTTP-01 challenge..."
docker stop "$TRAEFIK_CONTAINER" >/dev/null
sleep 2

certbot_account_args=(--register-unsafely-without-email)
if [[ -n "${TANTALUM_CERTBOT_EMAIL:-}" ]]; then
  certbot_account_args=(--email "$TANTALUM_CERTBOT_EMAIL")
fi

docker run --rm \
  -p 80:80 \
  -v "$WORK_DIR/config:/etc/letsencrypt" \
  -v "$WORK_DIR/work:/var/lib/letsencrypt" \
  -v "$WORK_DIR/logs:/var/log/letsencrypt" \
  "$CERTBOT_IMAGE" certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  "${certbot_account_args[@]}" \
  --preferred-challenges http \
  --key-type rsa \
  --rsa-key-size "$RSA_KEY_SIZE" \
  --force-renewal \
  --cert-name "$DOMAIN" \
  -d "$DOMAIN"

new_live="$WORK_DIR/config/live/$DOMAIN"
test -f "$new_live/fullchain.pem"
test -f "$new_live/privkey.pem"

install -m 0644 "$new_live/cert.pem" "$CERT_DIR/cert.pem"
install -m 0644 "$new_live/chain.pem" "$CERT_DIR/chain.pem"
install -m 0644 "$new_live/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -m 0600 "$new_live/privkey.pem" "$CERT_DIR/privkey.pem"

restart_traefik
trap - EXIT
sleep 5

openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -dates
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text |
  awk '/Public Key Algorithm/{print; getline; print; exit}'

param(
  [string]$ResourceGroup = "rg-tantalum-git-prod",
  [string]$VmName = "vm-tantalum-git-prod",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_ed25519",
  [string]$HostName = "",
  [string]$GitDomain = "git.metl.run",
  [string]$GiteaOrg = "tantalum-users",
  [string]$GiteaAdminUser = "tantalum-admin",
  [string]$GiteaAdminEmail = "admin@metl.run",
  [string]$GiteaAdminPassword = "",
  [string]$PostgresPassword = "",
  [string]$BackupStorageAccount = "tantalumbaktw0s316p45",
  [string]$BackupContainer = "git-backups"
)

$ErrorActionPreference = "Stop"

function Resolve-PathStrict($PathValue, $Name) {
  $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction SilentlyContinue
  if (-not $resolved) {
    throw "$Name was not found: $PathValue"
  }
  return $resolved.Path
}

function New-Secret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($buffer).TrimEnd("=") -replace "\+", "-" -replace "/", "_"
}

function Quote-Sh($Value) {
  return "'" + ([string]$Value).Replace("'", "'\''") + "'"
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required on PATH."
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "OpenSSH ssh is required on PATH."
}
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw "OpenSSH scp is required on PATH."
}

$sshKeyPath = Resolve-PathStrict $SshPrivateKeyPath "SSH private key"
if (-not $HostName) {
  $HostName = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
  if ($LASTEXITCODE -ne 0 -or -not $HostName) {
    throw "Could not resolve VM public IP. Pass -HostName explicitly."
  }
}

if (-not $GiteaAdminPassword) {
  $GiteaAdminPassword = New-Secret 30
}
if (-not $PostgresPassword) {
  $PostgresPassword = New-Secret 32
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$remoteScriptLocal = Join-Path $env:TEMP "configure-$VmName-gitea.sh"
$secretsPath = Join-Path $scriptRoot ".gitea-secrets.json"

$remoteTemplate = @'
#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT=/srv/tantalum-git
APP_ROOT=$DATA_ROOT/gitea
ADMIN_LINUX_USER=__ADMIN_LINUX_USER__
DOMAIN=__DOMAIN__
ORG=__GITEA_ORG__
ADMIN_USER=__GITEA_ADMIN_USER__
ADMIN_EMAIL=__GITEA_ADMIN_EMAIL__
ADMIN_PASSWORD=__GITEA_ADMIN_PASSWORD__
REQUESTED_POSTGRES_PASSWORD=__POSTGRES_PASSWORD__
BACKUP_STORAGE_ACCOUNT=__BACKUP_STORAGE_ACCOUNT__
BACKUP_CONTAINER=__BACKUP_CONTAINER__

if command -v cloud-init >/dev/null 2>&1; then
  sudo cloud-init status --wait || true
fi

if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
    sudo chmod a+r /etc/apt/keyrings/docker.asc
  fi
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
fi

if ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y jq
fi

sudo mkdir -p "$APP_ROOT/postgres" "$APP_ROOT/data" "$APP_ROOT/caddy/data" "$APP_ROOT/caddy/config" "$APP_ROOT/caddy/site" "$DATA_ROOT/bin" "$DATA_ROOT/backups"
sudo chown -R "$ADMIN_LINUX_USER:$ADMIN_LINUX_USER" "$DATA_ROOT/bin" "$DATA_ROOT/backups" "$APP_ROOT/data" "$APP_ROOT/caddy"
if [ -d "$APP_ROOT/postgres" ]; then
  sudo chown -R 70:70 "$APP_ROOT/postgres" || true
fi

POSTGRES_PASSWORD="$REQUESTED_POSTGRES_PASSWORD"
GITEA_SECRET_KEY=""
GITEA_INTERNAL_TOKEN=""
GITEA_JWT_SECRET=""
if [ -f "$APP_ROOT/.env" ]; then
  EXISTING_POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' "$APP_ROOT/.env" | cut -d= -f2- || true)"
  if [ -n "$EXISTING_POSTGRES_PASSWORD" ]; then
    POSTGRES_PASSWORD="$EXISTING_POSTGRES_PASSWORD"
  fi
  GITEA_SECRET_KEY="$(grep '^GITEA_SECRET_KEY=' "$APP_ROOT/.env" | cut -d= -f2- || true)"
  GITEA_INTERNAL_TOKEN="$(grep '^GITEA_INTERNAL_TOKEN=' "$APP_ROOT/.env" | cut -d= -f2- || true)"
  GITEA_JWT_SECRET="$(grep '^GITEA_JWT_SECRET=' "$APP_ROOT/.env" | cut -d= -f2- || true)"
fi
if [ -z "$GITEA_SECRET_KEY" ] && [ -f "$APP_ROOT/data/gitea/conf/app.ini" ]; then
  GITEA_SECRET_KEY="$(awk -F= '/^SECRET_KEY[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$APP_ROOT/data/gitea/conf/app.ini" || true)"
fi
if [ -z "$GITEA_INTERNAL_TOKEN" ] && [ -f "$APP_ROOT/data/gitea/conf/app.ini" ]; then
  GITEA_INTERNAL_TOKEN="$(awk -F= '/^INTERNAL_TOKEN[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$APP_ROOT/data/gitea/conf/app.ini" || true)"
fi
if [ -z "$GITEA_JWT_SECRET" ] && [ -f "$APP_ROOT/data/gitea/conf/app.ini" ]; then
  GITEA_JWT_SECRET="$(awk -F= '/^JWT_SECRET[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$APP_ROOT/data/gitea/conf/app.ini" || true)"
fi
if [ -z "$GITEA_SECRET_KEY" ]; then
  GITEA_SECRET_KEY="$(openssl rand -hex 32)"
fi
if [ -z "$GITEA_INTERNAL_TOKEN" ]; then
  GITEA_INTERNAL_TOKEN="$(openssl rand -hex 64)"
fi
if [ -z "$GITEA_JWT_SECRET" ]; then
  GITEA_JWT_SECRET="$(openssl rand -hex 32)"
fi

if ! command -v az >/dev/null 2>&1; then
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
fi

cat >"$APP_ROOT/.env" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DOMAIN=$DOMAIN
GITEA_SECRET_KEY=$GITEA_SECRET_KEY
GITEA_INTERNAL_TOKEN=$GITEA_INTERNAL_TOKEN
GITEA_JWT_SECRET=$GITEA_JWT_SECRET
EOF
chmod 600 "$APP_ROOT/.env"

cat >"$APP_ROOT/Caddyfile" <<EOF
$DOMAIN {
  encode gzip zstd
  reverse_proxy gitea:3000
}
EOF

cat >"$APP_ROOT/docker-compose.yml" <<'EOF'
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: gitea
      POSTGRES_USER: gitea
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ./postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gitea -d gitea"]
      interval: 10s
      timeout: 5s
      retries: 10

  gitea:
    image: gitea/gitea:1.23
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: postgres:5432
      GITEA__database__NAME: gitea
      GITEA__database__USER: gitea
      GITEA__database__PASSWD: ${POSTGRES_PASSWORD}
      GITEA__server__DOMAIN: ${DOMAIN}
      GITEA__server__ROOT_URL: https://${DOMAIN}/
      GITEA__server__SSH_DOMAIN: ${DOMAIN}
      GITEA__server__SSH_PORT: "2222"
      GITEA__server__START_SSH_SERVER: "true"
      GITEA__server__SSH_LISTEN_PORT: "2222"
      GITEA__service__DISABLE_REGISTRATION: "true"
      GITEA__service__ALLOW_ONLY_EXTERNAL_REGISTRATION: "false"
      GITEA__repository__DEFAULT_PRIVATE: private
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__security__SECRET_KEY: ${GITEA_SECRET_KEY}
      GITEA__security__INTERNAL_TOKEN: ${GITEA_INTERNAL_TOKEN}
      GITEA__oauth2__JWT_SECRET: ${GITEA_JWT_SECRET}
      GITEA__openid__ENABLE_OPENID_SIGNIN: "false"
      GITEA__openid__ENABLE_OPENID_SIGNUP: "false"
      GITEA__log__LEVEL: Info
    volumes:
      - ./data:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "2222:2222"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - gitea
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
EOF

cat >"$DATA_ROOT/bin/backup-gitea.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT=/srv/tantalum-git
APP_ROOT=$DATA_ROOT/gitea
BACKUP_ROOT=$DATA_ROOT/backups
STORAGE_ACCOUNT=__BACKUP_STORAGE_ACCOUNT_RAW__
CONTAINER=__BACKUP_CONTAINER_RAW__
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$BACKUP_ROOT/work-$STAMP"
ARCHIVE="$BACKUP_ROOT/gitea-$STAMP.tar.gz"

mkdir -p "$WORK_DIR"
cd "$APP_ROOT"
docker compose exec -T postgres pg_dump -U gitea gitea | gzip > "$WORK_DIR/postgres.sql.gz"
tar -C "$DATA_ROOT" -czf "$WORK_DIR/gitea-data.tar.gz" gitea/data gitea/docker-compose.yml gitea/Caddyfile
( cd / && tar -czf "$WORK_DIR/ssh-host-keys.tar.gz" etc/ssh/ssh_host_* ) || true
tar -C "$WORK_DIR" -czf "$ARCHIVE" .
rm -rf "$WORK_DIR"

if command -v az >/dev/null 2>&1; then
  az login --identity --allow-no-subscriptions >/dev/null
  az storage blob upload \
    --account-name "$STORAGE_ACCOUNT" \
    --container-name "$CONTAINER" \
    --name "$(basename "$ARCHIVE")" \
    --file "$ARCHIVE" \
    --auth-mode login \
    --overwrite true >/dev/null
fi

find "$BACKUP_ROOT" -maxdepth 1 -name 'gitea-*.tar.gz' -mtime +14 -delete
echo "$ARCHIVE"
EOF
chmod 750 "$DATA_ROOT/bin/backup-gitea.sh"

cat >"$DATA_ROOT/bin/restore-gitea.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo "Set CONFIRM_RESTORE=YES to restore." >&2
  exit 2
fi

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: restore-gitea.sh /path/to/gitea-backup.tar.gz" >&2
  exit 2
fi

DATA_ROOT=/srv/tantalum-git
APP_ROOT=$DATA_ROOT/gitea
RESTORE_ROOT=$DATA_ROOT/restore-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RESTORE_ROOT"
tar -C "$RESTORE_ROOT" -xzf "$ARCHIVE"

cd "$APP_ROOT"
docker compose down
tar -C "$DATA_ROOT" -xzf "$RESTORE_ROOT/gitea-data.tar.gz"
docker compose up -d postgres
for _ in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U gitea -d gitea >/dev/null 2>&1 && break
  sleep 2
done
gzip -dc "$RESTORE_ROOT/postgres.sql.gz" | docker compose exec -T postgres psql -U gitea -d gitea
docker compose up -d
echo "Restore complete."
EOF
chmod 750 "$DATA_ROOT/bin/restore-gitea.sh"

cd "$APP_ROOT"
sudo docker compose pull
sudo docker compose up -d postgres
for _ in $(seq 1 60); do
  if sudo docker compose exec -T postgres pg_isready -U gitea -d gitea >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
SQL_PASSWORD="${POSTGRES_PASSWORD//\'/\'\'}"
sudo docker compose exec -T postgres psql -U gitea -d gitea -v ON_ERROR_STOP=1 -c "ALTER USER gitea WITH PASSWORD '$SQL_PASSWORD';"
sudo docker compose up -d --force-recreate gitea caddy

GITEA_READY=false
for _ in $(seq 1 90); do
  if sudo docker compose exec -T gitea wget -qO- http://127.0.0.1:3000/api/v1/version >/dev/null 2>&1; then
    GITEA_READY=true
    break
  fi
  sleep 3
done
if [ "$GITEA_READY" != "true" ]; then
  sudo docker compose ps
  sudo docker compose logs --tail=80 gitea
  echo "Gitea did not become healthy on localhost:3000." >&2
  exit 1
fi

sudo docker compose exec -T --user git gitea gitea --config /data/gitea/conf/app.ini --work-path /data/gitea admin user create \
  --username "$ADMIN_USER" \
  --password "$ADMIN_PASSWORD" \
  --email "$ADMIN_EMAIL" \
  --admin \
  --must-change-password=false >/tmp/gitea-create-user.log 2>&1 || true
sudo docker compose exec -T --user git gitea gitea --config /data/gitea/conf/app.ini --work-path /data/gitea admin user change-password \
  --username "$ADMIN_USER" \
  --password "$ADMIN_PASSWORD" \
  --must-change-password=false >/tmp/gitea-change-password.log 2>&1 || true

ADMIN_TOKEN="$(sudo docker compose exec -T --user git gitea gitea --config /data/gitea/conf/app.ini --work-path /data/gitea admin user generate-access-token \
  --username "$ADMIN_USER" \
  --token-name "appwrite-project-sync-$(date -u +%Y%m%d%H%M%S)" \
  --scopes all \
  --raw | tr -d '\r\n')"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "Unable to create Gitea admin token." >&2
  exit 1
fi

sudo docker compose exec -T gitea wget -qO- \
  --header "Authorization: token $ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --post-data "{\"username\":\"$ORG\",\"full_name\":\"Tantalum Users\",\"visibility\":\"private\"}" \
  http://127.0.0.1:3000/api/v1/orgs >/tmp/gitea-create-org.log 2>&1 || true

sudo tee /etc/systemd/system/tantalum-gitea-backup.service >/dev/null <<'EOF'
[Unit]
Description=Tantalum Gitea backup
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/srv/tantalum-git/bin/backup-gitea.sh
EOF

sudo tee /etc/systemd/system/tantalum-gitea-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Tantalum Gitea backup timer

[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now tantalum-gitea-backup.timer

jq -n \
  --arg domain "$DOMAIN" \
  --arg org "$ORG" \
  --arg adminUser "$ADMIN_USER" \
  --arg adminPassword "$ADMIN_PASSWORD" \
  --arg adminToken "$ADMIN_TOKEN" \
  --arg backupStorageAccount "$BACKUP_STORAGE_ACCOUNT" \
  --arg backupContainer "$BACKUP_CONTAINER" \
  '{domain:$domain,org:$org,adminUser:$adminUser,adminPassword:$adminPassword,adminToken:$adminToken,backupStorageAccount:$backupStorageAccount,backupContainer:$backupContainer,configuredAt:(now|todate)}' \
  > "$DATA_ROOT/gitea/admin-secrets.json"
chmod 600 "$DATA_ROOT/gitea/admin-secrets.json"

echo "Gitea configured."
echo "DOMAIN=$DOMAIN"
echo "ORG=$ORG"
echo "ADMIN_TOKEN=$ADMIN_TOKEN"
'@

$remoteScript = $remoteTemplate
$remoteScript = $remoteScript.Replace("__ADMIN_LINUX_USER__", (Quote-Sh $AdminUsername))
$remoteScript = $remoteScript.Replace("__DOMAIN__", (Quote-Sh $GitDomain))
$remoteScript = $remoteScript.Replace("__GITEA_ORG__", (Quote-Sh $GiteaOrg))
$remoteScript = $remoteScript.Replace("__GITEA_ADMIN_USER__", (Quote-Sh $GiteaAdminUser))
$remoteScript = $remoteScript.Replace("__GITEA_ADMIN_EMAIL__", (Quote-Sh $GiteaAdminEmail))
$remoteScript = $remoteScript.Replace("__GITEA_ADMIN_PASSWORD__", (Quote-Sh $GiteaAdminPassword))
$remoteScript = $remoteScript.Replace("__POSTGRES_PASSWORD__", (Quote-Sh $PostgresPassword))
$remoteScript = $remoteScript.Replace("__BACKUP_STORAGE_ACCOUNT__", (Quote-Sh $BackupStorageAccount))
$remoteScript = $remoteScript.Replace("__BACKUP_CONTAINER__", (Quote-Sh $BackupContainer))
$remoteScript = $remoteScript.Replace("__BACKUP_STORAGE_ACCOUNT_RAW__", $BackupStorageAccount)
$remoteScript = $remoteScript.Replace("__BACKUP_CONTAINER_RAW__", $BackupContainer)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($remoteScriptLocal, $remoteScript, $utf8NoBom)

Write-Host "Waiting for SSH on $HostName..." -ForegroundColor Cyan
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$sshReady = $false
for ($i = 0; $i -lt 60; $i += 1) {
  & ssh -i $sshKeyPath -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$AdminUsername@$HostName" "echo ready" 2>$null
  if ($LASTEXITCODE -eq 0) {
    $sshReady = $true
    break
  }
  Start-Sleep -Seconds 5
}
if (-not $sshReady) {
  $ErrorActionPreference = $previousErrorActionPreference
  throw "SSH did not become ready on $HostName."
}

& scp -i $sshKeyPath -o StrictHostKeyChecking=accept-new $remoteScriptLocal "$AdminUsername@${HostName}:/tmp/configure-gitea.sh"
if ($LASTEXITCODE -ne 0) {
  $ErrorActionPreference = $previousErrorActionPreference
  throw "Failed to copy configure script to VM."
}

$output = & ssh -i $sshKeyPath -o StrictHostKeyChecking=accept-new "$AdminUsername@$HostName" "chmod +x /tmp/configure-gitea.sh && /tmp/configure-gitea.sh"
$remoteExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($remoteExitCode -ne 0) {
  throw "Remote Gitea configuration failed."
}

$tokenLine = $output | Where-Object { $_ -like "ADMIN_TOKEN=*" } | Select-Object -Last 1
$adminToken = if ($tokenLine) { $tokenLine.Substring("ADMIN_TOKEN=".Length).Trim() } else { "" }

$secrets = [ordered]@{
  hostName = $HostName
  domain = $GitDomain
  org = $GiteaOrg
  adminUser = $GiteaAdminUser
  adminPassword = $GiteaAdminPassword
  adminToken = $adminToken
  backupStorageAccount = $BackupStorageAccount
  backupContainer = $BackupContainer
  configuredAt = (Get-Date).ToUniversalTime().ToString("o")
}
$secrets | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $secretsPath -Encoding UTF8

Write-Host ""
Write-Host "Gitea configured." -ForegroundColor Green
Write-Host "Domain: https://$GitDomain"
Write-Host "SSH Git: ssh -p 2222 git@$GitDomain"
Write-Host "Service org: $GiteaOrg"
Write-Host "Secrets written locally: $secretsPath"
Write-Host "Set Appwrite project-sync GITEA_ADMIN_TOKEN from that secrets file."

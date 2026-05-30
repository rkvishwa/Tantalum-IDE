param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$SubscriptionId,
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_rsa",
  [string]$AppDomain,
  [string]$AppwriteVersion = "1.9.0",
  [switch]$StartInstaller,
  [switch]$UploadOnly,
  [switch]$RepairFunctionsRuntime
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required."
  }
}

Require-Command az
Require-Command ssh
Require-Command scp

$subscriptionArgs = @()
if ($SubscriptionId) {
  $subscriptionArgs = @("--subscription", $SubscriptionId)
}

if (-not $AppDomain) {
  throw "AppDomain is required. Example: -AppDomain api.example.com"
}

$repairSubscriptionText = ""
if ($SubscriptionId) {
  $repairSubscriptionText = " -SubscriptionId `"$SubscriptionId`""
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..\..")
$selfhostRoot = Join-Path $repoRoot "infra\selfhost"
$sshKey = Resolve-Path -LiteralPath $SshPrivateKeyPath -ErrorAction SilentlyContinue
if (-not $sshKey) {
  throw "SSH private key not found: $SshPrivateKeyPath"
}

$publicIp = (& az vm show @subscriptionArgs -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $publicIp) {
  throw "Unable to resolve VM public IP from Azure."
}

$sshTarget = "$AdminUsername@$publicIp"
$sshArgs = @("-i", $sshKey.Path, "-o", "StrictHostKeyChecking=accept-new")

Write-Host "Uploading self-host scripts to $sshTarget..."
& ssh @sshArgs $sshTarget "sudo mkdir -p /srv/tantalum/bin /srv/tantalum/appwrite /srv/tantalum/backups && sudo chown -R ${AdminUsername}:${AdminUsername} /srv/tantalum"
if ($LASTEXITCODE -ne 0) { throw "Remote directory setup failed." }

& scp @sshArgs (Join-Path $selfhostRoot "scripts\backup.sh") "${sshTarget}:/srv/tantalum/bin/backup.sh"
if ($LASTEXITCODE -ne 0) { throw "backup.sh upload failed." }
& scp @sshArgs (Join-Path $selfhostRoot "scripts\restore.sh") "${sshTarget}:/srv/tantalum/bin/restore.sh"
if ($LASTEXITCODE -ne 0) { throw "restore.sh upload failed." }
& scp @sshArgs (Join-Path $selfhostRoot "scripts\healthcheck.sh") "${sshTarget}:/srv/tantalum/bin/healthcheck.sh"
if ($LASTEXITCODE -ne 0) { throw "healthcheck.sh upload failed." }
& scp @sshArgs (Join-Path $selfhostRoot "scripts\tantalum-monitor.sh") "${sshTarget}:/srv/tantalum/bin/tantalum-monitor.sh"
if ($LASTEXITCODE -ne 0) { throw "tantalum-monitor.sh upload failed." }
& scp @sshArgs (Join-Path $selfhostRoot "scripts\repair-functions-runtime.sh") "${sshTarget}:/srv/tantalum/bin/repair-functions-runtime.sh"
if ($LASTEXITCODE -ne 0) { throw "repair-functions-runtime.sh upload failed." }

$remoteBootstrap = @"
set -euo pipefail
chmod +x /srv/tantalum/bin/*.sh
cat >/srv/tantalum/appwrite/tantalum.env <<'EOF'
APPWRITE_VERSION=$AppwriteVersion
APP_DOMAIN=$AppDomain
APPWRITE_ENDPOINT=https://$AppDomain/v1
APPWRITE_PROJECT_ID=tantalum
APPWRITE_DATABASE_ID=697b8f660033fffde4be
EOF
sudo tee /etc/systemd/system/tantalum-monitor.service >/dev/null <<'EOF'
[Unit]
Description=Tantalum Appwrite monitor and function warmer
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/srv/tantalum/bin/tantalum-monitor.sh
EOF
sudo tee /etc/systemd/system/tantalum-monitor.timer >/dev/null <<'EOF'
[Unit]
Description=Run Tantalum Appwrite monitor every 5 minutes

[Timer]
OnBootSec=2m
OnUnitActiveSec=5m
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now tantalum-monitor.timer
"@
& ssh @sshArgs $sshTarget $remoteBootstrap
if ($LASTEXITCODE -ne 0) { throw "Remote bootstrap failed." }

if ($UploadOnly) {
  Write-Host "Uploaded scripts only. Use -StartInstaller when DNS is pointed at this VM." -ForegroundColor Yellow
  Write-Host "To repair functions without SSH later, run:"
  Write-Host "  pwsh ./infra/azure/repair-appwrite-functions.ps1 -ResourceGroup `"$ResourceGroup`" -VmName `"$VmName`"$repairSubscriptionText"
  exit 0
}

if ($RepairFunctionsRuntime) {
  $remoteRepair = "sudo /srv/tantalum/bin/repair-functions-runtime.sh --restart --async"
  & ssh @sshArgs $sshTarget $remoteRepair
  if ($LASTEXITCODE -ne 0) { throw "Function runtime repair failed." }
}

if ($StartInstaller) {
  $remoteInstall = @"
set -euo pipefail
cd /srv/tantalum
docker rm -f appwrite-installer >/dev/null 2>&1 || true
docker run -d --name appwrite-installer \
  --publish 127.0.0.1:20080:20080 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /srv/tantalum/appwrite:/usr/src/code/appwrite:rw \
  --entrypoint="install" \
  appwrite/appwrite:$AppwriteVersion
"@
  & ssh @sshArgs $sshTarget $remoteInstall
  if ($LASTEXITCODE -ne 0) { throw "Appwrite installer start failed." }
}

Write-Host ""
Write-Host "Self-host bootstrap uploaded." -ForegroundColor Green
Write-Host "DNS: point $AppDomain A record to $publicIp"
Write-Host "Installer tunnel:"
Write-Host "  ssh -i `"$($sshKey.Path)`" -L 20080:127.0.0.1:20080 $sshTarget"
Write-Host "Then open http://127.0.0.1:20080 and complete the Appwrite installer."
Write-Host "After the installer finishes, run:"
Write-Host "  ssh -i `"$($sshKey.Path)`" $sshTarget '/srv/tantalum/bin/healthcheck.sh https://$AppDomain/v1'"
Write-Host "If agent-settings async/scheduled executions stop completing, run:"
Write-Host "  ssh -i `"$($sshKey.Path)`" $sshTarget 'sudo /srv/tantalum/bin/repair-functions-runtime.sh --restart --async'"
Write-Host "Or, if SSH is unavailable, run:"
Write-Host "  pwsh ./infra/azure/repair-appwrite-functions.ps1 -ResourceGroup `"$ResourceGroup`" -VmName `"$VmName`"$repairSubscriptionText"

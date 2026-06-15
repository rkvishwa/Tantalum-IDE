param(
  [Parameter(Mandatory = $true)][string]$BackupBlobName,
  [string]$ResourceGroup = "rg-tantalum-git-prod",
  [string]$VmName = "vm-tantalum-git-prod",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_ed25519",
  [string]$HostName = "",
  [string]$BackupStorageAccount = "tantalumbaktw0s316p45",
  [string]$BackupContainer = "git-backups",
  [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmRestore) {
  throw "Restore is destructive. Re-run with -ConfirmRestore after confirming this is the target VM."
}

$sshKey = Resolve-Path -LiteralPath $SshPrivateKeyPath -ErrorAction SilentlyContinue
if (-not $sshKey) {
  throw "SSH private key was not found: $SshPrivateKeyPath"
}

if (-not $HostName) {
  $HostName = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
  if ($LASTEXITCODE -ne 0 -or -not $HostName) {
    throw "Could not resolve VM public IP. Pass -HostName explicitly."
  }
}

$remoteArchive = "/srv/tantalum-git/backups/$BackupBlobName"
$remoteCommand = @"
set -euo pipefail
az login --identity --allow-no-subscriptions >/dev/null
az storage blob download --account-name '$BackupStorageAccount' --container-name '$BackupContainer' --name '$BackupBlobName' --file '$remoteArchive' --auth-mode login --overwrite
sudo env CONFIRM_RESTORE=YES /srv/tantalum-git/bin/restore-gitea.sh '$remoteArchive'
"@

Write-Host "Restoring $BackupBlobName to $VmName ($HostName)..." -ForegroundColor Yellow
& ssh -i $sshKey.Path -o StrictHostKeyChecking=accept-new "$AdminUsername@$HostName" $remoteCommand
if ($LASTEXITCODE -ne 0) {
  throw "Remote restore failed."
}

Write-Host "Restore complete." -ForegroundColor Green

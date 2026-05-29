param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_rsa",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

foreach ($cmd in @("az", "ssh", "scp")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd is required."
  }
}

$backup = Resolve-Path -LiteralPath $BackupPath -ErrorAction Stop
$sshKey = Resolve-Path -LiteralPath $SshPrivateKeyPath -ErrorAction Stop
$publicIp = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $publicIp) {
  throw "Unable to resolve VM public IP from Azure."
}

if (-not $Force) {
  throw "Restore is destructive. Re-run with -Force after confirming this VM can be overwritten."
}

$sshTarget = "$AdminUsername@$publicIp"
$sshArgs = @("-i", $sshKey.Path, "-o", "StrictHostKeyChecking=accept-new")
$remoteBackup = "/srv/tantalum/restore/$(Split-Path -Leaf $backup.Path)"

& ssh @sshArgs $sshTarget "mkdir -p /srv/tantalum/restore"
if ($LASTEXITCODE -ne 0) { throw "Remote restore directory setup failed." }

& scp @sshArgs $backup.Path "${sshTarget}:$remoteBackup"
if ($LASTEXITCODE -ne 0) { throw "Backup upload failed." }

& ssh @sshArgs $sshTarget "sudo /srv/tantalum/bin/restore.sh '$remoteBackup' --force"
if ($LASTEXITCODE -ne 0) { throw "Remote restore failed." }

Write-Host "Restore completed. Run healthcheck before using the instance." -ForegroundColor Green

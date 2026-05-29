param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_rsa",
  [string]$DownloadPath = ".\backups",
  [string]$StorageAccount = "",
  [string]$StorageContainer = ""
)

$ErrorActionPreference = "Stop"

foreach ($cmd in @("az", "ssh", "scp")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd is required."
  }
}

$sshKey = Resolve-Path -LiteralPath $SshPrivateKeyPath -ErrorAction Stop
$publicIp = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $publicIp) {
  throw "Unable to resolve VM public IP from Azure."
}

$sshTarget = "$AdminUsername@$publicIp"
$sshArgs = @("-i", $sshKey.Path, "-o", "StrictHostKeyChecking=accept-new")
$remoteCommand = "sudo /srv/tantalum/bin/backup.sh --print-path"

$remoteBackup = (& ssh @sshArgs $sshTarget $remoteCommand).Trim().Split("`n")[-1].Trim()
if ($LASTEXITCODE -ne 0 -or -not $remoteBackup) {
  throw "Remote backup failed."
}

New-Item -ItemType Directory -Force -Path $DownloadPath | Out-Null
Write-Host "Downloading $remoteBackup..."
& scp @sshArgs "${sshTarget}:$remoteBackup" $DownloadPath
if ($LASTEXITCODE -ne 0) {
  throw "Backup download failed."
}

$localBackup = Join-Path (Resolve-Path $DownloadPath).Path (Split-Path -Leaf $remoteBackup)

if ($StorageAccount -and $StorageContainer) {
  Write-Host "Uploading backup to Azure Storage container $StorageContainer..."
  & az storage blob upload --account-name $StorageAccount --container-name $StorageContainer --file $localBackup --name (Split-Path -Leaf $localBackup) --overwrite false --auth-mode login
  if ($LASTEXITCODE -ne 0) {
    throw "Azure Storage upload failed."
  }
}

Write-Host "Backup complete: $localBackup" -ForegroundColor Green

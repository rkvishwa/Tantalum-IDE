param(
  [string]$ResourceGroup = "rg-tantalum-git-prod",
  [string]$VmName = "vm-tantalum-git-prod",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_ed25519",
  [string]$HostName = "",
  [string]$BackupStorageAccount = "tantalumbaktw0s316p45",
  [string]$BackupContainer = "git-backups"
)

$ErrorActionPreference = "Stop"

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

Write-Host "Running Gitea backup on $HostName..." -ForegroundColor Cyan
& ssh -i $sshKey.Path -o StrictHostKeyChecking=accept-new "$AdminUsername@$HostName" "sudo /srv/tantalum-git/bin/backup-gitea.sh"
if ($LASTEXITCODE -ne 0) {
  throw "Remote backup failed."
}

Write-Host ""
Write-Host "Latest blobs in $BackupStorageAccount/${BackupContainer}:" -ForegroundColor Cyan
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& az storage blob list `
  --account-name $BackupStorageAccount `
  --container-name $BackupContainer `
  --auth-mode login `
  --query "sort_by([].{name:name,lastModified:properties.lastModified,size:properties.contentLength}, &lastModified)[-5:]" `
  -o table 2>$null
$loginListExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($loginListExitCode -ne 0) {
  Write-Warning "Backup ran, but listing Azure blobs with login auth failed. Trying account-key auth."
  $storageResourceGroup = (& az storage account list --query "[?name=='$BackupStorageAccount'].resourceGroup | [0]" -o tsv)
  if ($LASTEXITCODE -ne 0 -or -not $storageResourceGroup) {
    Write-Warning "Could not resolve storage resource group for $BackupStorageAccount."
    exit 0
  }

  $accountKey = (& az storage account keys list -g $storageResourceGroup -n $BackupStorageAccount --query "[0].value" -o tsv)
  if ($LASTEXITCODE -ne 0 -or -not $accountKey) {
    Write-Warning "Could not read account key for $BackupStorageAccount."
    exit 0
  }

  & az storage blob list `
    --account-name $BackupStorageAccount `
    --account-key $accountKey `
    --container-name $BackupContainer `
    --query "sort_by([].{name:name,lastModified:properties.lastModified,size:properties.contentLength}, &lastModified)[-5:]" `
    -o table
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Backup ran, but listing Azure blobs failed with both login and account-key auth."
  }
}

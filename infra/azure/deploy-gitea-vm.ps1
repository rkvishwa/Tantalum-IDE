param(
  [string]$ResourceGroup = "rg-tantalum-git-prod",
  [string]$Location = "centralindia",
  [string]$VmName = "vm-tantalum-git-prod",
  [string]$VmSize = "Standard_B2ls_v2",
  [string]$AdminUsername = "azureuser",
  [string]$SshPublicKeyPath = "$HOME\.ssh\id_ed25519.pub",
  [string]$SshSourceCidr = "",
  [int]$OsDiskSizeGb = 32,
  [int]$DataDiskSizeGb = 64,
  [string]$DiskSku = "StandardSSD_LRS",
  [string]$AddressPrefix = "10.43.0.0/16",
  [string]$SubnetPrefix = "10.43.1.0/24",
  [string]$BackupStorageAccount = "tantalumbaktw0s316p45",
  [string]$BackupContainer = "git-backups",
  [switch]$NoCurrentIpLookup
)

$ErrorActionPreference = "Stop"

function Resolve-PathStrict($PathValue, $Name) {
  $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction SilentlyContinue
  if (-not $resolved) {
    throw "$Name was not found: $PathValue"
  }
  return $resolved.Path
}

function Invoke-AzCli {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  Write-Host "az $($Arguments -join ' ')" -ForegroundColor DarkGray
  & az @Arguments
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }
  return $LASTEXITCODE
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-CurrentPublicCidr {
  if ($NoCurrentIpLookup) {
    return ""
  }

  try {
    $ip = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10).Trim()
    if ($ip -match "^\d{1,3}(\.\d{1,3}){3}$") {
      return "$ip/32"
    }
  } catch {
    Write-Warning "Could not detect current public IP. Pass -SshSourceCidr explicitly."
  }

  return ""
}

function Assert-SizeAvailable {
  $sizes = & az vm list-sizes --location $Location --query "[?name=='$VmSize'].name" -o tsv
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to validate VM sizes in $Location."
  }
  if (-not $sizes) {
    throw "VM size $VmSize is not available in $Location."
  }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Install it and run 'az login' first."
}

$account = & az account show --query "{id:id,name:name,user:user.name}" -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $account.id) {
  throw "Azure CLI is not logged in. Run 'az login' first."
}

$sshKey = Resolve-PathStrict $SshPublicKeyPath "SSH public key"
if (-not $SshSourceCidr) {
  $SshSourceCidr = Get-CurrentPublicCidr
}
if (-not $SshSourceCidr) {
  throw "SshSourceCidr is required. Example: -SshSourceCidr '203.0.113.10/32'"
}
if ($OsDiskSizeGb -lt 32) {
  throw "OsDiskSizeGb must be at least 32."
}
if ($DataDiskSizeGb -lt 64) {
  throw "DataDiskSizeGb must be at least 64 for the Gitea production MVP."
}

Assert-SizeAvailable

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudInitTemplate = Join-Path $scriptRoot "cloud-init-gitea.yml"
$cloudInitTemp = Join-Path $env:TEMP "$VmName-cloud-init.yml"
if (-not (Test-Path -LiteralPath $cloudInitTemplate)) {
  throw "Missing cloud-init template: $cloudInitTemplate"
}

$cloudInitContent = (Get-Content -Raw -LiteralPath $cloudInitTemplate).
  Replace("__ADMIN_USERNAME__", $AdminUsername).
  Replace("__DATA_MOUNT__", "/srv/tantalum-git")
Write-Utf8NoBom -Path $cloudInitTemp -Value $cloudInitContent

$vnetName = "$VmName-vnet"
$subnetName = "$VmName-subnet"
$nsgName = "$VmName-nsg"
$publicIpName = "$VmName-ip"

Invoke-AzCli @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--tags", "app=tantalum", "component=gitea", "env=prod")

Invoke-AzCli @(
  "network", "vnet", "create",
  "--resource-group", $ResourceGroup,
  "--name", $vnetName,
  "--address-prefix", $AddressPrefix,
  "--subnet-name", $subnetName,
  "--subnet-prefix", $SubnetPrefix
)

Invoke-AzCli @("network", "nsg", "create", "--resource-group", $ResourceGroup, "--name", $nsgName, "--location", $Location)

Invoke-AzCli @(
  "network", "nsg", "rule", "create",
  "--resource-group", $ResourceGroup,
  "--nsg-name", $nsgName,
  "--name", "Allow-SSH-Admin",
  "--priority", "100",
  "--access", "Allow",
  "--protocol", "Tcp",
  "--direction", "Inbound",
  "--source-address-prefixes", $SshSourceCidr,
  "--destination-port-ranges", "22"
)

Invoke-AzCli @(
  "network", "nsg", "rule", "create",
  "--resource-group", $ResourceGroup,
  "--nsg-name", $nsgName,
  "--name", "Allow-HTTP-HTTPS",
  "--priority", "110",
  "--access", "Allow",
  "--protocol", "Tcp",
  "--direction", "Inbound",
  "--source-address-prefixes", "Internet",
  "--destination-port-ranges", "80", "443"
)

Invoke-AzCli @(
  "network", "nsg", "rule", "create",
  "--resource-group", $ResourceGroup,
  "--nsg-name", $nsgName,
  "--name", "Allow-Git-SSH",
  "--priority", "120",
  "--access", "Allow",
  "--protocol", "Tcp",
  "--direction", "Inbound",
  "--source-address-prefixes", "Internet",
  "--destination-port-ranges", "2222"
)

Invoke-AzCli @(
  "network", "public-ip", "create",
  "--resource-group", $ResourceGroup,
  "--name", $publicIpName,
  "--location", $Location,
  "--sku", "Standard",
  "--allocation-method", "Static",
  "--tags", "app=tantalum", "component=gitea", "env=prod"
)

Invoke-AzCli @(
  "vm", "create",
  "--resource-group", $ResourceGroup,
  "--name", $VmName,
  "--location", $Location,
  "--image", "Ubuntu2204",
  "--size", $VmSize,
  "--admin-username", $AdminUsername,
  "--ssh-key-values", $sshKey,
  "--vnet-name", $vnetName,
  "--subnet", $subnetName,
  "--nsg", $nsgName,
  "--public-ip-address", $publicIpName,
  "--public-ip-sku", "Standard",
  "--os-disk-size-gb", "$OsDiskSizeGb",
  "--data-disk-sizes-gb", "$DataDiskSizeGb",
  "--storage-sku", $DiskSku,
  "--assign-identity",
  "--custom-data", $cloudInitTemp,
  "--tags", "app=tantalum", "component=gitea", "env=prod"
)

$publicIp = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $publicIp) {
  throw "VM was created, but public IP lookup failed."
}

$principalId = (& az vm show -g $ResourceGroup -n $VmName --query identity.principalId -o tsv)
$storageId = (& az storage account show -n $BackupStorageAccount --query id -o tsv 2>$null)
if ($LASTEXITCODE -eq 0 -and $principalId -and $storageId) {
  Invoke-AzCli @(
    "role", "assignment", "create",
    "--assignee-object-id", $principalId,
    "--assignee-principal-type", "ServicePrincipal",
    "--role", "Storage Blob Data Contributor",
    "--scope", $storageId
  ) -AllowFailure | Out-Null
} else {
  Write-Warning "Could not assign backup storage access to the VM managed identity. Check storage account $BackupStorageAccount."
}

$containerExit = Invoke-AzCli @(
  "storage", "container", "create",
  "--account-name", $BackupStorageAccount,
  "--name", $BackupContainer,
  "--auth-mode", "login"
) -AllowFailure
if ($containerExit -ne 0) {
  Write-Warning "Backup container creation with login auth failed. Trying account-key auth."
  $storageResourceGroup = (& az storage account list --query "[?name=='$BackupStorageAccount'].resourceGroup | [0]" -o tsv)
  $accountKey = ""
  if ($LASTEXITCODE -eq 0 -and $storageResourceGroup) {
    $accountKey = (& az storage account keys list -g $storageResourceGroup -n $BackupStorageAccount --query "[0].value" -o tsv)
  }
  if ($LASTEXITCODE -eq 0 -and $accountKey) {
    & az storage container create `
      --account-name $BackupStorageAccount `
      --account-key $accountKey `
      --name $BackupContainer | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Backup container creation failed with both login and account-key auth."
    }
  } else {
    Write-Warning "Could not read an account key for $BackupStorageAccount. Create '$BackupContainer' manually or rerun after assigning data-plane access."
  }
}

$summary = [ordered]@{
  resourceGroup = $ResourceGroup
  location = $Location
  vmName = $VmName
  vmSize = $VmSize
  adminUsername = $AdminUsername
  publicIp = $publicIp
  gitDomain = "git.metl.run"
  sshSourceCidr = $SshSourceCidr
  osDiskSizeGb = $OsDiskSizeGb
  dataDiskSizeGb = $DataDiskSizeGb
  dataMount = "/srv/tantalum-git"
  backupStorageAccount = $BackupStorageAccount
  backupContainer = $BackupContainer
  subscriptionId = $account.id
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
}
$summaryPath = Join-Path $scriptRoot ".gitea-vm-deployment.json"
Write-Utf8NoBom -Path $summaryPath -Value ($summary | ConvertTo-Json -Depth 5)

Write-Host ""
Write-Host "Azure Gitea VM created." -ForegroundColor Green
Write-Host "Public IP: $publicIp"
Write-Host "SSH: ssh $AdminUsername@$publicIp"
Write-Host "Manual DNS required: create A git.metl.run -> $publicIp"
Write-Host "Next: run infra/azure/configure-gitea.ps1 after SSH/cloud-init is ready."
Write-Host "Deployment summary: $summaryPath"

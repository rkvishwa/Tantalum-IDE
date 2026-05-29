param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$Location = "southeastasia",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$VmSize = "Standard_B2s_v2",
  [string]$AdminUsername = "azureuser",
  [string]$SshPublicKeyPath = "$HOME\.ssh\id_rsa.pub",
  [string]$SshSourceCidr = "",
  [int]$OsDiskSizeGb = 64,
  [int]$DataDiskSizeGb = 256,
  [string]$DiskSku = "StandardSSD_LRS",
  [string]$AddressPrefix = "10.42.0.0/16",
  [string]$SubnetPrefix = "10.42.1.0/24",
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
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  Write-Host "az $($Arguments -join ' ')" -ForegroundColor DarkGray
  & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }
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

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Install it and run 'az login' first."
}

$sshKey = Resolve-PathStrict $SshPublicKeyPath "SSH public key"
if (-not $SshSourceCidr) {
  $SshSourceCidr = Get-CurrentPublicCidr
}
if (-not $SshSourceCidr) {
  throw "SshSourceCidr is required. Example: -SshSourceCidr '203.0.113.10/32'"
}
if ($DataDiskSizeGb -lt 128) {
  throw "DataDiskSizeGb must be at least 128 for Appwrite. Use 256 for the default production MVP."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudInitTemplate = Join-Path $scriptRoot "cloud-init-base.yml"
$cloudInitTemp = Join-Path $env:TEMP "$VmName-cloud-init.yml"
if (-not (Test-Path -LiteralPath $cloudInitTemplate)) {
  throw "Missing cloud-init template: $cloudInitTemplate"
}

(Get-Content -Raw -LiteralPath $cloudInitTemplate).
  Replace("__ADMIN_USERNAME__", $AdminUsername).
  Replace("__DATA_MOUNT__", "/srv/tantalum") |
  Set-Content -LiteralPath $cloudInitTemp -Encoding UTF8

$vnetName = "$VmName-vnet"
$subnetName = "$VmName-subnet"
$nsgName = "$VmName-nsg"
$publicIpName = "$VmName-ip"

Invoke-AzCli @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--tags", "app=tantalum", "component=appwrite", "env=prod")

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
  "--custom-data", $cloudInitTemp,
  "--tags", "app=tantalum", "component=appwrite", "env=prod"
)

$publicIp = (& az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv)
if ($LASTEXITCODE -ne 0) {
  throw "VM was created, but public IP lookup failed."
}

Write-Host ""
Write-Host "Azure VM created." -ForegroundColor Green
Write-Host "Public IP: $publicIp"
Write-Host "SSH: ssh $AdminUsername@$publicIp"
Write-Host "Next: point your API domain A record to $publicIp, then run infra/azure/configure-appwrite.ps1."

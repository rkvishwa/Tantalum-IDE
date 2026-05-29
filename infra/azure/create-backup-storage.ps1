param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$Location = "southeastasia",
  [string]$StorageAccountName = "",
  [string]$ContainerName = "appwrite-backups",
  [string]$Sku = "Standard_LRS"
)

$ErrorActionPreference = "Stop"

function Invoke-AzCli {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  Write-Host "az $($Arguments -join ' ')" -ForegroundColor DarkGray
  & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Install it and run 'az login' first."
}

if (-not $StorageAccountName) {
  $suffix = -join ((48..57) + (97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
  $StorageAccountName = "tantalumbak$suffix"
}

if ($StorageAccountName -notmatch "^[a-z0-9]{3,24}$") {
  throw "StorageAccountName must be 3-24 lowercase letters or numbers."
}

Invoke-AzCli @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--tags", "app=tantalum", "component=backup", "env=prod")

Invoke-AzCli @(
  "storage", "account", "create",
  "--resource-group", $ResourceGroup,
  "--name", $StorageAccountName,
  "--location", $Location,
  "--sku", $Sku,
  "--kind", "StorageV2",
  "--https-only", "true",
  "--min-tls-version", "TLS1_2",
  "--allow-blob-public-access", "false",
  "--default-action", "Allow",
  "--tags", "app=tantalum", "component=backup", "env=prod"
)

Invoke-AzCli @(
  "storage", "container", "create",
  "--account-name", $StorageAccountName,
  "--name", $ContainerName,
  "--auth-mode", "login",
  "--public-access", "off"
)

Write-Host ""
Write-Host "Backup storage ready." -ForegroundColor Green
Write-Host "Storage account: $StorageAccountName"
Write-Host "Container: $ContainerName"
Write-Host "Use with backup-now.ps1 -StorageAccount $StorageAccountName -StorageContainer $ContainerName"

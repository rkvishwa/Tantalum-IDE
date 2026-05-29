param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$Size = "Standard_B4s_v2"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required."
}

Write-Host "Available resize options:"
& az vm list-vm-resize-options -g $ResourceGroup -n $VmName -o table
if ($LASTEXITCODE -ne 0) {
  throw "Unable to list resize options."
}

Write-Host "Resizing $VmName to $Size..."
& az vm resize -g $ResourceGroup -n $VmName --size $Size
if ($LASTEXITCODE -ne 0) {
  throw "VM resize failed."
}

Write-Host "Resize complete." -ForegroundColor Green

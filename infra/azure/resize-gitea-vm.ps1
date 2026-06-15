param(
  [ValidateSet("Cost", "Baseline", "Growth", "Surge")]
  [string]$Mode = "Cost",
  [string]$ResourceGroup = "rg-tantalum-git-prod",
  [string]$VmName = "vm-tantalum-git-prod",
  [string]$GitDomain = "git.metl.run",
  [string]$AdminUsername = "azureuser",
  [string]$SshPrivateKeyPath = "$HOME\.ssh\id_ed25519",
  [switch]$SkipSshChecks
)

$ErrorActionPreference = "Stop"

$sizes = @{
  Cost = "Standard_B2ls_v2"
  Baseline = "Standard_B2s_v2"
  Growth = "Standard_B4s_v2"
  Surge = "Standard_B8s_v2"
}
$targetSize = $sizes[$Mode]

function Invoke-AzCli {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  Write-Host "az $($Arguments -join ' ')" -ForegroundColor DarkGray
  & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }
}

$vm = & az vm show -g $ResourceGroup -n $VmName -d -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $vm.id) {
  throw "Could not find VM $VmName in $ResourceGroup."
}

$available = & az vm list-sizes --location $vm.location --query "[?name=='$targetSize'].name" -o tsv
if ($LASTEXITCODE -ne 0 -or -not $available) {
  throw "VM size $targetSize is not available in $($vm.location)."
}

$publicIp = [string]$vm.publicIps
if ($GitDomain) {
  try {
    $resolvedIp = [System.Net.Dns]::GetHostAddresses($GitDomain) | Select-Object -First 1
    if ($resolvedIp -and $resolvedIp.IPAddressToString -ne $publicIp) {
      Write-Warning "$GitDomain resolves to $($resolvedIp.IPAddressToString), expected $publicIp."
    } elseif ($resolvedIp) {
      Write-Host "DNS check passed: $GitDomain -> $publicIp" -ForegroundColor Green
    }
  } catch {
    Write-Warning "$GitDomain does not resolve yet."
  }
}

Write-Host "Resizing $VmName to $targetSize ($Mode)." -ForegroundColor Cyan
Invoke-AzCli @("vm", "deallocate", "-g", $ResourceGroup, "-n", $VmName)
Invoke-AzCli @("vm", "resize", "-g", $ResourceGroup, "-n", $VmName, "--size", $targetSize)
Invoke-AzCli @("vm", "start", "-g", $ResourceGroup, "-n", $VmName)

if (-not $SkipSshChecks) {
  $sshKey = Resolve-Path -LiteralPath $SshPrivateKeyPath -ErrorAction SilentlyContinue
  if ($sshKey) {
    Write-Host "Waiting for SSH and checking disk/backups..." -ForegroundColor Cyan
    for ($i = 0; $i -lt 60; $i += 1) {
      & ssh -i $sshKey.Path -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$AdminUsername@$publicIp" "echo ready" 2>$null
      if ($LASTEXITCODE -eq 0) {
        break
      }
      Start-Sleep -Seconds 5
    }
    if ($LASTEXITCODE -eq 0) {
      & ssh -i $sshKey.Path -o StrictHostKeyChecking=accept-new "$AdminUsername@$publicIp" "df -h /srv/tantalum-git; systemctl is-active tantalum-gitea-backup.timer || true; cd /srv/tantalum-git/gitea && sudo docker compose ps"
    } else {
      Write-Warning "SSH check did not succeed after resize."
    }
  } else {
    Write-Warning "SSH private key not found; skipped disk and backup checks."
  }
}

Write-Host "Resize complete: $VmName is $targetSize." -ForegroundColor Green

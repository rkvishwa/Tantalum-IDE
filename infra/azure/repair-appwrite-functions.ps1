param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [string]$SubscriptionId,
  [switch]$NoRestart,
  [switch]$SkipAsync,
  [switch]$SkipUpload
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required."
  }
}

function To-Base64Utf8($Value) {
  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Value))
}

function Invoke-AzText($Arguments, [switch]$AllowFailure) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & az @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $text = ($output | Out-String).Trim()
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    $argumentText = $Arguments -join " "
    if ($argumentText.Length -gt 1000) {
      $argumentText = "$($argumentText.Substring(0, 1000))... [truncated]"
    }
    throw "Azure CLI command failed: az $argumentText`n$text"
  }

  [PSCustomObject]@{
    Success = $exitCode -eq 0
    Text = $text
  }
}

function Invoke-AzJson($Arguments, [switch]$AllowFailure) {
  $result = Invoke-AzText $Arguments -AllowFailure:$AllowFailure
  if (-not $result.Success) {
    return $result
  }

  $value = $null
  if ($result.Text) {
    $value = $result.Text | ConvertFrom-Json
  }

  [PSCustomObject]@{
    Success = $true
    Text = $result.Text
    Value = $value
  }
}

Require-Command az

$subscriptionArgs = @()
if ($SubscriptionId) {
  $subscriptionArgs = @("--subscription", $SubscriptionId)
}

$accountResult = Invoke-AzJson (@("account", "show") + $subscriptionArgs + @("--output", "json"))
$account = $accountResult.Value
if (-not $account) {
  throw "Azure CLI is not signed in or the requested subscription is unavailable."
}

$vmResult = Invoke-AzJson (@("vm", "show") + $subscriptionArgs + @("--resource-group", $ResourceGroup, "--name", $VmName, "-d", "--output", "json")) -AllowFailure
if (-not $vmResult.Success -or -not $vmResult.Value) {
  $groupResult = Invoke-AzText (@("group", "list") + $subscriptionArgs + @("--query", "[].name", "--output", "tsv")) -AllowFailure
  $visibleGroups = ($groupResult.Text -split "\r?\n" | Where-Object { $_ }) -join ", "
  if (-not $visibleGroups) {
    $visibleGroups = "(none visible)"
  }
  throw "VM '$VmName' in resource group '$ResourceGroup' was not found in subscription '$($account.name)' ($($account.id)). Visible resource groups: $visibleGroups. Pass -SubscriptionId, -ResourceGroup, and -VmName for the production Appwrite VM."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..\..")
$repairScriptPath = Join-Path $repoRoot "infra\selfhost\scripts\repair-functions-runtime.sh"

if (-not (Test-Path -LiteralPath $repairScriptPath)) {
  throw "Repair script not found: $repairScriptPath"
}

$repairArgs = @()
if (-not $NoRestart) {
  $repairArgs += "--restart"
}
if ($SkipAsync) {
  $repairArgs += "--no-async"
} else {
  $repairArgs += "--async"
}
$repairArgString = $repairArgs -join " "

$uploadBlock = ""
if (-not $SkipUpload) {
  $repairScriptBase64 = To-Base64Utf8 (Get-Content -LiteralPath $repairScriptPath -Raw)
  $uploadBlock = @"
sudo mkdir -p /srv/tantalum/bin
cat <<'TANTALUM_REPAIR_SCRIPT_B64' | base64 -d | sudo tee /srv/tantalum/bin/repair-functions-runtime.sh >/dev/null
$repairScriptBase64
TANTALUM_REPAIR_SCRIPT_B64
sudo chmod +x /srv/tantalum/bin/repair-functions-runtime.sh
"@
}

$remoteScriptBody = @"
set -euo pipefail
$uploadBlock
if [[ ! -x /srv/tantalum/bin/repair-functions-runtime.sh ]]; then
  echo "/srv/tantalum/bin/repair-functions-runtime.sh is missing or not executable." >&2
  exit 1
fi
sudo /srv/tantalum/bin/repair-functions-runtime.sh $repairArgString
"@

$remoteScript = @"
bash <<'TANTALUM_REPAIR_RUN'
$remoteScriptBody
TANTALUM_REPAIR_RUN
"@

$remoteScriptFile = [System.IO.Path]::GetTempFileName()
Set-Content -LiteralPath $remoteScriptFile -Value $remoteScript -NoNewline -Encoding UTF8

Write-Host "Running Appwrite function-runtime repair on $VmName in $ResourceGroup using subscription $($account.name)..." -ForegroundColor Cyan
try {
  $runResult = Invoke-AzText (@(
    "vm", "run-command", "invoke"
  ) + $subscriptionArgs + @(
    "--resource-group", $ResourceGroup,
    "--name", $VmName,
    "--command-id", "RunShellScript",
    "--scripts", "@$remoteScriptFile",
    "--query", "value[].message",
    "--output", "tsv"
  ))
  Write-Host $runResult.Text
  if ($runResult.Text -notmatch "Appwrite function runtime repair and verification completed\.") {
    throw "Azure Run Command finished without the repair completion marker. Output:`n$($runResult.Text)"
  }
} finally {
  Remove-Item -LiteralPath $remoteScriptFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Function-runtime repair command completed." -ForegroundColor Green

param(
  [string]$ResourceGroup = "rg-tantalum-appwrite-prod",
  [string]$Location = "southeastasia",
  [string]$VmName = "vm-tantalum-appwrite-prod",
  [ValidateSet("Cost", "Baseline", "Growth", "Surge")]
  [string]$Mode = "Baseline",
  [string]$Size = "",
  [string]$Domain = "api.metl.run",
  [string]$ExpectedPublicIp = "4.193.248.149",
  [string]$AppwriteHealthUrl = "https://api.metl.run/v1/health/version",
  [string]$BackupStorageAccount = "tantalumbaktw0s316p45",
  [string]$BackupStorageContainer = "appwrite-backups",
  [string]$BackupBlobPrefix = "scheduled/",
  [int]$BackupMaxAgeHours = 30,
  [string]$LogAnalyticsWorkspace = "law-tantalum-appwrite-prod",
  [int]$AdvisorLookbackHours = 24,
  [switch]$PlanOnly,
  [switch]$Yes,
  [switch]$Recommend
)

$ErrorActionPreference = "Stop"

$VmModes = @{
  Cost = [pscustomobject]@{
    Size = "Standard_B2ls_v2"
    VCpu = 2
    MemoryGb = 4
    MonthlyUsd = 38.54
    Notes = "Lowest always-on Appwrite size; use only while traffic is light."
  }
  Baseline = [pscustomobject]@{
    Size = "Standard_B2s_v2"
    VCpu = 2
    MemoryGb = 8
    MonthlyUsd = 77.38
    Notes = "Current MVP size with more headroom for MongoDB and workers."
  }
  Growth = [pscustomobject]@{
    Size = "Standard_B4s_v2"
    VCpu = 4
    MemoryGb = 16
    MonthlyUsd = 154.03
    Notes = "First upgrade when real traffic pushes CPU or memory."
  }
  Surge = [pscustomobject]@{
    Size = "Standard_B8s_v2"
    VCpu = 8
    MemoryGb = 32
    MonthlyUsd = 308.06
    Notes = "Temporary or sustained high-load mode."
  }
}

function Invoke-AzCli {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }

  return ($output | Out-String).Trim()
}

function Invoke-AzCliJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = Invoke-AzCli $Arguments
  if (-not $output) {
    return $null
  }

  return $output | ConvertFrom-Json
}

function Format-UsdMonthly {
  param([double]$Value)
  return ("~`$" + ("{0:N2}" -f $Value) + "/mo compute")
}

function Get-TargetProfile {
  if ($Size) {
    return [pscustomobject]@{
      Mode = "Custom"
      Size = $Size
      VCpu = $null
      MemoryGb = $null
      MonthlyUsd = $null
      Notes = "Explicit size override. Cost estimate not embedded in this script."
    }
  }

  $profile = $VmModes[$Mode]
  return [pscustomobject]@{
    Mode = $Mode
    Size = $profile.Size
    VCpu = $profile.VCpu
    MemoryGb = $profile.MemoryGb
    MonthlyUsd = $profile.MonthlyUsd
    Notes = $profile.Notes
  }
}

function Get-ModeForSize {
  param([string]$VmSize)

  foreach ($entry in $VmModes.GetEnumerator()) {
    if ($entry.Value.Size -eq $VmSize) {
      return $entry.Key
    }
  }

  return "Custom"
}

function Get-VmInfo {
  $query = "{id:id,location:location,size:hardwareProfile.vmSize,power:powerState,publicIp:publicIps}"
  $info = Invoke-AzCliJson @("vm", "show", "-d", "-g", $ResourceGroup, "-n", $VmName, "--query", $query, "-o", "json")
  if (-not $info) {
    throw "Unable to read VM info for $VmName."
  }

  if (-not $info.publicIp) {
    $fallbackIp = Invoke-AzCli @(
      "network", "public-ip", "show",
      "-g", $ResourceGroup,
      "-n", "$VmName-ip",
      "--query", "ipAddress",
      "-o", "tsv"
    )
    $info.publicIp = $fallbackIp
  }

  return $info
}

function Get-DnsARecords {
  param([string]$HostName)

  try {
    return @(
      [System.Net.Dns]::GetHostAddresses($HostName) |
        Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
        ForEach-Object { $_.ToString() } |
        Sort-Object -Unique
    )
  } catch {
    return @()
  }
}

function Assert-TargetSizeAvailable {
  param(
    [string]$TargetSize,
    [string]$CurrentSize
  )

  if ($TargetSize -eq $CurrentSize) {
    return
  }

  $output = Invoke-AzCli @(
    "vm", "list-vm-resize-options",
    "-g", $ResourceGroup,
    "-n", $VmName,
    "--query", "[].name",
    "-o", "tsv"
  )
  $availableSizes = @($output -split "`r?`n" | Where-Object { $_ })
  if ($availableSizes -notcontains $TargetSize) {
    throw "$TargetSize is not currently available for $VmName in $Location."
  }
}

function Test-AppwriteHealth {
  try {
    $response = Invoke-RestMethod -Uri $AppwriteHealthUrl -TimeoutSec 20
    $version = ""
    if ($response.PSObject.Properties.Name -contains "version") {
      $version = $response.version
    }

    return [pscustomobject]@{
      Ok = $true
      Version = $version
      Error = ""
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Version = ""
      Error = $_.Exception.Message
    }
  }
}

function Get-LatestBackupStatus {
  if (-not $BackupStorageAccount -or -not $BackupStorageContainer) {
    return [pscustomobject]@{
      Ok = $false
      Name = ""
      AgeHours = $null
      Error = "Backup storage account/container was not provided."
    }
  }

  $query = "sort_by([].{name:name,lastModified:properties.lastModified,size:properties.contentLength}, &lastModified)[-1]"
  try {
    $latest = Invoke-AzCliJson @(
      "storage", "blob", "list",
      "--account-name", $BackupStorageAccount,
      "--container-name", $BackupStorageContainer,
      "--prefix", $BackupBlobPrefix,
      "--query", $query,
      "-o", "json"
    )
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Name = ""
      AgeHours = $null
      Error = $_.Exception.Message
    }
  }

  if (-not $latest -or -not $latest.lastModified) {
    return [pscustomobject]@{
      Ok = $false
      Name = ""
      AgeHours = $null
      Error = "No backup blob found with prefix '$BackupBlobPrefix'."
    }
  }

  $lastModified = [DateTimeOffset]::Parse($latest.lastModified).ToUniversalTime()
  $ageHours = ([DateTimeOffset]::UtcNow - $lastModified).TotalHours

  return [pscustomobject]@{
    Ok = ($ageHours -le $BackupMaxAgeHours)
    Name = $latest.name
    AgeHours = $ageHours
    Error = ""
  }
}

function Wait-AppwriteHealthy {
  param([int]$TimeoutSeconds = 600)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $health = Test-AppwriteHealth
    if ($health.Ok) {
      return $health
    }

    Start-Sleep -Seconds 10
  }

  return Test-AppwriteHealth
}

function Invoke-VmRunCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [int]$TimeoutSeconds = 600
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = ""

  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-AzCliJson @(
        "vm", "run-command", "invoke",
        "-g", $ResourceGroup,
        "-n", $VmName,
        "--command-id", "RunShellScript",
        "--scripts", $Script,
        "-o", "json"
      )
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds 15
    }
  }

  throw "Azure VM Run Command did not become available within $TimeoutSeconds seconds. Last error: $lastError"
}

function Start-AppwriteStack {
  $script = @'
set -e
cd /srv/tantalum/appwrite
docker compose up -d
docker compose ps
'@

  return Invoke-VmRunCommand -Script $script -TimeoutSeconds 600
}

function Get-AzureMetricSummary {
  param(
    [string]$ResourceId,
    [string]$Aggregation
  )

  $startTime = (Get-Date).ToUniversalTime().AddHours(-1 * $AdvisorLookbackHours).ToString("o")
  $endTime = (Get-Date).ToUniversalTime().ToString("o")
  $values = Invoke-AzCliJson @(
    "monitor", "metrics", "list",
    "--resource", $ResourceId,
    "--metric", "Percentage CPU",
    "--start-time", $startTime,
    "--end-time", $endTime,
    "--interval", "PT1H",
    "--aggregation", $Aggregation,
    "--query", "value[0].timeseries[0].data[].$($Aggregation.ToLowerInvariant())",
    "-o", "json"
  )

  $numericValues = @($values | Where-Object { $null -ne $_ })
  if ($numericValues.Count -eq 0) {
    return $null
  }

  if ($Aggregation -eq "Maximum") {
    return ($numericValues | Measure-Object -Maximum).Maximum
  }

  return ($numericValues | Measure-Object -Average).Average
}

function Get-MonitorRows {
  try {
    $customerId = Invoke-AzCli @(
      "monitor", "log-analytics", "workspace", "show",
      "-g", $ResourceGroup,
      "-n", $LogAnalyticsWorkspace,
      "--query", "customerId",
      "-o", "tsv"
    )
  } catch {
    Write-Warning "Unable to resolve Log Analytics workspace '$LogAnalyticsWorkspace': $($_.Exception.Message)"
    return @{}
  }

  $query = @"
Syslog
| where TimeGenerated > ago(${AdvisorLookbackHours}h)
| where ProcessName == 'tantalum-monitor'
| where SyslogMessage startswith 'metric='
| extend metric = extract('metric=([^ ]+)', 1, SyslogMessage)
| extend value = toint(extract('value=([0-9]+)', 1, SyslogMessage))
| extend threshold = toint(extract('threshold=([0-9]+)', 1, SyslogMessage))
| extend status = extract('status=([^ ]+)', 1, SyslogMessage)
| where metric in ('memory', 'container_health', 'backup_age', 'disk_root', 'disk_data')
| summarize arg_max(TimeGenerated, value, threshold, status, SyslogMessage) by metric
| project metric, value, threshold, status, TimeGenerated, SyslogMessage
"@

  try {
    $rows = Invoke-AzCliJson @(
      "monitor", "log-analytics", "query",
      "-w", $customerId,
      "--analytics-query", $query,
      "-t", "PT$($AdvisorLookbackHours)H",
      "-o", "json"
    )
  } catch {
    Write-Warning "Unable to query Log Analytics monitor rows: $($_.Exception.Message)"
    return @{}
  }

  $result = @{}
  foreach ($row in @($rows)) {
    if (-not $row.metric) {
      continue
    }

    $result[$row.metric] = [pscustomobject]@{
      Metric = $row.metric
      Value = $row.value
      Threshold = $row.threshold
      Status = $row.status
      TimeGenerated = $row.TimeGenerated
      Message = $row.SyslogMessage
    }
  }

  return $result
}

function Show-Recommendation {
  $vmInfo = Get-VmInfo
  $currentMode = Get-ModeForSize $vmInfo.size
  $cpuAverage = Get-AzureMetricSummary -ResourceId $vmInfo.id -Aggregation "Average"
  $cpuMaximum = Get-AzureMetricSummary -ResourceId $vmInfo.id -Aggregation "Maximum"
  $monitor = Get-MonitorRows

  $memory = $null
  if ($monitor.ContainsKey("memory")) {
    $memory = [int]$monitor["memory"].Value
  }

  $hasMonitorFailure = $false
  foreach ($entry in $monitor.Values) {
    if ($entry.Status -eq "fail") {
      $hasMonitorFailure = $true
    }
  }

  $recommendedMode = "Cost"
  $reasons = @()

  if ($null -ne $cpuAverage -and $cpuAverage -ge 75) {
    $recommendedMode = "Surge"
    $reasons += "average CPU is $([math]::Round($cpuAverage, 1))%"
  } elseif ($null -ne $memory -and $memory -ge 85) {
    $recommendedMode = "Surge"
    $reasons += "memory is ${memory}%"
  } elseif (($null -ne $cpuAverage -and $cpuAverage -ge 60) -or ($null -ne $memory -and $memory -ge 75)) {
    $recommendedMode = "Growth"
    if ($null -ne $cpuAverage -and $cpuAverage -ge 60) { $reasons += "average CPU is $([math]::Round($cpuAverage, 1))%" }
    if ($null -ne $memory -and $memory -ge 75) { $reasons += "memory is ${memory}%" }
  } elseif (($null -ne $cpuAverage -and $cpuAverage -ge 40) -or ($null -ne $memory -and $memory -ge 70) -or $hasMonitorFailure) {
    $recommendedMode = "Baseline"
    if ($null -ne $cpuAverage -and $cpuAverage -ge 40) { $reasons += "average CPU is $([math]::Round($cpuAverage, 1))%" }
    if ($null -ne $memory -and $memory -ge 70) { $reasons += "memory is ${memory}%" }
    if ($hasMonitorFailure) { $reasons += "one or more monitor checks are failing" }
  } else {
    $reasons += "recent CPU and memory are low"
  }

  $profile = $VmModes[$recommendedMode]
  Write-Host "Current VM: $($vmInfo.size) ($currentMode), public IP $($vmInfo.publicIp)"
  if ($null -ne $cpuAverage) {
    Write-Host "CPU: average $([math]::Round($cpuAverage, 1))%, peak hourly maximum $([math]::Round($cpuMaximum, 1))% over the last $AdvisorLookbackHours hours"
  } else {
    Write-Host "CPU: no Azure Monitor samples found over the last $AdvisorLookbackHours hours"
  }
  if ($null -ne $memory) {
    Write-Host "Memory: latest monitor value ${memory}%"
  } else {
    Write-Host "Memory: no recent tantalum-monitor memory row found"
  }
  foreach ($name in @("container_health", "backup_age", "disk_root", "disk_data")) {
    if ($monitor.ContainsKey($name)) {
      Write-Host "${name}: $($monitor[$name].Message)"
    }
  }

  Write-Host ""
  Write-Host "Recommended mode: $recommendedMode -> $($profile.Size) ($($profile.VCpu) vCPU / $($profile.MemoryGb) GB, $(Format-UsdMonthly $profile.MonthlyUsd))" -ForegroundColor Green
  Write-Host "Reason: $($reasons -join '; ')"
  Write-Host "This command is advisory only. To dry-run the resize checks, use:"
  Write-Host "pwsh ./infra/azure/resize-vm.ps1 -Mode $recommendedMode -PlanOnly"
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Install it and run 'az login' first."
}

if ($Recommend) {
  Show-Recommendation
  return
}

$target = Get-TargetProfile
$vmInfo = Get-VmInfo
$currentMode = Get-ModeForSize $vmInfo.size
$dnsRecords = Get-DnsARecords $Domain
$health = Test-AppwriteHealth
$backup = Get-LatestBackupStatus

Assert-TargetSizeAvailable -TargetSize $target.Size -CurrentSize $vmInfo.size

Write-Host "Current VM: $($vmInfo.size) ($currentMode), power state: $($vmInfo.power)"
Write-Host "Target VM: $($target.Size) ($($target.Mode))"
if ($target.MonthlyUsd) {
  Write-Host "Estimated compute cost: $(Format-UsdMonthly $target.MonthlyUsd)"
} else {
  Write-Host "Estimated compute cost: unavailable for custom size"
}
Write-Host "Expected outage: a brief VM restart during Azure resize, usually a few minutes."
Write-Host "Current public IP: $($vmInfo.publicIp)"
Write-Host "DNS ${Domain}: $($dnsRecords -join ', ')"
if ($health.Ok) {
  Write-Host "Appwrite health: OK $($health.Version)"
} else {
  Write-Host "Appwrite health: FAILED $($health.Error)" -ForegroundColor Red
}
if ($backup.Ok) {
  Write-Host "Latest Blob backup: OK $($backup.Name), age $([math]::Round($backup.AgeHours, 2))h"
} else {
  Write-Host "Latest Blob backup: FAILED $($backup.Error)" -ForegroundColor Red
}

if ($PlanOnly) {
  Write-Host ""
  Write-Host "PlanOnly complete. No resize was performed." -ForegroundColor Green
  return
}

if ($vmInfo.size -eq $target.Size) {
  if ($health.Ok) {
    Write-Host "VM is already $($target.Size). No resize needed." -ForegroundColor Green
    return
  }

  if (-not $Yes) {
    $answer = Read-Host "VM is already $($target.Size), but Appwrite health is failing. Type RECOVER to run docker compose up -d"
    if ($answer -ne "RECOVER") {
      throw "Recovery cancelled."
    }
  }

  Write-Host "VM is already $($target.Size). Starting Appwrite compose stack for recovery..."
  Start-AppwriteStack | Out-Null

  Write-Host "Waiting for Appwrite health after recovery..."
  $recoveredHealth = Wait-AppwriteHealthy -TimeoutSeconds 600
  if (-not $recoveredHealth.Ok) {
    throw "Appwrite health did not recover: $($recoveredHealth.Error)"
  }

  Write-Host "Recovery complete. Appwrite health: OK $($recoveredHealth.Version)" -ForegroundColor Green
  return
}

if (-not $health.Ok) {
  throw "Refusing to resize because Appwrite health is not currently OK."
}
if (-not $backup.Ok) {
  throw "Refusing to resize because the latest Blob backup is missing or older than $BackupMaxAgeHours hours."
}
if ($dnsRecords -notcontains $vmInfo.publicIp) {
  throw "Refusing to resize because $Domain does not currently resolve to VM public IP $($vmInfo.publicIp)."
}

if (-not $Yes) {
  $answer = Read-Host "Type RESIZE to resize $VmName from $($vmInfo.size) to $($target.Size)"
  if ($answer -ne "RESIZE") {
    throw "Resize cancelled."
  }
}

Write-Host "Resizing $VmName to $($target.Size)..."
Invoke-AzCli @("vm", "resize", "-g", $ResourceGroup, "-n", $VmName, "--size", $target.Size) | Out-Null

Write-Host "Starting Appwrite compose stack after resize..."
Start-AppwriteStack | Out-Null

Write-Host "Waiting for Appwrite health after resize..."
$postHealth = Wait-AppwriteHealthy -TimeoutSeconds 600
$postVmInfo = Get-VmInfo
$postDnsRecords = Get-DnsARecords $Domain

Write-Host "Post-resize public IP: $($postVmInfo.publicIp)"
Write-Host "Post-resize DNS ${Domain}: $($postDnsRecords -join ', ')"

if ($postVmInfo.publicIp -ne $ExpectedPublicIp) {
  Write-Warning "VM public IP is $($postVmInfo.publicIp), not expected $ExpectedPublicIp. Set the $Domain A record to $($postVmInfo.publicIp)."
}
if ($postDnsRecords -notcontains $postVmInfo.publicIp) {
  Write-Warning "$Domain does not resolve to $($postVmInfo.publicIp). Set the $Domain A record to $($postVmInfo.publicIp)."
}
if (-not $postHealth.Ok) {
  throw "Resize finished, but Appwrite health did not recover: $($postHealth.Error)"
}

Write-Host "Resize complete. Appwrite health: OK $($postHealth.Version)" -ForegroundColor Green

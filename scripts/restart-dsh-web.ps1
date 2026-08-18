<#
.SYNOPSIS
  Restart the running `dsh web` instance on this machine and verify the
  dsh-updater host surface comes up. Written for the case where the harness
  itself must be restarted: run this DETACHED (Start-Process) so it survives
  killing the process tree that hosts the web server.

.DESCRIPTION
  1. (optional) wait DelaySeconds.
  2. Find the process listening on Port, walk up to the top pnpm wrapper,
     and taskkill /T /F that whole tree.
  3. Relaunch `pnpm dsh web` from Checkout in a hidden, detached shell.
  4. Poll the port; verify /__dsh-update/status answers JSON and the boot
     HTML lists the dsh-updater client plugin.
  Every step is logged to LogPath.
#>
param(
  [int]$DelaySeconds = 30,
  [int]$Port = 3080,
  [string]$Checkout = 'D:\Program Files (x86)\deepseek-harness',
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-updater-restart.log')
)

function Log([string]$msg) {
  ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) | Out-File -FilePath $LogPath -Append -Encoding utf8
}

Log "=== dsh web restart starting (delay ${DelaySeconds}s) ==="
Start-Sleep -Seconds $DelaySeconds
Log "delay over; locating listener on port $Port"

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Log "WARN: nothing listening on port $Port — skipping kill, relaunching anyway"
} else {
  $server = $conn.OwningProcess
  Log "port owner PID $server"
  # Walk up to the top-most pnpm/node wrapper so the whole tree dies together.
  $root = $server
  $cur = $server
  for ($i = 0; $i -lt 8; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    if ($p.Name -eq 'node.exe' -and $p.CommandLine -match 'pnpm') { $root = $cur }
    $cur = $p.ParentProcessId
  }
  Log "killing tree root PID $root (taskkill /T /F)"
  taskkill /PID $root /T /F 2>&1 | ForEach-Object { Log "  kill: $_" }
  Start-Sleep -Seconds 4
}

Log "relaunching: pnpm dsh web (cwd $Checkout)"
$relauncher = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
  "Set-Location -LiteralPath '$Checkout'; pnpm dsh web *>> '$LogPath'"
) -PassThru -WindowStyle Hidden
Log "relauncher PID $($relauncher.Id)"

# Poll for the host surface + boot roster.
$statusOk = $false
$bootOk = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try {
    $status = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__dsh-update/status" -UseBasicParsing -TimeoutSec 3
    if ($status.StatusCode -eq 200) {
      try {
        $json = $status.Content | ConvertFrom-Json
        if ($null -ne $json -and $json.PSObject.Properties.Name -contains 'resolved') {
          $statusOk = $true
          Log "VERIFY OK: /__dsh-update/status JSON (resolved=$($json.resolved), source=$($json.sourceVersion), latest=$($json.latestVersion), outdated=$($json.outdated))"
        }
      } catch {
        Log "  status answered non-JSON (plugin host not loaded yet)"
      }
    }
    $boot = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
    if ($boot.Content -match 'dsh-updater') {
      $bootOk = $true
      Log 'VERIFY OK: boot HTML lists the dsh-updater client plugin'
    }
  } catch {
    Log "  poll $i: server not answering ($($_.Exception.Message))"
  }
  if ($statusOk -and $bootOk) { break }
}
Log "done: statusOk=$statusOk bootOk=$bootOk"
if (-not ($statusOk -and $bootOk)) {
  Log 'WARNING: verification incomplete — check `pnpm dsh web` output above'
}

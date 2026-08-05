#Requires -Version 5.1
# OWM Drive - diagnostic report (read-only: changes nothing on this
# computer, only reads and prints information).
#
# Usage: normally fetched and run via the landing page's "Run diagnostics"
# link (https://capnkeith.github.io/one-world-montessori/), which copies
# the command to your clipboard - downloads this file to disk first, then
# runs it with -File, same reasoning as first-run.ps1's own comment on why
# (piping straight into iex is a shape Windows Defender's heuristics can
# silently kill mid-run - not something a diagnostic tool should risk
# either).
#
# IMPORTANT: docs/d is a copy of this exact file, hosted at a short path on
# the GitHub Pages site, the same way docs/i mirrors first-run.ps1. Whenever
# this file changes, copy it there too: Copy-Item bootstrap/diagnose.ps1 docs/d -Force

Write-Host '=================================================='
Write-Host '  OWM Drive - diagnostic report'
Write-Host '=================================================='
Write-Host ''
Write-Host 'This only reads information - it does not change anything on'
Write-Host 'this computer. Copy everything from the line below down to the'
Write-Host 'bottom, and paste it into a reply email to Claude.'
Write-Host '---------------------------------------------------'

Write-Host ''
Write-Host '[Windows]'
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Write-Host "Version: $($os.Caption) (build $($os.BuildNumber))"
} catch {
  Write-Host "Could not read Windows version: $($_.Exception.Message)"
}

Write-Host ''
Write-Host '[Windows Security]'
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  Write-Host "Smart App Control: $($mp.SmartAppControlState)"
  Write-Host "Real-time protection enabled: $($mp.RealTimeProtectionEnabled)"
  Write-Host "Antivirus enabled: $($mp.AntivirusEnabled)"
} catch {
  Write-Host "Could not read Windows Security status: $($_.Exception.Message)"
}

Write-Host ''
Write-Host '[Recent Windows Security detections/blocks (last 10)]'
try {
  $threats = Get-MpThreatDetection -ErrorAction Stop | Sort-Object InitialDetectionTime -Descending | Select-Object -First 10
  if ($threats) {
    foreach ($t in $threats) {
      Write-Host "$($t.InitialDetectionTime) - $($t.ThreatName) - resolved: $($t.ActionSuccess)"
    }
  } else {
    Write-Host 'None found.'
  }
} catch {
  Write-Host "Could not read detection history: $($_.Exception.Message)"
}

Write-Host ''
Write-Host '[OWM Drive install state]'
$stateRoot = Join-Path $env:USERPROFILE '.owm-mcp'
if (Test-Path $stateRoot) {
  Write-Host "Found: $stateRoot"
  $current = Join-Path $stateRoot 'current'
  if (Test-Path $current) {
    try {
      $commit = & git -C $current log -1 --oneline 2>&1
      Write-Host "Current install commit: $commit"
    } catch {
      Write-Host "Could not read current install's version."
    }
  } else {
    Write-Host 'No completed install found yet ("current" folder is missing).'
  }

  $supervisorLog = Join-Path $stateRoot 'supervisor.log'
  if (Test-Path $supervisorLog) {
    Write-Host ''
    Write-Host '--- last 30 lines of supervisor.log ---'
    Get-Content $supervisorLog -Tail 30
  } else {
    Write-Host 'No supervisor.log found yet.'
  }

  $installLogDir = Join-Path $stateRoot 'install-logs'
  if (Test-Path $installLogDir) {
    $latestInstallLog = Get-ChildItem $installLogDir -Filter 'install.log' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestInstallLog) {
      Write-Host ''
      Write-Host "--- last 40 lines of $($latestInstallLog.Name) (from $($latestInstallLog.LastWriteTime)) ---"
      Get-Content $latestInstallLog.FullName -Tail 40
    }
  }
} else {
  Write-Host 'Nothing installed yet at all - no .owm-mcp folder exists.'
}

Write-Host ''
Write-Host '[Node / Git]'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "node: $(& node --version)" } else { Write-Host 'node: not found' }
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Write-Host "git: $(& git --version)" } else { Write-Host 'git: not found' }

Write-Host ''
Write-Host '---------------------------------------------------'
Write-Host 'That is everything - copy from the line above down to here.'
Write-Host ''
Write-Host 'This window will stay open so you have time to scroll up and copy it all.'
try { [Console]::ReadKey($true) | Out-Null } catch { while ($true) { Start-Sleep -Seconds 3600 } }

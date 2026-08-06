#Requires -Version 5.1
# OWM Drive - diagnostic report (read-only: never installs or changes
# anything except possibly sending one email with this report).
#
# One click, auto-delivered (Seth, 2026-08-05): collects the same
# information as before, then tries emailing it directly through this
# machine's own local OWM Drive server (the same `mail` tool every other
# real email in this project already goes through) - no copy/paste
# needed. Falls back to printing everything to the console, with the same
# "copy this into a reply" instructions as before, if that delivery
# attempt fails for any reason - this is never a dead end even on a
# machine where the local server truly isn't reachable, which given this
# script's whole purpose is a real possibility, not an edge case.
#
# Usage: normally fetched and run via the diagnostics page
# (https://capnkeith.github.io/one-world-montessori/diagnose.html), which
# copies the command to your clipboard - downloads this file to disk
# first, then runs it with -File, same reasoning as first-run.ps1's own
# comment on why (piping straight into iex is a shape Windows Defender's
# heuristics can silently kill mid-run).
#
# IMPORTANT: docs/d is a copy of this exact file, hosted at a short path on
# the GitHub Pages site, the same way docs/i mirrors first-run.ps1. Whenever
# this file changes, copy it there too: Copy-Item bootstrap/diagnose.ps1 docs/d -Force

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line($text = '') {
  $lines.Add($text)
  Write-Host $text
}

Add-Line '=================================================='
Add-Line '  OWM Drive - diagnostic report'
Add-Line '=================================================='

Add-Line ''
Add-Line '[Windows]'
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Add-Line "Version: $($os.Caption) (build $($os.BuildNumber))"
} catch {
  Add-Line "Could not read Windows version: $($_.Exception.Message)"
}

Add-Line ''
Add-Line '[Windows Security]'
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  Add-Line "Smart App Control: $($mp.SmartAppControlState)"
  Add-Line "Real-time protection enabled: $($mp.RealTimeProtectionEnabled)"
  Add-Line "Antivirus enabled: $($mp.AntivirusEnabled)"
} catch {
  Add-Line "Could not read Windows Security status: $($_.Exception.Message)"
}

Add-Line ''
Add-Line '[Recent Windows Security detections/blocks (last 10)]'
try {
  $threats = Get-MpThreatDetection -ErrorAction Stop | Sort-Object InitialDetectionTime -Descending | Select-Object -First 10
  if ($threats) {
    foreach ($t in $threats) {
      # ThreatName does not exist on Get-MpThreatDetection's own output
      # (real bug, confirmed live: silently comes back blank) - the real
      # name needs a Get-MpThreat lookup by ThreatID.
      $threatName = try { (Get-MpThreat -ThreatID $t.ThreatID -ErrorAction Stop).ThreatName } catch { "ThreatID $($t.ThreatID)" }
      Add-Line "$($t.InitialDetectionTime) - $threatName - resolved: $($t.ActionSuccess)"
    }
  } else {
    Add-Line 'None found.'
  }
} catch {
  Add-Line "Could not read detection history: $($_.Exception.Message)"
}

Add-Line ''
Add-Line '[OWM Drive install state]'
$stateRoot = Join-Path $env:USERPROFILE '.owm-mcp'
if (Test-Path $stateRoot) {
  Add-Line "Found: $stateRoot"
  $current = Join-Path $stateRoot 'current'
  if (Test-Path $current) {
    try {
      $commit = & git -C $current log -1 --oneline 2>&1
      Add-Line "Current install commit: $commit"
    } catch {
      Add-Line "Could not read current install's version."
    }
  } else {
    Add-Line 'No completed install found yet ("current" folder is missing).'
  }

  $supervisorLog = Join-Path $stateRoot 'supervisor.log'
  if (Test-Path $supervisorLog) {
    Add-Line ''
    Add-Line '--- last 30 lines of supervisor.log ---'
    Get-Content $supervisorLog -Tail 30 | ForEach-Object { Add-Line $_ }
  } else {
    Add-Line 'No supervisor.log found yet.'
  }

  # The one thing that actually explains *why* the server exited, not
  # just that it did - see supervisor.js's own comment on why this exists
  # (the child's real stdout/stderr used to go nowhere in a headless
  # launch). Won't exist yet on an install from before 2026-08-05.
  $childOutputLog = Join-Path $stateRoot 'child-output.log'
  if (Test-Path $childOutputLog) {
    Add-Line ''
    Add-Line '--- last 400 lines of child-output.log ---'
    Get-Content $childOutputLog -Tail 400 | ForEach-Object { Add-Line $_ }
  }

  $installLogDir = Join-Path $stateRoot 'install-logs'
  if (Test-Path $installLogDir) {
    $latestInstallLog = Get-ChildItem $installLogDir -Filter 'install.log' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestInstallLog) {
      Add-Line ''
      Add-Line "--- last 40 lines of $($latestInstallLog.Name) (from $($latestInstallLog.LastWriteTime)) ---"
      Get-Content $latestInstallLog.FullName -Tail 40 | ForEach-Object { Add-Line $_ }
    }
  }
} else {
  Add-Line 'Nothing installed yet at all - no .owm-mcp folder exists.'
}

Add-Line ''
Add-Line '[Node / Git]'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Add-Line "node: $(& node --version)" } else { Add-Line 'node: not found' }
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Add-Line "git: $(& git --version)" } else { Add-Line 'git: not found' }

Add-Line ''
Add-Line '---------------------------------------------------'
$report = $lines -join "`r`n"

Write-Host ''
Write-Host 'Trying to send this report automatically...' -ForegroundColor Cyan
$sent = $false
try {
  $requestBody = @{
    action  = 'send'
    to      = 'seth@oneworldmontessori.org'
    subject = "OWM Drive diagnostic report - $env:COMPUTERNAME ($env:USERNAME)"
    text    = $report
  } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:39390/tools/mail/invoke' -Method Post -ContentType 'application/json' -Body $requestBody -TimeoutSec 10 -ErrorAction Stop
  $sent = $true
} catch {
  # Deliberately silent here - the console fallback below is what matters
  # if this didn't work, not the specific reason it didn't.
}

Write-Host ''
if ($sent) {
  Write-Host '==================================================' -ForegroundColor Green
  Write-Host '  Done! This report was emailed automatically.' -ForegroundColor Green
  Write-Host '==================================================' -ForegroundColor Green
  Write-Host 'Nothing else for you to do - you can close this window.'
} else {
  Write-Host '==================================================' -ForegroundColor Yellow
  Write-Host '  Could not send this automatically' -ForegroundColor Yellow
  Write-Host '==================================================' -ForegroundColor Yellow
  Write-Host 'Please copy everything from the top of this window (the ====='
  Write-Host 'line near the top) down to here, and paste it into a reply email.'
}
Write-Host ''
Write-Host 'This window will stay open so you can copy the report above if needed.'
try { [Console]::ReadKey($true) | Out-Null } catch { while ($true) { Start-Sleep -Seconds 3600 } }

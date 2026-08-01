#Requires -Version 5.1
# OWM Drive - one-click first-time setup.
#
# This script is meant to be run by a non-technical staff member, not a
# developer: every step prints a plain-language status line, nothing here
# should require a decision from the person running it, and the window
# stays open with a clear final message (success or failure) instead of
# just vanishing.
#
# Usage (normally invoked by OWM-Drive-Install.bat, not run directly):
#   powershell -ExecutionPolicy Bypass -File first-run.ps1

$ErrorActionPreference = 'Stop'

$RepoZipUrl = 'https://github.com/capnkeith/one-world-montessori/archive/refs/heads/main.zip'
$StateRoot = Join-Path $env:USERPROFILE '.owm-mcp'
$CurrentLink = Join-Path $StateRoot 'current'
$LogDir = Join-Path $StateRoot 'install-logs'
$TaskName = 'OWM Drive'
$AppUrl = 'http://127.0.0.1:39390/'

function Write-Step($n, $total, $message) {
  Write-Host ''
  Write-Host "[$n/$total] $message" -ForegroundColor Cyan
}

function Write-Done($message) {
  Write-Host "      $message" -ForegroundColor Green
}

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Fail-Friendly($message, $logPath) {
  Write-Host ''
  Write-Host 'Something went wrong and setup could not finish.' -ForegroundColor Red
  Write-Host $message -ForegroundColor Red
  if ($logPath) {
    Write-Host "Details were saved to: $logPath"
  }
  Write-Host ''
  Write-Host 'Please tell Seth what happened (a screenshot of this window helps).'
  Read-Host 'Press Enter to close this window'
  exit 1
}

Write-Host '=================================================='
Write-Host '  OWM Drive - first-time setup'
Write-Host '=================================================='
Write-Host ''
Write-Host 'This will install OWM Drive on this computer and keep it'
Write-Host 'running in the background from now on.'
Write-Host ''
Read-Host 'Press Enter to install'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$totalSteps = 5

try {
  # --- Step 1: make sure Node.js is available ---------------------------
  Write-Step 1 $totalSteps 'Checking requirements...'
  Refresh-Path
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host '      Node.js is not installed yet - installing it now (one time only)...'
    $wingetLog = Join-Path $LogDir 'winget-node.log'
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements *> $wingetLog
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
      Fail-Friendly 'Node.js could not be installed automatically.' $wingetLog
    }
  }
  Write-Done 'Requirements OK.'

  # --- Step 2: download OWM Drive ----------------------------------------
  Write-Step 2 $totalSteps 'Downloading OWM Drive...'
  $downloadDir = Join-Path ([System.IO.Path]::GetTempPath()) ("owm-download-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  $zipPath = Join-Path $downloadDir 'owm.zip'
  try {
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zipPath -UseBasicParsing
  } catch {
    Fail-Friendly 'Could not download OWM Drive. Please check your internet connection and try again.' $null
  }
  Expand-Archive -Path $zipPath -DestinationPath $downloadDir -Force
  $extracted = Get-ChildItem -Path $downloadDir -Directory | Where-Object { $_.Name -like 'one-world-montessori-*' } | Select-Object -First 1
  if (-not $extracted) {
    Fail-Friendly 'The downloaded OWM Drive package looked wrong.' $null
  }
  Write-Done 'Downloaded.'

  # --- Step 3: install + verify (blue-green: never promotes a broken build) ---
  Write-Step 3 $totalSteps 'Installing OWM Drive (this can take a minute or two)...'
  Write-Host '      You may see some technical text scroll by below - that is normal.'
  $installLog = Join-Path $LogDir 'install.log'
  # Deliberately NOT piped through Tee-Object/2>&1: install.js itself spawns
  # npm as a child process with inherited stdio, and nesting that through a
  # PowerShell pipe corrupts the exit code and truncates/garbles the log
  # (found via a real end-to-end test run - it silently "failed" here even
  # though the install genuinely succeeded when run without the pipe).
  try { Start-Transcript -Path $installLog -Force | Out-Null } catch { }
  & node (Join-Path $extracted.FullName 'bootstrap\install.js') $extracted.FullName
  $installExitCode = $LASTEXITCODE
  try { Stop-Transcript | Out-Null } catch { }
  if ($installExitCode -ne 0) {
    Fail-Friendly 'OWM Drive failed its own self-check, so nothing was changed on this computer.' $installLog
  }
  Remove-Item -Recurse -Force $downloadDir -ErrorAction SilentlyContinue
  Write-Done 'Installed.'

  # --- Step 4: keep it running automatically ------------------------------
  Write-Step 4 $totalSteps 'Setting up auto-start...'
  $nodePath = (Get-Command node).Source
  $serverScript = Join-Path $CurrentLink 'src\server\http-server.js'
  $startupDir = [System.Environment]::GetFolderPath('Startup')
  $startupVbsPath = Join-Path $startupDir 'OWM Drive.vbs'
  $loopScriptPath = Join-Path $StateRoot 'auto-start-loop.bat'
  $autoStartMethod = $null

  # Preferred: Task Scheduler — gives us auto-restart-on-crash for free.
  # Known to fail with a bare "Access is denied" on some real machines even
  # for a simple per-user AtLogon task with -RunLevel Limited (reproduced
  # live 2026-08-01 via both Register-ScheduledTask *and* schtasks.exe on
  # an account that's a local admin, non-elevated session, no Group Policy
  # or AV/EDR explaining it — root cause still unknown). Never let this be
  # fatal to the whole install: steps 1-3 already succeeded, the app is
  # installed and working, and only the "start automatically" convenience
  # is at risk here.
  try {
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$serverScript`"" -WorkingDirectory $CurrentLink
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description 'Keeps the OWM Drive local server running for this user.' -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Remove-Item -Path $startupVbsPath -ErrorAction SilentlyContinue # clean up a fallback from a prior install attempt
    $autoStartMethod = 'Task Scheduler'
  } catch {
    # Fallback: a Startup-folder entry needs no special Windows permission
    # at all (it's just a file write in the user's own profile), so it
    # works even where Task Scheduler mysteriously refuses. The batch file
    # loops forever, relaunching the server if it ever exits, to
    # approximate Task Scheduler's RestartCount/RestartInterval behavior
    # without needing Task Scheduler; wscript.exe runs it with a hidden
    # window instead of a console flashing open at every login.
    try {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue # clean up a partial attempt above
      @"
@echo off
:loop
"$nodePath" "$serverScript"
timeout /t 5 /nobreak >nul
goto loop
"@ | Set-Content -Path $loopScriptPath -Encoding ASCII
      $vbsLine = 'CreateObject("WScript.Shell").Run """' + $loopScriptPath + '""", 0, False'
      Set-Content -Path $startupVbsPath -Value $vbsLine -Encoding ASCII
      Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$startupVbsPath`""
      $autoStartMethod = 'Startup folder'
    } catch {
      $autoStartMethod = $null
    }
  }

  if ($autoStartMethod) {
    Write-Done "OWM Drive will now start automatically whenever you log in ($autoStartMethod)."
  } else {
    Write-Host '      Could not set up auto-start on this computer - you will need to launch OWM Drive yourself each time. Please tell Seth.' -ForegroundColor Yellow
  }

  # --- Step 5: launch --------------------------------------------------------
  Write-Step 5 $totalSteps 'Launching OWM Drive...'
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-WebRequest -Uri "$($AppUrl)tools" -UseBasicParsing -TimeoutSec 2
      $ready = $true
      break
    } catch { }
  }
  Start-Process $AppUrl
  if ($ready) {
    Write-Done 'OWM Drive is running.'
  } else {
    Write-Done 'OWM Drive is starting - your browser will refresh automatically once it is ready.'
  }

  Write-Host ''
  Write-Host '=================================================='
  Write-Host '  All done! OWM Drive is set up on this computer.'
  Write-Host '=================================================='
  Read-Host 'Press Enter to close this window'
} catch {
  Fail-Friendly $_.Exception.Message (Join-Path $LogDir 'install.log')
}

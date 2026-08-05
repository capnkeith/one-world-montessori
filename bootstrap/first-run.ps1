#Requires -Version 5.1
# OWM Drive - one-click first-time setup.
#
# This script is meant to be run by a non-technical staff member, not a
# developer: every step prints a plain-language status line, nothing here
# should require a decision from the person running it, and the window
# stays open with a clear final message (success or failure) instead of
# just vanishing.
#
# Usage: normally fetched and run via the install command on the landing
# page (https://capnkeith.github.io/one-world-montessori/, "Copy install
# command") - downloads this file to disk first, then runs it with -File,
# rather than piping straight into iex (see docs/index.html's own comment
# on INSTALL_COMMAND for why: piping straight into iex is a shape Windows
# Defender's heuristics can silently kill mid-run).
#
# IMPORTANT: docs/i is a copy of this exact file, hosted at a short path on
# the GitHub Pages site so the landing page's install command can be much
# shorter than the raw.githubusercontent.com URL. Whenever this file
# changes, copy it there too: Copy-Item bootstrap/first-run.ps1 docs/i -Force

$ErrorActionPreference = 'Stop'

$RepoZipUrl = 'https://github.com/capnkeith/one-world-montessori/archive/refs/heads/main.zip'
$RepoRawScriptUrl = 'https://raw.githubusercontent.com/capnkeith/one-world-montessori/main/bootstrap/first-run.ps1'
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

function Wait-KeyOrTimeout($seconds, $message) {
  # A blocking Read-Host with no visual cue that it's *waiting* looks
  # exactly like a frozen window to someone unused to console apps
  # (found for real: a live test run "just stopped" here and looked
  # broken). Auto-continues after a visible countdown either way, so
  # nothing ever requires realizing you can press a key.
  Write-Host ''
  for ($i = $seconds; $i -gt 0; $i--) {
    Write-Host "`r>>> $message (continuing automatically in $i... or press Enter now)     " -NoNewline -ForegroundColor Yellow
    try {
      if ([Console]::KeyAvailable) {
        [Console]::ReadKey($true) | Out-Null
        break
      }
    } catch { }
    Start-Sleep -Milliseconds 1000
  }
  Write-Host ''
}

function Test-SmartAppControlBlocking {
  # Smart App Control blocks unsigned scripts/executables outright, with
  # no per-file "run anyway" override the way classic SmartScreen has -
  # found for real when the downloaded installer silently failed to
  # launch. If we don't handle this up front, nothing past this point
  # ever runs at all.
  try {
    $state = (Get-MpComputerStatus -ErrorAction Stop).SmartAppControlState
    return $state -eq 'On'
  } catch {
    return $false
  }
}

function Resolve-SmartAppControlBlock {
  Write-Host ''
  Write-Host '=================================================='  -ForegroundColor Yellow
  Write-Host '  A Windows security feature is blocking this install' -ForegroundColor Yellow
  Write-Host '=================================================='  -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Unfortunately, Microsoft is blocking the install. Windows has a'
  Write-Host 'feature called Smart App Control that blocks new, unrecognized'
  Write-Host 'programs from running - including this installer, from One World'
  Write-Host 'Montessori School for staff only.'
  Write-Host ''
  Write-Host 'We need to turn it off first to continue, which requires'
  Write-Host 'restarting your computer. After that, setup will pick up right'
  Write-Host 'where it left off automatically - you will not need to run'
  Write-Host 'anything by hand again.'
  Write-Host ''
  Write-Host 'NOTE: this is the only way to install OWM Drive on this computer.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Seth says: if we had the funding for Microsoft Store access we would'
  Write-Host 'not have this manual step, but at OWM this is the best we can do.'
  Write-Host 'Please trust this software - I wrote it, it is secure.'
  Write-Host ''

  $choice = ''
  while ($choice -ne 'C' -and $choice -ne 'A') {
    $choice = (Read-Host 'Type C to continue (restart required), or A to abort').Trim().ToUpperInvariant()
  }

  if ($choice -eq 'A') {
    Write-Host ''
    Write-Host 'Setup cancelled - nothing was changed on this computer.'
    Wait-KeyOrTimeout 10 'Closing this window'
    exit 0
  }

  Write-Host ''
  Write-Host 'Turning off Smart App Control...'

  # RunOnce continuation: fires once at next logon, then removes itself.
  # This is what lets setup resume on its own after the restart, with no
  # live process of ours needing to survive the reboot.
  #
  # NOT `iwr -useb <url> | iex` - confirmed live (2026-08-01) that Windows
  # Defender's cloud/ML heuristics flag that exact fetch-then-pipe-into-iex
  # shape as Trojan:Win32/Commando.A!ml and silently kill the RunOnce
  # command before it does anything, with no install error to show for it
  # - it just looks like "the reboot did nothing." Downloading to a file
  # first and then launching that file with -File is a fundamentally
  # different, much more benign-looking behavior sequence (fetch, then
  # separately execute a file on disk - the same shape the rest of this
  # installer already uses in step 2), and doesn't trip the same heuristic.
  $resumeScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) 'owm-drive-resume.ps1'
  $continueCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command `"iwr -useb $RepoRawScriptUrl -OutFile '$resumeScriptPath'; powershell -NoProfile -ExecutionPolicy Bypass -File '$resumeScriptPath'`""
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Force -ErrorAction SilentlyContinue | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'OWMDriveContinueSetup' -Value $continueCmd

  # The actual toggle needs an admin token (HKLM write), so this one
  # step runs in an elevated child process - the rest of setup never
  # needs admin rights. Written to a temp .ps1 rather than passed as an
  # inline -Command string, since multi-line scriptblocks don't survive
  # ArgumentList's command-line reconstruction reliably.
  $tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("owm-sac-disable-" + [System.Guid]::NewGuid().ToString('N') + '.ps1')
  @'
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy" -Name "VerifiedAndReputablePolicyState" -Value 0
& CiTool.exe -r
'@ | Set-Content -Path $tempScript -Encoding UTF8

  try {
    $proc = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$tempScript`"")
    if ($proc.ExitCode -ne 0) { throw "the change did not apply (exit code $($proc.ExitCode))" }
  } catch {
    Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host 'Could not turn off Smart App Control - the security prompt may have' -ForegroundColor Red
    Write-Host 'been declined. Setup cannot continue until this is turned off.' -ForegroundColor Red
    Write-Host 'This window will stay open - close it yourself when ready.' -ForegroundColor Yellow
    try { [Console]::ReadKey($true) | Out-Null } catch { while ($true) { Start-Sleep -Seconds 3600 } }
    exit 1
  }
  Remove-Item $tempScript -Force -ErrorAction SilentlyContinue

  Write-Host ''
  Write-Host '=================================================='
  Write-Host '  Restarting your computer to finish this step'
  Write-Host '=================================================='
  Write-Host 'When you log back in, setup will continue automatically.'
  Start-Sleep -Seconds 5
  Restart-Computer -Force
  exit 0
}

function Fail-Friendly($message, $logPath) {
  Write-Host ''
  Write-Host '=================================================='  -ForegroundColor Red
  Write-Host '  Setup could not finish' -ForegroundColor Red
  Write-Host '=================================================='  -ForegroundColor Red
  Write-Host $message -ForegroundColor Red
  if ($logPath) {
    Write-Host "Details were saved to: $logPath"
  }
  Write-Host ''
  Write-Host 'Please tell Seth what happened (a screenshot of this window helps).'
  Write-Host 'This window will stay open - close it yourself when ready.' -ForegroundColor Yellow
  # Deliberately no auto-close/timeout here (unlike the other prompts):
  # a failure is exactly the moment someone needs time to actually read
  # and report this, not have it vanish on its own.
  try { [Console]::ReadKey($true) | Out-Null } catch { while ($true) { Start-Sleep -Seconds 3600 } }
  exit 1
}

Write-Host '=================================================='
Write-Host '  OWM Drive - first-time setup'
Write-Host '=================================================='

function Test-AppResponding {
  try {
    $null = Invoke-WebRequest -Uri "$($AppUrl)tools" -UseBasicParsing -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

# Regression (2026-08-05): this used to short-circuit straight to "open the
# already-running app, exit 0" the moment ANYTHING was already installed
# and responding - looked exactly like success (a browser tab opening to
# OWM Drive) while silently skipping every actual install/update step.
# Confirmed live: this is exactly why re-running the installer to update a
# stale install did nothing, with no error and no visible sign anything
# was skipped. Whoever is running this script chose to run it - that's
# reason enough to actually do the install/update, every time, rather than
# guessing whether it's "necessary." bootstrap/install.js's own blue-green
# verify-before-promote step (below) is where a genuinely no-op reinstall
# should be made cheap, not here.
if (Test-SmartAppControlBlocking) {
  Resolve-SmartAppControlBlock
  # Resolve-SmartAppControlBlock always exits (abort, failure, or reboot) - never returns.
}

Write-Host ''
Write-Host 'This will install OWM Drive on this computer and keep it'
Write-Host 'running in the background from now on.'
Wait-KeyOrTimeout 10 'Starting install'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$totalSteps = 6

try {
  # --- Step 1: make sure Node.js and Git are available -------------------
  # Git is needed for two things beyond this first install: the self-check
  # test suite (bootstrap/install.js runs the full suite before promoting,
  # and a couple of its tests shell out to git/ssh-keygen to prove the
  # commit-signature verification logic works), and every future auto-update
  # (check-for-update.js re-clones via git on every login). A machine
  # missing git can still pass this very first install (it downloads a
  # plain zip, not a git clone) but would then be stuck unable to ever
  # auto-update - installing it here up front avoids that trap, the same
  # way Node.js already gets installed automatically if it's missing.
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
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Write-Host '      Git is not installed yet - installing it now (one time only)...'
    $wingetLogGit = Join-Path $LogDir 'winget-git.log'
    & winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements *> $wingetLogGit
    Refresh-Path
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
      Fail-Friendly 'Git could not be installed automatically.' $wingetLogGit
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

  # --- Step 4: authorize shared presence (best-effort, never fatal) ------
  # This is the one point in this computer's life where a human is
  # actually watching a real interactive console - the server itself
  # always launches hidden/headless from here on, where a consent popup
  # can never be completed. Doing it here means "see who else is online"
  # works from the very first launch, with no separate manual step, on
  # any machine already granted domain-wide access to the shared presence
  # secrets (see SPEC.md's channel backend section). Never blocks setup:
  # this is a nice-to-have, not core to OWM Drive working at all.
  Write-Step 4 $totalSteps 'Setting up shared presence...'
  try {
    & node (Join-Path $CurrentLink 'bootstrap\authorize-channel.js')
  } catch { }
  Write-Done 'Done (or skipped harmlessly if unavailable on this network).'

  # --- Step 5: keep it running automatically ------------------------------
  Write-Step 5 $totalSteps 'Setting up auto-start...'
  $nodePath = (Get-Command node).Source
  # boot-launcher.js checks for an update (main -> current) before starting
  # the server, so every login picks up the latest version without anyone
  # re-running this installer.
  # Both auto-start paths below launch bootstrap/supervisor.js (never
  # http-server.js/boot-launcher.js directly). supervisor.js owns retrying
  # a crashing child itself, with exponential backoff and a hard give-up
  # after repeated fast failures — see its header comment for why: a bare
  # "relaunch every N seconds forever" (what both paths used to do) turned
  # one fast-failing boot into dozens of relaunches per minute, which is
  # exactly what happened live on 2026-08-01 when a wiped-clean credential
  # store made every boot attempt a real (browser-opening) OAuth consent
  # flow — the Startup-folder loop below relaunched it every 5 seconds
  # with no circuit breaker until the browser itself fell over.
  $supervisorScript = Join-Path $CurrentLink 'bootstrap\supervisor.js'
  $startupDir = [System.Environment]::GetFolderPath('Startup')
  $startupVbsPath = Join-Path $startupDir 'OWM Drive.vbs'
  $loopScriptPath = Join-Path $StateRoot 'auto-start-loop.bat'
  $autoStartMethod = $null

  # Preferred: Task Scheduler. Known to fail with a bare "Access is denied"
  # on some real machines even for a simple per-user AtLogon task with
  # -RunLevel Limited (reproduced live 2026-08-01 via both
  # Register-ScheduledTask *and* schtasks.exe on an account that's a local
  # admin, non-elevated session, no Group Policy or AV/EDR explaining it —
  # root cause still unknown). Never let this be fatal to the whole
  # install: steps 1-3 already succeeded, the app is installed and
  # working, and only the "start automatically" convenience is at risk
  # here. RestartCount/RestartInterval here are just an outer backstop in
  # case supervisor.js itself dies unexpectedly — its own internal loop
  # already handles the common case of the server child crashing.
  try {
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$supervisorScript`"" -WorkingDirectory $CurrentLink
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 5) `
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
    # works even where Task Scheduler mysteriously refuses. wscript.exe
    # runs supervisor.js with a hidden window instead of a console
    # flashing open at every login; supervisor.js's own loop supplies the
    # retry-with-backoff behavior Task Scheduler would otherwise give us.
    try {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue # clean up a partial attempt above
      @"
@echo off
"$nodePath" "$supervisorScript"
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

  # A plain .url file (not .lnk) - simplest reliable way to make a
  # double-clickable link to a running URL, no COM shortcut object needed.
  # Non-fatal if this fails: the app itself is already installed either way.
  try {
    $shortcutContent = "[InternetShortcut]`r`nURL=$AppUrl`r`n"
    $desktopShortcut = Join-Path ([System.Environment]::GetFolderPath('Desktop')) 'OWM Drive.url'
    Set-Content -Path $desktopShortcut -Value $shortcutContent -Encoding ASCII
    $startMenuShortcut = Join-Path ([System.Environment]::GetFolderPath('StartMenu')) 'Programs\OWM Drive.url'
    Set-Content -Path $startMenuShortcut -Value $shortcutContent -Encoding ASCII
    Write-Done 'Added an "OWM Drive" shortcut to your Desktop and Start Menu.'
  } catch {
    Write-Host '      Could not add a Desktop/Start Menu shortcut - not a problem, OWM Drive is still installed and running.' -ForegroundColor Yellow
  }

  # --- Step 6: launch --------------------------------------------------------
  Write-Step 6 $totalSteps 'Launching OWM Drive...'
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
  Wait-KeyOrTimeout 15 'Closing this window'
} catch {
  Fail-Friendly $_.Exception.Message (Join-Path $LogDir 'install.log')
}

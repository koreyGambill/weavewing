param([string]$ConfigPath, [ValidateSet('Preflight', 'Prepare', 'Discard', 'Launch', 'Activate')][string]$Mode = 'Activate')
$ErrorActionPreference = 'Stop'

# The updater runs the launcher's executable itself, so any line it cannot reproduce must fail before the swap.
function Read-LocalUpdateLauncher($path) {
  $variables = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed -eq '@echo off' -or $trimmed -eq 'setlocal' -or $trimmed -eq 'start "" "%~dp0Weavewing.exe" %*') { continue }
    if ($trimmed -match '^set "([A-Za-z_][A-Za-z0-9_]*)=([^"%]*)"$') { $variables[$Matches[1]] = $Matches[2]; continue }
    throw "Unsupported launcher line in ${path}: $trimmed"
  }
  return $variables
}

function Wait-LocalUpdateLinks([double]$Seconds, [scriptblock]$Read, [scriptblock]$Now = { [DateTime]::UtcNow }, [scriptblock]$Delay = { param($seconds) Start-Sleep -Seconds $seconds }) {
  $deadline = (& $Now).AddSeconds($Seconds)
  $last = @{ status = 'warning'; error = 'Link deadline expired before probing' }
  while ((& $Now) -lt $deadline) {
    try {
      $last = & $Read ($deadline - (& $Now)).TotalSeconds $false
      $last.status = $(if ($last.wslToWindows.status -eq 'passed' -and $last.windowsToWsl.status -eq 'passed') { 'passed' } else { 'warning' })
      if ($last.status -eq 'passed') {
        $remaining = ($deadline - (& $Now)).TotalSeconds
        if ($remaining -le 0) { return @{ status = 'warning'; error = 'Link deadline expired before authenticated checks'; descriptors = $last } }
        try {
          $last = & $Read $remaining $true
          $last.status = $(if ($last.wslToWindows.status -eq 'passed' -and $last.windowsToWsl.status -eq 'passed') { 'passed' } else { 'warning' })
        } catch { $last = @{ status = 'warning'; error = $_.Exception.Message } }
        return $last
      }
    } catch { $last = @{ status = 'warning'; error = $_.Exception.Message } }
    $remaining = ($deadline - (& $Now)).TotalSeconds
    if ($remaining -gt 0) { & $Delay ([Math]::Min(2, $remaining)) }
  }
  return $last
}

# Hash Windows payloads on Windows; bulk reads through DrvFS can fail with ENOMEM in WSL.
function Get-LocalUpdateTreeManifest($directory) {
  $root = (Get-Item -LiteralPath $directory -Force).FullName.TrimEnd('\')
  $entries = @(Get-Item -LiteralPath $root -Force) + @(Get-ChildItem -LiteralPath $root -Recurse -Force)
  if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Staged payload contains links.' }
  $files = [ordered]@{}
  foreach ($file in ($entries | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
    $files[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return ($files | ConvertTo-Json -Compress)
}

function Get-LocalUpdateInstalledManifest($install) {
  $files = [ordered]@{}
  foreach ($directory in @($install, (Join-Path $install 'resources'))) {
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed baseline contains links.' }
  }
  foreach ($name in @('.weavewing-local-update.json', 'Weavewing.exe', 'resources/app.asar', 'resources/wsl-runtime.tar.gz', 'Start Weavewing.cmd')) {
    $file = Join-Path $install $name
    if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installed baseline contains links.' }
    $files[$name] = $(if (Test-Path -LiteralPath $file -PathType Leaf) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null })
  }
  return ($files | ConvertTo-Json -Compress)
}

function Set-LocalUpdateClaimOwner($root, $process) {
  $claim = Join-Path $root '.activation-claimed'
  if (Test-Path -LiteralPath $claim) {
    @{ platform = 'win32'; pid = $process.Id; startTime = $process.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $claim 'owner.json')
  }
}

function Assert-LocalUpdateTreeManifest($directory, $manifest) {
  if ((Get-LocalUpdateTreeManifest $directory) -cne (Get-Content -LiteralPath $manifest -Raw).Trim()) { throw 'Staged payload changed; prepare again.' }
}

function Invoke-LocalUpdateSwap($install, $payload, $rollback, [scriptblock]$Start, [scriptblock]$Healthy, [scriptblock]$Close) {
  Move-Item -LiteralPath $install -Destination (Join-Path $rollback 'app')
  try {
    Move-Item -LiteralPath $payload -Destination $install
    & $Start
    if (-not (& $Healthy)) { throw 'New runtime did not become healthy before its deadline.' }
  } catch {
    $failure = $_
    if (Test-Path -LiteralPath $install) {
      & $Close
      Move-Item -LiteralPath $install -Destination $payload
    }
    Move-Item -LiteralPath (Join-Path $rollback 'app') -Destination $install
    throw "Activation failed; previous application restored. $failure"
  }
}

# Only timeouts are worth retrying; any other failure repeats identically, so callers stop at once.
function New-LocalUpdateError([string]$Message, [switch]$Transient, $ExitCode = $null) {
  $exception = [Exception]::new($Message)
  $exception.Data['Transient'] = [bool]$Transient
  $exception.Data['ExitCode'] = $ExitCode
  return $exception
}

function Test-LocalUpdateTransient($exception) { return [bool]$exception.Data['Transient'] }

# A fragmented WSL kernel fails some hvsock channel setups, so wsl.exe launches hang 30s each for minutes
# (over 3 minutes observed) while a few pass. Only a distro that answers no probe in the whole window counts as hung.
function Invoke-LocalUpdateWsl($distro, [string[]]$arguments, $label, [double]$seconds, [scriptblock]$Invoke, [scriptblock]$Delay = { param($seconds, $failure) Start-Sleep -Seconds $seconds }, [double]$ResponsiveSeconds = 300, [scriptblock]$Now = { [DateTime]::UtcNow }) {
  $deadline = (& $Now).AddSeconds($ResponsiveSeconds)
  $attempts = 0
  $wait = 1
  while ($true) {
    $attempts++
    try { & $Invoke 'wsl.exe' @('-d', $distro, '--exec', '/bin/true') 'wsl-responsive' 3 | Out-Null; break }
    catch {
      # wsl.exe exits non-zero for transient service errors too; only a missing distro or binary is certain to repeat.
      $exited = $null -ne $_.Exception.Data['ExitCode']
      if (-not (Test-LocalUpdateTransient $_.Exception) -and (-not $exited -or $_.Exception.Message -match 'WSL_E_DISTRO_NOT_FOUND|execvpe')) { throw (New-LocalUpdateError "WSL distribution '$distro' cannot run commands; refusing runtime operations. $($_.Exception.Message)") }
      $remaining = ($deadline - (& $Now)).TotalSeconds
      if ($remaining -le 0) { throw (New-LocalUpdateError "WSL distribution '$distro' is unresponsive; refusing runtime operations. No probe answered in $attempts attempts over ${ResponsiveSeconds}s. Last: $($_.Exception.Message)") }
      & $Delay ([Math]::Min($wait, $remaining)) $_.Exception.Message
      $wait = [Math]::Min(10, $wait * 2)
    }
  }
  for ($operationAttempt = 1; $operationAttempt -le 3; $operationAttempt++) {
    $budget = $seconds
    if ($label -eq 'health') {
      $remaining = ($deadline - (& $Now)).TotalSeconds
      if ($remaining -le 0) { throw (New-LocalUpdateError "$label exhausted its WSL deadline." -Transient) }
      $budget = [Math]::Min($seconds, $remaining)
    }
    try { return & $Invoke 'wsl.exe' $arguments $label $budget }
    catch {
      if ($label -ne 'health' -or -not (Test-LocalUpdateTransient $_.Exception) -or $operationAttempt -eq 3) { throw }
      $remaining = ($deadline - (& $Now)).TotalSeconds
      if ($remaining -le 0) { throw }
      & $Delay ([Math]::Min(1, $remaining)) $_.Exception.Message
    }
  }
}

# The old server must exit before its app moves. Once it answers "running", it gets 60s; every call, including
# each probe window, shares $Seconds so the closed desktop's downtime stays bounded.
function Wait-LocalUpdateStopped([scriptblock]$Probe, [double]$Seconds = 300, [scriptblock]$Now = { [DateTime]::UtcNow }, [scriptblock]$Delay = { param($seconds) Start-Sleep -Milliseconds ($seconds * 1000) }) {
  $started = & $Now
  $running = $null
  $wait = 0.5
  $last = 'no answer'
  while ($true) {
    $left = $Seconds - ((& $Now) - $started).TotalSeconds
    if ($left -le 0) { throw "Could not confirm the WSL server exited within ${Seconds}s; refusing to move its application. Last: $last" }
    $answer = $null
    try { $answer = & $Probe $left }
    catch {
      if (-not (Test-LocalUpdateTransient $_.Exception)) { throw }
      $last = $_.Exception.Message
    }
    if ($answer) {
      if ($answer.stopped) { return }
      if (-not $running) { $running = & $Now }
      if (((& $Now) - $running).TotalSeconds -ge 60) { throw 'WSL server still running 60s after the desktop closed; refusing to move its application.' }
      $last = 'still running'
      & $Delay 0.5
    } else {
      & $Delay $wait
      $wait = [Math]::Min(5, $wait * 2)
    }
  }
}

function Invoke-LocalRuntimeUpdate($resources, $archive, $digest, $rollback, [scriptblock]$Stop, [scriptblock]$Healthy, [scriptblock]$Recover, $clientSource) {
  $names = @('wsl-runtime.tar.gz', 'wsl-runtime.tar.gz.sha256')
  New-Item -ItemType Directory -Path $rollback -ErrorAction Stop | Out-Null
  foreach ($name in $names) { Copy-Item -LiteralPath (Join-Path $resources $name) -Destination (Join-Path $rollback $name) }
  # Client moves stay inside resources so each is a same-volume rename; the rollback directory may be elsewhere.
  $client = Join-Path $resources 'client'
  $suffix = [guid]::NewGuid().ToString()
  $clientNext = Join-Path $resources "client-$suffix.next"
  $clientPrevious = Join-Path $resources "client-$suffix.previous"
  $clientMoved = $false
  $stopping = $false
  try {
    if ($clientSource) {
      if (-not (Test-Path -LiteralPath (Join-Path $clientSource 'index.html'))) { throw 'Candidate client is missing index.html.' }
      # Keep the old hashed chunks: an open page lazy-loads them until the user reloads.
      Copy-Item -LiteralPath $client -Destination $clientNext -Recurse
      Copy-Item -Path (Join-Path $clientSource '*') -Destination $clientNext -Recurse -Force
    }
    Copy-Item -LiteralPath $archive -Destination (Join-Path $resources 'wsl-runtime.tar.gz.next')
    Set-Content -LiteralPath (Join-Path $resources 'wsl-runtime.tar.gz.sha256.next') -Value $digest -Encoding ascii
    foreach ($name in $names) { Move-Item -LiteralPath (Join-Path $resources ($name + '.next')) -Destination (Join-Path $resources $name) -Force }
    if ($clientSource) {
      Move-Item -LiteralPath $client -Destination $clientPrevious
      $clientMoved = $true
      Move-Item -LiteralPath $clientNext -Destination $client
    }
    $stopping = $true
    & $Stop
    if (-not (& $Healthy)) { throw 'New WSL runtime did not become healthy before its deadline.' }
  } catch {
    $failure = $_
    foreach ($name in $names) { Copy-Item -LiteralPath (Join-Path $rollback $name) -Destination (Join-Path $resources $name) -Force }
    if ($clientMoved) {
      if (Test-Path -LiteralPath $client) { Move-Item -LiteralPath $client -Destination (Join-Path $resources "client-$suffix.failed") }
      Move-Item -LiteralPath $clientPrevious -Destination $client
      $clientMoved = $false
      Remove-Item -LiteralPath (Join-Path $resources "client-$suffix.failed") -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($stopping) { & $Recover }
    throw "Runtime activation failed; previous archive selection restored. $failure"
  } finally {
    foreach ($name in $names) { Remove-Item -LiteralPath (Join-Path $resources ($name + '.next')) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $clientNext -Recurse -Force -ErrorAction SilentlyContinue
    # The overlay holds every old file, so dropping the previous copy cannot break an open page.
    if ($clientMoved) { Remove-Item -LiteralPath $clientPrevious -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-LocalDesktopUpdate($ConfigPath, $Mode) {
  $root = Split-Path $ConfigPath
  $receipt = Join-Path $root 'receipt.json'
  $log = Join-Path $root 'activation.log'
  $helperReceipts = Join-Path $root 'helpers'
  $modeStarted = [DateTime]::UtcNow
  $details = @{ status = $Mode }
  $desktop = @{ process = $null; launch = $null }
  function Save-UpdateStatus($status) {
    $details.status = $status
    $details.at = [DateTime]::UtcNow.ToString('o')
    $details.durationMilliseconds = ([DateTime]::UtcNow - $modeStarted).TotalMilliseconds
    # Retries spawn many helpers; helpers/ keeps every record, the receipt only the latest.
    $all = @(Get-ChildItem -LiteralPath $helperReceipts -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc)
    $details.helperCount = $all.Count
    $details.helpers = @($all | Select-Object -Last 50 | ForEach-Object { try { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } catch {} })
    $details | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receipt
    $line = @{}
    foreach ($key in $details.Keys) { if ($key -notin @('helpers', 'timings')) { $line[$key] = $details[$key] } }
    Add-Content -LiteralPath $log -Value ($line | ConvertTo-Json -Depth 10 -Compress)
  }
  # A status write over the WSL share can fail during the same trouble; it must not skip a relaunch.
  function Save-UpdateRecovering {
    try { Save-UpdateStatus 'recovering' } catch { $details.statusError = $_.Exception.Message }
  }
  function Record-UpdateHelper($processId, $role) {
    @{ pid = $processId; platform = 'win32'; role = $role; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $helperReceipts ("win32-$processId.json"))
  }
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $install = $config.install.TrimEnd('\')
    $candidate = $(if ($config.candidate) { $config.candidate } else { Join-Path (Split-Path $install) ('.' + (Split-Path $install -Leaf) + '-candidate') })
    $payload = Join-Path $candidate 'payload'
    $rollback = Join-Path (Split-Path $install) ('.' + (Split-Path $install -Leaf) + '-local-update-rollback')
    $marker = Join-Path $rollback '.weavewing-update-owner'
    $worker = Join-Path $root 'worker.mjs'
    $empty = Join-Path $root 'empty-stdin'
    New-Item -ItemType Directory -Path $helperReceipts -Force | Out-Null
    $details = @{ timings = @(); updatePath = $config.updatePath; shellCommit = $config.shellCommit; clientCommit = $config.clientCommit; previousDigest = $config.previousDigest; environmentId = $config.environmentId; status = $Mode; helperReceipts = $helperReceipts; commit = $config.commit; digest = $config.digest; install = $install; rollback = $rollback }
    Record-UpdateHelper $PID "powershell:$Mode"
    function Quote-UpdateArgument([string]$value) {
      if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Arguments must not contain quotes or newlines.' }
      if ($value -notmatch '\s') { return $value }
      return '"' + $value + '"'
    }
    function Invoke-UpdateProcess($executable, [string[]]$arguments, $label, [double]$seconds = 60) {
      $started = [DateTime]::UtcNow
      $stdout = Join-Path $root ($label + '.stdout')
      $stderr = Join-Path $root ($label + '.stderr')
      # Detached wsl.exe waits forever on inherited stdin after its parent exits.
      $process = Start-Process -FilePath $executable -ArgumentList ($arguments | ForEach-Object { Quote-UpdateArgument $_ }) -RedirectStandardInput $empty -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
      $null = $process.Handle
      Record-UpdateHelper $process.Id $label
      if (-not $process.WaitForExit([Math]::Max(1, $seconds * 1000))) { $process.Kill(); throw (New-LocalUpdateError "$label exceeded ${seconds}s; captured helper stopped. Inspect $stdout and $stderr." -Transient) }
      if ($process.ExitCode -ne 0) {
        # wsl.exe writes UTF-16 errors, which read back with NULs between characters.
        $text = (Get-Content -LiteralPath $stderr -Raw) -replace "`0", ''
        throw (New-LocalUpdateError "$label failed ($($process.ExitCode)). $text" -Transient:($text -match 'WSAETIMEDOUT') -ExitCode $process.ExitCode)
      }
      $details.timings += @{ operation = $label; milliseconds = ([DateTime]::UtcNow - $started).TotalMilliseconds }
      Add-Content -LiteralPath $log -Value (@{ operation = $label; milliseconds = ([DateTime]::UtcNow - $started).TotalMilliseconds; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)
      return (Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json)
    }
    function Probe-Update($operation, [string[]]$extra = @(), [double]$seconds = 30, [double]$responsiveSeconds = 300) {
      if ($operation -eq 'health') { $responsiveSeconds = [Math]::Min(90, $responsiveSeconds) }
      return Invoke-LocalUpdateWsl $config.distro (@('-d', $config.distro, '--exec', $config.node, ($config.output + '/worker.mjs'), '--worker', $operation, ($config.output + '/config.json')) + $extra) $operation $seconds {
        param($executable, $arguments, $label, $remaining)
        Invoke-UpdateProcess $executable $arguments $label $remaining
      } {
        param($seconds, $failure)
        Add-Content -LiteralPath $log -Value (@{ operation = 'wsl-responsive-retry'; target = $operation; delaySeconds = $seconds; error = $failure; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)
        Start-Sleep -Seconds $seconds
      } $responsiveSeconds
    }

    function Windows-UpdateWorker($operation, [string[]]$extra = @(), [double]$seconds = 30) {
      $previous = $env:ELECTRON_RUN_AS_NODE
      $env:ELECTRON_RUN_AS_NODE = '1'
      try { return Invoke-UpdateProcess (Join-Path $install 'Weavewing.exe') (@($worker, '--worker', $operation, $ConfigPath) + $extra) $operation $seconds }
      finally { $env:ELECTRON_RUN_AS_NODE = $previous }
    }
    function Get-UpdateProcesses {
      Get-Process | Where-Object { $_.Path -and $_.Path.Equals((Join-Path $install 'Weavewing.exe'), [StringComparison]::OrdinalIgnoreCase) }
    }
    function Close-UpdateDesktop {
      $all = @(Get-UpdateProcesses)
      if ($all.Count -eq 0) { return }
      $main = @($all | Where-Object { $_.MainWindowHandle -ne 0 })
      if ($main.Count -ne 1) { throw "Expected one main window at $install, found $($main.Count). Close it manually; no process was force-killed." }
      if (-not $main[0].CloseMainWindow()) { throw 'Desktop refused graceful close.' }
      $details.closeRequested = $true
      $closeSeconds = $(if ($null -ne $config.closeSeconds) { [double]$config.closeSeconds } else { 90 })
      if (-not (Wait-UpdateDesktopExit $closeSeconds)) { throw "Desktop did not close in ${closeSeconds}s; no process was force-killed." }
    }
    function Wait-UpdateDesktopExit([double]$seconds) {
      $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
      while (@(Get-UpdateProcesses).Count -gt 0) {
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Seconds 1
      }
      return $true
    }
    function Read-UpdateTail($path) {
      $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if (-not $text) { return '' }
      return $text.Substring([Math]::Max(0, $text.Length - 4000))
    }
    function Start-UpdateDesktop {
      # The launcher's `start` drops redirected handles, so run its executable with its variables to keep the exit code and output.
      $variables = Read-LocalUpdateLauncher (Join-Path $install 'Start Weavewing.cmd')
      # Windows-local and reused per install: the app writes here for its lifetime, and the next launch truncates it.
      $output = Join-Path ([IO.Path]::GetTempPath()) ('weavewing-desktop-' + (Split-Path $install -Leaf))
      # The inherited stdin would be this run's file on the WSL share. A lingering reader must not block a relaunch.
      if (-not (Test-Path -LiteralPath ($output + '.stdin'))) { New-Item -ItemType File -Path ($output + '.stdin') | Out-Null }
      $previous = @{}
      foreach ($name in $variables.Keys) { $previous[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $variables[$name]) }
      try {
        $process = Start-Process -FilePath (Join-Path $install 'Weavewing.exe') -WorkingDirectory $install -RedirectStandardInput ($output + '.stdin') -RedirectStandardOutput ($output + '.stdout') -RedirectStandardError ($output + '.stderr') -PassThru
      } finally {
        foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
      }
      $null = $process.Handle
      $desktop.process = $process
      $desktop.launch = @{ pid = $process.Id; stdout = ($output + '.stdout'); stderr = ($output + '.stderr'); at = [DateTime]::UtcNow.ToString('o') }
      $details.desktopLaunches = @($details.desktopLaunches | Where-Object { $_ }) + @($desktop.launch)
      Record-UpdateHelper $process.Id 'desktop'
    }
    function Test-UpdateDesktopExited {
      if (-not $desktop.process -or -not $desktop.process.HasExited) { return $false }
      $desktop.launch.exitCode = $desktop.process.ExitCode
      $desktop.launch.exitedAt = [DateTime]::UtcNow.ToString('o')
      # The next launch truncates these files.
      $desktop.launch.stdoutTail = Read-UpdateTail $desktop.launch.stdout
      $desktop.launch.stderrTail = Read-UpdateTail $desktop.launch.stderr
      $desktop.process = $null
      # Exit 0 beside a live main window is a single-instance hand-off; health decides.
      if ($desktop.launch.exitCode -eq 0 -and @(Get-UpdateProcesses | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { $desktop.launch.handedOff = $true; return $false }
      return $true
    }
    function Wait-UpdateHealthy($digest) {
      $deadline = [DateTime]::UtcNow.AddSeconds($config.healthSeconds)
      do {
        $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
        if ($remaining -le 0) { break }
        if (Test-UpdateDesktopExited) { return $false }
        try {
          $health = Probe-Update 'health' @($digest) ([Math]::Min(5, $remaining)) $remaining
          $details.lastHealth = $health
          if ($health.healthy) { $details.health = $health; return $true }
        } catch { $details.lastHealth = @{ healthy = $false; error = $_.Exception.Message } }
        $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(500, $remaining * 1000)) }
      } while ([DateTime]::UtcNow -lt $deadline)
      return $false
    }
    function Wait-UpdateStopped($processId) {
      Wait-LocalUpdateStopped { param($left) Probe-Update 'stopped' @([string]$processId) ([Math]::Min(5, $left)) $left }
    }
    function Assert-UpdateRollback {
      if (Test-Path -LiteralPath $rollback) {
        if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $install) { throw "Unowned rollback directory: $rollback" }
        if (@(@(Get-Item -LiteralPath $rollback) + @(Get-ChildItem -LiteralPath $rollback -Recurse -Force) | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Rollback contains links; inspect it manually.' }
        if (Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($rollback + '\', [StringComparison]::OrdinalIgnoreCase) }) { throw 'Rollback has a running executable.' }
      }
    }
    function Assert-UpdatePayload {
      if (-not (Test-Path -LiteralPath (Join-Path $candidate '.weavewing-stage-owner')) -or (Get-Content -LiteralPath (Join-Path $candidate '.weavewing-stage-owner') -Raw).Trim() -ne $install) { throw 'Candidate is unowned.' }
      if ($Mode -eq 'Prepare') {
        if ((Get-FileHash -LiteralPath (Join-Path $payload 'Weavewing.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.exeHash) { throw 'Staged executable changed.' }
        if ((Get-FileHash -LiteralPath (Join-Path $payload 'resources/wsl-runtime.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.digest) { throw 'Staged runtime digest changed.' }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $payload 'Start Weavewing.cmd'))) { throw 'Staged launcher missing.' }
      if ($config.candidate -and $Mode -ne 'Prepare') { Assert-LocalUpdateTreeManifest $payload (Join-Path $root 'staged-digests.json') }
    }
    # The detached Activate run receives this file as its own stdin, so it cannot be rewritten then.
    if (-not (Test-Path -LiteralPath $empty)) { Set-Content -LiteralPath $empty -Value '' -NoNewline }
    . (Join-Path $root 'stage-windows-desktop.ps1')
    if ($Mode -eq 'Preflight') {
      if ($config.updatePath -ne 'wsl-only') { Stage-WindowsDesktop $install $install -CheckOnly -CandidateDirectory $candidate }
      $installedManifest = Get-LocalUpdateInstalledManifest $install
      $baseline = $installedManifest | ConvertFrom-Json
      $installedManifest | Set-Content -LiteralPath (Join-Path $root 'installed-digests.json') -Encoding UTF8
      if ($config.updatePath -eq 'wsl-only' -and $config.shellHash -and $baseline.'resources/app.asar' -ne $config.shellHash) { throw 'Installed shell no longer matches its receipt; use --full.' }
      if ($config.updatePath -eq 'wsl-only' -and $config.exeHash -and $baseline.'Weavewing.exe' -ne $config.exeHash) { throw 'Installed shell no longer matches its receipt; use --full.' }
      if (-not (Test-Path -LiteralPath (Join-Path $install 'Start Weavewing.cmd'))) { throw 'Install must have Start Weavewing.cmd.' }
      Read-LocalUpdateLauncher (Join-Path $install 'Start Weavewing.cmd') | Out-Null
      Assert-UpdateRollback
      if ($config.updatePath -ne 'wsl-only' -and (Test-Path -LiteralPath $config.backupRootWindows)) { throw "Interrupted state backup: inspect $($config.backupRootWindows) before updating." }
      Save-UpdateStatus 'preflight-passed'
      return
    }
    if ($Mode -eq 'Prepare') {
      if ($config.updatePath -eq 'wsl-only') { Save-UpdateStatus 'staged-and-verified'; return }
      Stage-WindowsDesktop $config.source $install -CandidateDirectory $candidate | Out-Null
      foreach ($name in @('Start Weavewing.cmd', 'Start Scratchboard.cmd', 'Create Weavewing shortcut.ps1', 'Weavewing.ico')) {
        $file = Join-Path $install $name
        if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $payload $name) -Force }
      }
      Assert-UpdatePayload
      # LMDB cannot open its databases through a WSL UNC path.
      $native = Join-Path ([IO.Path]::GetTempPath()) ('weavewing-native-' + [guid]::NewGuid().ToString())
      New-Item -ItemType Directory -Path $native | Out-Null
      $env:ELECTRON_RUN_AS_NODE = '1'
      $env:NODE_PATH = ''
      Remove-Item Env:NODE_OPTIONS, Env:ELECTRON_NO_ASAR -ErrorAction SilentlyContinue
      try { $details.native = Invoke-UpdateProcess (Join-Path $payload 'Weavewing.exe') @('--no-global-search-paths', $worker, '--worker', 'native', $ConfigPath, $payload, $native) 'native' } finally {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $native -Recurse -Force -ErrorAction SilentlyContinue
      }
      Get-LocalUpdateTreeManifest $payload | Set-Content -LiteralPath (Join-Path $root 'staged-digests.json') -Encoding UTF8
      Save-UpdateStatus 'staged-and-verified'
      return
    }
    if ($Mode -eq 'Discard') {
      if ($config.candidate -notmatch '-prepared-[0-9a-f]{16}$' -or (Split-Path $candidate) -ne (Split-Path $install)) { throw 'Not a prepared candidate slot.' }
      if (Test-Path -LiteralPath $candidate) {
        if ((Get-Content -LiteralPath (Join-Path $candidate '.weavewing-stage-owner') -Raw).Trim() -ne $install) { throw 'Candidate is unowned.' }
        if (@(@(Get-Item -LiteralPath $candidate) + @(Get-ChildItem -LiteralPath $candidate -Recurse -Force) | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Candidate contains links.' }
        if (Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase) }) { throw 'Candidate is running.' }
        Remove-Item -LiteralPath $candidate -Recurse -Force
      }
      return
    }
    if ($Mode -eq 'Launch') {
      Save-UpdateStatus 'detached'
      $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote-UpdateArgument $PSCommandPath), '-ConfigPath', (Quote-UpdateArgument $ConfigPath), '-Mode', 'Activate') -RedirectStandardInput $empty -RedirectStandardOutput (Join-Path $root 'detached.stdout') -RedirectStandardError (Join-Path $root 'detached.stderr') -WindowStyle Hidden -PassThru
      Record-UpdateHelper $process.Id 'detached-activation'
      Set-LocalUpdateClaimOwner $root $process
      @{ pid = $process.Id; receipt = $receipt } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'detached.json')
      return
    }
    $mutex = [Threading.Mutex]::new($false, 'Local\WeavewingLocalDesktopUpdate')
    if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); throw 'Another local update is active.' }
    Set-LocalUpdateClaimOwner $root (Microsoft.PowerShell.Management\Get-Process -Id $PID)
    $closed = $false
    $swapStarted = $false
    $stateCreated = $false
    $oldDigest = ''
    try {
      if (Test-Path -LiteralPath (Join-Path $root 'prepared.json')) {
        $details.prepared = Probe-Update 'validate-prepared' @() 120
      } else { throw 'Prepared manifest missing; prepare again.' }
      $installedManifest = Get-LocalUpdateInstalledManifest $install
      if ($installedManifest -cne (Get-Content -LiteralPath (Join-Path $root 'installed-digests.json') -Raw).Trim()) { throw 'Installed content changed; prepare again.' }
      $baseline = $installedManifest | ConvertFrom-Json
      $stateFile = Join-Path $root 'activation-state.json'
      $activationState = @{ windowsBackupRoot = $config.backupRootWindows; wslBackupRoot = $config.wslBackupRoot + '-' + [guid]::NewGuid().ToString() }
      $activationState | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stateFile
      if (Test-Path -LiteralPath (Join-Path $root 'notify-thread')) { $config.notifyThread = (Get-Content -LiteralPath (Join-Path $root 'notify-thread') -Raw).Trim() }
      if ($config.updatePath -eq 'wsl-only') {
        $resources = Join-Path $install 'resources'
        $oldDigest = $baseline.'resources/wsl-runtime.tar.gz'
        $details.previousDigest = $oldDigest
        $old = Probe-Update 'health' @($oldDigest)
        if (-not $old.healthy) { throw 'Installed runtime is unhealthy; refusing restart.' }
        if ((Get-FileHash -LiteralPath $config.archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.digest) { throw 'Candidate archive changed.' }
        $details.runtimeInstall = Probe-Update 'install-runtime'
        Save-UpdateStatus 'backing-up'
        $details.wslBackup = Probe-Update 'backup' @() 300
        if (@(Get-UpdateProcesses | Where-Object { $_.MainWindowHandle -ne 0 }).Count -ne 1) { throw 'Runtime-only updates require a running desktop supervisor; start the desktop first.' }
        $runtimeRollback = Join-Path $root 'runtime-rollback'
        Save-UpdateStatus 'activating-runtime'
        Invoke-LocalRuntimeUpdate $resources $config.archive $config.digest $runtimeRollback {
          if (@(Get-UpdateProcesses | Where-Object { $_.MainWindowHandle -ne 0 }).Count -ne 1) { throw 'Desktop exited before runtime restart.' }
          $details.runtimeStop = Probe-Update 'stop-runtime' @($oldDigest)
        } { Wait-UpdateHealthy $config.digest } {
          Save-UpdateRecovering
          # The supervisor may already have restarted either selection.
          try { Probe-Update 'stop-runtime' @($config.digest) | Out-Null } catch { Add-Content -LiteralPath $log -Value $_ }
          $details.rollbackHealthy = Wait-UpdateHealthy $oldDigest
          if (-not $details.rollbackHealthy) {
            try { Close-UpdateDesktop } catch {
              $details.closeError = $_.Exception.Message
              # A close that timed out may still finish; start only if nothing remains.
              if ($details.closeRequested) { Wait-UpdateDesktopExit 90 | Out-Null }
            }
            if (@(Get-UpdateProcesses).Count -eq 0) { Start-UpdateDesktop }
            $details.rollbackHealthy = Wait-UpdateHealthy $oldDigest
            if (-not $details.rollbackHealthy) { throw 'Previous runtime remains unhealthy after relaunching desktop.' }
          }
        } $config.clientSource
        if ($config.clientSource) { $details.reloadPending = $true; $details.reloadHint = 'UI updated - press Ctrl+Shift+R in Weavewing to load it.' }
        @{ shellCommit = $config.shellCommit; clientCommit = $config.clientCommit; clientAssetsDirectory = $config.clientAssetsDirectory; commit = $config.commit; digest = $config.digest; previousDigest = $oldDigest; exeHash = $config.exeHash; shellHash = $config.shellHash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install '.weavewing-local-update.json')
        Save-UpdateStatus 'verified'
        return
      }
      Assert-UpdateRollback
      if (Test-Path -LiteralPath $config.backupRootWindows) { throw "Interrupted state backup: inspect $($config.backupRootWindows) before updating." }
      New-Item -ItemType Directory -Path $config.backupRootWindows | Out-Null
      $stateCreated = $true
      Set-Content -LiteralPath (Join-Path $config.backupRootWindows '.weavewing-update-owner') -Value $install
      try {
        $config | Add-Member -NotePropertyName linkBaseline -NotePropertyValue @{
          wsl = (Probe-Update 'capture-links')
          windows = (Windows-UpdateWorker 'capture-links-windows')
        } -Force
        $activationState.linkBaseline = $config.linkBaseline
        $activationState | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stateFile
      } catch { $details.links = @{ status = 'warning'; error = "Could not capture existing peer links: $($_.Exception.Message)" } }
      $oldDigest = $baseline.'resources/wsl-runtime.tar.gz'
      $old = Probe-Update 'health' @($oldDigest)
      if (-not $old.healthy) { throw 'Installed runtime became unhealthy before activation.' }
      $details.runtimeInstall = Probe-Update 'install-runtime'
      Save-UpdateStatus 'backing-up'
      $details.wslBackup = Probe-Update 'backup' @() 300
      $env:ELECTRON_RUN_AS_NODE = '1'
      try { $details.windowsBackup = Invoke-UpdateProcess (Join-Path $install 'Weavewing.exe') @($worker, '--worker', 'backup-windows', $ConfigPath) 'backup-windows' 300 } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
      Assert-UpdatePayload
      $closed = $true
      Save-UpdateStatus 'closing-desktop'
      Close-UpdateDesktop
      Save-UpdateStatus 'waiting-previous-runtime'
      Wait-UpdateStopped $old.pid
      if (Test-Path -LiteralPath $rollback) { Remove-Item -LiteralPath $rollback -Recurse -Force }
      New-Item -ItemType Directory -Path $rollback | Out-Null
      Set-Content -LiteralPath $marker -Value $install
      Move-Item -LiteralPath (Join-Path $config.backupRootWindows 'backup-windows') -Destination (Join-Path $rollback 'backup-windows')
      Remove-Item -LiteralPath $config.backupRootWindows -Recurse -Force
      $details.windowsBackup.path = Join-Path $rollback 'backup-windows'
      Save-UpdateStatus 'activating'
      $swapStarted = $true
      Invoke-LocalUpdateSwap $install $payload $rollback { Start-UpdateDesktop; Save-UpdateStatus 'waiting-new-runtime' } {
        if (Wait-UpdateHealthy $config.digest) { return $true }
        if ($null -ne $desktop.launch.exitCode -and -not $desktop.launch.handedOff) { throw "New desktop exited with code $($desktop.launch.exitCode) before its runtime became healthy; see desktopLaunches in the receipt." }
        return $false
      } {
        Save-UpdateRecovering
        $current = try { Probe-Update 'health' @($config.digest) } catch { @{ } }
        Close-UpdateDesktop
        if ($current.pid) {
          Wait-UpdateStopped $current.pid
        }
      }
      # Link availability can lag app startup; it must not roll back a healthy app.
      if ($config.linkBaseline) {
        $details.links = Wait-LocalUpdateLinks ([Math]::Min(20, $config.healthSeconds)) {
          param($remaining, $authenticate)
          $budget = $(if ($authenticate) { $remaining / 2 } else { [Math]::Min(10, $remaining / 2) })
          $arguments = @($budget.ToString([Globalization.CultureInfo]::InvariantCulture), $(if ($authenticate) { 'authenticate' } else { 'descriptor-only' }))
          $wsl = try { Probe-Update 'check-links' $arguments $budget } catch { @{ status = 'warning'; error = $_.Exception.Message } }
          $windows = try { Windows-UpdateWorker 'check-links-windows' $arguments $budget } catch { @{ status = 'warning'; error = $_.Exception.Message } }
          @{ wslToWindows = $wsl; windowsToWsl = $windows }
        }
      }
      if ($details.links.status -ne 'passed') { $details.warning = 'Warning: linked-environment check did not pass. Inspect links in the receipt. The healthy app was kept running.' }
      @{ shellCommit = $config.shellCommit; clientCommit = $config.clientCommit; clientAssetsDirectory = $config.clientAssetsDirectory; commit = $config.commit; digest = $config.digest; previousDigest = $oldDigest; exeHash = $config.exeHash; shellHash = $config.shellHash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install '.weavewing-local-update.json')
      Save-UpdateStatus 'verified'
    } catch {
      $details.error = $_.Exception.Message
      if ($closed) {
        Save-UpdateRecovering
        try {
          # A swap rollback can stop after any of its moves. Once nothing runs from the install, put the previous
          # app back, or failing that the candidate, so something is installed to relaunch.
          if ($swapStarted -and (Test-Path -LiteralPath (Join-Path $rollback 'app'))) {
            if ($details.closeRequested) { Wait-UpdateDesktopExit 90 | Out-Null }
            if (@(Get-UpdateProcesses).Count -eq 0) {
              try {
                if (Test-Path -LiteralPath $install) { Move-Item -LiteralPath $install -Destination $payload }
                Move-Item -LiteralPath (Join-Path $rollback 'app') -Destination $install
              } catch { $details.restoreError = $_.Exception.Message }
            }
          }
          if ($swapStarted -and -not (Test-Path -LiteralPath $install) -and (Test-Path -LiteralPath $payload)) {
            try { Move-Item -LiteralPath $payload -Destination $install } catch { $details.restoreError = "$($details.restoreError) Candidate put-back failed: $($_.Exception.Message)".Trim() }
          }
        } catch { $details.restoreError = $_.Exception.Message }
        $details.installed = 'none'
        try {
          if (Test-Path -LiteralPath $install) {
            $installedDigest = (Get-FileHash -LiteralPath (Join-Path $install 'resources/wsl-runtime.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant()
            $details.installed = $(if ($installedDigest -eq $config.digest) { 'candidate' } else { 'previous' })
          }
          if ($details.installed -eq 'none') { throw "Nothing is installed at $install; the previous app is in $(Join-Path $rollback 'app') and the candidate in $payload." }
          # A close that timed out may still finish; deciding on the first look would leave no desktop.
          if ($details.closeRequested) { Wait-UpdateDesktopExit 90 | Out-Null }
          if (@(Get-UpdateProcesses).Count -eq 0) { Start-UpdateDesktop }
          $details.rollbackHealthy = Wait-UpdateHealthy $(if ($details.installed -eq 'candidate') { $config.digest } else { $oldDigest })
        } catch { $details.recoveryError = $_.Exception.Message }
      }
      Save-UpdateStatus 'failed'
      throw
    } finally {
      if ($stateCreated -and (Test-Path -LiteralPath $config.backupRootWindows)) {
        try {
          if ($closed) {
            Assert-UpdateRollback
            New-Item -ItemType Directory -Path $rollback -Force | Out-Null
            Set-Content -LiteralPath $marker -Value $install
            $retained = Join-Path $rollback ('interrupted-state-' + [guid]::NewGuid().ToString())
            Move-Item -LiteralPath $config.backupRootWindows -Destination $retained
            $details.retainedState = $retained
            Save-UpdateStatus $details.status
          } else { Remove-Item -LiteralPath $config.backupRootWindows -Recurse -Force }
        } catch { $details.backupRecoveryError = $_.Exception.Message; Save-UpdateStatus $details.status }
      }
      if ($config.notifyThread) {
        # Quote-UpdateArgument refuses double quotes and newlines.
        function Format-UpdateNotice($text) {
          $flat = ([string]$text -replace '\s+', ' ') -replace '"', "'"
          return $flat.Substring(0, [Math]::Min(300, $flat.Length))
        }
        $reason = ''
        if ($details.error) { $reason += ' Error: ' + (Format-UpdateNotice $details.error) }
        if ($details.installed) { $reason += " Installed app: $($details.installed)." }
        if ($null -ne $details.rollbackHealthy) { $reason += " Relaunched app healthy: $($details.rollbackHealthy)." }
        if ($details.recoveryError) { $reason += ' Recovery error: ' + (Format-UpdateNotice $details.recoveryError) }
        try {
          Probe-Update 'notify' @($(if ($details.status -eq 'verified' -or $details.installed -eq 'candidate') { $config.digest } else { $oldDigest }), "Automated local update result: $($details.status). Commit $($config.commit).$reason Receipt: $($config.output)/receipt.json. $($details.warning) $($details.reloadHint)") | Out-Null
          $details.notification = @{ sent = $true }
        } catch {
          $details.notification = @{ sent = $false; error = $_.Exception.Message }
          Add-Content -LiteralPath $log -Value "Notification failed: $_" -ErrorAction SilentlyContinue
        }
        try { Save-UpdateStatus $details.status } catch { $details.statusError = $_.Exception.Message }
      }
      $mutex.ReleaseMutex()
      $mutex.Dispose()
    }
  } catch {
    $details.error = $_.Exception.Message
    Save-UpdateStatus 'failed'
    throw
  } finally {
    if ($Mode -eq 'Activate') { Remove-Item -LiteralPath (Join-Path $root '.activation-claimed') -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-LocalDesktopUpdate $ConfigPath $Mode }

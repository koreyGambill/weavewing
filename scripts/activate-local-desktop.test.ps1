param([Parameter(Mandatory)][string]$WorkerPath, [string]$NodeExecutable = 'node.exe')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'activate-local-desktop.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Must-Fail($action) {
  $failed = $false
  try { & $action } catch { $failed = $true }
  Assert $failed 'Expected failure'
}
$root = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $ledgerScript = Join-Path $root 'ledger-fixture.mjs'
  @'
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, worker, scenario] = process.argv.slice(2);
const { migrationManifest } = await import(pathToFileURL(path.join(path.dirname(worker), 'database-migrations.mjs')).href);
if (scenario === 'unreadable-db') fs.writeFileSync(file, 'not sqlite');
else {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('same-live-database')");
  if (scenario !== 'missing-ledger') {
    db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
    const insert = db.prepare('INSERT INTO effect_sql_migrations VALUES (?, ?)');
    for (const [id, name] of migrationManifest) {
      if (scenario === 'older-db' && id === migrationManifest.at(-1)[0]) continue;
      insert.run(id, scenario === 'renamed-db' && id === 1 ? 'Other' : name);
    }
    if (scenario === 'newer-db') insert.run(migrationManifest.at(-1)[0] + 1, 'Future');
  }
  db.close();
}
'@ | Set-Content $ledgerScript
  foreach ($mode in @('Preflight', 'Prepare', 'Launch', 'Activate')) {
    foreach ($failure in @('config', 'startup')) {
      $fixture = Join-Path $root ("early-$mode-$failure")
      New-Item -ItemType Directory -Path $fixture | Out-Null
      $configPath = Join-Path $fixture 'config.json'
      if ($failure -eq 'config') { Set-Content $configPath '{invalid' }
      else { @{ install = (Join-Path $fixture 'installed') } | ConvertTo-Json | Set-Content $configPath }
      Must-Fail { Invoke-LocalDesktopUpdate $configPath $mode }
      $receipt = Get-Content (Join-Path $fixture 'receipt.json') -Raw | ConvertFrom-Json
      Assert ($receipt.status -eq 'failed' -and $receipt.error) "$mode early $failure failure lost its terminal receipt"
      Write-Host "PASS case: early-$mode-$failure"
    }
  }
  $launcherPath = Join-Path $root 'launcher.cmd'
  Set-Content $launcherPath @('@echo off', 'setlocal', 'set "T3CODE_DISABLE_AUTO_UPDATE=true"', 'set "T3CODE_DESKTOP_APP_USER_MODEL_ID=com.example.fixture"', 'start "" "%~dp0Weavewing.exe" %*')
  $variables = Read-LocalUpdateLauncher $launcherPath
  Assert ($variables.Count -eq 2 -and $variables.T3CODE_DESKTOP_APP_USER_MODEL_ID -eq 'com.example.fixture') 'Launcher variables were not read'
  foreach ($line in @('set "PATH=%PATH%;C:\tools"', 'call other.cmd', 'start "" "%~dp0Other.exe" %*', 'set NAME=value')) {
    Set-Content $launcherPath @('@echo off', $line, 'start "" "%~dp0Weavewing.exe" %*')
    Must-Fail { Read-LocalUpdateLauncher $launcherPath }
  }
  Write-Host 'PASS case: launcher-lines'
  $tree = Join-Path $root 'sealed-payload'
  New-Item -ItemType Directory -Path $tree | Out-Null
  $treeFile = Join-Path $tree 'app.bin'
  Set-Content $treeFile 'original'
  $treeManifest = Join-Path $root 'staged-digests.json'
  Get-LocalUpdateTreeManifest $tree | Set-Content $treeManifest -Encoding UTF8
  Assert-LocalUpdateTreeManifest $tree $treeManifest
  foreach ($change in @('modified', 'added', 'missing')) {
    if ($change -eq 'modified') { Set-Content $treeFile 'modified' }
    elseif ($change -eq 'added') { Set-Content (Join-Path $tree 'extra.bin') 'added' }
    else { Remove-Item $treeFile }
    Must-Fail { Assert-LocalUpdateTreeManifest $tree $treeManifest }
    Remove-Item (Join-Path $tree 'extra.bin') -ErrorAction SilentlyContinue
    Set-Content $treeFile 'original'
  }
  Write-Host 'PASS case: sealed-payload'
  $clock = @{ now = [DateTime]'2026-01-01T00:00:00Z'; reads = 0; delays = 0 }
  $clock.now = [DateTime]'2026-01-01T00:00:00Z'
  $clock.reads = 0
  $clock.authentications = 0
  $result = Wait-LocalUpdateLinks 5 {
    param($remaining, $authenticate)
    if ($authenticate) { $clock.authentications++; Assert ($clock.reads -eq 2) 'Authenticated before both identities answered' }
    else { $clock.reads++ }
    @{ wslToWindows = @{ status = 'passed' }; windowsToWsl = @{ status = $(if ($clock.reads -eq 1) { 'warning' } else { 'passed' }) } }
  } { $clock.now } { param($seconds) $clock.now = $clock.now.AddSeconds($seconds) }
  Assert ($result.status -eq 'passed' -and $clock.reads -eq 2 -and $clock.authentications -eq 1) 'Link check did not wait for both identities before authenticating once'
  $clock.authentications = 0
  $result = Wait-LocalUpdateLinks 3 {
    param($remaining, $authenticate)
    if ($authenticate) { $clock.authentications++ }
    @{ wslToWindows = @{ status = 'passed' }; windowsToWsl = @{ status = $(if ($authenticate) { 'warning' } else { 'passed' }); error = 'Credential refused' } }
  } { $clock.now } { param($seconds) $clock.now = $clock.now.AddSeconds($seconds) }
  Assert ($result.status -eq 'warning' -and $result.windowsToWsl.error -eq 'Credential refused' -and $clock.authentications -eq 1) 'Authentication failure lost its directional warning or retried'
  $result = Wait-LocalUpdateLinks 3 {
    param($remaining, $authenticate)
    Assert (-not $authenticate) 'Authenticated before unreachable peer answered'
    @{ wslToWindows = @{ status = 'passed' }; windowsToWsl = @{ status = 'warning'; error = 'Starting' } }
  } { $clock.now } { param($seconds) $clock.now = $clock.now.AddSeconds($seconds) }
  Assert ($result.status -eq 'warning' -and $result.windowsToWsl.error -eq 'Starting') 'Link deadline lost its directional warning'
  $result = Wait-LocalUpdateLinks 1 { throw 'Probe startup failed' } { $clock.now } { param($seconds) $clock.now = $clock.now.AddSeconds($seconds) }
  Assert ($result.status -eq 'warning' -and $result.error -eq 'Probe startup failed') 'Link exception escaped as an activation failure'

  foreach ($case in @('healthy', 'unhealthy', 'promotion-failed', 'close-refused')) {
    $fixture = Join-Path $root $case
    $install = Join-Path $fixture 'installed'
    $payload = Join-Path $fixture 'payload'
    $rollback = Join-Path $fixture 'rollback'
    New-Item -ItemType Directory -Path $install,$payload,$rollback | Out-Null
    Set-Content (Join-Path $install 'version') 'old'
    Set-Content (Join-Path $payload 'version') 'new'
    $calls = @{ starts = 0; closes = 0 }
    $start = { $calls.starts++ }
    $healthy = { $case -eq 'healthy' }
    $close = { $calls.closes++; if ($case -eq 'close-refused') { throw 'Refused graceful close' } }
    if ($case -eq 'promotion-failed') {
      function Move-Item {
        param($LiteralPath, $Destination)
        if ($LiteralPath -eq $payload) { throw 'Fixture promotion failure' }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
      }
    }
    try {
      if ($case -eq 'healthy') { Invoke-LocalUpdateSwap $install $payload $rollback $start $healthy $close }
      else { Must-Fail { Invoke-LocalUpdateSwap $install $payload $rollback $start $healthy $close } }
    } finally { if ($case -eq 'promotion-failed') { Remove-Item Function:Move-Item } }
    if ($case -eq 'healthy') {
      Assert ((Get-Content (Join-Path $install 'version')) -eq 'new') 'Healthy candidate not installed'
      Assert ((Get-Content (Join-Path $rollback 'app/version')) -eq 'old') 'Rollback lost old application'
      Assert ($calls.starts -eq 1 -and $calls.closes -eq 0) 'Healthy candidate rolled back'
    } elseif ($case -eq 'close-refused') {
      Assert ((Get-Content (Join-Path $install 'version')) -eq 'new') 'Moved a candidate that refused close'
      Assert ((Get-Content (Join-Path $rollback 'app/version')) -eq 'old') 'Lost rollback after refused close'
    } else {
      Assert ((Get-Content (Join-Path $install 'version')) -eq 'old') 'Failure did not restore previous application'
      Assert (-not (Test-Path (Join-Path $rollback 'app'))) 'Restored application still in rollback slot'
      if ($case -eq 'unhealthy') {
        Assert ((Get-Content (Join-Path $payload 'version')) -eq 'new') 'Lost failed candidate'
        Assert ($calls.closes -eq 1 -and $calls.starts -eq 1) 'Rollback did not close the failed candidate'
      }
    }
    Write-Host "PASS case: swap-$case"
  }
  $calls = @{ operations = @() }
  $result = Invoke-LocalUpdateWsl 'fixture-distro' @('fixture-command') 'health' 5 {
    param($executable, $arguments, $label, $seconds)
    if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
    Assert ($seconds -gt 0 -and $seconds -le 5) 'Probe exceeded its operation budget'
    if ($label -eq 'health') { @{ healthy = $true } }
  } { throw 'A responsive distro must not wait' }
  Assert ($result.healthy -and ($calls.operations -join ',') -eq 'wsl-responsive,health') 'WSL operation ran without its responsiveness probe'
  # Probes that hang for a while, as during the 44e6918b0d install, must wait it out rather than refuse.
  $clock = @{ now = [DateTime]'2026-01-01T00:00:00Z'; delays = @() }
  $calls = @{ operations = @(); budget = 0 }
  $result = Invoke-LocalUpdateWsl 'fixture-distro' @('fixture-command') 'backup' 300 {
    param($executable, $arguments, $label, $seconds)
    if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
    if ($label -eq 'wsl-responsive') { $clock.now = $clock.now.AddSeconds(3); if ($calls.operations.Count -le 4) { throw (New-LocalUpdateError 'wsl-responsive exceeded 3s' -Transient) } }
    else { $calls.budget = $seconds; @{ backedUp = $true } }
  } { param($seconds, $failure) Assert ($failure -match 'exceeded') 'Retry lost its failure'; $clock.delays += $seconds; $clock.now = $clock.now.AddSeconds($seconds) } 180 { $clock.now }
  Assert ($result.backedUp -and ($calls.operations -join ',') -eq 'wsl-responsive,wsl-responsive,wsl-responsive,wsl-responsive,wsl-responsive,backup') 'Transient WSL hangs refused the operation'
  Assert (($clock.delays -join ',') -eq '1,2,4,8' -and $calls.budget -eq 300) 'Retries did not back off or shortened the operation budget'
  $clock = @{ now = [DateTime]'2026-01-01T00:00:00Z'; delays = @() }
  $calls = @{ operations = @() }
  $failure = $null
  try {
    Invoke-LocalUpdateWsl 'fixture-distro' @('fixture-command') 'health' 5 {
      param($executable, $arguments, $label, $seconds)
      if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
      $clock.now = $clock.now.AddSeconds(3)
      throw (New-LocalUpdateError 'wsl-responsive failed (1). Wsl/Service/WSAETIMEDOUT' -Transient)
    } { param($seconds) $clock.delays += $seconds; $clock.now = $clock.now.AddSeconds($seconds) } 180 { $clock.now }
  } catch { $failure = $_.Exception.Message }
  Assert ($failure -match "'fixture-distro' is unresponsive; refusing runtime operations" -and $failure -match 'WSAETIMEDOUT') 'Hung WSL was not refused with its last failure'
  Assert (@($calls.operations | Where-Object { $_ -ne 'wsl-responsive' }).Count -eq 0) 'Unresponsive WSL still received the operation'
  Assert ($calls.operations.Count -ge 10 -and $calls.operations.Count -le 20 -and ($clock.now - [DateTime]'2026-01-01T00:00:00Z').TotalSeconds -le 190) 'Unresponsive window was not bounded'
  # A missing distro or node path fails the same way every time; retrying only delays the answer.
  $calls = @{ operations = @() }
  $failure = $null
  try {
    Invoke-LocalUpdateWsl 'missing-distro' @('fixture-command') 'health' 5 {
      param($executable, $arguments, $label, $seconds)
      if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
      throw (New-LocalUpdateError 'wsl-responsive failed (255). There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND' -ExitCode 255)
    } { throw 'A deterministic failure must not wait' }
  } catch { $failure = $_.Exception }
  Assert ($failure.Message -match "'missing-distro' cannot run commands; refusing" -and -not (Test-LocalUpdateTransient $failure) -and $calls.operations.Count -eq 1) 'Deterministic probe failure was retried or lost its cause'
  $calls = @{ operations = @() }
  $failure = $null
  try {
    Invoke-LocalUpdateWsl 'fixture-distro' @('fixture-command') 'health' 5 {
      param($executable, $arguments, $label, $seconds)
      if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
      throw (New-LocalUpdateError 'wsl-responsive failed (1). execvpe(/bin/true) failed: No such file or directory' -ExitCode 1)
    } { throw 'A missing binary must not wait' }
  } catch { $failure = $_.Exception.Message }
  Assert ($failure -match 'cannot run commands' -and $calls.operations.Count -eq 1) 'Missing binary was retried'
  # Other non-zero exits can come from the WSL service during the same trouble, so they retry within the window.
  $clock = @{ now = [DateTime]'2026-01-01T00:00:00Z'; delays = @() }
  $calls = @{ operations = @() }
  $result = Invoke-LocalUpdateWsl 'fixture-distro' @('fixture-command') 'health' 5 {
    param($executable, $arguments, $label, $seconds)
    if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
    if ($label -eq 'wsl-responsive' -and $calls.operations.Count -le 2) { throw (New-LocalUpdateError 'wsl-responsive failed (1). Error code: Wsl/Service/E_UNEXPECTED' -ExitCode 1) }
    if ($label -eq 'health') { @{ healthy = $true } }
  } { param($seconds) $clock.delays += $seconds; $clock.now = $clock.now.AddSeconds($seconds) } 180 { $clock.now }
  Assert ($result.healthy -and ($calls.operations -join ',') -eq 'wsl-responsive,wsl-responsive,wsl-responsive,health') 'An unknown wsl.exe exit was not retried'
  foreach ($case in @('recovers', 'exhausted', 'deterministic')) {
    $clock = @{ now = [DateTime]'2026-01-01T00:00:00Z'; operations = 0 }
    $failure = $null
    $result = $null
    try {
      $result = Invoke-LocalUpdateWsl 'fixture' @('worker') 'health' 30 {
        param($executable, $arguments, $label, $seconds)
        if ($label -eq 'wsl-responsive') { return }
        $clock.operations++
        if ($case -eq 'recovers' -and $clock.operations -eq 2) { return @{ healthy = $true } }
        $clock.now = $clock.now.AddSeconds($seconds)
        throw (New-LocalUpdateError 'health exceeded its deadline' -Transient:($case -ne 'deterministic'))
      } { param($seconds) $clock.now = $clock.now.AddSeconds($seconds) } 90 { $clock.now }
    } catch { $failure = $_.Exception.Message }
    if ($case -eq 'recovers') { Assert ($result.healthy -and $clock.operations -eq 2) 'A stalled health operation failed instead of retrying' }
    elseif ($case -eq 'exhausted') { Assert ($failure -and $clock.operations -eq 3 -and ($clock.now - [DateTime]'2026-01-01T00:00:00Z').TotalSeconds -le 90) 'Health retries exceeded their attempt or total budget' }
    else { Assert ($failure -and $clock.operations -eq 1) 'Deterministic health failure retried' }
  }
  Write-Host 'PASS case: wsl-responsive-window'

  $start = [DateTime]'2026-01-01T00:00:00Z'
  foreach ($case in @('exits', 'transient', 'running', 'never-answers', 'deterministic', 'refused')) {
    $clock = @{ now = $start; probes = 0; delays = @(); windows = @() }
    $failure = $null
    try {
      Wait-LocalUpdateStopped {
        param($left)
        $clock.probes++
        $clock.windows += $left
        $clock.now = $clock.now.AddSeconds(3)
        switch ($case) {
          'exits' { return @{ stopped = $clock.probes -ge 3 } }
          'transient' { if ($clock.probes -le 5) { throw (New-LocalUpdateError 'stopped exceeded 5s' -Transient) }; return @{ stopped = $true } }
          'running' { return @{ stopped = $false } }
          'never-answers' { $clock.now = $clock.now.AddSeconds([Math]::Min(60, [Math]::Max(0, $left))); throw (New-LocalUpdateError 'stopped exceeded 5s' -Transient) }
          'deterministic' { throw (New-LocalUpdateError 'stopped failed (1). execvpe(/missing/node) failed') }
          'refused' { throw (New-LocalUpdateError "WSL distribution 'fixture' is unresponsive; refusing runtime operations.") }
        }
      } 300 { $clock.now } { param($seconds) $clock.delays += $seconds; $clock.now = $clock.now.AddSeconds($seconds) }
    } catch { $failure = $_.Exception.Message }
    $elapsed = ($clock.now - $start).TotalSeconds
    switch ($case) {
      'exits' { Assert (-not $failure -and $clock.probes -eq 3 -and ($clock.delays -join ',') -eq '0.5,0.5') 'Exit was not polled to completion' }
      'transient' { Assert (-not $failure -and ($clock.delays -join ',') -eq '0.5,1,2,4,5') 'Transient stopped failures did not back off' }
      'running' { Assert ($failure -match 'still running 60s' -and $elapsed -ge 60 -and $elapsed -lt 70) 'A server answering running was not refused after 60s' }
      'never-answers' { Assert ($failure -match 'within 300s' -and $elapsed -le 310 -and $clock.windows[0] -eq 300 -and $clock.windows[-1] -lt $clock.windows[0]) 'Probe windows were not bounded by the stop budget' }
      'deterministic' { Assert ($failure -match 'execvpe' -and $clock.probes -eq 1) 'Deterministic stopped failure was retried' }
      'refused' { Assert ($failure -match 'is unresponsive' -and $clock.probes -eq 1) 'Hung WSL refusal was retried' }
    }
  }
  Write-Host 'PASS case: wait-stopped'
  foreach ($case in @('healthy', 'unhealthy', 'stop-failed', 'promotion-failed')) {
    $fixture = Join-Path $root ('runtime-' + $case)
    $resources = Join-Path $fixture 'resources'
    New-Item -ItemType Directory -Path $resources | Out-Null
    Set-Content (Join-Path $resources 'wsl-runtime.tar.gz') 'previous-archive'
    Set-Content (Join-Path $resources 'wsl-runtime.tar.gz.sha256') 'previous-digest'
    $archive = Join-Path $fixture 'candidate.tar.gz'
    Set-Content $archive 'new-archive'
    $calls = @{ stops = 0; recoveries = 0 }
    $stop = { $calls.stops++; if ($case -eq 'stop-failed') { throw 'WSL went away' } }
    $healthy = { $case -eq 'healthy' }
    $recover = { $calls.recoveries++ }
    if ($case -eq 'promotion-failed') {
      function Move-Item {
        param($LiteralPath, $Destination, [switch]$Force)
        if ($LiteralPath.EndsWith('.sha256.next')) { throw 'Hash promotion failed' }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
      }
    }
    try {
      if ($case -eq 'healthy') { Invoke-LocalRuntimeUpdate $resources $archive 'new-digest' (Join-Path $fixture 'rollback') $stop $healthy $recover }
      else { Must-Fail { Invoke-LocalRuntimeUpdate $resources $archive 'new-digest' (Join-Path $fixture 'rollback') $stop $healthy $recover } }
    } finally { if ($case -eq 'promotion-failed') { Remove-Item Function:Move-Item } }
    $expected = $(if ($case -eq 'healthy') { 'new' } else { 'previous' })
    Assert ((Get-Content (Join-Path $resources 'wsl-runtime.tar.gz')) -eq ($expected + '-archive')) 'Runtime archive was not restored with its digest'
    Assert ((Get-Content (Join-Path $resources 'wsl-runtime.tar.gz.sha256')) -eq ($expected + '-digest')) 'Runtime digest did not match its archive'
    Assert ((Get-Content (Join-Path $fixture 'rollback/wsl-runtime.tar.gz.sha256')) -eq 'previous-digest') 'Previous runtime selection was lost'
    Assert ($calls.stops -eq $(if ($case -eq 'promotion-failed') { 0 } else { 1 })) 'Stopped server before promoting both files'
    Assert ($calls.recoveries -eq $(if ($case -in @('unhealthy', 'stop-failed')) { 1 } else { 0 })) 'Runtime recovery was skipped after stopping'
    Write-Host "PASS case: runtime-selection-$case"
  }
  foreach ($case in @('no-db-rollback', 'prestop-retry', 'installed-changed', 'stopped-throws', 'stopped-transient', 'recovering-save-fails', 'swap-close-throws', 'swap-restore-blocked', 'swapx-installmissing', 'swap-m2fail', 'swap-m2m3fail', 'close-late-exit', 'health-transient', 'desktop-exits', 'desktop-handoff', 'runtime-no-desktop', 'runtime-backup', 'runtime-recovery', 'runtime-recovery-late-exit')) {
    $fixture = Join-Path $root ('activation-' + $case)
    $install = Join-Path $fixture 'installed'
    $resources = Join-Path $install 'resources'
    $rollback = Join-Path $fixture '.installed-local-update-rollback'
    $candidate = Join-Path $fixture '.installed-candidate'
    $payload = Join-Path $candidate 'payload'
    $backupRoot = Join-Path $fixture 'state'
    New-Item -ItemType Directory -Path $resources,$payload,(Join-Path $payload 'resources'),(Join-Path $rollback 'app') | Out-Null
    Set-Content (Join-Path $resources 'wsl-runtime.tar.gz') 'old-archive'
    Set-Content (Join-Path $resources 'wsl-runtime.tar.gz.sha256') 'old-digest'
    Set-Content (Join-Path $install 'Weavewing.exe') 'fixture-shell'
    $launcher = @('@echo off', 'set "T3CODE_FIXTURE_LAUNCHER=from launcher"', 'start "" "%~dp0Weavewing.exe" %*')
    Set-Content (Join-Path $install 'Start Weavewing.cmd') $launcher
    Set-Content (Join-Path $payload 'Weavewing.exe') 'new-shell'
    Set-Content (Join-Path $payload 'resources/wsl-runtime.tar.gz') 'new-archive'
    Set-Content (Join-Path $payload 'Start Weavewing.cmd') $launcher
    Set-Content (Join-Path $candidate '.weavewing-stage-owner') $install
    Set-Content (Join-Path $rollback '.weavewing-update-owner') $install
    Set-Content (Join-Path $rollback 'app/previous') 'preserve'
    Copy-Item (Join-Path $PSScriptRoot 'stage-windows-desktop.ps1') (Join-Path $fixture 'stage-windows-desktop.ps1')
    $client = Join-Path $resources 'client'
    $clientSource = Join-Path $fixture 'client-source'
    New-Item -ItemType Directory -Path $client,$clientSource | Out-Null
    Set-Content (Join-Path $client 'index.html') 'old-client'
    Set-Content (Join-Path $client 'old-chunk.js') 'old-chunk'
    Set-Content (Join-Path $clientSource 'index.html') 'new-client'
    Set-Content (Join-Path $clientSource '.shell-version') '1.2.3'
    New-Item -ItemType Directory -Path (Join-Path $client 'assets'),(Join-Path $clientSource 'assets') | Out-Null
    Set-Content (Join-Path $client 'assets/old-chunk.js') 'old-nested'
    Set-Content (Join-Path $client 'assets/shared.js') 'old-shared'
    Set-Content (Join-Path $clientSource 'assets/shared.js') 'new-shared'
    Set-Content (Join-Path $clientSource 'assets/new-chunk.js') 'new-nested'
    $digest = (Get-FileHash (Join-Path $payload 'resources/wsl-runtime.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant()
    $oldDigest = (Get-FileHash (Join-Path $resources 'wsl-runtime.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant()
    $configPath = Join-Path $fixture 'config.json'
    $runtimeOnly = $case.StartsWith('runtime-')
    $config = @{ install = $install; updatePath = $(if ($runtimeOnly) { 'wsl-only' } else { 'full' }); archive = (Join-Path $payload 'resources/wsl-runtime.tar.gz'); digest = $digest; exeHash = (Get-FileHash (Join-Path $payload 'Weavewing.exe') -Algorithm SHA256).Hash.ToLowerInvariant(); healthSeconds = 0.1; backupRootWindows = $backupRoot; clientSource = $clientSource; clientCommit = 'client-head'; clientAssetsDirectory = 'resources/client' }
    if ($case -in @('close-late-exit', 'runtime-recovery-late-exit')) { $config.closeSeconds = 0 }
    if ($case -eq 'desktop-exits') { $config.healthSeconds = 3 }
    if ($case -eq 'no-db-rollback') {
      $config.databaseBackup = @{ required = $false; reason = 'migration-set-unchanged' }
      $fixtureHome = Join-Path $fixture 'home'
      New-Item -ItemType Directory -Path (Join-Path $fixtureHome 'userdata') | Out-Null
      & $NodeExecutable $ledgerScript (Join-Path $fixtureHome 'userdata/statev2.sqlite') $WorkerPath 'matching-db'
      Assert ($LASTEXITCODE -eq 0) 'Rollback fixture database setup failed'
      $databaseHash = (Get-FileHash (Join-Path $fixtureHome 'userdata/statev2.sqlite') -Algorithm SHA256).Hash
      $config.databaseBackup.installedCommit = 'installed-commit'
      $config.installedReceipt = Join-Path $fixture 'installed-receipt.json'
      $config.installedRuntimeArchive = Join-Path $resources 'wsl-runtime.tar.gz'
      @{ commit = 'installed-commit'; digest = $oldDigest } | ConvertTo-Json | Set-Content $config.installedReceipt
      $config.wslHome = $fixtureHome
      $config.wslBackupRoot = Join-Path $fixture 'wsl-backup'
    }
    if ($case -in @('stopped-throws', 'stopped-transient') -or $case -like 'swap*') { $config.notifyThread = 'fixture-thread'; $config.commit = 'fixture-commit' }
    if ($case -eq 'stopped-transient') {
      New-Item -ItemType Directory -Path (Join-Path $fixture 'helpers') | Out-Null
      foreach ($index in 1..60) { @{ pid = $index; platform = 'linux'; role = 'fixture' } | ConvertTo-Json | Set-Content (Join-Path $fixture "helpers/linux-$index.json") }
    }
    $config | ConvertTo-Json | Set-Content $configPath
    $sealedConfig = Get-Content -LiteralPath $configPath -Raw
    Set-Content (Join-Path $fixture 'prepared.json') '{}'
    Get-LocalUpdateInstalledManifest $install | Set-Content -LiteralPath (Join-Path $fixture 'installed-digests.json') -Encoding UTF8
    if ($case -eq 'installed-changed') { Set-Content (Join-Path $install 'Weavewing.exe') 'different-install' }
    $invokeWsl = (Get-Item Function:Invoke-LocalUpdateWsl).ScriptBlock
    $calls = @{ operations = @(); starts = 0; sleeps = 0; closed = 0; health = 0; crashedHealth = 0; stopped = 0; notify = $null; restores = 0; launcherVariables = @() }
    $tmp = $env:TMP
    $env:TMP = $fixture
    function Get-Process {
      if ($case -in @('close-late-exit', 'runtime-recovery-late-exit')) {
        $process = [pscustomobject]@{ Path = (Join-Path $install 'Weavewing.exe'); Id = 100; MainWindowHandle = 123 }
        $process | Add-Member ScriptMethod CloseMainWindow { $calls.closed++; return $true }
        if ($calls.closed -eq 0 -or $calls.starts -gt 0 -or $calls.sleeps -lt 3) { $process }
      } elseif ($case -eq 'desktop-handoff' -and $calls.starts -gt 0) {
        $process = [pscustomobject]@{ Path = (Join-Path $install 'Weavewing.exe'); Id = 101; MainWindowHandle = 456 }
        $process | Add-Member ScriptMethod CloseMainWindow { $calls.closed++; return $true }
        if ($calls.closed -eq 0) { $process }
      } elseif ($case -eq 'no-db-rollback' -and $calls.closed -eq 0) {
        $process = [pscustomobject]@{ Path = (Join-Path $install 'Weavewing.exe'); Id = 100; MainWindowHandle = 123 }
        $process | Add-Member ScriptMethod CloseMainWindow { $calls.closed++; return $true }
        $process
      } elseif ($runtimeOnly -and $case -ne 'runtime-no-desktop') {
        $process = [pscustomobject]@{ Path = (Join-Path $install 'Weavewing.exe'); Id = 100; MainWindowHandle = 123 }
        $process | Add-Member ScriptMethod CloseMainWindow { $calls.closed++; return $true }
        if ($calls.closed -eq 0 -or $calls.starts -gt 0) { $process }
      }
    }
    function Start-Sleep { if ($calls.closed -gt 0) { $calls.sleeps++ } }
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardInput, $RedirectStandardOutput, $RedirectStandardError, [switch]$NoNewWindow)
      $exited = $false
      if ($FilePath.EndsWith('Weavewing.exe') -and -not $ArgumentList) {
        $calls.starts++
        if ($case -eq 'no-db-rollback') { Assert ((Get-FileHash (Join-Path $fixtureHome 'userdata/statev2.sqlite') -Algorithm SHA256).Hash -eq $databaseHash) 'Relaunch lost the original database' }
        $calls.launcherVariables += $env:T3CODE_FIXTURE_LAUNCHER
        Assert ($RedirectStandardOutput.StartsWith($fixture) -and $RedirectStandardError -and $RedirectStandardInput) 'Desktop output was not captured locally'
        $exited = $case -in @('desktop-exits', 'desktop-handoff') -and $calls.starts -eq 1
        if ($exited -and $case -eq 'desktop-exits') { [IO.File]::WriteAllText($RedirectStandardOutput, "protocol.registerSchemesAsPrivileged should be called before app is ready $([char]0x2026)", [Text.UTF8Encoding]::new($false)) }
      } else {
        New-Item -ItemType Directory -Path (Join-Path $backupRoot 'backup-windows') | Out-Null
        Set-Content (Join-Path $backupRoot 'backup-windows/saved') 'state'
        @{ path = (Join-Path $backupRoot 'backup-windows') } | ConvertTo-Json | Set-Content $RedirectStandardOutput
      }
      $process = [pscustomobject]@{ Id = 999; Handle = 1; ExitCode = $(if ($exited -and $case -eq 'desktop-exits') { 1 } else { 0 }); HasExited = $exited }
      $process | Add-Member ScriptMethod WaitForExit { return $true }
      $process
    }
    function Invoke-LocalUpdateWsl {
      param($distro, $arguments, $label, $seconds, $Invoke)
      if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
      if ($label -eq 'health') {
        $calls.health++
        if ($case -eq 'prestop-retry' -and $calls.health -eq 1) { throw 'health exhausted its WSL deadline' }
        if ($case -eq 'health-transient' -and $calls.health -eq 2) { throw 'One slow wsl call' }
        if ($case -eq 'desktop-exits' -and $calls.starts -eq 1) { $calls.crashedHealth++; return @{ healthy = $false; pid = 123 } }
        if (($case -like 'swap*' -or $case -eq 'no-db-rollback') -and $calls.starts -eq 1) { return @{ healthy = $false; pid = 123 } }
        return @{ healthy = ($case -notin @('runtime-recovery', 'runtime-recovery-late-exit') -or $calls.health -eq 1 -or $calls.starts -gt 0); pid = 123; environmentId = 'fixture' }
      }
      if ($label -eq 'stopped' -and ($case -in @('stopped-throws', 'recovering-save-fails') -or ($case.StartsWith('swap-') -and $calls.starts -gt 0))) { throw (New-LocalUpdateError "WSL distribution 'fixture' is unresponsive; refusing runtime operations. No probe answered.") }
      if ($label -eq 'stopped' -and $case -eq 'stopped-transient' -and ++$calls.stopped -eq 1) { throw (New-LocalUpdateError 'stopped exceeded 5s; captured helper stopped.' -Transient) }
      if ($label -eq 'notify') {
        $calls.notify = $arguments[-1]
        if ($case -eq 'stopped-transient') { throw 'notify exceeded 30s' }
      }
      if ($label -eq 'backup' -and $case -eq 'no-db-rollback') {
        $backupConfig = @{ wslHome = $fixtureHome; output = $fixture; wslBackupRoot = (Join-Path $fixture 'wsl-backup'); databaseBackup = $config.databaseBackup; installedReceipt = $config.installedReceipt; installedRuntimeArchive = $config.installedRuntimeArchive }
        $backupConfigFile = Join-Path $fixture 'backup-worker-config.json'
        $backupConfig | ConvertTo-Json | Set-Content $backupConfigFile
        $result = & $NodeExecutable $WorkerPath --worker backup $backupConfigFile | ConvertFrom-Json
        Assert ($LASTEXITCODE -eq 0) 'Rollback fixture backup worker failed'
        return $result
      }
      if ($label -eq 'capture-links') { throw 'No links in fixture' }
      return @{ installed = $true; backedUp = $true; stopped = $true; path = 'fixture-wsl-backup' }
    }
    if ($case -eq 'recovering-save-fails') {
      function Add-Content {
        param($LiteralPath, $Value, $ErrorAction)
        if ([string]$Value -match '"status":"recovering"') { throw 'WSL share write failed' }
        Microsoft.PowerShell.Management\Add-Content -LiteralPath $LiteralPath -Value $Value
      }
    }
    if ($case -eq 'swap-restore-blocked') {
      function Move-Item {
        param($LiteralPath, $Destination, [switch]$Force)
        if ($LiteralPath -eq $install -and $Destination -eq $payload) { throw 'Candidate files are in use' }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
      }
    }
    # swapx: the swap's own restore move fails once, leaving no install. m2: every restore move fails.
    # m2m3: the candidate put-back fails as well, so nothing can be installed.
    if ($case -in @('swapx-installmissing', 'swap-m2fail', 'swap-m2m3fail')) {
      function Move-Item {
        param($LiteralPath, $Destination, [switch]$Force)
        if ($LiteralPath -eq (Join-Path $rollback 'app') -and $Destination -eq $install -and ($case -ne 'swapx-installmissing' -or ++$calls.restores -eq 1)) { throw 'restore blocked' }
        if ($case -eq 'swap-m2m3fail' -and $LiteralPath -eq $payload -and $Destination -eq $install -and $calls.starts -gt 0) { throw 'put back blocked' }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
      }
    }
    # A reader left over from a failed launch must not block the recovery relaunch.
    $stdinHolder = $(if ($case -eq 'desktop-exits') { [IO.File]::Open((Join-Path $fixture 'weavewing-desktop-installed.stdin'), 'OpenOrCreate', 'Read', 'Read') })
    try {
      if ($case -eq 'prestop-retry') {
        Must-Fail { Invoke-LocalDesktopUpdate $configPath 'Activate' }
        Assert ((Get-Content -LiteralPath $configPath -Raw) -ceq $sealedConfig) 'Pre-stop failure changed the sealed configuration; retry would refuse it'
        Assert ($calls.closed -eq 0 -and $calls.starts -eq 0) 'Pre-stop failure touched the desktop'
        Invoke-LocalDesktopUpdate $configPath 'Activate'
      } elseif ($case -in @('no-db-rollback', 'installed-changed', 'stopped-throws', 'recovering-save-fails', 'close-late-exit') -or $case -like 'swap*' -or $case -in @('desktop-exits', 'runtime-no-desktop', 'runtime-recovery', 'runtime-recovery-late-exit')) { Must-Fail { Invoke-LocalDesktopUpdate $configPath 'Activate' } }
      else { Invoke-LocalDesktopUpdate $configPath 'Activate' }
    } finally {
      Set-Item Function:Invoke-LocalUpdateWsl $invokeWsl
      Remove-Item Function:Get-Process,Function:Start-Process,Function:Start-Sleep
      Remove-Item Function:Add-Content,Function:Move-Item -ErrorAction SilentlyContinue
      $env:TMP = $tmp
      if ($stdinHolder) { $stdinHolder.Dispose() }
    }
    Assert ((Get-Content -LiteralPath $configPath -Raw) -ceq $sealedConfig) 'Activation modified the sealed configuration'
    Assert (@($calls.launcherVariables | Where-Object { $_ -ne 'from launcher' }).Count -eq 0 -and -not $env:T3CODE_FIXTURE_LAUNCHER) 'Desktop launch did not scope the launcher variables to the desktop'
    $receipt = Get-Content (Join-Path $fixture 'receipt.json') -Raw | ConvertFrom-Json
    if ($case -eq 'no-db-rollback') {
      Assert ($null -ne $receipt.timeToCloseDesktopMilliseconds -and $null -ne $receipt.desktopDowntimeMilliseconds -and $null -ne $receipt.desktopCloseMilliseconds) 'Receipt lost separate desktop closure and downtime measurements'
      Assert ($receipt.installed -eq 'previous' -and $receipt.rollbackHealthy -and $calls.starts -eq 2) 'No-DB rollback did not restart the old build'
      Assert ($receipt.wslBackup.databaseBackup.ran -eq $false -and $receipt.wslBackup.databaseBackup.reason -eq 'migration-set-unchanged') 'No-DB rollback receipt lost backup decision'
      Assert (-not (Test-Path (Join-Path $receipt.wslBackup.path 'statev2.sqlite'))) 'No-DB rollback had a database copy'
      Assert ((Get-FileHash (Join-Path $fixtureHome 'userdata/statev2.sqlite') -Algorithm SHA256).Hash -eq $databaseHash) 'No-DB rollback changed the database'
    } elseif ($case -eq 'prestop-retry') {
      Assert ($receipt.status -eq 'verified' -and $calls.starts -eq 1) 'Retry after pre-stop failure did not activate successfully'
    } elseif ($case -eq 'installed-changed') {
      Assert ($receipt.status -eq 'failed' -and $receipt.error -match 'Installed content changed' -and $calls.starts -eq 0 -and $calls.closed -eq 0 -and $calls.operations.Count -eq 0) 'Changed install reached runtime operations'
    } elseif ($case -eq 'stopped-throws') {
      Assert ($receipt.status -eq 'failed' -and $calls.starts -eq 1 -and $receipt.rollbackHealthy) 'Stopped probe failure with an older rollback did not relaunch desktop'
      Assert (-not (Test-Path $backupRoot)) 'Failed update left a retry-blocking Windows backup'
      Assert (Test-Path (Join-Path $rollback 'app/previous')) 'Failure removed the existing rollback app'
      Assert (@(Get-ChildItem $rollback -Recurse -Filter 'saved').Count -eq 1) 'Failure lost the owned state backup'
      $statuses = @(Get-Content (Join-Path $fixture 'activation.log') | ForEach-Object { try { ($_ | ConvertFrom-Json).status } catch {} } | Where-Object { $_ })
      $recovering = [Array]::IndexOf($statuses, 'recovering')
      Assert ($recovering -gt [Array]::IndexOf($statuses, 'waiting-previous-runtime') -and $recovering -lt [Array]::LastIndexOf($statuses, 'failed')) 'Recovery kept showing the phase that failed'
      Assert ($receipt.notification.sent -and $calls.notify -match 'result: failed\. Commit fixture-commit\. Error: WSL distribution .fixture. is unresponsive') 'Failure notification lost its cause'
    } elseif ($case -eq 'recovering-save-fails') {
      Assert ($calls.starts -eq 1 -and $receipt.rollbackHealthy) 'A failed status write skipped the desktop relaunch'
      Assert ($receipt.status -eq 'failed' -and $receipt.statusError -match 'share write failed') 'Failed recovering save was not recorded'
    } elseif ($case -eq 'swap-close-throws') {
      Assert ($receipt.status -eq 'failed' -and $receipt.installed -eq 'previous' -and $calls.starts -eq 2 -and $receipt.rollbackHealthy) 'Swap rollback with a failed close left the desktop closed'
      Assert ((Get-Content (Join-Path $install 'Weavewing.exe')) -eq 'fixture-shell' -and (Get-Content (Join-Path $payload 'Weavewing.exe')) -eq 'new-shell') 'Failed close did not restore the previous app'
      $statuses = @(Get-Content (Join-Path $fixture 'activation.log') | ForEach-Object { try { ($_ | ConvertFrom-Json).status } catch {} } | Where-Object { $_ })
      Assert ([Array]::IndexOf($statuses, 'recovering') -gt [Array]::IndexOf($statuses, 'waiting-new-runtime')) 'Swap rollback kept showing waiting-new-runtime'
      Assert ($calls.notify -match 'Installed app: previous\. Relaunched app healthy: True\.') 'Notification did not say which app came back'
    } elseif ($case -eq 'swap-restore-blocked') {
      Assert ($receipt.status -eq 'failed' -and $receipt.installed -eq 'candidate' -and $receipt.restoreError -match 'in use') 'Blocked restore was not named'
      Assert ($calls.starts -eq 2 -and $receipt.rollbackHealthy -and (Get-Content (Join-Path $install 'Weavewing.exe')) -eq 'new-shell') 'Installed candidate was not relaunched'
      Assert ($calls.notify -match 'Installed app: candidate\.') 'Notification hid the installed candidate'
    } elseif ($case -eq 'swapx-installmissing') {
      Assert ($receipt.installed -eq 'previous' -and $calls.starts -eq 2 -and $receipt.rollbackHealthy) 'A missing install was not restored from the rollback'
      Assert ((Get-Content (Join-Path $install 'Weavewing.exe')) -eq 'fixture-shell' -and (Get-Content (Join-Path $payload 'Weavewing.exe')) -eq 'new-shell') 'Restore from a missing install lost a copy'
    } elseif ($case -eq 'swap-m2fail') {
      Assert ($receipt.installed -eq 'candidate' -and $receipt.restoreError -match 'restore blocked' -and $calls.starts -eq 2 -and $receipt.rollbackHealthy) 'Candidate was not put back and relaunched'
      Assert ((Get-Content (Join-Path $install 'Weavewing.exe')) -eq 'new-shell' -and (Get-Content (Join-Path $rollback 'app/Weavewing.exe')) -eq 'fixture-shell') 'Candidate put-back lost a copy'
    } elseif ($case -eq 'swap-m2m3fail') {
      Assert ($receipt.installed -eq 'none' -and $receipt.restoreError -match 'put back blocked' -and $receipt.recoveryError -match 'Nothing is installed' -and $calls.starts -eq 1) 'Missing install was misreported or launched'
      Assert ((Get-Content (Join-Path $payload 'Weavewing.exe')) -eq 'new-shell' -and (Get-Content (Join-Path $rollback 'app/Weavewing.exe')) -eq 'fixture-shell') 'Failed restore lost a copy'
      Assert ($calls.notify -match 'Installed app: none\.' -and $calls.notify -match 'Nothing is installed') 'Notification hid the missing install'
    } elseif ($case -eq 'stopped-transient') {
      Assert (@($receipt.helpers).Count -eq 50 -and $receipt.helperCount -ge 60) 'Receipt copied every helper record'
      Assert (-not (Select-String -Path (Join-Path $fixture 'activation.log') -Pattern '"helpers":' -SimpleMatch -Quiet)) 'Activation log repeated helper records'
      Assert ($receipt.status -eq 'verified' -and $calls.stopped -eq 2 -and $calls.starts -eq 1) 'One slow stopped probe failed the update'
      Assert ($receipt.notification.sent -eq $false -and $receipt.notification.error -match 'notify exceeded') 'Receipt did not record the failed notification'
    } elseif ($case -eq 'close-late-exit') {
      Assert ($receipt.status -eq 'failed' -and $receipt.closeRequested -and $calls.sleeps -ge 3) 'Late desktop exit was not awaited'
      Assert ($calls.starts -eq 1 -and $receipt.rollbackHealthy) 'Desktop that exited after the close deadline was not relaunched'
    } elseif ($case -eq 'desktop-exits') {
      $launch = @($receipt.desktopLaunches)[0]
      Assert ($receipt.status -eq 'failed' -and $receipt.error -match 'exited with code 1' -and $calls.crashedHealth -le 1) 'Exited desktop did not fail the update before the health deadline'
      Assert ($launch.exitCode -eq 1 -and $launch.stdoutTail.EndsWith("ready $([char]0x2026)")) 'Receipt lost the exited desktop output'
      Assert ($calls.starts -eq 2 -and $receipt.rollbackHealthy -and (Get-Content (Join-Path $install 'Weavewing.exe')) -eq 'fixture-shell') 'Exited desktop did not restore and relaunch the previous app'
    } elseif ($case -eq 'desktop-handoff') {
      Assert ($receipt.status -eq 'verified' -and @($receipt.desktopLaunches)[0].handedOff -and $calls.starts -eq 1) 'Single-instance hand-off rolled back a healthy update'
    } elseif ($case -eq 'health-transient') {
      Assert ($receipt.status -eq 'verified') 'One transient health probe rolled back a healthy update'
    } elseif ($case -eq 'runtime-no-desktop') {
      Assert ($calls.operations -notcontains 'stop-runtime') 'Runtime stopped without a desktop supervisor'
    } else {
      Assert ($calls.operations -contains 'backup') 'Runtime update skipped the WSL backup'
      Assert ([Array]::IndexOf($calls.operations, 'backup') -lt [Array]::IndexOf($calls.operations, 'stop-runtime')) 'Runtime backup ran after stop'
      Assert ($calls.operations -notcontains 'backup-windows') 'Runtime update backed up unused Windows state'
      if ($case -in @('runtime-recovery', 'runtime-recovery-late-exit')) {
        if ($case -eq 'runtime-recovery-late-exit') { Assert ($receipt.closeError -and $calls.sleeps -ge 3) 'Late desktop exit was not awaited during runtime recovery' }
        Assert ($calls.closed -eq 1 -and $calls.starts -eq 1 -and $receipt.rollbackHealthy) 'Unhealthy runtime recovery did not restart desktop'
        Assert ((Get-Content (Join-Path $client 'index.html')) -eq 'old-client') 'Runtime recovery kept the failed client'
        Assert (-not (Test-Path (Join-Path $client '.shell-version')) -and @(Get-ChildItem $resources -Filter 'client-*').Count -eq 0) 'Runtime recovery left failed or scratch client files'
      } else {
        Assert ($receipt.status -eq 'verified' -and $receipt.reloadPending -and $receipt.reloadHint -match 'Ctrl\+Shift\+R') 'Healthy runtime update did not record the pending reload'
        Assert ((Get-Content (Join-Path $client 'index.html')) -eq 'new-client') 'Runtime update kept the old client'
        Assert ((Get-Content (Join-Path $client '.shell-version')) -eq '1.2.3') 'Runtime update dropped the shell marker'
        Assert ((Get-Content (Join-Path $client 'old-chunk.js')) -eq 'old-chunk') 'Runtime update deleted a chunk the open page still needs'
        Assert ((Get-Content (Join-Path $client 'assets/old-chunk.js')) -eq 'old-nested' -and (Get-Content (Join-Path $client 'assets/shared.js')) -eq 'new-shared' -and (Get-Content (Join-Path $client 'assets/new-chunk.js')) -eq 'new-nested') 'Runtime update did not merge nested client assets'
        Assert (@(Get-ChildItem $resources -Filter 'client-*').Count -eq 0) 'Runtime update left client scratch directories'
        Assert ((Get-Content (Join-Path $install '.weavewing-local-update.json') -Raw | ConvertFrom-Json).clientCommit -eq 'client-head') 'Runtime receipt lost client provenance'
      }
    }
    Write-Host "PASS case: activation-$case"
  }
  $fixture = Join-Path $root 'prepare-only-runtime'
  $install = Join-Path $fixture 'installed'
  $resources = Join-Path $install 'resources'
  New-Item -ItemType Directory -Path $resources | Out-Null
  Set-Content (Join-Path $resources 'wsl-runtime.tar.gz') 'old-archive'
  Set-Content (Join-Path $resources 'wsl-runtime.tar.gz.sha256') 'old-digest'
  Set-Content (Join-Path $install 'Weavewing.exe') 'fixture-shell'
  $archive = Join-Path $fixture 'candidate.tar.gz'
  Set-Content $archive 'new-archive'
  Copy-Item (Join-Path $PSScriptRoot 'stage-windows-desktop.ps1') (Join-Path $fixture 'stage-windows-desktop.ps1')
  $configPath = Join-Path $fixture 'config.json'
  @{ install = $install; updatePath = 'wsl-only'; archive = $archive; digest = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content $configPath
  $invokeWsl = (Get-Item Function:Invoke-LocalUpdateWsl).ScriptBlock
  $calls = @{ operations = @() }
  function Invoke-LocalUpdateWsl {
    param($distro, $arguments, $label, $seconds, $Invoke)
    if ($label -eq 'validate-prepared') { return @{ verified = $true } }
    $calls.operations += $label
    if ($label -eq 'health') { return @{ healthy = $true; pid = 123; environmentId = 'fixture' } }
    if ($label -eq 'install-runtime') { return @{ installed = $true } }
    if ($label -eq 'backup') { return @{ backedUp = $true } }
    throw "Preparation attempted forbidden operation: $label"
  }
  try { Invoke-LocalDesktopUpdate $configPath 'Prepare' }
  finally { Set-Item Function:Invoke-LocalUpdateWsl $invokeWsl }
  $receipt = Get-Content (Join-Path $fixture 'receipt.json') -Raw | ConvertFrom-Json
  Assert ($receipt.status -eq 'staged-and-verified') 'Runtime preparation did not complete'
  Assert ($calls.operations.Count -eq 0) 'Preparation touched the installed runtime or state'
  Write-Host 'PASS case: prepare-only-runtime'
  Assert ((Get-Content (Join-Path $resources 'wsl-runtime.tar.gz')) -eq 'old-archive') 'Preparation replaced the installed runtime selection'

  $fixtureHome = Join-Path $root 'home'
  $userdata = Join-Path $fixtureHome 'userdata'
  New-Item -ItemType Directory -Path $userdata | Out-Null
  $configPath = Join-Path $root 'backup-config.json'
  @{ wslHome = $fixtureHome; output = $root; backupRoot = $root; wslBackupRoot = $root } | ConvertTo-Json | Set-Content $configPath
  $fixtureScript = Join-Path $root 'backup-fixture.mjs'
  @'
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, worker, config] = process.argv.slice(2);
const db = new DatabaseSync(path.join(root, 'statev2.sqlite'));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('preserved')");
const reader = new DatabaseSync(path.join(root, 'statev2.sqlite'), {readOnly: true});
reader.exec('BEGIN');
reader.prepare('SELECT value FROM saved').get();
db.exec("UPDATE saved SET value = 'writer committed'");
if (reader.prepare('SELECT value FROM saved').get().value !== 'preserved') throw new Error('Read snapshot changed');
db.exec("UPDATE saved SET value = 'preserved'");
reader.close();
db.close();
// A locked ownership database made the manual updater's backup retry forever.
const lock = new DatabaseSync(path.join(root, 'server-owner.sqlite'));
lock.exec('CREATE TABLE owner(id); BEGIN EXCLUSIVE');
fs.writeFileSync(path.join(root, 'settings.json'), '{"saved":true}');
fs.mkdirSync(path.join(root, 'secrets'));
fs.writeFileSync(path.join(root, 'secrets', 'fixture'), 'secret');
fs.mkdirSync(path.join(root, 'thread-workspaces'));
fs.writeFileSync(path.join(root, 'thread-workspaces', 'fixture'), 'workspace');
process.argv = [process.execPath, worker, '--worker', 'backup', config];
await import(pathToFileURL(worker).href);
const snapshot = new DatabaseSync(path.join(path.dirname(root), '..', 'backup-wsl', 'statev2.sqlite'), {readOnly: true});
if (snapshot.prepare('SELECT value FROM saved').get().value !== 'preserved') throw new Error('Snapshot lost data');
snapshot.close();
lock.close();
'@ | Set-Content $fixtureScript
  & $NodeExecutable $fixtureScript $userdata $WorkerPath $configPath
  Assert ($LASTEXITCODE -eq 0) 'State backup worker failed'
  $backup = Join-Path $root 'backup-wsl'
  Assert (Test-Path (Join-Path $backup 'statev2.sqlite')) 'State snapshot missing'
  Assert ((Get-Content (Join-Path $backup 'secrets/fixture')) -eq 'secret') 'Secrets missing'
  Assert ((Get-Content (Join-Path $backup 'thread-workspaces/fixture')) -eq 'workspace') 'Workspace missing'
  Assert (-not (Test-Path (Join-Path $backup 'server-owner.sqlite'))) 'Ownership lock entered backup'
  $installedArchive = Join-Path $root 'installed-runtime.tar.gz'
  Set-Content $installedArchive 'installed-runtime'
  $installedReceipt = Join-Path $root 'installed-receipt.json'
  $installedDigest = (Get-FileHash $installedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  foreach ($ledgerCase in @('older-db', 'newer-db', 'renamed-db', 'unreadable-db', 'missing-ledger', 'digest-mismatch', 'missing-receipt', 'receipt-commit-mismatch', 'missing-reader', 'matching-db')) {
    $ledgerRoot = Join-Path $root $ledgerCase
    $ledgerHome = Join-Path $ledgerRoot 'home'
    $ledgerUserdata = Join-Path $ledgerHome 'userdata'
    New-Item -ItemType Directory -Path $ledgerUserdata -Force | Out-Null
    & $NodeExecutable $ledgerScript (Join-Path $ledgerUserdata 'statev2.sqlite') $WorkerPath $ledgerCase
    Assert ($LASTEXITCODE -eq 0) 'Ledger fixture setup failed'
    $ledgerDatabaseHash = (Get-FileHash (Join-Path $ledgerUserdata 'statev2.sqlite') -Algorithm SHA256).Hash
    @{ commit = $(if ($ledgerCase -eq 'receipt-commit-mismatch') { 'other-commit' } else { 'installed-commit' }); digest = $(if ($ledgerCase -eq 'digest-mismatch') { 'wrong' } else { $installedDigest }) } | ConvertTo-Json | Set-Content $installedReceipt
    if ($ledgerCase -eq 'missing-receipt') { Remove-Item $installedReceipt }
    $ledgerConfig = @{ wslHome = $ledgerHome; output = $root; wslBackupRoot = $ledgerRoot; installedReceipt = $installedReceipt; installedRuntimeArchive = $installedArchive; databaseBackup = @{ required = $false; reason = 'migration-set-unchanged'; installedCommit = 'installed-commit' } }
    $ledgerConfig | ConvertTo-Json -Depth 5 | Set-Content $configPath
    $ledgerWorker = $WorkerPath
    if ($ledgerCase -eq 'missing-reader') {
      $ledgerWorker = Join-Path $ledgerRoot 'worker.mjs'
      Copy-Item $WorkerPath $ledgerWorker
    }
    try {
      $ErrorActionPreference = 'Continue'
      & $NodeExecutable $ledgerWorker --worker backup $configPath 2> (Join-Path $ledgerRoot 'backup.stderr') | Set-Content (Join-Path $ledgerRoot 'result.json')
      $ledgerCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
    Assert ((Get-FileHash (Join-Path $ledgerUserdata 'statev2.sqlite') -Algorithm SHA256).Hash -eq $ledgerDatabaseHash) 'Migration probe modified the live database'
    if ($ledgerCase -eq 'unreadable-db') {
      Assert ($ledgerCode -ne 0 -and -not (Test-Path (Join-Path $ledgerRoot 'backup-wsl'))) 'Unreadable database did not fail safely'
      Write-Host "PASS case: live-ledger-$ledgerCase"
      continue
    }
    Assert ($ledgerCode -eq 0) "Ledger backup failed: $ledgerCase"
    $ledgerResult = Get-Content (Join-Path $ledgerRoot 'result.json') -Raw | ConvertFrom-Json
    $shouldCopy = $ledgerCase -ne 'matching-db'
    Assert ($ledgerResult.databaseBackup.ran -eq $shouldCopy) "Unsafe database-copy decision: $ledgerCase"
    $expectedReason = switch ($ledgerCase) {
      { $_ -in @('digest-mismatch', 'missing-receipt', 'receipt-commit-mismatch') } { 'installed-runtime-unverified' }
      'missing-reader' { 'database-migrations-unavailable' }
      'matching-db' { 'migration-set-unchanged' }
      'older-db' { 'destructive-migrations' }
      'missing-ledger' { 'destructive-migrations' }
      default { 'database-migrations-differ' }
    }
    Assert ($ledgerResult.databaseBackup.reason -eq $expectedReason) "Wrong database-copy reason: $ledgerCase"
    Assert ((Test-Path (Join-Path $ledgerRoot 'backup-wsl/statev2.sqlite')) -eq $shouldCopy) "Database snapshot disagrees with receipt: $ledgerCase"
    Write-Host "PASS case: live-ledger-$ledgerCase"
  }
  & $NodeExecutable $ledgerScript (Join-Path $userdata 'ledger.sqlite') $WorkerPath 'matching-db'
  Assert ($LASTEXITCODE -eq 0) 'Skip fixture setup failed'
  Move-Item (Join-Path $userdata 'ledger.sqlite') (Join-Path $userdata 'statev2.sqlite') -Force
  @{ commit = 'installed-commit'; digest = $installedDigest } | ConvertTo-Json | Set-Content $installedReceipt
  $skipRoot = Join-Path $root 'skip-state'
  New-Item -ItemType Directory -Path $skipRoot | Out-Null
  @{ wslHome = $fixtureHome; output = $root; wslBackupRoot = $skipRoot; backupTimeoutMs = 0; installedReceipt = $installedReceipt; installedRuntimeArchive = $installedArchive; databaseBackup = @{ required = $false; reason = 'migration-set-unchanged'; installedCommit = 'installed-commit' } } | ConvertTo-Json | Set-Content $configPath
  & $NodeExecutable $WorkerPath --worker backup $configPath | Set-Content (Join-Path $root 'skip-result.json')
  Assert ($LASTEXITCODE -eq 0) 'No-migration backup attempted a database snapshot'
  $skipResult = Get-Content (Join-Path $root 'skip-result.json') -Raw | ConvertFrom-Json
  Assert (-not $skipResult.databaseBackup.ran -and $skipResult.databaseBackup.reason -eq 'migration-set-unchanged') 'Skipped database backup lost its reason'
  Assert (-not (Test-Path (Join-Path $skipRoot 'backup-wsl/statev2.sqlite'))) 'No-migration backup copied the database'
  foreach ($file in @('settings.json', 'secrets/fixture', 'thread-workspaces/fixture')) {
    Assert (Test-Path (Join-Path $skipRoot ('backup-wsl/' + $file))) "Small state missing without DB backup: $file"
  }
  Write-Host 'PASS case: no-migration-small-state-backup'
  $failureRoot = Join-Path $root 'failure'
  New-Item -ItemType Directory -Path $failureRoot | Out-Null
  @{ wslHome = $fixtureHome; output = $root; backupRoot = $failureRoot; wslBackupRoot = $failureRoot; backupTimeoutMs = 0 } | ConvertTo-Json | Set-Content $configPath
  try {
    $ErrorActionPreference = 'Continue'
    & $NodeExecutable $WorkerPath --worker backup $configPath 2> (Join-Path $root 'timeout.stderr')
    $failureCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = 'Stop' }
  Assert ($failureCode -ne 0) 'Expired snapshot budget succeeded'
  Assert (-not (Test-Path (Join-Path $failureRoot 'backup-wsl'))) 'Timeout left a partial snapshot'
  Assert ((Get-Content (Join-Path $root 'timeout.stderr') -Raw) -match 'timed out') 'Timeout did not explain its failure'
  foreach ($helper in Get-ChildItem (Join-Path $root 'helpers') -Filter '*.json') {
    $record = Get-Content $helper.FullName -Raw | ConvertFrom-Json
    Assert (-not (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) 'Snapshot helper remained running after completion or timeout'
  }
  Assert (Test-Path (Join-Path $userdata 'statev2.sqlite')) 'Timeout removed source state'
  'PASS: runtime selection rollback, responsiveness guard, runtime prepare-only, early failure receipts, bounded link checks, swap and rollback, refused close, read-only snapshot excluding ownership lock, timeout cleanup and captured helper exit'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

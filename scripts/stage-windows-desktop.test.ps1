$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stage-windows-desktop.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Must-Refuse($action) {
  $refused = $false
  try { & $action } catch { $refused = $true }
  Assert $refused 'Expected refusal'
}
try {
  $source = Join-Path $root 'payload'
  $install = Join-Path $root 'installed'
  $candidate = Join-Path $root '.installed-candidate'
  New-Item -ItemType Directory $source,$install -Force | Out-Null
  Set-Content (Join-Path $source 'Weavewing.exe') 'new'
  Set-Content (Join-Path $install 'keep') 'installed'
  Set-Content (Join-Path $install 'Weavewing.exe') 'installed'
  Assert ((Get-StageFreeBytes $root) -gt 0) 'Windows volume free-space query failed'
  function Get-StageFreeBytes($directory) { return 0 }
  Must-Refuse { Stage-WindowsDesktop $source $install }
  Assert (-not (Test-Path $candidate)) 'Low space created candidate'
  function Get-StageFreeBytes($directory) { return 1TB }
  Stage-WindowsDesktop $install $install -CheckOnly
  Must-Refuse { Stage-WindowsDesktop $install $install }
  Stage-WindowsDesktop $source $install -CheckOnly
  Assert (-not (Test-Path $candidate)) 'CheckOnly created candidate'
  Stage-WindowsDesktop $source $install | Out-Null
  Set-Content (Join-Path $candidate 'payload/obsolete') 'old'
  function Get-StageFreeBytes($directory) { return 0 }
  Must-Refuse { Stage-WindowsDesktop $source $install }
  Assert (Test-Path (Join-Path $candidate 'payload/obsolete')) 'Low space changed candidate'
  function Get-StageFreeBytes($directory) { return 1TB }
  function Copy-Item { throw 'Fixture copy failure' }
  try { Must-Refuse { Stage-WindowsDesktop $source $install } } finally { Remove-Item Function:Copy-Item }
  Assert (Test-Path (Join-Path $candidate 'payload/obsolete')) 'Copy failure changed candidate'
  Stage-WindowsDesktop $source $install | Out-Null
  Assert (-not (Test-Path (Join-Path $candidate 'payload/obsolete'))) 'Second stage merged stale payload'
  Assert ((Get-ChildItem $root -Directory).Count -eq 3) 'Staging grew extra slots'
  Assert ((Get-Content (Join-Path $install 'keep')) -eq 'installed') 'Install changed'
  foreach ($relative in @('.git', '.t3', 'userdata', 'user-data', 'state.sqlite', 'state.db', 'turn.jsonl', 'trace.ndjson', 'build.log')) {
    foreach ($directory in @($source, (Join-Path $candidate 'payload'))) {
      $protected = Join-Path $directory $relative
      if ($relative -in @('.git', '.t3', 'userdata', 'user-data')) { New-Item -ItemType Directory $protected | Out-Null } else { Set-Content $protected 'evidence' }
      Must-Refuse { Stage-WindowsDesktop $source $install }
      Assert (Test-Path $protected) 'Protected content removed'
      Remove-Item $protected -Recurse -Force
    }
  }
  function Get-StageProcessPaths { Join-Path $candidate 'payload/Weavewing.exe' }
  try { Must-Refuse { Stage-WindowsDesktop $source $install } } finally { Remove-Item Function:Get-StageProcessPaths }
  $prepared = Join-Path $root '.installed-prepared-0123456789abcdef'
  Stage-WindowsDesktop $source $install -CandidateDirectory $prepared | Out-Null
  Assert (Test-Path (Join-Path $candidate 'payload/Weavewing.exe')) 'Preparation overwrote the existing candidate slot'
  Assert ((Get-Content (Join-Path $prepared 'payload/Weavewing.exe')) -eq 'new') 'Prepared sibling payload missing'
  Must-Refuse { Stage-WindowsDesktop $source $install -CandidateDirectory (Join-Path $root 'unowned') }
  Must-Refuse { Stage-WindowsDesktop $source $install -CandidateDirectory (Join-Path $install '.installed-prepared-0123456789abcdef') }
  Remove-Item $prepared -Recurse -Force
  Remove-Item (Join-Path $install 'Weavewing.exe')
  Must-Refuse { Stage-WindowsDesktop $source $install }
  Set-Content (Join-Path $install 'Weavewing.exe') 'installed'
  Remove-Item $candidate -Recurse -Force
  New-Item -ItemType Directory $candidate | Out-Null
  Set-Content (Join-Path $candidate 'keep') 'unowned'
  Must-Refuse { Stage-WindowsDesktop $source $install }
  Assert ((Get-Content (Join-Path $candidate 'keep')) -eq 'unowned') 'Unowned candidate changed'
  'PASS: low space preserves slots; repeat staging bounded; install and unowned paths preserved'
} finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }

param([string]$Source, [string]$InstallDirectory, [switch]$CheckOnly, [string]$CandidateDirectory)
$ErrorActionPreference = 'Stop'

function Get-StageFreeBytes($directory) {
  return ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($directory))).AvailableFreeSpace
}
function Get-StageProcessPaths { Get-Process | ForEach-Object { $_.Path } }
function Assert-StageContent($entries) {
  if ($entries | Where-Object { $_.Name -in @('.git', '.t3', 'userdata', 'user-data') -or $_.Extension -in @('.sqlite', '.db', '.jsonl', '.ndjson', '.log') }) {
    throw 'Payload contains private state or evidence; inspect it manually.'
  }
}

function Stage-WindowsDesktop([string]$source, [string]$install, [switch]$CheckOnly, [string]$CandidateDirectory) {
  if (-not $source -or -not $install) { throw 'Supply Source and InstallDirectory.' }
  $source = (Get-Item -LiteralPath $source).FullName.TrimEnd('\')
  $install = (Get-Item -LiteralPath $install).FullName.TrimEnd('\')
  if (-not (Test-Path -LiteralPath $install -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $install 'Weavewing.exe') -PathType Leaf)) { throw 'InstallDirectory must contain an existing Weavewing installation.' }
  if ($install -notmatch '^[A-Za-z]:\\') { throw 'InstallDirectory must be on a local Windows drive.' }
  $parent = Split-Path $install
  $candidate = Join-Path $parent ('.' + (Split-Path $install -Leaf) + '-candidate')
  if ($CandidateDirectory) {
    if ((Split-Path $CandidateDirectory) -ne $parent -or (Split-Path $CandidateDirectory -Leaf) -notmatch ('^\.' + [regex]::Escape((Split-Path $install -Leaf)) + '-prepared-[0-9a-f]{16}$')) { throw 'CandidateDirectory must be a prepared sibling slot.' }
    $candidate = $CandidateDirectory
  }
  foreach ($path in @($install, $candidate)) {
    if (-not $CheckOnly -and ($source -eq $path -or $source.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase))) {
      throw 'Source must be separate from installation and candidate.'
    }
  }
  $ancestor = $parent
  while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Destination ancestors must not be links or mount points.' }
    $ancestor = Split-Path $ancestor
  }
  $marker = Join-Path $candidate '.weavewing-stage-owner'
  if (Test-Path -LiteralPath $candidate) {
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $install) { throw 'Candidate is unowned; inspect it manually.' }
    $entries = @(Get-Item -LiteralPath $candidate) + @(Get-ChildItem -LiteralPath $candidate -Recurse -Force)
    Assert-StageContent $entries
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Candidate contains a link; refusing changes.' }
    if (Get-StageProcessPaths | Where-Object { $_ -and $_.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase) }) { throw 'Candidate has a running executable; close it before staging.' }
  }
  $files = @(Get-Item -LiteralPath $source -Force) + @(Get-ChildItem -LiteralPath $source -Recurse -Force)
  Assert-StageContent $files
  if ($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Source contains links.' }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'Weavewing.exe') -PathType Leaf)) { throw 'Source must contain Weavewing.exe.' }
  $bytes = ($files | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum
  if ((Get-StageFreeBytes $parent) -lt ($bytes + 20GB)) { throw 'Staging requires incoming payload bytes plus 20 GiB free on the destination Windows volume.' }
  if ($CheckOnly) { return }
  New-Item -ItemType Directory -Path $candidate -Force | Out-Null
  Set-Content -LiteralPath $marker -Value $install
  $incoming = Join-Path $candidate 'incoming'
  $payload = Join-Path $candidate 'payload'
  $previous = Join-Path $candidate 'previous'
  if (Test-Path -LiteralPath $previous) { throw 'Interrupted promotion: inspect previous before staging again.' }
  try {
    if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $incoming -Recurse -Force
    if (Test-Path -LiteralPath $payload) { Move-Item -LiteralPath $payload -Destination $previous }
    try { Move-Item -LiteralPath $incoming -Destination $payload } catch {
      if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $payload }
      throw
    }
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
  } finally {
    if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force }
  }
  $payload
}

if ($MyInvocation.InvocationName -ne '.') { Stage-WindowsDesktop $Source $InstallDirectory -CheckOnly:$CheckOnly -CandidateDirectory $CandidateDirectory }

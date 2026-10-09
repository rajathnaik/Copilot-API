# One-click launcher: signs in to GitHub Copilot if needed, (re)builds the
# server and desktop bundles when sources changed, enables "Start server on
# launch", and opens the Copilot API desktop app, which starts the gateway.
$ErrorActionPreference = 'Stop'

$workspace = $PSScriptRoot
$root = Join-Path $workspace 'apps\gateway'
$desktop = Join-Path $root 'desktop'
$shared = Join-Path $workspace 'packages\shared\src'
$dataDir = Join-Path $env:USERPROFILE '.local\share\copilot-api'
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
$env:PATH = "$(Split-Path $bun);$env:PATH"

function Test-Stale([string]$output, [string[]]$sources) {
  if (-not (Test-Path $output)) { return $true }
  $built = (Get-Item $output).LastWriteTime
  $newer = Get-ChildItem $sources -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object LastWriteTime -gt $built | Select-Object -First 1
  return [bool]$newer
}

function Invoke-Bun([string]$dir, [string[]]$bunArgs) {
  Push-Location $dir
  try {
    & $bun @bunArgs
    if ($LASTEXITCODE -ne 0) { throw "bun $($bunArgs -join ' ') failed in $dir" }
  } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $workspace 'node_modules'))) { Invoke-Bun $workspace @('install') }

$tokenFile = Join-Path $dataDir 'github_token'
if (-not (Test-Path $tokenFile) -or (Get-Item $tokenFile).Length -eq 0) {
  Write-Host 'No saved GitHub login found. Starting GitHub Copilot sign-in...'
  Invoke-Bun $root @('./src/main.ts', 'auth', 'login', '--provider', 'copilot')
}

if (Test-Stale (Join-Path $root 'dist\main.js') @((Join-Path $root 'src'), $shared)) {
  Write-Host 'Building server bundle...'
  Invoke-Bun $root @('run', 'build:desktop')
}
$desktopBuilt = (Test-Path (Join-Path $desktop 'out\renderer\index.html')) -and
  -not (Test-Stale (Join-Path $desktop 'out\main\index.js') @((Join-Path $desktop 'electron'), (Join-Path $desktop 'src'), $shared))
if (-not $desktopBuilt) {
  Write-Host 'Building desktop app...'
  Invoke-Bun $desktop @('run', 'build')
}

$settingsFile = Join-Path $dataDir 'desktop-config.json'
$settings = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$settings | Add-Member -NotePropertyName autoStartServer -NotePropertyValue $true -Force
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
[IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

Invoke-Bun $workspace @('scripts/ensure-electron.mjs')
$electron = & $bun -e 'console.log(require("electron"))'
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the workspace Electron runtime.' }

$listener = Get-NetTCPConnection -LocalPort 4141 -State Listen -ErrorAction SilentlyContinue
if ($listener -and -not (Get-Process electron -ErrorAction SilentlyContinue)) {
  Write-Warning 'Port 4141 is already in use by another process; the app will not be able to start its server on that port.'
}

Start-Process -FilePath $electron -ArgumentList "`"$desktop`"" -WorkingDirectory $desktop
Write-Host 'Copilot API desktop app launched; it will start the server on http://localhost:4141.'

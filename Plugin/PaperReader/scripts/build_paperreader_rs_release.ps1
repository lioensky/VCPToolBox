[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$rustRoot = Join-Path $pluginRoot "paperreader-rs"
$binDir = Join-Path $pluginRoot "bin"

$srcExe = Join-Path $rustRoot "target\\release\\paperreader-cli.exe"
$dstExe = Join-Path $binDir "paperreader-cli.exe"

Write-Host "[PaperReader] Building paperreader-cli (release)..."
Push-Location $rustRoot
try {
  cargo build -p paperreader-cli --release
} finally {
  Pop-Location
}

if (-not (Test-Path $binDir)) {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
}

if (-not (Test-Path $srcExe)) {
  throw "Expected release binary not found: $srcExe"
}

Copy-Item -Force $srcExe $dstExe

$manifestPath = Join-Path $pluginRoot "plugin-manifest.json"
if (Test-Path $manifestPath) {
  try {
    $manifestJson = Get-Content -Raw -Encoding UTF8 $manifestPath
    try {
      # PowerShell 7+ supports -Depth, Windows PowerShell 5.1 does not.
      $manifest = $manifestJson | ConvertFrom-Json -Depth 32
    } catch {
      $manifest = $manifestJson | ConvertFrom-Json
    }
    $expectedCommand = "bin\paperreader-cli.exe"
    if ($manifest.entryPoint.command -ne $expectedCommand) {
      Write-Warning ("plugin-manifest.json entryPoint.command is '{0}', expected '{1}'" -f $manifest.entryPoint.command, $expectedCommand)
    }
  } catch {
    Write-Warning "Failed to parse plugin-manifest.json for a quick sanity check."
  }
}

Write-Host ("[PaperReader] Updated: {0}" -f $dstExe)
(Get-Item $dstExe | Select-Object FullName,Length,LastWriteTime) | Format-List

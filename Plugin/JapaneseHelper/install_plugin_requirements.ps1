param(
  [ValidateSet("host","docker","auto")]
  [string]$Mode = "auto",
  [string]$PythonExe = "python",
  [string]$DockerContainerId = "",
  [string]$TargetPath = "",
  [switch]$BreakSystemPackages = $true,
  [switch]$UseTsinghuaMirror = $true,
  [switch]$UpgradePip = $true
)

$ErrorActionPreference = "Stop"

function Write-Info($msg) {
  Write-Host "[JapaneseHelper Installer] $msg" -ForegroundColor Cyan
}

function Assert-FileExists($path) {
  if (!(Test-Path -LiteralPath $path)) {
    throw "File not found: $path"
  }
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$ReqFile = Join-Path $ScriptDir "requirements.txt"
Assert-FileExists $ReqFile
Write-Info "requirements: $ReqFile"

if ($Mode -eq "auto") {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $cid = ""
    try { $cid = docker ps -q | Select-Object -First 1 } catch {}
    if ($cid) {
      $Mode = "docker"
      $DockerContainerId = $cid
    } else {
      $Mode = "host"
    }
  } else {
    $Mode = "host"
  }
  Write-Info "auto resolved mode: $Mode"
}

if ($Mode -eq "docker") {
  if (-not $DockerContainerId) {
    $DockerContainerId = docker ps -q | Select-Object -First 1
  }
  if (-not $DockerContainerId) {
    throw "No running container found. Start one or pass -DockerContainerId."
  }

  $mirrorArg = ""
  if ($UseTsinghuaMirror) {
    $mirrorArg = " -i https://pypi.tuna.tsinghua.edu.cn/simple"
  }

  $pipBase = "python3 -m pip install"
  if ($BreakSystemPackages) {
    $pipBase += " --break-system-packages"
  }

  Write-Info "docker target: $DockerContainerId"

  if ($UpgradePip) {
    $cmdUp = "$pipBase -U pip setuptools wheel$mirrorArg"
    docker exec $DockerContainerId sh -lc $cmdUp
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed in container" }
  }

  # 避免依赖容器内固定路径：将宿主 requirements.txt 复制到容器临时目录再安装
  $tmpReq = "/tmp/JapaneseHelper.requirements.txt"
  docker cp "$ReqFile" "${DockerContainerId}:$tmpReq"
  if ($LASTEXITCODE -ne 0) { throw "failed to copy requirements.txt into container" }

  $cmdInstall = "$pipBase -r $tmpReq$mirrorArg"
  docker exec $DockerContainerId sh -lc $cmdInstall
  if ($LASTEXITCODE -ne 0) { throw "requirements install failed in container" }

  Write-Info "docker mode install done."
  exit 0
}

if (!(Get-Command $PythonExe -ErrorAction SilentlyContinue)) {
  throw "Python executable not found: $PythonExe"
}

if ($UpgradePip) {
  $upList = @("-m","pip","install")
  if ($BreakSystemPackages) { $upList += "--break-system-packages" }
  $upList += @("-U","pip","setuptools","wheel")
  if ($UseTsinghuaMirror) {
    $upList += @("-i","https://pypi.tuna.tsinghua.edu.cn/simple")
  }

  Write-Info "upgrading pip/setuptools/wheel..."
  & $PythonExe @upList
  if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed on host" }
}

$argList = @("-m","pip","install")
if ($BreakSystemPackages) { $argList += "--break-system-packages" }
if ($TargetPath) {
  if (!(Test-Path -LiteralPath $TargetPath)) {
    New-Item -ItemType Directory -Path $TargetPath | Out-Null
  }
  $argList += @("--target",$TargetPath)
}
$argList += @("-r",$ReqFile)
if ($UseTsinghuaMirror) {
  $argList += @("-i","https://pypi.tuna.tsinghua.edu.cn/simple")
}

Write-Info "host mode install start..."
& $PythonExe @argList
if ($LASTEXITCODE -ne 0) { throw "requirements install failed on host" }

Write-Info "host mode install done."
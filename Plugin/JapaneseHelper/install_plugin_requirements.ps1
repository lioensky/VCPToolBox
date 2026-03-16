param([ValidateSet("host","docker","auto")]
  [string]$Mode = "auto",
  [string]$PythonExe = "python",
  [string]$DockerContainerId = "",
  [string]$TargetPath = "",
  [switch]$BreakSystemPackages = $true,
  [switch]$UseTsinghuaMirror = $true,
  [switch]$UpgradePip = $true,
  [switch]$NoMeCab = $true,
  [switch]$PreferBinary = $true,
  [switch]$RunQuickCheck = $true,
  [switch]$InstallCompileToolchain = $true
)

$ErrorActionPreference = "Stop"

function Write-Info($msg) {
  Write-Host "[JapaneseHelper Installer] $msg" -ForegroundColor Cyan
}

function Write-Warn($msg) {
  Write-Host "[JapaneseHelper Installer] $msg" -ForegroundColor Yellow
}

function Assert-FileExists($path) {
  if (!(Test-Path -LiteralPath $path)) {
    throw "File not found: $path"
  }
}

function Get-PreferredContainerId {
  $cid = ""
  try { $cid = docker ps -q --filter "name=vcptoolbox" | Select-Object -First 1 } catch {}
  if (-not $cid) {
    try { $cid = docker ps -q | Select-Object -First 1 } catch {}
  }
  return $cid
}

function Get-DockerPythonCmd([string]$cid) {
  foreach ($c in @("python3","python")) {
    try {
      docker exec $cid sh -lc "$c --version >/dev/null 2>&1"
      if ($LASTEXITCODE -eq 0) { return $c }
    } catch {}
  }
  throw "No python executable found in container ($cid)."
}

function Test-DockerCommand([string]$cid, [string]$cmd) {
  try {
    docker exec $cid sh -lc "command -v $cmd >/dev/null 2>&1"
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Get-DockerPackageManager([string]$cid) {
  foreach ($pm in @("apk","apt-get","dnf","microdnf","yum")) {
    if (Test-DockerCommand -cid $cid -cmd $pm) { return $pm }
  }
  return ""
}

function Test-DockerPythonPip([string]$cid, [string]$pythonCmd) {
  try {
    docker exec $cid sh -lc "$pythonCmd -m pip --version >/dev/null 2>&1"
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Test-DockerApkPackageInstalled([string]$cid, [string]$pkg) {
  try {
    docker exec $cid sh -lc "apk info -e $pkg >/dev/null 2>&1"
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Ensure-DockerTempPipApk([string]$cid, [string]$pythonCmd) {
  if (Test-DockerPythonPip -cid $cid -pythonCmd $pythonCmd) {
    Write-Info "pip already present in container."
    return @()
  }

  $added = @()
  foreach ($pkg in @("py3-pip","py3-setuptools")) {
    if (-not (Test-DockerApkPackageInstalled -cid $cid -pkg $pkg)) {
      $added += $pkg
    }
  }

  if (@($added).Count -gt 0) {
    Write-Warn "pip not found; temporarily installing: $($added -join ', ')"
    $cmd = "apk add --no-cache " + ($added -join " ")
    docker exec -u 0 $cid sh -lc $cmd
    if ($LASTEXITCODE -ne 0) {
      throw "failed to install temporary pip packages via apk"
    }
  }

  if (-not (Test-DockerPythonPip -cid $cid -pythonCmd $pythonCmd)) {
    throw "pip is still unavailable after temporary bootstrap"
  }

  return ,$added
}

function Remove-DockerTempApkPackages([string]$cid, [string[]]$packages) {
  if (@($packages).Count -eq 0) { return }

  Write-Info "removing temporary packages: $($packages -join ', ')"
  $cmd = "apk del " + ($packages -join " ")
  docker exec -u 0 $cid sh -lc $cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "failed to remove temporary packages: $($packages -join ', ')"
  }
}

function Ensure-DockerCompileToolchain([string]$cid) {
  $hasRust = (Test-DockerCommand -cid $cid -cmd "rustc") -and (Test-DockerCommand -cid $cid -cmd "cargo")
  $hasCc = (Test-DockerCommand -cid $cid -cmd "cc") -or (Test-DockerCommand -cid $cid -cmd "gcc")
  $hasPkgConfig = (Test-DockerCommand -cid $cid -cmd "pkg-config") -or (Test-DockerCommand -cid $cid -cmd "pkgconf")

  if ($hasRust -and $hasCc -and $hasPkgConfig) {
    Write-Info "Compile toolchain already present in container, skip bootstrap."
    return
  }

  $pm = Get-DockerPackageManager -cid $cid
  if (-not $pm) {
    throw "No supported package manager found in container. Cannot install compile toolchain automatically."
  }

  Write-Info "compile toolchain bootstrap via package manager: $pm"

  switch ($pm) {
    "apk" {
      $cmd = "apk add --no-cache rust cargo build-base python3-dev musl-dev pkgconf"
    }
    "apt-get" {
      $cmd = "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends rustc cargo build-essential python3-dev pkg-config"
    }
    "dnf" {
      $cmd = "dnf install -y rust cargo gcc gcc-c++ make python3-devel pkgconf-pkg-config"
    }
    "microdnf" {
      $cmd = "microdnf install -y rust cargo gcc gcc-c++ make python3-devel pkgconf-pkg-config"
    }
    "yum" {
      $cmd = "yum install -y rust cargo gcc gcc-c++ make python3-devel pkgconfig"
    }
    default {
      throw "Unsupported package manager: $pm"
    }
  }

  docker exec -u 0 $cid sh -lc $cmd
  if ($LASTEXITCODE -ne 0) { throw "failed to install compile toolchain in container via $pm" }

  $hasRustAfter = (Test-DockerCommand -cid $cid -cmd "rustc") -and (Test-DockerCommand -cid $cid -cmd "cargo")
  $hasCcAfter = (Test-DockerCommand -cid $cid -cmd "cc") -or (Test-DockerCommand -cid $cid -cmd "gcc")
  $hasPkgConfigAfter = (Test-DockerCommand -cid $cid -cmd "pkg-config") -or (Test-DockerCommand -cid $cid -cmd "pkgconf")

  if (-not $hasRustAfter) {
    throw "rust toolchain still not found after compile toolchain bootstrap"
  }if (-not $hasCcAfter) {
    throw "C/C++ compiler still not found after compile toolchain bootstrap"
  }
  if (-not $hasPkgConfigAfter) {
    Write-Warn "pkg-config/pkgconf still not found after bootstrap; some native builds may still fail."
  }

  Write-Info "compile toolchain bootstrap done."
}

function Build-PipArgs([string]$reqPath) {
  $args = @("-m","pip","install")
  if ($BreakSystemPackages) { $args += "--break-system-packages" }
  if ($PreferBinary) { $args += "--prefer-binary" }
  $args += @("-r",$reqPath)
  if ($UseTsinghuaMirror) {
    $args += @("-i","https://pypi.tuna.tsinghua.edu.cn/simple")
  }
  return ,$args
}

function Run-QuickCheckHost([string]$pythonExe) {
  $localTmp = Join-Path $env:TEMP "jh_quick_check.py"
  $py = @'
import importlib
mods = ["requests","sudachipy","jaconv","neologdn","budoux","pykakasi","janome","spacy","ginza"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(f"{m}:{e.__class__.__name__}")
print("quick_check_missing=" + ("none" if not bad else ",".join(bad)))
'@
  Set-Content -LiteralPath $localTmp -Value $py -Encoding UTF8
  & $pythonExe $localTmp
  $rc = $LASTEXITCODE
  Remove-Item -LiteralPath $localTmp -ErrorAction SilentlyContinue
  if ($rc -ne 0) { throw "quick check failed on host" }
}

function Run-QuickCheckDocker([string]$cid, [string]$pythonCmd) {
  $localTmp = Join-Path $env:TEMP "jh_quick_check.py"
  $py = @'
import importlib
mods = ["requests","sudachipy","jaconv","neologdn","budoux","pykakasi","janome","spacy","ginza"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(f"{m}:{e.__class__.__name__}")
print("quick_check_missing=" + ("none" if not bad else ",".join(bad)))
'@
  Set-Content -LiteralPath $localTmp -Value $py -Encoding UTF8
  $tmpInContainer = "/tmp/jh_quick_check.py"
  docker cp "$localTmp" "${cid}:$tmpInContainer"
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $localTmp -ErrorAction SilentlyContinue
    throw "failed to copy quick check script to container"
  }
  docker exec $cid sh -lc "$pythonCmd $tmpInContainer"
  $rc = $LASTEXITCODE
  Remove-Item -LiteralPath $localTmp -ErrorAction SilentlyContinue
  if ($rc -ne 0) { throw "quick check failed in container" }
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = $ScriptDir
$ReqFile = Join-Path $RootDir "requirements.txt"
Assert-FileExists $ReqFile
Write-Info "requirements: $ReqFile"

if ($Mode -eq "auto") {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $cid = Get-PreferredContainerId
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

if ($NoMeCab) {
  Write-Info "NoMeCab profile enabled (fugashi/oseti pipeline is intentionally excluded)."
}

if ($Mode -eq "docker") {
  if (-not $DockerContainerId) {
    $DockerContainerId = Get-PreferredContainerId
  }
  if (-not $DockerContainerId) {
    throw "No running container found. Start one or pass -DockerContainerId."
  }

  $pyInDocker = Get-DockerPythonCmd -cid $DockerContainerId
  Write-Info "docker target: $DockerContainerId (python: $pyInDocker)"

  $pm = Get-DockerPackageManager -cid $DockerContainerId
  if (-not $pm) {
    Write-Warn "No supported package manager detected in container; temporary pip bootstrap will be unavailable if pip is missing."
  }

  $tempPipPackages = @()
  $dockerSucceeded = $false

  try {
    if (-not (Test-DockerPythonPip -cid $DockerContainerId -pythonCmd $pyInDocker)) {
      if ($pm -ne "apk") {
        throw "pip not found in container and temporary bootstrap is only implemented for apk. package manager=$pm"
      }

      $tempPipPackages = @(Ensure-DockerTempPipApk -cid $DockerContainerId -pythonCmd $pyInDocker)
    }

    $pipWasBootstrappedTemporarily = (@($tempPipPackages).Count -gt 0)

    $mirrorArg = ""
    if ($UseTsinghuaMirror) { $mirrorArg = " -i https://pypi.tuna.tsinghua.edu.cn/simple" }

    $pipBase = "$pyInDocker -m pip install"
    if ($BreakSystemPackages) { $pipBase += " --break-system-packages" }
    if ($PreferBinary) { $pipBase += " --prefer-binary" }

    if ($UpgradePip -and -not $pipWasBootstrappedTemporarily) {
      $cmdUp = "$pyInDocker -m pip install"
      if ($BreakSystemPackages) { $cmdUp += " --break-system-packages" }
      $cmdUp += " -U pip setuptools wheel$mirrorArg"
      docker exec $DockerContainerId sh -lc $cmdUp
      if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed in container" }
    }
    elseif ($UpgradePip -and $pipWasBootstrappedTemporarily) {
      Write-Warn "temporary pip bootstrap detected; skip pip/setuptools/wheel self-upgrade to keep container clean."
    }

    if ($InstallCompileToolchain) {Ensure-DockerCompileToolchain -cid $DockerContainerId
    } else {
      Write-Warn "compile toolchain bootstrap disabled; source builds may fail if no wheel is available."
    }

    $tmpReq = "/tmp/JapaneseHelper.requirements.txt"
    docker cp "$ReqFile" "${DockerContainerId}:$tmpReq"
    if ($LASTEXITCODE -ne 0) { throw "failed to copy requirements.txt into container" }

    $cmdInstall = "$pipBase -r $tmpReq$mirrorArg"
    docker exec $DockerContainerId sh -lc $cmdInstall
    if ($LASTEXITCODE -ne 0) { throw "requirements install failed in container" }

    if ($RunQuickCheck) {
      Run-QuickCheckDocker -cid $DockerContainerId -pythonCmd $pyInDocker
    }

    $dockerSucceeded = $true
  }
  finally {
    try {
      docker exec $DockerContainerId sh -lc "rm -f /tmp/JapaneseHelper.requirements.txt /tmp/jh_quick_check.py >/dev/null 2>&1|| true"
    } catch {}

    if (@($tempPipPackages).Count -gt 0) {
      Remove-DockerTempApkPackages -cid $DockerContainerId -packages $tempPipPackages
    }
  }

  if ($dockerSucceeded) {
    Write-Info "docker mode install done."
    exit 0
  }
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

$argList = Build-PipArgs -reqPath $ReqFile
if ($TargetPath) {
  if (!(Test-Path -LiteralPath $TargetPath)) {
    New-Item -ItemType Directory -Path $TargetPath | Out-Null
  }
  $argList += @("--target",$TargetPath)
}

Write-Info "host mode install start..."
& $PythonExe @argList
if ($LASTEXITCODE -ne 0) { throw "requirements install failed on host" }

if ($RunQuickCheck) {
  Run-QuickCheckHost -pythonExe $PythonExe
}

Write-Info "host mode install done."
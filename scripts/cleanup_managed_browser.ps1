[CmdletBinding()]
param(
    [string]$ProfileDir,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ConfigPath = Join-Path $ProjectRoot 'config.env'

function Get-ConfigValue {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }

        $separator = $trimmed.IndexOf('=')
        if ($separator -le 0) {
            continue
        }

        $key = $trimmed.Substring(0, $separator).Trim()
        if ($key -ne $Name) {
            continue
        }

        $value = $trimmed.Substring($separator + 1).Trim()
        if (
            $value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        return $value
    }

    return $null
}

function Resolve-ProfilePath {
    param([string]$RequestedPath)

    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Get-ConfigValue -Path $ConfigPath -Name 'VCP_BROWSER_PROFILE_DIR'
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = 'Plugin/ChromeBridge/managed-profile'
    }

    if ([System.IO.Path]::IsPathRooted($candidate)) {
        return [System.IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
    }

    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $candidate)).TrimEnd('\', '/')
}

function Normalize-ComparablePath {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }

    try {
        return [System.IO.Path]::GetFullPath($Value).TrimEnd('\', '/').ToLowerInvariant()
    } catch {
        return $Value.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant()
    }
}

function Get-UserDataDirFromCommandLine {
    param([string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $null
    }

    $match = [regex]::Match(
        $CommandLine,
        '(?i)(?:^|\s)--user-data-dir=(?:"([^"]+)"|''([^'']+)''|([^\s]+))'
    )
    if (-not $match.Success) {
        return $null
    }

    foreach ($index in 1..3) {
        if ($match.Groups[$index].Success) {
            return $match.Groups[$index].Value
        }
    }

    return $null
}

function Get-ManagedBrowserProcesses {
    param([string]$ExpectedProfile)

    $normalizedExpected = Normalize-ComparablePath $ExpectedProfile
    $browserNames = @('chrome.exe', 'msedge.exe', 'chromium.exe')
    $processes = Get-CimInstance Win32_Process | Where-Object {
        $browserNames -contains $_.Name.ToLowerInvariant()
    }

    return @($processes | Where-Object {
        $userDataDir = Get-UserDataDirFromCommandLine $_.CommandLine
        $userDataDir -and (Normalize-ComparablePath $userDataDir) -eq $normalizedExpected
    })
}

function Remove-StaleProfileLocks {
    param([string]$ExpectedProfile)

    $lockNames = @('SingletonLock', 'SingletonSocket', 'SingletonCookie')
    foreach ($lockName in $lockNames) {
        $lockPath = Join-Path $ExpectedProfile $lockName
        if (Test-Path -LiteralPath $lockPath) {
            Remove-Item -LiteralPath $lockPath -Force -Recurse -ErrorAction SilentlyContinue
            Write-Host "[CLEAN] Removed stale lock: $lockPath" -ForegroundColor DarkGray
        }
    }
}

$resolvedProfile = Resolve-ProfilePath $ProfileDir
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' VCP Managed Chrome Process Cleanup' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "Managed Profile: $resolvedProfile"
Write-Host ''

$matches = Get-ManagedBrowserProcesses $resolvedProfile
if ($matches.Count -eq 0) {
    Write-Host '[OK] No browser process is using this managed Profile.' -ForegroundColor Green
    if (-not $DryRun) {
        Remove-StaleProfileLocks $resolvedProfile
    }
    exit 0
}

Write-Host "[FOUND] $($matches.Count) managed browser process(es):" -ForegroundColor Yellow
$matches |
    Sort-Object ProcessId |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine |
    Format-Table -AutoSize -Wrap

if ($DryRun) {
    Write-Host '[DRY-RUN] No process or lock file was changed.' -ForegroundColor Cyan
    exit 0
}

if (-not $Force) {
    $answer = Read-Host 'Terminate only the processes using this managed Profile? Type YES to continue'
    if ($answer -cne 'YES') {
        Write-Host '[CANCELLED] Nothing was changed.' -ForegroundColor Yellow
        exit 2
    }
}

$matchedIds = @{}
foreach ($process in $matches) {
    $matchedIds[[int]$process.ProcessId] = $true
}

$roots = @($matches | Where-Object {
    -not $matchedIds.ContainsKey([int]$_.ParentProcessId)
})
if ($roots.Count -eq 0) {
    $roots = @($matches)
}

$failed = @()
foreach ($root in ($roots | Sort-Object ProcessId -Unique)) {
    Write-Host "[STOP] taskkill /T /F /PID $($root.ProcessId) ($($root.Name))" -ForegroundColor Yellow
    & taskkill.exe /T /F /PID ([string]$root.ProcessId) | Out-Host
    if ($LASTEXITCODE -ne 0) {
        $failed += $root.ProcessId
    }
}

Start-Sleep -Milliseconds 800
$remaining = Get-ManagedBrowserProcesses $resolvedProfile
if ($remaining.Count -gt 0) {
    Write-Host "[ERROR] $($remaining.Count) matching process(es) remain:" -ForegroundColor Red
    $remaining |
        Select-Object ProcessId, ParentProcessId, Name, CommandLine |
        Format-Table -AutoSize -Wrap
    exit 1
}

Remove-StaleProfileLocks $resolvedProfile

if ($failed.Count -gt 0) {
    Write-Host "[WARN] taskkill returned errors for PID(s): $($failed -join ', '), but no matching process remains." -ForegroundColor Yellow
}

Write-Host '[DONE] Managed browser processes were cleared. Other Chrome profiles were not targeted.' -ForegroundColor Green
exit 0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [Parameter(Mandatory = $true)]
    [string]$TargetRoot,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedSha256,
    [switch]$DryRun,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-Install([string]$Code) {
    throw [System.InvalidOperationException]::new($Code)
}

function Test-SupportedNode([string]$Value) {
    try { $version = [version]($Value.Split('-')[0]) }
    catch { return $false }
    return (($version.Major -eq 20 -and $version -ge [version]'20.20.2') -or
            ($version.Major -eq 22 -and $version -ge [version]'22.21.1'))
}

function Assert-SafeArchiveEntry([string]$Entry) {
    $normalized = $Entry.Replace('\', '/').TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($normalized)) { return }
    if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or $normalized.IndexOf([char]0) -ge 0) {
        Stop-Install 'ARCHIVE_PATH_UNSAFE'
    }
    $parts = @($normalized.Split('/'))
    if ($parts.Count -lt 2 -or $parts[0] -ne 'TelegramBridge' -or $parts -contains '..' -or $parts -contains '.') {
        Stop-Install 'ARCHIVE_PATH_UNSAFE'
    }
    if ($parts -contains 'config.env' -or $parts -contains 'state' -or $parts -contains '.git' -or
        $parts -contains 'node_modules' -or $parts -contains 'logs' -or $parts -contains 'media') {
        Stop-Install 'ARCHIVE_PRIVATE_DATA_FORBIDDEN'
    }
    if ($normalized -match '(?i)\.sqlite(?:3)?(?:-(?:wal|shm|journal))?$|\.log$') {
        Stop-Install 'ARCHIVE_PRIVATE_DATA_FORBIDDEN'
    }
}

$stagingRoot = $null
$targetPath = $null
$backupPath = $null
$installed = $false
$stage = 'MODE'

try {
    if ($DryRun -and $Apply) { Stop-Install 'INSTALL_MODE_CONFLICT' }
    if (-not $DryRun -and -not $Apply) { Stop-Install 'INSTALL_MODE_REQUIRED' }

    $stage = 'PACKAGE'
    $resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
    if (-not (Test-Path -LiteralPath $resolvedPackage -PathType Leaf)) { Stop-Install 'PACKAGE_NOT_FOUND' }
    if (-not $resolvedPackage.EndsWith('.tar.gz', [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Install 'PACKAGE_FORMAT_INVALID'
    }

    $stage = 'TARGET'
    $resolvedTargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
    $filesystemRoot = [System.IO.Path]::GetPathRoot($resolvedTargetRoot)
    if ($resolvedTargetRoot -eq $filesystemRoot -or -not (Test-Path -LiteralPath $resolvedTargetRoot -PathType Container)) {
        Stop-Install 'TARGET_ROOT_INVALID'
    }
    $pluginParent = Join-Path $resolvedTargetRoot 'Plugin'
    if (-not (Test-Path -LiteralPath $pluginParent -PathType Container)) { Stop-Install 'TARGET_PLUGIN_DIR_MISSING' }
    $targetPath = [System.IO.Path]::GetFullPath((Join-Path $pluginParent 'TelegramBridge'))
    $relativeTarget = $targetPath.Substring($resolvedTargetRoot.Length).TrimStart('\', '/')
    if ($relativeTarget -ne (Join-Path 'Plugin' 'TelegramBridge')) { Stop-Install 'TARGET_PATH_UNSAFE' }

    $stage = 'NODE'
    $nodeVersion = (& node -p 'process.versions.node' 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not (Test-SupportedNode ([string]$nodeVersion))) {
        Stop-Install 'NODE_VERSION_UNSUPPORTED'
    }

    $stage = 'HASH_READ'
    $hashStream = [System.IO.File]::OpenRead($resolvedPackage)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { $hashBytes = $sha256.ComputeHash($hashStream) }
        finally { $sha256.Dispose() }
    } finally {
        $hashStream.Dispose()
    }
    $stage = 'HASH_COMPARE'
    $actualSha256 = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) { Stop-Install 'PACKAGE_HASH_MISMATCH' }

    $stage = 'ARCHIVE_LIST'
    $tarCommand = (Get-Command tar -ErrorAction Stop).Source
    $archiveEntries = @(& $tarCommand -tzf $resolvedPackage)
    if ($LASTEXITCODE -ne 0 -or $archiveEntries.Count -eq 0) { Stop-Install 'ARCHIVE_LIST_FAILED' }
    foreach ($entry in $archiveEntries) { Assert-SafeArchiveEntry ([string]$entry) }
    $normalizedEntries = @($archiveEntries | ForEach-Object { ([string]$_).Replace('\', '/').TrimEnd('/') })
    foreach ($required in @(
        'TelegramBridge/TelegramBridge.js',
        'TelegramBridge/plugin-manifest.json',
        'TelegramBridge/config.env.example',
        'TelegramBridge/package.json',
        'TelegramBridge/package-lock.json'
    )) {
        if ($normalizedEntries -notcontains $required) { Stop-Install 'ARCHIVE_REQUIRED_FILE_MISSING' }
    }

    $stage = 'ARCHIVE_EXTRACT'
    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('telegrambridge-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    & $tarCommand -xzf $resolvedPackage -C $stagingRoot
    if ($LASTEXITCODE -ne 0) { Stop-Install 'ARCHIVE_EXTRACT_FAILED' }
    $stagedPlugin = Join-Path $stagingRoot 'TelegramBridge'
    $stage = 'PACKAGE_DEFAULTS'
    $manifest = Get-Content -LiteralPath (Join-Path $stagedPlugin 'plugin-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.configSchema.TELEGRAM_MODE.default -ne 'disabled') { Stop-Install 'PACKAGE_DEFAULT_UNSAFE' }
    $modeLine = Get-Content -LiteralPath (Join-Path $stagedPlugin 'config.env.example') |
        Where-Object { $_ -match '^TELEGRAM_MODE=' } | Select-Object -First 1
    if ($modeLine -ne 'TELEGRAM_MODE=disabled') { Stop-Install 'PACKAGE_DEFAULT_UNSAFE' }
    if (Test-Path -LiteralPath (Join-Path $stagedPlugin 'config.env')) { Stop-Install 'PACKAGE_CONFIG_FORBIDDEN' }
    if (Test-Path -LiteralPath (Join-Path $stagedPlugin 'state')) { Stop-Install 'PACKAGE_STATE_FORBIDDEN' }

    if ($DryRun) {
        Write-Output 'LOCAL_INSTALL_DRY_RUN_OK'
        return
    }

    $stage = 'APPLY'
    $backupRoot = Join-Path $resolvedTargetRoot '.telegrambridge-backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backupPath = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $targetPath) {
        Move-Item -LiteralPath $targetPath -Destination $backupPath
    } else {
        $backupPath = $null
    }

    try {
        New-Item -ItemType Directory -Path $targetPath | Out-Null
        Get-ChildItem -LiteralPath $stagedPlugin | Copy-Item -Destination $targetPath -Recurse -Force
        if ($null -ne $backupPath) {
            $savedConfig = Join-Path $backupPath 'config.env'
            $savedState = Join-Path $backupPath 'state'
            if (Test-Path -LiteralPath $savedConfig -PathType Leaf) {
                Copy-Item -LiteralPath $savedConfig -Destination (Join-Path $targetPath 'config.env')
            }
            if (Test-Path -LiteralPath $savedState -PathType Container) {
                Copy-Item -LiteralPath $savedState -Destination (Join-Path $targetPath 'state') -Recurse
            }
        }
        # Never let npm search parent directories if extraction/path setup failed.
        foreach ($packageFile in @('package.json', 'package-lock.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $targetPath $packageFile) -PathType Leaf)) {
                Stop-Install 'INSTALL_PACKAGE_SCOPE_INVALID'
            }
        }
        $installedPackage = Get-Content -LiteralPath (Join-Path $targetPath 'package.json') -Raw | ConvertFrom-Json
        if ($installedPackage.name -ne 'vcp-telegram-bridge') { Stop-Install 'INSTALL_PACKAGE_SCOPE_INVALID' }
        & npm --prefix $targetPath ci --omit=dev
        if ($LASTEXITCODE -ne 0) { Stop-Install 'NPM_INSTALL_FAILED' }
        $installed = $true
    } catch {
        if (Test-Path -LiteralPath $targetPath) {
            $verifiedTarget = [System.IO.Path]::GetFullPath($targetPath)
            if ($verifiedTarget -ne [System.IO.Path]::GetFullPath((Join-Path $resolvedTargetRoot 'Plugin\TelegramBridge'))) {
                Stop-Install 'ROLLBACK_TARGET_UNSAFE'
            }
            Remove-Item -LiteralPath $verifiedTarget -Recurse -Force
        }
        if ($null -ne $backupPath -and (Test-Path -LiteralPath $backupPath)) {
            Move-Item -LiteralPath $backupPath -Destination $targetPath
        }
        throw
    }

    Write-Output 'LOCAL_INSTALL_APPLY_OK'
    if ($null -ne $backupPath) { Write-Output 'LOCAL_INSTALL_BACKUP_CREATED' }
} catch {
    $code = if ($_.Exception.Message -match '^[A-Z][A-Z0-9_]{2,63}$') {
        $_.Exception.Message
    } else {
        "LOCAL_INSTALL_UNEXPECTED_$stage"
    }
    Write-Error "LOCAL_INSTALL_FAILED ($code)"
    exit 1
} finally {
    if ($null -ne $stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

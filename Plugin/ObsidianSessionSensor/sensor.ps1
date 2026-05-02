$ErrorActionPreference = "Stop"

function Write-Utf8Json($Object) {
    $json = $Object | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
    $stdout = [System.Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
    $stdout.Close()
}

$vaultDir = $env:OBSIDIAN_VAULT_DIR
$activeNote = $env:OBSIDIAN_ACTIVE_NOTE
$limit = 8
if ($env:OBSIDIAN_SENSOR_LIMIT) {
    [int]::TryParse($env:OBSIDIAN_SENSOR_LIMIT, [ref]$limit) | Out-Null
}

if ([string]::IsNullOrWhiteSpace($vaultDir) -or -not (Test-Path -LiteralPath $vaultDir -PathType Container)) {
    Write-Utf8Json @{
        vcp_dynamic_fold = $true
        fold_name = "ObsidianSession"
        plugin_description = "Obsidian session context sensor."
        fold_blocks = @(
            @{
                threshold = 0.0
                content = "ObsidianSessionSensor is not configured. Set OBSIDIAN_VAULT_DIR."
            }
        )
    }
    exit 0
}

$vaultRoot = (Resolve-Path -LiteralPath $vaultDir).Path
$recent = Get-ChildItem -LiteralPath $vaultRoot -Recurse -File -Filter "*.md" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First $limit

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("[Obsidian vault context]")
$lines.Add("Vault: $vaultRoot")

if (-not [string]::IsNullOrWhiteSpace($activeNote)) {
    $resolvedActive = if ([System.IO.Path]::IsPathRooted($activeNote)) {
        $activeNote
    } else {
        Join-Path $vaultRoot $activeNote
    }
    $lines.Add("Active note: $resolvedActive")
}

$lines.Add("Recent notes:")
if ($recent.Count -eq 0) {
    $lines.Add("- (no markdown notes found)")
} else {
    foreach ($note in $recent) {
        $relativePath = $note.FullName
        if ($note.FullName.StartsWith($vaultRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relativePath = $note.FullName.Substring($vaultRoot.Length).TrimStart('\', '/')
        }
        $lines.Add("- $relativePath | modified: $($note.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))")
    }
}

$detailed = $lines -join "`n"
$summary = "Obsidian vault available: $vaultRoot. Recent markdown note count sampled: $($recent.Count)."

Write-Utf8Json @{
    vcp_dynamic_fold = $true
    fold_name = "ObsidianSession"
    plugin_description = "Provides recent Obsidian vault activity for prompt context. It does not edit notes."
    fold_blocks = @(
        @{
            threshold = 0.65
            content = $detailed
        },
        @{
            threshold = 0.25
            content = $summary
        },
        @{
            threshold = 0.0
            content = "[Obsidian session context is available but not expanded.]"
        }
    )
}

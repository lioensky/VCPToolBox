# sensor.ps1
# 获取具有可见主窗口的进程，提取窗口标题，并格式化为 vcp_dynamic_fold 协议支持的 JSON

# 读取插件配置（如果存在），获取当前节点名，否则默认
$nodeName = "Master"
# 如果存在 plugin-config.json，尝试读取 NodeName (根据 VCP 的插件机制，实际可能由系统环境变量或配置文件注入，这里提供一个简单的降级)
$configPath = Join-Path $PSScriptRoot "plugin-config.json"
if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.NodeName) {
            $nodeName = $config.NodeName
        }
    } catch {}
}

# 1. 获取所有有窗口且未退出的进程
$processes = Get-Process | Where-Object { 
    $_.MainWindowHandle -ne 0 -and 
    (-not [string]::IsNullOrWhiteSpace($_.MainWindowTitle))
}

# 2. 预定义的关注应用列表（可以根据进程名优先分类）
$priorityApps = @("chrome", "firefox", "msedge", "Code", "devenv", "qq", "wechat", "vcpchat", "electron")

$highPriority = @()
$otherApps = @()

foreach ($p in $processes) {
    $procName = $p.ProcessName
    $title = $p.MainWindowTitle
    
    # 过滤掉一些系统级的无用窗口 (例如 "Program Manager", "Settings" 等)
    if ($title -match "^(?:Program Manager|Settings)$") { continue }

    $pidNum = $p.Id
    $hwnd = $p.MainWindowHandle

    $info = "[$pidNum] $procName : $title (HWND: $hwnd)"

    $isPriority = $false
    foreach ($pApp in $priorityApps) {
        if ($procName -imatch $pApp) {
            $isPriority = $true
            break
        }
    }

    if ($isPriority) {
        $highPriority += $info
    } else {
        $otherApps += $info
    }
}

# 3. 构建不同精度层次的输出文本
$detailedContentList = new-object System.Collections.ArrayList
[void]$detailedContentList.Add("【节点 $($nodeName) 窗口深度感知数据】")
[void]$detailedContentList.Add("--- 核心交互进程 ---")
if ($highPriority.Count -gt 0) {
    $detailedContentList.AddRange($highPriority)
} else {
    [void]$detailedContentList.Add("(无)")
}

[void]$detailedContentList.Add("--- 其他活跃窗口 ---")
if ($otherApps.Count -gt 0) {
    # 如果太多，截断显示，防止超出一定限度
    $displayCount = [Math]::Min($otherApps.Count, 15)
    for ($i = 0; $i -lt $displayCount; $i++) {
        [void]$detailedContentList.Add($otherApps[$i])
    }
    if ($otherApps.Count -gt 15) {
        [void]$detailedContentList.Add("... (及其它 $($otherApps.Count - 15) 个窗口)")
    }
} else {
    [void]$detailedContentList.Add("(无)")
}

$detailedText = $detailedContentList -join "`n"

# 简略摘要
$summaryContentList = new-object System.Collections.ArrayList
[void]$summaryContentList.Add("【节点 $($nodeName) 窗口简报】")
if ($highPriority.Count -gt 0) {
    $summaryApps = ($highPriority | ForEach-Object { ($_ -split ' : ')[0] -replace '^\[\d+\]\s*', '' }) | Select-Object -Unique
    [void]$summaryContentList.Add("活跃应用: " + ($summaryApps -join ", "))
} else {
    [void]$summaryContentList.Add("活跃应用: (无明显核心交互应用)")
}
$summaryText = $summaryContentList -join "`n"

# 4. 构建符合 vcp_dynamic_fold 的 JSON
# JSON 字符串必须严谨构建
$foldObj = @{
    vcp_dynamic_fold = $true
    fold_name = "WindowSense_$nodeName"
    plugin_description = "获取当前电脑正在运行的有窗口进程列表，用于了解用户正在看什么软件，比如浏览器、游戏或代码编辑器等。检测窗口、进程名、标题、应用。"
    fold_blocks = @(
        @{
            threshold = 0.7
            content = $detailedText
        },
        @{
            threshold = 0.4
            content = $summaryText
        },
        @{
            threshold = 0.0
            content = "[节点 $($nodeName) 窗口感知雷达已就绪，当前语境无需展开]"
        }
    )
}

# 转换为 JSON 输出，不自动换行，保持紧凑
$jsonOutput = $foldObj | ConvertTo-Json -Depth 5 -Compress

# 绕过 PowerShell 标准输出的编码坑，直接以严格的 UTF-8 (无 BOM) 写入底层的 StandardOutput 流
$bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonOutput + "`n")
$stdout = [System.Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
$stdout.Close()

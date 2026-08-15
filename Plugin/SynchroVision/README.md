# SynchroVision

SynchroVision 是一个 Windows 优先的 `hybridservice` 插件，为 VCPToolBox 提供浏览器与桌面上下文。它可以读取浏览器历史、书签、下载记录、搜索记录、打开标签页和可见窗口，并通过配套扩展接收当前页面摘要与截图。

## 隐私边界

这些数据可能包含完整 URL、页面标题、搜索词、文件路径和窗口标题。插件只应在明确授权的个人设备上启用；请在共享设备或多用户服务中关闭它。插件不读取或上传浏览器保存的密码，Cookie 文件也不随插件发布。调用结果可能包含敏感内容，请按私密数据处理。

## 工具命令

| 命令 | 用途 |
| --- | --- |
| `inspect_active_tab` | 当前激活标签页的标题、URL、正文摘要和标签页概览 |
| `get_browser_history` | Chrome/Edge 历史，可传 `limit`、`days_back`、`browser` |
| `get_bookmarks` | 书签，可传 `search`、`browser` |
| `get_downloads` | 下载记录，可传 `limit`、`days_back`、`browser` |
| `get_recent_searches` | 搜索记录，可传 `limit`、`days_back` |
| `get_extensions` | 已安装扩展清单 |
| `get_open_tabs` | 扩展连接提供的所有标签页 |
| `get_all_windows` | 可见桌面窗口与分类 |
| `get_focus_summary` | 当前窗口焦点摘要 |
| `check_user_intent` | 聚合浏览器、窗口和 AI 页面活动 |
| `get_full_overview` | 完整浏览器感知报告 |

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name: SynchroVision
command: get_browser_history
limit: 20
days_back: 3
<<<[END_TOOL_REQUEST]>>>
```

## 安装与配置

1. 将 `config.env.example` 复制为 `config.env`。
2. 默认只需保持 `DebugMode=false`；调试时再改为 `true`。
3. 在 VCPToolBox 中加载 `plugin-manifest.json`。
4. 如需实时页面、标签页和截图能力，将 `extension/` 作为 Chrome 扩展以开发者模式加载，并确认 VCPChrome/WebSocket 服务已运行。

如需 B 站增强信息，可在插件目录放置本机导出的 `www.bilibili.com_cookies.txt`；该文件只在本机配置，不要提交。

## 运行依赖

- Node.js 18 或更高版本
- Windows PowerShell（窗口扫描回退链使用）
- `better-sqlite3`（浏览器数据库读取；缺失时相关能力会优雅降级）
- VCPToolBox 的 WebSocket/Plugin 运行时

## 目录

`SynchroVision.js` 是插件入口；`chrome_data_miner.js`、`window_scanner.js` 和 `bili_enricher.js` 提供数据适配；`extension/` 是可选的浏览器端采集器。日志和截图目录由运行时生成，不应提交。

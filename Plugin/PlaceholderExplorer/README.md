# PlaceholderExplorer

PlaceholderExplorer 为 VCPToolBox 建立“占位符 → 定义位置 → 引用位置”的统一索引，并解析 Tar/Var/Sar、Agent 与 Toolbox 指向文件后的嵌套引用链。

## 组成

- `PlaceholderExplorer`：static 插件，定期扫描并向 `{{VCPPlaceholderMap}}` 输出动态折叠摘要。
- `PlaceholderExplorerCommand`：同步命令插件，提供 `Scan`、`Locate`、`Edit`、`Preview`、`CheckDeadLinks`。
- `generated/placeholder-index.json`：最近一次全量索引样例和运行时索引。
- `backups/`：每次成功写入前的原文件备份，运行时自动创建。

## 扫描范围

- `config.env` 中所有 `Tar*`、`Var*`、`SarPrompt*`；
- `sarprompt.json` 中的 Sar 定义；
- `Plugin/*/plugin-manifest.json` 中显式静态占位符与 `{{VCP<插件名>}}` 工具说明占位符；
- `TVStxt/**/*.{txt,md}` 与 `Agent/**/*.{txt,md}` 的 `{{...}}` / `[[...]]` 使用点；
- `agent_map.json`、`toolbox_map.json`、表情包目录和引擎内置占位符。

## 命令

命令均调用工具 `PlaceholderExplorerCommand`。

### Scan

重建索引：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PlaceholderExplorerCommand「末」,
command:「始」Scan「末」
<<<[END_TOOL_REQUEST]>>>
```

### Locate

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PlaceholderExplorerCommand「末」,
command:「始」Locate「末」,
placeholder:「始」{{VarToolList}}「末」
<<<[END_TOOL_REQUEST]>>>
```

返回定义路径与行号、全部引用、`nesting` 边和 `referenceChains` 完整链。

### Edit

编辑定义值：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PlaceholderExplorerCommand「末」,
command:「始」Edit「末」,
placeholder:「始」{{VarCity}}「末」,
newValue:「始」Shanghai「末」,
scope:「始」definition「末」
<<<[END_TOOL_REQUEST]>>>
```

若变量唯一指向一个 TVStxt 文件，可用 `scope=file` 编辑文件正文。写入流程固定为：读取全文 → 内存修改 → 临时文件 → 校验 → 备份 → 原子替换。

**重要：修改 `config.env` 中 Tar/Var 后不会热重载，必须重启 VCP 服务才生效。** Sar 的运行时真相源为 `sarprompt.json`，该文件由现有 SarPromptManager 监听。

只读类型（内置、聚合、插件、表情包、Agent/Toolbox 映射、声明式日记占位符）无写入入口。

### Preview

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PlaceholderExplorerCommand「末」,
command:「始」Preview「末」,
placeholder:「始」{{VarTimeNow}}「末」,
role:「始」system「末」
<<<[END_TOOL_REQUEST]>>>
```

预览直接复用 `modules/messageProcessor.js` 导出的 `replaceAgentVariables`（即 `resolveAllVariables`），不会绕过特权角色判定。将 `role` 设为普通 `user` 时，system 专属变量不会展开。独立命令进程不能访问 VCP 主进程内存中的静态插件实时结果，该类值会保留并在结果中说明限制。

### CheckDeadLinks

返回：

- 死链：有引用、无定义；
- 孤儿：有定义、无其他引用；
- 缺失的 TVStxt / Agent 映射文件；
- 无效 manifest 或其他扫描错误。

## 配置

复制 `config.env.example` 为 `config.env` 后可覆盖扫描路径、索引路径、备份目录、保留份数和单次编辑大小限制。插件通过 `PROJECT_BASE_PATH` 自动获取 VCP 根目录，通常不需要配置。

备份目录必须位于 `Plugin/PlaceholderExplorer/` 内，避免把敏感配置备份到任意外部路径。

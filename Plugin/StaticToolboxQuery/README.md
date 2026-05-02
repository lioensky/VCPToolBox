# StaticToolboxQuery

`StaticToolboxQuery` 是静态工具箱折叠协议的运行时查询扩展。

它解决的不是“自动预展开更多内容”，而是让 Agent 在已经开始推理后，仍然能主动查询 `TVStxt/*ToolBox.txt` 中被折叠收纳的说明块，再按返回的说明调用真实工具。

## 安全边界

- 只查询 `toolbox_map.json` 中注册的静态工具箱。
- 不接受任意文件路径。
- 不执行真实工具操作，只返回说明文本。
- 默认不返回基础常驻 block，避免重复上下文。
- 默认限制 `maxBlocks=2`、`maxChars=8000`。

## 参数

- `toolbox`: 必需。支持 `VCPFileToolBox`、`VCPSearchToolBox`、`VCPMemoToolBox`、`VCPContactToolBox`、`VCPMediaToolBox`，也支持 `file/search/memo/contact/media`。
- `mode`: `best`、`list`、`all`，默认 `best`。
- `query`: `best` 模式必需。
- `block` 或 `index`: 可选。使用 `list` 返回的 index 精确获取 block。
- `maxBlocks`: 可选，默认 `2`，最大 `10`。
- `maxChars`: 可选，默认 `8000`，最大 `30000`。
- `includeBase`: 可选，默认 `false`。

## 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」StaticToolboxQuery「末」,
toolbox:「始」file「末」,
query:「始」WriteFile EditFile 文件写入「末」,
mode:「始」best「末」,
maxBlocks:「始」1「末」
<<<[END_TOOL_REQUEST]>>>
```

```powershell
'{"toolbox":"file","query":"WriteFile EditFile","mode":"best","maxBlocks":1}' | node Plugin/StaticToolboxQuery/StaticToolboxQuery.js
```

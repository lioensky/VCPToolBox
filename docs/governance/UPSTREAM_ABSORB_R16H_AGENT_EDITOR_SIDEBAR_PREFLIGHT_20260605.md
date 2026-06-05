# Upstream Absorb R16H Agent Editor Sidebar Preflight - 2026-06-05

本文件只做设计/preflight，不实现代码，不 raw merge `upstream/main`。

## 1. 目标

评估 upstream `c2f3b1a9` 中“Agent 编辑器右侧栏快速编辑”是否适合吸收。

本轮只看源码范围：

- `AdminPanel-Vue/src/views/AgentFilesEditor.vue`
- `AdminPanel-Vue/src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue`

明确排除：

- `AdminPanel-Vue/dist/*`
- 真实 env / `config.env`
- 后端接口实现
- 运行态、缓存、构建产物

## 2. 上游行为摘要

`c2f3b1a9` 同时包含源码和构建产物：

- `AdminPanel-Vue/dist/*` 多个 hash 文件重生成。
- `AdminPanel-Vue/src/views/AgentFilesEditor.vue` 增加右侧“常用占位符”侧栏。
- `AdminPanel-Vue/src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue` 将 `sanitizeNumber(value: string)` 放宽为 `sanitizeNumber(value: unknown)`。

侧栏设计大致为：

- 在 Agent 文件编辑器右侧工具栏增加“占位符”开关。
- 编辑区从单 textarea 改为 editor + sidebar 双列布局。
- 侧栏从 `toolboxApi.getToolboxMap()` 读取 toolbox alias。
- 侧栏从 `placeholderApi.getPlaceholders()` 读取占位符列表，并筛选 `Tar*` / `Var*` / `Sar*`。
- 点击占位符 chip 后插入到 textarea 当前光标位置。
- 支持搜索、分组折叠、侧栏折叠和移动端响应式布局。

## 3. 本地现状

本地已经有可复用 API：

- `AdminPanel-Vue/src/api/placeholder.ts`
  - `placeholderApi.getPlaceholders()`
  - `placeholderApi.getPlaceholderDetail()`
- `AdminPanel-Vue/src/api/toolbox.ts`
  - `toolboxApi.getToolboxMap()`

本地 `AgentFilesEditor.vue` 当前已有：

- Agent map 编辑
- Agent 文件创建/绑定/编辑/保存
- 移动端 list/editor 切换
- 日记本语法编辑器 modal
- 离开页面/刷新时的未保存改动保护

## 4. 风险判断

不建议 raw cherry-pick `c2f3b1a9`。

原因：

- 上游提交混入大量 `AdminPanel-Vue/dist/*` 构建产物，必须排除。
- `AgentFilesEditor.vue` 单文件改动约 600 行，包含 UI、状态、异步加载、插入光标和响应式样式，review 面较大。
- 侧栏默认展开会改变编辑器可用宽度，移动端和窄屏需要实测。
- 新增 `toolboxApi` / `placeholderApi` 并发加载，若接口失败应只影响侧栏，不应阻断 Agent 文件编辑。
- 插入行为会直接修改 `fileContent`，必须保持原有 `fileDirty` / 保存流程语义。
- `DiarySyntaxEditorModal.vue` 的 `sanitizeNumber` 类型修正是小而独立的安全改动，可与侧栏同包或单独先吸收，但不应带入无关重排。

## 5. 建议实现边界

若继续实现，建议开独立 R16H1 小包，范围限定：

- `AdminPanel-Vue/src/views/AgentFilesEditor.vue`
- `AdminPanel-Vue/src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue`

不碰：

- `AdminPanel-Vue/dist/*`
- `AdminPanel-Vue/package.json`
- `AdminPanel-Vue/package-lock.json`
- 后端 routes / admin API
- 真实 env / `config.env`

建议本地更保守策略：

- 保留现有 API，不新增后端接口。
- 侧栏数据加载失败时只显示侧栏错误，不影响文件编辑。
- 默认可考虑折叠或维持上游默认展开，但需要明确移动端表现。
- 插入 placeholder 时优先插入 textarea 光标位置；没有 ref 时追加到末尾。
- 保持 `Ctrl/Cmd+S`、未保存离开确认、刷新确认行为不变。
- `DiarySyntaxEditorModal.vue` 的 `sanitizeNumber(value: unknown)` 可作为同包附带小修，因为它只增强输入健壮性，不改变生成语法的正常路径。

## 6. 验证建议

源码实现包建议至少跑：

```powershell
git diff --check
Set-Location AdminPanel-Vue
npm run build
```

必要时补充静态检查：

```powershell
rg -n "placeholderApi|toolboxApi|insertPlaceholderAtCursor|fileDirty|handleKeydown" AdminPanel-Vue\src\views\AgentFilesEditor.vue
```

如果本地环境允许，再做浏览器手测：

- 打开 Agent 文件编辑器。
- 选择一个 Agent 文件。
- 点击“占位符”按钮折叠/展开侧栏。
- 搜索 `Var` / `Tar` / toolbox alias。
- 点击 chip 后确认文本插入到当前光标位置。
- 修改后 `fileDirty` 生效，`Ctrl/Cmd+S` 保存仍可用。
- 移动端宽度下 editor 与侧栏不重叠。

## 7. 结论

R16H 值得继续做，但必须作为独立前端源码包手工吸收。

推荐下一步开 R16H1 实现小包，只改 `AdminPanel-Vue/src/views/AgentFilesEditor.vue` 和 `AdminPanel-Vue/src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue`，继续排除 `AdminPanel-Vue/dist/*`。实现后以 `npm run build` 作为最低验证，不提交构建产物。

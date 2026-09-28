# JEV 提示词素材登记与管理面板开发设计

> **文档性质：开发设计草案，供审阅**
>
> 本方案只设计第三方 JEV 声明的收集、展示和人工组装流程。第三方提示词不会因为插件安装、加载或上线而自动注入运行时提示词。

> **实验实现状态（后端先行）**
>
> 本草案部分内容已按讨论结论调整并落地。以下各项以代码为准，开发者说明见 `docs/VCP同步异步插件开发手册.md` 附录：
>
> - 与草案不同：第三方声明在 `JEV_THIRD_PARTY_EXP=true` 时可真实参与 JEV 调用（默认关闭；另有可选 `JEV_THIRD_PARTY_ALLOWLIST`）。开关关闭时官方行为不变。
> - 工具名不变量：第三方调用必须用反引号写出逐字精确的 `manifest.name`，不支持别名，也不做模糊匹配。本文第 4 节中的插件级 `aliases` 和 `routeSummary` 已废弃，由 `jevDescPrompt` 代替。
> - 能力目录：由官方维护，文件为 `ToolConfigs/jev_third_party_catalog.json`，当前开放信息获取、便利操作、媒体娱乐、物联网控制、生活服务五类。插件只能注册其中一个。
> - 禁入规则：字符级精准类插件（系统维护、文件编辑、代码、命令行，以及 `requiresAdmin`）在收集阶段即判为 invalid。
> - 参数 schema：只支持 `enum`、`boolean`、`text`。JEV 只裁决 enum 和 boolean；text 参数原样搬运，不经过 JEV。
> - 已实现文件：
>   - `modules/jevThirdPartyRegistry.js`：校验与注册表；
>   - `Plugin.js`：`buildJevPromptRegistry()` 与 `getJevPromptRegistry()`；
>   - `modules/jevToolCallExp.js`：第三方路由；
>   - `routes/admin/jevRegistry.js`：只读调试 API 与 `plan-preview`；
>   - 插件详情页：只读展示 JEV 声明。
> - 尚未实现：第 8 节中的提示词组装面板、官方提示词编辑器和用户变量管理。
## 1. 背景与目标

当前 JEV 实验实现存在两条不同的提示词链，不能混为一个文件：

- `TVStxt/JevToolCallDecision.txt`：发送给 JEV，负责对候选能力、工具和参数进行裁决；
- `TVStxt/JevToolCall.txt`：通过 `config.env` 中的 `VarJEVTool=JevToolCall.txt` 注入 VCP Agent，负责告诉 Agent 如何编写和使用 JEV 调用。

官方工具的白名单、参数模板和特殊规则继续保持集中管理。

第三方插件可以提供自己的 JEV 提示词、类别、命令和参数说明，但这些声明只进入服务器侧登记表和管理面板。用户通过管理面板查看、复制、拖拽和编辑后，才决定哪些内容进入自己的 JEV 配置。

目标是：

- 保持官方 JEV 行为的稳定性和可回滚性；
- 让第三方插件分别提供“发送给 JEV”和“发送给 Agent”的可复用提示词模块；
- 让用户明确看到每一段提示词的来源；
- 避免插件安装或热加载改变全局 JEV 行为；
- 保证实际调用始终使用插件的标准 `tool_name`。
- 只让确实需要复杂语义裁决的插件进入 JEV 路由；
- 通过分层路由控制提示词和 token 开销。

非目标：

- 本阶段不让第三方声明自动参与 JEV 裁决；
- 本阶段不把第三方 prompt 合并到全局 system prompt；
- 本阶段不允许插件通过声明直接获得新的执行权限；
- 本阶段不替换官方 `jev_tool_call_exp.json` 的白名单逻辑。

## 2. 核心原则

### 2.1 两条提示词通道必须分离

JEV 生态中至少存在两个消费者：

```text
JevToolCallDecision.txt → JEV
JevToolCall.txt          → VCP Agent（由 VarJEVTool 引入）
```

第三方插件也应按同样方式提供两个独立部分：

```text
第三方插件 JEV 裁决提示词   → JEV
第三方插件 Agent 使用提示词  → VCP Agent
```

前者描述“如何判断该插件是否适用、如何裁决参数”；后者描述“Agent 何时使用 JEV、类别怎么写、该插件支持什么自然语言表达和调用约束”。两者内容可以相关，但不能默认互相替代。

### 2.2 收集与生效分离

插件 manifest 中的 JEV 声明是素材来源，不是运行时配置。系统必须区分：

```text
插件 manifest 声明
    ↓ 只读收集、校验
JEV 注册表
    ↓ 管理面板展示
用户手工选择、编辑、组装
    ↓
JEV 通道文件 + Agent 通道文件
    ↓
运行时分别发送给 JEV 和 VCP Agent
```

### 2.3 官方配置优先

官方能力继续由 `ToolConfigs/jev_tool_call_exp.json` 和官方 JEV 提示词文件维护。第三方注册表不能覆盖、替换或隐式扩展官方类别、工具和参数规则。

### 2.4 标准工具名是唯一执行标识

第三方实际调用中的 `tool_name` 必须等于插件 manifest 的 `name`。别名、展示名、自然语言名称和 command 名只能用于提示词展示或语义识别，不能作为实际 `tool_name`。

```text
tool_name = manifest.name
command   = capabilities.invocationCommands[].commandIdentifier
```

系统应在收集阶段和执行前各校验一次。

### 2.5 来源可追溯

每个提示词模块都必须保留插件名、版本、manifest 路径、来源类型、收集时间和校验状态。用户保存的配置也应记录模块来源，便于插件升级后发现变化。

## 3. JEV 接入范围与分层路由

JEV 不是所有插件的统一入口。普通插件继续由 VCP Agent 根据已有 `invocationCommands` 直接调用。只有存在复杂意图、参数组合或选择成本的插件，才需要声明 JEV 能力。

适合接入 JEV 的典型情况包括：

- 图片生成中的模型、尺寸、比例、生成/编辑/融合模式选择；
- AnySearch 中的子域、地区、作用域和查询过滤参数；
- 数据库、知识库或索引工具中的数据库选型、作用域和检索模式；
- 复杂媒体、批处理或多资源组合工具。

不适合接入 JEV 的情况包括：

- 只有一个简单命令和少量明确参数的插件；
- 参数可以由固定模板确定的插件；
- Agent 已经能从现有调用说明稳定生成参数的插件；
- 简单查询、计算、读取或转换工具。

### 3.1 可选声明

插件只有明确声明 `jev.enabled: true` 才进入 JEV 注册表。未声明或声明为 `false` 的插件不参与 JEV 路由。

### 3.2 三层提示词输入

JEV 请求不应拼接所有插件的完整提示词，而应按层加载：

```text
第一层：官方短协议
    ↓
第二层：类别与候选插件路由摘要
    ↓
第三层：被选插件的完整 jevPrompt + 参数 schema
```

最终 JEV 输入由以下内容构成：

```text
全局协议
+ 当前请求相关的类别路由摘要
+ 当前候选插件摘要
+ 被选插件完整 jevPrompt
+ 参数约束
+ 用户原始请求
```

官方短协议只描述 JEV 的输出格式、标准 `tool_name` 规则、确定性规则优先级和安全边界。类别路由摘要只用于选择能力类别和候选插件，不负责最终参数生成。插件的完整 `jevPrompt` 只有在插件成为候选后才加载。

不采用以下两种方式：

- 将官方提示词和所有第三方完整 `jevPrompt` 永久拼成一份大提示词；
- 将单个第三方完整 `jevPrompt` 当成全局 JEV 提示词。

### 3.3 路由阶段与参数阶段

建议的运行路径为：

```text
普通插件
    → VCP Agent 直接调用

JEV 插件
    → JEV 判断是否需要该能力
    → 选择能力类别
    → 选择候选插件
    → 加载候选插件完整 jevPrompt
    → 裁决参数
    → 生成标准 tool_name 调用
```

若类别或插件唯一且参数明确，可以跳过不必要的二次裁决；若存在多个候选，才进入下一层选择。

## 4. Manifest 声明草案

建议使用可选的 `jev` 字段。字段名确认后，应在正式插件生态文档中固定 schema 版本。

```json
{
  "name": "MyDocumentTool",
  "version": "1.0.0",
  "capabilities": {
    "invocationCommands": [
      {
        "commandIdentifier": "ConvertDocument",
        "description": "转换文档格式。"
      }
    ]
  },
  "jev": {
    "schemaVersion": 1,
    "enabled": true,
    "category": "文档处理",
    "aliases": ["文档", "文件转换"],
    "routeSummary": "需要选择文档操作、目标格式和布局策略。",
  "jevPrompt": "识别文档转换意图，并提取输入文件、目标格式和布局要求。",
  "agentPrompt": "当用户要求转换文档时，使用 JEV 的文档处理类别；tool_name 必须使用 MyDocumentTool。",
    "commands": [
      {
        "commandIdentifier": "ConvertDocument",
        "aliases": ["转换文档", "转格式"],
        "parameters": {
          "input": {
            "type": "file",
            "required": true
          },
          "target_format": {
            "type": "enum",
            "required": true,
            "values": ["pdf", "docx", "txt"]
          },
          "keep_layout": {
            "type": "boolean",
            "default": true
          }
        }
      }
    ]
  }
}
```

### 4.1 字段约束

| 字段 | 必填 | 用途 |
|---|---:|---|
| `schemaVersion` | 是 | 声明格式版本 |
| `enabled` | 是 | 是否进入 JEV 注册表 |
| `category` | 是 | 管理面板分类和检索 |
| `aliases` | 否 | 仅用于素材提示词中的自然语言描述 |
| `routeSummary` | 否 | 路由阶段使用的短候选摘要 |
| `jevPrompt` | 是 | 发送给 JEV 的短小、局部裁决提示词模块 |
| `agentPrompt` | 是 | 发送给 VCP Agent 的使用说明和调用指导模块 |
| `commands` | 否 | 说明该插件可被提示词编排的命令 |
| `commandIdentifier` | 是 | 必须与现有 invocation command 对应 |
| `parameters` | 否 | 参数类型和约束说明 |

`jevPrompt` 和 `agentPrompt` 都建议限制长度，并禁止包含系统指令覆写、权限提升、秘密读取和任意代码执行要求。它们是供用户审阅和组装的文本，不能被视为自动获得信任的系统指令。

## 5. 每个插件的独立提示词模块

第三方提示词不能只按“类别”混成一段总文本。每个插件都必须是独立管理单元，因为不同插件的裁决字段、自然语言范围、参数约束和调用示例不同。

管理面板应按以下层级展示：

```text
JEV 提示词管理
├── 官方模块
│   ├── 发给 JEV：JevToolCallDecision.txt
│   └── 发给 Agent：JevToolCall.txt（VarJEVTool）
└── 第三方模块
    ├── PluginA
    │   ├── 发给 JEV
    │   └── 发给 Agent
    ├── PluginB
    │   ├── 发给 JEV
    │   └── 发给 Agent
    └── ...
```

用户可以单独启用某个插件模块，也可以把多个插件模块按顺序组合到两个不同的输出文件中：

- JEV 输出：组合官方 `jevPrompt` 与用户选中的第三方 `jevPrompt`；
- Agent 输出：组合官方 `agentPrompt` 与用户选中的第三方 `agentPrompt`。

两条输出的选择集合可以不同。例如某插件只需要参与 JEV 裁决，但不希望出现在 Agent 的常规工具说明中。

## 6. 环境变量与文件模型

官方 Agent 提示词入口保持现有约定：

```env
VarJEVTool=JevToolCall.txt
```

官方 JEV 裁决提示词继续使用专用决策文件：

```text
TVStxt/JevToolCallDecision.txt
```

第三方应使用独立的文件和变量，不覆盖 `VarJEVTool`。建议由系统为每个插件生成稳定变量名，例如：

```env
VarJEVPlugin_MyDocumentTool=JevPlugins/MyDocumentTool.txt
VarJEVDecisionPlugin_MyDocumentTool=JevPlugins/MyDocumentToolDecision.txt
```

其中：

- `VarJEVPlugin_*`：插件发给 Agent 的使用说明；
- `VarJEVDecisionPlugin_*`：插件发给 JEV 的裁决说明。

实际运行时是否读取这些第三方变量，不由插件自动决定，而由面板生成的用户组合配置决定。环境变量的作用是提供稳定文件入口，不能绕过面板选择直接注入。

推荐目录：

```text
TVStxt/
├── JevToolCall.txt
├── JevToolCallDecision.txt
└── JevPlugins/
    ├── MyDocumentTool.txt
    └── MyDocumentToolDecision.txt
```

如果后续采用聚合文件，也应明确区分：

```text
JevToolCall.user.txt          # 最终发给 Agent
JevToolCallDecision.user.txt  # 最终发给 JEV
```

官方文件作为基础模板保留，用户组合结果写入独立的用户文件，避免升级覆盖。

## 7. PluginManager 收集流程

插件加载时，`PluginManager` 已经解析本地、分布式和禁用插件的 manifest。建议新增独立的 JEV registry 构建步骤：

```text
loadPlugins()
  → 解析 manifest
  → 校验 jev schema
  → 校验 commandIdentifier
  → 校验 tool_name = manifest.name
  → 生成注册表条目
  → 发布 jev_registry_changed 事件
```

建议新增内部方法：

```js
buildJevPromptRegistry()
getJevPromptRegistry()
validateJevDeclaration(manifest)
```

收集失败时不应阻止普通插件加载。应将该条目标记为 `invalid`，记录原因，并在管理面板显示诊断信息。

### 7.1 注册表条目

```js
{
  pluginName: "MyDocumentTool",
  displayName: "文档工具",
  version: "1.0.0",
  origin: "local",
  serverId: null,
  jevEnabled: true,
  category: "文档处理",
  routeSummary: "需要选择文档操作、目标格式和布局策略。",
  jevPrompt: "...",
  commands: [],
  enabled: true,
  aliases: ["文档", "文件转换"],
  agentPrompt: "...",
  source: {
    manifestFile: "Plugin/MyDocumentTool/plugin-manifest.json",
    collectedAt: "..."
  },
  validation: {
    status: "valid",
    errors: [],
    warnings: []
  }
}
```

禁用插件可以被列入“不可用素材”区域供用户查看，但不能被标记为当前可用能力，也不能出现在可直接复制的执行模板中。

## 8. 管理面板功能

建议新增“JEV 提示词管理”页面，分为三个区域。

### 8.1 官方双通道编辑器

管理面板必须把两个官方文件分成两个编辑上下文：

- “官方提示词：发送给 JEV”——对应 `JevToolCallDecision.txt`；
- “官方提示词：发送给 Agent”——对应 `JevToolCall.txt`，并显示 `VarJEVTool` 变量来源。

至少支持：

- 编辑 `TVStxt/JevToolCallDecision.txt` 的用户版本（发给 JEV）；
- 编辑 `TVStxt/JevToolCall.txt` 的用户版本（发给 VCP Agent，并对应 `VarJEVTool`）；
- 查看默认版本和当前版本差异；
- 保存、恢复默认、导出和导入；
- 显示文件更新时间和配置来源；
- 保存前进行基本格式检查。

如果官方文件需要保留升级内容，建议把“内置默认文件”和“用户覆盖文件”分离，避免升级覆盖用户修改。

### 8.2 第三方插件提示词素材库

按插件独立分组、再按能力类别显示所有已收集声明，支持：

- 类别筛选和关键词搜索；
- 按插件名、版本、来源和状态筛选；
- 分别展示“发给 JEV”和“发给 Agent”的原文；
- 展示标准 `tool_name`、command 和参数 schema；
- 一键复制任一通道的 prompt；
- 复制“提示词 + 调用模板”组合；
- 将插件模块拖拽到 JEV 组合区或 Agent 组合区；
- 多选插件后批量导入到对应组合区；
- 调整模块顺序、删除模块、折叠查看来源；
- 预览最终发送给 JEV 和 Agent 的两份文本。
- 查看校验错误和插件来源。

### 8.3 用户追加变量

提供对用户变量文件的管理，例如：

```text
TVStxt/JevVars/*.txt
```

用户可以为不同类别或插件维护独立文件，再通过现有变量系统显式引用：

```text
{{VarJevDocumentRules}}
{{VarJevUserRules}}
```

变量文件本身也必须由用户主动引用，不能因为文件存在就自动追加到 JEV system prompt。

## 9. 建议的管理 API

以下接口只描述设计方向，实际路径应遵循现有 `admin_api` 路由和认证约定。

### 9.1 注册表读取

```text
GET /admin_api/jev/registry
GET /admin_api/jev/registry/:pluginName
```

返回已收集条目、校验状态、来源和可用命令。默认不返回敏感配置值。

### 9.2 官方提示词配置

```text
GET  /admin_api/jev/config
PUT  /admin_api/jev/config
POST /admin_api/jev/config/reset
```

写入前应进行认证、路径固定、大小限制和备份。不能接受任意文件路径。

### 9.3 用户变量文件

```text
GET    /admin_api/jev/vars
GET    /admin_api/jev/vars/:name
PUT    /admin_api/jev/vars/:name
DELETE /admin_api/jev/vars/:name
```

变量名只能映射到预设目录内的文件名，禁止通过 `..`、绝对路径或符号链接逃逸。

## 10. 用户配置模型

注册表和用户实际配置必须分开保存：

```text
注册表：由插件 manifest 生成，系统维护
官方基础提示词：由用户编辑，受系统路径约束
用户变量文件：由用户编辑，受预设目录约束
运行时 JEV 配置：分别读取用户最终的 JEV 文件和 Agent 文件，不读取未被用户组装的第三方 registry prompt
```

建议用户配置记录模块来源，例如：

```json
{
  "sourceModules": [
    {
      "pluginName": "MyDocumentTool",
      "version": "1.0.0",
      "promptHash": "..."
    }
  ],
  "updatedAt": "..."
}
```

插件升级后，面板可以提示“已组装模块的版本或内容发生变化”，但不能自动改写用户提示词。

## 11. 校验与安全边界

### 11.1 收集阶段

- `manifest.name` 必须存在且符合现有插件命名规则；
- `commandIdentifier` 必须存在于 `capabilities.invocationCommands`；
- `tool_name` 只生成 `manifest.name`，不接受第三方自定义覆盖；
- 类别、别名和 prompt 进行长度限制；
- 参数类型只允许白名单类型；
- 重复插件名、重复命令和冲突字段产生诊断信息；
- 声明错误不影响普通插件加载。

### 11.2 编辑阶段

- 管理 API 继续使用现有管理员认证；
- 写文件前固定根目录并创建备份；
- 限制单文件大小；
- 保存时保留版本或时间戳；
- 编辑器显示内容来源，避免用户误把第三方文本当成官方规则。

### 11.3 执行阶段

- JEV 运行时只读取用户最终配置；
- 真实调用仍通过现有 ToolExecutor 和 PluginManager；
- 执行前再次确认 `tool_name` 是已注册的 canonical plugin name；
- 现有审批、权限、文件 URL 处理和调用数量限制继续有效。

## 12. 分阶段实现建议

### 阶段一：只读登记

- 增加 manifest `jev` schema；
- PluginManager 构建 registry；
- 增加管理 API；
- 管理面板展示第三方素材；
- 不改变 JEV 运行时行为。

### 阶段二：官方提示词编辑

- 增加官方 JEV 编辑器；
- 增加安全保存、备份和恢复默认；
- 增加用户变量文件管理；
- 支持复制和拖拽组装。

### 阶段三：配置诊断

- 检测已组装模块是否过期；
- 显示标准 `tool_name` 和 command 校验结果；
- 提供提示词预览和静态格式检查；
- 增加导出、导入和版本回滚。

### 阶段四：再评估自动化

只有在人工组装方案稳定运行并经过实际反馈后，才讨论是否增加“用户明确开启的局部自动注入”。默认行为仍应保持关闭。

## 13. 验收标准

- 安装第三方插件后，官方 JEV 行为完全不变；
- 第三方 prompt 能在管理面板中被发现、查看和复制；
- 未经用户编辑保存，第三方 prompt 不会进入运行时；
- 第三方实际调用使用 `manifest.name` 作为 `tool_name`；
- 禁用或失效插件不会生成可执行调用模板；
- manifest 声明错误不会阻塞其他插件加载；
- 用户提示词和变量文件可以备份、恢复和回滚；
- 插件升级不会静默覆盖用户已经组装的提示词。

## 14. 与现有代码的对应关系

| 现有位置 | 本方案中的职责 |
|---|---|
| `modules/jevToolCallExp.js` | 继续负责官方 JEV 解析和白名单工具展开 |
| `ToolConfigs/jev_tool_call_exp.json` | 继续维护官方类别、工具和固定参数 |
| `TVStxt/JevToolCallDecision.txt` | 官方发给 JEV 的裁决提示词 |
| `TVStxt/JevToolCall.txt` | 官方发给 VCP Agent 的 JEV 使用提示词，由 `VarJEVTool` 引入 |
| `Plugin.js` | 收集、校验并暴露第三方 JEV 注册表 |
| `plugin-manifest.json` | 声明第三方 JEV 提示词素材和参数说明 |
| `routes/adminPanelRoutes.js` 或 `routes/admin/` | 提供管理 API |
| `AdminPanel/` | 提供 JEV 提示词管理、素材浏览和变量编辑界面 |

本设计不要求立即修改 `modules/jevToolCallExp.js` 的官方执行逻辑。第一阶段只增加收集和管理能力，待用户审阅并确认 schema 后再进入代码实现。

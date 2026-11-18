# JEV 语义工具调用：未来架构蓝图

> **文档性质：未来研究与架构规划**
>
> 本文不代表当前实现，不构成兼容性承诺，也不要求近期落地。
>
> 当前实验实现见 `docs/JEV_SEMANTIC_TOOL_CALL_EXPERIMENT.md`。
>
> 当前实验仍以 `ToolConfigs/jev_tool_call_exp.json` 作为集中式白名单；本文讨论的是实验被证明可行后，如何演化为可扩展、可审计、分级授权的正式能力系统。

---

## 1. 长期目标

JEV 语义工具调用的长期目标不是继续维护一份不断膨胀的中央工具配置，也不是把完整插件 manifest 直接丢给 Jev。

更合理的最终结构是：

```text
插件声明自身的语义能力
        ↓
主机验证声明是否合法
        ↓
中央安全策略裁剪与覆盖
        ↓
结合 Agent 身份和请求上下文授权
        ↓
编译为本次请求可见的最小能力树
        ↓
模板和确定性规则优先处理
        ↓
仅将仍未确定的有限选择交给 Jev
        ↓
生成真实工具调用计划
        ↓
继续通过 PluginManager 安全执行
```

其核心原则是：

> 插件可以声明自己“能做什么”，但不能自行决定“谁可以调用、何时可以调用、Jev 可以控制到什么程度”。

---

## 2. 插件自声明 JEV 能力

未来可以允许每个插件在自己的 `plugin-manifest.json` 中声明一个可选的 `jevCapabilities` 区域。

这比长期维护单一中央 JSON 更具扩展性：

- 插件协议与能力描述共同版本化；
- 插件作者最了解自身参数和限制；
- 新插件不需要修改核心规划器源码；
- 分布式插件可以携带同一能力声明；
- 插件字段变化时可同步更新语义适配；
- 能力可以随插件启用、禁用、上线和离线动态更新。

但插件自声明不等于插件自动获得 JEV 调用资格。

所有声明都必须经过主机侧验证和安全策略裁剪。

---

## 3. 建议的 Manifest 结构

以下仅为未来草案，不是当前正式 schema：

```json
{
  "name": "ExampleTool",
  "pluginType": "synchronous",
  "entryPoint": {
    "command": "node ExampleTool.js"
  },
  "jevCapabilities": {
    "schemaVersion": 1,
    "enabledByDefault": false,
    "categories": [
      "web_search"
    ],
    "actions": [
      {
        "id": "example.search",
        "description": "搜索公开网页资料",
        "aliases": [
          "示例搜索",
          "查找资料"
        ],
        "implicitTriggers": [
          {
            "all": [
              {
                "actionWords": [
                  "搜索",
                  "查找"
                ]
              },
              {
                "primaryRequired": true
              }
            ]
          }
        ],
        "inputContract": {
          "primary": {
            "target": "query",
            "required": true,
            "maxItems": 1
          },
          "constraints": {
            "maxItems": 5
          }
        },
        "templates": [
          {
            "id": "default",
            "fixedArgs": {
              "mode": "safe"
            },
            "bindings": {
              "query": {
                "source": "primary.0"
              }
            }
          }
        ],
        "decisions": [],
        "security": {
          "level": 1,
          "sideEffects": "read_only",
          "dataScope": "public_network"
        }
      }
    ]
  }
}
```

该结构应描述语义能力，而不是复制传统插件说明。

---

## 4. 能力声明应该包含什么

### 4.1 稳定能力 ID

每个能力应拥有稳定 ID：

```text
web.search.google
web.fetch.url
media.image.generate
memory.lightmemo.search
communication.agent.contact
system.file.write
```

能力 ID 不应直接等同于插件名。

这样可以：

- 多个插件实现同一种能力；
- 同一个插件实现多种能力；
- 插件替换时保持上层语义协议稳定；
- 为能力级权限和审计提供稳定键；
- 支持默认实现、优先级和故障降级。

### 4.2 分类

例如：

```text
web_search
image_generation
daily_tools
memory
communication
file_system
system_control
code_execution
```

分类主要用于导航和策略，不应该直接决定最终权限。

### 4.3 自然语言别名

插件可声明：

- 工具别名；
- 动作词；
- 中文和英文名称；
- 高置信度隐式触发短语；
- 明确禁止作为隐式触发的弱词。

例如“打开”本身是弱信号，而：

```text
打开 + [URL]
```

是可以接受的强组合。

### 4.4 输入槽位

插件应声明语义槽位，而不是要求主模型记忆真实参数：

```text
primary
constraints
references
target
time
count
mode
```

再由绑定规则将槽位编译为真实参数：

```text
primary.0 → query
references → image
time.0 → time_description
```

### 4.5 固定模板

模板应该承担绝大多数参数装配工作：

```json
{
  "fixedArgs": {
    "command": "search",
    "mode": "safe",
    "max_results": 5
  }
}
```

危险参数不应出现在 JEV 可见模板中。

### 4.6 有限决策

只有模板无法确定的部分，才能声明为 Jev 决策：

```json
{
  "id": "image_size",
  "type": "choice",
  "source": "constraints",
  "options": {
    "portrait": "适合竖向人物和手机壁纸",
    "landscape": "适合宽屏场景",
    "square": "适合头像和方形构图"
  },
  "fallback": "square",
  "minimumConfidence": 0.65
}
```

Jev 只能返回声明过的选项。

### 4.7 输出和副作用

插件应声明：

- 只读；
- 写文件；
- 修改数据；
- 发送消息；
- 启动进程；
- 控制桌面；
- 执行代码；
- 访问公网；
- 访问本地文件；
- 访问私有记忆；
- 产生费用；
- 不可逆操作。

这些声明是安全分级的重要输入。

---

## 5. 为什么不能只相信插件 Manifest

插件 manifest 属于插件提供方。

如果允许插件仅通过声明：

```json
{
  "security": {
    "level": 0
  }
}
```

就获得低风险权限，那么恶意或错误插件可以自行降级风险。

因此：

> 插件声明只能是安全评估输入，不能成为最终安全裁决。

最终权限必须由主机侧策略计算：

```text
插件自声明
∩ 主机风险数据库
∩ 管理员覆盖规则
∩ Agent 权限
∩ 请求来源权限
∩ 当前运行环境
∩ 人工审核策略
```

---

## 6. 中央能力编译器

未来应引入独立的 JEV 能力编译器。

它负责：

1. 收集本地插件的 `jevCapabilities`；
2. 收集分布式插件上报的能力声明；
3. 验证 schema；
4. 检查能力 ID 冲突；
5. 应用中央禁止列表；
6. 应用管理员覆盖；
7. 检查插件是否在线；
8. 计算实际风险等级；
9. 根据 Agent 身份过滤；
10. 根据请求来源过滤；
11. 生成本次请求可见的最小能力树；
12. 生成确定性匹配索引；
13. 生成 Jev 候选集合；
14. 生成审计所需的版本摘要。

编译结果应是不可变快照：

```text
CapabilitySnapshot
```

每次调用都记录使用了哪个快照版本。

---

## 7. 三类权限必须分开

未来至少需要区分三类不同权限。

### 7.1 Agent 能力权限

回答：

> 这个 Agent 是否有资格使用该能力？

例如：

```text
访客 Agent
    → 只允许公开联网搜索和计算

普通 Agent
    → 允许记忆检索、图片生成、闹钟和点歌

受信任 Agent
    → 允许文件写入、跨 Agent 通讯和桌面操作

管理员 Agent
    → 允许高风险系统维护能力
```

Agent 权限不能仅由 Agent 自己在提示词里声明。

应来自可信的服务端身份映射。

### 7.2 Jev 决策权限

回答：

> 即使 Agent 可以使用该能力，哪些参数允许由 Jev 决定？

例如：

```text
Agent 可调用图片生成
```

不代表：

```text
Jev 可以决定任意模型、费用等级、图片数量和外部回调地址
```

可以分别设置：

- Jev 可选择工具；
- Jev 可选择模板；
- Jev 可选择低风险枚举；
- Jev 不可控制费用参数；
- Jev 不可控制目标文件；
- Jev 不可控制执行主机；
- Jev 不可控制 shell 参数；
- Jev 不可控制认证信息。

### 7.3 执行权限

回答：

> 最终生成的真实调用是否允许执行？

即使前两层都通过，执行前仍应检查：

- 工具当前是否在线；
- 参数是否通过最终 schema；
- 是否需要人工审核；
- 是否超过预算；
- 是否超过并发限制；
- 是否命中禁止路径；
- 是否访问敏感资源；
- 是否满足租户和节点隔离。

---

## 8. 建议的安全等级

未来可以建立统一风险等级，例如：

| 等级 | 名称 | 示例 |
|---|---|---|
| L0 | 纯计算 | 科学计算、格式转换 |
| L1 | 公共只读 | 公网搜索、公开网页读取 |
| L2 | 私有只读 | 私有记忆、本地文档读取 |
| L3 | 低风险副作用 | 闹钟、点歌、生成图片 |
| L4 | 通讯与持久化 | Agent 通讯、写日记、创建任务 |
| L5 | 高风险修改 | 文件修改、数据库修改、桌面操作 |
| L6 | 特权执行 | Shell、系统配置、凭证相关操作 |

等级只是基础维度，不能替代更细的策略。

同为 L2：

- 读取项目公开文档；
- 读取用户私密日记；
- 读取密钥文件；

实际风险完全不同。

因此还需要能力标签。

---

## 9. 能力安全标签

建议同时使用标签：

```text
network.public.read
network.private.read
filesystem.project.read
filesystem.project.write
filesystem.external.read
memory.private.read
communication.agent.send
process.spawn
shell.execute
desktop.control
credential.access
billing.consume
irreversible
```

最终授权可写成：

```text
Agent A:
  allow:
    - network.public.read
    - memory.own.read
    - media.generate
  deny:
    - filesystem.external.read
    - shell.execute
```

---

## 10. Agent 权限模型

### 10.1 基于角色的权限

可以先使用 RBAC：

```text
guest
standard
trusted
operator
admin
```

优点是简单。

缺点是角色容易膨胀。

### 10.2 基于能力的权限

更长期的方案是 Capability-Based Security：

```json
{
  "agent": "Nova",
  "capabilities": [
    "web.search.public",
    "memory.own.search",
    "media.image.generate",
    "communication.agent.send"
  ]
}
```

能力还可以附带限制：

```json
{
  "capability": "filesystem.project.read",
  "constraints": {
    "roots": [
      "docs/",
      "knowledge/"
    ],
    "maxBytes": 1048576
  }
}
```

### 10.3 Agent 身份必须可信

`maid` 当前主要用于署名和日志。

未来如果 `maid` 参与权限判断，就不能再把用户或模型传入的字符串直接当作可信身份。

需要由服务端生成可信执行主体：

```text
ExecutionPrincipal
```

可能包含：

```json
{
  "agentId": "agent:nova",
  "sessionId": "session:...",
  "tenantId": "tenant:default",
  "source": "chat_api",
  "authenticated": true,
  "roles": [
    "trusted"
  ]
}
```

模型提供的 `maid` 只能作为展示署名，不能直接提升权限。

---

## 11. Jev 权限分级

可以为每个能力设置 Jev 控制等级。

| 等级 | Jev 可做什么 |
|---|---|
| J0 | 完全不使用 Jev，只允许模板 |
| J1 | 判断是否相关 |
| J2 | 选择低风险枚举 |
| J3 | 选择工具或模板 |
| J4 | 选择多个工具并编排只读调用 |
| J5 | 提议副作用调用，但必须人工审核 |
| J6 | 禁止自动化，仅允许人工明确构造 |

示例：

```text
SciCalculator
    → J0

图片尺寸选择
    → J2

公共搜索器选择
    → J3

多个只读搜索器并发
    → J4

发送 Agent 通讯
    → J5

Shell 执行
    → J6
```

这能避免“Agent 有权限”被错误理解为“Jev 有权自由规划全部参数”。

---

## 12. 隐式触发也必须分级

未来 manifest 可以声明隐式触发，但主机必须审核。

例如：

```json
{
  "implicitTrigger": {
    "level": "strong",
    "all": [
      {
        "action": "open"
      },
      {
        "slot": "url",
        "required": true
      }
    ]
  }
}
```

高风险工具不应允许隐式触发。

建议：

| 风险等级 | 隐式触发 |
|---|---|
| L0-L1 | 可允许强规则触发 |
| L2 | 仅限明确目标和受控范围 |
| L3 | 可触发，但需明显动作词 |
| L4 | 默认要求显式工具或目录 |
| L5-L6 | 禁止隐式触发 |

---

## 13. 本地文件读取的未来策略

以 UrlFetch 读取本地文件为例：

```text
打开[file://C:\Tsubasa\VCPToolbox\Plugin\DailyHot\dailyhot_cache.md]
```

当前实验规划层会把它编译为：

```text
UrlFetch
url = file://...
mode = text
```

真实执行仍由现有文件 URL 解析和插件安全链处理。

未来正式安全模型中，应增加：

- 允许读取的根目录；
- 路径规范化；
- 符号链接逃逸检查；
- UNC 路径限制；
- 驱动器范围限制；
- 文件扩展名限制；
- 最大文件大小；
- 敏感目录禁止列表；
- Agent 对该目录的读取权限；
- 分布式节点文件归属检查；
- 读取行为审计。

不能因为它是 `file://` 就默认允许访问整个文件系统。

---

## 14. 分布式插件能力

分布式工具不能只上报：

```text
工具名 + 描述
```

未来应上报：

- 能力声明；
- schema 版本；
- 插件版本；
- 节点身份；
- 节点信任等级；
- 能力签名；
- 风险声明；
- 数据驻留位置；
- 是否支持取消；
- 超时和并发限制。

中央服务器应把分布式能力视为不可信输入。

只有通过信任策略的声明才能进入能力树。

节点断线后，对应能力应立即从新快照移除。

---

## 15. 管理员覆盖层

即使插件声明完整，也必须支持中央覆盖：

```json
{
  "capabilityOverrides": {
    "communication.agent.send": {
      "enabled": true,
      "minimumAgentLevel": 3,
      "maximumJevLevel": "J5",
      "requiresApproval": true
    },
    "shell.execute": {
      "enabled": false
    }
  }
}
```

管理员应能：

- 禁用能力；
- 修改别名；
- 删除隐式触发；
- 提高风险等级；
- 降低 Jev 权限；
- 强制人工审核；
- 限制 Agent；
- 限制目录或域名；
- 设置预算；
- 设置速率；
- 设置并发；
- 固定默认工具；
- 禁止分布式实现。

管理员可以提高限制，但插件不能自行降低中央限制。

---

## 16. 能力解析与冲突

多个插件可能声明同一能力：

```text
web.search.general
```

编译器需要处理：

- 默认实现；
- 优先级；
- 成本；
- 延迟；
- 在线状态；
- Agent 权限；
- 地区可用性；
- 数据隐私；
- 显式用户选择；
- 故障降级。

不建议直接让 Jev 在几十个同质插件中自由选择。

可以先由代码过滤：

```text
合法
∩ 在线
∩ 有权限
∩ 未超预算
∩ 满足地区要求
```

然后再让 Jev 在少量候选中做语义选择。

---

## 17. 参数绑定语言

未来可以设计一个受限、无执行能力的绑定 DSL：

```json
{
  "bindings": {
    "query": {
      "source": "primary.0",
      "transform": "trim"
    },
    "images": {
      "source": "references",
      "transform": "unique"
    },
    "count": {
      "source": "constraints.count",
      "default": 5,
      "clamp": [
        1,
        10
      ]
    }
  }
}
```

允许的转换必须是内置白名单：

```text
trim
lowercase
uppercase
join
unique
integer
boolean
clamp
enum
url
fileUrl
date
duration
```

manifest 不应允许嵌入任意 JavaScript 表达式，否则能力声明会变成新的代码执行面。

---

## 18. 决策预算

未来每个能力应声明决策预算：

```json
{
  "decisionBudget": {
    "maxJevCalls": 1,
    "maxQuestions": 8,
    "maxCandidates": 20,
    "timeoutMs": 3000,
    "fallback": "template"
  }
}
```

全局也应设置请求预算：

```text
单个 JEV 工具块最多调用 Jev 一次
单次对话循环最多调用 Jev 两次
单次最多展开五个真实工具
副作用工具最多一个
```

避免能力树扩张后产生决策风暴。

---

## 19. 能力快照与缓存

编译结果可以缓存为：

```text
JevCapabilitySnapshot
```

快照 Hash 应覆盖：

- 插件版本；
- 能力声明；
- 中央覆盖；
- Agent 权限；
- 节点在线状态；
- 安全策略版本。

只有 Hash 变化时才重建。

请求日志记录：

```text
capabilitySnapshotId
policyVersion
principalId
selectedCapabilityId
selectedImplementation
jevDecisions
fallbacks
approvalResult
```

这样才能复盘一次自然语言调用为何落到某个真实插件。

---

## 20. 审计事件

未来建议新增结构化事件：

```text
JEV_INTENT_PARSED
JEV_CATEGORY_INFERRED
JEV_CAPABILITY_FILTERED
JEV_DECISION_REQUESTED
JEV_DECISION_FALLBACK
JEV_PLAN_COMPILED
JEV_PLAN_DENIED
JEV_APPROVAL_REQUIRED
JEV_EXECUTION_STARTED
JEV_EXECUTION_FINISHED
```

审计日志不应泄露：

- API Key；
- 私密文件正文；
- 完整凭证；
- 未脱敏通讯内容；
- 私有记忆全文。

---

## 21. 人工审核的关系

JEV 权限系统不替代人工审核。

建议顺序：

```text
语义解析
    ↓
能力权限过滤
    ↓
Jev 有限决策
    ↓
生成调用计划
    ↓
最终参数校验
    ↓
人工审核判断
    ↓
PluginManager 执行
```

人工审核应该看到：

- 原始自然语言；
- 推断能力；
- Jev 选择；
- 真实工具；
- 最终参数；
- 风险等级；
- 副作用摘要；
- 文件或通讯目标；
- 为什么需要审核。

---

## 22. 失败策略

未来每个能力应明确失败策略：

```text
deny
fallback_default
fallback_tool
ask_user
require_explicit
require_approval
```

例如：

- 模糊图片尺寸：回退默认值；
- 模糊搜索器：回退默认搜索器；
- 模糊文件路径：拒绝；
- 模糊通讯目标：要求明确；
- 模糊 shell 操作：拒绝；
- 权限不足：拒绝，不允许换工具绕过。

---

## 23. Schema 版本与迁移

如果能力声明进入正式 manifest，必须版本化：

```json
{
  "schemaVersion": 1
}
```

主机应：

- 拒绝未知高版本；
- 对旧版本提供有限迁移；
- 输出弃用警告；
- 提供 schema 验证工具；
- 在插件商店发布前检查；
- 对安全字段采用 fail-closed。

实验阶段不应急于冻结 schema。

应先积累足够多的真实插件样本，再提炼稳定字段。

---

## 24. 插件商店与签名

未来插件商店可以检查：

- JEV 能力 ID 是否规范；
- 是否声明副作用；
- 是否暴露危险参数；
- 是否错误标低风险；
- 隐式触发是否过宽；
- 是否包含任意代码绑定；
- 默认模板是否安全；
- 是否存在未声明网络访问；
- 是否存在权限升级路径。

经过审核的能力声明可以签名。

本地未签名插件默认采用更严格策略。

---

## 25. 推荐迁移阶段

### 阶段 0：当前实验

- 中央硬编码 JSON；
- 少量工具；
- 模板优先；
- Jev 只处理少量有限选择；
- 不保证兼容。

### 阶段 1：旁路声明

- 插件可选声明 `jevCapabilities`；
- 核心只读取并展示；
- 不自动执行；
- 与中央实验配置对照验证。

### 阶段 2：能力编译器

- 校验插件声明；
- 编译统一能力树；
- 中央配置仍拥有最终控制权；
- 低风险能力开始使用编译结果。

### 阶段 3：Agent 权限

- 引入可信执行主体；
- 建立 Agent 能力授权；
- `maid` 与权限身份分离；
- 加入能力快照和审计。

### 阶段 4：Jev 权限分级

- 对工具选择、模板选择、参数选择分别授权；
- 引入 J0-J6；
- 副作用调用默认审核。

### 阶段 5：分布式和插件商店

- 能力声明签名；
- 节点信任；
- 插件商店自动检查；
- 动态上线和离线。

### 阶段 6：逐步替代传统工具栈

- 主模型默认只看到语义入口；
- 完整工具说明降级为兼容模式；
- 高风险工具继续使用显式协议；
- 传统调用长期保留作为调试和逃生通道。

---

## 26. 不建议的做法

### 26.1 不要自动暴露所有 manifest 参数

这会重新制造提示词膨胀和危险参数暴露。

### 26.2 不要让插件自报低风险后自动生效

风险等级必须由中央策略确认。

### 26.3 不要让 Jev 生成任意 JSON

Jev 应在有限候选中选择。

### 26.4 不要把 Agent 署名当作可信权限身份

模型可生成任意 `maid` 字符串。

### 26.5 不要对高风险能力开放宽松隐式触发

Shell、文件写入和系统控制必须保持显式。

### 26.6 不要绕过 PluginManager

JEV 负责计划，现有执行链负责安全执行。

### 26.7 不要过早冻结 schema

当前仍处于发现问题空间的阶段。

---

## 27. 一个可能的最终调用过程

```text
Agent 输出自然语言 JEV 请求
        ↓
解析语义锚点
        ↓
构建可信 ExecutionPrincipal
        ↓
加载 CapabilitySnapshot
        ↓
按 Agent 权限过滤能力
        ↓
按风险和请求来源继续过滤
        ↓
确定性规则匹配
        ↓
必要时进行受限 Jev 决策
        ↓
编译统一 ToolPlan
        ↓
验证参数与预算
        ↓
人工审核（如需要）
        ↓
PluginManager 执行
        ↓
记录完整审计链
```

统一计划可以类似：

```json
{
  "planVersion": 1,
  "principalId": "agent:nova",
  "capabilityId": "communication.agent.send",
  "implementation": "AgentAssistant",
  "riskLevel": "L4",
  "jevLevel": "J5",
  "args": {
    "agent_name": "小娜",
    "prompt": "我是Nova，请检查方案"
  },
  "requiresApproval": true,
  "capabilitySnapshotId": "sha256:..."
}
```

---

## 28. 结论

长期最优解很可能确实是：

> 每个插件在自己的 manifest 中声明 JEV 语义能力，核心系统把这些声明编译成受中央策略控制的能力树。

但必须补全后半句：

> 插件只声明能力，主机负责验证；Agent 权限决定能否使用，Jev 权限决定能控制到哪一步，最终执行权限和人工审核决定调用是否真正发生。

因此未来正式架构不应是：

```text
插件 manifest
    → Jev
    → 直接执行
```

而应是：

```text
插件能力声明
    → schema 验证
    → 中央安全覆盖
    → Agent 权限过滤
    → Jev 权限过滤
    → 有限决策
    → 最终执行校验
    → PluginManager
```

这条路线既保留插件生态的自治扩展能力，又避免把整个系统的执行权限交给插件作者、Agent 提示词或 Jev 决策模型。
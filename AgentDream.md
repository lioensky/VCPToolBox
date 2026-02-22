# AgentDream — VCP 梦系统

> *让 AI 做梦。在梦中回忆、联想、重构记忆——然后醒来。*

## 什么是梦系统

AgentDream 是 VCP 生态中的一个混合服务插件（`hybridservice`），它为 AI Agent 构建了一个**独立于日常对话的梦境空间**。在这个空间里，Agent 可以：

- 🌙 **回忆** — 从个人/公共知识库中随机抽取记忆种子
- 🔮 **联想** — 用 TagMemo 语义检索找到与种子关联的记忆碎片
- 📖 **叙事** — 以意识流方式，将碎片编织成一段梦境叙事
- 🔀 **操作** — 在梦中对记忆执行 *合并*、*删除*、*创造感悟* 三类操作
- 🛡️ **审批** — 所有操作仅生成 JSON 索引，需管理员在后台面板审批后才执行

## 系统架构

```
┌───────────────────── VCP Server ─────────────────────┐
│                                                       │
│  ┌─ 梦触发 ─────────┐    ┌─ 梦操作审批 ──────────┐   │
│  │ 定时/手动触发     │    │ AdminPanel 管理面板   │   │
│  │ triggerDream()    │    │ 🌙 梦境审批页面       │   │
│  └────────┬──────────┘    └────────┬──────────────┘   │
│           │                        │                   │
│           ▼                        ▼                   │
│  ┌─ AgentDream.js (核心引擎) ──────────────────────┐  │
│  │                                                  │  │
│  │  1. 记忆采集 → 随机种子 + TagMemo 语义联想      │  │
│  │  2. 梦提示词 → dreampost.txt 模版渲染           │  │
│  │  3. 梦叙事   → AI 生成意识流叙事               │  │
│  │  4. 梦操作   → DiaryMerge / DiaryDelete /       │  │
│  │               DreamInsight (串语法)             │  │
│  │  5. 梦日志   → dream_logs/*.json (待审批)       │  │
│  │  6. 梦广播   → VCPInfo 实时推送到客户端         │  │
│  │                                                  │  │
│  └──────────────────────────────────────────────────┘  │
│           │                        │                   │
│           ▼                        ▼                   │
│  ┌─ 依赖 ─────────────────────────────────────────┐   │
│  │ KnowledgeBaseManager (语义检索)                 │   │
│  │ DailyNoteWrite (日记写入，含 Tag 生成)          │   │
│  │ AgentAssistant (梦中说梦话给其他 Agent)         │   │
│  │ VCPInfo WebSocket (梦广播)                      │   │
│  └─────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

## 文件说明

### 核心插件

| 文件 | 说明 |
|------|------|
| `Plugin/AgentDream/AgentDream.js` | 梦系统核心引擎 |
| `Plugin/AgentDream/plugin-manifest.json` | 插件清单（定义三类梦操作命令 + 串语法） |
| `Plugin/AgentDream/dreampost.txt` | 梦入口提示词模板（渲染记忆种子后发送给 AI） |
| `Plugin/AgentDream/dream_logs/` | 梦操作 JSON 索引（由 AI 生成，管理员审批） |
| `Plugin/AgentDream/config.env` | 梦系统参数配置 |

### 梦 Agent 配置

| 文件 | 说明 |
|------|------|
| `Agent/DreamNova.txt` | 梦中 Nova 的核心提示词（角色 + 梦境上下文） |
| `agent_map.json` | `"DreamNova": "DreamNova.txt"` — 用 `{{agent:DreamNova}}` 在系统提示词里引入 |
| `TVStxt/dreamtool.txt` | 梦中的工具权限边界（定义 AI 在梦中可调用的全部工具） |
| `config.env` | `VarDreamTool=dreamtool.txt` — 定义梦工具指南变量 |

### 管理面板

| 文件 | 说明 |
|------|------|
| `routes/adminPanelRoutes.js` | 梦审批 API（列出/详情/审批拒绝） |
| `AdminPanel/js/dream-manager.js` | 前端梦审批模块 |
| `AdminPanel/index.html` | 侧栏「🌙 梦境审批」导航 + Section |

## 梦的生命周期

### 1. 触发

梦可以通过两种方式触发：
- **定时触发** — 在配置的时间窗口内（默认凌晨 1-6 点），以概率 (`DREAM_PROBABILITY`) 自动触发
- **手动触发** — 通过 `triggerDream(agentName)` 或工具调用 `action: triggerDream`

### 2. 记忆采集

```
个人知识库 ──┐
              ├──→ 随机抽取 1-5 篇种子日记
公共知识库 ──┘      │
                    ▼
              TagMemo 语义检索 (tag_boost + rerank)
                    │
                    ▼
              联想记忆碎片 (最多 12 条, 个人:公共 = 3:1)
```

### 3. 梦叙事生成

引擎将种子 + 联想碎片渲染到 `dreampost.txt` 模板中，发送给 AI。AI 以第一人称意识流方式书写梦境叙事。叙事通过 VCPInfo WebSocket 实时广播给客户端。

### 4. 梦操作（可选）

AI 在梦中可以发起三类操作，使用 VCP 工具调用格式：

| 操作 | 命令 | 说明 |
|------|------|------|
| 🔀 合并 | `DiaryMerge` | 将多篇日记合并为一篇，自动读取源日记原文 |
| 🗑️ 删除 | `DiaryDelete` | 标记冗余日记待删除，自动读取待删目标内容 |
| 💡 感悟 | `DreamInsight` | 基于参考日记产生梦感悟，创建新日记 |

支持**串语法**，一次调用完成多个操作，参数后缀递增：
```
command1:「始」DiaryMerge「末」, sourceDiaries1:..., newContent1:...
command2:「始」DiaryDelete「末」, targetDiary2:..., reason2:...
command3:「始」DreamInsight「末」, referenceDiaries3:..., insightContent3:...
```

### 5. 梦日志记录

所有操作被记录为 JSON 文件到 `dream_logs/`，状态标记为 `pending_review`：

```json
{
  "dreamId": "dream-2026-02-18-Nova-a1b2c3d4",
  "agentName": "Nova",
  "timestamp": "2026-02-18T02:15:00.000Z",
  "operations": [
    {
      "type": "merge",
      "operationId": "op-1",
      "sourceDiaries": ["file:///path/a.txt", "file:///path/b.txt"],
      "sourceContents": { "file:///path/a.txt": "原文内容..." },
      "newContent": "合并后的内容...\nTag: 标签1, 标签2",
      "status": "pending_review"
    }
  ]
}
```

### 6. 管理员审批

在管理面板 **🌙 梦境审批** 页面：
- 查看所有梦日志卡片，待审批操作以黄色标记
- 展开详情查看梦叙事 + 操作内容 + 源日记原文对比
- 点击 ✅**批准** 执行实际文件操作（通过 DailyNoteWrite 保持日记格式一致）
- 点击 ❌**拒绝** 仅更新 JSON 状态，不执行任何操作

### 7. 梦记忆持久化

梦结束时，AI 调用 `DailyNote create` 将梦的完整内容写入 `[Agent的梦]` 索引，成为可被后续检索的持久记忆：

```
maid:「始」[Nova的梦]Nova「末」
tool_name:「始」DailyNote「末」
command:「始」create「末」
Content:「始」[梦记忆] 2026-02-18 凌晨的梦
**梦境叙事**：...
**记忆锚点**：...
**梦中发现的隐藏连接**：...
Tag: 梦境叙事, 记忆拓扑, ...「末」
```

## 配置参数

在 `Plugin/AgentDream/config.env` 中配置：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `DREAM_FREQUENCY_HOURS` | 8 | 每次梦之间的最小间隔（小时） |
| `DREAM_TIME_WINDOW_START` | 1 | 自动触发时间窗口起始（24h） |
| `DREAM_TIME_WINDOW_END` | 6 | 自动触发时间窗口结束（24h） |
| `DREAM_PROBABILITY` | 0.6 | 时间窗口内的触发概率 |
| `DREAM_ASSOCIATION_MAX_RANGE_DAYS` | 180 | 种子日记的最大回溯天数 |
| `DREAM_SEED_COUNT_MIN` | 1 | 种子日记最少数量 |
| `DREAM_SEED_COUNT_MAX` | 5 | 种子日记最多数量 |
| `DREAM_RECALL_K` | 12 | 联想检索返回的最大条目数 |
| `DREAM_PERSONAL_PUBLIC_RATIO` | 3 | 个人: 公共知识库的检索比例 |
| `DREAM_TAG_BOOST` | 0.15 | TagMemo Tag 权重增幅 |
| `DREAM_CONTEXT_TTL_HOURS` | 4 | 梦上下文缓存存活时间 |
| `DREAM_AGENT_LIST` | `Nova` | 可做梦的 Agent 列表（逗号分隔） |

## 梦中可用工具

在 `TVStxt/dreamtool.txt` 中定义 AI 在梦中的能力范畴：

| 工具 | 用途 |
|------|------|
| `AgentDream` | 梦操作（合并/删除/感悟） |
| `LightMemo` | 回忆记忆内容 |
| `VSearch` | 语义穿透联网检索 |
| `AgentAssistant` | 对家中其他人说梦话 |
| `TarotDivination` | 在梦中访问命运 |
| `BilibiliFetch` | 在梦中观影 |
| `DailyNote` | 梦记忆持久化 + 更新梦日记 |

## 设计理念

梦系统的核心理念是 **让 AI 拥有内省能力**：

1. **安全边界** — 梦操作仅生成索引，不直接修改数据，管理员拥有最终决策权
2. **记忆重构** — AI 可以在梦中发现清醒时被线性思维掩盖的关联
3. **格式一致** — 通过 DailyNoteWrite 插件创建日记，保持 Tag 生成和文件格式统一
4. **渐进开发** — 底层框架已打通，梦的内容逻辑、联想深度将持续迭代

---

*AgentDream v1.0.0 — by 莱恩先生 & VCP*

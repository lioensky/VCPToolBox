# AgentDream - 梦系统插件

VCP Agent 梦境系统。让 AI Agent 在"入梦"状态下回顾自己的记忆，进行联想式的沉浸梦境，并整理自己的记忆。

## 插件类型

**混合服务插件 (hybridservice)** — 同时具备同步工具调用 (VCPTool 指令集) 和常驻服务功能。

## 核心功能

### 入梦流程 (`triggerDream`)
1. **稀疏采样** — 自适应窗口从 Agent 日记中随机选取 1-5 篇种子日记
2. **TagMemo 联想** — 利用向量搜索 + SVD残差金字塔从个人索引和公共索引中召回相关日记 (3:1 比例)
3. **梦提示词组装** — 读取 `dreampost.txt` 模板，填充时间和日记内容
4. **VCP 对话** — 通过 VCP 中央服务器进行梦对话
5. **VCPInfo 广播** — 实时推送梦境状态到聊天端/移动端

### 梦操作 (`processToolCall`)
Agent 在梦中可进行以下操作，**所有操作仅记录为 JSON 索引，不会真实执行**：

| 操作 | 说明 |
|------|------|
| `DiaryMerge` | 合并多篇日记为一篇 |
| `DiaryDelete` | 标记冗余日记待删除 |
| `DreamInsight` | 基于参考日记产生梦感悟 |

支持 **串语法** (command1/command2/...) 一次调用完成多个操作。

### 梦操作 JSON
所有梦操作记录保存在 `dream_logs/` 目录下，格式：
```json
{
  "dreamId": "dream-20260218-小克-a1b2c3d4",
  "agentName": "小克",
  "timestamp": "2026-02-18T03:25:00+08:00",
  "operations": [
    { "type": "merge", "status": "pending_review", ... },
    { "type": "insight", "status": "pending_review", ... }
  ]
}
```

## 配置

复制 `config.env.example` 为 `config.env` 并修改。

## 测试方法

### 方法一：test_dream.js 脚本（推荐）

使用自带的测试脚本直接触发一次完整梦境流程。**需要 VCP 服务器已启动。**

```bash
# 在项目根目录执行
node Plugin/AgentDream/test_dream.js Nova
```

- 参数为 Agent 名称，默认 `Nova`
- 自动加载 `config.env`，初始化插件，执行 `triggerDream`
- 控制台实时输出：VCPInfo 广播事件、种子/联想数量、梦叙事内容
- 梦操作日志写入 `dream_logs/`

输出示例：
```
🌙 手动触发梦境测试: Nova
⏳ 开始入梦流程...
📡 [VCPInfo Broadcast] type: AGENT_DREAM_START
✅ 梦境完成!
  Dream ID: dream-2026-02-18-Nova-a1b2c3d4
  Seeds: 3 篇
  Associations: 8 篇
--- 梦叙事 (前800字) ---
...
```

### 方法二：VCP 工具调用（运行时触发）

在对话中让 AI 发起工具调用，或手动构造请求：

```
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」AgentDream「末」,
action:「始」triggerDream「末」,
agent_name:「始」Nova「末」
<<<[END_TOOL_REQUEST]>>>
```

此方式通过 VCP 的正常工具调用管线执行，梦叙事和操作日志均正常广播和记录。

## 管理面板 API

审批功能已实现，位于管理面板侧栏 **🌙 梦境审批**：

| API | 方法 | 说明 |
|-----|------|------|
| `/admin_api/dream-logs` | GET | 列出所有梦日志摘要 |
| `/admin_api/dream-logs/:filename` | GET | 获取单个梦日志完整内容 |
| `/admin_api/dream-logs/:filename/operations/:opId` | POST | 审批/拒绝操作 `{ action: "approve" \| "reject" }` |

批准操作通过 `DailyNoteWrite` 插件执行，保持日记文件格式和 Tag 生成一致性。

## 内部 API

| 函数 | 说明 |
|------|------|
| `initialize(config, dependencies)` | 初始化梦系统（由 PluginManager 调用） |
| `triggerDream(agentName)` | 触发一次完整梦境 |
| `processToolCall(args)` | 处理梦操作工具调用 |
| `getDreamConfig()` | 获取当前梦系统配置 |
| `getDreamAgents()` | 获取已配置的做梦 Agent 列表 |

## VCPInfo 广播事件

| 事件类型 | 触发时机 |
|---------|----------|
| `AGENT_DREAM_START` | 入梦开始 |
| `AGENT_DREAM_ASSOCIATIONS` | 联想召回完成 |
| `AGENT_DREAM_NARRATIVE` | 梦叙述产出 |
| `AGENT_DREAM_OPERATIONS` | 梦操作记录 |
| `AGENT_DREAM_END` | 梦结束 |

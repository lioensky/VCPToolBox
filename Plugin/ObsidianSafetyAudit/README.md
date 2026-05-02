# ObsidianSafetyAudit

用于 Obsidian 动作安全控制和审计记录的同步插件。

## 职责

- 负责：判定风险等级、应用拒绝/审批策略、写入 JSONL 审计记录。
- 不负责：编辑笔记、直接发起 UI 审批、渲染审计事件。

## 命令

- `AssessAction`
- `RecordAuditEvent`

## 客户端呈现

审计结果会以结构化文本和 `details` 的形式返回。如果要在 VCPChat 中展示，应复用现有高级渲染或通知渲染链路。

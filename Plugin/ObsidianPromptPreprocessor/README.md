# ObsidianPromptPreprocessor

用于显式 Obsidian 上下文注入的消息预处理插件。

## 职责

- 负责：把当前活动笔记和显式配置的上下文笔记注入到系统提示词。
- 不负责：搜索整个 vault、编辑笔记、请求审批、保存审计日志。

## 配置

在 `config.env` 中设置 `OBSIDIAN_ACTIVE_NOTE` 和/或 `OBSIDIAN_CONTEXT_NOTES`。

`OBSIDIAN_CONTEXT_NOTES` 使用分号分隔多个笔记路径。

# ObsidianSessionSensor

用于轻量 Obsidian 会话上下文注入的 P0 静态插件。

## 边界

- 负责：通过 `{{VCPObsidianSession}}` 暴露最近的 vault 活动信息。
- 不负责：编辑文件、执行语义检索、推断任务意图。

## 必需配置

安装插件后，将 `config.env.example` 复制为 `config.env`，并设置 `OBSIDIAN_VAULT_DIR`。

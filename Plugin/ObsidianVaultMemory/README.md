# ObsidianVaultMemory

用于即时 Obsidian vault 检索的同步插件。

## 职责

- 负责：搜索 Markdown 笔记、列出最近笔记、查找反链。
- 不负责：编辑笔记、运行长时间索引任务、请求人工审批、保存审计日志。

## 命令

- `SearchNotes`
- `GetBacklinks`
- `ListRecentNotes`

## 配置

安装到 `D:/VCP/VCPToolBox/Plugin/ObsidianVaultMemory/` 后，将 `config.env.example` 复制为 `config.env`，然后设置 `OBSIDIAN_VAULT_DIR`。

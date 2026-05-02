# ObsidianCoreGateway

Obsidian 插件套件中的 P0 混合服务主轴插件。

## 边界

- 负责：校验笔记路径、读取笔记、原子写入、追加、精确替换，以及在配置了 CLI 的情况下打开笔记。
- 不负责：vault 检索、异步后台任务、确认 UI、审计持久化。

## 必需配置

安装插件后，将 `config.env.example` 复制为 `config.env`，并至少设置：

```env
OBSIDIAN_VAULT_DIR=D:\Path\To\ObsidianVault
```

只有在配置了 `OBSIDIAN_CLI_COMMAND` 时，`OpenNote` 才会执行。

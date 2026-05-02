# ObsidianAsyncWorker

用于轻量 Obsidian vault 维护报告的异步插件。

## 职责

- 负责：排队执行后台 vault 报告任务、写入任务状态 JSON，并按需发送 VCP 插件回调。
- 不负责：编辑笔记、做审批决策、替代 `ObsidianVaultMemory` 的即时检索职责。

## 命令

- `GenerateVaultReport`

## 输出

初始响应会立即返回任务 ID。最终任务详情会写入 `OBSIDIAN_ASYNC_STATE_DIR` 或默认的 `./state` 目录。

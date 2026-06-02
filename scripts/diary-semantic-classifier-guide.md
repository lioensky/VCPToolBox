# 日记语义分类工具使用指南

脚本 `diary-semantic-classifier.js` 已创建完成。由于开发环境依赖限制，请在部署了完整依赖的服务器环境中使用。
警告：使用本脚本时务必注意服务器已经关闭。请勿在服务器运行期间使用此脚本。

## 1. 准备工作

在服务器上，确保安装了新增的依赖 `commander`：

```bash
# 如果是首次部署，或者 package.json 已更新
npm install
```

## 2. 脚本参数说明

| 参数 | 简写 | 说明 |
|------|------|------|
| `--source` | `-s` | 源日记本文件夹名称（相对于 `dailynote/`） |
| `--categories` | `-c` | 目标分类列表，用逗号分隔 |
| `--filter` | `-f` | 屏蔽词（从分类名中移除后进行向量化） |
| `--threshold` | `-t` | 相似度阈值 (默认 0.3)，低于此值的文件保持不动 |
| `--api-url` | `-a` | **[可选]** 覆盖 API 地址。如果你在本地通过 `\\DESKTOP...` 远程运行脚本，需要指定服务器 IP |
| `--dry-run` | `-d` | **强烈建议首次运行使用**。只打印预演结果，不移动任何文件 |

## 3. 使用示例

### 场景 1：在服务器本机运行 (推荐)

**PowerShell:**
```powershell
node diary-semantic-classifier.js `
  --source "小吉的知识" `
  --categories "小吉的日常,小吉的通用知识,小吉的地缘政治,小吉的社会与历史学,小吉的逻辑学与哲学" `
  --filter "小吉的" `
  -d
```

### 场景 2：在本地远程运行 (通过网络共享)

如果你的脚本在 `\\DESKTOP-XXX\...` 路径下，但 API 服务在远程服务器上，请使用 `-a` 指定服务器 IP：

**PowerShell:**
```powershell
node diary-semantic-classifier.js `
  --source "小吉的知识" `
  --categories "小吉的日常,小吉的通用知识,小吉的地缘政治,小吉的社会与历史学,小吉的逻辑学与哲学" `
  --filter "小吉的" `
  --api-url "http://192.168.1.5:3106" `
  -d
```

### 场景 3：正式执行 (无 Dry-run)

**警告**：执行此命令前，请务必确认已备份数据，或在确认 Dry-run 结果无误后运行。

**PowerShell:**
```powershell
node diary-semantic-classifier.js `
  --source "小吉的知识" `
  --categories "小吉的日常,小吉的通用知识,小吉的地缘政治,小吉的社会与历史学,小吉的逻辑学与哲学" `
  --filter "小吉的" `
  --api-url "http://192.168.1.5:3106" `
  --threshold "0.4"  # 可选：提高阈值到 0.4
```

## 4. 运行结果

- 脚本会自动计算每个文件与分类的语义相似度。
- 将文件移动到 `dailynote/` 下对应的分类文件夹（如 `dailynote/小吉的社会与历史学/`）。
- 自动更新数据库中的路径记录。
- 自动重建相关的向量索引。

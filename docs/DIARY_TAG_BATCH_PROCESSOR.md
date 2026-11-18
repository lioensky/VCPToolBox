# VCP日记批量Tag处理工具使用指南

## 概述

`diary-tag-batch-processor.js` 是一个独立的命令行工具，用于批量处理日记文件的Tag标签。它可以：

- ✅ **检查Tag格式** - 验证Tag是否符合VCP RAG系统规范
- 🔧 **自动修复格式** - 修复中文标点、首行缩进等格式问题
- 🤖 **AI自动生成Tag** - 为缺失Tag的日记调用AI模型生成高质量标签
- 📊 **详细统计报告** - 显示处理结果和统计信息

## 功能特性

### 1. 智能Tag检测

自动检测日记文件最后一行是否包含Tag，并验证格式：

```
✅ 合规格式: Tag: 关键词1, 关键词2, 关键词3
❌ 需修复:    Tag：关键词1，关键词2，关键词3  (中文标点)
❌ 需修复:      Tag: 关键词1,关键词2          (首行缩进、缺少空格)
```

### 2. 格式自动修复

- 移除首行缩进
- 中文冒号 `：` → 移除
- 中文逗号 `，` → `, `
- 全角逗号 → `, `
- 顿号 `、` → `, `
- 规范化空格（逗号后有且仅有一个空格）

### 3. AI智能生成

- 使用专业的TagMaster提示词
- 3次退避重试机制（应对API 500/503错误）
- 自动提取和规范化AI生成的Tag

### 4. 批量处理

- 递归扫描目录（包括所有子文件夹）
- 支持 `.txt` 和 `.md` 文件
- 自动跳过已合规的文件
- 防API限流延迟

## 安装要求

### 方式1：在VCP项目中使用（推荐）

工具使用VCP主项目的依赖，确保已安装：

```bash
npm install
```

### 方式2：独立部署使用

如果想在其他项目或单独使用，可以创建独立部署：

#### 步骤1：复制文件

将以下文件复制到新目录：

```
your-diary-tool/
├── diary-tag-batch-processor.js    # 主程序
├── package.json                     # 依赖配置（见下文）
├── config.env                       # API配置
├── TagMaster.txt                    # Tag生成提示词
└── Plugin/                          # 可选，仅用于引用TagMaster.txt
    └── DailyNoteWrite/
        └── TagMaster.txt
```

#### 步骤2：创建package.json

```json
{
  "name": "vcp-diary-tag-processor",
  "version": "1.0.0",
  "description": "VCP日记批量Tag处理工具",
  "main": "diary-tag-batch-processor.js",
  "scripts": {
    "start": "node diary-tag-batch-processor.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "node-fetch": "^3.3.2"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
```

或直接使用根目录的 [`diary-tag-processor-package.json`](diary-tag-processor-package.json:1)：

```bash
cp diary-tag-processor-package.json your-diary-tool/package.json
```

#### 步骤3：安装依赖

```bash
cd your-diary-tool
npm install
```

#### 步骤4：配置

创建 `config.env`（参考 [`tag-processor-config.env.example`](tag-processor-config.env.example:1)）：

```env
API_Key=your_api_key_here
API_URL=https://api.openai.com
TagModel=claude-sonnet-4-20250514
TagModelMaxTokens=40000
TagModelMaxOutPutTokens=30000
TagModelPrompt=TagMaster.txt
```

#### 步骤5：运行

```bash
node diary-tag-batch-processor.js /path/to/your/diaries
```

### 主要依赖

- `dotenv` (^16.4.5) - 环境变量加载
- `node-fetch` (^3.3.2) - HTTP请求（ESM动态导入）

### 配置文件

需要在VCP根目录的 `config.env` 中配置API：

```env
# API配置（必需）
API_Key=your_api_key_here
API_URL=http://127.0.0.1:3000

# 可选：在 Plugin/DailyNoteWrite/config.env 中配置Tag模型
TagModel=gemini-2.5-flash-preview-09-2025-thinking
TagModelMaxTokens=40000
TagModelPrompt=TagMaster.txt
```

## 使用方法

### 基本语法

```bash
node diary-tag-batch-processor.js [目标文件夹路径]
```

### 示例

#### 1. 处理dailynote目录

```bash
node diary-tag-batch-processor.js ./dailynote
```

#### 2. 处理指定路径的旧日记

```bash
# Windows
node diary-tag-batch-processor.js "C:\Users\Admin\Documents\旧日记"

# Linux/Mac
node diary-tag-batch-processor.js "/home/user/old-diaries"
```

#### 3. 处理相对路径

```bash
node diary-tag-batch-processor.js ../my-diaries
```

## 运行示例

```
╔════════════════════════════════════════════════════════════╗
║        VCP日记批量Tag处理工具 v1.0                         ║
╚════════════════════════════════════════════════════════════╝

[TagProcessor] Target directory: ./dailynote
[TagProcessor] API URL: http://127.0.0.1:3000
[TagProcessor] Model: gemini-2.5-flash-preview-09-2025-thinking

[TagProcessor] Scanning files...
[TagProcessor] Found 15 files to process

[TagProcessor] Starting processing...

[TagProcessor] [1/15]
[TagProcessor] Processing: ./dailynote/小吉/2025-11-14-10_30_00.txt
[TagProcessor]   ⚠ Tag format needs fixing
[TagProcessor]   ✓ Fixed tag: Tag: 消费降级, 鸭货三巨头, 商业模式分析
[TagProcessor]   ✓ File updated

[TagProcessor] [2/15]
[TagProcessor] Processing: ./dailynote/小吉/2025-11-13-15_20_00.txt
[TagProcessor]   ⚠ No tag found, generating...
[TagProcessor]   ✓ Generated tag: Tag: VCP, 日记系统, RAG优化
[TagProcessor]   ✓ File updated

[TagProcessor] [3/15]
[TagProcessor] Processing: ./dailynote/莱恩/2025-11-12-09_00_00.txt
[TagProcessor]   ✓ Tag format is valid

...

╔════════════════════════════════════════════════════════════╗
║                      处理完成统计                           ║
╠════════════════════════════════════════════════════════════╣
║  总文件数:       15 个                                 ║
║  处理成功:       10 个 (修改了文件)                  ║
║  格式修复:        7 个                                 ║
║  AI生成Tag:       3 个                                 ║
║  跳过(已合规):    5 个                                 ║
║  错误:            0 个                                 ║
╚════════════════════════════════════════════════════════════╝

[TagProcessor] 所有文件处理完成！
```

## 处理逻辑

```
对于每个文件：
  ↓
检测最后一行是否有Tag
  ↓
┌─────────────┬─────────────┐
│   有Tag     │   无Tag     │
└─────────────┴─────────────┘
      ↓              ↓
  格式检查      调用AI生成
      ↓              ↓
  ┌───────┐     ┌────────┐
  │ 合规  │     │ 成功？ │
  │ 跳过  │     └────────┘
  └───────┘          ↓
      ↓         格式修复
  需修复             ↓
      ↓         附加到内容
  格式修复           ↓
      ↓         写入文件
  写入文件           ↓
      ↓         统计++
  统计++
```

## 文件处理规则

### 扫描规则

- ✅ 递归扫描所有子目录
- ✅ 处理 `.txt` 文件
- ✅ 处理 `.md` 文件
- ❌ 忽略其他文件类型
- ❌ 忽略隐藏文件

### 修改规则

- ✅ Tag格式不合规 → 修复并写入
- ✅ 缺失Tag → AI生成并写入
- ⏭️ Tag已合规 → 跳过（不修改）
- ⚠️ API失败 → 记录错误，继续下一个

## 错误处理

### API错误重试

针对临时性错误（500/503），工具会自动重试：

- 第1次重试：等待 1秒
- 第2次重试：等待 2秒
- 第3次重试：等待 4秒
- 3次后仍失败：记录错误，继续处理下一个文件

### 常见错误

| 错误信息 | 原因 | 解决方法 |
|---------|------|---------|
| `API configuration missing` | config.env缺少API配置 | 配置 `API_Key` 和 `API_URL` |
| `路径不存在` | 目标路径不存在 | 检查路径是否正确 |
| `Failed to read TagMaster prompt file` | TagMaster.txt文件缺失 | 检查 `Plugin/DailyNoteWrite/TagMaster.txt` |
| `API returned 401` | API密钥错误 | 检查 `API_Key` 配置 |
| `API returned 429` | API限流 | 等待后重试，或减少并发 |

## 性能优化

### 处理速度

- 本地文件读写：非常快
- AI生成Tag：2-5秒/文件
- 防限流延迟：500ms/文件

### 建议

对于大量文件（>100个）：

1. **分批处理** - 先处理一个子目录测试
2. **检查配额** - 确保API有足够配额
3. **离峰处理** - 避开API高峰时段
4. **备份数据** - 处理前备份重要文件

## 安全性

### 文件保护

- ✅ 仅修改Tag行，不改变日记内容
- ✅ 原子写入（写入完成才覆盖）
- ✅ UTF-8编码保护
- ⚠️ **建议处理前备份文件**

### 数据隐私

- ✅ 日记内容发送到配置的API端点
- ⚠️ 确保API端点安全可信
- ⚠️ 注意API日志策略

## 高级用法

### 自定义配置

在 `Plugin/DailyNoteWrite/config.env` 中调整：

```env
# 使用不同的模型
TagModel=gpt-4

# 调整Token限制
TagModelMaxTokens=50000

# 使用自定义提示词
TagModelPrompt=MyCustomTagPrompt.txt
```

### 编程集成

也可以在代码中导入使用：

```javascript
const processor = require('./diary-tag-batch-processor.js');
// 自定义使用...
```

## 故障排查

### 检查清单

1. ✅ Node.js版本 >= 14
2. ✅ 已运行 `npm install`
3. ✅ `config.env` 存在且配置正确
4. ✅ API端点可访问
5. ✅ TagMaster.txt 文件存在
6. ✅ 目标目录有读写权限

### 调试模式

在 `config.env` 中启用：

```env
DebugMode=true
```

将输出详细的调试信息。

## 最佳实践

### 处理前

1. **备份数据** - 使用 `cp -r` 或其他工具备份
2. **小范围测试** - 先处理1-2个文件验证
3. **检查配额** - 确认API剩余额度

### 处理中

1. **监控日志** - 注意错误信息
2. **保持连接** - 确保网络稳定
3. **避免中断** - 不要强制终止进程

### 处理后

1. **检查统计** - 确认处理结果
2. **抽查文件** - 随机检查几个文件
3. **验证Tag** - 确认Tag质量和格式

## 更新日志

### v1.0 (2025-11-15)

- ✨ 初始版本发布
- ✨ Tag格式检测与修复
- ✨ AI自动生成Tag
- ✨ 退避重试机制
- ✨ 详细统计报告
- ✨ 递归目录扫描

## 支持与反馈

遇到问题？

1. 检查本文档的"故障排查"部分
2. 查看 `Plugin/DailyNoteWrite/README.md`
3. 提交Issue到项目仓库

## 相关工具

- `Plugin/DailyNoteWrite/` - 实时Tag处理（写入时）
- `RAGDiaryPlugin/` - Tag检索和RAG系统
- `diary-tag-batch-processor.js` - 批量Tag处理（本工具）

---

## 附录：独立配置文件模板

### 说明

本工具可以通过独立的配置文件在其他项目中使用。以下提供完整的配置模板，可直接复制使用。

### 配置文件：`tag-processor-config.env`

```env
# ============================================================
# VCP Tag处理器独立配置文件
# ============================================================
#
# 用途：为日记批量打Tag工具提供配置
# 位置：可放在任意目录，通过 --config 参数指定
#
# 使用示例：
#   node diary-tag-batch-processor.js --config ./tag-processor-config.env ./my-diaries
#
# ============================================================

# ------------------------------------------------------------
# [必需] API配置
# ------------------------------------------------------------
# 用于调用AI模型生成Tag的API配置
# 支持OpenAI兼容API（如OpenRouter、One-API等中转服务）

# API密钥
API_Key=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# API地址（不要包含/v1/chat/completions，工具会自动添加）
API_URL=https://api.openai.com
# 或使用本地转发
# API_URL=http://127.0.0.1:3000


# ------------------------------------------------------------
# [推荐] Tag生成模型配置
# ------------------------------------------------------------
# 用于生成高质量Tag的AI模型

# 模型名称
# 推荐：claude-sonnet-4-20250514（最佳质量）
# 备选：gpt-4o（速度快）、gpt-4o-mini（成本低）
TagModel=claude-sonnet-4-20250514

# 模型最大Token限制（输入+输出）
TagModelMaxTokens=40000

# 模型最大输出Token限制
TagModelMaxOutPutTokens=30000

# Tag生成提示词文件路径（相对于工具所在目录）
# 默认使用 Plugin/DailyNoteWrite/TagMaster.txt
TagModelPrompt=TagMaster.txt


# ------------------------------------------------------------
# [可选] 调试选项
# ------------------------------------------------------------
# 启用详细日志输出（true/false）
DebugMode=false


# ------------------------------------------------------------
# [可选] 日记文件扩展名
# ------------------------------------------------------------
# 工具会自动处理的文件类型（硬编码为 .txt 和 .md）
# 此配置项仅用于DailyNoteWrite插件
DAILY_NOTE_EXTENSION=txt


# ============================================================
# 模型选择指南
# ============================================================
#
# 【最佳质量】Claude Sonnet 4/4.5
# TagModel=claude-sonnet-4-20250514
# TagModel=claude-sonnet-4.5-20250929
# - 最强的结构化输出能力
# - 最好的中文理解
# - 最准确的关键词提取
# - 推荐用于知识图谱构建
#
# 【速度优先】GPT-4o
# TagModel=gpt-4o
# - 响应速度快
# - 质量稳定
# - 成本适中
#
# 【成本优先】GPT-4o-mini
# TagModel=gpt-4o-mini
# - 最低成本
# - 速度最快
# - 质量略逊但可接受
#
# 【不推荐】Gemini Flash
# TagModel=gemini-2.5-flash-preview-09-2025-thinking
# - 便宜但格式控制较弱
# - 可能偏离Tag格式要求
#
# ============================================================
```

### 如何使用独立配置

#### 方法1：替换主配置（简单）

将上述配置内容保存为 `config.env`，放在VCP根目录：

```bash
# 配置会自动加载
node diary-tag-batch-processor.js ./my-diaries
```

#### 方法2：使用自定义路径（高级）

如果需要在其他项目中使用，可以修改工具代码加载配置路径：

```javascript
// 在 diary-tag-batch-processor.js 开头修改
require('dotenv').config({ path: '/path/to/your/tag-processor-config.env' });
```

### 最小配置示例

如果只想快速测试，最少需要配置：

```env
# 最小配置
API_Key=your_api_key_here
API_URL=https://api.openai.com
TagModel=claude-sonnet-4-20250514
```

其他参数会使用默认值。

### 配置验证

运行工具前，可以通过以下方式验证配置：

```bash
node -e "require('dotenv').config(); console.log('API_Key:', process.env.API_Key ? '✓ 已配置' : '✗ 缺失'); console.log('API_URL:', process.env.API_URL || '✗ 缺失'); console.log('TagModel:', process.env.TagModel || 'gemini-2.5-flash-preview-09-2025-thinking (默认)');"
```

预期输出：
```
API_Key: ✓ 已配置
API_URL: https://api.openai.com
TagModel: claude-sonnet-4-20250514
```

---

**注意：** 本工具会修改文件内容，使用前请务必备份重要数据！
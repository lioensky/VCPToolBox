# VCPToolBox 配置系统文档

本文档详细说明 VCPToolBox 的配置体系，包括配置文件清单、参数详解、优先级规则及安全注意事项。

---

## 目录

1. [配置文件清单](#1-配置文件清单)
2. [配置优先级规则](#2-配置优先级规则)
3. [核心配置详解](#3-核心配置详解)
   - [3.1 主配置文件 config.env](#31-主配置文件-configenv)
   - [3.2 RAG 参数配置 rag_params.json](#32-rag-参数配置-rag_paramsjson)
   - [3.3 模型重定向 ModelRedirect.json](#33-模型重定向-modelredirectjson)
   - [3.4 Agent 映射 agent_map.json](#34-agent-映射-agent_mapjson)
   - [3.5 Tag 处理器配置](#35-tag-处理器配置)
   - [3.6 插件配置](#36-插件配置)
4. [Docker 配置](#4-docker-配置)
5. [安全注意事项](#5-安全注意事项)
6. [常见配置问题](#6-常见配置问题)

---

## 1. 配置文件清单

### 核心配置文件

| 文件名 | 位置 | 用途 | 是否必需 |
|--------|------|------|----------|
| `config.env` | 根目录 | 主配置文件，包含所有核心参数 | **必需** |
| `rag_params.json` | 根目录 | RAG/知识库算法参数 | 可选（有默认值） |
| `ModelRedirect.json` | 根目录 | 模型名称重定向映射 | 可选 |
| `agent_map.json` | 根目录 | Agent 别名与文件映射 | 可选（无则不加载 Agent） |

### 辅助配置文件

| 文件名 | 位置 | 用途 |
|--------|------|------|
| `tag-processor-config.env` | 根目录 | Tag 批量处理工具配置 |
| `Plugin/*/config.env` | 插件目录 | 各插件专属配置 |
| `docker-compose.yml` | 根目录 | Docker Compose 部署配置 |
| `Dockerfile` | 根目录 | Docker 镜像构建配置 |

### 模板文件（.example 后缀）

所有敏感配置文件都提供 `.example` 模板版本，首次部署时需复制并填写实际值：

```bash
cp config.env.example config.env
cp agent_map.json.example agent_map.json
cp ModelRedirect.json.example ModelRedirect.json
```

---

## 2. 配置优先级规则

VCPToolBox 配置系统遵循以下优先级（从高到低）：

```
环境变量 > config.env 配置文件 > 代码内默认值
```

### 优先级示例

| 参数 | 环境变量 | config.env | 默认值 | 最终值 |
|------|----------|------------|--------|--------|
| PORT | 8080 | 6005 | 3000 | **8080** |
| DebugMode | true | false | false | **true** |
| Key | - | mykey123 | - | **mykey123** |

### 插件配置合并规则

插件配置采用两级合并策略：

```
插件 config.env > 全局 config.env > manifest 默认值
```

当同一参数在多处定义时，插件目录下的 `config.env` 优先级最高。

---

## 3. 核心配置详解

### 3.1 主配置文件 config.env

主配置文件是 VCPToolBox 运行的核心，包含约 460 行配置项，按功能模块分组。

#### 3.1.1 AI 模型 API 配置

| 参数 | 类型 | 默认值 | 说明 | 风险等级 |
|------|------|--------|------|----------|
| `API_Key` | string | - | 后端 AI 服务 API 密钥 | 🔴 **高** |
| `API_URL` | string | - | 后端 AI 服务 API 地址 | 🟡 中 |

**风险说明：**
- `API_Key` 泄露将导致 API 额度被盗用
- 请勿使用非官方或反向代理 API，可能导致敏感信息泄露

```env
# 示例
API_Key=sk-xxxxxxxxxxxxxxxxxxxxxxxx
API_URL=https://api.openai.com
```

#### 3.1.2 VCP 服务配置

| 参数 | 类型 | 默认值 | 说明 | 风险等级 |
|------|------|--------|------|----------|
| `PORT` | number | 6005 | VCP 服务监听端口 | 🟢 低 |
| `Key` | string | - | 聊天 API 访问密钥 | 🔴 **高** |
| `Image_Key` | string | - | 图片服务访问密钥 | 🔴 **高** |
| `File_Key` | string | - | 文件服务访问密钥 | 🔴 **高** |
| `VCP_Key` | string | - | WebSocket 鉴权密钥 | 🔴 **高** |
| `ApiRetries` | number | 3 | API 请求重试次数 | 🟢 低 |
| `ApiRetryDelay` | number | 200 | 重试间隔（毫秒） | 🟢 低 |
| `DEFAULT_TIMEZONE` | string | Asia/Shanghai | 服务器时区 | 🟢 低 |

**安全建议：**
- 所有 `*_Key` 参数必须使用强随机字符串（至少 16 位）
- 不同服务使用不同密钥，避免单点泄露影响全局

#### 3.1.3 工具调用循环配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `MaxVCPLoopStream` | number | 5 | 流式模式下工具调用最大循环次数 |
| `MaxVCPLoopNonStream` | number | 5 | 非流式模式下工具调用最大循环次数 |
| `VCPToolCode` | boolean | false | 是否启用工具调用验证码 |

#### 3.1.4 国产模型推理配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ChinaModel1` | string | GLM,qwen,deepseek,hunyuan | 支持推理的国产模型列表 |
| `ChinaModel1Cot` | boolean | true | 是否启用国产模型 CoT 推理 |

#### 3.1.5 角色分割配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `EnableRoleDivider` | boolean | false | 启用角色分割功能总开关 |
| `EnableRoleDividerInLoop` | boolean | false | 在 VCPTool 调用循环中启用角色分割 |
| `EnableRoleDividerAutoPurge` | boolean | true | 当特定角色分割被禁用时，自动清除该角色标签 |
| `RoleDividerSystem` | boolean | true | 允许切割为 system 角色 |
| `RoleDividerAssistant` | boolean | true | 允许切割为 assistant 角色 |
| `RoleDividerUser` | boolean | true | 允许切割为 user 角色 |
| `RoleDividerScanSystem` | boolean | true | 是否对 system 楼层进行分割监测 |
| `RoleDividerScanAssistant` | boolean | true | 是否对 assistant 楼层进行分割监测 |
| `RoleDividerScanUser` | boolean | true | 是否对 user 楼层进行分割监测 |
| `RoleDividerRemoveDisabledTags` | boolean | true | 当角色分割被禁用时，是否自动移除该角色标签 |
| `RoleDividerIgnoreList` | JSON array | [] | 角色分割忽略列表，匹配时忽略换行符、反斜杠和空格 |

**配置说明：**
- `RoleDividerScan*` 系列参数控制是否对特定角色的消息进行分割处理
- 当 `RoleDividerXXXX=false` 且 `RoleDividerRemoveDisabledTags=true` 时，会自动清除该角色的分割标签
- `RoleDividerIgnoreList` 格式为 JSON 数组字符串，例如：`["content1","content2"]`

#### 3.1.6 调试与开发配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `DebugMode` | boolean | false | 启用调试模式，输出详细日志 |
| `ShowVCP` | boolean | false | 非流式输出时是否显示 VCP 调用信息 |

**说明：**
- `DebugMode=true` 会在控制台输出详细的调试信息，方便开发和排错
- `ShowVCP=true` 会在 API 响应中包含工具调用的详细信息

#### 3.1.7 管理面板配置

| 参数 | 类型 | 默认值 | 说明 | 风险等级 |
|------|------|--------|------|----------|
| `AdminUsername` | string | admin | 管理面板用户名 | 🟡 中 |
| `AdminPassword` | string | - | 管理面板密码 | 🔴 **高** |

**安全建议：**
- 必须修改默认用户名和密码
- 密码应包含大小写字母、数字、特殊字符，长度至少 12 位

#### 3.1.7 回调地址配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `CALLBACK_BASE_URL` | string | http://localhost:6005/plugin-callback | 插件异步任务回调地址 |

**注意：** 部署到服务器时，需将 `localhost` 替换为实际 IP 或域名。

#### 3.1.8 模型路由配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `WhitelistImageModel` | string | gemini-2.0-flash-exp-image-generation | 图像生成白名单模型 |
| `WhitelistEmbeddingModel` | string | gemini-embedding-exp-03-07 | 嵌入模型白名单 |
| `WhitelistEmbeddingModelMaxToken` | number | 8000 | 嵌入模型最大 Token |
| `WhitelistEmbeddingModelList` | number | 5 | 嵌入模型列表数量 |

#### 3.1.9 知识库配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `KNOWLEDGEBASE_ROOT_PATH` | string | ./dailynote | 知识库/日记根目录 |
| `KNOWLEDGEBASE_STORE_PATH` | string | ./VectorStore | 向量索引存储目录 |
| `VECTORDB_DIMENSION` | number | 3072 | 向量维度（必须与嵌入模型匹配） |
| `KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP` | boolean | true | 启动时全量扫描 |
| `KNOWLEDGEBASE_MAX_BATCH_SIZE` | number | 50 | 批量处理最大文件数 |
| `KNOWLEDGEBASE_BATCH_WINDOW_MS` | number | 2000 | 批处理等待窗口（毫秒） |
| `KNOWLEDGEBASE_INDEX_SAVE_DELAY` | number | 120000 | 索引保存延迟（毫秒） |
| `KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY` | number | 300000 | Tag 索引保存延迟（毫秒） |
| `RAGMemoRefresh` | boolean | true | 启用流内记忆刷新器 |

**重要：** `VECTORDB_DIMENSION` 必须与 `WhitelistEmbeddingModel` 严格匹配：

| 嵌入模型 | 向量维度 |
|----------|----------|
| google/gemini-embedding-001 | 3072 |
| text-embedding-3-small | 1536 |
| text-embedding-3-large | 3072 |

#### 3.1.10 内容过滤配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `IGNORE_FOLDERS` | string | VCP论坛 | 忽略的日记本名称（逗号分隔） |
| `IGNORE_PREFIXES` | string | 已整理 | 忽略的文件名前缀（逗号分隔） |
| `IGNORE_SUFFIXES` | string | 夜伽 | 忽略的文件名后缀（逗号分隔） |
| `TAG_BLACKLIST` | string | - | Tag 黑名单（逗号分隔） |
| `TAG_BLACKLIST_SUPER` | string | - | Tag 移除关键词列表 |
| `TAG_EXPAND_MAX_COUNT` | number | 30 | Tag 扩展最大数量 |

#### 3.1.11 语言置信度补偿

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `LANG_CONFIDENCE_GATING_ENABLED` | boolean | true | 启用语言置信度补偿 |
| `LANG_PENALTY_UNKNOWN` | number | 0.05 | 未知世界观英文压制权重 |
| `LANG_PENALTY_CROSS_DOMAIN` | number | 0.1 | 跨域英文压制权重 |

#### 3.1.12 系统提示词变量

| 参数 | 类型 | 说明 |
|------|------|------|
| `TarSysPrompt` | string | 核心系统提示词模板 |
| `TarEmojiPrompt` | string | 表情包系统提示词 |
| `TarEmojiList` | string | 表情包列表文件名 |
| `VarToolList` | string | 工具列表文件名 |
| `VarVCPGuide` | string | VCP 工具调用指南 |
| `VarDailyNoteGuide` | string | 日记功能指南 |

#### 3.1.13 自定义变量

| 参数前缀 | 优先级 | 说明 |
|----------|--------|------|
| `Tar*` | 最高 | 模板变量，支持嵌套解析 |
| `Var*` | 中 | 通用变量，按定义顺序替换 |
| `Sar*` | 条件 | 模型专属变量，根据当前模型生效 |
| `Agent{{*}}` | 基础 | Agent 角色变量基座 |

#### 3.1.14 文本替换配置

VCP 支持在系统提示词和上下文中进行文本替换，用于绕过某些模型限制或优化指令。

**系统提示词转化（Detector 系列）：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `Detector1` | string | 要查找的文本 1 |
| `Detector_Output1` | string | 替换文本 1 |
| `Detector2` | string | 要查找的文本 2 |
| `Detector_Output2` | string | 替换文本 2 |
| `Detector3` | string | 要查找的文本 3 |
| `Detector_Output3` | string | 替换文本 3 |

**全局上下文转化（SuperDetector 系列）：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `SuperDetector1` | string | 全局查找文本 1 |
| `SuperDetector_Output1` | string | 全局替换文本 1 |
| `SuperDetector2` | string | 全局查找文本 2 |
| `SuperDetector_Output2` | string | 全局替换文本 2 |
| `SuperDetector3` | string | 全局查找文本 3 |
| `SuperDetector_Output3` | string | 全局替换文本 3 |
| `SuperDetector4` | string | 全局查找文本 4 |
| `SuperDetector_Output4` | string | 全局替换文本 4 |

**配置示例：**
```env
# 系统提示词转化
Detector1="You can use one tool per message"
Detector_Output1="You can use any tool per message"

# 全局上下文转化（处理重复字符）
SuperDetector1="……"
SuperDetector_Output1="…"
SuperDetector2="啊啊啊啊啊"
SuperDetector_Output2="啊啊啊"
```

#### 3.1.15 多模态配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `MultiModalModel` | string | gemini-2.5-flash | 多模态识别模型 |
| `MultiModalPrompt` | string | - | 多模态分析提示词 |
| `MediaInsertPrompt` | string | - | 媒体插入提示词 |
| `MultiModalModelOutputMaxTokens` | number | 50000 | 输出最大 Token |
| `MultiModalModelContent` | number | 250000 | 内容最大 Token |
| `MultiModalModelThinkingBudget` | number | 23000 | 思考预算 Token |
| `MultiModalModelAsynchronousLimit` | number | 10 | 异步请求上限 |
| `BILIBILI_COOKIE` | string | - | Bilibili Cookie |
| `BILIBILI_SUB_LANG` | string | ai-zh | Bilibili 字幕语言 |

#### 3.1.16 Agent 目录配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENT_DIR_PATH` | string | ./Agent | Agent 文件存放目录（可选配置） |

**注意：** 此参数在 config.env.example 中默认被注释，如需自定义 Agent 目录位置可启用。

#### 3.1.17 模型专属指令

通过 `SarModelN` / `SarPromptN` 对配置模型专属提示词：

```env
SarModel1=gemini-2.5-flash-preview-05-20,gemini-2.5-flash-preview-04-17
SarPrompt1="请对用户的输入信息做出详尽，泛化的思考..."
```

#### 3.1.15 插件 API 密钥

| 参数 | 用途 | 风险等级 |
|------|------|----------|
| `WeatherKey` | 和风天气 API | 🟡 中 |
| `WeatherUrl` | 和风天气 API 地址 | 🟢 低 |
| `TavilyKey` | Tavily 搜索引擎 | 🟡 中 |
| `SILICONFLOW_API_KEY` | 硅基流动 API | 🔴 **高** |
| `BILIBILI_COOKIE` | B 站登录凭证 | 🔴 **高** |

#### 3.1.16 多模态配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `MultiModalModel` | string | gemini-2.5-flash | 多模态识别模型 |
| `MultiModalPrompt` | string | - | 多模态分析提示词 |
| `MediaInsertPrompt` | string | - | 媒体插入提示词 |
| `MultiModalModelOutputMaxTokens` | number | 50000 | 输出最大 Token |
| `MultiModalModelContent` | number | 250000 | 内容最大 Token |
| `MultiModalModelThinkingBudget` | number | 23000 | 思考预算 Token |
| `MultiModalModelAsynchronousLimit` | number | 10 | 异步请求上限 |

---

### 3.2 RAG 参数配置 rag_params.json

该文件控制 TagMemo "浪潮"算法的核心参数，分为两个模块：

```json
{
  "RAGDiaryPlugin": {
    "noise_penalty": 0.05,
    "tagWeightRange": [0.05, 0.45],
    "tagTruncationBase": 0.6,
    "tagTruncationRange": [0.5, 0.9]
  },
  "KnowledgeBaseManager": {
    "activationMultiplier": [0.5, 1.5],
    "dynamicBoostRange": [0.3, 2.0],
    "coreBoostRange": [1.20, 1.40],
    "deduplicationThreshold": 0.88,
    "techTagThreshold": 0.08,
    "normalTagThreshold": 0.015,
    "languageCompensator": {
      "penaltyUnknown": 0.05,
      "penaltyCrossDomain": 0.1
    }
  }
}
```

#### RAGDiaryPlugin 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `noise_penalty` | number | 0.05 | 噪音惩罚系数 |
| `tagWeightRange` | [number, number] | [0.05, 0.45] | Tag 权重范围 |
| `tagTruncationBase` | number | 0.6 | Tag 截断基准值 |
| `tagTruncationRange` | [number, number] | [0.5, 0.9] | Tag 截断范围 |

#### KnowledgeBaseManager 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `activationMultiplier` | [number, number] | [0.5, 1.5] | 激活乘数范围 |
| `dynamicBoostRange` | [number, number] | [0.3, 2.0] | 动态增强范围 |
| `coreBoostRange` | [number, number] | [1.20, 1.40] | 核心标签增强范围 |
| `deduplicationThreshold` | number | 0.88 | 去重阈值（余弦相似度） |
| `techTagThreshold` | number | 0.08 | 技术 Tag 阈值 |
| `normalTagThreshold` | number | 0.015 | 普通 Tag 阈值 |
| `languageCompensator.penaltyUnknown` | number | 0.05 | 未知世界观语言惩罚 |
| `languageCompensator.penaltyCrossDomain` | number | 0.1 | 跨域语言惩罚 |

**调参建议：**
- 增大 `coreBoostRange` 可提升核心标签召回率
- 降低 `deduplicationThreshold` 可保留更多相似内容
- 这些参数可通过 Web 管理面板动态调整

---

### 3.3 模型重定向 ModelRedirect.json

用于将客户端请求的"公开模型名称"映射到"内部模型名称"：

```json
{
  "gpt-4-vision-preview": "GPT-4-Vision",
  "claude-3-opus": "claude-3-opus-20240229",
  "gemini-pro-vision": "gemini-1.5-pro-vision-latest",
  "my-custom-model": "specific-backend-model-id"
}
```

| 场景 | 公开名称 | 内部名称 |
|------|----------|----------|
| 兼容旧客户端 | gpt-4-vision-preview | GPT-4-Vision |
| 模型别名 | claude-3-opus | claude-3-opus-20240229 |
| 自定义路由 | my-custom-model | 实际后端模型 ID |

---

### 3.4 Agent 映射 agent_map.json

定义 Agent 别名与配置文件的映射关系：

```json
{
  "Nova": "Nova.txt",
  "ShaoShenYun": "ShaoShenYun.txt",
  "Coco": "ThemeMaidCoco.txt"
}
```

**文件位置：** Agent 配置文件默认位于 `Agent/` 目录下。

**热更新：** 修改 `agent_map.json` 后，系统会自动重新加载，无需重启服务。

---

### 3.5 Tag 处理器配置

用于日记批量打 Tag 工具的独立配置：

```env
# API 配置
API_Key=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
API_URL=https://api.openai.com

# Tag 生成模型
TagModel=claude-sonnet-4-20250514
TagModelMaxTokens=40000
TagModelMaxOutPutTokens=30000

# 提示词文件
TagModelPrompt=TagMaster.txt

# 调试模式
DebugMode=false
```

**推荐模型：**
- `claude-sonnet-4-20250514` - 最准确的 Tag 提取（推荐）
- `gpt-4o` - 速度快
- `gpt-4o-mini` - 成本低

---

### 3.6 插件配置

每个插件可在其目录下创建独立的 `config.env` 文件：

```
Plugin/
├── WeatherReporter/
│   ├── config.env.example    # 配置模板
│   ├── config.env            # 实际配置（不提交）
│   └── plugin-manifest.json
```

#### 示例：WeatherReporter 插件配置

```env
forecastDays=7                    # 天气预报天数 (1-15)
hourlyForecastInterval=2          # 小时预报间隔
hourlyForecastCount=12            # 小时预报条数
```

#### 配置继承规则

```
插件 config.env 值 > 全局 config.env 同名值 > manifest 默认值
```

---

## 4. Docker 配置

### 4.1 docker-compose.yml

```yaml
services:
  app:
    build: .
    container_name: vcptoolbox
    ports:
      - "6005:6005"
    environment:
      TZ: ${DEFAULT_TIMEZONE:-Asia/Shanghai}
    volumes:
      - .:/usr/src/app              # 全挂载模式
      - /usr/src/app/pydeps         # Python 依赖独立层
      - /usr/src/app/node_modules   # Node 依赖独立层
    restart: unless-stopped
```

### 4.2 Dockerfile 关键配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 基础镜像 | node:20-alpine | 轻量级 Node.js 环境 |
| 工作目录 | /usr/src/app | 容器内应用路径 |
| 暴露端口 | 6005 | VCP 服务端口 |
| 运行用户 | root | ⚠️ 安全风险（见下文） |
| 进程管理 | pm2-runtime | 生产级进程守护 |

### 4.3 Docker 安全注意事项

**当前状态：** 容器以 `root` 用户运行，存在安全风险。

**原因：** 需要写入挂载的宿主机目录，权限不匹配会导致写入失败。

**推荐方案：**

1. 在宿主机上创建应用用户：
   ```bash
   sudo useradd -u 1001 vcptoolbox
   ```

2. 修改数据目录所有权：
   ```bash
   sudo chown -R 1001:1001 ./dailynote ./image ./VectorStore
   ```

3. 在 Dockerfile 中启用非 root 用户（取消注释）：
   ```dockerfile
   RUN addgroup -S appuser && adduser -S appuser -G appuser
   RUN chown -R appuser:appuser /usr/src/app
   USER appuser
   ```

---

## 5. 安全注意事项

### 5.1 密钥管理

| 风险类型 | 风险等级 | 防护措施 |
|----------|----------|----------|
| API 密钥泄露 | 🔴 高 | 使用强随机密钥，定期轮换 |
| 配置文件提交 | 🔴 高 | 将 `config.env` 加入 `.gitignore` |
| 弱密码 | 🔴 高 | 密码长度 ≥12 位，包含大小写+数字+符号 |
| 密钥复用 | 🟡 中 | 不同服务使用不同密钥 |

### 5.2 敏感配置项清单

**绝不可提交到版本库的文件：**

- `config.env` - 包含所有 API 密钥
- `Plugin/*/config.env` - 插件私有配置
- `agent_map.json` - 可能包含内部信息
- `ModelRedirect.json` - 可能暴露后端架构

### 5.3 API 安全建议

1. **使用官方 API**
   - 禁止使用非官方或反向代理 API
   - 原因：可能导致 AI 交互数据、记忆库内容、API 密钥泄露

2. **网络隔离**
   - 生产环境建议部署在内网
   - 使用反向代理（Nginx）添加 HTTPS 和访问控制

3. **访问控制**
   - 为不同服务配置独立的访问密钥
   - 启用 `VCPToolCode` 进行工具调用验证

### 5.4 权限控制

VCP Agent 拥有**硬件底层级分布式系统根权限**：

- PowerShell/Shell 执行器具有完整系统访问能力
- 文件操作插件可读写任意可访问目录
- 浏览器控制插件可操作用户浏览器

**部署前必须确认：**
1. 信任所有可能使用系统的用户
2. 理解 Agent 可能执行的任何操作
3. 在隔离环境测试后再部署到生产环境

---

## 6. 常见配置问题

### Q1: 启动后无法连接后端 API

**排查步骤：**
1. 检查 `API_URL` 格式是否正确（不要包含 `/v1/chat/completions`）
2. 检查 `API_Key` 是否有效
3. 检查网络连接和防火墙设置

### Q2: 知识库向量维度不匹配

**错误现象：** 向量检索失败或抛出维度错误

**解决方案：**
1. 确认 `WhitelistEmbeddingModel` 对应的维度
2. 修改 `VECTORDB_DIMENSION` 为正确值
3. 删除 `VectorStore/` 目录重新索引

### Q3: 插件配置不生效

**可能原因：**
1. 配置文件名错误（应为 `config.env` 而非 `config.env.example`）
2. 配置文件位置错误（应在插件目录下）
3. 参数名拼写错误（区分大小写）

### Q4: 管理面板无法登录

**解决方案：**
1. 确认 `AdminUsername` 和 `AdminPassword` 已正确配置
2. 清除浏览器缓存
3. 检查浏览器是否支持 HTTP Basic Auth

### Q5: Docker 容器启动后立即退出

**排查步骤：**
1. 查看日志：`docker-compose logs -f`
2. 检查 `config.env` 是否存在
3. 检查端口 6005 是否被占用

---

## 附录：配置文件完整示例

### config.env 最小配置

```env
# 核心配置（必需）
API_Key=sk-your-api-key
API_URL=https://api.openai.com
PORT=6005
Key=your-random-key-at-least-16-chars

# 管理面板（必需修改）
AdminUsername=admin
AdminPassword=your-strong-password

# WebSocket 鉴权（必需）
VCP_Key=your-websocket-key

# 回调地址（部署时修改）
CALLBACK_BASE_URL=http://your-server-ip:6005/plugin-callback
```

---

**文档版本：** 1.0  
**最后更新：** 2026-02-13  
**适用版本：** VCPToolBox 6.4+

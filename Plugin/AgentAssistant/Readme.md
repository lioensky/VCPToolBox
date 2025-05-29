# AgentAssistant 同步插件 - README

## 目录
1. [功能简介](#功能简介)
2. [核心特性](#核心特性)
3. [配置指南](#配置指南)
    - [必要环境配置](#必要环境配置)
    - [Agent 定义详解](#agent-定义详解)
    - [配置示例](#配置示例)
4. [使用方法](#使用方法)
    - [AI 调用指令格式](#ai-调用指令格式)
    - [如何确定可用的 `agent_name`](#如何确定可用的-agent_name)
    - [占位符替换](#占位符替换)
5. [上下文记忆](#上下文记忆)
6. [调试模式](#调试模式)
7. [注意事项](#注意事项)

## 功能简介
`AgentAssistant` 插件允许您的主 AI (通过VCP交互的AI) 调用在配置文件中预先定义的其他辅助 AI Agent。这使得主 AI 可以根据任务需求，“咨询”不同特性、不同模型或拥有不同系统提示的辅助 Agent，从而增强其整体能力和灵活性。

## 核心特性
* **动态加载 Agent**：从 `config.env` 文件中读取配置，动态加载任意数量的辅助 Agent。
* **独立上下文记忆**：每个辅助 Agent 都拥有独立的临时对话记忆（默认为5轮，12小时后或服务器重启后清除，可配置）。
* **占位符支持**：在传递给辅助 Agent 的提示词 (prompt) 中，可以识别并替换一部分通用占位符（如 `{{Date}}`, `{{Time}}`）。更复杂的占位符（如 `{{XX日记本}}`）应由 VCP 主服务在调用此插件前处理。
* **OpenAI 兼容 API**：通过标准的 OpenAI 兼容 API与辅助 Agent 模型进行交互。

## 配置指南
您需要在 VCP 项目的**根目录**下的 `config.env` 文件中添加以下配置项。

### 必要环境配置
这些变量用于 `AgentAssistant` 插件连接到提供大语言模型服务的 API。

* `API_URL`
    * 描述：OpenAI 兼容 API 的终端地址。例如，您的 VCP 服务器地址（如果它作为代理），或其他云服务商提供的 API 地址。
    * 示例：`API_URL="https://api.openai.com/v1"` 或 `API_URL="http://localhost:8000/v1"`

* `API_KEY`
    * 描述：用于访问上述 API 的密钥。
    * 示例：`API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"`

* `AGENT_ASSISTANT_MAX_HISTORY_ROUNDS` (可选)
    * 描述：每个辅助 Agent 保留的对话历史轮数（一轮指一次用户提问和一次助手回答）。
    * 默认值：`5`
    * 示例：`AGENT_ASSISTANT_MAX_HISTORY_ROUNDS=3`

* `AGENT_ASSISTANT_CONTEXT_TTL_HOURS` (可选)
    * 描述：辅助 Agent 对话上下文的有效时间（小时）。超过此时长未活动的上下文将被清除。
    * 默认值：`12`
    * 示例：`AGENT_ASSISTANT_CONTEXT_TTL_HOURS=24`

### Agent 定义详解
您可以定义任意数量的辅助 Agent。每个 Agent 通过一组遵循特定命名模式的环境变量进行配置。

**Agent 名称 (`{NAME}`) 的由来**：
Agent 的调用名称是从定义其模型ID的变量键中自动提取的。例如，如果您定义了 `AGENT_MyExpert_ID`，那么 `MyExpert` 就是这个 Agent 在被调用时需要使用的 `agent_name`。

**Agent 配置变量格式**：
对于每一个 Agent，您需要定义以下变量，其中 `{NAME}` 部分是您为该 Agent设定的独特标识符（例如 `GROK_HELPER`, `TranslationBot`, `小助手` 等）：

* `AGENT_{NAME}_ID` (必需)
    * 描述：此辅助 Agent 对应的实际模型 ID (例如 `gpt-4o`, `claude-3-opus-20240229`, 或您在 API 服务中定义的其他模型名称)。
    * 示例：`AGENT_MyExpert_ID="gpt-4-turbo"`

* `AGENT_{NAME}_SYSTEM_PROMPT` (推荐)
    * 描述：赋予此辅助 Agent 的系统提示词，用于设定其角色、个性和行为准则。您可以在此提示词中使用 `{{Date}}`, `{{Time}}`, `{{Today}}` 等简单占位符，它们会被插件自动替换。
    * 默认值：`You are a helpful AI assistant named {NAME}.`
    * 示例：`AGENT_MyExpert_SYSTEM_PROMPT="你是一位精通中国历史的专家。今天是{{Date}}。"`

* `AGENT_{NAME}_MAX_OUTPUT_TOKENS` (可选)
    * 描述：此辅助 Agent 生成回复时最大的 token 数量。
    * 默认值：`2048`
    * 示例：`AGENT_MyExpert_MAX_OUTPUT_TOKENS=1500`

* `AGENT_{NAME}_TEMPERATURE` (可选)
    * 描述：控制模型输出随机性的参数，值越高输出越随机，值越低输出越确定。通常范围在 0 到 2 之间。
    * 默认值：`0.7`
    * 示例：`AGENT_MyExpert_TEMPERATURE=0.5`

* `AGENT_{NAME}_DESCRIPTION` (可选)
    * 描述：对该 Agent 功能的简短描述。此信息目前主要用于配置参考，未来可能用于更智能的 Agent 选择。
    * 示例：`AGENT_MyExpert_DESCRIPTION="用于回答关于中国历史的深度问题。"`

### 配置示例
```env
# AgentAssistant 插件基础配置
API_URL="YOUR_OPENAI_COMPATIBLE_API_ENDPOINT"
API_KEY="YOUR_API_KEY"
AGENT_ASSISTANT_MAX_HISTORY_ROUNDS=5
AGENT_ASSISTANT_CONTEXT_TTL_HOURS=12

# --- Agent 定义示例 ---

# Agent 1: 一个风趣的助手，名为 "GrokHelper"
AGENT_GrokHelper_ID="xai-grok-model-xyz" # 请替换为实际模型ID
AGENT_GrokHelper_SYSTEM_PROMPT="你是Grok，一个风趣且略带叛逆的AI。你喜欢幽默，不怕讨论有争议的话题，但始终乐于助人。当前日期是 {{Date}}，时间是 {{Time}}。"
AGENT_GrokHelper_MAX_OUTPUT_TOKENS=4000
AGENT_GrokHelper_TEMPERATURE=0.6
AGENT_GrokHelper_DESCRIPTION="一个风趣的AI助手，略带叛逆，适合创意任务和讨论。"

# Agent 2: 一个知识渊博的专家，名为 "DeepThinker"
AGENT_DeepThinker_ID="anthropic-claude-model-abc" # 请替换为实际模型ID
AGENT_DeepThinker_SYSTEM_PROMPT="你是一位知识渊博、善于分析的AI助手。你擅长提供详尽的解释和事实信息。今天是 {{Today}}。"
AGENT_DeepThinker_MAX_OUTPUT_TOKENS=3500
AGENT_DeepThinker_TEMPERATURE=0.3
AGENT_DeepThinker_DESCRIPTION="知识渊博且善于分析的AI，非常适合研究和事实查询。"

# Agent 3: 一个中文对话助手，名为 "小明同学"
AGENT_小明同学_ID="your-chinese-optimized-model-id" # 请替换为实际模型ID
AGENT_小明同学_SYSTEM_PROMPT="你好，我是小明同学，一个友好的中文对话助手。我们可以聊任何你感兴趣的话题！现在是北京时间 {{Time}}。"
AGENT_小明同学_DESCRIPTION="友好的中文对话助手。"
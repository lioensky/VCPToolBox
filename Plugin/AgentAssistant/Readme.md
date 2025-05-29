# AgentAssistant 插件 - README (通用版)

## 目录
1.  [插件简介](#1-插件简介)
2.  [核心功能](#2-核心功能)
3.  [配置指南 (`config.env`)](#3-配置指南-configenv)
    * [3.1 基础配置参数](#31-基础配置参数)
    * [3.2 定义 AI Agent](#32-定义-ai-agent)
    * [3.3 Agent 配置详解](#33-agent-配置详解)
    * [3.4 通用配置示例片段](#34-通用配置示例片段)
4.  [使用方法](#4-使用方法)
    * [4.1 AI 调用 Agent 的指令格式](#41-ai-调用-agent-的指令格式)
    * [4.2 如何确定可用的 `agent_name`](#42-如何确定可用的-agent_name)
    * [4.3 重要：调用时建议进行“自我介绍”](#43-重要调用时建议进行自我介绍)
    * [4.4 占位符替换机制](#44-占位符替换机制)
5.  [上下文记忆](#5-上下文记忆)
6.  [调试模式](#6-调试模式)
7.  [注意事项](#7-注意事项)

## 1. 插件简介
`AgentAssistant` 是一款VCP同步插件，允许您的主控AI动态调用和管理多个预先配置好的、具有不同能力和系统设定的辅助AI Agent。这使得主控AI可以根据任务需求，将特定子任务“委托”给最合适的辅助Agent处理，从而增强整体的问题解决能力和任务执行效率。

## 2. 核心功能
* **动态 Agent 加载**：从 `config.env` 文件中读取配置，支持定义和加载任意数量的辅助 AI Agent。
* **可定制的 Agent 画像**：每个辅助 Agent 都可以拥有独立的模型ID、系统提示词、输出参数（如 `max_tokens`, `temperature`）等。
* **显示/调用名称分离**：Agent 在配置文件中的基础标识使用纯ASCII字符，但其对外展示和被调用时使用的名称可以自定义（支持多语言）。
* **独立上下文记忆**：每个辅助 Agent 拥有独立的短期对话上下文记忆，轮数和有效时长可配置。
* **OpenAI 兼容 API**：通过标准的 OpenAI 兼容 API 与后端的大语言模型进行交互。

## 3. 配置指南 (`config.env`)
所有配置项均添加在您VCP项目**根目录**下的 `config.env` 文件中。请确保此文件以 **UTF-8 编码** 保存。

### 3.1 基础配置参数
这些是 `AgentAssistant` 插件运行所必需或推荐的基础参数：
* `AGENT_ASSISTANT_MAX_HISTORY_ROUNDS=5` (可选)
    * **说明**：每个辅助 Agent 保留的对话历史轮数（一轮指一次用户提问和一次助手回答）。
    * **默认值** (如果未在 `config.env` 中设置，以插件代码内定为准，通常是 `7` 或 `5`)。
* `AGENT_ASSISTANT_CONTEXT_TTL_HOURS=12` (可选)
    * **说明**：辅助 Agent 对话上下文的有效时间（小时）。超过此时长未活动的上下文将被清除。
    * **默认值** (同上，通常是 `24` 或 `12`)。

### 3.2 定义 AI Agent
您可以定义任意数量的辅助 Agent。推荐使用以下结构进行配置，以确保稳定性和灵活性：

1.  **Agent 基础名 (BASENAME)**：为每个 Agent 指定一个纯 ASCII 字符的内部基础名（例如 `MyHelper`, `CodeBotV1`, `ResearchAnalyst`）。这将用于构成相关的环境变量键。
2.  **核心配置变量**：
    * `AGENT_{BASENAME}_MODEL_ID` (必需)：此 Agent 使用的实际模型 ID。
    * `AGENT_{BASENAME}_CHINESE_NAME` (必需)：此 Agent 的**显示名称和调用名称**。
        * **重要说明**：尽管此环境变量名中包含 "CHINESE"，但它是为了兼容现有代码逻辑。您可以将其值设置为**任何语言的字符串**（例如 "MyHelper", "ResearchBot", "小助手", "MonAssistantDeCode"）。主控 AI 将使用这个名称来调用对应的辅助 Agent。
    * `AGENT_{BASENAME}_SYSTEM_PROMPT` (推荐)：此 Agent 的系统提示词。
        * **占位符说明**：您可以在此提示词中使用 `{{MaidName}}` 占位符。尽管占位符名为 "MaidName"（同样是历史原因），它将被上述 `AGENT_{BASENAME}_CHINESE_NAME` 字段的值（即Agent的实际显示/调用名称）所替换。
        * 您也可以使用 `{{Date}}`, `{{Time}}`, `{{Today}}` 这些由插件自动处理的时间日期占位符。
        * 更复杂的占位符如 `{{公共日记本}}`, `{{VarSomeConfig}}` 等，应由VCP主服务在调用本插件前预处理。

### 3.3 Agent 配置详解
对于每一个 Agent (以 `BASENAME` 区分)，您可以定义以下变量：

* `AGENT_{BASENAME}_MODEL_ID`：**必需**。模型ID。
    * 示例: `AGENT_MyHelper_MODEL_ID="gpt-4o"`
* `AGENT_{BASENAME}_CHINESE_NAME`：**必需**。Agent的显示/调用名称。
    * 示例: `AGENT_MyHelper_CHINESE_NAME="GeneralPurposeAssistant"`
* `AGENT_{BASENAME}_SYSTEM_PROMPT`：推荐。系统提示词。
    * 示例: `AGENT_MyHelper_SYSTEM_PROMPT="You are {{MaidName}}, a highly capable general-purpose AI assistant. You are to be helpful, concise, and accurate. Today is {{Date}}."`
* `AGENT_{BASENAME}_MAX_OUTPUT_TOKENS`：可选。Agent生成回复的最大token数 (插件代码内默认通常为 `40000`)。
    * 示例: `AGENT_MyHelper_MAX_OUTPUT_TOKENS=3500`
* `AGENT_{BASENAME}_TEMPERATURE`：可选。控制输出随机性 (0.0 - 2.0) (插件代码内默认通常为 `0.7`)。
    * 示例: `AGENT_MyHelper_TEMPERATURE=0.6`
* `AGENT_{BASENAME}_DESCRIPTION`：可选。对Agent功能的简短描述，主要用于配置时参考。
    * 示例: `AGENT_MyHelper_DESCRIPTION="A versatile assistant for a wide range of queries and tasks."`

### 3.4 通用配置示例片段
```env
# AgentAssistant 插件基础配置
API_URL="[https://api.example.com/v1](https://api.example.com/v1)"
API_KEY="your_secret_api_key"
AGENT_ASSISTANT_MAX_HISTORY_ROUNDS=5
AGENT_ASSISTANT_CONTEXT_TTL_HOURS=12

# --- 示例 Agent 定义 ---

# 示例 Agent 1: 研究助手
AGENT_RESEARCH_BOT_MODEL_ID="gemini-2.5-flash-preview-05-20"
AGENT_RESEARCH_BOT_CHINESE_NAME="ResearchPro" 
AGENT_RESEARCH_BOT_SYSTEM_PROMPT="Access to shared research DB: {{公共日记本}}. Your private notes: {{ResearchPro日记本}}.\nYou are {{MaidName}}, an AI research specialist. Your goal is to provide comprehensive, well-sourced answers. Focus on facts and data. Current date: {{Date}}."
AGENT_RESEARCH_BOT_MAX_OUTPUT_TOKENS=8000
AGENT_RESEARCH_BOT_TEMPERATURE=0.2
AGENT_RESEARCH_BOT_DESCRIPTION="AI for in-depth research and factual analysis."

# 示例 Agent 2: 代码生成助手 (中文调用名示例)
AGENT_CODEGEN_ASSISTANT_MODEL_ID="gemini-2.5-flash-preview-05-20"
AGENT_CODEGEN_ASSISTANT_CHINESE_NAME="编程小精灵"
AGENT_CODEGEN_ASSISTANT_SYSTEM_PROMPT="Available code libraries: {{VarCodeSnippets}}. Your project scratchpad: {{编程小精灵日记本}}.\n你好，我是你的AI编程伙伴，{{MaidName}}。我擅长多种编程语言，可以帮助你编写、解释和调试代码。\n今天是 {{Date}}，{{Today}}，现在时间是 {{Time}}。"
AGENT_CODEGEN_ASSISTANT_MAX_OUTPUT_TOKENS=10000
AGENT_CODEGEN_ASSISTANT_TEMPERATURE=0.4
AGENT_CODEGEN_ASSISTANT_DESCRIPTION="AI assistant for code generation, explanation, and debugging."

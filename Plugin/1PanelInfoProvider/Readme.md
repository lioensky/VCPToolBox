# 1PanelInfoProvider 插件 - README

## 目录
1.  [插件简介](#1-插件简介)
2.  [核心功能](#2-核心功能)
3.  [提供的变量](#3-提供的变量)
    *   [3.1 `{{1PanelOsInfo}}`](#31-1panelosinfo)
    *   [3.2 `{{1PanelDashboard}}`](#32-1paneldashboard)
4.  [配置指南](#4-配置指南)
5.  [使用方法](#5-使用方法)
6.  [数据结构示例](#6-数据结构示例)
    *   [6.1 `1PanelOsInfo` 示例](#61-1panelosinfo-示例)
    *   [6.2 `1PanelDashboard` 示例](#62-1paneldashboard-示例)

---

## 1. 插件简介
`1PanelInfoProvider` 是一款 **静态 (static)** 类型的 VCP 插件。它通过 VCP 的通用变量系统，将您的 [1Panel](https://github.com/1Panel-dev/1Panel) 服务器的实时状态和基础信息无缝注入到 AI 的上下文中。这使得 AI 能够“感知”到服务器的运行状况、资源使用率、已安装应用等关键信息，从而可以基于这些实时数据进行更智能的回答和决策。例如，AI 可以根据服务器负载建议您是否执行高资源消耗的任务，或者报告服务器上安装了哪些网站或数据库。

## 2. 核心功能
*   **实时信息获取**: 直接从 1Panel API 获取最新的服务器状态和操作系统信息。
*   **动态变量注入**: 提供 `{{1PanelOsInfo}}` 和 `{{1PanelDashboard}}` 两个占位符，可在任何支持 VCP 变量的地方（如系统提示词、角色卡）使用。
*   **弹性缓存机制**: 当无法连接到 1Panel API 时，插件会自动使用上一次成功获取的数据作为缓存，保证了信息提供的稳定性。
*   **配置简单**: 仅需在项目根目录的 `config.env` 文件中配置 1Panel 的地址和 API 密钥即可。

## 3. 提供的变量
本插件向 VCP 系统注册了两个核心的占位符变量：

### 3.1 `{{1PanelOsInfo}}`
此变量提供关于 1Panel 服务器**操作系统**的详细信息。它是一个 JSON 对象，包含了服务器的静态硬件和软件信息。
*   **内容**:
    *   操作系统名称 (Distributor)
    *   操作系统版本 (Release)
    *   系统代号 (Codename)
    *   系统架构 (Architecture)
    *   ...以及其他相关的系统底层信息。
*   **用途**: 让 AI 了解其运行的硬件和系统环境，有助于进行与环境相关的判断（例如，在讨论软件兼容性或编译选项时）。

### 3.2 `{{1PanelDashboard}}`
此变量提供 1Panel 服务器**仪表盘**的实时概览信息。它是一个 JSON 对象，包含了服务器动态变化的性能指标和资源统计。
*   **内容**:
    *   **监控信息**: CPU 使用率、核心数、平均负载、内存使用情况、磁盘空间占用等。
    *   **状态信息**: 服务器正常运行时间 (uptime)、网络速度等。
    *   **资源统计**: 已安装的应用、网站、数据库、计划任务等的数量统计。
*   **用途**: 这是最有价值的变量，它赋予 AI 对服务器健康状况和资源使用情况的“洞察力”。AI 可以利用这些信息回答关于“服务器现在忙不忙？”、“磁盘空间还够吗？”、“我安装了多少个网站？”等问题。

## 4. 配置指南
要使用此插件，您需要在 1PanelInfoProvicer **插件根目录**下的 `config.env` 文件中添加以下两个环境变量：

*   `PanelBaseUrl`
    *   **说明**: 您的 1Panel 服务器的访问地址，必须包含 `http://` 或 `https://`。
    *   **示例**: `PanelBaseUrl="http://192.168.1.100:12345"`

*   `PanelApiKey`
    *   **说明**: 您在 1Panel 的安全设置中创建的 API 密钥。
    *   **示例**: `PanelApiKey="your_very_long_api_key_string"`

配置完成后，请**重启 VCPToolBox 服务器**以使配置生效。

## 5. 使用方法
配置完成后，您可以非常方便地在 AI 的系统提示词或角色卡（Agent Profile）中使用这两个新变量。VCP 服务器会在处理发送给 AI 的消息时，自动将这两个占位符替换为从 1Panel 获取的实时 JSON 数据。

**在角色卡或系统提示词中加入以下内容：**

```
- 操作系统信息: {{1PanelOsInfo}}
- 服务器实时状态: {{1PanelDashboard}}
```

通过这种方式，AI 就能在对话开始前“学习”到服务器的当前状态，并随时准备回答您的相关问题。

## 6. 数据结构示例
以下是两个变量可能返回的 JSON 数据结构示例，以帮助您更好地理解其内容。

### 6.1 `1PanelOsInfo` 示例
```json
{
  "name": "Ubuntu",
  "version": "22.04.3 LTS (Jammy Jellyfish)",
  "arch": "x86_64",
  "kernel": "5.15.0-88-generic",
  "distributor": "Ubuntu",
  "release": "22.04",
  "codename": "jammy"
}
```

### 6.2 `1PanelDashboard` 示例
```json
{
  "monitor": {
    "cpu_used": 5.8,
    "cpu_total": 4,
    "cpu_load": {
      "load1": 0.53,
      "load5": 0.38,
      "load15": 0.35
    },
    "mem_used": 4180,
    "mem_total": 7837,
    "disk_used": 50,
    "disk_total": 200,
    "uptime": 1234567
  },
  "state": {
    "net_speed_up": 1024,
    "net_speed_down": 20480,
    "net_total_up": 1234567890,
    "net_total_down": 9876543210
  },
  "resource_stats": {
    "app": 10,
    "database": 5,
    "website": 8,
    "cronjob": 3
  }
}

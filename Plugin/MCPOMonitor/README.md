# MCPOMonitor - MCPO 服务状态监控器

## 概述

MCPOMonitor 是一个静态插件，用于监控 MCPO 服务器状态并提供所有可用 MCP 工具的详细信息。它通过 `{{MCPOServiceStatus}}` 占位符将监控信息集成到系统提示词中。

## 功能特性

- 🔍 **实时健康检查**: 监控 MCPO 服务器连接状态和各个端点可用性
- 📊 **服务状态概览**: 显示服务器版本、可用服务数量和工具统计
- 🛠️ **工具详情展示**: 提供完整的工具名称、描述、参数说明和调用示例
- 💾 **双重缓存机制**: 同时保存格式化文本和原始JSON数据
- ⚡ **快速离线检测**: 服务器不可用时快速返回缓存或离线报告
- 🎯 **状态标识**: 使用颜色编码（🟢/🔴）提供清晰的状态标识

## 配置说明

### 基本配置

插件的配置文件位于 `Plugin/MCPOMonitor/config.env`：

```env
# MCPO 服务器连接配置
# 支持多种端口配置方式：
# 方式1: 仅设置端口号（推荐，与MCPO插件共享配置）
MCPO_PORT=9000

# 方式2: 设置完整URL（优先级较低）
MCPO_HOST=http://0.0.0.0:9000

# 方式3: 同时设置时，MCPO_PORT优先级更高
# MCPO_PORT=9000
# MCPO_HOST=http://localhost:9000

# API密钥（与MCPO插件共享）
MCPO_API_KEY=vcp-mcpo-secret

# 缓存配置
ENABLE_CACHE=true
CACHE_TTL_MINUTES=5

# 显示配置
INCLUDE_DETAILED_PARAMS=true

# 健康检查配置
HEALTH_CHECK_TIMEOUT=5000
```

### 端口配置说明

**配置优先级**（从高到低）：
1. MCPOMonitor插件自己的 `MCPO_PORT` 配置
2. MCPO插件的 `MCPO_PORT` 配置（自动共享）
3. MCPOMonitor插件的 `MCPO_HOST` 完整URL配置  
4. 默认值 `9000`

**自动配置共享**：
- 插件会自动读取 `Plugin/MCPO/config.env` 中的端口配置
- 如果MCPO和MCPOMonitor插件都存在，端口配置会自动同步
- 支持独立配置，也支持共享配置

**配置验证**：
```bash
# 启用调试模式查看当前端口配置
cd Plugin/MCPOMonitor
DebugMode=true node mcpo_monitor.js 2>&1 | head -3
```

### 更新间隔配置

插件默认每30秒自动更新一次状态信息。用户可以通过修改 `config.env` 文件中的 `REFRESH_INTERVAL_CRON` 配置项来自定义更新间隔。

**修改步骤：**

1. 编辑 `Plugin/MCPOMonitor/config.env` 文件
2. 修改 `REFRESH_INTERVAL_CRON` 的值（Cron 表达式格式：秒 分 时 日 月 星期）
3. 保存文件
4. 重启 VCP 服务器：`pm2 restart server`

**常用间隔示例：**
- 每30秒: `REFRESH_INTERVAL_CRON=*/30 * * * * *`
- 每1分钟: `REFRESH_INTERVAL_CRON=0 * * * * *`
- 每5分钟: `REFRESH_INTERVAL_CRON=0 */5 * * * *`
- 每10分钟: `REFRESH_INTERVAL_CRON=0 */10 * * * *`
- 每小时: `REFRESH_INTERVAL_CRON=0 0 * * * *`

**验证配置：**
```bash
# 启用调试模式查看当前配置
cd Plugin/MCPOMonitor
DebugMode=true node mcpo_monitor.js 2>&1 | head -5
```

## 占位符使用

在 AI 系统提示词中添加 `{{MCPOServiceStatus}}` 占位符，插件会自动将其替换为当前的 MCPO 服务状态报告。

### 报告内容包括

1. **服务器状态概览**
   - 连接状态（🟢 正常 / 🔴 异常）
   - 服务器版本信息
   - 可用服务和工具数量统计

2. **健康检查详情**
   - OpenAPI文档端点状态
   - Swagger UI界面状态
   - 详细错误信息（如有）

3. **可用服务详情**
   - 各服务的运行状态
   - 版本信息和文档链接
   - 错误诊断信息

4. **工具详情展示**
   - 按服务分组的工具列表
   - 完整的参数说明
   - VCP调用示例
   - 通用调用格式指南

## 缓存机制

插件实现了双重缓存策略：

- **文本缓存**: `mcpo_status_cache.txt` - 存储格式化的状态报告
- **JSON缓存**: `mcpo_status_cache.json` - 存储原始状态数据

缓存有效期默认为5分钟，可通过 `CACHE_TTL_MINUTES` 配置项调整。

## 错误处理

- **服务器不可用**: 优先返回缓存数据，无缓存时返回离线报告
- **部分服务异常**: 显示具体错误信息和故障排除建议
- **网络超时**: 自动降级为快速检查模式

## 故障排除

### 常见问题

1. **连接超时**
   - 检查 MCPO 服务器是否正在运行
   - 验证 `MCPO_HOST` 配置是否正确
   - 检查网络连接和防火墙设置

2. **API认证失败**
   - 确认 `MCPO_API_KEY` 配置正确
   - 检查 MCPO 服务器的API密钥设置

3. **插件不更新**
   - 检查VCP服务器日志中的错误信息
   - 验证 Cron 表达式格式是否正确
   - 确认插件执行权限

### 调试模式

启用调试模式获取详细日志：

```env
# 在 config.env 文件中添加
DebugMode=true
```

## 依赖要求

- Node.js v20+
- node-fetch (动态导入)
- 可访问的 MCPO 服务器

## 版本信息

- 插件版本: 1.0.0
- 支持的VCP版本: 最新版
- 最后更新: 2025年8月

## 开发者说明

插件采用模块化设计，主要组件：

- `_quickServerCheck()`: 快速服务器可用性检查
- `_checkServerHealth()`: 详细健康状态检查
- `_getToolDetails()`: 工具信息获取和解析
- `_formatStatusReport()`: 状态报告格式化
- `_readCache()` / `_writeCache()`: 缓存管理

如需扩展功能或修改报告格式，请参考源代码中的相关方法。
# MCPO 插件部署指南

本指南详细说明如何在 VCP 系统中部署和使用 MCPO 插件。

## 📋 前置要求

### 系统要求
- Python 3.8 或更高版本
- Node.js 16 或更高版本（用于某些 MCP 服务器）
- 已运行的 VCP 系统

### 依赖安装

1. **安装 mcpo 包**
   ```bash
   pip install mcpo
   ```

2. **安装其他依赖**
   ```bash
   cd Plugin/MCPO
   pip install -r requirements.txt
   ```

3. **安装 MCP 服务器示例**
   ```bash
   # 安装时间服务器
   pip install mcp-server-time
   
   # 或使用 uvx 方式
   # uvx --help
   ```

## 🚀 部署步骤

### 1. 确认插件文件

确保 `Plugin/MCPO/` 目录包含以下文件：
- `plugin-manifest.json` - 插件清单
- `mcpo_plugin.py` - 主程序
- `config.env` - 配置文件
- `requirements.txt` - Python 依赖
- `mcp-config.json` - MCP 服务器配置
- `README.md` - 文档
- `test_mcpo_plugin.py` - 测试脚本

### 2. 配置 MCP 服务器

编辑 `mcp-config.json` 文件，配置您要使用的 MCP 服务器：

```json
{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]  
    }
  }
}
```

### 3. 调整插件配置

根据需要修改 `config.env`：

```env
# MCPO 服务器设置
MCPO_PORT=9000
MCPO_API_KEY=your-secret-key
MCPO_AUTO_START=true

# Python 解释器
PYTHON_EXECUTABLE=python3

# MCP 配置文件路径
MCP_CONFIG_PATH=./mcp-config.json

# 启用热重载
MCPO_HOT_RELOAD=true
```

### 4. 测试插件功能

运行测试脚本：

```bash
cd Plugin/MCPO
python test_mcpo_plugin.py
```

如果看到 "🎉 所有测试通过！"，说明插件部署成功。

### 5. 在 VCP 系统中启用

在 AI 的系统提示词中添加：

```
系统工具列表：{{VCPMCPO}}
```

### 6. 重启 VCP 系统

重启 VCP 主服务器以加载新插件：

```bash
node server.js
```

## 🔧 配置指南

### 环境变量说明

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `MCPO_PORT` | integer | 9000 | MCPO 服务器端口 |
| `MCPO_API_KEY` | string | vcp-mcpo-secret | API 访问密钥 |
| `MCPO_AUTO_START` | boolean | true | 自动启动服务器 |
| `PYTHON_EXECUTABLE` | string | python | Python 解释器路径 |
| `MCP_CONFIG_PATH` | string | ./mcp-config.json | MCP 配置文件路径 |
| `MCPO_HOT_RELOAD` | boolean | true | 启用热重载 |

### MCP 服务器类型

支持以下类型的 MCP 服务器：

#### 1. Stdio 服务器（推荐）
```json
{
  "server_name": {
    "command": "python",
    "args": ["-m", "your_mcp_server"]
  }
}
```

#### 2. SSE 服务器
```json
{
  "server_name": {
    "type": "sse",
    "url": "http://localhost:8001/sse",
    "headers": {
      "Authorization": "Bearer token"
    }
  }
}
```

#### 3. Streamable HTTP 服务器
```json
{
  "server_name": {
    "type": "streamable-http", 
    "url": "http://localhost:8002/mcp"
  }
}
```

## 🔍 常见问题

### 问题 1: 端口冲突
**症状**: MCPO 服务器启动失败，提示端口被占用

**解决方案**:
1. 修改 `config.env` 中的 `MCPO_PORT`
2. 或终止占用端口的进程：
   ```bash
   lsof -ti:9000 | xargs kill
   ```

### 问题 2: MCP 服务器无法启动
**症状**: 工具列表为空，或健康检查失败

**解决方案**:
1. 检查 MCP 服务器是否正确安装
2. 验证 `mcp-config.json` 配置语法
3. 查看 MCPO 服务器日志：
   ```bash
   curl http://localhost:9000/docs
   ```

### 问题 3: 权限错误
**症状**: Python 脚本无法执行

**解决方案**:
1. 确认 Python 路径：
   ```bash
   which python3
   ```
2. 更新 `config.env` 中的 `PYTHON_EXECUTABLE`
3. 确认文件权限：
   ```bash
   chmod +x mcpo_plugin.py
   ```

### 问题 4: VCP 系统无法识别插件
**症状**: `{{VCPMCPO}}` 占位符无内容

**解决方案**:
1. 检查插件目录结构
2. 验证 `plugin-manifest.json` 格式
3. 重启 VCP 服务器
4. 查看 VCP 日志确认插件加载状态

## 🎯 使用示例

### 基础用法

1. **检查系统状态**
   ```
   请使用 MCPO 检查当前系统状态
   ```

2. **列出所有工具**
   ```
   请列出所有可用的 MCP 工具
   ```

3. **调用时间工具**
   ```
   请使用 MCPO 调用时间工具获取当前时间
   ```

### 高级用法

1. **批量管理**
   ```
   请重新发现所有 MCP 工具，然后列出工具列表
   ```

2. **故障排除**
   ```
   MCPO 服务器无响应，请重启服务器并检查状态
   ```

## 📊 监控与维护

### 日志监控
- VCP 系统日志: `DebugLog/ServerLog-*.txt`
- MCPO 插件运行日志通过 VCP 系统记录

### 性能优化
- 启用缓存机制减少重复请求
- 使用热重载避免频繁重启
- 监控内存使用情况

### 定期维护
- 定期更新 mcpo 和 MCP 服务器包
- 清理过期的服务器进程
- 备份配置文件

## 🔗 相关资源

- [MCP 官方文档](https://modelcontextprotocol.io/)
- [mcpo 项目](https://github.com/open-webui/mcpo)
- [VCP 系统文档](../../../README.md)

---

如有问题，请查阅 [README.md](README.md) 或提交 Issue。
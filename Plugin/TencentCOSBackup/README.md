# Server腾讯云COS备份插件

## 概述

ServerTencentCOSBackup是一个功能完整的腾讯云对象存储（COS）插件，为VCP系统提供强大的云存储功能。该插件支持文件上传、下载、复制、移动、删除和列出操作，具有精细的权限控制、自动压缩功能和病毒检测功能。

**重要限制**：目前只支持部署VCPToolBox的机器的本地文件的备份操作,如需对VCPChat支持请到VCPChat\VCPDistributedServer\Plugin\ChatTencentcos进行配置
**病毒检测功能**：无需额外授权和权限检查，支持对COS中的文件和公网文件进行病毒检测。

## 主要特性

- **完整的文件操作**：支持上传、下载、复制、移动、删除和列出文件
- **权限控制**：基于配置文件的精细权限管理
- **自动压缩**：大文件和文件夹自动压缩为ZIP格式
- **动态配置**：实时读取config.env中的AGENT_FOLDERS_CONFIG
- **权限描述**：自动生成详细的文件夹权限文字描述
- **错误处理**：完善的错误处理和日志记录
- **断点续传**：支持大文件的断点续传上传和下载
- **病毒检测**：支持对COS文件和公网文件进行病毒检测，无需额外授权

## 安装和配置

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `config.env.example` 为 `config.env` 并配置相关参数：

```bash
cp config.env.example config.env
```

#### 必需配置

- `TENCENTCLOUD_SECRET_ID`：腾讯云密钥ID（建议使用环境变量）
- `TENCENTCLOUD_SECRET_KEY`：腾讯云密钥Key（建议使用环境变量）
- `COS_BUCKET_NAME`：腾讯云COS存储桶名称
- `COS_REGION`：腾讯云COS存储桶所在地域

#### 可选配置

- `AGENT_PARENT_DIR`：AgentAI操作文件夹的父目录名称（默认：VCPAgentAI）
- `AGENT_FOLDERS_CONFIG`：文件夹权限配置
- `COMPRESS_THRESHOLD_MB`：文件压缩阈值（默认：100MB）
- `DEBUG_MODE`：调试模式开关（默认：false）
- `ENABLE_LOGGING`：日志记录功能开关（默认：false）

### 3. 文件夹权限配置

`AGENT_FOLDERS_CONFIG` 格式：`文件夹名:上传权限:列出权限:下载权限:删除权限:复制和移动权限`

示例配置：
```
AGENT_FOLDERS_CONFIG=agent-data:true:true:true:true:false,agent-temp:true:true:true:true:true,agent-readonly:false:true:false:false:false
```

权限说明：
- `agent-data`：允许上传、列出、下载、复制和移动，禁止删除
- `agent-temp`：允许所有操作
- `agent-readonly`：只允许列出，禁止其他操作

## 使用方法

### 获取权限信息

```json
{
  "command": "get_permissions"
}
```

返回详细的权限配置和描述信息。

### 上传文件

```json
{
  "command": "upload_file",
  "local_path": "/path/to/local/file.txt",
  "cos_folder": "agent-data",
  "remote_filename": "backup_file.txt"
}
```

### 下载文件

```json
{
  "command": "download_file",
  "cos_key": "VCPAgentAI/agent-data/backup_file.txt",
  "local_path": "/path/to/save/file.txt"
}
```

### 复制文件

```json
{
  "command": "copy_file",
  "source_cos_key": "VCPAgentAI/agent-data/backup_file.txt",
  "target_cos_folder": "agent-temp",
  "target_filename": "copied_file.txt"
}
```

### 移动文件

```json
{
  "command": "move_file",
  "source_cos_key": "VCPAgentAI/agent-temp/temp_file.txt",
  "target_cos_folder": "agent-data",
  "target_filename": "moved_file.txt"
}
```

### 删除文件

```json
{
  "command": "delete_file",
  "cos_key": "VCPAgentAI/agent-temp/old_file.txt"
}
```

### 列出文件

```json
{
  "command": "list_files",
  "cos_folder": "agent-data"
}
```

### 提交病毒检测（通过COS文件键）

```json
{
  "command": "submit_virus_detection_by_key",
  "key": "VCPAgentAI/agent-data/通用表情包.txt"
}
```

### 提交病毒检测（通过公网文件URL）

```json
{
  "command": "submit_virus_detection_by_url",
  "url": "http://example.com/file.exe"
}
```

### 查询病毒检测结果

```json
{
  "command": "query_virus_detection",
  "job_id": "av1234567890abcdef"
}
```

## 权限系统

插件实现了基于文件夹的权限控制系统：

- **上传权限**：控制是否可以上传文件到指定文件夹
- **列出权限**：控制是否可以列出文件夹中的文件
- **下载权限**：控制是否可以从指定文件夹下载文件
- **删除权限**：控制是否可以删除文件夹中的文件
- **复制和移动权限**：控制是否可以在文件夹间复制和移动文件

## 自动压缩功能

- 当文件大小超过 `COMPRESS_THRESHOLD_MB`（默认100MB）时自动压缩
- 文件夹上传时自动压缩为ZIP格式
- 压缩后的文件会在文件名后添加`.zip`后缀

## 错误处理

插件提供完善的错误处理机制：

- **权限错误**：当操作超出权限范围时返回详细错误信息
- **文件不存在**：本地文件或COS文件不存在时的错误提示
- **网络错误**：COS服务连接问题的错误处理
- **配置错误**：配置参数缺失或错误的提示

## 日志记录

插件会在以下位置记录日志：
- 控制台输出（stderr）
- `cos_operations.log` 文件

日志包含详细的操作信息、错误堆栈和调试信息。

## 安全注意事项

1. **密钥安全**：
   - 建议使用环境变量存储腾讯云密钥
   - 避免在代码中硬编码密钥信息
   - 使用最小权限原则配置COS访问权限

2. **权限控制**：
   - 仔细配置文件夹权限，避免不必要的操作权限
   - 定期审查权限配置

3. **文件安全**：
   - 删除操作不可逆，请谨慎使用
   - 重要文件建议在多个位置备份

## 故障排除

### 常见问题

1. **初始化失败**
   - 检查腾讯云密钥配置
   - 确认COS存储桶存在且可访问
   - 检查网络连接

2. **权限错误**
   - 验证AGENT_FOLDERS_CONFIG配置格式
   - 检查文件夹名称是否正确

3. **上传/下载失败**
   - 检查本地文件路径
   - 确认COS键格式正确
   - 查看详细错误日志

4. **文件路径限制**
   - **重要**：插件目前只支持部署VCPToolBox的机器的本地文件
   - 无法访问远程机器或网络共享路径上的文件
   - 确保要备份的文件位于VCPToolBox部署机器的本地存储上

### 调试模式

启用调试模式可以获取更详细的日志信息：

```
DEBUG_MODE=true
```

## 版本信息

- **版本**：1.0.0
- **作者**：liukk222
- **兼容性**：VCP系统
- **Python要求**：3.12+
  
## 许可证

本插件遵循VCPToolBox项目的许可证条款。

## 技术支持

如有问题或建议，请联系VCP开发团队。
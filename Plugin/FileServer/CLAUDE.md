[根目录](../../../CLAUDE.md) > [Plugin](../) > **FileServer**

# FileServer 插件

## 面包屑导航
[根目录](../../../CLAUDE.md) > [Plugin](../) > **FileServer**

## 模块职责

FileServer（文件服务器）是一个服务插件，提供文件上传、下载和管理功能。它注册HTTP路由以提供额外的文件服务，允许用户通过Web界面上传文件并获取可访问的URL，同时也支持文件列表、删除等管理操作。

## 入口与启动

- **入口文件**: `file-server.js`
- **启动命令**: 自动作为服务插件加载并注册路由
- **插件类型**: 服务插件
- **通信协议**: HTTP (通过Express路由)
- **服务端口**: 与主服务器共享端口

## 对外接口

### HTTP路由
- **POST /file-upload**: 文件上传接口
- **GET /files**: 文件列表接口
- **DELETE /files/:filename**: 文件删除接口
- **GET /files/:filename**: 文件下载接口

### 插件命令
- **uploadFile**: 上传文件到服务器
- **listFiles**: 获取文件列表
- **deleteFile**: 删除指定文件
- **getFileUrl**: 获取文件访问URL

## 关键依赖与配置

### 配置文件
- **插件清单**: `plugin-manifest.json`
- **配置文件**: `config.env.example` (需要复制为`config.env`并填写实际值)

### 依赖项
- Node.js 环境
- Express.js (用于路由注册)
- 文件系统相关Node.js模块

### 配置项
```env
File_Key=YOUR_FILE_KEY_SUCH_AS_123456
CALLBACK_BASE_URL="http://localhost:6005/plugin-callback"
```

### 文件存储
- **存储目录**: 默认使用项目的file/目录
- **访问控制**: 通过File_Key进行访问权限验证

## 数据模型

### 文件信息结构
每个上传的文件包含以下信息：
- 文件名
- 文件大小
- 上传时间
- 文件类型
- 访问URL

### 文件管理
- 支持文件上传、下载、列表、删除
- 提供文件访问URL生成
- 支持访问权限控制

## 测试与质量

### 测试文件
目前未发现专门的测试文件，建议添加：
- `test_file_server.js` - 文件上传下载功能测试

### 质量工具
- 暂无发现代码质量工具配置

## 常见问题 (FAQ)

1. **如何上传文件？**
   - 通过POST请求到/file-upload接口
   - 或通过VCP工具调用协议使用uploadFile命令

2. **文件存储在哪里？**
   - 默认存储在项目的file/目录下

3. **如何获取文件的访问URL？**
   - 使用getFileUrl命令或通过文件列表接口获取

4. **文件访问有权限控制吗？**
   - 是的，通过File_Key进行访问权限验证

## 相关文件清单

```
Plugin/FileServer/
├── file-server.js             # 主入口文件
├── plugin-manifest.json      # 插件清单
├── config.env.example        # 配置文件模板
└── README.md                 # 插件说明
```

## 变更记录 (Changelog)

### 2025-09-30 20:07:41 - AI上下文初始化
- 创建FileServer插件文档
- 添加导航面包屑
- 完善插件功能和配置说明
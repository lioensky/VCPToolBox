# FileOperator - 全能文件操作器

## 简介

FileOperator（内部名称ServerFileOperator）是 VCP 的核心文件系统插件，提供对服务器文件的全方位操作能力——包括读取、写入、编辑、复制、移动、搜索、下载等。它能自动识别并提取 PDF、Word（.docx）、Excel（.xlsx/.csv）等文档的纯文本内容，是 Agent 与物理文件系统之间的桥梁。

### 主要特性

- **19种文件操作命令**：涵盖读写、编辑、复制、移动、重命名、删除、搜索等全部场景
- **智能文档解析**：自动提取 PDF、Word、Excel、CSV 等格式的文本内容
- **批量操作**：单次调用可执行多个命令，通过数字后缀区分参数组
- **安全写入**：WriteFile 自动防重名（追加序号），RenameFile 防覆盖
- **转义写入**：WriteEscapedFile 专为生成包含 VCP 指令语法的文件而设计
- **Canvas 集成**：CreateCanvas 可创建即时编辑窗口
- **Diff 修改**：ApplyDiff 支持精确的文件局部修改
- **零外部依赖**：仅使用 Node.js 原生模块

## 系统要求

- Node.js v18.0.0 或更高版本

## 配置选项

在 `config.env` 中可配置以下参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `ALLOWED_DIRECTORIES` | 允许操作的目录白名单（逗号分隔的绝对路径），为空则允许所有目录 | 空 |
| `DEFAULT_DOWNLOAD_DIR` | DownloadFile 的默认下载路径 | - |
| `WEB_FILE_DIR` | WebReadFile/DownloadFile 的默认文件存储目录，优先级高于 DEFAULT_DOWNLOAD_DIR | VCPToolBox/file/ |
| `MAX_FILE_SIZE` | 允许操作的最大文件大小（字节） | 10485760 (10MB) |
| `MAX_DIRECTORY_ITEMS` | ListDirectory 返回的最大条目数 | 1000 |
| `MAX_SEARCH_RESULTS` | SearchFiles 返回的最大结果数 | 100 |
| `DEBUG_MODE` | 是否启用调试日志 | false |

## 命令一览

### 文件读取

| 命令 | 说明 |
|------|------|
| `ReadFile` | 读取文件内容，自动解析 PDF/Word/Excel/CSV |
| `WebReadFile` | 从URL 下载文件后读取内容 |
| `FileInfo` | 获取文件或目录的详细元信息 |

### 文件写入

| 命令 | 说明 |
|------|------|
| `WriteFile` | 写入文件（同名自动追加序号，不覆盖） |
| `WriteEscapedFile` | 写入包含 VCP 指令语法的文件（自动转义替换） |
| `AppendFile` | 追加内容到文件末尾（文件不存在则创建） |
| `EditFile` | 覆盖编辑已有文件（文件不存在则报错） |
| `ApplyDiff` | 局部修改文件（支持 diff 内容或搜索替换） |

### 目录操作

| 命令 | 说明 |
|------|------|
| `ListDirectory` | 列出目录内容 |
| `CreateDirectory` | 创建目录（含父目录） |
| `ListAllowedDirectories` | 列出所有授权目录的一级结构 |

### 文件管理

| 命令 | 说明 |
|------|------|
| `CopyFile` | 复制文件（同名自动重命名） |
| `MoveFile` | 移动文件或目录 |
| `RenameFile` | 重命名文件（目标已存在则报错） |
| `DeleteFile` | 删除文件或空目录 |

### 搜索与下载

| 命令 | 说明 |
|------|------|
| `SearchFiles` | 递归搜索匹配模式的文件 |
| `DownloadFile` | 从 URL 异步下载文件到本地 |

### 特殊功能

| 命令 | 说明 |
|------|------|
| `CreateCanvas` | 创建Canvas 编辑窗口 |
| `UpdateHistory` | 安全更新 JSON 格式的聊天历史文件 |

## 使用示例

### 读取文件

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」ReadFile「末exp」,
filePath:「始exp」/path/to/document.pdf「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 写入文件

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」WriteFile「末exp」,
filePath:「始exp」/path/to/new_file.txt「末exp」,
content:「始exp」这是文件内容。「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 列出目录

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」ListDirectory「末exp」,
directoryPath:「始exp」/path/to/directory「末exp」,
showHidden:「始exp」true「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 搜索文件

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」SearchFiles「末exp」,
searchPath:「始exp」/project/src「末exp」,
pattern:「始exp」*.js「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 局部修改文件（ApplyDiff）

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」ApplyDiff「末exp」,
filePath:「始exp」/path/to/file.js「末exp」,
searchString:「始exp」const oldValue = 42;「末exp」,
replaceString:「始exp」const newValue = 100;「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 批量操作

单次调用执行多个命令，通过数字后缀区分参数组：

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command1:「始exp」ReadFile「末exp」,
filePath1:「始exp」/path/to/file1.txt「末exp」,
command2:「始exp」ListDirectory「末exp」,
directoryPath2:「始exp」/path/to/dir「末exp」,
command3:「始exp」EditFile「末exp」,
filePath3:「始exp」/path/to/file2.txt「末exp」,
content3:「始exp」新的内容「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

### 写入包含 VCP 指令的文件

当需要创建包含 VCP 工具调用语法的文件时（如 plugin-manifest.json），使用 WriteEscapedFile：

<<<[TOOL_REQUEST_EXP]>>>
tool_name:「始exp」FileOperator「末exp」,
command:「始exp」WriteEscapedFile「末exp」,
filePath:「始exp」/path/to/manifest.json「末exp」,
content:「始exp」{
  "description": "调用格式:\n<<<[TOOL_REQUEST_EXP]>>>\ntool_name:「始exp」MyPlugin「末exp」\n<<<[END_TOOL_REQUEST_EXP]>>>"
}「末exp」
<<<[END_TOOL_REQUEST_EXP]>>>

## 参数详解

### ReadFile

| 参数 | 必需 | 说明 | 默认值 |
|------|------|------|--------|
| `filePath` | 是 | 文件路径 | - |
| `encoding` | 否 | 文件编码 | utf8 |

### WriteFile / EditFile / AppendFile

| 参数 | 必需 | 说明 | 默认值 |
|------|------|------|--------|
| `filePath` | 是 | 文件路径 | - |
| `content` | 是 | 写入内容 | - |
| `encoding` | 否 | 文件编码 | utf8 |

### CopyFile / MoveFile / RenameFile

| 参数 | 必需 | 说明 |
|------|------|------|
| `sourcePath` | 是 | 源文件路径 |
| `destinationPath` | 是 | 目标路径 |

### SearchFiles

| 参数 | 必需 | 说明 |
|------|------|------|
| `searchPath` | 是 | 搜索起始目录 |
| `pattern` | 是 | 匹配模式（支持通配符） |
| `options` | 否 | JSON 字符串，可含 caseSensitive、includeHidden、fileType |

### ApplyDiff

| 参数 | 必需 | 说明 |
|------|------|------|
| `filePath` | 是 | 目标文件路径 |
| `diffContent` | 否 | diff 格式的修改内容 |
| `searchString` | 否 | 要查找的文本 |
| `replaceString` | 否 | 替换后的文本 |

### DownloadFile

| 参数 | 必需 | 说明 |
|------|------|------|
| `url` | 是 | 下载 URL |
| `downloadDir` | 否 | 下载目录（默认使用配置） |
| `fileName` | 否 | 自定义文件名 |

## 前端vs 后端

| 调用名| 作用域 | 说明 |
|--------|--------|------|
| `FileOperator` | 前端（VCPChat） | 操作前端电脑上的文件 |
| `ServerFileOperator` | 后端（VCPToolBox） | 操作后端服务器上的文件 |

两者命令和参数完全相同，区别仅在于操作的文件系统位置。

## 注意事项

1. **WriteFile 不覆盖**：如果目标文件已存在，会自动追加序号（如 `file(1).txt`），确保不会意外覆盖
2. **EditFile 要求文件存在**：如果文件不存在会报错，请先用 WriteFile 创建
3. **RenameFile 防覆盖**：如果目标文件名已存在会报错，不会静默覆盖
4. **路径安全**：如果配置了 ALLOWED_DIRECTORIES，所有操作都会验证路径是否在白名单内
5. **大文件限制**：默认最大 10MB，可通过 MAX_FILE_SIZE 调整
6. **文档解析**：ReadFile 自动识别 PDF/Word/Excel/CSV 并提取文本，无需额外配置

## 文件结构

```
FileOperator/
├── FileOperator.js         # 主程序（59KB，19个命令实现）
├── CodeValidator.js         # 代码验证模块
├── config.env               # 配置文件
├── plugin-manifest.json     # 插件清单（15.9KB，完整命令描述）
└── README.md# 本文档
```

---

FileOperator / ServerFileOperator 是 VCP 生态中最基础、最常用的插件之一，是Agent 操作物理文件系统的核心桥梁。
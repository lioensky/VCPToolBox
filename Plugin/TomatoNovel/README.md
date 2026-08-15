# TomatoNovel

TomatoNovel 是一个同步 `stdio` 插件，用于通过本地 TomatoNovelDownloader 服务搜索番茄小说、下载 EPUB，并提取简介与目录。下载器本身由用户单独安装和配置；插件不会携带下载器二进制文件。

## 能力

- `search`: 按关键词搜索书籍。
- `download_intro`: 下载最小章节范围并返回简介、作者信息和目录摘要。
- `download`: 下载整本 EPUB，并处理下载器生成的输出文件。

## 安装与配置

1. 安装可用的 `TomatoNovelDownloader.exe`，并确认它支持 `--server` 参数。
2. 复制 `config.env.example` 为同目录的 `config.env`。
3. 设置 `TOMATO_DOWNLOADER_PATH` 为本机下载器的绝对路径。可选地设置工作目录、输出目录、服务端口和代理。
4. 在 VCPToolBox 中加载此目录的 `plugin-manifest.json`。

`config.env` 只存在于本机，不能提交到 Git。插件不再包含任何开发者本机路径或固定代理；未配置下载器时会给出明确错误。

## 调用示例

```json
{"tool_name":"TomatoNovel","action":"search","query":"科幻小说"}
```

```json
{"tool_name":"TomatoNovel","action":"download_intro","book_id":"7580018670118652952"}
```

```json
{"tool_name":"TomatoNovel","action":"download","book_id":"7580018670118652952"}
```

命令行冒烟测试：

```powershell
'{"tool_name":"TomatoNovel","action":"search","query":"科幻小说"}' | node TomatoNovel.js
```

## 运行依赖

- Node.js 18 或更高版本
- Python 3（用于 `download_intro` 的 EPUB 摘要提取）
- 本机可运行的 TomatoNovelDownloader
- 插件目录可解析 `dotenv`（VCPToolBox 根目录通常已提供）

## 说明

请确认你对请求的小说内容拥有相应的访问和使用权，并遵守目标站点的服务条款。下载器的网络请求、登录状态和代理由用户自行负责。

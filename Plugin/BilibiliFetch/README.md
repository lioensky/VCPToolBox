# Bilibili 内容获取插件 (VCP)

该插件用于从 Bilibili 视频链接中提取多种信息，包括视频标题、作者、字幕、热门弹幕、热门评论以及视频特定时间点的快照截图。

## 功能

- **短链接解析**：支持 `https://b23.tv/xxxxxx` 格式的短链接自动解析。
- **视频元数据**：获取视频的标题和作者信息。
- **字幕提取**：根据 URL 或 BVID 提取指定语言的字幕。
- **热门弹幕与评论**：并发获取指定数量的热门弹幕和热门评论。
- **智能快照 (Videoshot)**：支持指定时间点，自动从视频拼版图中裁剪出精确的单张截图。
- **分类存储**：截图会按照视频标题自动建立子目录存放，方便管理。
- **HTML 渲染**：快照以 HTML `<img>` 标签形式返回，支持前端直接显示。

## 配置

### 环境变量

在项目根目录的 `config.env` 文件中，你需要配置以下变量：

- **`BILIBILI_COOKIE`**: 你的 Bilibili 网站登录 Cookie（建议配置）。
- **`VarHttpUrl`**, **`SERVER_PORT`**, **`IMAGESERVER_IMAGE_KEY`**: 用于构造可访问的图像服务器 URL。
- **`PROJECT_BASE_PATH`**: 插件运行的基础路径，用于定位 `image` 目录，如在 VCP中调用视频快照即保存在后端根目录下的image\bilibili\视频名称文件夹，手动运行本插件及保存在本插件的image\bilibili\视频名称文件夹 下。

## AI 调用参数

当 AI 调用此工具时，可以传入以下参数：

1.  **`url`** (必需)
    - **描述**: Bilibili 视频的 URL (支持长链接和 b23.tv 短链接)。
2.  **`lang`** (可选)
    - **描述**: 指定字幕语言代码 (如 `ai-zh`, `ai-en`)。默认为 `ai-zh`。
3.  **`danmaku_num`** (可选)
    - **描述**: 获取热门弹幕的数量，默认为 0。
4.  **`comment_num`** (可选)
    - **描述**: 获取热门评论的数量，默认为 0。
5.  **`snapshots`** (可选)
    - **描述**: 想要查看快照的时间点（秒），多个时间点用逗号分隔，例如 `10,60`。
6.  **`need_subs`** (可选)
    - **描述**: 是否需要获取字幕，默认为 `true`。如果只想获取快照，请设置为 `false`。

## AI 调用示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」BilibiliFetch「末」,
url:「始」https://b23.tv/b6PME73「末」,
danmaku_num:「始」10「末」,
comment_num:「始」5「末」,
snapshots:「始」15,45「末」,
need_subs:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
```

## 注意事项

- **并发抓取**：插件会并发执行多个任务以提高效率。
- **图像鉴权**：快照 URL 已集成 `pw=` 鉴权，确保前端渲染正常。
- **依赖项**：快照功能需要安装 `Pillow` 库 (`pip install Pillow`)。
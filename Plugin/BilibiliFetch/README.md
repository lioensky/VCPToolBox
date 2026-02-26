# Bilibili 内容获取插件 (VCP)

本插件是针对强大的 AI 工具箱项目 [VCPToolBox](https://github.com/lioensky/VCPToolBox) 中原有的 B 站字幕插件进行的加强版。

**核心定位**：直接替换原有的 B 站插件即可获得更丰富的功能，无需额外配置改动。

## 功能与相比原版的加强点
- **短链接解析**：支持 `https://b23.tv/xxxxxx` 格式的短链接自动解析。
- **多P分P支持**：URL 中的 `?p=N` 参数自动识别，通过 pagelist API 获取对应分P的 CID，字幕/弹幕/快照均为指定P的内容。
- **视频元数据**：获取视频的标题和作者信息。
- **字幕提取**：多源降级策略（CC字幕 > WBI Player API > AI Summary API），支持指定语言代码，未指定时按优先级自动选择：ai-zh > zh-CN > zh-Hans > 第一个可用语言。
- **热门弹幕与评论**：并发获取指定数量的热门弹幕和热门评论（评论按点赞排序）。
- **高能进度条**：自动获取视频中弹幕最集中的时间点及热度值，帮助 AI 快速定位精彩内容。
- **智能快照 (Videoshot)**：支持指定时间点截图，提供两种模式：
  - **HD 高清模式**：通过 ffmpeg 从视频流直接抽帧，画质与原视频一致。
  - **雪碧图模式**：从 B 站预生成的拼版图中裁切（HD 失败时自动降级）。
- **分类存储**：截图按视频标题自动建立子目录存放，方便管理。
- **HTML 渲染**：快照以 HTML `<img>` 标签形式返回，通过 VCP 图床服务器提供访问 URL，支持 Vchat 前端直接显示。
- **搜索功能**：支持关键词搜索视频或 UP 主（基于 WBI 签名认证）。
- **UP 主视频列表**：支持获取指定 UP 主的所有投稿视频（按发布时间倒序）。

## 安装与替换

1. 将本目录下的所有文件复制到你的 VCP 项目的 `Plugin` 目录下。
2. 确保安装了依赖项：`pip install requests Pillow`。
3. 在 `config.env` 中配置你的 `BILIBILI_COOKIE`。

- **`PROJECT_BASE_PATH`**: 插件运行的基础路径，自动定位 `image` 目录。如在 VCP 中调用，视频快照保存在后端根目录下的 `image\bilibili\视频名称` 文件夹；手动运行则保存在本插件的 `image\bilibili\视频名称` 文件夹下。

### ffmpeg 依赖（HD 高清截图功能）

HD 截图功能需要 ffmpeg 环境，插件按以下优先级自动查找：
1. **项目内置**：`VCPChat/bin/bin/ffmpeg.exe` 或 `VCPToolBox/bin/ffmpeg.exe`（相对路径自动定位，不依赖项目安装位置）
2. **系统 PATH**：宿主机全局安装的 ffmpeg
3. **Docker 容器内**：通过 `apk add ffmpeg` 安装

未找到 ffmpeg 时 HD 功能自动降级到雪碧图裁切，不影响其他功能。

## AI 调用工具说明

### 1.1 BilibiliFetch
**说明**: 调用此工具获取 Bilibili 视频信息（标题、作者）、字幕、热门弹幕、热门评论、高能进度条（弹幕集中的时间点）以及视频特定时间点的快照截图。支持长链接和 b23.tv 短链接。

**调用格式**:
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」BilibiliFetch「末」,
url:「始」(必需) Bilibili 视频的 URL (支持 b23.tv 短链接)。「末」,
lang:「始」(可选) 字幕语言代码, 例如 'ai-zh' 或 'ai-en'。如果未提供，将默认尝试获取中文字幕。「末」,
danmaku_num:「始」(可选) 获取热门弹幕的数量，默认为 0。「末」,
comment_num:「始」(可选) 获取热门评论的数量，默认为 0。「末」,
snapshots:「始」(获取字幕后使用) 想要查看快照的时间点（秒），多个时间点用逗号分隔，例如 '10,60,120'。「末」,
hd_snapshot:「始」(可选) 是否启用HD高清截图模式，默认为 false。设为 true 时通过 ffmpeg 从视频流直接抽帧，失败自动降级到雪碧图裁切。「末」,
need_subs:「始」(可选)是否获取字幕，默认为 true。如果您只想获取快照请设置为 false。「末」,
need_pbp:「始」(可选) 是否获取弹幕热度最高的几个时间点，方便后续获取快照，默认为 true。「末」
<<<[END_TOOL_REQUEST]>>>
```

**重要提示**：
1. 插件返回多模态结构化数据，包含文本和 HTML `<img>` 标签。
2. 请务必将返回结果中的 `<img>` 标签原样展示给用户以便渲染快照。

### 1.2 BilibiliSearch
**说明**: 关键词搜索 Bilibili 视频或 UP 主。支持分页获取结果。

**调用格式**:
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」BilibiliFetch「末」,
action:「始」search「末」,
keyword:「始」搜索关键词，如 Python「末」,
search_type:「始」'video' (搜索视频) 或 'bili_user' (搜索用户)。默认为 'video'「末」,
page:「始」(可选): 页码，默认为 1「末」
<<<[END_TOOL_REQUEST]>>>
```

### 1.3 GetUpVideos
**说明**: 获取指定 UP 主（通过 mid）的所有投稿视频 BV 号。常用于在搜索到用户后，进一步获取其视频列表。B 站短链接的固定格式为 `https://b23.tv/BV号`，长链接的固定格式为 `https://www.bilibili.com/video/BV号`。

**调用格式**:
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」BilibiliFetch「末」,
action:「始」get_up_videos「末」,
mid:「始」目标用户的 ID (mid)「末」,
pn:「始」页码，默认为 1「末」,
ps:「始」(可选): 每页项数，最大 50，默认为 30「末」
<<<[END_TOOL_REQUEST]>>>
```

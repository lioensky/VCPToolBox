# NeteaseMusic

NeteaseMusic 是一个同步 `stdio` 插件，基于 NeteaseCloudMusicApi 为 VCPToolBox 提供网易云音乐搜索、歌单、歌词、播放链接、个人记录、下载和可选的音频分析能力。

## 能力概览

- 公共查询：`search`、`playlist`、`playlist_all_songs`、`song_detail`、`song_info`、`share_song`、`cover`、`song_url`、`lyric`、`top_playlist`。
- 登录数据：`my_playlists`、`user_playlist`、`recent_songs`、`top_songs`、`daily_recommend`、`today_listens`、`login_status`。
- 账号写操作：`like_song`、`unlike_song`、`add_to_playlist`、`remove_from_playlist`。支持 `dryRun=true` 预检。
- 本地能力：`download` 下载音频；`analyze` 使用 VCPToolBox 主配置中的多模态模型分析音频。

所有调用都使用 `action`，歌曲可以用 `id`、`ids`、`songId`、歌曲 URL、分享短链或完整分享文案定位。

## 配置

复制 `config.env.example` 为 `config.env`。公共查询无需 Cookie；个人数据、推荐、写操作和高音质下载通常需要有效的 `NETEASE_COOKIE`。也可以将 Netscape Cookie 导出为插件目录下的 `music.163.com_cookies.txt`，该文件只保存在本机。

```env
NETEASE_COOKIE=
```

不要把 Cookie、下载音频、`node_modules` 或测试输出提交到 Git。音频分析还需要 VCPToolBox 根配置提供可用的多模态模型和 API 地址；下载压缩路径需要本机安装 `ffmpeg`。

## 调用示例

```text
<<<[TOOL_REQUEST]>>>
tool_name: NeteaseMusic
action: search
keywords: 夜に駆ける
limit: 5
<<<[END_TOOL_REQUEST]>>>
```

```text
<<<[TOOL_REQUEST]>>>
tool_name: NeteaseMusic
action: song_info
shareText: 分享歌曲《NEVER》: https://163cn.tv/example
<<<[END_TOOL_REQUEST]>>>
```

账号写操作建议先使用 `dryRun=true`，确认目标歌曲和歌单后再执行真实变更。请遵守网易云音乐及内容版权方的服务条款。

## 安装与测试

```powershell
npm install
'{"action":"login_status"}' | node index.js
```

需要登录态的测试请在本机 `config.env` 配置 Cookie；测试输出和下载文件不得进入 PR。

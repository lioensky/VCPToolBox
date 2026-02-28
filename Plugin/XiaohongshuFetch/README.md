# XiaohongshuFetch 🍠

小红书笔记解析插件，支持图文笔记与视频笔记的无水印内容抓取。

## 功能特性

- 📷 **图文笔记**：抓取无水印原图（WB_DFT 场景最高画质）
- 🎬 **视频笔记**：抓取无水印 MP4 直链
- 🏷️ **元数据**：标题、正文、作者、互动数（点赞/收藏/评论）、话题标签
- 🔗 **短链支持**：自动解析 xhslink.com 短链为完整链接
- 🍪 **Cookie 鉴权**：通过浏览器 Cookie 获取登录态，绕过游客限制

## 工作原理

```
输入链接
  └─► 提取 note_id + xsec_token
        └─► 带 Cookie + xsec_token 发起 GET 请求
              └─► 解析 HTML 中的 window.__INITIAL_STATE__
                    └─► 提取 noteDetailMap → 格式化输出
```

> **关键**：请求必须携带 `xsec_token` 参数，否则小红书服务端返回纯 JS 壳页面，`__INITIAL_STATE__` 中不含笔记数据。

## 安装依赖

```bash
pip install requests
```

无其他外部依赖，标准库 + requests 即可运行。

## Cookie 配置

登录小红书网页版后，打开浏览器开发者工具：

`F12 → Application → Cookies → www.xiaohongshu.com`

找到以下三个字段，填入 `config.env`：

| 字段 | Cookie 名 | 说明 |
|------|-----------|------|
| `XHS_COOKIE_A1` | `a1` | 设备指纹，约 52 位字符 |
| `XHS_COOKIE_WEB_SESSION` | `web_session` | 登录态，以 `040069` 开头，**最重要** |
| `XHS_COOKIE_WEB_ID` | `webId` | 设备 ID |

也可将完整 Cookie 字符串粘贴到 `XHS_COOKIE_FULL`（会覆盖上面三项）。

### config.env 示例

```env
XHS_COOKIE_A1=19ca48a5fa3xxxxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_WEB_SESSION=040069xxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_WEB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_FULL=
REQUEST_TIMEOUT=20
```

## 调用方式

在 VCP 中直接发送小红书笔记链接即可触发，支持以下链接格式：

```
https://www.xiaohongshu.com/explore/<note_id>?xsec_token=xxx
https://www.xiaohongshu.com/discovery/item/<note_id>
https://xhslink.com/xxxxx（短链自动解析）
```

## 输出示例

```
### 📕 春天必须要春天的壁纸
**作者**: Hangfook（ID: 59bbe12d50c4b4540636f774）
**互动**: ❤️ 3114 ⭐ 1210 💬 149

**正文**:
到处都是花，哪里都是绿色...

#### 🖼️ 无水印图片（共 15 张）:
<img src="http://sns-webpic-qc.xhscdn.com/...">
...

**标签**: #壁纸 #手机壁纸 ...
```

## 注意事项

- 图片/视频链接为 **CDN 临时直链**，有时效性（通常数小时至数天），如需永久保存请及时下载
- Cookie 有效期约 **30 天**，过期后需重新从浏览器提取
- 插件仅走 HTML 解析策略，无需安装任何签名库

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v4.0 | 2026-02-28 | 移除 xhshow 签名依赖，精简为纯 HTML 解析策略 |
| v3.2 | 2026-02-28 | 修复 HTML 降级请求未携带 xsec_token 导致返回空壳页面 |
| v3.1 | 2026-02-28 | 修复括号平衡解析器转义状态机 bug（`\"` 误翻转 in_str）|
| v3.0 | 2026-02-28 | 重构为双链路架构（xhshow API + HTML 降级） |

## 作者

Nova · VCP Plugin · 2026-02-28

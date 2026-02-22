# UrlFetch 插件使用说明

## 功能概述

UrlFetch 插件用于访问各种 URL 内容，支持以下模式：
- **text 模式**（默认）：返回解析后的网页文本内容或链接列表
- **snapshot 模式**：返回网页的完整长截图
- **image 模式**：直接下载网络图片并返回 Base64（URL 以图片扩展名结尾时自动启用）
- **file:// 本地文件**：读取本地文本文件（.txt/.md/.json 等）或图片，无需指定 mode

## 配置说明

### 1. 创建配置文件

复制 `config.env.example` 为 `config.env`：

```bash
cp config.env.example config.env
```

### 2. 配置项说明

#### FETCH_PROXY_PORT（可选）
代理端口配置，用于通过代理访问网站。

```env
FETCH_PROXY_PORT=7890
```

#### Cookies 配置（三选一）

##### 方式一：FETCH_COOKIES_RAW_MULTI（推荐，支持多网站）
JSON 对象格式，key 是域名关键词，value 是 cookie 字符串。会根据访问的 URL 自动匹配对应的 cookies。

**获取步骤**：
1. 在浏览器中打开第一个网站并登录（如 B站）
2. 按 F12 → Console，运行：`copy(document.cookie)`
3. 记录下来（或先粘贴到文本编辑器）
4. 重复步骤 1-3 获取其他网站的 cookies
5. 组合成 JSON 对象格式

**配置示例**：
```env
FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=abc123; bili_jct=xyz789","twitter.com":"auth_token=xxx; ct0=yyy","github.com":"user_session=zzz"}
```

✅ **优点**：
- 支持多个网站的 cookies
- 自动根据访问的 URL 匹配对应 cookies
- 一次配置，永久使用
- 不需要手动提取单个值

##### 方式二：FETCH_COOKIES_RAW（适合单网站）
直接粘贴从浏览器复制的原始 cookie 字符串。适合只访问一个网站的情况。

**获取方式**：
1. 在浏览器中打开目标网站并登录
2. 按 F12 打开开发者工具 → Console（控制台）
3. 运行：`copy(document.cookie)`
4. Cookie 字符串已复制到剪贴板

**配置示例**：
```env
FETCH_COOKIES_RAW=SESSDATA=abc123; bili_jct=xyz789; token=qwerty
```

⚠️ **注意**：访问任何网站都会使用这些 cookies

##### 方式三：FETCH_COOKIES（高级用户）
JSON 数组格式，支持最精细的参数控制。

**格式**：JSON 数组，每个元素是一个 cookie 对象。

**基础示例**：
```env
FETCH_COOKIES=[{"name":"session_id","value":"abc123","domain":".example.com"}]
```

**完整参数示例**：
```env
FETCH_COOKIES=[{"name":"token","value":"xxx","domain":".example.com","path":"/","expires":-1,"httpOnly":false,"secure":true,"sameSite":"Lax"}]
```

**多个 cookies 示例**：
```env
FETCH_COOKIES=[{"name":"session_id","value":"abc123","domain":".example.com"},{"name":"user_token","value":"xyz789","domain":".example.com","path":"/api"}]
```

⚠️ **优先级**：FETCH_COOKIES_RAW_MULTI > FETCH_COOKIES_RAW > FETCH_COOKIES

### Cookie 参数说明

| 参数 | 必需 | 说明 | 示例 |
|------|------|------|------|
| `name` | ✅ | Cookie 名称 | `"session_id"` |
| `value` | ✅ | Cookie 值 | `"abc123"` |
| `domain` | 推荐 | Cookie 所属域名（建议以 `.` 开头以匹配子域名） | `".example.com"` |
| `path` | ❌ | Cookie 生效路径 | `"/"` |
| `expires` | ❌ | 过期时间（Unix 时间戳，-1 表示会话 cookie） | `-1` |
| `httpOnly` | ❌ | 是否只能通过 HTTP 访问 | `false` |
| `secure` | ❌ | 是否仅在 HTTPS 下传输 | `true` |
| `sameSite` | ❌ | 同站策略（`Strict`, `Lax`, `None`） | `"Lax"` |

## 使用示例

### 1. 获取文本内容

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」https://www.example.com「末」
<<<[END_TOOL_REQUEST]>>>
```

### 2. 获取网页快照

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」https://www.example.com「末」,
mode:「始」snapshot「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3. 下载网络图片（自动检测）

当 URL 以图片扩展名结尾时，自动切换为 image 模式：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」https://example.com/photo.jpg「末」
<<<[END_TOOL_REQUEST]>>>
```

### 4. 读取本地文本文件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」file:///C:/Projects/notes/readme.md「末」
<<<[END_TOOL_REQUEST]>>>
```

### 5. 读取本地图片

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」file:///C:/Pictures/screenshot.png「末」
<<<[END_TOOL_REQUEST]>>>
```

### 6. 使用 Cookies 访问需要登录的网站

#### 多站点配置方式（推荐）

**步骤 1**：收集各网站的 cookies

对每个需要访问的网站：
1. 在浏览器中登录该网站
2. 按 F12 → Console，运行：`copy(document.cookie)`
3. 粘贴到文本编辑器，记下网站域名

**步骤 2**：组合成 JSON 对象

```env
FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=xxx; bili_jct=yyy","twitter.com":"auth_token=aaa; ct0=bbb"}
```

**步骤 3**：访问任意已配置的网站
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」https://www.bilibili.com/watchlater/「末」
<<<[END_TOOL_REQUEST]>>>
```

自动使用 B站的 cookies！访问 Twitter 时自动用 Twitter 的 cookies！

#### 单站点配置方式

**步骤 1**：一键复制所有 cookies
1. 在浏览器中登录目标网站
2. 按 F12 打开开发者工具
3. 切换到 Console（控制台）标签
4. 粘贴并运行：`copy(document.cookie)`

**步骤 2**：粘贴到 `config.env`
```env
FETCH_COOKIES_RAW=你粘贴的完整cookie字符串
```

**步骤 3**：正常调用插件（同上）

#### 手动方式（JSON 格式）

**步骤 1**：从浏览器获取 cookies
1. 在浏览器中登录目标网站
2. 打开开发者工具（F12）
3. 进入 Application/存储 > Cookies
4. 复制需要的 cookie 值

**步骤 2**：配置到 `config.env`
```env
FETCH_COOKIES=[{"name":"your_cookie_name","value":"your_cookie_value","domain":".target-site.com"}]
```

**步骤 3**：正常调用插件（同上）

## 常见问题

### Q: 如何获取网站的 cookies？

A: **最简单方式**（推荐）：
1. 在浏览器中打开并登录目标网站
2. 按 F12 打开开发者工具
3. 切换到 Console（控制台）
4. 运行：`copy(document.cookie)`
5. Cookies 已自动复制到剪贴板，粘贴到 `FETCH_COOKIES_RAW` 即可

**手动方式**：
1. 访问目标网站并登录
2. 按 F12 打开开发者工具
3. 切换到 "Application" 或 "存储" 标签
4. 在左侧找到 "Cookies" 并展开
5. 选择对应域名，查看和复制 cookie 信息

### Q: Cookies 设置后没有生效？

A: 检查以下几点：

**使用 FETCH_COOKIES_RAW 时**：
1. Cookie 字符串是否完整复制（没有多余空格或换行）
2. 格式是否为 `name1=value1; name2=value2` 的形式
3. 重新登录获取新的 cookies

**使用 FETCH_COOKIES 时**：
1. `domain` 是否正确（建议以 `.` 开头，如 `.example.com`）
2. JSON 格式是否正确（可以使用在线 JSON 校验工具）
3. Cookie 是否已过期（检查 `expires` 参数）
4. 是否需要设置 `secure` 为 `true`（HTTPS 网站）

### Q: 支持哪些网站？

A: 理论上支持所有公开访问的网站。但某些网站可能：
- 有反爬虫机制（已集成 Stealth 插件缓解）
- 需要 JavaScript 渲染（已支持，会等待页面加载完成）
- 需要特定的 cookies 或 headers（可通过配置 cookies 解决）

### Q: 代理配置有什么用？

A: 当直接访问某些网站失败时，会自动尝试通过配置的代理端口访问，适用于：
- 访问受地理位置限制的网站
- 绕过某些网络限制
- 需要使用特定 IP 访问的场景

## 技术细节

- 使用 Puppeteer 作为浏览器自动化引擎
- 集成了 `puppeteer-extra-plugin-stealth` 反检测插件
- 集成了 `puppeteer-extra-plugin-anonymize-ua` UA 匿名化插件
- 支持自动滚动加载懒加载内容
- 智能提取网页中的文本、链接、图片和视频信息
- 支持通过代理访问（失败重试机制）

## 更新日志

- **v0.1.0**: 初始版本，支持文本和快照模式
- **v0.1.1**: 新增 Cookies 配置支持
# DiscourseReader

让 AI Agent 高效阅读任意 [Discourse](https://www.discourse.org/) 论坛内容的 VCP 插件。

告别低效的浏览器截图→识别→点击循环，一次工具调用直接获取结构化数据。

## 功能特性

- **5 个命令**：浏览帖子、读取内容、搜索、板块列表、标签列表
- **多论坛支持**：为不同论坛配置独立的 API Key
- **Cloudflare 穿透**：Puppeteer + stealth 自动通过 CF 挑战
- **永久认证**：基于 Discourse User API Key（RSA 握手协议获取），无需反复更新 cookie
- **丰富输出**：Markdown 表格、HTML 转 Markdown、相对时间戳
- **分页浏览**：帖子列表分页、楼层分批加载、搜索结果翻页

## 依赖

- VCP 根目录 node_modules 中已安装 `puppeteer-extra` 和 `puppeteer-extra-plugin-stealth`
- Python 3.7+，`pycryptodomex`（仅用于生成 API Key）

## 快速开始

### 1. 获取 User API Key（推荐）

```bash
# 安装依赖（仅首次）
pip install pycryptodomex

# 生成 API Key（以 linux.do 为例）
python get_user_api_key.py https://linux.do
```

脚本会：
1. 生成 RSA 2048 位密钥对
2. 输出授权链接 — 在浏览器打开并点击 **授权**
3. 要求粘贴页面显示的加密密文
4. 解密输出永久有效的 User API Key

该脚本适用于所有 Discourse 论坛，只需替换 URL。

### 2. 配置

将 `config.env.example` 复制为 `config.env`，填入你的 API Key：

```env
DISCOURSE_BASE_URL=https://linux.do
forum_linuxdo_api_key=你的key

# 多论坛示例
# forum_metacommunity_api_key=另一个key
```

### 3. 使用

插件就绪，Agent 可直接调用 5 个命令。

## 命令说明

### ListTopics — 浏览帖子列表

| 参数 | 必需 | 说明 |
|------|:----:|------|
| command | ✅ | `ListTopics` |
| category | | 板块 slug（默认读取配置） |
| tag | | 标签 slug 筛选 |
| page | | 页码，从 0 开始 |
| order | | `latest` / `views` / `posts` |
| base_url | | 覆盖默认论坛地址 |

### ReadTopic — 读取帖子内容

| 参数 | 必需 | 说明 |
|------|:----:|------|
| command | ✅ | `ReadTopic` |
| topic_id | ✅* | 帖子 ID |
| url | ✅* | 帖子链接（与 topic_id 二选一） |
| max_posts | | 最多返回楼层数 |
| post_number | | 从第几楼开始读 |
| base_url | | 覆盖默认论坛地址 |

### SearchForum — 搜索帖子

| 参数 | 必需 | 说明 |
|------|:----:|------|
| command | ✅ | `SearchForum` |
| keyword | ✅ | 搜索关键词 |
| category | | 限定板块 |
| order | | `relevance` / `latest` / `likes` |
| page | | 页码 |
| base_url | | 覆盖默认论坛地址 |

### ListCategories — 板块列表

| 参数 | 必需 | 说明 |
|------|:----:|------|
| command | ✅ | `ListCategories` |
| base_url | | 覆盖默认论坛地址 |

### ListTags — 标签列表

| 参数 | 必需 | 说明 |
|------|:----:|------|
| command | ✅ | `ListTags` |
| base_url | | 覆盖默认论坛地址 |

## 架构

```
Agent
  ↓ 工具调用 (stdio/JSON)
DiscourseReader.js
  ↓ Puppeteer + stealth（穿透 Cloudflare）
  ↓ User-Api-Key header（Discourse 认证）
Discourse JSON API
  ↓ 结构化数据
DiscourseReader.js
  ↓ 格式化为 Markdown
Agent
```

### 为什么用 Puppeteer 而不是原生 HTTPS？

许多 Discourse 论坛（如 linux.do）启用了 Cloudflare JS 挑战。Node.js 原生 `https` 的 TLS 指纹会被识别为非浏览器而遭到拦截（403/503）。Puppeteer + stealth 使用真实 Chromium 引擎，TLS 指纹与正常浏览器一致。

### 为什么用 User API Key 而不是 Cookie？

| 方案 | 问题 |
|------|------|
| Cookie 直连 | CF 检测 TLS 指纹与 cookie 不匹配 → 拦截 |
| Cookie + Puppeteer | session 级 cookie 过期快，需反复更新 |
| **User API Key** | **永久有效，不依赖浏览器环境** |

## 认证优先级

同一论坛同时配了 API Key 和 Cookie 时：

```
1. User-Api-Key header  （永久，推荐）
2. Cookie 注入           （session 级，备选）
```

## 配置参考

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| DISCOURSE_BASE_URL | string | https://linux.do | 默认论坛地址 |
| DEFAULT_CATEGORY | string | develop | ListTopics 默认板块 |
| MAX_CONTENT_LENGTH | number | 3000 | 超过此长度的帖子内容截断 |
| MAX_POSTS | number | 10 | ReadTopic 默认最大楼层数 |
| forum_{name}_api_key | string | - | User API Key（按域名匹配） |
| forum_{name}_cookie | string | - | Cookie 字符串（备选认证） |

## 已知限制

- **Puppeteer 冷启动**：首次请求需 3-5 秒启动浏览器，后续复用
- **搜索频率限制**：Discourse 限制搜索次数（认证用户约 30 次/15 分钟）
- **Turnstile 验证码**：如果论坛使用 CF Turnstile（非 JS 挑战），可能无法通过
- **只读**：当前 API Key 权限为 `read`

## 文件清单

| 文件 | 说明 |
|------|------|
| DiscourseReader.js | 插件主程序 |
| plugin-manifest.json | VCP 插件清单 |
| config.env.example | 配置模板 |
| get_user_api_key.py | API Key 生成工具 |
| README.md | 本文件 |
| .gitignore | 排除密钥等敏感文件 |

## 许可

MIT
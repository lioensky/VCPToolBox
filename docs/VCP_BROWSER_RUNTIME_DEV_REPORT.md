# VCP 托管浏览器运行时开发评估报告

## 1. 摘要

本文评估将 VCP 的网页访问能力升级为“托管浏览器运行时”的方案。该方案的核心目标是：由 VCP 主进程按需启动一个受控 Chrome 实例，预装 [`VCPChrome`](../VCPChrome) 扩展，通过 [`ChromeBridge`](../Plugin/ChromeBridge) 接入现有浏览器控制协议，并让 [`UrlFetch`](../Plugin/UrlFetch) 等网页内容类插件复用该浏览器获得更可靠的 DOM、CDP、Cookie、LocalStorage、网络响应体与页面渲染能力。

该工程的判断是：技术难度中等偏低，核心实现并不复杂；但测试矩阵、兼容性验证、安全边界、运行时生命周期、用户真 Chrome 与 VCP 托管 Chrome 的优先级路由都需要大量工程验证。因此它属于“实现不难，但工程量与测试成本巨大”的基础设施升级。

推荐路线是分阶段落地：先实现 VCP 托管 Chrome 的按需启动、空闲关闭与 [`ChromeBridge`](../Plugin/ChromeBridge) 自动连接；再做连接池身份、权限分层与高权限 managed 沙盒；最后让 [`UrlFetch`](../Plugin/UrlFetch) 接入 managed Chrome 的 DOM/CDP 能力。

---

## 2. 背景

当前 VCP 已经存在两类浏览器相关能力。

第一类是 [`UrlFetch`](../Plugin/UrlFetch)，主要入口为 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js)。它负责网页正文提取、图片下载、网页截图、Jina Reader 转 Markdown、本地文件读取等。当前已经增强到支持 Puppeteer 持久化 Profile、高风险域名浏览器优先、URL 保护和中文长文本分段修复。

第二类是 [`ChromeBridge`](../Plugin/ChromeBridge)，主要入口为 [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js)。它是 hybridservice 插件，通过 [`VCPChrome`](../VCPChrome) 浏览器扩展连接 VCP WebSocket，使 AI 可以观察当前页面、打开 URL、点击、输入、滚动、执行脚本和调用 CDP 指令。

当前问题是：这两类能力仍然相对割裂。 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 自己启动 Puppeteer；[`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 依赖用户已经打开并连接了浏览器。VCP 缺少一个统一的“浏览器运行时”，也缺少对用户真 Chrome、VCP 托管 Chrome、分布式远端 Chrome 的明确身份与权限分层。

---

## 3. 目标

本工程目标如下。

1. 新增中央浏览器运行时模块，建议命名为 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js)。
2. 由 VCP 按需启动一个托管 Chrome，并加载 [`VCPChrome`](../VCPChrome) 扩展。
3. 托管 Chrome 使用独立 Profile，保存 Cookie、LocalStorage、IndexedDB、CacheStorage、Service Worker、扩展配置与站点状态。
4. [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 能在没有用户浏览器连接时自动拉起托管 Chrome。
5. 托管 Chrome 空闲一段时间后自动关闭，释放 Chromium 内存，但保留磁盘 Profile。
6. AI 可通过新增指令显式打开、查询状态、续租、关闭托管 Chrome。
7. [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 可选择通过托管 Chrome 获取 DOM、Markdown、CDP 网络响应体和页面状态。
8. 明确只有 VCP 创建的 managed Chrome 拥有更高权限的沙盒能力。
9. 用户自己的 Chrome 默认不授予高权限 CDP/Storage/Cookie 读取能力，除非显式授权。
10. 分布式远端 Chrome 默认作为受限能力处理。

---

## 4. 非目标

本阶段不建议一次性完成以下内容。

1. 不直接替换 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 的所有现有提取路径。
2. 不强制所有网页访问都走托管 Chrome。
3. 不默认接管用户私人 Chrome 的高权限数据。
4. 不默认让 AI 操作用户当前真实浏览器完成检索任务。
5. 不在首版实现完整浏览器集群或多实例池。
6. 不在首版实现所有站点的反爬自动处理。
7. 不承诺 headless + extension 在所有 Chrome 版本上稳定可用。
8. 不在首版开放远端分布式 Chrome 的高权限 CDP 能力。

---

## 5. 现状分析

### 5.1 UrlFetch 现状

[`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 当前主要包含以下能力。

- 通过 [`fetchWithDirectHttp()`](../Plugin/UrlFetch/UrlFetch.js:564) 快速直接读取普通网页。
- 通过 [`fetchWithPuppeteer()`](../Plugin/UrlFetch/UrlFetch.js:627) 使用 Puppeteer 打开真实页面。
- 通过 [`fetchWithJinaReader()`](../Plugin/UrlFetch/UrlFetch.js:461) 使用 Jina Reader 获取 Markdown。
- 通过 [`formatExtractedArticleContent()`](../Plugin/UrlFetch/UrlFetch.js:166) 和 [`normalizeExtractedText()`](../Plugin/UrlFetch/UrlFetch.js:105) 进行正文格式化。
- 通过 [`getPersistentProfilePath()`](../Plugin/UrlFetch/UrlFetch.js:318) 计算持久化 Profile 路径。
- 通过 [`shouldUseBrowserFirst()`](../Plugin/UrlFetch/UrlFetch.js:314) 对高风险域名走浏览器优先。
- 支持 `snapshot`、`image`、`download`、`jina`、`text` 等模式，定义见 [`plugin-manifest.json`](../Plugin/UrlFetch/plugin-manifest.json)。

当前缺点是：每个插件调用独立启动 Puppeteer，虽然 Profile 可持久化，但浏览器本身不是 VCP 公共资源，也不能直接复用 [`ChromeBridge`](../Plugin/ChromeBridge) 的 CDP 与扩展能力。

### 5.2 ChromeBridge 现状

[`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 当前主要包含以下能力。

- 使用 [`connectedChromes`](../Plugin/ChromeBridge/ChromeBridge.js:11) 保存浏览器扩展连接。
- 使用 [`handleNewClient()`](../Plugin/ChromeBridge/ChromeBridge.js:35) 记录新连接。
- 使用 [`handleClientMessage()`](../Plugin/ChromeBridge/ChromeBridge.js:53) 接收页面更新。
- 使用 [`processToolCall()`](../Plugin/ChromeBridge/ChromeBridge.js:214) 执行 AI 调用。
- 使用 [`executeSingleCommand()`](../Plugin/ChromeBridge/ChromeBridge.js:126) 向扩展发送命令并等待结果。
- 插件能力在 [`Plugin/ChromeBridge/plugin-manifest.json`](../Plugin/ChromeBridge/plugin-manifest.json) 中定义，包括 `open_url`、`click`、`type`、`scroll`、`query_html`、`execute_script`、CDP 系列和标签页管理指令。

当前缺点是：如果没有浏览器扩展连接，[`processToolCall()`](../Plugin/ChromeBridge/ChromeBridge.js:214) 会直接失败。连接对象也没有区分 user、managed、distributed，无法建立权限模型。

### 5.3 VCPChrome 扩展现状

[`VCPChrome`](../VCPChrome) 是 Manifest V3 扩展，入口定义在 [`manifest.json`](../VCPChrome/manifest.json)。它拥有 `storage`、`activeTab`、`scripting`、`debugger` 等权限。核心逻辑在 [`background.js`](../VCPChrome/background.js)。

[`background.js`](../VCPChrome/background.js) 当前默认连接地址为 [`defaultServerUrl`](../VCPChrome/background.js:11)，默认 key 为 [`defaultVcpKey`](../VCPChrome/background.js:12)。它可以处理 `open_url`、CDP、脚本执行、标签页管理和页面信息上报。

当前缺点是：扩展没有明确声明自身是用户浏览器还是 VCP 托管浏览器；也没有 `clientHello` 之类的握手元信息；托管 Chrome 启动时还没有自动预写扩展配置。

---

## 6. 推荐总体架构

推荐架构如下。

1. 新增中央模块 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js)，负责 VCP 托管 Chrome 生命周期。
2. [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 负责浏览器连接池、命令分发、权限判断和客户端优先级。
3. [`VCPChrome`](../VCPChrome) 扩展负责在浏览器内执行页面级、扩展级和 CDP 级能力。
4. [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 作为网页内容消费者，按配置选择 direct、Jina、Puppeteer profile 或 managed Chrome backend。
5. 主配置文件 [`config.env.example`](../config.env.example) 增加托管浏览器运行时配置。
6. 插件级配置 [`Plugin/UrlFetch/config.env.example`](../Plugin/UrlFetch/config.env.example) 保留独立 Puppeteer fallback 配置。

逻辑关系如下。

- AI 调用 [`ChromeBridge`](../Plugin/ChromeBridge)。
- [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 检查连接池。
- 若没有可用 managed 或 user 浏览器，则调用 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 启动托管 Chrome。
- 托管 Chrome 加载 [`VCPChrome`](../VCPChrome)，自动连接 WebSocket。
- [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 收到 `clientHello`，标记为 managed。
- AI 执行浏览器操作。
- AI 完成检索后调用 `close_chrome`，或等待 idle timeout 自动关闭。
- [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 可按 backend 调用 managed Chrome 获取页面内容。

---

## 7. 浏览器身份模型

必须明确三类浏览器身份。

### 7.1 user

`user` 表示用户自己打开的真实 Chrome。它可能包含用户私人登录态、日常浏览历史、企业后台、邮箱、银行、社交平台等敏感信息。

默认权限应保守。

允许：打开 URL、点击、输入、滚动、查看页面 Markdown、基础 HTML 查询。

限制：Cookie 读取、Storage 读取、网络响应体读取、敏感 CDP、任意脚本执行、本地地址访问、清理站点数据。

### 7.2 managed

`managed` 表示由 VCP 自己启动的托管 Chrome。它使用 VCP 独立 Profile，是 AI 沙盒浏览器。

默认可授予高权限。

允许：CDP 网络监听、响应体读取、DOM.getDocument、Runtime.evaluate、Storage.getCookies、LocalStorage/IndexedDB/CacheStorage 管理、自动打开关闭标签页、AI 主动关闭浏览器。

### 7.3 distributed

`distributed` 表示来自远端节点或分布式连接的浏览器。

默认受限。

允许：页面读取、截图、基础 DOM 查询。

限制：Cookie、Storage、响应体、敏感 CDP、内网访问、用户态脚本执行，除非节点被显式信任。

---

## 8. 权限分层原则

高权限能力只属于 managed Chrome。不能仅凭 `127.0.0.1` 判断权限，因为用户 Chrome 和托管 Chrome 都可能来自本机地址；Docker、WSL、隧道和分布式代理也可能改变 remote address。

推荐判断顺序如下。

1. 扩展主动声明 `clientKind`。
2. [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 记录连接来源 IP 作为辅助信号。
3. [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 维护托管 Chrome 的启动会话 token。
4. 托管扩展通过 storage 或启动注入携带 managed token。
5. 权限判断以 `clientKind=managed` 且 token 匹配为高权限依据。
6. `remoteAddress=127.0.0.1` 只能作为本机连接辅助判断，不可作为高权限依据。

建议新增统一授权函数 [`authorizeChromeCommand()`](../Plugin/ChromeBridge/ChromeBridge.js)，用于判断每条指令能否在目标浏览器上执行。

---

## 9. ChromeBridge 改造需求

### 9.1 连接池结构升级

当前 [`connectedChromes`](../Plugin/ChromeBridge/ChromeBridge.js:11) 是 `Map`，值直接是 WebSocket。建议升级为连接对象。

连接对象建议字段如下。

| 字段 | 说明 |
|---|---|
| `clientId` | WebSocket 客户端 ID |
| `ws` | WebSocket 对象 |
| `clientKind` | `user`、`managed`、`distributed` |
| `remoteAddress` | 连接来源地址 |
| `connectedAt` | 连接时间 |
| `lastSeenAt` | 最近心跳或消息时间 |
| `capabilities` | 扩展声明能力 |
| `permissionLevel` | 权限等级 |
| `managedTokenValid` | 托管 token 是否有效 |
| `activeTabInfo` | 最近活动标签信息 |

### 9.2 新增 clientHello

[`VCPChrome/background.js`](../VCPChrome/background.js) 在 WebSocket 打开后应发送 `clientHello`，用于声明浏览器身份与能力。

建议字段如下。

| 字段 | 示例 | 说明 |
|---|---|---|
| `clientKind` | `managed` | 浏览器身份 |
| `extensionVersion` | `1.0.0` | 扩展版本 |
| `capabilities` | `pageInfo,tabs,cdp,storage,networkBody` | 能力集合 |
| `managedRuntime` | `true` | 是否托管运行时 |
| `managedToken` | 随机 token | 仅 managed 使用 |
| `userAgent` | 浏览器 UA | 辅助诊断 |
| `platform` | 平台 | 辅助诊断 |

### 9.3 新增生命周期指令

[`Plugin/ChromeBridge/plugin-manifest.json`](../Plugin/ChromeBridge/plugin-manifest.json) 应新增以下命令。

| 命令 | 说明 |
|---|---|
| `open_chrome` | 确保 VCP 托管 Chrome 已启动并连接 |
| `close_chrome` | 关闭 VCP 托管 Chrome，不能关闭用户 Chrome |
| `browser_status` | 返回连接池、托管进程、Profile、idle timer 状态 |
| `keep_chrome_alive` | 延长托管 Chrome 生命周期 |
| `close_managed_tabs` | 可选，关闭托管 Chrome 中 AI 打开的标签页 |

### 9.4 客户端选择策略

建议新增 [`selectChromeClient()`](../Plugin/ChromeBridge/ChromeBridge.js)，替代当前直接选择第一个连接的逻辑。

默认策略建议如下。

- 明确指定 `browserTarget=managed` 时，只选 managed。
- 明确指定 `browserTarget=user` 时，只选 user，且遵循用户授权。
- 未指定时，普通 AI 检索优先 managed。
- 用户明确要求操作当前浏览器时，优先 user。
- 分布式浏览器默认最后选择。
- 如果没有可用 managed，且命令允许自动创建，则调用 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js)。

---

## 10. BrowserRuntimeManager 设计

建议新增 [`modules/browserRuntimeManager.js`](../modules/browserRuntimeManager.js)。该模块只负责托管 Chrome 生命周期，不负责具体页面操作。

### 10.1 核心职责

1. 探测 Chrome 可执行文件。
2. 启动托管 Chrome。
3. 加载 [`VCPChrome`](../VCPChrome) 扩展。
4. 写入或注入扩展配置。
5. 管理独立 Profile。
6. 维护启动状态、PID、调试端口、Profile 路径。
7. 维护 idle timer。
8. 响应关闭与重启。
9. VCP 退出时清理子进程。
10. 向 [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 提供托管 token。

### 10.2 建议接口

建议提供以下接口。

| 接口 | 说明 |
|---|---|
| [`ensureManagedBrowser()`](../modules/browserRuntimeManager.js) | 启动或确认托管浏览器存在 |
| [`closeManagedBrowser()`](../modules/browserRuntimeManager.js) | 关闭托管浏览器 |
| [`touchManagedBrowser()`](../modules/browserRuntimeManager.js) | 刷新 idle timer |
| [`getManagedBrowserStatus()`](../modules/browserRuntimeManager.js) | 返回运行状态 |
| [`restartManagedBrowser()`](../modules/browserRuntimeManager.js) | 重启托管浏览器 |
| [`getManagedToken()`](../modules/browserRuntimeManager.js) | 返回托管会话 token |

### 10.3 启动参数

建议使用 Chrome 参数加载扩展和 Profile。

| 参数 | 说明 |
|---|---|
| `--user-data-dir` | 指向托管 Profile |
| `--disable-extensions-except` | 只启用 [`VCPChrome`](../VCPChrome) |
| `--load-extension` | 加载 [`VCPChrome`](../VCPChrome) |
| `--remote-debugging-port` | 可选调试端口 |
| `--no-first-run` | 跳过首次运行 |
| `--no-default-browser-check` | 跳过默认浏览器检查 |
| `--window-size` | 控制窗口尺寸 |
| `--start-minimized` | 可选最小化启动 |

注意：Manifest V3 扩展在 headless 下兼容性需要专项验证。首版建议默认有头但最小化，而非纯 headless。

---

## 11. UrlFetch 联动设计

[`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 可以新增 backend 配置，让网页内容提取能力逐步接入托管 Chrome。

建议配置如下。

| 配置 | 说明 |
|---|---|
| `URLFETCH_BROWSER_BACKEND=auto` | 自动选择 backend |
| `URLFETCH_USE_MANAGED_CHROME=false` | 是否启用 managed Chrome |
| `URLFETCH_MANAGED_CHROME_CDP=true` | 是否使用 CDP 获取网络响应和 DOM |
| `URLFETCH_MANAGED_CHROME_AUTO_CLOSE=true` | 是否由 UrlFetch 自动拉起后自动关闭 |
| `URLFETCH_MANAGED_CHROME_CLOSE_TAB=true` | 任务后关闭本次标签页 |
| `URLFETCH_MANAGED_CHROME_HIGH_RISK_ONLY=true` | 仅高风险域名走 managed |

推荐 backend 顺序如下。

1. managed Chrome + CDP。
2. managed Chrome + DOM/Markdown。
3. Puppeteer persistent profile。
4. direct HTTP。
5. Jina Reader。

对普通静态页面，仍可使用 [`fetchWithDirectHttp()`](../Plugin/UrlFetch/UrlFetch.js:564)。对强动态页面、需要登录态页面、SPA 页面、反爬敏感页面，优先 managed Chrome。

---

## 12. CDP 级内容获取价值

通过 managed Chrome 和 [`ChromeBridge`](../Plugin/ChromeBridge)，[`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 可以获得比当前 Puppeteer 提取更强的能力。

### 12.1 渲染后 DOM

通过 [`cdp_dom_get_document`](../Plugin/ChromeBridge/plugin-manifest.json:89)、[`cdp_runtime_evaluate`](../Plugin/ChromeBridge/plugin-manifest.json:84) 或 [`execute_script`](../Plugin/ChromeBridge/plugin-manifest.json:54)，可以读取完整渲染后内容，包括 SPA 路由结果、异步加载正文、Shadow DOM 和 iframe 内容。

### 12.2 网络响应体

通过 [`cdp_network_query`](../Plugin/ChromeBridge/plugin-manifest.json:69) 和 [`cdp_get_response_body`](../Plugin/ChromeBridge/plugin-manifest.json:74)，可以获取文章接口、JSON API、分页响应、评论接口等。对正文不在 HTML 中的网站很关键。

### 12.3 登录态和站点状态

managed Chrome 保留独立 Profile，能沉淀 Cookie、LocalStorage、IndexedDB 和 Service Worker 状态。相比单纯的 Cookie 注入更真实、更稳定。

### 12.4 自动关闭和资源回收

当 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 自动拉起 managed Chrome 完成抓取后，可以主动调用 `close_chrome`，实现用完即关。Profile 保留，内存释放。

---

## 13. 主配置建议

建议在 [`config.env.example`](../config.env.example) 中新增以下配置。

| 配置 | 默认值 | 说明 |
|---|---|---|
| `VCP_BROWSER_RUNTIME_ENABLED` | `false` | 是否启用托管浏览器运行时 |
| `VCP_BROWSER_IDLE_TIMEOUT_MS` | `300000` | 空闲自动关闭时间 |
| `VCP_BROWSER_PROFILE_DIR` | `Plugin/ChromeBridge/managed-profile` | 托管 Profile |
| `VCP_BROWSER_LOAD_VCPCHROME` | `true` | 是否加载扩展 |
| `VCP_BROWSER_HEADLESS` | `false` | 是否无头 |
| `VCP_BROWSER_EXECUTABLE_PATH` | 空 | Chrome 路径 |
| `VCP_BROWSER_REMOTE_DEBUGGING_PORT` | `0` | 调试端口，0 表示自动 |
| `VCP_BROWSER_CLIENT_PRIORITY` | `managed,user,distributed` | 默认优先级 |
| `VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE` | `false` | 是否允许用户 Chrome 高权限 |
| `VCP_BROWSER_MANAGED_TOKEN_TTL_MS` | `3600000` | 托管 token 生命周期 |
| `VCP_BROWSER_AUTO_CLOSE_AFTER_URLFETCH` | `true` | UrlFetch 自动拉起后是否关闭 |

---

## 14. 安全评估

### 14.1 主要风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 用户 Chrome 数据泄露 | AI 读取用户私人 Cookie 或网页数据 | 高权限仅 managed，user 默认受限 |
| SSRF | AI 让浏览器访问内网或本地服务 | URL 策略、审批、黑白名单 |
| Cookie 泄露 | CDP Storage.getCookies 读取敏感 Cookie | 仅 managed 默认允许 |
| 响应体泄露 | CDP 读取用户网页 API 响应 | user 禁止或审批 |
| 任意脚本执行 | 对用户页面执行危险脚本 | user 下限制 [`execute_script`](../Plugin/ChromeBridge/plugin-manifest.json:54) |
| 托管 Profile 污染 | Agent 访问危险网站污染 Profile | 支持重置 Profile |
| 分布式节点滥用 | 远端 Chrome 声明虚假能力 | token、节点信任策略 |
| 资源泄露 | 浏览器未关闭长期占内存 | idle timer、主动 close、进程监控 |

### 14.2 必须遵守的安全原则

1. `close_chrome` 不能关闭用户 Chrome。
2. `cdp_storage_get_cookies` 默认只能对 managed 执行。
3. `cdp_get_response_body` 默认只能对 managed 执行。
4. [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 默认不能使用用户 Chrome，除非显式配置。
5. 仅凭本机 IP 不能授予高权限。
6. 托管 Chrome 必须使用独立 Profile。
7. 管理接口必须只绑定本地或受 VCP Key 保护。
8. AdminPanel 应显示当前操作目标是 user、managed 还是 distributed。

---

## 15. 工程难度评估

### 15.1 实现难度

核心实现难度不大。主要原因如下。

- VCP 已有 [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 作为命令桥。
- [`VCPChrome/background.js`](../VCPChrome/background.js) 已支持大量浏览器操作与 CDP 能力。
- Node 启动 Chrome 加载扩展属于成熟工程模式。
- [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 已具备多 backend fallback 思路。
- hybridservice 插件机制已存在。

### 15.2 工程量来源

真正的大工程量来自以下方面。

1. Chrome 路径探测和跨平台启动。
2. Manifest V3 扩展在托管 Chrome 下的自动配置。
3. headless、有头、最小化三种模式兼容。
4. Windows、Docker、Linux、macOS 差异。
5. 连接池元信息协议设计。
6. 连接断开、重连、心跳、进程异常退出处理。
7. idle timer 与任务 lease 的正确性。
8. user、managed、distributed 权限边界。
9. [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 多 backend fallback 行为。
10. CDP 网络响应体提取对不同站点的兼容性。
11. AdminPanel 状态显示和诊断。
12. 安全审批与访问策略。
13. 大量真实网站测试。

### 15.3 复杂度结论

该工程是基础设施型工程。代码实现并不艰深，但质量取决于测试覆盖、异常处理、诊断信息和安全边界。不能以“功能能跑”为完成标准，必须以“长期运行可控、失败可诊断、权限不越界”为完成标准。

---

## 16. 测试矩阵

### 16.1 启动测试

| 场景 | 预期 |
|---|---|
| 未安装 Chrome | 返回明确错误 |
| 自动探测 Chrome 成功 | 可启动 managed Chrome |
| 指定 Chrome 路径 | 使用指定路径 |
| Profile 目录不存在 | 自动创建 |
| Profile 目录无权限 | 返回可诊断错误 |
| [`VCPChrome`](../VCPChrome) 路径不存在 | 返回可诊断错误 |
| 重复调用 `open_chrome` | 不重复启动 |
| 浏览器异常退出 | 状态变为 stopped |

### 16.2 连接测试

| 场景 | 预期 |
|---|---|
| managed 扩展连接 | 标记 `clientKind=managed` |
| 用户扩展连接 | 标记 `clientKind=user` |
| 分布式连接 | 标记 `clientKind=distributed` |
| clientHello 缺失 | 降级为 user 或 unknown |
| managed token 错误 | 不授予高权限 |
| WebSocket 断开 | 连接池清理 |
| 心跳超时 | 标记 stale |

### 16.3 权限测试

| 指令 | user | managed | distributed |
|---|---|---|---|
| `open_url` | 允许 | 允许 | 可选允许 |
| `click` | 允许 | 允许 | 可选允许 |
| `execute_script` | 审批或拒绝 | 允许 | 默认拒绝 |
| `cdp_storage_get_cookies` | 默认拒绝 | 允许 | 默认拒绝 |
| `cdp_get_response_body` | 默认拒绝 | 允许 | 默认拒绝 |
| `close_chrome` | 不关闭 | 允许关闭 managed | 不关闭 |
| `browser_status` | 允许 | 允许 | 允许 |

### 16.4 UrlFetch 测试

| 页面类型 | 预期 backend |
|---|---|
| 静态 HTML | direct HTTP |
| 微信公众号 | managed Chrome 或 Puppeteer profile |
| GitHub | direct 或 browser |
| SPA 页面 | managed Chrome + DOM |
| API 驱动页面 | managed Chrome + CDP network |
| 图片 URL | image 模式 |
| 长页面截图 | managed 或 Puppeteer 截图 |
| 403 页面 | 返回 blocked 类型诊断 |
| 登录墙 | 返回 login_required 类型诊断 |

### 16.5 资源回收测试

| 场景 | 预期 |
|---|---|
| idle 5 分钟 | 自动关闭 managed Chrome |
| AI 调用 `close_chrome` | 立即关闭 managed Chrome |
| user Chrome 存在 | 不关闭 user Chrome |
| UrlFetch 自动拉起 | 任务完成后按配置关闭 |
| 多任务并发 | 不误关正在使用的浏览器 |
| 子进程残留 | VCP 退出时清理 |

---

## 17. 分阶段落地计划

### 阶段一：托管 Chrome 最小闭环

目标：VCP 能按需启动 managed Chrome，并让 [`VCPChrome`](../VCPChrome) 自动连接 [`ChromeBridge`](../Plugin/ChromeBridge)。

任务：

1. 新增 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js)。
2. 实现 Chrome 路径探测。
3. 实现 Profile 目录创建。
4. 实现加载 [`VCPChrome`](../VCPChrome) 扩展。
5. 实现 idle timeout。
6. [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 增加 `open_chrome`、`close_chrome`、`browser_status`。
7. [`Plugin/ChromeBridge/plugin-manifest.json`](../Plugin/ChromeBridge/plugin-manifest.json) 更新指令说明。

验收：无用户浏览器时，AI 调用 `open_chrome` 后能够获得一个 connected managed Chrome。

### 阶段二：连接身份与权限

目标：区分 user、managed、distributed，并建立权限边界。

任务：

1. [`VCPChrome/background.js`](../VCPChrome/background.js) 增加 `clientHello`。
2. [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 升级 [`connectedChromes`](../Plugin/ChromeBridge/ChromeBridge.js:11) 结构。
3. 新增 [`selectChromeClient()`](../Plugin/ChromeBridge/ChromeBridge.js)。
4. 新增 [`authorizeChromeCommand()`](../Plugin/ChromeBridge/ChromeBridge.js)。
5. 高权限 CDP 默认只允许 managed。
6. `close_chrome` 只允许关闭 managed。

验收：同一 VCP 同时连接用户 Chrome 和 managed Chrome 时，能稳定选择目标并执行权限判断。

### 阶段二补充：基于 maid/valet 的 Agent 独立 Profile

目标：利用 VCP 工具调用中的 `maid` / `valet` 署名字段，为不同 Agent 自动维护独立的浏览器 Profile 数据，使每个 Agent 都可以拥有自己的持久化网页登录态、站点状态和浏览器人格。

该能力建议放入二期工程，而不是首版最小闭环。原因是它不改变托管 Chrome 的基础启动能力，但会显著增加 Profile 路由、权限隔离、测试矩阵和用户预期管理的复杂度。

#### 设计动机

VCP 的工具调用链路中存在调用者署名字段，即 `maid` / `valet`。该字段可以被视为 Agent 身份来源。若浏览器运行时能够读取该身份，就可以在 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 中为不同 Agent 分配不同 Profile，例如：

| Agent 身份 | Profile 路径示例 | 用途 |
|---|---|---|
| `maid=Nova` | `managed-profiles/agents/Nova` | Nova 的网页登录态与站点状态 |
| `valet=Metis` | `managed-profiles/agents/Metis` | Metis 的研究账号与检索状态 |
| 未署名 | `managed-profiles/default` | 默认托管浏览器身份 |

这样可以实现“每个 Agent 拥有自己的网页身份”。例如 Nova 登录某个知识站点后，该登录态不会泄漏给 Metis；Metis 在某个搜索引擎或开发者平台上的偏好也不会污染其它 Agent。

#### 推荐 Profile 路由规则

建议新增 Profile scope 概念：

| Scope | 说明 |
|---|---|
| `global` | 所有 Agent 共用一个 managed Profile |
| `agent` | 按 `maid` / `valet` 字段隔离 Profile |
| `agent-domain` | 按 Agent + 域名隔离 Profile |
| `task-ephemeral` | 临时任务 Profile，任务结束后可删除 |

推荐默认策略：

1. 首版仍使用 `global`，降低复杂度。
2. 二期引入 `agent`，用于长期 Agent 登录态。
3. 高风险站点可使用 `agent-domain`，减少不同站点状态互相影响。
4. 敏感临时任务使用 `task-ephemeral`，避免污染长期 Profile。

#### 调用链路要求

要实现该能力，需要在插件调用链路中把 `maid` / `valet` 传递给浏览器运行时。建议由 [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 和 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 在调用 [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 时传入调用上下文：

| 字段 | 说明 |
|---|---|
| `maid` | 女仆/Agent 署名 |
| `valet` | 管家/Agent 署名 |
| `agentId` | 归一化后的 Agent 身份 |
| `profileScope` | `global` / `agent` / `agent-domain` / `task-ephemeral` |
| `browserTarget` | `managed` / `user` / `distributed` |
| `taskId` | 可选任务 ID，用于临时 Profile |

[`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 应提供类似 [`resolveProfilePath()`](../modules/browserRuntimeManager.js) 的内部能力，将调用上下文映射到实际 Profile 目录。

#### 安全边界

Agent 独立 Profile 能提升长期使用体验，但也引入新的安全问题。

必须遵守以下原则：

1. Agent Profile 只能用于 managed Chrome，不能自动绑定用户 Chrome。
2. `maid` / `valet` 必须进行文件名安全归一化，防止路径穿越。
3. 不同 Agent Profile 默认互相隔离，不能读取彼此 Cookie 和 Storage。
4. AdminPanel 应显示和管理各 Agent Profile 的磁盘占用、最近使用时间和清理入口。
5. 高权限 CDP 能力仍然只授予 managed Chrome；Agent Profile 不等于用户授权。
6. 若 Agent 名称缺失或不可信，必须回退到 `default` 或临时 Profile。
7. 导出 Cookie、读取 Storage、读取响应体等能力需要继续经过 [`authorizeChromeCommand()`](../Plugin/ChromeBridge/ChromeBridge.js) 权限判断。

#### 配置建议

二期可增加以下配置：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `VCP_BROWSER_PROFILE_SCOPE` | `global` | Profile 隔离策略 |
| `VCP_BROWSER_AGENT_PROFILE_ENABLED` | `false` | 是否启用 Agent 独立 Profile |
| `VCP_BROWSER_AGENT_PROFILE_FIELD_PRIORITY` | `maid,valet` | Agent 身份字段优先级 |
| `VCP_BROWSER_AGENT_PROFILE_DIR` | `Plugin/ChromeBridge/managed-profiles/agents` | Agent Profile 根目录 |
| `VCP_BROWSER_AGENT_PROFILE_MAX_COUNT` | `50` | 最大 Agent Profile 数 |
| `VCP_BROWSER_AGENT_PROFILE_MAX_AGE_DAYS` | `90` | 长期未使用 Profile 清理阈值 |
| `VCP_BROWSER_AGENT_PROFILE_ALLOWLIST` | 空 | 允许启用独立 Profile 的 Agent 列表 |
| `VCP_BROWSER_AGENT_PROFILE_BLOCKLIST` | 空 | 禁止启用独立 Profile 的 Agent 列表 |

#### 测试重点

二期需要补充以下测试：

| 场景 | 预期 |
|---|---|
| `maid=Nova` 登录站点 | 登录态保存到 Nova Profile |
| `maid=Metis` 访问同站点 | 不继承 Nova 登录态 |
| 未提供 `maid` / `valet` | 使用 default Profile |
| Agent 名称含非法路径字符 | 被安全归一化 |
| `agent-domain` 模式访问两个域名 | 生成两个隔离 Profile |
| `close_chrome` | 只关闭当前 managed Chrome，不删除 Profile |
| 清理 Nova Profile | 只删除 Nova 数据，不影响其它 Agent |
| [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 自动调用 managed backend | 能正确使用调用 Agent 的 Profile |

#### 阶段二验收补充

二期完成后，应达到以下验收标准：

- [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 能从工具调用上下文识别 `maid` / `valet`。
- [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 能按 Agent 身份选择 Profile。
- 同一站点在不同 Agent 下登录态隔离。
- AdminPanel 能查看和清理 Agent Profile。
- 默认配置仍保持全局 Profile，不影响首版用户。

### 阶段三：UrlFetch 接入 managed backend

目标：让 [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 可复用 managed Chrome 的 DOM/CDP 能力。

任务：

1. 增加 `URLFETCH_USE_MANAGED_CHROME` 等配置。
2. 新增 managed Chrome backend。
3. 高风险域名优先 managed。
4. 支持 managed DOM 提取。
5. 支持 managed CDP 网络响应体提取。
6. 保留 Puppeteer/direct/Jina fallback。
7. 支持任务后关闭 tab 或关闭 managed Chrome。

验收：微信公众号、SPA、API 驱动网页在 managed backend 下能获得更完整正文。

### 阶段四：可观测与 AdminPanel

目标：提升诊断和运维能力。

任务：

1. AdminPanel 显示托管浏览器状态。
2. 显示连接池：user、managed、distributed。
3. 显示 Profile 路径、PID、idle 倒计时。
4. 提供重启 managed Chrome。
5. 提供清理 managed Profile。
6. 提供下载诊断日志。
7. 提供权限策略配置界面。

验收：用户能从管理面板判断浏览器运行时是否健康。

---

## 18. 工作量估算

粗略估算如下。

| 模块 | 代码量 | 难度 | 测试成本 |
|---|---:|---|---|
| [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) | 中 | 中 | 高 |
| [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 连接池升级 | 中 | 中 | 高 |
| [`VCPChrome/background.js`](../VCPChrome/background.js) clientHello 与 managed 配置 | 小到中 | 中 | 高 |
| [`Plugin/ChromeBridge/plugin-manifest.json`](../Plugin/ChromeBridge/plugin-manifest.json) 指令更新 | 小 | 低 | 低 |
| Agent 独立 Profile 路由与清理 | 中 | 中 | 高 |
| [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) managed backend | 中到大 | 中 | 高 |
| 配置与文档 | 中 | 低 | 中 |
| AdminPanel | 中 | 中 | 中 |
| 安全策略 | 中 | 中 | 高 |

首个可测版本预计 2 到 4 个开发日。稳定版本预计 1 到 2 周。生产可用版本取决于真实网站测试，可能需要更长周期。

---

## 19. 风险与缓解

### 19.1 Manifest V3 与 headless 兼容

风险：托管 Chrome 如果使用 headless，扩展加载和 service worker 生命周期可能不稳定。

缓解：首版默认有头最小化。后续再验证新版 headless。

### 19.2 用户 Chrome 权限误判

风险：错误把用户 Chrome 当 managed，导致高权限数据暴露。

缓解：managed 必须通过 token 验证。IP 只做辅助。

### 19.3 资源泄漏

风险：Chrome 子进程未退出，长期占内存。

缓解：idle timer、VCP shutdown 清理、PID 监控、异常退出监听。

### 19.4 UrlFetch 行为不稳定

风险：引入 managed backend 后，正文提取结果和现有路径不一致。

缓解：backend 可配置，保留 fallback，逐站点灰度。

### 19.5 安全策略复杂

风险：规则过多导致用户困惑或误拦截。

缓解：默认安全，提供高级配置；AdminPanel 显示当前目标与原因。

---

## 20. 推荐决策

建议推进该工程，但必须分阶段，不建议一次性大爆改。

推荐优先级如下。

1. 先做 [`ChromeBridge`](../Plugin/ChromeBridge) 自动拉起 managed Chrome。
2. 再做 clientKind 与权限边界。
3. 二期引入基于 `maid` / `valet` 的 Agent 独立 Profile，使长期网页登录态按 Agent 隔离。
4. 再让 [`UrlFetch`](../Plugin/UrlFetch) 试验接入 managed Chrome。
5. 最后做 AdminPanel 可视化和策略配置。

首版的成功标准不是覆盖全部网页，而是完成基础闭环：

- VCP 能创建自己的 Chrome。
- 扩展能自动连接。
- AI 能打开网页。
- AI 能完成任务后关闭 Chrome。
- Cookie/Profile 能保留。
- 用户 Chrome 和 managed Chrome 不混淆。
- 高权限只给 managed。

---

## 21. 结论

VCP 托管浏览器运行时是非常有价值的基础设施升级。它能把 [`UrlFetch`](../Plugin/UrlFetch)、[`ChromeBridge`](../Plugin/ChromeBridge)、[`VCPChrome`](../VCPChrome) 三条能力线统一起来，使 AI 获得一个按需启动、可持久身份、可高权限 CDP、可主动释放资源的沙盒级浏览器。

该工程代码实现难度不大，但测试和工程治理成本很高。真正的难点不是启动 Chrome，而是长期稳定地管理浏览器生命周期、连接身份、权限边界、失败诊断、多 backend fallback 和真实网站兼容性。

最终推荐形态是：

- [`browserRuntimeManager.js`](../modules/browserRuntimeManager.js) 管生命周期。
- [`ChromeBridge.js`](../Plugin/ChromeBridge/ChromeBridge.js) 管连接池、权限与指令。
- [`VCPChrome`](../VCPChrome) 管浏览器内能力。
- [`UrlFetch.js`](../Plugin/UrlFetch/UrlFetch.js) 消费 managed Chrome 的 DOM/CDP/网络能力。
- managed Chrome 是高权限 AI 沙盒。
- user Chrome 是用户私人浏览器，默认低权限。
- distributed Chrome 默认受限。

这将让 VCP 具备更可靠、更安全、更可控的网页智能基础能力。
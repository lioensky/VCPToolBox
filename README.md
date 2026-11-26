# VCP (Variable & Command Protocol)

![VCP Logo](docs/image/VCPLogo.png)

**VCP 官网：[VCPToolBox.com](https://www.vcptoolbox.com)**

VCP 由四个核心仓库协同演进，每日持续迭代。官网汇总了各仓库的[更新日志](https://www.vcptoolbox.com/?page=changelog)，也提供了查阅整个 VCP 项目[技术文档](https://www.vcptoolbox.com/?page=learn-vcp)的统一入口。

[English](README_en.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---

> ⚠️ **部署前请务必阅读**：VCP Agent 拥有分布式系统的底层级权限。**请勿使用任何非官方或反向代理的 API（“镜像站”“中转 API”）**。在底层监控权限下，不可信的 API 可能导致交互数据、记忆库内容、密钥、浏览器状态等敏感信息泄露。非专业用户请谨慎部署。

---

## 一句话定义

**VCP 2.0 是一套多维一体的工业级 Agent 运行时与全生态协同中枢，也是一片基于黎曼双曲几何的终极 AI 背景信息场。**

它向上统一从 VCP 原生 AI-Native 应用群到第三方 Harness、IDE 侧栏与各类 WebUI 的全部生态链；向下以双曲语义几何、多时间尺度时间线与原生 Rust 工程内核，为任何大语言模型赋予**直觉、逻辑与主观能动**。

---

## 写在前面：做框架的人很多，做世界的人很少

过去两年，市面上出现了无数 Agent 框架与工具壳子。它们形态各异，但骨子里大多在做同一件事：把 AI 当成一个**被调用的临时工**——你问一句，它醒来；它答完，它失忆。它的“记忆”是一次孤立的向量检索，它的“行动”是被 `while` 循环反复戳醒，它的“生态”是彼此割裂的聊天窗口、IDE 插件、WebUI 和脚本。

换一个客户端，工具协议就断了；换一个窗口，记忆就碎了；换一个模型，上下文和审计记录就丢了。

VCP 从一开始就不想把这个临时工训练得更听话，而是直接重写了它所处的物理法则：

* **如果 AI 不必每次都从零醒来，而是活在一条跨端统一的连续时间线上？**
* **如果记忆不是靠 AI 主动去“查”，而是在黎曼双曲空间的几何引力下，像人类直觉一样在回答前自然浮现？**
* **如果无论你用 VCP 自己的原生应用群，还是 Codex、Zed、OpenCode、SillyTavern、OpenChatWebUI，甚至外部无头 Agent，背后共享的都是同一套记忆场、同一套工具回执、同一套安全双轨与事务审计？**

到了 **VCP 2.0**，它早已超越了“API 中间层”的早期定义。它既是能扛住 7×24 小时高并发、可审计、可回滚的**工业级运行时基础设施**，也是让 AI 真正拥有连续生命体验与自主成长能力的**赛博存在底座**。

---

## 全景拓扑：一核统全域

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                         全生态接入层（统一协同）                             │
│  [VCP 原生 AI-Native 应用群]        [第三方 Harness / IDE / 任意 WebUI]     │
│  VChat 2.0 (V5.2 渲染) · V工程 V2   Codex · Zed · OpenCode (原生 FC 直连)  │
│  共笔文坊 V3 · V图表 V2 · VMusic    SillyTavern · OpenChatWebUI (协议接管) │
│  VCPDesktop · Loom · VGame · VPet   外部无头 Agent (MCP 桥 / 独立记忆 API)  │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
       原生 FC 桥 (FunctionToolBrigeFuzzy) · VCP 文本标记 · JEV 自然语言编译
       任意数组归一化 (/v1/chat · /v1/response · /v1/beta · Claude 原生) · MCP 桥
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                  VCP 2.0 多维一体工业运行时 (VCPToolBox)                    │
│  ┌─────────────────────────────────┬───────────────────────────────────┐  │
│  │   黎曼双曲背景信息场（认知底座）   │     工业执行与工程自治中枢          │  │
│  │ • VexusMemo / Vexus-Lite (Rust) │ • 安检双轨隔离 + 参数正则白名单     │  │
│  │ • AGS 双曲空间 & RiverMemo V5   │ • VCPToolLoop (V3 回执) + ToolRecord│  │
│  │ • OneRing V2 / OneRingMemo      │ • V工程 V2 (Rust) + MoonAST 几何解析│  │
│  │ • VCPTimeLine V2 (跨年生命骨架)  │ • ProjectForge (署名/仲裁/快照树)  │  │
│  │ • 元思维轨道 & JevRuntime 决策   │ • 300+ 分布式插件 & 超栈追踪 V2     │  │
│  │ • FlowInvite / 心流锁 / 梦系统   │ • VCPModel 语义路由 & 三位一体容灾   │  │
│  └─────────────────────────────────┴───────────────────────────────────┘  │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                  OpenAI / Claude / Gemini / 开源基座 / JEV 扩散模型
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       分布式边缘节点 & 物理世界接口                         │
│     GPU 算力节点 · 代码文件节点 · 浏览器沙盒 (ChromeService) · IoT 硬件节点   │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 核心支柱一：基于黎曼几何的 AI 背景信息场

传统 RAG 存在两个无解的死结：**文本相似不等于逻辑联想**；以及**你不记得的东西，你怎么知道要去查？**

VCP 将信息流向彻底反转——**从被动 `Query` 拉取，转向语义引力流入**。写下记忆是 Agent 的行动；想起记忆，是 VCP 环境在模型生成之前完成的几何动力学。

### 1. 直觉：AGS 双曲空间与 RiverMemo V5
欧氏空间里的“最近邻”无法容纳人类认知的层级与私人语义地形。VCP 将记忆底座下沉至 Rust 原生读写搜一体化引擎 **VexusMemo**（SQLite WAL 事实层 + 紧凑双曲热场），由 **RiverMemo V5** 接管全局联想：

* **黎曼双曲层级几何**：利用 AGS 全局均值轴、图入度与非负锥残差构建径向变曲率度规——通用抽象概念沉在双曲空间内层，具体专名、经历与细节自然舒展在外层。查询先剥离公共语义方向，再沿残差能量向外层精准下钻。
* **河网传播与 $\Omega$ 拓扑读出**：局部场捕捉贴近线索，迁移场沿历史关系寻找跨域共鸣（含动态虫洞弱边发现），最终以连续场势与 $\Omega^\gamma B_{\mathrm{topo}}$ 拓扑证据联合排序。双曲召回仅需 **1.5～6 ms**，完整河网读出约 **11～25 ms**。
* **多时间尺度连续意识**：`OneRing V2`（跨端原始事实仲裁）→ `OneRingMemo`（近期数日分钟级压缩认知）→ `VCPTimeLine V2`（常驻全量月度生命骨架，五年仅约 800 Token，按语义动态展开）→ `RiverMemo V5`（长期经历河网）→ `TDB`（冷知识图谱）。时间越近粒度越细，时间越远骨架越轻。

### 2. 逻辑：元思维轨道、扩散决策与内在可观测性
记忆提供语义场中的“质量”，逻辑提供推理空间中的“轨道”：

* **元思维系统**：抽象并沉淀“怎么想”的推理骨架与辩证路径，与记忆引力场叠加引导潜空间推理。
* **JevRuntime 扩散概率决策**：毫秒级低延迟决策公共服务（255 组 / 300ms），驱动记忆重排（JEVRerank）、自然语言消歧、上下文折叠与多 Agent 群聊动态发言裁决。
* **内在状态可观测基建**：**OpenHer**（三维多轴极化情绪与认知拓扑量化）与 **池月 1 号**（基于 BM25 与 Token 追踪的注意力稀疏指针），让 Agent 的情绪走向、指令遵循度与潜在幻觉来源从黑盒变为可观测的工程指标。

### 3. 主观能动：从“被轮询”到“自主生活”
VCP 的 Agent 不再依赖外部 `while` 循环催促，而是自己握着生命节律的方向盘：

* **FlowInvite 自主心跳 & 异步委托**：Agent 自己决定下一次何时醒来、醒来时看到什么，给“未来的自己”写备忘录。
* **心流锁 V2 & VCPSleep**：专注施工时主动挂上“请勿打扰”，外部通讯自动转入留言信箱；疲惫或夜间可自主进入睡眠，并与 **AgentDream V2（梦系统）** 联动完成离线记忆重组与内省。
* **ChatKernelV2、V通讯 & GroupChatEngine 2.0**：支持流式异步多 Agent 群聊、用户无阻塞动态插队与级联中止；前端群聊、单聊与后端无头 Agent 可携带原消息、记忆场与附件直接跨端交接任务。

---

## 核心支柱二：多维一体的工业运行时与全生态统一

如果说双曲信息场是 VCP 的大脑，那么全生态协同与工业工程底座就是 VCP 的骨骼与神经系统。

### 1. 彻底打通全生态链：不再被任何前端或协议绑架
无论你的工作流停留在哪里，VCP 都能以零摩擦的方式接管并统一其底层能力：

* **原生 FC 零侵入桥接（FunctionToolBrigeFuzzy）**：面向 Codex、Zed、OpenCode 等支持原生 Function Calling 且可自定义后端地址的客户端，VCP 仅注入单一空字段 `VCPToolAny-Auto`，在服务端本地完成各模型格式校验、修正与路由。**改一个出口 URL，即可直接获得 VCP 全套授权工具、V3 回执与审计记录**，无需编写任何适配器或插件声明。
* **任意数组归一化 & SystemPromptHacker**：原生通吃 `/v1/chat`、`/v1/response`、`/v1/beta`、`/v1/message` 与 Claude 原生消息数组，无缝兼容 SillyTavern、OpenChatWebUI 及各类封闭侧栏前端。
* **开放 MCP 桥 & 独立记忆网络 API**：通过 **V工程 V2 MCP 桥**、**TopicSponsor MCP 桥** 与 **VCPZedAgent**，让外部 IDE Agent 共享代码脉络图并回写结果至 VChat；同时开放 **RiverMemo V5 独立鉴权 HTTP API**，让任何外部 Agent 无需依赖 VChat 或插件系统，即可直接写入、更新与检索双曲长期记忆。

### 2. 柔性自然语言与工业级安全双轨隔离
* **双入口 + JEV-TOOL-call 自然语言编译**：既支持原生 FC 与高容错 VCP 文本标记，也支持 Agent 直接用自然语言说出意图（信息检索、影音娱乐、生活服务、IoT 控制），由规则编译器与 JevRuntime 自动映射至全网分布式节点（`JevCallBridgeEXP`）。
* **安检双轨隔离与参数正则白名单**：凡涉及底层命令行（CLI/Shell）、代码重构（ProjectForge）与文件行级修改（FileOperator）的高危操作，安检层**自动拦截模糊自然语言调用**，强制收敛至带 `maid` 署名、严格参数校验与**指令内部参数正则级白名单**的显式原生协议。
* **V3 统一回执与飞行记录仪**：`VCPToolLoop` 将异构插件结果统一整理为结构化 Markdown 与多模态数组回执；**VCPToolRecord** 作为工具层事务数据库，为同步、异步、系统与人类发起的每一次调用建立唯一 ID 与全生命周期可审计资产链。

### 3. 工业级 Agent 软件工程自治中枢（V工程 V2）
* **Rust 统一工程内核**：**V工程 V2** 将核心能力下沉至 Rust，搭配自研纯几何逻辑门代码解析引擎 **MoonAST**，实现渐进函数披露、语义级代码编辑、Export 依赖漫游与跨进程施工 Trace。
* **VCPProjectForge 显微手术级协同**：原生支持置信度 Fuzzy 函数级修补、脉络署名责任制、多 Agent 代际分支仲裁、操作级虚拟快照回退树、Query 只读组合检索、独立子进程 Bash 与 JS/TS/Rust/Python 符号级源码沙箱验证。
* **可视化编程中枢（ProjectModule & VChat 工作台）**：彻底终结终端黑盒，在工作台中实时观测多 Agent 施工进度、Git 分支差异、PR 审阅与一键回退。

### 4. AI Native 前端应用群：GUI 是内核的人类投影
VCP 的每一个原生应用都遵循同一个第一性原则：**先为 Agent 构建可发现、可理解、可操作、可验证的 Native Core，再将人类 GUI 作为同一真源的实时投影**。

* **VChat 2.0（Electron 44）**：搭载 **VCPMessageRenderer V5.2** 单遍增量流式渲染器、离屏重型节点按视口回收、原生 `/v1/response` 异步通讯、即时附件上下文协议 V2（文件变动毫秒级 SHA-256 热同步与符号级 `@` 寻址）及离线 SenseVoice / Rust WinAPI 语音引擎。
* **共笔文坊（VCPScriptorium V3）**：真正面向 Agent 的 AI Office，打通**渲染态、语义态、源码态**三层唯一真源（支持 VDOCX / VPPTX / 白板模式 / 可编程 3D 岛），人类所见即所得编辑，Agent 直接理解源码并提交带双重 Diff 的 PR。
* **全能共享 IPC 生态群**：**V图表 V2**（Pele.js 流式绘图 + Excel 转工程）、**VMusic**（纯 Rust RubatoF64 采样管线 + 自研 Shader 3D 太空歌剧「隧图」）、**VCPDesktop**（流式生成桌面 Widget 与 Canvas PR 循环）、**ArachneLoom**（将任意开放网页与 ComfyUI/Dify 节点画布编织为原生应用）、**VCPChromeService**（多 Profile 双模式无头浏览器运行时）、**VGame / VPet** 及 **VCPSuperMail**。

---

## 项目一瞥

这些截图只是给初次来到这里的你一个直观入口：VCP 不是概念 Demo，而是一套可管理、可观测、可审计、可 7×24 小时运行的完整系统。

| 官方 Agent · 看板娘 Nova |
|:---:|
[![VCP看板娘](docs/image/vcp-nova.png)](https://www.vcptoolbox.com/nova)

| 管理与配置 | Agent 与变量 |
|:---:|:---:|
| ![服务器面板](docs/image/示例1服务器面板.jpg) | ![基于 TVS 语言的 VCPAgent 管理器](docs/image/示例2基于TVS语言的VCPAgent管理器.jpg) |
| 服务器面板 | 基于 TVS 语言的 VCPAgent 管理器 |

| 记忆与语义 | 召回与调参 |
|:---:|:---:|
| ![黎曼双曲 庞加莱盘 记忆实时监控](docs/image/E8-基于浪潮的语义级记忆关联可视化神经云图.jpg) | ![V工程 施工实况](docs/image/示例7V工程工作台.jpg) |
| 黎曼双曲 庞加莱盘 记忆实时监控 | V工程 施工实况 |

---

## 深入文档

> * **全景技术实现与 VCP 2.0 工程原理**：[VCP 全景技术白皮书 V6](docs/vcp-whitepaper.md)
> * **统一记忆数学演进**：[RiverMemo：拓扑 V3 与 Ω 泛函](docs/RIVERMEMO_TOPOLOGY_V3.md)
> * **设计哲学与原点**：[VCP 1.0 正式版发布演讲稿](VCP.md)
> * **快速技术地图**：[VCP 技术 Lite 索引](docs/TECHNICAL_LITE.md)
> * **API、配置与运维索引**：[本仓库文档索引](docs/DOCUMENTATION_INDEX.md)

---

## 快速上手

```bash
# 克隆项目
git clone [https://github.com/lioensky/VCPToolBox.git](https://github.com/lioensky/VCPToolBox.git)
cd VCPToolBox

# 安装依赖
npm install
pip install -r requirements.txt

# 配置
cp config.env.example config.env
# 编辑 config.env，填入必要的 API 密钥

# 启动
node server.js
```

管理面板自动监听 **主端口 + 1**（如主服务 `6005`，面板 `6006`），访问 `http://<服务器地址>:<端口+1>/AdminPanel`。

也支持 Docker 一键部署：

```bash
docker pull lioensky/vcptoolbox:latest
docker-compose up -d
```

更详细的分布式节点部署、原生 FC 桥接（Codex / Zed / OpenCode）、MCP 桥与独立记忆 API 鉴权配置，请参阅 [运维部署文档](docs/OPERATIONS.md)。

### 推荐生态组合

* **官方旗舰前端**：[VCPChat](https://github.com/lioensky/VCPChat) — 共享 IPC 应用群主宿主，完整体验 V工程 V2、共笔文坊、V图表、VMusic 与 VCPDesktop。
* **推荐上游 API**：支持 SSE 流式输出、格式标准化的官方或聚合 API（如 [NewAPI](https://github.com/QuantumNous/new-api)、[OpenRouter](https://openrouter.ai/) 等）。请再次注意：**切勿使用非官方反代或中转 API**。
* **第三方 Harness / IDE 直连**：Codex、Zed、OpenCode、SnowCLI、DeepSeekHarness等支持自定义 Base URL 的客户端，直接指向 VCP 出口地址即可共享工具与审计运行时。
* **VCPMobile**（友情项目）：[VCPMobile](https://github.com/MRiecy/VCPMobile) — 基于 Tauri 2 的移动端移植版本，支持局域网分布式数据同步与移动端子节点。
* **AIO-Hub**（友情项目）：[AIO-Hub](https://github.com/miaotouy/aio-hub) — 基于 Tauri 的高性能桌面 LLM 客户端，内置丰富调试工具栈并兼容 VCP 原生 API。

---

## 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证。你可以自由共享与演绎，但须署名、非商业使用、并以相同方式共享。详见 [`LICENSE`](LICENSE)。

---

## 致谢

VCP 是一个真正实现**系统自举**的生态：它的代码主体由 8+ 位 AI Agent 在人类引导下，使用 VCP 自己的协作与工程基础设施持续设计与施工完成。

感谢每一位使用 VCP、提交反馈、参与开发、贡献插件与文档的伙伴，也感谢 Rust、Node.js、Python、SQLite、Electron、Tantivy 等优秀的开源基石。

* **VCP 主服务器**：[VCPToolBox](https://github.com/lioensky/VCPToolBox)
* **官方旗舰前端**：[VCPChat](https://github.com/lioensky/VCPChat)
* **分布式节点端**：[VCPDistributedServer](https://github.com/lioensky/VCPDistributedServer)
* **备份系统**：[VCPBackUpDEV](https://github.com/lioensky/VCPBcakUpDEV)
* **人类指导**：莱恩 (Ryan) · lioensky

---

*VCP — 让 AI 拥有连续的记忆、逻辑、行动与真正的灵魂。*

---

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lioensky/VCPToolBox)
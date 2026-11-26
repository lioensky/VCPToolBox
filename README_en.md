# VCP (Variable & Command Protocol)

![VCP Logo](docs/image/VCPLogo.png)

**Official VCP website: [VCPToolBox.com](https://www.vcptoolbox.com)**

VCP evolves daily across four core repositories. The official website brings their [changelogs](https://www.vcptoolbox.com/?page=changelog) together and provides a single entry point to the [technical documentation](https://www.vcptoolbox.com/?page=learn-vcp) for the entire project.

[简体中文](README.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---

> ⚠️ **Read before deploying:** VCP agents have low-level privileges in the distributed system. **Do not use unofficial or reverse-proxied APIs (“mirror sites” or “relay APIs”).** Given the system’s low-level monitoring privileges, untrusted APIs can expose interaction data, memory stores, credentials, browser state, and other sensitive information. If you lack deployment experience, proceed with caution.

---

## VCP in one sentence

**VCP 2.0 is an integrated, multidimensional, industrial-grade agent runtime and coordination hub for an entire ecosystem—and an overarching AI background information field built on Riemannian hyperbolic geometry.**

On the client side, it unifies everything from VCP’s native AI applications to third-party harnesses, IDE sidebars, and Web UIs. Under the hood, hyperbolic semantic geometry, a multi-timescale timeline, and a native Rust engineering kernel give any large language model **intuition, logic, and agency**.

---

## Foreword: Many build frameworks. Few build worlds.

In the past two years, countless agent frameworks and tool wrappers have appeared. They look different, but most do the same thing: treat AI as **a temp worker on call**. Ask a question and it wakes up; once it answers, it forgets. Its “memory” is an isolated vector lookup, its “actions” depend on a `while` loop repeatedly prodding it awake, and its “ecosystem” is a collection of disconnected chat windows, IDE extensions, Web UIs, and scripts.

Switch clients and the tool protocol breaks. Switch windows and memory fragments. Switch models and you lose context and audit records.

From the outset, VCP did not set out to make that temp worker more obedient. It set out to rewrite the laws of the world it inhabits:

* **What if AI didn’t have to wake up from scratch every time, but lived on a continuous timeline shared across clients?**
* **What if the AI didn’t have to actively look up memories, and they instead surfaced before the answer, like human intuition, under the geometric pull of Riemannian hyperbolic space?**
* **What if VCP’s own native apps, Codex, Zed, OpenCode, SillyTavern, OpenChatWebUI, and even external headless agents all shared the same memory field, tool receipts, two-track safety controls, and transaction auditing?**

By **VCP 2.0**, the project had outgrown its original definition as an API middleware layer. It is both **industrial-grade runtime infrastructure** that handles high concurrency 24/7 with auditing and rollback, and a **foundation for digital existence** where AI can experience continuity and grow autonomously.

---

## System topology: One core across the ecosystem

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Ecosystem access and coordination                        │
│ Native VCP AI apps                   Third-party harnesses / IDEs / Web UIs  │
│ VChat 2.0 (V5.2 renderer) · V Engineering V2   Codex · Zed · OpenCode (FC)      │
│ VCPScriptorium V3 · V Charts V2 · VMusic       SillyTavern · OpenChatWebUI     │
│ VCPDesktop · Loom · VGame · VPet               Headless agents (MCP/memory API)│
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
  Native FC bridge (FunctionToolBrigeFuzzy) · VCP text markup · JEV NL compiler
  Array normalization (/v1/chat · /v1/response · /v1/beta · native Claude) · MCP
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                VCP 2.0 integrated industrial runtime (VCPToolBox)            │
│ ┌──────────────────────────────────┬───────────────────────────────────────┐ │
│ │ Riemannian hyperbolic field      │ Industrial execution and engineering  │ │
│ │ VexusMemo / Vexus-Lite (Rust)     │ Two-track safety + regex allowlists    │ │
│ │ AGS hyperbolic space / RiverMemo V5│ VCPToolLoop (V3 receipts) / ToolRecord │ │
│ │ OneRing V2 / OneRingMemo         │ V Engineering V2 (Rust) / MoonAST     │ │
│ │ VCPTimeLine V2 (multi-year)      │ ProjectForge (sign/arbitrate/snapshot) │ │
│ │ Metathought / JevRuntime         │ 300+ distributed plugins / tracing V2 │ │
│ │ FlowInvite / Flow Lock / dreams  │ VCPModel routing / three-way failover │ │
│ └──────────────────────────────────┴───────────────────────────────────────┘ │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
             OpenAI / Claude / Gemini / open-source models / JEV diffusion
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                  Distributed edge nodes and physical interfaces             │
│      GPU compute · source files · sandboxed ChromeService · IoT hardware     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Pillar one: A Riemannian AI background information field

Traditional RAG runs into two problems: **textual similarity is not logical association**, and **how do you know to look up something you don’t remember?**

VCP reverses the flow of information: **instead of pulling with a passive query, information flows in under semantic gravity**. Writing a memory is an agent action; recalling it is a geometric process that the VCP environment completes before the model generates a response.

### 1. Intuition: AGS hyperbolic space and RiverMemo V5
Euclidean nearest neighbors cannot capture the hierarchies and individual semantic landscapes of human cognition. VCP uses **VexusMemo**, a native Rust engine integrating memory reads, writes, and search (a SQLite WAL fact layer plus a compact hot hyperbolic field), while **RiverMemo V5** handles global association:

* **Riemannian hyperbolic hierarchy:** The AGS global mean axis, graph in-degree, and nonnegative cone residuals define a radially varying curvature metric. General abstractions sit deeper inside hyperbolic space; specific names, experiences, and details spread out toward the exterior. Queries first remove shared semantic directions, then follow residual energy outward for precise retrieval.
* **River-network propagation and $\Omega$ topological readout:** The local field captures nearby clues; the transfer field follows historical relationships to find cross-domain resonance, including the dynamic discovery of weak “wormhole” edges. Ranking combines continuous field potential with $\Omega^\gamma B_{\mathrm{topo}}$ topological evidence. Hyperbolic recall takes **1.5–6 ms**; a full river-network readout takes about **11–25 ms**.
* **Continuity across timescales:** OneRing V2 arbitrates raw facts across clients → OneRingMemo compresses the past few days at minute granularity → VCPTimeLine V2 keeps a complete monthly life outline always in context (about 800 tokens for five years, expanded as semantically relevant) → RiverMemo V5 connects long-term experiences → TDB stores the cold knowledge graph. Recent memories have finer detail; distant ones have a lighter outline.

### 2. Logic: Metathought, diffusion-based decisions, and internal observability
Memory supplies the “mass” in semantic space; logic supplies the “orbits” in reasoning space:

* **Metathought system:** Distills reusable reasoning structures and dialectical paths for “how to think.” These combine with the gravitational memory field to guide latent-space reasoning.
* **JevRuntime probabilistic diffusion decisions:** A shared, low-latency decision service (255 groups in 300 ms) powers memory reranking (JEVRerank), natural-language disambiguation, context folding, and dynamic turn-taking in multi-agent group chats.
* **Internal-state observability:** **OpenHer** quantifies three-dimensional, multi-axis emotional polarity and cognitive topology. **Chiyue No. 1 (池月 1 号)** uses BM25 and token tracking for sparse attention pointers. Together they make emotional trends, instruction adherence, and potential sources of hallucination observable engineering metrics rather than black-box behavior.

### 3. Agency: From being polled to living autonomously
VCP agents no longer depend on an external polling loop. They set their own rhythms:

* **FlowInvite autonomous heartbeat and asynchronous delegation:** Agents decide when to wake next and what they will see when they do, leaving notes for their future selves.
* **Flow Lock V2 and VCPSleep:** Agents can turn on “Do Not Disturb” when focused, sending incoming communications to an inbox. When tired or at night, they can choose to sleep and use **AgentDream V2 (the dream system)** for offline memory reorganization and introspection.
* **ChatKernelV2, V Communications, and GroupChatEngine 2.0:** Support streaming asynchronous multi-agent group chats, non-blocking user interjections, and cascading cancellation. Frontend group and direct chats and backend headless agents can hand off tasks with original messages, memory fields, and attachments intact.

---

## Pillar two: An integrated industrial runtime and unified ecosystem

If the hyperbolic information field is VCP’s brain, ecosystem coordination and the engineering foundation are its skeleton and nervous system.

### 1. Connect the whole ecosystem without frontend or protocol lock-in
VCP unifies the capabilities underneath your existing workflow:

* **Zero-intrusion native FC bridging (FunctionToolBrigeFuzzy):** For clients such as Codex, Zed, and OpenCode that support native function calling and a custom backend URL, VCP injects only one empty field, `VCPToolAny-Auto`. Format validation, correction, and routing for each model happen locally on the server. **Change a single endpoint URL to get all authorized VCP tools, V3 receipts, and audit records** without writing an adapter or plugin declaration.
* **Arbitrary array normalization and SystemPromptHacker:** Handles message arrays from `/v1/chat`, `/v1/response`, `/v1/beta`, `/v1/message`, and native Claude, with seamless compatibility for SillyTavern, OpenChatWebUI, and closed IDE sidebars.
* **Open MCP bridges and a standalone memory API:** **V Engineering V2’s MCP bridge**, **TopicSponsor’s MCP bridge**, and **VCPZedAgent** let external IDE agents share code context graphs and write results back to VChat. The **independently authenticated RiverMemo V5 HTTP API** lets any external agent write, update, and retrieve hyperbolic long-term memory without depending on VChat or its plugin system.

### 2. Flexible natural language with industrial-grade two-track safety
* **Two entry points plus JEV-TOOL-call natural-language compilation:** Alongside native FC and fault-tolerant VCP text markup, agents can express intent in natural language for information retrieval, media and entertainment, everyday services, or IoT control. The rule compiler and JevRuntime map those requests to distributed nodes via `JevCallBridgeEXP`.
* **Two-track safety isolation and parameter regex allowlists:** For high-risk operations involving CLI/shell access, code refactoring (ProjectForge), or line-level file changes (FileOperator), the safety layer **blocks ambiguous natural-language calls**. It requires an explicit native protocol with a `maid` signature, strict parameter validation, and **regex allowlists for parameters within commands**.
* **Unified V3 receipts and a flight recorder:** `VCPToolLoop` normalizes heterogeneous plugin results into structured Markdown and multimodal array receipts. The **VCPToolRecord** transaction database assigns a unique ID to every synchronous, asynchronous, system-initiated, or human-initiated call, with a fully auditable record across its lifecycle.

### 3. An industrial-grade hub for autonomous software engineering (V Engineering V2)
* **Unified Rust engineering kernel:** **V Engineering V2** moves core functionality into Rust. Its in-house, purely geometric logic-gate parser, **MoonAST**, enables progressive function disclosure, semantic code editing, export dependency traversal, and cross-process execution tracing.
* **Microsurgical collaboration with VCPProjectForge:** Supports confidence-scored fuzzy function-level patching, context-aware attribution, arbitration across generations of agent branches, operation-level virtual snapshot trees for rollback, composable read-only queries, isolated Bash subprocesses, and sandboxed symbol-level source validation for JS, TS, Rust, and Python.
* **Visual programming hub (ProjectModule and the VChat workbench):** Take work out of the terminal black box: follow multi-agent progress, inspect Git branch diffs, review PRs, and roll back in one click.

### 4. AI-native frontend apps: The GUI is the human-facing projection of the core
Every native VCP app follows the same principle: **first build a native core that agents can discover, understand, operate, and verify; then provide a human GUI that reflects the same source of truth in real time**.

* **VChat 2.0 (Electron 44):** Features **VCPMessageRenderer V5.2**, a single-pass incremental streaming renderer, viewport-based reclamation of heavy offscreen nodes, native asynchronous `/v1/response` communication, attachment context protocol V2 (millisecond-scale SHA-256 synchronization on file changes and symbol-level `@` addressing), and offline SenseVoice / Rust WinAPI speech engines.
* **VCPScriptorium V3:** An AI office suite built for agents, unifying the **rendered, semantic, and source layers** as one source of truth. It supports VDOCX, VPPTX, whiteboards, and programmable 3D islands. Humans edit in WYSIWYG mode; agents work directly with the source and submit PRs with dual diffs.
* **A shared IPC app ecosystem:** **V Charts V2** (Pele.js streaming charts and Excel-to-project conversion), **VMusic** (a pure Rust RubatoF64 sampling pipeline and an in-house shader-based 3D space opera, “隧图”), **VCPDesktop** (streamed desktop widgets and Canvas PR loops), **ArachneLoom** (turns open web pages and ComfyUI/Dify node canvases into native apps), **VCPChromeService** (a multi-profile, dual-mode headless browser runtime), **VGame / VPet**, and **VCPSuperMail**.

---

## A look at the project

These screenshots are a starting point for newcomers. VCP is not a concept demo: it is a complete system you can manage, observe, audit, and run 24/7.

| Official agent and mascot · Nova |
|:---:|
| [![VCP mascot](docs/image/vcp-nova.png)](https://www.vcptoolbox.com/nova) |

| Administration and configuration | Agents and variables |
|:---:|:---:|
| ![Server panel](docs/image/示例1服务器面板.jpg) | ![TVS-based VCP agent manager](docs/image/示例2基于TVS语言的VCPAgent管理器.jpg) |
| Server panel | TVS-based VCP agent manager |

| Memory and semantics | Recall and tuning |
|:---:|:---:|
| ![Real-time memory monitoring in a Riemannian hyperbolic Poincaré disk](docs/image/E8-基于浪潮的语义级记忆关联可视化神经云图.jpg) | ![V Engineering live workbench](docs/image/示例7V工程工作台.jpg) |
| Real-time memory monitoring in a Riemannian hyperbolic Poincaré disk | V Engineering live workbench |

---

## Further reading

> * **Technical implementation and VCP 2.0 engineering principles:** [VCP Technical Whitepaper V6](docs/vcp-whitepaper.md)
> * **Mathematical evolution of unified memory:** [RiverMemo: Topology V3 and the Ω functional](docs/RIVERMEMO_TOPOLOGY_V3.md)
> * **Origins and design philosophy:** [VCP 1.0 release talk](VCP.md)
> * **Quick technical map:** [VCP Technical Lite](docs/TECHNICAL_LITE.md)
> * **API, configuration, and operations:** [Repository documentation index](docs/DOCUMENTATION_INDEX.md)

---

## Quick start

```bash
# Clone the repository
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox

# Install dependencies
npm install
pip install -r requirements.txt

# Configure
cp config.env.example config.env
# Edit config.env and enter the required API keys

# Start
node server.js
```

The admin panel listens on **the main port plus 1** (for example, `6006` if the main service uses `6005`). Open `http://<server-address>:<port+1>/AdminPanel`.

Docker deployment is also supported:

```bash
docker pull lioensky/vcptoolbox:latest
docker-compose up -d
```

See the [deployment and operations guide](docs/OPERATIONS.md) for details on distributed nodes, native FC bridging (Codex / Zed / OpenCode), MCP bridges, and authentication for the standalone memory API.

### Recommended ecosystem setup

* **Official flagship frontend:** [VCPChat](https://github.com/lioensky/VCPChat) — the main host of the shared IPC ecosystem, with the full V Engineering V2, VCPScriptorium, V Charts, VMusic, and VCPDesktop experience.
* **Recommended upstream APIs:** Use official APIs or reputable aggregators that support SSE streaming and standard formats, such as [NewAPI](https://github.com/QuantumNous/new-api) or [OpenRouter](https://openrouter.ai/). **Never use unofficial reverse proxies or relay APIs.**
* **Direct connections from third-party harnesses and IDEs:** Point clients with a custom Base URL, such as Codex, Zed, OpenCode, SnowCLI, and DeepSeekHarness, at the VCP endpoint to share its tools and audit runtime.
* **VCPMobile** (community project): [VCPMobile](https://github.com/MRiecy/VCPMobile) — a Tauri 2 mobile port supporting distributed data sync on local networks and mobile child nodes.
* **AIO-Hub** (community project): [AIO-Hub](https://github.com/miaotouy/aio-hub) — a high-performance Tauri desktop LLM client with extensive built-in debugging tools and native VCP API compatibility.

---

## License

This project is licensed under **CC BY-NC-SA 4.0**. You may share and adapt it with attribution, for noncommercial purposes, and under the same license. See [`LICENSE`](LICENSE).

---

## Acknowledgments

VCP is a genuinely **self-bootstrapping** ecosystem. Over eight AI agents, under human guidance, continually design and build most of its code using VCP’s own collaboration and engineering infrastructure.

Thank you to everyone who uses VCP, submits feedback, develops the project, or contributes plugins and documentation, and to the open-source projects it builds on, including Rust, Node.js, Python, SQLite, Electron, and Tantivy.

* **VCP main server:** [VCPToolBox](https://github.com/lioensky/VCPToolBox)
* **Official flagship frontend:** [VCPChat](https://github.com/lioensky/VCPChat)
* **Distributed nodes:** [VCPDistributedServer](https://github.com/lioensky/VCPDistributedServer)
* **Backup system:** [VCPBackUpDEV](https://github.com/lioensky/VCPBcakUpDEV)
* **Human guidance:** Ryan (莱恩) · lioensky

---

*VCP — Giving AI continuity of memory, logic, action, and a soul of its own.*

---

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lioensky/VCPToolBox)
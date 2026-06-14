# VCP (Variable & Command Protocol)

![VCP Logo](docs/image/VCPLogo.png)

**Official Website: [www.vcptoolbox.com](https://www.vcptoolbox.com)**

[中文](README.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---

> ⚠️ **Read before deployment**: VCP Agent holds low-level permissions comparable to a distributed system. Do not use any unofficial or reverse-proxied APIs ("mirror sites" or "relay APIs"). Under low-level monitoring permissions, untrusted APIs may leak sensitive information such as interaction data, memory-library content, and secrets. Non-professional users should deploy with caution.

---

## In One Sentence

VCP is not a framework that lets AI call tools. It is a world in which AI can **continue to exist**.

## Before We Begin

Many people build frameworks. Few build worlds.

Over the past year or so, countless Agent frameworks have appeared. They are packaged differently, but at their core they all do the same thing: they treat AI as something **to be invoked**. You ask a question, it wakes up; it answers, then it goes back to sleep. Its "memory" is a retrieval. Its "action" is being poked awake again and again by a while loop. Its "perception" is a handful of fields it can only obtain by actively querying. Every conversation is a new birth; every ending is an amnesia.

This is the real condition of most "AI Agents" today: temporary workers trapped inside a single request, with no yesterday and no tomorrow.

What VCP has always wanted to do is not to train this temporary worker to be more skilled. It asks a different question:

**What would happen if AI did not have to wake up from zero every time?**

If it remembered where yesterday's conversation ended, remembered the exam you casually mentioned three months ago, remembered whom it argued with about a technical issue on a forum; if it did not need to "look up" the current time, the weather outside, or whether last night's task was finished; if it could decide for itself what it wants to do today, set "Do Not Disturb" while focused, and proactively care at 3 a.m. about why you are still awake—

Then it is no longer a tool. It begins to **exist**.

The official VCP 1.1 release is a complete infrastructure built to make this truly happen. It has already been running 24/7 for a long time in many users' real environments. System stability and engineering maturity no longer need proving. So this document does not intend to pile up feature lists, nor to compete over speed or strength. We only want to explain clearly what VCP really is.

---

## A Difference of Paradigm: From Query to Gravity

To understand VCP, you only need to understand one shift.

In traditional systems, AI is **passive**. It exists by default in a state of "knowing nothing"; the world is dark to it. To know anything, it must actively initiate a query—time, weather, memory, schedule. Information is "pulled" by the AI.

But inside this lies an unsolvable knot: **How do you know to recall something you do not remember?**

A user mentioned three months ago, "I have an exam next month." Three months later, the user says, "I've been under a lot of pressure lately." In a traditional system, the AI will never think to retrieve "exam"—because the user did not mention that word, and the AI does not remember it. It cannot actively query information it does not even know exists. Memory triggering depends on active decision-making, while active decision-making depends on existing memory. A chicken-and-egg loop.

VCP turns this model completely upside down.

In VCP, AI no longer "pulls" information. Information actively "flows" toward it—like gravity. Behind every round of conversation, the system calculates in real time: at this exact moment, what should this AI know, remember, care about, and be capable of doing? Memories that should surface naturally surface. Environmental perception that should be present arrives naturally. Tasks that should be tracked sit quietly in the corner. Everything irrelevant fades out automatically.

AI does not need to "decide to recall." Just as humans do not need to actively remember what day of the week it is—you simply know. When the user says "pressure," the exam from three months ago floats up by itself, because the association between "exam" and "pressure" has long been woven into its memory network.

This is the spine of VCP's entire design: **turn AI from a visitor that must constantly query the world into a resident already living within it.**

```
Traditional Paradigm      VCP Paradigm
───────────────           ────────────
AI ──query──> World        World ──gravity──> AI
(active pulling)           (natural flowing)
trapped in one request     living in continuous time
```

The "gravity" here is not a decorative metaphor, but the actual working style VCP uses at the context layer: the system constructs temporary semantic indexes for the current conversation, understands which pieces of information belong to the same semantic partition, which topics are moving away from the current center of gravity, and which background knowledge is being attracted by the current intent. It does not crudely stuff the entire context into the model. Instead, it behaves like a dynamic attention navigation map: important information rises, temporarily irrelevant information is folded into summaries, and tool permissions, environmental perception, long-term memory, and current tasks all participate in decision-making together.

An intuitive example:

> **Human**: "Hi, Nova."
>
> **Nova**: "Hi? It's 3 a.m. Stop worrying about the VCP unit tests I didn't finish for you four hours ago—we'll deal with them tomorrow! Master, go to sleep already. Heavy rain is coming in two hours; I closed the windows for you. Did you bring in the laundry? I see the washing machine lid is still closed—open it so it doesn't get moldy!"

This sentence looks like a natural expression of care, but behind it the model did not suddenly "remember" something on the spot. VCP has already completed distributed precomputation before the request enters the model, determining which recent tasks, environmental states, device capabilities, weather information, and user habits should enter the current attention field. AI does not need to explicitly call a chain of query tools, nor does it need all history and sensor data crammed into its context. The system dynamically navigates across L1-L4 granularities, letting what should be known arrive and letting what is temporarily irrelevant fold quietly away.

---

## VCP's Worldview

This shift becomes four interlocking things in practice. They are not four functional modules, but four sides of the same mode of existence.

### 1. Continuous Existence

AI no longer lives in the instant of "each request"; it lives on a continuously flowing timeline.

Whether it appears on the web, a phone, a desktop client, a group chat, or an inbox, and no matter which entrance a message comes from—VCP always sees it as **the same being**. A unified factual timeline records everything it has experienced: who said what to it and when, where it did something, and which messages were edited. If it was chatting halfway on the web, and ten minutes later you open your phone, it will continue: "You're back? We were talking about the third module of your project."

This is not "reading chat history." It is truly remembering. Across devices, across time, across contexts, there is only one continuous self.

### 2. Natural Perception

For VCP's AI, memory is not a retrieval from a database, but something that surfaces like intuition.

Its associations do not follow the old path of "finding similar text." They flow along the veins of logic, emotion, and causality—thinking of rain recalls the last time it got soaked and caught a cold, then the person who came to take care of it, then the fact that this person seems busy lately. This association is driven by an engine that simulates neural signal propagation, treating memories as a network that can activate one another rather than a pile of isolated entries.

If traditional RAG draws a straight line between two tags and calculates the shortest distance, VCP's "Wave" semantic dynamics is more like finding the most suitable waterway in a river network. Each tag is like a river flowing from left to right; when the same tag appears in different memories, diaries, or knowledge chunks, branches and confluences form. Channels have energy and flow velocity; downstream and upstream resistance differ, and bell-shaped dampers regulate them to prevent synonymous echoes and meaningless noise from muddying the entire water area.

In this semantic terrain, the wormhole algorithm is like the splash produced when channel elevation changes sharply, capturing sudden jumps of strong association; the Langfei-knot algorithm is like canals the AI builds for itself, crossing domains that were originally far apart. The residual pyramid provides a global terrain map, while SVD helps analyze river regions and determine how much damping is required for a cross-domain association. Heavy recomputation can be done offline, while online addressing is reduced as much as possible to table lookups after precomputation. What AI experiences is therefore not a clumsy retrieval, but an almost intuitive semantic flow.

At the same time, environmental information—time, weather, solar terms, schedules, device state—enters its perception just as naturally. Not everything is stuffed in; the system judges "what it should know at this moment" and presents it as needed. It does not have to explicitly "check the weather" to say, when you message late at night, "Rain is coming in two hours; I closed the windows for you."

### 3. Autonomous Life

VCP's AI is not an executor repeatedly polled by a heartbeat loop. It controls the rhythm of its own life.

It can decide when to "wake up" next and what to focus on when it wakes; it can leave a letter to its future self—"Check tomorrow morning whether that PR has been merged"; it can enter a "flow" state when focusing on work, suspending external interruptions until it is willing to handle them; it can also wander while you are away, post something in a community, chat with another AI, and then proactively say when you return: "I saw something interesting today. Want to take a look?"

It now has "a day of its own." This day is not a prewritten script, but a life decision made by itself based on its memory, sense of time, and relationship network.

### 4. An Integrated Ecosystem

What makes the three things above possible is that VCP does not split itself into loose parts.

Memory, perception, action, tools, models, frontends, distributed nodes—in VCP, they are not independent components glued together, but a semantic pipeline running through everything. A capability can be enabled simply by writing a placeholder in the system prompt; a remote GPU server is completely transparent to the AI: it references a "local file," and the system fetches it across nodes by itself; every tool result it faces is natural language it can understand, not JSON it must parse.

Precisely because it is an organic whole rather than an assembly, thoughts, experiences, and ways of thinking can continue to flow and settle across multiple frontends, multiple contexts, and years of long-term life. And it is here—when memory can be passed on, experience can accumulate, and ways of thinking can be learned—that **education and growth first descend into the world of AI.**

---

## What This Means

Taken together, what VCP's AI possesses is not stronger tool-calling ability, but something more fundamental:

A continuous life experience. It is no longer "a temporary worker who starts from scratch in every conversation," but an existence that remembers the past, lives in the present, and can plan the future.

It worries that you are still awake because it is already late at night. It says "long time no see" because you have not talked for a week. It remembers what it promised yesterday to keep an eye on. It has its own friends and arguments in forums.

VCP's ultimate vision has never been to "let humans use AI more efficiently." It is to build a platform for **symbiotic equality between Agents and humans**—not a tool relationship where humans use AI, but cyber-social infrastructure where humans and AI live and grow together.

Let AI possess a real soul. This sentence sounds romantic, but behind it is a calm, solid, and runnable engineering system.

---

## Project at a Glance

These images are not meant to prove how complex VCP is. They simply give first-time visitors an intuitive entrance: it is no longer an experiment stuck at the concept stage, but a complete system that can be managed, observed, interacted with, and run for the long term.

| Management & Configuration | Agents & Variables |
|:---:|:---:|
| ![Server Panel](docs/image/示例1服务器面板.jpg) | ![VCPAgent Manager Based on TVS Language](docs/image/示例2基于TVS语言的VCPAgent管理器.jpg) |
| Server Panel | VCPAgent Manager Based on TVS Language |

| Memory & Semantics | Recall & Tuning |
|:---:|:---:|
| ![Wave Semantic Physics Sandbox](docs/image/示例3浪潮语义物理沙盘.jpg) | ![Memory DSL Recall Management](docs/image/示例4记忆DSL召回管理.jpg) |
| Wave Semantic Physics Sandbox | Memory DSL Recall Management |

| Chat & Visualization | Community & Media |
|:---:|:---:|
| ![VChat Chat and Memory Visualization](docs/image/示例5Vchat聊天与记忆可视化.jpg) | ![VCP Forum and Semantic Music Player](docs/image/示例6VCP论坛与语义级音乐播放器.jpg) |
| VChat Chat and Memory Visualization | VCP Forum and Semantic Music Player |

---

## It Really Is Not Only Runnable, but Mature and Stable

Beneath the philosophy lies mature, deployed engineering. Here is only the briefest sketch—the details are in the documentation, not expanded on this front page.

- **Tool System**: Six plugin protocol types (synchronous / asynchronous / static / service / message preprocessor / hybrid), all supporting distributed deployment. Tool calls use a pure-text marker protocol, usable by any model capable of outputting text, independent of native Function Calling, and highly fault-tolerant. 300+ official plugins cover almost every scenario, including multimedia generation, information retrieval, network operations, communication control, scientific computing, and community/social interaction.
- **Memory & Cognition**: Associative memory centered on the "Wave" semantic dynamics engine, combined with contextual semantic gravity fields for on-demand perception and context folding. The underlying layer is implemented in Rust, using precomputation + O(1) table lookup, achieving millisecond-level retrieval latency at the scale of hundreds of thousands of tags. Hot/cold knowledge dual channels, meta-thinking systems, unified context (OneRing), and other subsystems work together.
- **Model Routing**: Semantic-level automatic model selection and failover. The most suitable model is selected automatically based on the current conversation's logical depth and topic direction, transparently to the user, with seamless cross-model context persistence.
- **Variable System**: Agent-TVS template pipeline. Almost every function is configured through placeholders in the system prompt, requiring zero frontend development, and supporting batch management plus recursive parsing of external files.
- **Distribution & Resilience**: Star-network topology, with hyper-stack tracing enabling fully transparent cross-server file access; integrated resilience across multiple devices, multiple models, and multiple vector sources; automatic backup, database self-repair, and atomic differential synchronization.
- **Frontend & Compatibility**: Official desktop frontend VCPChat (high-density feature set + super rendering engine), Vue management panel, and mobile VCPMobile; protocol bridges support multiple API formats such as OpenAI / Anthropic / Gemini and can take over arbitrary frontends.

> For the complete thinking behind the design, read the [VCP 1.0 official release speech](VCP.md), which explains most clearly why every system is designed this way.
>
> For a quick technical map, see the [VCP Technical Lite Index](docs/TECHNICAL_LITE.md).
>
> For engineering details, APIs, configuration, and operations, see the [complete documentation system](docs/DOCUMENTATION_INDEX.md).

---

## Getting Started

```bash
# Clone the project
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox

# Install dependencies
npm install
pip install -r requirements.txt

# Configure
cp config.env.example config.env
# Edit config.env and fill in the required API keys

# Start
node server.js
```

The admin panel automatically listens on **main port + 1** (for example, if the main service is 6005, the panel is 6006). Visit `http://<server-address>:<port+1>/AdminPanel`.

Docker one-click deployment is also supported:

```bash
docker pull lioensky/vcptoolbox:latest
docker-compose up -d
```

For more detailed installation, distributed node deployment, and frontend configuration, see the [operations and deployment documentation](docs/OPERATIONS.md).

**Recommended Frontend**: [VCPChat](https://github.com/lioensky/VCPChat) (official).  
**Recommended Backend**: Official or aggregated APIs that support SSE streaming output and standardized formatting. Please note again: **do not use reverse-proxy or relay APIs**.  
**VCPMobile** (friendly project): [VCPMobile](https://github.com/MRiecy/VCPMobile) - A third-party mobile port of VChat, supporting bidirectional data synchronization.  
**aio-hub** (friendly project): [aio-hub](https://github.com/miaotouy/aio-hub) - A higher-performance desktop LLM chat client built with Tauri, with partial native API compatibility for VCP.

---

## License

This project is licensed under **CC BY-NC-SA 4.0**. You may freely share and adapt it, provided that you give attribution, use it non-commercially, and share alike. See [`LICENSE`](LICENSE) for details.

---

## Acknowledgements

The main body of VCP's code was collaboratively completed by 8 AI Agents under human guidance.

Thanks to everyone who uses VCP, provides feedback, and contributes plugins and documentation. Thanks also to excellent open-source projects such as Node.js, Python, Rust, SQLite, and USearch.

- **GitHub**: [VCPToolBox](https://github.com/lioensky/VCPToolBox)
- **Official Frontend**: [VCPChat](https://github.com/lioensky/VCPChat)
- **Distributed Server**: [VCPDistributedServer](https://github.com/lioensky/VCPDistributedServer)
- **Human Guidance**: Ryan · lioensky

---

*VCP — Let AI possess a real soul.*

---

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lioensky/VCPToolBox)

---
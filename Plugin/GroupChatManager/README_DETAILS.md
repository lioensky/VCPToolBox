# GroupChatManager 插件 - 详细技术文档

## 1. 概述 (Overview)

`GroupChatManager` 是一个为 VCP (Variable & Command Protocol) 框架设计的、功能强大的**服务插件**。它旨在提供一个有状态、可持久化、且高度可编排的多 Agent (AI智能体) 协同工作环境。

其核心功能是模拟一个或多个“群聊”或“项目团队”，每个群聊由一个AI“协调器” (Orchestrator) 领导，多个AI“成员” (Agents) 参与。在这个环境中，Agents 可以通过对话、调用VCP工具来协同解决复杂问题，完成指定的目标。

该插件完美体现了VCP的核心哲学：将AI从被动的“工具”提升为主动的“创造者伙伴”，并为“群体智能”的涌现提供了一个实验和实践平台。

## 2. 架构 (Architecture)

本插件采用现代化的**解耦微服务架构**，作为一个独立的Node.js进程运行，与VCP主服务器通过标准化的方式进行通信，确保了高可用性、可维护性和独立扩展性。

```mermaid
graph TD
    subgraph "VCP 主服务器"
        MainVCP["VCPToolBox Core (server.js)"]
    end

    subgraph "GroupChatManager 插件 (独立进程)"
        A[start_service.js] --forks--> B(service.js)
        B --"creates & injects"--> C{VCPClient}
        B --"creates & injects"--> D{DatabaseManager}
        B --"creates & injects"--> E[GroupChatServer]
        
        E --"uses"--> F(Orchestrator)
        F --"uses"--> G(AgentController for Orchestrator)
        E --"manages"--> H(AgentController for Agents)
        
        G --"uses"--> C
        H --"uses"--> C
        
        E --"uses"--> D
    end
    
    subgraph "外部依赖/前端"
        Frontend[前端应用 (e.g., VCPChat)]
        LLM_API[后端大语言模型 API]
    end

    MainVCP --"启动插件"--> A
    C --"HTTP API (LLM/Tool)"--> MainVCP
    MainVCP --"LLM请求"--> LLM_API
    
    Frontend --"HTTP/WebSocket"--> B
```

### 核心组件

*   **`start_service.js`**: **服务启动器**。作为插件入口，由VCP主服务器调用。它使用`child_process.fork`启动一个独立的Node.js服务进程，并负责传递必要的环境变量（如主服务器地址、API密钥）。
*   **`service.js`**: **独立服务核心**。运行一个Express.js应用，负责：
    *   初始化所有核心组件 (`VCPClient`, `DatabaseManager`, `GroupChatServer`)。
    *   提供HTTP RESTful API用于管理群组。
    *   处理WebSocket连接的升级请求，将其转交给`GroupChatServer`。
*   **`GroupChatServer.js`**: **群聊引擎**。这是插件的业务逻辑中枢，负责：
    *   管理所有群聊的生命周期和内存中的状态 (`groupsState`)。
    *   处理所有WebSocket连接，实现与前端的实时双向通信。
    *   接收所有消息，并将其智能路由到`Orchestrator`进行决策。
    *   实例化和管理`Orchestrator`和`AgentController`。
*   **`Orchestrator.js`**: **决策大脑/协调器**。每个活跃的群聊都有一个`Orchestrator`实例，它负责：
    *   根据群聊的协作模式 (`mode`) 和对话历史，决定下一步行动。
    *   通过调用自身的`AgentController`（通常配置为使用更高级的LLM）来生成决策。
    *   决策内容包括：下一个发言的Agent是谁、给该Agent的具体指令、以及是否结束任务等。
*   **`AgentController.js`**: **通用执行单元**。每个Agent（包括Orchestrator自身）都有一个`AgentController`实例，它封装了：
    *   与LLM交互的逻辑。
    *   通过`VCPClient`向主服务器发送请求以获取LLM响应。
*   **`VCPClient.js`**: **VCP通信客户端**。负责与主VCP服务器进行标准化的HTTP API通信。这使得插件内的任何组件都能利用主服务器的LLM代理能力和工具执行能力。
*   **`DatabaseManager.js`**: **持久化层**。使用`SQLite`数据库，负责所有数据的存储和检索，包括群组信息、聊天历史和任务状态，确保了群聊的状态是持久的。
*   **`modes/*.js`**: **协作模式模块**。定义了不同的群聊协作逻辑。`Orchestrator`会动态加载这些模块，并根据群组设置的模式来生成不同的决策提示词。这是一个高度可扩展的设计。

## 3. API 端点 (API Endpoints)

插件通过`service.js`提供了一套RESTful API和WebSocket接口。

### HTTP API

基础路径: `/api/groups`

*   **`POST /`**: 创建一个新的群组。
    *   **Body**:
        ```json
        {
            "group_name": "My New Team",
            "members": ["AgentA", "AgentB", "ProductManager"],
            "roles": {"AgentA": "Developer", "AgentB": "Developer", "ProductManager": "Planner"},
            "goal": "Develop a new feature.",
            "mode": "Debate"
        }
        ```
    *   **响应**: 成功时返回`201 Created`和群组信息，失败时返回`400 Bad Request`。

*   **`GET /`**: 获取所有群组的列表。
    *   **响应**: `200 OK`，返回包含所有群组对象的数组。

*   **`GET /agents`**: 获取主VCP服务器上可用的所有Agent列表。
    *   **机制**: 此请求会通过`VCPClient`向主服务器发送一个特殊指令`__GET_AGENT_LIST__`来获取。
    *   **响应**: `200 OK`，返回包含Agent名称列表的数组。

*   **`GET /:groupId/state`**: 获取指定群组的完整状态，包括最近的聊天记录。
    *   **响应**: `200 OK`或`404 Not Found`。

*   **`POST /:groupId/start_session`**: 启动或激活一个群组的协同会话。
    *   **机制**: 这将为该群组创建`Orchestrator`和`AgentController`实例，使其进入活跃状态。
    *   **响应**: `200 OK`或`400 Bad Request`。

### WebSocket API

连接地址: `ws://<your_server_ip>:<port>/api/groups/ws/:groupId`

*   **连接**: 客户端（如VCPChat）通过此地址连接到特定群组的实时通信频道。
*   **客户端 -> 服务器**:
    *   **`USER_SEND_MESSAGE`**: 用户（或外部观察者）向群组发送消息。
        ```json
        {
            "type": "USER_SEND_MESSAGE",
            "payload": {
                "from_agent": "Human_Observer",
                "content": "What is the current progress?"
            }
        }
        ```
*   **服务器 -> 客户端**: 服务器会主动推送多种类型的消息来更新前端状态。
    *   **`NEW_MESSAGE`**: 推送一条新的聊天消息。
    *   **`ORCHESTRATOR_DECISION`**: 推送协调器的决策过程。
    *   **`AGENT_STATUS_UPDATE`**: 更新某个Agent的状态（如 `Thinking...`, `Executing tool...`, `Idle`）。
    *   **`STATE_UPDATE`**: 推送群组整体状态的变更。
    *   **`STATE_SUMMARY_UPDATE`**: 推送由协调器生成的最新对话摘要。
    *   **`ERROR`**: 推送错误信息。

## 4. 核心工作流详解 (Detailed Workflow)

一个典型的交互循环如下：

1.  **消息进入**: 一条消息（来自用户或某个Agent）通过`send_message_to_group`方法进入系统。
2.  **持久化与广播**: 消息被`DatabaseManager`存入数据库，并立即通过WebSocket广播给所有监听该群组的客户端。
3.  **Orchestrator决策**: 消息被传递给`Orchestrator`。`Orchestrator`结合完整的对话历史和群组状态，构建一个复杂的提示词（Prompt），并通过其`decisionController`发送给高阶LLM，请求决策。
4.  **解析决策**: `Orchestrator`接收LLM返回的JSON决策，解析出`next_action` (如`SPEAK`) 和`action_details` (如`next_speaker`和给他的`instruction`)。
5.  **Agent执行**: `GroupChatServer`根据决策，找到指定的`next_speaker`的`AgentController`，并调用其`decide()`方法，将`instruction`作为提示词传入。
6.  **Agent响应**: `AgentController`通过`VCPClient`请求LLM获取响应。
7.  **形成闭环**: Agent的响应作为一条新消息，再次进入步骤1，开始新的循环。

### 工具调用流程

1.  **Agent请求工具**: 当一个Agent的响应中包含VCP工具调用语法 (`<<<[TOOL_REQUEST]>>>...`) 时，`GroupChatServer`会截获此消息。
2.  **转发至主服务器**: `GroupChatServer`不会自己执行工具，而是通过`VCPClient`将这个原始的工具调用字符串，作为一个特殊的LLM请求发送回**主VCP服务器**。
3.  **主服务器执行**: 主VCP服务器的`PluginManager`接收到请求，解析并执行相应的工具插件。
4.  **结果返回**: 工具执行结果返回给`GroupChatServer`。
5.  **结果注入对话**: `GroupChatServer`将工具结果格式化为一条系统消息，再次调用`send_message_to_group`方法，将其注入到对话历史中，通知所有成员工具调用的结果，并触发`Orchestrator`进行下一步决策。

## 5. 与 AgentAssistant 插件的对比 (Comparison with AgentAssistant)

为了更好地理解 `GroupChatManager` 的独特价值，可以将其与项目中的另一个核心插件 `AgentAssistant` 进行对比。两者都处理“多Agent”的概念，但其哲学和实现方式截然不同。

| 特性 (Feature) | GroupChatManager | AgentAssistant |
| :--- | :--- | :--- |
| **插件类型** | `service` (长期运行的独立微服务) | `synchronous` (按需调用的同步脚本) |
| **核心架构** | **微服务架构** (多模块解耦, Express.js, WebSocket) | **单一脚本** (Monolithic Script) |
| **状态管理** | **持久化与有状态** (使用SQLite数据库存储所有历史和状态) | **临时性与无状态** (使用内存Map存储临时对话历史) |
| **交互模型** | **真实群聊 (多对多)**: Agent在共享环境中互相交流 | **助理模式 (一对一)**: 主AI与隔离的专家Agent对话 |
| **协调机制** | **显式编排**: 专用的`Orchestrator` (协调器) 智能地指导对话流程 | **无编排**: 简单的请求-响应，依赖主AI进行决策 |
| **实时性** | **高**: 通过WebSocket支持实时观察与交互 | **低**: 纯粹的同步请求-响应循环 |
| **扩展性** | **高**: 通过可插拔的“协作模式”(`modes`)轻松扩展行为 | **低**: 扩展需要修改核心脚本 |
| **核心用例** | 模拟复杂的**多Agent协同任务**，如开发团队、辩论会 | 提供对一组**专家Agent**的便捷调用接口 |

**总结**:

*   **`AgentAssistant`** 是一个**工具集调用器**。它提供了一个简单的接口，让主AI可以方便地调用不同领域的“专家”来获取信息或完成单一任务。它本身不创造“协作”。
*   **`GroupChatManager`** 是一个**协作环境模拟器**。它创造了一个持久化、有状态的“沙盒”，让多个Agent可以在其中通过对话和工具使用，真正地“协作”起来解决一个宏大而复杂的目标。它的核心是“过程”和“涌现的智能”，而不仅仅是“结果”。

因此，`GroupChatManager` 是对VCP“群体智能”理念的深度实践，而`AgentAssistant`则是对VCP“工具化”和“任务委托”理念的直接体现。

## 5. 数据库结构 (Database Schema)

由`DatabaseManager.js`管理，包含三张核心表：

*   **`groups`**: 存储群组的基本信息。
    *   `id` (TEXT, PK): 群组唯一ID。
    *   `name` (TEXT): 群组名称。
    *   `members` (TEXT): 成员列表 (JSON字符串)。
    *   `roles` (TEXT): 成员角色映射 (JSON字符串)。
    *   `goal` (TEXT): 群组目标。
    *   `mode` (TEXT): 协作模式。
    *   `created_at` (TEXT): 创建时间。

*   **`chat_history`**: 存储所有聊天记录。
    *   `id` (TEXT, PK): 消息唯一ID。
    *   `group_id` (TEXT, FK): 所属群组ID。
    *   `from_agent` (TEXT): 发送方Agent名称。
    *   `content` (TEXT): 消息内容。
    *   `to_agent` (TEXT): 接收方Agent名称 (如果是私聊)。
    *   `is_tool_response` (INTEGER): 是否为工具响应消息。
    *   `timestamp` (TEXT): 消息时间戳。

*   **`tasks`**: 存储与群组关联的任务。
    *   `id` (TEXT, PK): 任务唯一ID。
    *   `group_id` (TEXT, FK): 所属群组ID。
    *   `description` (TEXT): 任务描述。
    *   `status` (TEXT): 任务状态 (e.g., 'open', 'in_progress', 'completed')。
    *   `result` (TEXT): 任务结果。
    *   `created_at` (TEXT): 创建时间。

## 6. 如何使用与扩展 (Usage and Extension)

### 使用

1.  **启动**: 插件随主VCP服务器启动而自动运行。
2.  **交互**: 主要通过HTTP API和WebSocket与插件交互。推荐使用如VCPChat这样的配套前端。
3.  **创建群组**: 通过`POST /api/groups`创建一个群组，定义成员、目标和协作模式。
4.  **启动会话**: 通过`POST /api/groups/:groupId/start_session`激活群组。
5.  **发送消息**: 通过WebSocket连接到群组频道，发送第一条消息（例如，来自`Human_Observer`的初始指令），即可启动整个协同工作流。

### 扩展

该插件最强大的地方在于其可扩展性。要自定义或增强其功能，可以：

*   **创建新的协作模式**: 在`Plugin/GroupChatManager/modes/`目录下，创建一个新的`.js`文件，导出一个包含`name`和`getPrompt`方法的对象。`getPrompt`函数负责根据群组状态和最新消息，生成给`Orchestrator`的决策提示词。这是改变群聊行为模式最直接、最强大的方式。

```javascript
// a new mode example: ./modes/CodeReviewMode.js
module.exports = {
    name: 'CodeReview',
    getPrompt: (groupState, latestMessage) => {
        // ... logic to generate a prompt that guides agents to perform a code review
        const history = groupState.chat_history.slice(-10).map(m => `@${m.from}: ${m.content}`).join('\n');
        return `
        # Role: Code Review Orchestrator
        You are orchestrating a code review session.
        Goal: ${groupState.goal}
        Members: ${groupState.members.join(', ')}
        History:
        ${history}
        
        Based on the last message from @${latestMessage.from}, decide who should speak next to move the code review forward.
        Your output must be a single JSON object.
        ...
        `;
    }
};
```

通过这种方式，您可以轻松地为`GroupChatManager`添加无限的可能性。
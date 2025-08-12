### 前端集成“应急停止”功能开发手册

这份手册将指导您如何在前端应用中集成由后端提供的AI请求中断功能。

#### 核心流程

1.  **发起请求时**：为每一次聊天生成一个唯一的ID，并将其以 `messageId` 或 `requestId` 的字段名包含在发送到 `/v1/chat/completions` 的请求体中。
2.  **中断请求时**：当用户点击“停止”按钮时，获取当前正在进行的聊天的唯一ID，并用它来请求 `/v1/interrupt` 接口。

> **兼容性说明**: 后端服务器同时支持 `messageId` 和 `requestId` 两个字段名。本手册统一使用 `messageId` 作为示例，您可以根据您的项目习惯选择使用。

---

#### 步骤 1: 发起聊天请求

在向后端发起聊天或AI工具调用请求时，您需要在请求体中加入 `messageId` 字段。

**1.1 生成唯一ID**

在发送请求前，先为这次会话生成一个全局唯一的ID。在现代浏览器中，推荐使用 `crypto.randomUUID()`。

```javascript
const messageId = crypto.randomUUID(); // 例如: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

**1.2 保存当前ID**

您需要将这个 `messageId` 保存到您的应用状态管理中（如 React state, Vuex, Pinia, 或一个全局变量），以便在用户点击“停止”按钮时能够访问到它。

```javascript
// 伪代码
let currentMessageId = null;

function handleSendMessage() {
    currentMessageId = crypto.randomUUID();
    // ...接下来的请求逻辑
}
```

**1.3 发送请求**

使用 `fetch` 或其他HTTP客户端向 `/v1/chat/completions` 发送请求，确保请求体中包含 `messageId`。

```javascript
const messageId = crypto.randomUUID();
// 保存 messageId 到你的应用状态
setCurrentActiveMessageId(messageId); 

fetch('http://your-server-address/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer YOUR_SERVER_KEY' 
    },
    body: JSON.stringify({
        model: "your-model-name",
        messages: [
            { role: "user", content: "你好" }
        ],
        stream: true,
        messageId: messageId // <--- 在这里包含ID (也可以使用 "requestId": messageId)
    })
})
.then(response => {
    // ...处理响应流
})
.catch(error => {
    console.error('请求出错:', error);
})
.finally(() => {
    // 请求结束后，清空当前活动的ID
    setCurrentActiveMessageId(null);
});
```

---

#### 步骤 2: 实现中断功能

**2.1 创建“停止”按钮**

在您的UI中，当AI正在响应时，显示一个“停止生成”或类似的按钮。

**2.2 绑定点击事件**

为该按钮添加一个点击事件处理器。当用户点击时，该处理器会调用中断函数。

```javascript
// 伪代码
function handleStopButtonClick() {
    const idToStop = getCurrentActiveMessageId(); // 从你的应用状态中获取ID
    if (idToStop) {
        interruptRequest(idToStop);
    }
}
```

**2.3 发送中断请求**

中断函数会向 `/v1/interrupt` 端点发送一个 `POST` 请求。

```javascript
async function interruptRequest(messageId) {
    try {
        const response = await fetch('http://your-server-address/v1/interrupt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer YOUR_SERVER_KEY'
            },
            body: JSON.stringify({
                messageId: messageId // <--- 使用需要中断的ID (也可以使用 "requestId": messageId)
            })
        });

        const result = await response.json();
        console.log('中断指令发送结果:', result.message); // "Interrupt signal sent for request..."

        if (!response.ok) {
            // 可以根据需要处理中断指令发送失败的情况
            console.error('发送中断指令失败:', result);
        }
    } catch (error) {
        console.error('发送中断请求时出错:', error);
    }
}
```

**重要提示**：由于后端已经做了优雅处理，前端在收到中断信号后，正在进行的流式请求会像正常结束一样关闭，不会抛出网络错误。您不需要在前端为此添加特殊的错误处理逻辑。
jev调用文档-莱恩-1789900041864
**Jev**（TypeSafe AI 于 2026 年 9 月 15 日发布）并不是传统的图像识别模型，而是一种全新的 **System One 模型**，专门做**快速、结构化的决策**（不生成文本）。官方目前明确**不支持图像/音频/视频输入**（只接受文本或结构化 state），但未来有图像模型方向的暗示，社区也已出现 Jev-like 视觉实验项目。

### 报价（官方定价）
- **输入**：每百万 tokens **$0.042**（即每十亿 tokens $42）
- **输出**：免费（“太便宜无需计量”）
- 上下文：约 32k–64k tokens（state + 问题）
- 速率限制（动态）：约 25 万 tokens/秒、1200 请求/分钟（企业可申请更高）
- 当前处于 **early access**（需 waitlist），也有第三方网关（如 Vercel AI Gateway、Cloudflare、AIMLAPI 等）可间接调用，价格接近官方。

实际成本极低：很多工作流单次决策约 $0.0001–$0.0004，大批量分类任务可比普通 LLM 便宜 40–400 倍。

### 工作原理
Jev 不是传统 LLM（不逐 token 自回归生成文字），核心设计是：

1. **输入**：一段 **state**（文本、JSON 对象或数组）+ 一组**类型化问题**。
2. **问题类型（三个原语）**：
   - **Choice**：从预定义选项中选一个（最多约 255 个），返回选择 + 各选项概率 + 置信度。
   - **Score**：按有序等级打分（如冷静→愤怒），返回分数 + 分布 + 置信度。
   - **Noul**：判断某陈述是否为真，返回 0–1 概率。
3. **处理**：用新架构 + **并行采样器**，一次性对所有问题并行评估（共享 state 上下文，不互相影响），直接从 logits 打分候选输出，**不生成任何自由文本**。
4. **训练方法**：**RLCD**（Reinforcement Learning for Calibrated Decisions，校准决策强化学习）。目标是让输出的概率与真实正确率对齐（校准），而不是像 RLHF 那样优化“人类喜欢听什么”。
5. **输出**：严格类型安全（schema 保证，数学上不可能类型错误或幻觉式自由文本），附带校准后的概率和置信度。响应时间通常 **70–500 ms**。

简单说：把“判断”变成软件里可直接调用的原语（像超级智能的 if 语句），代码负责组合和阈值决策。

### 哪里可以用
- **官方**：https://typesafe.ai （join waitlist → 拿到 API key 后用 `POST https://api.typesafe.ai/v1/systemone`，模型名 `jev-latest` 或 `jev-1.13.0`）。有官方 Python / JS SDK。
- **第三方已接入**：Vercel AI Gateway、Cloudflare Workers AI、AIMLAPI 等（模型 ID 类似 `typesafe/jev`）。
- **典型场景**（文本决策为主）：
  - 客服工单路由 / 紧急度判断 / 情绪打分
  - 发票审核、内容审核、安全事件分类
  - Agent 中的快速决策节点（浏览器自动化、游戏控制等，如 Doom 演示、航班搜索 agent）
  - 大规模分类（百万级文档成本极低）
  - 任何需要“快速、便宜、有置信度的结构化判断”的地方
- **视觉相关**：官方尚未支持。社区有 jev-visual、jevlike 等项目，用开源多模态模型（如 Qwen、Gemma）模拟 Jev 风格的图像问答 / 选项打分，可在 Apple Silicon 等本地跑。官方 CEO 曾非正式提到未来图像模型方向。

**总结**：Jev 是目前最快最便宜的“决策专用模型”，适合嵌在软件流水线里做大量结构化判断，而不是聊天或图像识别。如果你真正需要图像输入，目前只能用社区适配方案，或等 TypeSafe 后续 multimodal 版本。更多细节可看官方博客 https://typesafe.ai/blog/introducing-system-one-models-and-jev 和文档 https://docs.typesafe.ai。
---
下面是 **传统 JavaScript（纯 JS，无框架）** 的详细调用文档，覆盖官方 TypeSafe 和 OpenRouter 两种方式。

---

## 1. 基础信息

| 项目 | 官方 TypeSafe | OpenRouter |
|------|---------------|------------|
| **Endpoint** | `POST https://api.typesafe.ai/v1/systemone` | `POST https://openrouter.ai/api/alpha/decisions` |
| **Model** | `"jev-latest"` 或 `"jev-1.13.0"` | `"~typesafe/jev-latest"` |
| **Auth** | `Authorization: Bearer <TYPESAFE_API_KEY>` | `Authorization: Bearer <OPENROUTER_API_KEY>` |
| **Content-Type** | `application/json` | `application/json` |

---

## 2. 请求结构（通用）

```js
{
  "model": "jev-latest",          // 或 "~typesafe/jev-latest"（OpenRouter）
  "state": "任意文本 或 对象 或 数组",
  "questions": {
    "任意自定义key": {
      "type": "noul" | "choice" | "score",
      "instructions": "问题描述",
      "criteria": ...               // 根据 type 不同
    }
  }
}
```

### 三种问题类型

#### ① Noul（是/否概率，0~1）
```js
{
  "type": "noul",
  "instructions": "Does this convey urgency?",
  "criteria": {                    // 可选
    "true": "Explicitly time-sensitive",
    "false": "No urgency expressed"
  }
}
```

#### ② Choice（从选项中选一个）
```js
{
  "type": "choice",
  "instructions": "Which team should handle this?",
  "criteria": {
    "billing": "Payments, invoicing, refunds",
    "technical": "Bugs, outages, integrations",
    "sales": "Pricing, upgrades, new accounts"
  }
}
```

#### ③ Score（按有序等级打分）
```js
{
  "type": "score",
  "instructions": "How frustrated is the customer?",
  "criteria": ["Calm", "Frustrated", "Very angry"]   // 至少 2 个等级
}
```

---

## 3. 响应结构

```js
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": {
      "type": "noul",
      "noul": 0.95                 // 0~1
    },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {
        "billing": 0.87,
        "technical": 0.13,
        "sales": 0
      },
      "confidence": 0.8
    },
    "frustration": {
      "type": "score",
      "score": 1.04,               // 加权分数，可落在等级之间
      "legend": {
        "0": "Calm",
        "1": "Frustrated",
        "2": "Very angry"
      },
      "probabilities": {
        "0": 0,
        "1": 0.96,
        "2": 0.04
      },
      "confidence": 0.94
    }
  },
  "usage": {
    "input_tokens": 426,
    "output_tokens": 73
  }
}
```

---

## 4. 完整可运行示例（传统 JS）

### 方式一：官方 TypeSafe（推荐，延迟最低）

```js
async function callJevOfficial(state, questions) {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TYPESAFE_API_KEY}`,  // 或直接写 key
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'jev-latest',
      state: state,
      questions: questions
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HTTP ${response.status}: ${err}`);
  }

  return await response.json();
}

// 使用示例
(async () => {
  const result = await callJevOfficial(
    "Help! My payouts have been failing for 3 days. I'm losing sales. Please help ASAP.",
    {
      is_urgent: {
        type: 'noul',
        instructions: 'Does this convey urgency?',
        criteria: {
          true: 'Explicitly time-sensitive',
          false: 'No urgency expressed'
        }
      },
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
          billing: 'Payments, invoicing, refunds',
          technical: 'Bugs, outages, integrations',
          sales: 'Pricing, upgrades, new accounts'
        }
      },
      frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Frustrated', 'Very angry']
      }
    }
  );

  console.log('紧急度概率:', result.answers.is_urgent.noul);
  console.log('部门:', result.answers.department.choice);
  console.log('部门概率:', result.answers.department.probabilities);
  console.log('愤怒分数:', result.answers.frustration.score);
  console.log('Token 用量:', result.usage);
})();
```

### 方式二：OpenRouter（你账号里已有）

```js
async function callJevOpenRouter(state, questions) {
  const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // 可选：让你的应用出现在 OpenRouter 排行榜
      'HTTP-Referer': 'https://your-site.com',
      'X-OpenRouter-Title': 'My App Name'
    },
    body: JSON.stringify({
      model: '~typesafe/jev-latest',
      state: state,
      questions: questions
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HTTP ${response.status}: ${err}`);
  }

  return await response.json();
}

// 使用示例（和上面完全一样，只是换函数）
(async () => {
  const result = await callJevOpenRouter(
    "Help! My payouts have been failing for 3 days.",
    {
      is_urgent: {
        type: 'noul',
        instructions: 'Does this convey urgency?'
      },
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
          billing: 'Payments, invoicing, refunds',
          technical: 'Bugs, outages, integrations',
          sales: 'Pricing, upgrades, new accounts'
        }
      }
    }
  );

  console.log(result.answers);
})();
```

---

## 5. 实用封装（推荐日常使用）

```js
/**
 * 通用 Jev 调用函数
 * @param {string|object|array} state
 * @param {object} questions
 * @param {object} options  { provider: 'typesafe' | 'openrouter', apiKey, model }
 */
async function jev(state, questions, options = {}) {
  const {
    provider = 'openrouter',           // 默认用 OpenRouter（你已有）
    apiKey = provider === 'typesafe' 
      ? process.env.TYPESAFE_API_KEY 
      : process.env.OPENROUTER_API_KEY,
    model = provider === 'typesafe' ? 'jev-latest' : '~typesafe/jev-latest'
  } = options;

  const url = provider === 'typesafe'
    ? 'https://api.typesafe.ai/v1/systemone'
    : 'https://openrouter.ai/api/alpha/decisions';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, state, questions })
  });

  if (!res.ok) {
    throw new Error(`Jev error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}
```

---

## 6. 常见错误码

| 状态码 | 含义 | 处理建议 |
|--------|------|----------|
| 401 | API Key 无效或缺失 | 检查 Authorization header |
| 422 | 请求体验证失败（缺字段、criteria 格式错等） | 检查 questions 结构 |
| 429 | 速率限制 | 指数退避重试 |
| 529 | 服务过载 | 稍后重试 |

---

## 7. 注意事项

1. **state** 可以是字符串、对象或数组，对象更利于复杂场景（推荐）。
2. 一次请求可混合多个 Noul / Choice / Score，它们会并行评估。
3. Choice 选项建议控制在 100 以内（官方上限约 255）。
4. Score 至少需要 2 个等级。
5. 浏览器端请务必把 API Key 放在后端代理，不要直接暴露。
6. 输入的问题不可以超过32k，算上选项，总输入不可以超过64k，否则会报错。

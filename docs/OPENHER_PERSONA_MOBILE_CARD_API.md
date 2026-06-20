# OpenHerPersona 移动端关键心境小卡片 API 适配说明

## 目标

在移动端触摸或长按 Agent 头像时，弹出轻量关键心境小卡片，展示 OpenHerPersona 当前的复合心境摘要。

新版 OpenHerPersona 已从旧的“三情绪桶标签”升级为：

- 原型共振池
- Agent 动态 baseline
- 性别轴体八轴二极结构
- 驱力/对冲轴
- 三轴表达系统

因此移动端小卡片建议优先使用后端已经生成好的 `state.mood.expression`，而不是在移动端重新拼接旧式描述。

推荐展示示例：

```text
纯异步观察 · 欲冷相持 / 性欲上扬·冷漠对冲 / 冲突与防御女性极
小吉
当前情绪底色为欲冷相持，驱动层表现为性欲上扬·冷漠对冲，其中性欲受到对冲压力0.08，性别轴体以冲突与防御为最清晰表达，整体呈女性极。
正性 40% · 负性 33% · 唤醒 34%
```

## 现有后端 API

当前可直接使用 [`GET /admin_api/openher-persona/status`](../routes/admin/openHerPersona.js:48)。

后端聚合逻辑在 [`routes/admin/openHerPersona.js`](../routes/admin/openHerPersona.js:48)，会返回：

| 字段 | 用途 |
| --- | --- |
| `status` | 请求状态 |
| `plugin` | 插件名 |
| `overview` | 插件总览 |
| `agents` | Agent 状态数组 |

每个 `agents[]` 条目结构由 [`OpenHerPersonaAdminAgent`](../AdminPanel-Vue/src/api/openHerPersona.ts:217) 表示，核心字段是：

| 字段 | 用途 |
| --- | --- |
| `summary.agentKey` | Agent 唯一键 |
| `summary.agentLabel` | Agent 显示名 |
| `summary.observationCount` | 观测次数 |
| `summary.lastObservedAt` | 最近观测时间 |
| `status.state` | 该 Agent 的完整轴体状态 |
| `status.queue` | 该 Agent 的异步观测队列状态 |

## 当前状态结构重点

完整状态由 [`OpenHerPersonaState`](../AdminPanel-Vue/src/api/openHerPersona.ts:167) 表示。

新版核心字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `state.gender` | [`OpenHerPersonaAxisLayer`](../AdminPanel-Vue/src/api/openHerPersona.ts:21) | 性别轴体八轴二极结构 |
| `state.cognitive` | [`OpenHerPersonaAxisLayer`](../AdminPanel-Vue/src/api/openHerPersona.ts:21) | 知性轴 |
| `state.affective` | [`OpenHerPersonaAxisLayer`](../AdminPanel-Vue/src/api/openHerPersona.ts:21) | 感性轴 |
| `state.drive` | [`OpenHerPersonaAxisLayer`](../AdminPanel-Vue/src/api/openHerPersona.ts:21) | 驱力轴与对冲轴 |
| `state.baseline` | [`OpenHerPersonaBaseline`](../AdminPanel-Vue/src/api/openHerPersona.ts:144) | Agent 动态常态 |
| `state.coupling.lastCounterbalance` | [`OpenHerPersonaDriveCounterbalance`](../AdminPanel-Vue/src/api/openHerPersona.ts:126) | 最近对冲压力 |
| `state.mood` | [`OpenHerPersonaMood`](../AdminPanel-Vue/src/api/openHerPersona.ts:108) | 心境与表达系统 |

## 移动端是否需要新 API

### 推荐方案：先不新增 API

移动端可以复用 [`openHerPersonaApi.getStatus()`](../AdminPanel-Vue/src/api/openHerPersona.ts:261)，在前端本地从 `agents[]` 中按 `agentKey` 找到目标 Agent，然后组装小卡片。

适合场景：

| 场景 | 是否推荐 |
| --- | --- |
| 管理面板移动端适配 | 推荐 |
| VChat 内已能访问管理 API | 推荐 |
| Agent 数量不多 | 推荐 |
| 需要一次加载多个 Agent 心境预览 | 推荐 |

### 可选方案：新增轻量单 Agent API

如果 VChat 或移动端只想在触摸头像时请求单个 Agent，可后续新增：

```text
GET /admin_api/openher-persona/:agentKey/card
```

这个接口可以在 [`routes/admin/openHerPersona.js`](../routes/admin/openHerPersona.js:154) 附近新增，内部调用插件 `status` 命令并返回小卡片 ViewModel。

适合场景：

| 场景 | 是否推荐 |
| --- | --- |
| Agent 数量很多 | 推荐 |
| 移动端网络弱 | 推荐 |
| 只想懒加载当前头像卡片 | 推荐 |
| 不希望暴露完整轴体细节 | 推荐 |

## 推荐移动端 ViewModel

移动端卡片建议使用以下 ViewModel：

| 字段 | 来源 | 示例 |
| --- | --- | --- |
| `agentKey` | `summary.agentKey` | `xiaoji` |
| `agentLabel` | `state.agentLabel` 或 `summary.agentLabel` | `小吉` |
| `modeLabel` | 固定文案或 `status.mode` | `纯异步观察` |
| `moodLabel` | `state.mood.expression.shortLabel` 优先，回落到 `state.mood.label` | `欲冷相持 / 性欲上扬·冷漠对冲 / 冲突与防御女性极` |
| `description` | `state.mood.expression.sentence` 优先 | `当前情绪底色为...` |
| `positive` | `state.mood.positive` | `0.4` |
| `negative` | `state.mood.negative` | `0.33` |
| `arousal` | `state.mood.arousal` | `0.34` |
| `primaryArchetype` | `state.mood.archetypes.primary.label` | `欲冷相持` |
| `topArchetypes` | `state.mood.archetypes.candidates` | `["欲冷相持", "欲念焦灼"]` |
| `genderLabel` | `state.mood.expression.gender.label` | `冲突与防御女性极` |
| `driveLabel` | `state.mood.expression.drive.label` | `性欲上扬·冷漠对冲` |
| `counterPressure` | `state.mood.expression.drive.counterPressure` | `{ label: "性欲", pressure: 0.08 }` |
| `color` | 根据 `state.mood` 计算 | `hsl(...)` |

相关类型：

- [`OpenHerPersonaState`](../AdminPanel-Vue/src/api/openHerPersona.ts:167)
- [`OpenHerPersonaMood`](../AdminPanel-Vue/src/api/openHerPersona.ts:108)
- [`OpenHerPersonaExpression`](../AdminPanel-Vue/src/api/openHerPersona.ts:99)
- [`OpenHerPersonaMoodArchetypes`](../AdminPanel-Vue/src/api/openHerPersona.ts:38)
- [`OpenHerPersonaAxisLayer`](../AdminPanel-Vue/src/api/openHerPersona.ts:21)
- [`OpenHerPersonaAxisState`](../AdminPanel-Vue/src/api/openHerPersona.ts:14)

## 当前 Vue 面板已有可复用逻辑

[`AgentEmotionManager.vue`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:83) 中已经有完整卡片区域，可拆分为移动端复用组件。

可复用字段：

| UI 内容 | 当前来源 |
| --- | --- |
| `纯异步观察 · ${shortLabel}` | [`expressionShortLabel`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:572) |
| Agent 名称 | [`state.agentLabel`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:90) |
| 心境描述 | [`moodDescription`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:605) |
| 正性 | [`state.mood.positive`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:98) |
| 负性 | [`state.mood.negative`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:99) |
| 唤醒 | [`state.mood.arousal`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:100) |
| 心境颜色 | [`moodColor()`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:824) |
| 原型候选 | [`archetypeItems`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:574) |
| 对冲压力 | [`strongestCounterPressure`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:582) |
| baseline 相对变化 | [`formatBaselineDelta()`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:810) |

建议把这些逻辑抽成一个组件，例如：

- `OpenHerPersonaMiniCard.vue`
- 输入：`agent`
- 输出：仅渲染关键心境小卡片

## 推荐前端组装流程

1. 移动端头像触摸事件触发。
2. 根据当前聊天对象拿到 `agentKey` 或 `agentLabel`。
3. 调用 [`openHerPersonaApi.getStatus()`](../AdminPanel-Vue/src/api/openHerPersona.ts:261)。
4. 在返回的 `agents[]` 中匹配 `summary.agentKey === agentKey`。
5. 读取 `agent.status.state`。
6. 优先读取 `state.mood.expression.shortLabel` 作为标题。
7. 优先读取 `state.mood.expression.sentence` 作为描述。
8. 展示 `state.mood.positive`、`state.mood.negative`、`state.mood.arousal`。
9. 可选展示 `state.mood.archetypes.candidates.slice(0, 3)`。
10. 可选展示 `state.mood.expression.drive.counterPressure`。
11. 再次触摸头像或点击外部区域关闭卡片。

## 推荐交互策略

| 交互 | 建议 |
| --- | --- |
| `touchstart` | 不立即弹出，避免误触 |
| `longpress 350ms` | 推荐触发小卡片 |
| `tap` | 可用于快速打开/关闭 |
| `touchmove` | 如果移动超过阈值则取消 |
| `outside click` | 关闭卡片 |
| `Escape` | 桌面端关闭 |
| `auto close` | 8 到 12 秒后自动关闭 |

## 缓存策略

建议移动端做短缓存，避免频繁请求：

| 项 | 建议值 |
| --- | --- |
| 缓存键 | `agentKey` |
| TTL | 15 到 30 秒 |
| 失效条件 | 手动刷新、切换 Agent、收到新对话回合 |
| 加载状态 | 显示骨架卡片 |
| 失败状态 | 显示“暂无观测状态” |

## 如果新增轻量后端 API

可新增接口：

```text
GET /admin_api/openher-persona/:agentKey/card
```

建议返回：

| 字段 | 类型 |
| --- | --- |
| `status` | `success` 或 `error` |
| `agentKey` | 字符串 |
| `agentLabel` | 字符串 |
| `modeLabel` | 字符串 |
| `moodLabel` | 字符串 |
| `description` | 字符串 |
| `positive` | 数字 |
| `negative` | 数字 |
| `arousal` | 数字 |
| `primaryArchetype` | 字符串或空 |
| `topArchetypes` | 字符串数组 |
| `driveLabel` | 字符串或空 |
| `genderLabel` | 字符串或空 |
| `counterPressure` | 对象或空 |
| `updatedAt` | 字符串或空 |
| `lastObservedAt` | 字符串或空 |

优点：

- 移动端无需理解完整轴体结构。
- 可以隐藏二级残差、队列、数据库路径等管理面板专用信息。
- 更适合公开给聊天客户端。

缺点：

- 会增加一层后端维护逻辑。
- 前端管理面板与移动端会有两套数据组装路径。

## 最小改动建议

如果只是要在现有 AdminPanel 移动端中触摸 Agent 头像显示关键卡片，最小改动是：

1. 保持 [`routes/admin/openHerPersona.js`](../routes/admin/openHerPersona.js:48) 不变。
2. 保持 [`openHerPersonaApi.getStatus()`](../AdminPanel-Vue/src/api/openHerPersona.ts:261) 不变。
3. 从 [`AgentEmotionManager.vue`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:83) 抽出迷你卡片组件。
4. 在 Agent 列表头像处绑定长按或点击事件。
5. 将当前 `agent.status.state` 传给迷你卡片组件。
6. 使用 [`expressionShortLabel`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:572)、[`moodDescription`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:605)、[`moodColor()`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:824)。

## 结论

当前不需要立刻改后端 API。移动端关键心境小卡片可以直接基于 [`GET /admin_api/openher-persona/status`](../routes/admin/openHerPersona.js:48) 适配。

但文档必须以新版字段为准：

- 标题优先用 `state.mood.expression.shortLabel`
- 描述优先用 `state.mood.expression.sentence`
- 原型标签来自 `state.mood.archetypes`
- 驱力/对冲来自 `state.mood.expression.drive` 与 `state.coupling.lastCounterbalance`
- 性别轴体来自 `state.gender` 与 `state.mood.expression.gender`
- baseline 相对常态来自 `state.baseline` 与 `state.mood.archetypes.relative`

只有在移动端客户端需要低流量、按头像懒加载、隐藏完整管理数据时，才建议新增 `GET /admin_api/openher-persona/:agentKey/card` 轻量接口。

## 附录：其他可选参数的获取方式

移动端关键小卡片可以只展示核心心境，也可以扩展展示“最近二级残差”“轴体详情”“观测快照”“队列状态”等信息。以下参数都可以从现有 [`GET /admin_api/openher-persona/status`](../routes/admin/openHerPersona.js:48) 返回结构中获取，不一定需要新增接口。

### 1. 最近二级残差

最近二级残差来自每个轴的 `subAxes` 字段。

数据来源：

| 参数 | 路径 |
| --- | --- |
| 性别轴二级残差 | `agent.status.state.gender[axis].subAxes` |
| 知性轴二级残差 | `agent.status.state.cognitive[axis].subAxes` |
| 感性轴二级残差 | `agent.status.state.affective[axis].subAxes` |
| 驱力轴二级残差 | `agent.status.state.drive[axis].subAxes` |

相关类型：

- [`OpenHerPersonaAxisState.subAxes`](../AdminPanel-Vue/src/api/openHerPersona.ts:18)
- [`OpenHerPersonaAxisSubScore`](../AdminPanel-Vue/src/api/openHerPersona.ts:9)

单个二级残差项通常包含：

| 字段 | 含义 |
| --- | --- |
| `similarity` | 当前输入向量与该二级锚点的余弦相似度 |
| `weight` | softmax 后的残差权重 |

当前 Vue 面板中，“最近二级残差”的组装逻辑位于 [`subAxisItems`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:589)。

移动端推荐只取前 3 到 5 个，避免头像弹窗过大。

### 2. 轴体详情

完整轴体分为四组：

| 组 | 路径 | 示例 |
| --- | --- | --- |
| 性别轴 | `state.gender` | 存在与秩序、冲突与防御、创伤与疗愈 |
| 知性轴 | `state.cognitive` | 求知、分辨、拒绝 |
| 感性轴 | `state.affective` | 正性、负性、唤醒 |
| 驱力轴 | `state.drive` | 好奇、恐惧、性欲、享乐、冷漠、自大、麻木、自虐 |

每个轴的结构：

| 字段 | 含义 |
| --- | --- |
| `value` | 当前长期/平滑后的轴体值 |
| `activation` | 最近一次观测激活值 |
| `sharpness` | 二级残差分布锐度 |
| `subAxes` | 二级残差分布 |

相关类型是 [`OpenHerPersonaAxisState`](../AdminPanel-Vue/src/api/openHerPersona.ts:14)。

### 3. 心境数值

心境数值来自 `state.mood`。

| 参数 | 路径 | 用途 |
| --- | --- | --- |
| 心境标签 | `state.mood.label` | 兼容标题 |
| 复合标题 | `state.mood.expression.shortLabel` | 推荐标题 |
| 复合描述 | `state.mood.expression.sentence` | 推荐描述 |
| 正性 | `state.mood.positive` | 正面情绪强度 |
| 负性 | `state.mood.negative` | 负面情绪强度 |
| 唤醒 | `state.mood.arousal` | 激活/警觉程度 |
| 张力 | `state.mood.tension` | 正负并存程度 |
| 优势差 | `state.mood.dominance` | 正负差值，不建议直接展示给普通用户 |

相关类型是 [`OpenHerPersonaMood`](../AdminPanel-Vue/src/api/openHerPersona.ts:108)。

移动端关键小卡推荐固定展示：

```text
正性 40%
负性 33%
唤醒 34%
```

### 4. 性别轴体

性别轴体来自：

```text
state.gender
```

其中复合摘要优先来自：

```text
state.mood.expression.gender
```

相关字段定义在 [`OpenHerPersonaState.gender`](../AdminPanel-Vue/src/api/openHerPersona.ts:171)。

移动端可选展示：

```text
性别轴体：冲突与防御女性极
```

如果是头像弹出小卡，不建议展示所有八轴，推荐只展示 `state.mood.expression.gender.label`。

### 5. 动态 baseline

动态 baseline 来自：

```text
state.baseline
```

相关类型是 [`OpenHerPersonaBaseline`](../AdminPanel-Vue/src/api/openHerPersona.ts:144)。

移动端通常不需要直接展示 baseline 数字，但可以展示相对变化：

```text
性欲 ↑8% vs 常态
冷漠 ↑5% vs 常态
```

管理面板中的相对常态逻辑位于 [`formatBaselineDelta()`](../AdminPanel-Vue/src/views/AgentEmotionManager.vue:810)。

### 6. 对冲压力

对冲压力来自：

```text
state.coupling.lastCounterbalance
```

也可以优先使用：

```text
state.mood.expression.drive.counterPressure
```

相关类型是 [`OpenHerPersonaDriveCounterbalance`](../AdminPanel-Vue/src/api/openHerPersona.ts:126)。

移动端建议只展示最高一项：

```text
性欲受到冷漠/自虐对冲
```

如果做调试模式，可以展示完整 `details`。

### 7. 最近观测快照

最近观测快照来自：

```text
state.lastObservation
```

相关类型是 [`OpenHerPersonaLastObservation`](../AdminPanel-Vue/src/api/openHerPersona.ts:149)。

字段说明：

| 字段 | 路径 | 用途 |
| --- | --- | --- |
| 观测时间 | `state.lastObservation.at` | 显示最近更新时间 |
| 输入指纹 | `state.lastObservation.inputHash` | 调试用，不建议普通移动端显示 |
| 原始分数 | `state.lastObservation.scores` | 调试/高级图表 |
| 耦合后数值 | `state.lastObservation.coupled` | 调试/高级图表 |
| 快照心境 | `state.lastObservation.mood` | 可与当前 `state.mood` 对照 |

移动端建议只使用：

```ts
const lastObservedAt = state.lastObservation?.at || state.lastObservedAt;
```

### 8. 队列状态

队列状态来自：

```text
agent.status.queue
```

相关类型在 [`OpenHerPersonaPluginStatus.queue`](../AdminPanel-Vue/src/api/openHerPersona.ts:206)。

字段说明：

| 字段 | 含义 |
| --- | --- |
| `running` | 是否正在处理该 Agent 的观测任务 |
| `pending` | 等待处理的任务数量 |
| `maxSize` | 队列上限 |

移动端可用于显示一个小状态点：

| 状态 | UI 建议 |
| --- | --- |
| `running === true` | 小蓝点或“观测中” |
| `pending > 0` | 小黄点或“排队中” |
| 空闲 | 不显示，或灰点 |

不建议在头像卡片中显示完整队列数字，除非用于调试模式。

### 9. 推荐移动端扩展小卡结构

如果要展示核心心境 + 原型 + 对冲 + 最近二级残差，推荐 ViewModel：

```ts
interface OpenHerPersonaMobileCardView {
  agentKey: string;
  agentLabel: string;
  modeLabel: string;
  moodLabel: string;
  description: string;
  positive: number;
  negative: number;
  arousal: number;
  primaryArchetype?: string;
  topArchetypes?: Array<{
    label: string;
    score: number;
  }>;
  driveLabel?: string;
  genderLabel?: string;
  counterPressure?: {
    axis: string;
    label: string;
    pressure: number;
  } | null;
  residuals?: Array<{
    axis: string;
    axisLabel: string;
    subAxis: string;
    subAxisLabel: string;
    weight: number;
    similarity: number;
  }>;
  observationCount: number;
  lastObservedAt: string | null;
  queue?: {
    running: boolean;
    pending: number;
  };
}
```

推荐渲染顺序：

1. 第一行：`纯异步观察 · ${moodLabel}`
2. 第二行：`${agentLabel}`
3. 第三行：`description`
4. 第四行：正性 / 负性 / 唤醒
5. 可选：原型共振 Top 3
6. 可选：对冲压力
7. 折叠区或二级区域：最近二级残差 Top 3

### 10. 是否应该把这些参数做成后端轻量接口

如果移动端只在管理面板内使用，建议前端直接组装。

如果 VChat、OpenWebUI 脚本、外部客户端都要用，建议后续新增：

```text
GET /admin_api/openher-persona/:agentKey/card?includeResiduals=1
```

建议参数：

| Query | 含义 |
| --- | --- |
| `includeResiduals=1` | 返回最近二级残差 |
| `residualLimit=5` | 限制残差数量 |
| `includeQueue=1` | 返回队列状态 |
| `includeDebug=1` | 返回 inputHash、scores、coupled、baseline 等调试字段 |

这样可以让普通移动端只拿轻量卡片，高级面板再按需拿完整细节。
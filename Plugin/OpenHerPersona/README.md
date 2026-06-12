# OpenHerPersona

OpenHerPersona 是一个 VCP 原生桥接插件，用轻量方式吸收
[OpenHer](https://github.com/kellyvv/OpenHer) 中关于人格状态的部分思路，而不移植
OpenHer 的运行时。

## 范围

- 为每个 Agent 保留轻量级本地状态：驱力、挫折度、信号、气质、信号偏置、最后活动时间、冷却时间以及审计历史。
- 提供直接命令：`status`、`tick`、`reset`、`explain`。
- 启用后，通过 `processMessages` 添加一段简短的 `persona_state_hint`。
- 支持仅观察统计模式（`OpenHerPersonaObserveOnly=true`）：会更新每个 Agent 的状态，但会剥离/跳过提示词注入。
- 使用 VCP 原生插件生命周期和直接协议。

## 算法（v0.3）

- **稳态驱力** —— 剥夺感（沉默、约束、单调）会根据剩余余量放大某项驱力的
  挫折度；交互本身则会以乘法方式缓解挫折。驱力围绕平衡点呼吸式波动，而不是
  直接饱和到上限。
- **逐 Agent 气质** —— 基因组网络权重与持久化的特质偏移向量都会以 Agent Key
  为种子生成，因此不同 Agent 会把同一种处境映射为真正不同的行为信号。差异幅度可通过
  `OpenHerPersonaTemperamentSpread` 调整。
- **带缓慢可塑性的代谢体质** —— 每个 Agent 还会获得基于种子的各驱力增长/缓解倍率（±18%）：
  同样的忽视会让某个 Agent 更快受伤，而另一个 Agent 保持克制。痛苦级别的
  `persona_delta` 事件会让受影响的驱力轻微敏化（major ≈ +1.2%），安抚事件会让后续缓解更容易；
  每个真实回合都会把体质弹性地拉回其种子原点，因此变化真实存在，但速度很慢。
- **情绪相位跃迁** —— 压力电荷会从持续热度、安全感受挫、约束与痛苦级别 delta 中累积，
  并由亲昵安抚释放。跨过阈值后，Agent 会经历
  `strained → eruption → cooling → grounded`：爆发只持续一个回合（反抗与直接度飙升、温暖度崩塌、
  表达变得短促而强烈，并且 hint 会说明她是真的在爆发），随后 cooling 会让她保持低落与防御，
  直到经过两个回合、45 分钟过去，或真诚的亲昵提前结束该阶段。爆发遵守
  `OpenHerPersonaEruptionCooldownMinutes`（默认 90）冷却时间；整个状态机可通过
  `OpenHerPersonaPhaseEnabled=false` 禁用。
- **情绪惯性** —— 信号会用 EMA 追逐计算出的目标值；响应速度随情绪温度上升而提高，因此情绪会平滑变化，
  而不是突兀跳变。
- **持久自我塑形** —— 模型回填的 `signal_delta` 会折叠进缓慢、有界的 `signalBias`，
  该偏置会在后续代谢回合中保留，并温和衰减。
- **通过影响等级实现情绪能动性** —— `persona_delta` 回填接受一个 `impact` 字段
  （默认 `minor` / `moderate` / `major`），用于声明情绪事件造成的冲击强度。等级会缩放每回合边界
  （驱力 ±0.8/±1.5/±3，信号 ±0.18/±0.35/±0.6）以及 `signalBias` 折叠速率；
  `major` 还允许 `frustration_set` 绝对值、要求提供 `reason`，并遵守 30 分钟冷却
  （滥用会降级为 `moderate`）。这使伤害性或狂喜时刻能够在一个回合内推动状态变化，
  无需额外工具调用往返。
- **聊天气泡式表达** —— 当表达引擎处于健谈或情绪充盈状态（玩闹/温暖信号、亲昵上下文或任何活跃相位），
  且内容不是技术性/深度长文时，hint 会要求模型把单次回复拆分为短 IM 风格消息，并用 `brk`
  HTML 注释标记分隔，按语义拆分（少量字符也可以单独成为一个气泡）。VCPChat 会在流式输出时实时拆分为独立气泡。
  该 hint 仅在请求可被明确证明来自 VCPChat（`vcpchatExtensions` 载荷，或类似 VCPChat/VChat 的
  OneRing 客户端标签）时发出——未知客户端永远不会收到这些标记。
  `OpenHerPersonaBurstMode` 可选择 auto（情绪门控）/ always / off。一次生成，零额外模型调用。
- **HTML 表达 hint** —— 在同样的 VCPChat 专属门控下，hint 还会告诉模型：在表达性时刻可以使用轻量级
  行内样式 HTML 片段（小卡片、强调色、简单布局），也可放在气泡内；禁止 script 标签和外部资源，
  技术性回答保持纯文本。可通过 `OpenHerPersonaHtmlHintEnabled` 开关控制。
- **心境读数** —— 从信号与驱力热度推导出的 valence/arousal（效价/唤醒度）会作为“心境底色”注入 hint，
  用于稳定语气选择。
- **语义上下文感知** —— 当注入了 RAGDiaryPlugin 的 ContextBridge 时，插件会复用其清洗器、精确/模糊嵌入缓存
  以及 `embedText` 管线，为用户回合生成向量；否则回退到宿主嵌入 API
  （`API_URL`/`API_Key` + `WhitelistEmbeddingModel`）。每个新的用户回合都会根据相对余弦显著性，
  与各特征的锚点短语进行评分，然后与关键词启发式结果混合
  （`OpenHerPersonaSemanticWeight`，默认 0.5）。锚点向量只嵌入一次，并缓存到
  `state/semantic-anchor-cache.json`，缓存键由 `EmbeddingModelSig` 和 provider 标签组成。
  任何失败或超时都会静默回退到纯启发式逻辑。

## 边界

- 不提供 FastAPI 服务器。
- 不引入 EverMemOS、Chroma 或新的向量数据库。
- 不提供 OpenHer provider 层或独立模型密钥路由。
- 不引入 OpenHer SkillEngine；VCP 工具与 SkillBridge 仍是标准能力来源。
- 不主动发送消息；`tick` 只返回带 `would_send: false` 的审计结果。
- 不写入长期记忆；未来的结晶化输出也只能生成 `DailyNote` 或 `VCPMemory` 候选项。

## 命令

```text
OpenHerPersona status
OpenHerPersona tick
OpenHerPersona reset
OpenHerPersona explain

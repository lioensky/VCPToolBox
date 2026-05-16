export type ParamTone = "stable" | "sensitive" | "critical";

export interface ParamMeta {
  label: string;
  summary: string;
  logic?: string;
  range?: string;
  tone?: ParamTone;
  tupleLabels?: readonly string[];
}

export interface GroupMeta {
  title: string;
  description: string;
  icon: string;
  accent: string;
  badge: string;
}

export const WORMHOLE_PRIMARY_KEYS = [
  "tensionThreshold",
  "baseMomentum",
  "baseDecay",
  "wormholeDecay",
] as const;

export type WormholePrimaryKey = (typeof WORMHOLE_PRIMARY_KEYS)[number];

export type WormholeRoutingPanelId = "trigger" | "spread" | "decay";

export interface WormholeRoutingPanel {
  id: WormholeRoutingPanelId;
  title: string;
  summary: string;
  icon: string;
  keys: readonly string[];
}

export const WORMHOLE_ROUTING_PANELS: readonly WormholeRoutingPanel[] = [
  {
    id: "trigger",
    title: "触发与点火",
    summary: "决定什么时候跨域跳转，以及首次跳跃时带着多少动量起步。",
    icon: "bolt",
    keys: ["tensionThreshold", "firingThreshold", "baseMomentum"],
  },
  {
    id: "spread",
    title: "扩散边界",
    summary: "限制跳几层、扩多宽、以及允许多少新节点重新回流主召回链路。",
    icon: "hub",
    keys: ["maxSafeHops", "maxEmergentNodes", "maxNeighborsPerNode"],
  },
  {
    id: "decay",
    title: "衰减与稳定",
    summary: "控制常规传播与虫洞传播的能量保留，决定探索能走多远也决定噪声会不会放大。",
    icon: "vital_signs",
    keys: ["baseDecay", "wormholeDecay"],
  },
] as const;

const DEFAULT_GROUP_META: GroupMeta = {
  title: "未命名参数组",
  description: "该参数组暂时没有补充说明。",
  icon: "tune",
  accent: "oklch(0.78 0.15 230 / 0.5)",
  badge: "待整理",
};

const DEFAULT_PARAM_META: ParamMeta = {
  label: "未命名参数",
  summary: "该参数暂时没有补充说明。",
  tone: "stable",
};

export const GROUP_ORDER = ["ContextFoldingV2", "RAGDiaryPlugin", "KnowledgeBaseManager"] as const;

export const GROUP_METADATA: Record<string, GroupMeta> = {
  ContextFoldingV2: {
    title: "上下文折叠层",
    description: "负责根据语义相似度和逻辑聚焦度自动折叠远距离 AI 输出，控制上下文窗口大小。",
    icon: "unfold_less",
    accent: "oklch(0.74 0.16 305 / 0.55)",
    badge: "上下文控制",
  },
  RAGDiaryPlugin: {
    title: "感知与裁剪层",
    description: "负责标签感知、时间衰减与主检索权重，是浪潮 RAG 的第一道调制面。",
    icon: "flare",
    accent: "oklch(0.78 0.15 230 / 0.55)",
    badge: "输入前置",
  },
  KnowledgeBaseManager: {
    title: "增强与路由层",
    description: "负责残差激活、语言补偿、去重和虫洞传播，决定系统是稳还是敢跳。",
    icon: "hub",
    accent: "oklch(0.82 0.16 85 / 0.55)",
    badge: "检索后段",
  },
};

export const PARAM_METADATA: Record<string, Record<string, ParamMeta>> = {
  ContextFoldingV2: {
    thresholdBase: {
      label: "折叠阈值基准",
      summary: "上下文语义折叠V2的相似度判定基准线。相似度低于此值的远距离AI输出会被折叠为摘要。",
      logic: "调高（如0.60）：更激进地折叠，只有高度相关的内容保留原文；调低（如0.40）：更保守，大部分内容保留原文。",
      range: "建议区间: 0.35 ~ 0.65",
      tone: "sensitive",
    },
    thresholdRange: {
      label: "折叠阈值动态范围",
      summary: "阈值受逻辑深度(L)和语义宽度(S)调节后的上下限范围。",
      logic: "下限越低越保守（语义宽泛时保留更多）；上限越高越激进（逻辑聚焦时折叠更多）。",
      range: "建议区间: [0.30, 0.70]",
      tone: "sensitive",
      tupleLabels: ["下限", "上限"],
    },
    lWeight: {
      label: "逻辑深度(L)系数",
      summary: "逻辑深度对阈值的调节力度。L高表示对话逻辑聚焦，阈值会升高以更激进地折叠无关内容。",
      logic: "调高：L对阈值的影响更大，聚焦对话时折叠更激进；调低：L影响减弱，对话焦点变化不会显著改变折叠行为。",
      range: "建议区间: 0.02 ~ 0.15",
      tone: "sensitive",
    },
    sWeight: {
      label: "语义宽度(S)系数",
      summary: "语义宽度对阈值的调节力度。S高表示对话语义宽泛，阈值会降低以保守保留更多上下文。",
      logic: "调高：S对阈值的影响更大，宽泛对话时折叠更保守；调低：S影响减弱，语义宽度变化不会显著改变折叠行为。",
      range: "建议区间: 0.02 ~ 0.15",
      tone: "sensitive",
    },
  },
  RAGDiaryPlugin: {
    noise_penalty: {
      label: "语义宽度惩罚",
      summary: "抑制对话发散时的标签误触发，避免噪音上下文把检索带偏。",
      logic: "调高后更保守，调低后更愿意从散乱上下文里寻找关联。",
      range: "建议 0.01 ~ 0.20",
      tone: "sensitive",
    },
    tagWeightRange: {
      label: "标签权重映射区间",
      summary: "决定标签得分在最终检索向量里最多能占到多少比重。",
      logic: "上限越高，结果越容易被标签牵引；下限越高，弱标签也更容易留下来。",
      range: "建议下限 0.01 ~ 0.10；上限 0.30 ~ 0.60",
      tone: "sensitive",
      tupleLabels: ["最小权重", "最大权重"],
    },
    tagTruncationBase: {
      label: "标签截断基准",
      summary: "定义默认保留多少比例的高分标签，控制召回的精简程度。",
      logic: "值越高越保留长尾标签，值越低越只保留核心标签。",
      range: "建议 0.40 ~ 0.80",
      tone: "stable",
    },
    tagTruncationRange: {
      label: "标签截断动态范围",
      summary: "给截断比例一个可上下摆动的活动区间，允许系统按语义强度自适应收放。",
      logic: "区间越宽，系统越愿意根据上下文自动放宽或收紧标签数量。",
      range: "建议下限 0.50；上限 0.90",
      tone: "stable",
      tupleLabels: ["下限", "上限"],
    },
    timeDecay: {
      label: "时间衰减回退",
      summary: "给旧记忆设置统一衰减策略，避免久远内容长期占优。",
      logic: "通常作为局部时间规则失效时的全局兜底。",
      range: "半衰期建议 15 ~ 90 天；最低分建议不低于 0.50",
      tone: "sensitive",
    },
    "timeDecay.halfLifeDays": {
      label: "半衰期天数",
      summary: "记忆分数衰减到一半所需的天数。",
      range: "建议 15 ~ 90 天",
      tone: "stable",
    },
    "timeDecay.minScore": {
      label: "最低保留阈值",
      summary: "衰减后的结果低于这个分数就会被过滤，用来清理过旧且相关度不足的记忆。",
      logic: "它不是给旧结果托底，而是在时间衰减和重排之后做一次保留阈值筛选。",
      range: "建议 0.50 ~ 0.80",
      tone: "stable",
    },
    mainSearchWeights: {
      label: "主检索权重分配",
      summary: "平衡用户当前输入和 AI 上下文意图在最终检索向量中的占比。",
      logic: "左侧更重当前问题，右侧更重模型对对话上下文的理解。",
      range: "常用组合 [0.7, 0.3] 或 [0.8, 0.2]",
      tone: "sensitive",
      tupleLabels: ["用户输入", "AI 意图"],
    },
    refreshWeights: {
      label: "流内刷新权重",
      summary: "控制工具刷新阶段里用户、AI 和工具结果三者的占比。",
      logic: "工具权重越高，刷新结果越贴近刚执行完的任务输出。",
      range: "常用组合 [0.5, 0.35, 0.15]",
      tone: "stable",
      tupleLabels: ["用户", "AI", "工具结果"],
    },
    metaThinkingWeights: {
      label: "元思考递归权重",
      summary: "平衡原始查询和上一轮推理结果，决定递归思考是稳还是深。",
      logic: "推理结果权重越高，递归越深，但语义漂移风险也越大。",
      range: "常用组合 [0.8, 0.2]",
      tone: "sensitive",
      tupleLabels: ["原始查询", "推理结果"],
    },
  },
  KnowledgeBaseManager: {
    geodesicRerank: {
      label: "测地线重排(V8)",
      summary: "复用 Spike 距离场对 KNN 候选做基于 Tag 地形的二次重排。通过 ::TagMemo+ 修饰符激活。",
      logic: "V8 核心引擎，让被语义山峰挡住的相关记忆通过 Tag 拓扑关联浮出。三层防御链保证最坏情况无改动。",
      range: "包含 2 个子参数，见下方详细说明。",
      tone: "critical",
    },
    "geodesicRerank.alpha": {
      label: "测地线混合权重 (α)",
      summary: "测地线分数在最终排序中的占比。0=纯KNN余弦距离，1=纯测地线Tag地形距离。",
      logic: "调高：更信任 Tag 拓扑关联，被语义山峰遮挡的记忆更容易浮出；调低：更保守，主要依赖原始向量相似度。",
      range: "建议区间: 0.1 ~ 0.5 (默认 0.3)",
      tone: "sensitive",
    },
    "geodesicRerank.minGeoSamples": {
      label: "最小采样密度门槛",
      summary: "一个 chunk 在距离场上至少需要命中多少个 Tag 才有资格参与测地线评估。低于此值退化为纯 KNN。",
      logic: "调高：更严格，只有 Tag 密度高的 chunk 才会被测地线影响；调低：更宽松，但可能因采样不足导致估计不可靠。莱恩建议 4 作为基准。",
      range: "建议区间: 2 ~ 8 (整数，默认 4)",
      tone: "sensitive",
    },
    orderedCooccurrence: {
      label: "有序双向势能流形 (V8.2)",
      summary: "TagMemo V8.2 核心：把共现拓扑、叙事方向、语义距离三轴解耦——形(双向) × 色(顺逆阻尼) × 质(向量距离)。",
      logic: "三层灰度叠加 (α 双向 → β 锚 boost → γ 语义增益)。每层都改完观察一周再叠下一层；共用矩阵重建锁，重建时自动串行。",
      range: "共 12 个子参数，优先关注 reverseGain、reverseAnchorBoost、semanticGainEnabled、reverseInversionGuard。",
      tone: "critical",
    },
    "orderedCooccurrence.forwardGain": {
      label: "顺流增益",
      summary: "叙事顺向边 A→B 的基础权重倍率。1.0 表示与原 V7 保持一致。",
      logic: "几乎不需要调整。除非主路径明显偏弱才考虑提升到 1.1~1.2。",
      range: "建议 0.8 ~ 1.2 (默认 1.0)",
      tone: "stable",
    },
    "orderedCooccurrence.reverseGain": {
      label: "逆流基础增益",
      summary: "回溯方向 B→A 的基础权重倍率。0.42 是经过审计的初始档位。",
      logic: "调高: 概念回溯通畅，但有同义词回卷风险；调低: 偏向 V7 单向行为，逆向联想被压制。",
      range: "建议 0.30 ~ 0.65 (默认 0.42)",
      tone: "critical",
    },
    "orderedCooccurrence.minReverseGain": {
      label: "逆流增益下限",
      summary: "动态调制后的逆流增益的安全下限。",
      logic: "保证锚 boost 与 semantic gain 调制后逆流不会跌破完全切断。",
      range: "建议 0.20 ~ 0.40 (默认 0.25)",
      tone: "stable",
    },
    "orderedCooccurrence.maxReverseGain": {
      label: "逆流增益上限",
      summary: "动态调制后的逆流增益的安全上限，配合反转守卫双重保险。",
      logic: "调高: 允许概念锚回溯更激进；调低: 严格保叙事方向偏置。",
      range: "建议 0.55 ~ 0.80 (默认 0.70)",
      tone: "sensitive",
    },
    "orderedCooccurrence.distanceDecay": {
      label: "序位距离衰减",
      summary: "Tag 在同一篇日记里序位相邻强、远距离弱。0 表示关闭距离衰减 (V8.2-α 默认)。",
      logic: "灰度上线建议先关 (0)，验证一周后再开到 0.05~0.12。开启后长日记的首尾标签共现权重会被压低。",
      range: "建议 0 / 0.05 ~ 0.20 (默认 0)",
      tone: "sensitive",
    },
    "orderedCooccurrence.reverseAnchorBoost": {
      label: "概念锚逆流增强 (β 开关)",
      summary: "是否允许高内生残差的概念锚获得额外的逆流回溯权重。1=开启，0=关闭。",
      logic: "效果：哲学命题等概念锚 tag 容易从任何枝干被召回，但事件 tag 不会无故回卷。建议先观察 α 一周再开启。",
      range: "0 (关闭) / 1 (开启)，默认 1",
      tone: "sensitive",
    },
    "orderedCooccurrence.reverseAnchorMax": {
      label: "概念锚逆流最大倍率",
      summary: "概念锚 boost 的能量天花板。残差越大的锚 tag 逆流能力越强，但不超过此倍率。",
      logic: "调高: 概念锚回流更猛；调低: 锚效应温和。配合 maxReverseGain 双重夹逼。",
      range: "建议 1.2 ~ 2.0 (默认 1.5)",
      tone: "stable",
    },
    "orderedCooccurrence.semanticGainEnabled": {
      label: "语义增益开关 (γ 开关)",
      summary: "是否启用基于向量距离的钟形语义增益。1=开启，0=关闭。",
      logic: "开启后噪声边自然弱化，黄金区放大，同义词冗余被抑制。建议在 β 验证稳定后再开。",
      range: "0 (关闭) / 1 (开启)，默认 1",
      tone: "critical",
    },
    "orderedCooccurrence.semanticGainPeak": {
      label: "语义钟形峰值 (peak)",
      summary: "黄金联想区的余弦相似度位置。Gemini 模型分布右移，必要时调整。",
      logic: "OpenAI 系建议 0.55~0.65；Gemini-embedding-001 建议先扫真实分布再定。peak 越高越偏好概念邻接型。",
      range: "建议 0.50 ~ 0.75 (默认 0.65)",
      tone: "critical",
    },
    "orderedCooccurrence.semanticGainSigma": {
      label: "语义钟形宽度 (σ)",
      summary: "钟形函数的标准差，决定峰值附近的宽度。",
      logic: "调大: 黄金区平台更宽，更宽容；调小: 峰值更尖锐，仅最近邻获得最高增益。",
      range: "建议 0.15 ~ 0.35 (默认 0.25)",
      tone: "sensitive",
    },
    "orderedCooccurrence.semanticGainLowSimFallback": {
      label: "未命中 sim 兜底值",
      summary: "持久化 sim 表里查不到的 pair 默认相似度。0.1 比噪声阈值 0.05 略高。",
      logic: "刻意区别于 0：保留弱共现，避免与‘低于阈值被丢’语义混淆。",
      range: "建议 0.05 ~ 0.20 (默认 0.10)",
      tone: "stable",
    },
    "orderedCooccurrence.reverseInversionGuard": {
      label: "反转守卫上限",
      summary: "逆流权重相对顺流权重的最大占比。0.95 表示逆流永远不超过顺流 95%。",
      logic: "保 V8.2 叙事方向公理不被锚 boost × 语义增益的乘积突破。极少需要调整。",
      range: "建议 0.85 ~ 0.99 (默认 0.95)",
      tone: "critical",
    },
    spikeRouting: {
      label: "虫洞脉冲路由",
      summary: "V7 的传播引擎，负责跳跃、衰减、扩散上限和新节点涌现。",
      logic: "这是最敏感的一组参数，建议一次只改一项并观察检索结果。",
      range: "共 8 个子参数，优先关注 tensionThreshold、baseMomentum 与两个 decay。",
      tone: "critical",
    },
    "spikeRouting.maxSafeHops": {
      label: "最高安全跳数",
      summary: "限制任意脉冲路径允许穿行的最大边数，避免图环回路无限扩散。",
      range: "建议 2 ~ 6",
      tone: "stable",
    },
    "spikeRouting.maxEmergentNodes": {
      label: "涌现节点上限",
      summary: "扩散结束后最多允许多少个新节点重新注入召回阶段。",
      range: "建议 10 ~ 100",
      tone: "sensitive",
    },
    "spikeRouting.maxNeighborsPerNode": {
      label: "单节点最大邻居数",
      summary: "每个节点放电时最多向多少个相邻节点传播，决定扩散宽度。",
      range: "建议 10 ~ 40",
      tone: "sensitive",
    },
    "spikeRouting.baseMomentum": {
      label: "初始动量 (TTL)",
      summary: "种子标签启动时拥有的初始动量，类似传播剩余生命值。",
      range: "建议 1.0 ~ 5.0",
      tone: "critical",
    },
    "spikeRouting.tensionThreshold": {
      label: "虫洞触发张力",
      summary: "张力达到多高才允许触发跨域虫洞跳跃。",
      logic: "这是全组最危险参数之一：过高几乎不跳，过低则到处穿洞。",
      range: "建议 0.50 ~ 3.00",
      tone: "critical",
    },
    "spikeRouting.firingThreshold": {
      label: "底层放电阈值",
      summary: "节点向下传播所需的最低内部能量，用来清理弱信号尾流。",
      range: "建议 0.05 ~ 0.20",
      tone: "stable",
    },
    "spikeRouting.baseDecay": {
      label: "常规区衰减",
      summary: "在同质稠密区域内传播时的能量保留比例。",
      logic: "值越低衰减越快，用来压制同类簇里的回声放大。",
      range: "建议 0.10 ~ 0.40",
      tone: "critical",
    },
    "spikeRouting.wormholeDecay": {
      label: "虫洞区衰减",
      summary: "穿透语义屏障后的能量保留比例，决定探索路径能走多远。",
      logic: "通常应明显高于 baseDecay，才能体现跨域探索的优势。",
      range: "建议 0.60 ~ 0.90",
      tone: "critical",
    },
    activationMultiplier: {
      label: "金字塔激活倍率区间",
      summary: "定义 TagMemo 激活系数的倍率区间，用于把金字塔特征映射到最终增强强度。",
      logic: "系统会根据覆盖率、相干性和噪音信号在两个边界之间插值；左侧是最低倍率，右侧是最高倍率。",
      range: "建议最小值 0.20 ~ 0.80；最大值 1.0 ~ 2.5",
      tone: "sensitive",
      tupleLabels: ["最小值", "最大值"],
    },
    dynamicBoostRange: {
      label: "动态增强修正",
      summary: "根据 EPA 或共振分析结果对标签增强做二次修正。",
      logic: "上限越高，强逻辑场景越容易冲破天花板；下限越低，混乱场景越会压掉增强。",
      range: "建议下限 0.10 ~ 0.50；上限 1.50 ~ 3.00",
      tone: "sensitive",
      tupleLabels: ["下限", "上限"],
    },
    coreBoostRange: {
      label: "核心标签聚光灯",
      summary: "给用户手动指定的 coreTags 额外特权，强行提升其存在感。",
      logic: "值越高越像显式强推，值越低则更接近轻提示。",
      range: "建议 0.10 ~ 2.00",
      tone: "sensitive",
      tupleLabels: ["最小增益", "最大增益"],
    },
    deduplicationThreshold: {
      label: "语义去重阈值",
      summary: "两个标签相似到什么程度就合并，避免标签云过度拥挤。",
      logic: "高值保留细微差别，低值则更激进地合并近义标签。",
      range: "建议 0.80 ~ 0.95",
      tone: "stable",
    },
    techTagThreshold: {
      label: "技术标签门槛",
      summary: "技术样式词进入 matchedTags 列表时所需的相对权重，主要影响非技术语境下的技术词暴露度。",
      logic: "调高后代码片段、文件名和术语更难出现在返回标签里；它不会直接改写已构建好的上下文向量，但会影响调试观测和部分依赖 matchedTags 的后续逻辑。",
      range: "建议 0.02 ~ 0.20",
      tone: "sensitive",
    },
    normalTagThreshold: {
      label: "普通标签门槛",
      summary: "普通标签进入 matchedTags 列表的相对门槛，用来控制返回标签信息的密度。",
      logic: "调高后返回标签更少更干净，调低后可见标签更多；它主要影响标签展示与统计，不直接决定向量融合。",
      range: "建议 0.01 ~ 0.05",
      tone: "stable",
    },
    languageCompensator: {
      label: "语言置信度补偿",
      summary: "在启用语言置信度门控后，对非技术语境中的技术型词汇施加惩罚，降低跨语境技术噪音。",
      logic: "值越小惩罚越重；主要命中非中文且带技术命名特征的词，Unknown 与跨领域语境分别使用不同罚值。",
      range: "默认常见值：未知语境 0.05，跨领域 0.10",
      tone: "sensitive",
    },
    "languageCompensator.penaltyUnknown": {
      label: "未知语境惩罚",
      summary: "语境无法识别时采用的兜底惩罚系数。",
      range: "建议 0.01 ~ 0.50",
      tone: "stable",
    },
    "languageCompensator.penaltyCrossDomain": {
      label: "跨领域惩罚",
      summary: "语境可识别但与标签领域冲突时使用的惩罚系数。",
      range: "建议 0.01 ~ 0.50",
      tone: "stable",
    },
  },
};

export function getGroupMeta(groupName: string): GroupMeta {
  return GROUP_METADATA[groupName] ?? {
    ...DEFAULT_GROUP_META,
    title: groupName,
  };
}

export function getParamMeta(groupName: string, paramKey: string): ParamMeta {
  return PARAM_METADATA[groupName]?.[paramKey] ?? {
    ...DEFAULT_PARAM_META,
    label: paramKey,
  };
}

export function getTupleLabel(meta: ParamMeta, index: number): string {
  return meta.tupleLabels?.[index] ?? `值 ${index + 1}`;
}

export function getToneLabel(tone: ParamTone | undefined): string {
  switch (tone) {
    case "critical":
      return "高风险";
    case "sensitive":
      return "高敏感";
    case "stable":
    default:
      return "稳态";
  }
}

export function getSubParamRange(subKey: string, subVal?: unknown): {
  min: number;
  max: number;
  step: number;
} {
  const key = subKey.toLowerCase();

  // Wormhole routing explicit ranges (must be checked before generic threshold rules).
  if (key === "tensionthreshold") {
    return { min: 0.5, max: 3, step: 0.01 };
  }

  if (key === "firingthreshold") {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key === "basemomentum") {
    return { min: 1, max: 10, step: 0.1 };
  }

  if (key === "basedecay" || key === "wormholedecay") {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key === "maxsafehops") {
    return { min: 1, max: 20, step: 1 };
  }

  if (key === "maxemergentnodes") {
    return { min: 1, max: 200, step: 1 };
  }

  if (key === "maxneighborspernode") {
    return { min: 1, max: 20, step: 1 };
  }

  // 🆕 V8: 测地线混合权重
  if (key === 'alpha') {
    return { min: 0, max: 1, step: 0.01 };
  }
  
  // 🆕 V8: 最小采样密度门槛
  if (key.includes('samples')) {
    return { min: 1, max: 20, step: 1 };
  }

  // 🆕 V8.2: 有序双向势能流形参数
  if (key === 'forwardgain' || key === 'reversegain'
      || key === 'minreversegain' || key === 'maxreversegain') {
    return { min: 0, max: 1.5, step: 0.01 };
  }
  if (key === 'distancedecay') {
    return { min: 0, max: 0.5, step: 0.01 };
  }
  if (key === 'reverseanchorboost' || key === 'semanticgainenabled') {
    return { min: 0, max: 1, step: 1 }; // toggle 用 0/1 表达
  }
  if (key === 'reverseanchormax') {
    return { min: 1, max: 3, step: 0.05 };
  }
  if (key === 'semanticgainpeak') {
    return { min: 0, max: 1, step: 0.01 };
  }
  if (key === 'semanticgainsigma') {
    return { min: 0.05, max: 0.6, step: 0.01 };
  }
  if (key === 'semanticgainlowsimfallback') {
    return { min: 0, max: 0.5, step: 0.01 };
  }
  if (key === 'reverseinversionguard') {
    return { min: 0.5, max: 1, step: 0.01 };
  }

  if (key.includes("days")) {
    return { min: 1, max: 365, step: 1 };
  }

  if (key.includes("threshold")) {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key.includes("hops") || key.includes("nodes") || key.includes("neighbors")) {
    return { min: 1, max: key.includes('nodes') ? 200 : 20, step: 1 };
  }

  if (key.includes("momentum")) {
    return { min: 1, max: 10, step: 0.1 };
  }

  // 🛠️ 修复：语言补偿器和时间衰减的浮点参数
  if (key.includes("penalty") || key.includes("score") || key.includes("min")) {
    return { min: 0, max: 1, step: 0.01 };
  }

  // 🛠️ 修复：兜底逻辑 - 如果值本身是浮点数，自动使用小数步长
  if (typeof subVal === 'number' && !Number.isInteger(subVal)) {
    return { min: 0, max: Math.max(10, Math.ceil(subVal * 20)), step: 0.01 };
  }

  return { min: 0, max: 100, step: 1 };
}

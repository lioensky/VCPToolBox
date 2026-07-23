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

export type GeodesicRerankPanelId = "prepare" | "field" | "evidence" | "reward" | "guard";

export interface GeodesicRerankPanel {
  id: GeodesicRerankPanelId;
  title: string;
  plainTitle: string;
  summary: string;
  metaphor: string;
  icon: string;
  keys: readonly string[];
}

export type OrderedCooccurrencePanelId = "topology" | "direction" | "semantic" | "guard";

export interface OrderedCooccurrencePanel {
  id: OrderedCooccurrencePanelId;
  title: string;
  axis: string;
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

export const GEODESIC_RERANK_PANELS: readonly GeodesicRerankPanel[] = [
  {
    id: "prepare",
    title: "候选准备",
    plainTitle: "先把可能的路找出来",
    summary: "决定向量召回先捞多大的候选池，以及一条候选 Tag 路需要多少证据才能建立稳定判断。",
    metaphor: "像规划导航前先多看几条备选路线：池子太小可能错过好路，太大则会增加计算量。",
    icon: "travel_explore",
    keys: ["candidateKMultiplier", "minGeoSamples", "candidatePositionDecay", "minClosureSimilarity"],
  },
  {
    id: "field",
    title: "连续势场采样",
    plainTitle: "把离散地标铺成一张地形图",
    summary: "控制查询场保留多少节点、语义接触多宽，以及候选 Tag 如何从附近场节点采样势能。",
    metaphor: "阈值决定地图上的灯能照多远；核指数决定灯光边缘是柔和扩散还是迅速变暗。",
    icon: "landscape",
    keys: [
      "maxFieldNodes", "fieldEnergyMassRatio", "fieldSimilarityThreshold",
      "weakContactThreshold", "strongContactThreshold", "maxFieldNeighbors",
      "fieldKernelExponent", "publicHubFloor",
    ],
  },
  {
    id: "evidence",
    title: "证据判级",
    plainTitle: "判断是亲眼看见、沿路推断，还是只像同一主题",
    summary: "把候选分为 direct、structural、thematic，并限制弱近义词升级为直接证据。",
    metaphor: "直接证据像门牌号一致；结构证据像沿着连续脚印找到；主题证据只是出现在同一片街区。",
    icon: "fact_check",
    keys: [
      "structuralContinuityMin", "thematicMinPotential", "thematicMaxIsolatedRatio",
      "sparseAssociationEnabled", "sparseAssociationMinContacts",
      "sparseAssociationMinConductance", "sparseAssociationMinSimilarity",
      "sparseAssociationMinPotential", "sparseAssociationMinClosure",
      "sparseAssociationPairSaturation", "sparseAssociationMaxRelief",
      "directSemanticMinPotential", "directSemanticSaturation",
      "directSemanticMinContacts", "directConfidenceFloor",
    ],
  },
  {
    id: "reward",
    title: "奖励授权",
    plainTitle: "证据够硬，才允许往前排",
    summary: "将绝对曲线分映射为正向奖励，并为三类证据设置逐级递减的排序权限。",
    metaphor: "不是发现关联就立刻加满分：先过奖励起点，再按证据等级领取不同额度的加分券。",
    icon: "workspace_premium",
    keys: [
      "alpha", "geoRewardFloor", "geoRewardSaturation",
      "directBonusCap", "structuralBonusCap", "thematicBonusCap",
    ],
  },
  {
    id: "guard",
    title: "安全回退",
    plainTitle: "地图不靠谱时，老老实实回到 KNN",
    summary: "联合检查查询场、候选覆盖、曲线强度和区分度；低可信时保持原始向量排序。",
    metaphor: "像导航发现 GPS 漂移：不凭一条异常信号强行改道，而是退回可靠的主干路线。",
    icon: "shield",
    keys: [
      "fallbackToKnnOnLowTrust", "minFieldTags", "minFieldEntropy",
      "minGeoCoverageRatio", "minMaxGeoScore", "minGeoScoreSpread", "minStrongEvidence",
    ],
  },
] as const;

export const ORDERED_COOCCURRENCE_PRIMARY_KEYS = [
  "reverseGain",
  "reverseAnchorBoost",
  "semanticGainEnabled",
  "reverseInversionGuard",
] as const;

export type OrderedCooccurrencePrimaryKey = (typeof ORDERED_COOCCURRENCE_PRIMARY_KEYS)[number];

export const ORDERED_COOCCURRENCE_PANELS: readonly OrderedCooccurrencePanel[] = [
  {
    id: "topology",
    title: "拓扑层：形",
    axis: "双向共现",
    summary: "决定标签是否互为邻接，以及序位距离如何压低远距离共现边。",
    icon: "account_tree",
    keys: ["forwardGain", "distanceDecay"],
  },
  {
    id: "direction",
    title: "方向层：色",
    axis: "顺逆流阻尼",
    summary: "控制叙事顺流与逆流回溯之间的能量差，避免 V7 的硬墙又保留方向偏置。",
    icon: "swap_calls",
    keys: ["reverseGain", "minReverseGain", "maxReverseGain", "reverseAnchorBoost", "reverseAnchorMax"],
  },
  {
    id: "semantic",
    title: "语义层：质",
    axis: "向量距离调制",
    summary: "用钟形语义增益放大概念邻接黄金区，同时压制噪声边与同义词回音壁。",
    icon: "scatter_plot",
    keys: ["semanticGainEnabled", "semanticGainPeak", "semanticGainSigma", "semanticGainLowSimFallback"],
  },
  {
    id: "guard",
    title: "工程守卫",
    axis: "叙事方向公理",
    summary: "确保逆流永远不会突破顺流上限，是 V8.2 灰度调参的最后保险。",
    icon: "security",
    keys: ["reverseInversionGuard"],
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
    fuzzyEmbedding: {
      label: "Embedding Fuzzy 复用",
      summary: "折叠链路与动态工具折叠用于复用近似相同上下文向量的高阈值模糊缓存策略，避免 AI 输出因微小文本差异重复向量化。",
      logic: "阈值越高越保守，只有几乎一致的长文本才复用；maxScan 越大越容易命中但会增加扫描成本。建议保持 0.985 附近。",
      range: "共 5 个子参数：threshold、minLength、maxScan、maxLengthDiffRatio、maxLengthDiffAbs。",
      tone: "sensitive",
    },
    "fuzzyEmbedding.threshold": {
      label: "Fuzzy 命中阈值",
      summary: "Dice bigram 文本相似度达到该阈值才复用已有 embedding。",
      logic: "调低会提升复用率但增加误复用风险；调高更安全但可能仍重复向量化。0.985 是保守默认值。",
      range: "建议 0.970 ~ 0.995",
      tone: "sensitive",
    },
    "fuzzyEmbedding.minLength": {
      label: "最小文本长度",
      summary: "低于该长度的文本不参与 fuzzy 复用，避免短文本相似度虚高。",
      logic: "短文本更容易偶然相似，因此应保留长度门槛；长对话建议 80 起步。",
      range: "建议 40 ~ 200 字符",
      tone: "stable",
    },
    "fuzzyEmbedding.maxScan": {
      label: "最大扫描缓存数",
      summary: "每次 fuzzy 查询最多扫描最近多少条 embedding 文本索引。",
      logic: "调高会提升旧缓存命中概率，但每次动态折叠扫描成本也会增加。",
      range: "建议 100 ~ 500",
      tone: "stable",
    },
    "fuzzyEmbedding.maxLengthDiffRatio": {
      label: "最大长度差比例",
      summary: "候选缓存文本与当前文本允许的最大相对长度差。",
      logic: "用于过滤长度明显不同的文本。调大更宽松，调小更严格。",
      range: "建议 0.01 ~ 0.05",
      tone: "sensitive",
    },
    "fuzzyEmbedding.maxLengthDiffAbs": {
      label: "最大绝对长度差",
      summary: "候选缓存文本与当前文本允许的最大绝对字符数差。",
      logic: "与比例门槛取较大值，避免长文本少量系统尾巴差异导致无法复用。",
      range: "建议 40 ~ 200 字符",
      tone: "stable",
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
    shotgunDecayFactor: {
      label: "霰弹历史衰减因子",
      summary: "控制 Tagmemo V4 Shotgun Query 中历史语义分段召回结果的分数保留比例。",
      logic: "值越高，历史主题段对最终候选的影响越强；值越低，检索越偏向当前输入。0.85 表示历史分段按距离进行温和指数衰减。",
      range: "建议 0.60 ~ 0.95，默认 0.85",
      tone: "sensitive",
    },
    shotgunHistorySegmentLimit: {
      label: "霰弹历史分段数",
      summary: "控制 Shotgun Query 最多取最近多少个历史语义分段参与并行检索。",
      logic: "调高会扩大上下文覆盖，但并行搜索次数和历史噪音也会上升；调低更聚焦当前问题。0 表示只使用当前查询向量。",
      range: "建议 0 ~ 5，默认 3",
      tone: "sensitive",
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
      label: "查询势场曲线重排 (V9.2)",
      summary: "让候选有序 Tag 曲线采样查询诱导连续势场，并将证据分为 direct、structural、thematic 三档，以不同奖励上限修正排序。通过 ::TagMemo+ 激活。",
      logic: "V9.2 保留候选扩池与连续场读出，但不再把批内冠军强制归一化为满分。曲线分按固定绝对区间映射，直接锚点、结构走廊和主题晕轮分别获得递减的排序权限。",
      range: "包含候选扩池、连续场核、绝对奖励标度、证据等级上限和联合可信守卫；建议先观察 A/B 表中的证据等级与实际奖励。",
      tone: "critical",
    },
    "geodesicRerank.alpha": {
      label: "测地线混合权重 (α)",
      summary: "测地线分数在最终排序中的占比。0=纯KNN余弦距离，1=纯测地线Tag地形距离。",
      logic: "调高：更信任 Tag 拓扑关联，被语义山峰遮挡的记忆更容易浮出；调低：更保守，主要依赖原始向量相似度。",
      range: "建议区间: 0.1 ~ 0.6；当前默认由 rag_params.json 中的 KnowledgeBaseManager.geodesicRerank.alpha 决定",
      tone: "sensitive",
    },
    "geodesicRerank.candidateKMultiplier": {
      label: "测地候选 K 倍率",
      summary: "仅在 TagMemo+ 开启时，将底层向量候选池扩展为最终请求 K 的指定倍数；曲线重排后仍只返回原始 K。",
      logic: "默认 2。调到 3 可让势场读出看到更多远端候选，但会线性增加候选 Tag 链加载和连续场采样成本。它扩大已有向量召回池，不等价于独立 Tag 倒排召回。",
      range: "建议 1 ~ 4，默认 2；1 表示不额外扩池",
      tone: "sensitive",
    },
    "geodesicRerank.minGeoSamples": {
      label: "证据饱和尺度",
      summary: "控制强接触证据达到满置信度所需的大致样本尺度，不再是低于该数量就清零的硬门槛。",
      logic: "调高会要求更多强接触才能达到满置信度；短 Tag 链仍可凭单个强锚点获得贡献。通常保持 4。",
      range: "建议区间: 2 ~ 8 (整数，默认 4)",
      tone: "sensitive",
    },
    "geodesicRerank.fallbackToKnnOnLowTrust": {
      label: "低可信地图回归 KNN",
      summary: "测地线地图可信度不足时是否直接回到原始 KNN 排序。1=开启，0=关闭。",
      logic: "建议保持开启。关闭后即使 Tag 能量场稀疏、候选采样不足或测地线分数缺乏区分度，也会继续尝试测地线融合，误伤风险更高。",
      range: "0 (关闭) / 1 (开启)，默认 1",
      tone: "critical",
    },
    "geodesicRerank.maxFieldNodes": {
      label: "连续场节点上限",
      summary: "一次查询最多保留多少个高能量场节点参与向量核插值，限制候选 Tag × 场节点 × 向量维度的计算量。",
      logic: "调高能保留更多长尾场结构，但连续场采样成本近似线性增加；调低更快，却可能截掉弱而有价值的远端节点。",
      range: "建议 24 ~ 96，默认 48",
      tone: "critical",
    },
    "geodesicRerank.fieldEnergyMassRatio": {
      label: "场能量质量覆盖率",
      summary: "按能量降序保留场节点，累计达到该比例后允许停止；同时受连续场节点上限约束。",
      logic: "0.95 表示尽量覆盖 95% 查询场能量。调低更快、更聚焦峰值；调高保留更多长尾结构。",
      range: "建议 0.85 ~ 0.99，默认 0.95",
      tone: "sensitive",
    },
    "geodesicRerank.fieldSimilarityThreshold": {
      label: "连续场语义接触阈值",
      summary: "候选 Tag 与场节点的余弦相似度达到该值后，才允许通过局部核插值获得非精确势能。",
      logic: "调低会扩大语义晕轮并增加误接触；调高更精确，但可能重新退化为近似离散 ID 命中。建议结合 geo_contact_tags 观察。",
      range: "建议 0.45 ~ 0.75，默认 0.50",
      tone: "critical",
    },
    "geodesicRerank.weakContactThreshold": {
      label: "弱势场接触阈值",
      summary: "采样势能达到该值时计为曲线接触，用于覆盖率、连续性和孤立点计算。",
      logic: "调低可减少 no candidate curve contacted 回退，但会引入更多弱背景接触；应低于强接触阈值。",
      range: "建议 0.02 ~ 0.10，默认 0.04",
      tone: "sensitive",
    },
    "geodesicRerank.strongContactThreshold": {
      label: "强势场接触阈值",
      summary: "达到该势能的 Tag 被视为强证据，参与证据置信度和联合低信任守卫。",
      logic: "调低更容易建立曲线置信度；调高只承认靠近场峰的接触。必须不低于弱接触阈值。",
      range: "建议 0.08 ~ 0.30，默认 0.14",
      tone: "sensitive",
    },
    "geodesicRerank.maxFieldNeighbors": {
      label: "单 Tag 场邻居上限",
      summary: "每个候选 Tag 最多聚合多少个局部高势能场邻居。",
      logic: "调高允许多节点共同形成连续势能，但也增加语义晕轮和排序成本；默认 4 较保守。",
      range: "建议 1 ~ 8，默认 4",
      tone: "stable",
    },
    "geodesicRerank.fieldKernelExponent": {
      label: "连续场核指数",
      summary: "控制相似度超过接触阈值后势能上升的陡峭程度。",
      logic: "指数越大，只有非常相近的邻居才能保留明显势能；指数越小，场扩散更平缓、更宽。",
      range: "建议 1 ~ 4，默认 2",
      tone: "sensitive",
    },
    "geodesicRerank.geoRewardFloor": {
      label: "曲线奖励起点",
      summary: "候选曲线分必须超过该绝对值，才开始获得排序奖励。",
      logic: "它是跨查询固定标尺，不依赖当前批次的最高分。调高会过滤弱场响应，调低会让微弱主题接触也获得少量奖励。",
      range: "建议 0.005 ~ 0.05，默认 0.015",
      tone: "critical",
    },
    "geodesicRerank.geoRewardSaturation": {
      label: "曲线奖励饱和点",
      summary: "曲线分达到该绝对值时，绝对强度映射视为饱和；最终仍受证据等级奖励上限约束。",
      logic: "调低会让中等曲线更快吃满等级预算；调高则要求更强的场响应。必须高于奖励起点。",
      range: "建议 0.10 ~ 0.50，默认 0.25",
      tone: "critical",
    },
    "geodesicRerank.directBonusCap": {
      label: "直接证据奖励上限",
      summary: "候选精确接触查询 seed/core 场节点时，最多可增加的绝对排序分。",
      logic: "直接事实背景拥有最高排序权限。调高会加强实体与核心锚点召回，但过高仍可能造成大幅跨位。",
      range: "建议 0.08 ~ 0.25，默认 0.18",
      tone: "critical",
    },
    "geodesicRerank.structuralBonusCap": {
      label: "结构证据奖励上限",
      summary: "传播节点精确接触或形成多点连续走廊时，最多可增加的绝对排序分。",
      logic: "用于叙事结构和关联链，默认应低于直接证据、明显高于纯主题晕轮。",
      range: "建议 0.04 ~ 0.16，默认 0.10",
      tone: "critical",
    },
    "geodesicRerank.thematicBonusCap": {
      label: "主题证据奖励上限",
      summary: "仅依赖连续核插值得到的泛主题共振，最多可增加的绝对排序分。",
      logic: "这是防止“有关联但不是直接背景”的候选越权冲顶的关键上限。建议保持明显低于结构证据。",
      range: "建议 0.01 ~ 0.06，默认 0.035",
      tone: "critical",
    },
    "geodesicRerank.structuralContinuityMin": {
      label: "结构走廊连续性门槛",
      summary: "没有精确命中时，多个强接触要达到该连续性才能升级为 structural 证据。",
      logic: "调高更严格，减少离散主题点伪装成结构；调低更容易承认松散叙事同构。",
      range: "建议 0.03 ~ 0.25，默认 0.08",
      tone: "sensitive",
    },
    "geodesicRerank.thematicMinPotential": {
      label: "主题奖励最低峰值",
      summary: "纯 thematic 候选的最大势能至少达到该值，才具备奖励资格。",
      logic: "低于门槛仍保留曲线诊断，但不改变 KNN 排序。",
      range: "建议 0.04 ~ 0.20，默认 0.08",
      tone: "sensitive",
    },
    "geodesicRerank.thematicMaxIsolatedRatio": {
      label: "主题奖励最大有效孤立率",
      summary: "纯 thematic 接触经过稀疏交叉联想证明修正后，有效孤立程度不得超过该比例，否则不给排序奖励。",
      logic: "调低要求更连续的主题走廊；调高允许更多离散主题接触参与排序。原始序列孤立率不会被抹除，最多按交叉联想置信度获得有限减免。",
      range: "建议 0.35 ~ 0.80，默认 0.65",
      tone: "sensitive",
    },
    "geodesicRerank.sparseAssociationEnabled": {
      label: "稀疏交叉联想证明",
      summary: "允许位置不相邻的高势能 Tag 在命中子图中证明彼此连贯，从而有限减免孤立率。关闭后完全沿用原始序列孤立判定。",
      logic: "建议开启。它不会直接取消孤立惩罚：候选必须同时通过非局部拓扑、Tag 语义、查询势能与正文闭合四重审查。",
      range: "布尔开关，默认开启",
      tone: "sensitive",
    },
    "geodesicRerank.sparseAssociationMinContacts": {
      label: "交叉联想最少孤立接触数",
      summary: "至少出现多少个位置孤立且可信的查询场接触，才启动命中子图联想证明。",
      logic: "默认 3 可阻止单个或一对偶然碰撞自行豁免。调高更保守，但可能漏掉较短的跨段联想链。",
      range: "建议 3 ~ 6 个，默认 3",
      tone: "critical",
    },
    "geodesicRerank.sparseAssociationMinConductance": {
      label: "非局部图导通门槛",
      summary: "两个孤立命中之间至少需要达到的单向或反向传播核导通强度。",
      logic: "调低会承认更多弱共现边，增加随机跳跃伪装风险；调高只接受图结构中更稳定的跨段联系。",
      range: "建议 0.005 ~ 0.08，默认 0.015",
      tone: "critical",
    },
    "geodesicRerank.sparseAssociationMinSimilarity": {
      label: "非局部语义相似门槛",
      summary: "两个位置孤立命中的 Tag 向量至少达到该余弦相似度，才可能构成交叉联想边。",
      logic: "它与图导通门槛必须同时通过。调低鼓励跨域联想，调高偏向同一概念簇；过高可能只剩近义词回音。",
      range: "建议 0.35 ~ 0.75，默认 0.48",
      tone: "critical",
    },
    "geodesicRerank.sparseAssociationMinPotential": {
      label: "联想节点最低势能",
      summary: "位置孤立的 Tag 至少采样到该查询势能，才允许进入交叉联想子图。",
      logic: "该值不会低于弱接触阈值。调高只让靠近查询场峰的节点参与证明，调低则更容易吸收主题晕轮。",
      range: "建议 0.05 ~ 0.20，默认 0.08",
      tone: "sensitive",
    },
    "geodesicRerank.sparseAssociationMinClosure": {
      label: "联想节点正文闭合门槛",
      summary: "孤立 Tag 与候选 Chunk 的闭合质量至少达到该值，避免贴错或过泛标签组成虚假联想链。",
      logic: "调高更相信正文内容而非文件标签表；调低对抽象标签更宽容，但误证明风险会上升。",
      range: "建议 0.10 ~ 0.45，默认 0.20",
      tone: "critical",
    },
    "geodesicRerank.sparseAssociationPairSaturation": {
      label: "可信联想边饱和数",
      summary: "命中子图中需要多少条通过四重审查的非局部边，联想边数量置信度才达到饱和。",
      logic: "默认 3。调高要求更完整的联想网络，调低则少数强边即可获得较明显的孤立率减免。",
      range: "建议 2 ~ 8 条，默认 3",
      tone: "sensitive",
    },
    "geodesicRerank.sparseAssociationMaxRelief": {
      label: "孤立率最大减免比例",
      summary: "即使命中子图证明完全可信，最多允许减免多少原始序列孤立率。",
      logic: "默认 0.55，意味着仍保留至少 45% 原始孤立惩罚。调高会增强跨段联想召回，但不建议超过 0.70。",
      range: "建议 0.25 ~ 0.70，默认 0.55；代码硬上限 0.80",
      tone: "critical",
    },
    "geodesicRerank.directSemanticMinPotential": {
      label: "语义直锚最低势能",
      summary: "非精确 Tag 若直接采样到查询 seed/core，势能达到该值后才计入语义直锚。",
      logic: "用于识别 GPT-5.6/Grok 4.5 等 ID 不同但实体语义直接对应的候选。该值同时不低于强接触阈值，避免弱主题近义词升级。",
      range: "建议 0.12 ~ 0.30，默认 0.16",
      tone: "critical",
    },
    "geodesicRerank.directSemanticSaturation": {
      label: "语义直锚饱和势能",
      summary: "多个语义直锚的平均势能达到该值时，直锚奖励强度视为饱和。",
      logic: "调低会让强实体近义锚更快获得完整直接证据预算；必须高于语义直锚最低势能。",
      range: "建议 0.25 ~ 0.60，默认 0.35",
      tone: "critical",
    },
    "geodesicRerank.directSemanticMinContacts": {
      label: "语义直锚最少接触数",
      summary: "至少需要多少个候选 Tag 高强度采样到查询 seed/core，才能从 thematic 升级为 direct。",
      logic: "默认 2，防止单个宽泛近义词越权。实体丰富的直接背景通常会同时命中多个查询锚点。",
      range: "建议 2 ~ 4，默认 2",
      tone: "critical",
    },
    "geodesicRerank.directConfidenceFloor": {
      label: "语义直锚置信度下限",
      summary: "通过多直锚判定后，排序奖励使用的最低置信度。",
      logic: "文件级 Tag 较多时 weighted coverage 会稀释直接实体证据；该下限避免多个强直锚仍因长 Tag 链而奖励过弱。",
      range: "建议 0.20 ~ 0.55，默认 0.35",
      tone: "sensitive",
    },
    "geodesicRerank.minFieldTags": {
      label: "地图最小激活 Tag 数",
      summary: "查询级 Tag 能量场至少需要激活多少个正能量 Tag，才认为这张语义地图具备基本可信度。",
      logic: "调高会更保守，低覆盖 query 更容易回归 KNN；调低会允许更稀疏的地图参与重排。",
      range: "建议 2 ~ 12，默认 4",
      tone: "sensitive",
    },
    "geodesicRerank.minFieldEntropy": {
      label: "地图最小熵",
      summary: "限制能量场不能过度集中在单个 Tag 上，避免单点幻觉把测地线重排带偏。",
      logic: "调高会要求 Tag 能量更分散、更像一张地图；调低会允许强单峰地图参与重排。若频繁回退可略降到 0.08。",
      range: "建议 0.05 ~ 0.30，默认 0.12",
      tone: "sensitive",
    },
    "geodesicRerank.minGeoCoverageRatio": {
      label: "联合守卫覆盖率阈值",
      summary: "有曲线贡献的候选比例低于此值时进入联合低信任检查，不再单独触发整批回退。",
      logic: "只有覆盖率低、最大曲线分低且强证据不足三者同时成立才回归 KNN。稀有但精准的窄场不会仅因覆盖低被拒绝。",
      range: "建议 0.02 ~ 0.20，默认 0.05",
      tone: "stable",
    },
    "geodesicRerank.minMaxGeoScore": {
      label: "曲线奖励可信基准",
      summary: "最高曲线分低于该值时会按比例收缩整批正向奖励，并参与联合低信任守卫。",
      logic: "它不再单独导致回退。用于防止极弱曲线分经过归一化后获得过大奖励，一般保持很小即可。",
      range: "建议 0.001 ~ 0.05，默认 0.01",
      tone: "stable",
    },
    "geodesicRerank.minGeoScoreSpread": {
      label: "联合守卫最小区分度",
      summary: "候选曲线分最大值与最小正值的差距；只在最大分和强证据也不足时参与回退。",
      logic: "平坦但强度充足的场不再因 spread 单条件被拒绝。调高会更保守，调低则允许细微排序信号。",
      range: "建议 0.005 ~ 0.10，默认 0.03",
      tone: "stable",
    },
    "geodesicRerank.candidatePositionDecay": {
      label: "候选序位衰减",
      summary: "候选文件中越靠后的 Tag，其候选质量会按指数逐步衰减。",
      logic: "通俗地说，它决定系统有多重视标签书写顺序。调高后更相信前几个 Tag 是叙事主干；调低后前后 Tag 更平等。0 表示完全忽略序位。",
      range: "建议 0.01 ~ 0.08，默认 0.035",
      tone: "sensitive",
    },
    "geodesicRerank.publicHubFloor": {
      label: "公共枢纽特异性下限",
      summary: "高入流公共 Tag 被降权时仍保留的最低候选质量倍率。",
      logic: "像给“AI、技术、模型”等公共路口设置最低通行权。调低可更强地压制万金油标签；调高则避免真正的核心公共概念被误伤。",
      range: "建议 0.20 ~ 0.55，默认 0.35",
      tone: "sensitive",
    },
    "geodesicRerank.minClosureSimilarity": {
      label: "Tag→正文闭合起点",
      summary: "Tag 与候选 Chunk 的余弦相似度超过该值后，才开始贡献闭合质量。",
      logic: "它检查路标是否真的属于这篇正文。调高会排除贴错或过泛的标签；调低更宽容，但可能让与正文关系薄弱的 Tag 参与曲线评分。",
      range: "建议 0.10 ~ 0.40，默认 0.20",
      tone: "critical",
    },
    "geodesicRerank.minStrongEvidence": {
      label: "联合守卫强证据下限",
      summary: "候选池累计强接触与折算精确命中的最低证据量，用于覆盖率、最大分和区分度的联合回退判断。",
      logic: "调高会更保守；默认 1 表示只要存在一个可靠强接触，就不会因低覆盖或低 spread 单独回退。",
      range: "建议 0.5 ~ 3，默认 1",
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

export interface RiverMemoSectionMeta {
  id: string;
  title: string;
  summary: string;
  icon: string;
  paths: readonly string[];
}

export const RIVERMEMO_SECTIONS: readonly RiverMemoSectionMeta[] = [
  {
    id: "source",
    title: "V9 全上下文源观测",
    summary: "继承已验证的 EPA、Residual Pyramid 与 Spike 降噪链。除启用开关外，不建议修改。",
    icon: "filter_alt",
    paths: ["enabled", "sourceObservation"],
  },
  {
    id: "field",
    title: "双尺度连续场",
    summary: "以同一 V9 源场和守恒传输算子求解 Local / Transfer resolvent 场及有效支持域。",
    icon: "waves",
    paths: ["localField", "transferField", "effectiveSupport", "agentConditioning"],
  },
  {
    id: "candidate",
    title: "候选超集",
    summary: "控制六类候选来源的召回规模、最低配额和最终并集上限，主要影响延迟与覆盖率。",
    icon: "dataset",
    paths: ["candidateSuperset"],
  },
  {
    id: "geometry",
    title: "路径与相对拓扑",
    summary: "将候选有序 Tag 链作为曲线读取双场，并与查询河网比较节点、边、方向、距离和 Motif。",
    icon: "route",
    paths: ["pathGeometry", "relativeTopology"],
  },
  {
    id: "omega",
    title: "Ω 河网可观测性",
    summary: "统一测量边激活、节点涌现与边流熵；它决定关系拓扑创新能获得多少排序权限。",
    icon: "monitoring",
    paths: ["riverObservability"],
  },
  {
    id: "anchor",
    title: "直接锚点",
    summary: "读取 hop-0 seed/core 与候选原生 Tag 的精确或高阈值语义接触，独立于河网密度。",
    icon: "anchor",
    paths: ["directAnchor"],
  },
  {
    id: "score",
    title: "Topology V3 统一评分",
    summary: "设置条件拓扑创新、Ω 门控、角色限幅、自适应锚异常激活和正文闭合。",
    icon: "function",
    paths: ["dstc"],
  },
  {
    id: "safety",
    title: "安全与权限",
    summary: "控制权限违规容忍度与失败关闭。生产环境必须保持 fail-closed。",
    icon: "shield_lock",
    paths: ["safety"],
  },
] as const;

const RIVER_STABLE: ParamTone = "stable";
const RIVER_SENSITIVE: ParamTone = "sensitive";
const RIVER_CRITICAL: ParamTone = "critical";

export const RIVERMEMO_PARAM_METADATA: Record<string, ParamMeta> = {
  enabled: {
    label: "启用 RiverMemo",
    summary: "启用固定 Topology V3 生产重排；关闭时保留 V9 生产链。",
    logic: "这是唯一推荐用户按需调整的 RiverMemo 参数。启用前应确保 V9.1 资产已完成重建。",
    range: "布尔开关",
    tone: RIVER_SENSITIVE,
  },
  sourceObservation: {
    label: "V9 源观测",
    summary: "整个上下文先经过 V9 EPA、残差金字塔与 Spike 传播，形成降噪源场和查询河网。",
    tone: RIVER_CRITICAL,
  },
  "sourceObservation.mode": {
    label: "源观测模式",
    summary: "固定使用 V9 全上下文降噪观测，不建议切换。",
    range: "固定 v9_epa_pyramid_spike",
    tone: RIVER_CRITICAL,
  },
  "sourceObservation.baseTagBoost": {
    label: "基础 Tag 增强",
    summary: "传给 V9 降噪链的基础标签增强系数。",
    range: "建议保持 0.60",
    tone: RIVER_CRITICAL,
  },
  "sourceObservation.coreBoostFactor": {
    label: "Core Tag 增强",
    summary: "显式核心标签在 V9 源观测中的增强倍率。",
    range: "建议保持 1.33",
    tone: RIVER_CRITICAL,
  },
  "sourceObservation.allowKnnFallback": {
    label: "允许 KNN 源回退",
    summary: "完整 V9 降噪不可用时，是否允许普通 Tag KNN 代替源场。",
    logic: "生产必须关闭，避免未降噪近邻被误报为完整 RiverMemo 观测。",
    range: "建议关闭",
    tone: RIVER_CRITICAL,
  },
  "sourceObservation.fallbackSourceK": {
    label: "回退源 K",
    summary: "仅在显式允许 KNN 回退时使用的 Tag 近邻数量。",
    range: "8 ~ 64；默认 16",
    tone: RIVER_SENSITIVE,
  },
  localField: {
    label: "局部场",
    summary: "低 α resolvent 场，强调查询源附近的稳定解释。",
    tone: RIVER_CRITICAL,
  },
  transferField: {
    label: "迁移场",
    summary: "高 α resolvent 场，允许信息沿可靠关系传播到更远结构。",
    tone: RIVER_CRITICAL,
  },
  "localField.solver": {
    label: "局部场求解器",
    summary: "双场固定使用缩放 resolvent 迭代。",
    range: "固定 scaled_resolvent",
    tone: RIVER_CRITICAL,
  },
  "transferField.solver": {
    label: "迁移场求解器",
    summary: "双场固定使用缩放 resolvent 迭代。",
    range: "固定 scaled_resolvent",
    tone: RIVER_CRITICAL,
  },
  "localField.alpha": {
    label: "局部场 α",
    summary: "控制局部场对传播项的依赖程度；越小越贴近 V9 源。",
    range: "建议保持 0.15",
    tone: RIVER_CRITICAL,
  },
  "transferField.alpha": {
    label: "迁移场 α",
    summary: "控制迁移场对传播项的依赖程度；越大越强调远程传递。",
    range: "建议保持 0.55，且高于局部场 α",
    tone: RIVER_CRITICAL,
  },
  "localField.maxIterations": {
    label: "局部场最大迭代",
    summary: "局部 resolvent 求解的硬迭代上限。",
    range: "20 ~ 200；默认 80",
    tone: RIVER_SENSITIVE,
  },
  "transferField.maxIterations": {
    label: "迁移场最大迭代",
    summary: "迁移 resolvent 求解的硬迭代上限。",
    range: "20 ~ 200；默认 80",
    tone: RIVER_SENSITIVE,
  },
  "localField.tolerance": {
    label: "局部场收敛容差",
    summary: "相邻迭代 L1 残差低于此值时停止局部场求解。",
    range: "建议保持 1e-9",
    tone: RIVER_CRITICAL,
  },
  "transferField.tolerance": {
    label: "迁移场收敛容差",
    summary: "相邻迭代 L1 残差低于此值时停止迁移场求解。",
    range: "建议保持 1e-9",
    tone: RIVER_CRITICAL,
  },
  effectiveSupport: {
    label: "有效支持域",
    summary: "按累计场质量截断长尾，防止微弱正值获得完整路径解释权。",
    tone: RIVER_CRITICAL,
  },
  "effectiveSupport.method": {
    label: "支持域方法",
    summary: "按累计质量比例选择 Local / Transfer 有效节点。",
    range: "固定 mass_ratio",
    tone: RIVER_CRITICAL,
  },
  "effectiveSupport.localMassRatio": {
    label: "局部场质量覆盖",
    summary: "局部场有效支持域保留的累计质量比例。",
    range: "建议保持 0.80",
    tone: RIVER_SENSITIVE,
  },
  "effectiveSupport.transferMassRatio": {
    label: "迁移场质量覆盖",
    summary: "迁移场有效支持域保留的累计质量比例。",
    range: "建议保持 0.90",
    tone: RIVER_SENSITIVE,
  },
  agentConditioning: {
    label: "Agent 条件化",
    summary: "在共享传输上应用请求条件，不改变全局 RiverMemo 资产。",
    tone: RIVER_CRITICAL,
  },
  "agentConditioning.enabled": {
    label: "启用 Agent 条件化",
    summary: "启用请求级亲和调制；生产建议保持开启。",
    range: "布尔开关",
    tone: RIVER_CRITICAL,
  },
  "agentConditioning.localAffinityMin": {
    label: "局部亲和下限",
    summary: "局部场条件化边倍率的下界。",
    range: "建议保持 0.75",
    tone: RIVER_CRITICAL,
  },
  "agentConditioning.localAffinityMax": {
    label: "局部亲和上限",
    summary: "局部场条件化边倍率的上界。",
    range: "建议保持 1.25",
    tone: RIVER_CRITICAL,
  },
  "agentConditioning.transferAffinityMin": {
    label: "迁移亲和下限",
    summary: "迁移场条件化边倍率的下界。",
    range: "建议保持 0.90",
    tone: RIVER_CRITICAL,
  },
  "agentConditioning.transferAffinityMax": {
    label: "迁移亲和上限",
    summary: "迁移场条件化边倍率的上界。",
    range: "建议保持 1.10",
    tone: RIVER_CRITICAL,
  },
  candidateSuperset: {
    label: "六路候选超集",
    summary: "合并 Query、Denoised、Local、Transfer、BM25 与 Direct Anchor 候选。",
    tone: RIVER_SENSITIVE,
  },
  "candidateSuperset.queryK": { label: "原查询 K", summary: "原始上下文向量召回数量。", range: "20 ~ 300；默认 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.denoisedK": { label: "V9 降噪 K", summary: "V9 降噪向量召回数量。", range: "20 ~ 300；默认 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.localFieldK": { label: "局部场 K", summary: "局部场投影向量召回数量。", range: "20 ~ 300；默认 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.transferFieldK": { label: "迁移场 K", summary: "迁移场投影向量召回数量。", range: "20 ~ 300；默认 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.bm25K": { label: "BM25 K", summary: "词法候选来源的召回数量。", range: "0 ~ 200；默认 50", tone: RIVER_STABLE },
  "candidateSuperset.anchorK": { label: "直接锚 K", summary: "查询锚与文件 Tag 直接接触候选数量。", range: "0 ~ 200；默认 50", tone: RIVER_SENSITIVE },
  "candidateSuperset.maxUnionCandidates": { label: "并集候选上限", summary: "六路合并、去重后的候选硬上限，直接影响路径评估成本。", range: "50 ~ 1000；默认 300", tone: RIVER_CRITICAL },
  "candidateSuperset.minimumGeometryCoverage": { label: "最低几何覆盖", summary: "候选超集需要满足的最低几何来源覆盖比例。", range: "0 ~ 1；默认 0.50", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota": { label: "来源最低配额", summary: "为每个有效候选来源保留最低席位，避免单路召回垄断并集。", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota.query_knn": { label: "原查询最低配额", summary: "原查询 KNN 至少保留的候选数。", range: "0 ~ 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota.denoised_field_knn": { label: "降噪场最低配额", summary: "V9 降噪向量至少保留的候选数。", range: "0 ~ 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota.local_field_knn": { label: "局部场最低配额", summary: "局部场至少保留的候选数。", range: "0 ~ 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota.transfer_field_knn": { label: "迁移场最低配额", summary: "迁移场至少保留的候选数。", range: "0 ~ 100", tone: RIVER_SENSITIVE },
  "candidateSuperset.minimumQuota.bm25": { label: "BM25 最低配额", summary: "词法来源至少保留的候选数。", range: "0 ~ 100", tone: RIVER_STABLE },
  "candidateSuperset.minimumQuota.anchor_direct": { label: "直接锚最低配额", summary: "直接锚来源至少保留的候选数。", range: "0 ~ 100", tone: RIVER_SENSITIVE },
  pathGeometry: {
    label: "双场路径几何",
    summary: "沿候选有序 Tag 曲线读取势能、方向、连续性和正文闭合。",
    tone: RIVER_CRITICAL,
  },
  "pathGeometry.localWeight": { label: "路径局部场权重", summary: "路径段势能中 Local 场所占权重。", range: "建议保持 0.60", tone: RIVER_CRITICAL },
  "pathGeometry.transferWeight": { label: "路径迁移场权重", summary: "路径段势能中 Transfer 场所占权重。", range: "建议保持 0.40", tone: RIVER_CRITICAL },
  "pathGeometry.directionFloor": { label: "方向质量下限", summary: "无方向证据或逆向段仍保留的最小方向质量。", range: "0 ~ 0.25；默认 0.05", tone: RIVER_CRITICAL },
  "pathGeometry.closureFloor": { label: "Tag→Chunk 闭合起点", summary: "Tag 与候选正文余弦超过该值后开始形成闭合质量。", range: "-1 ~ 1；默认 0", tone: RIVER_CRITICAL },
  "pathGeometry.supportMode": { label: "路径支持模式", summary: "只允许有效支持域内的正势路径段贡献主质量。", range: "固定 effective_domain", tone: RIVER_CRITICAL },
  "pathGeometry.minimumSupportedPotential": { label: "最小支持势能", summary: "路径段进入主质量计算所需的最低双场势能。", range: "0 ~ 1；默认 0", tone: RIVER_SENSITIVE },
  relativeTopology: {
    label: "查询河网相对拓扑",
    summary: "比较查询河网与候选曲线的节点、边、相对距离、方向和 Motif。",
    tone: RIVER_CRITICAL,
  },
  "relativeTopology.enabled": { label: "启用相对拓扑", summary: "关闭后 Topology V3 将失去主要关系创新读出。", range: "建议开启", tone: RIVER_CRITICAL },
  "relativeTopology.semanticNodeThreshold": { label: "节点语义对应阈值", summary: "非同 ID 河网节点与候选 Tag 建立对应所需的最低余弦。", range: "0.35 ~ 0.75；默认 0.48", tone: RIVER_CRITICAL },
  "relativeTopology.relativeDistanceTemperature": { label: "相对距离温度", summary: "查询跳距与候选序位距离不一致时的指数衰减尺度。", range: "0.05 ~ 1；默认 0.35", tone: RIVER_CRITICAL },
  "relativeTopology.reverseDirectionCredit": { label: "逆向对应信用", summary: "候选序位与查询河网方向相反时保留的信用。", range: "0 ~ 1；默认 0.25", tone: RIVER_CRITICAL },
  "relativeTopology.selfEvidenceFloor": { label: "自证独立性下限", summary: "候选文件自身贡献关系证据时仍保留的最小独立比例。", range: "0 ~ 1；默认 0.15", tone: RIVER_CRITICAL },
  "relativeTopology.nodeOnlyReliabilityCap": { label: "纯节点退化可靠度上限", summary: "没有完整边对应时，节点对齐读出的可靠度硬上限。", range: "0 ~ 0.5；默认 0.20", tone: RIVER_CRITICAL },
  "relativeTopology.minimumRiverEdgeFlow": { label: "最小河网边流", summary: "低于该归一化流量的查询边不进入相对拓扑匹配。", range: "0 ~ 0.1；默认 0.015", tone: RIVER_CRITICAL },
  "relativeTopology.maximumRiverEdges": { label: "河网边匹配上限", summary: "每个查询最多保留多少条高流量边参与候选匹配。", range: "16 ~ 256；默认 96", tone: RIVER_SENSITIVE },
  "relativeTopology.traceEdgeLimit": { label: "边追踪输出上限", summary: "诊断结果最多输出多少条候选边对应，不影响实际评分。", range: "0 ~ 128；默认 24", tone: RIVER_STABLE },
  riverObservability: {
    label: "Ω 可观测泛函",
    summary: "边激活、节点涌现和边流熵的几何平均，统一控制结构创新权限。",
    tone: RIVER_CRITICAL,
  },
  "riverObservability.kappaEdge": { label: "Ω 边尺度 κE", summary: "按种子数归一化激活边数量的饱和尺度。", range: "建议保持 0.50", tone: RIVER_CRITICAL },
  "riverObservability.kappaRatio": { label: "Ω 涌现尺度 κN", summary: "按种子数归一化涌现节点数量的饱和尺度。", range: "建议保持 0.30", tone: RIVER_CRITICAL },
  "riverObservability.epsilon": { label: "Ω 数值软底 ε", summary: "几何平均各分量的数值软底，避免单项精确零导致不可区分。", range: "0.001 ~ 0.10；默认 0.02", tone: RIVER_CRITICAL },
  "riverObservability.collapsedThreshold": { label: "坍缩工况阈值", summary: "Ω 低于该值时河网标记为 collapsed。", range: "建议保持 0.12", tone: RIVER_CRITICAL },
  "riverObservability.sparseThreshold": { label: "稀疏工况上界", summary: "Ω 低于该值但未坍缩时标记为 sparse，更高为 dense。", range: "建议保持 0.45", tone: RIVER_CRITICAL },
  directAnchor: {
    label: "hop-0 直接锚",
    summary: "对查询 seed/core 与候选原生 Tag 的接触执行特异性、稀有度和正文闭合读出。",
    tone: RIVER_CRITICAL,
  },
  "directAnchor.semanticThreshold": { label: "锚语义接触阈值", summary: "非同 ID 锚与候选 Tag 建立直接接触所需的最低余弦。", range: "0.70 ~ 0.95；默认 0.80", tone: RIVER_CRITICAL },
  "directAnchor.semanticDiscount": { label: "语义锚折扣", summary: "非精确语义接触相对精确 ID 接触的权重。", range: "0 ~ 1；默认 0.70", tone: RIVER_CRITICAL },
  "directAnchor.specificityFloor": { label: "锚特异性下限", summary: "高入流公共 Tag 经特异性抑制后保留的最低倍率。", range: "0 ~ 1；默认 0.35", tone: RIVER_CRITICAL },
  "directAnchor.rarityFloor": { label: "批内稀有度下限", summary: "锚在候选池普遍出现时仍保留的最低稀有度倍率。", range: "0 ~ 1；默认 0.15", tone: RIVER_CRITICAL },
  "directAnchor.reliabilitySeedSaturation": { label: "锚可靠度种子饱和数", summary: "接触多少个独立 seed/core 后，接触数量可靠度饱和。", range: "1 ~ 8；默认 2", tone: RIVER_SENSITIVE },
  "directAnchor.fallbackReliabilityCap": { label: "来源回退可靠度上限", summary: "无法确认 hop-0 provenance 时，直接锚可靠度的硬上限。", range: "0 ~ 1；默认 0.50", tone: RIVER_CRITICAL },
  "directAnchor.traceLimit": { label: "锚接触追踪上限", summary: "诊断中最多返回的直接锚接触数，不影响实际评分。", range: "0 ~ 64；默认 8", tone: RIVER_STABLE },
  dstc: {
    label: "Topology V3 评分泛函",
    summary: "V9 双场基线、条件拓扑创新、Ω 门控与直接锚创新的最终闭合。",
    tone: RIVER_CRITICAL,
  },
  "dstc.semanticScoreMode": { label: "语义分数模式", summary: "正余弦直接截断到 [0,1]，不建议切换。", range: "固定 positive", tone: RIVER_CRITICAL },
  "dstc.pureScoreMode": { label: "基础分模式", summary: "使用拓扑限幅的连续场基础分。", range: "固定 topology_limited", tone: RIVER_CRITICAL },
  "dstc.topologyBonusCap": { label: "基础拓扑奖励上限", summary: "基础场分内部路径拓扑项的硬上限。", range: "0 ~ 0.2；默认 0.08", tone: RIVER_CRITICAL },
  "dstc.topologyPathSaturation": { label: "路径可靠度饱和点", summary: "路径质量达到该值时，路径可靠度视为饱和。", range: "0.01 ~ 1；默认 0.15", tone: RIVER_CRITICAL },
  "dstc.topologyReliabilityMode": { label: "拓扑可靠度模式", summary: "联合路径质量与正文闭合形成可靠度。", range: "固定 path_closure", tone: RIVER_CRITICAL },
  "dstc.topologyV2BonusCap": { label: "关系创新总上限", summary: "Ω 门控前的条件拓扑创新奖励总上限。", range: "0 ~ 0.2；默认 0.08", tone: RIVER_CRITICAL },
  "dstc.topologyV2InnovationScale": { label: "关系创新尺度 λ", summary: "条件创新下置信界转化为奖励的全局缩放。", range: "0 ~ 2；默认 0.50", tone: RIVER_CRITICAL },
  "dstc.topologyV2ConditionalBandwidth": { label: "语义基线条件带宽", summary: "按基础分寻找同条件候选邻域的高斯带宽。", range: "0.005 ~ 0.2；默认 0.04", tone: RIVER_CRITICAL },
  "dstc.topologyV2ClosureBandwidth": { label: "闭合条件带宽", summary: "按正文闭合寻找同条件候选邻域的高斯带宽。", range: "0.01 ~ 0.5；默认 0.10", tone: RIVER_CRITICAL },
  "dstc.topologyV2DirectBandwidth": { label: "直接证据条件带宽", summary: "按直接证据寻找同条件候选邻域的高斯带宽。", range: "0.01 ~ 0.5；默认 0.12", tone: RIVER_CRITICAL },
  "dstc.topologyV2MinimumPeers": { label: "条件估计最少邻居", summary: "估计 E(G|Z) 时至少纳入的候选邻居数。", range: "1 ~ 20；默认 3", tone: RIVER_CRITICAL },
  "dstc.topologyV2MinimumEffectivePeers": { label: "最小有效样本量", summary: "条件样本可靠度达到 1 所需的有效加权邻居数。", range: "1 ~ 20；默认 2.5", tone: RIVER_CRITICAL },
  "dstc.topologyV2InnovationConfidenceZ": { label: "创新置信系数 z", summary: "从拓扑创新中扣除多少倍条件预测不确定性。", range: "0 ~ 4；默认 1", tone: RIVER_CRITICAL },
  "dstc.topologyV2QueryConfidenceFloor": { label: "查询可信度下限", summary: "完整观测下动态结构充分性之外保留的查询置信底。", range: "0 ~ 1；默认 0.20", tone: RIVER_CRITICAL },
  "dstc.topologyV2DirectEvidenceThreshold": { label: "直接答案证据阈值", summary: "候选被识别为直接答案所需的直接边界证据。", range: "0 ~ 1；默认 0.55", tone: RIVER_CRITICAL },
  "dstc.topologyV2DirectFrontierMargin": { label: "直接答案前沿带宽", summary: "接近基础分冠军时可参与直接答案识别的分差。", range: "0 ~ 0.2；默认 0.03", tone: RIVER_CRITICAL },
  "dstc.topologyV2FrontierProtectionMargin": { label: "直接前沿保护间隔", summary: "非直接候选通过结构创新接近直接答案前沿时保留的安全分差。", range: "0 ~ 0.05；默认 0.005", tone: RIVER_CRITICAL },
  "dstc.topologyV3OmegaGamma": { label: "Ω 门控指数 γ", summary: "关系拓扑创新乘以 Ω^γ；越大越严格压制稀疏河网。", range: "0 ~ 4；默认 1", tone: RIVER_CRITICAL },
  "dstc.topologyV3StructRoleMinOmega": { label: "结构角色最低 Ω", summary: "低于该 Ω 时 structural explanation 降级为 thematic neighbor。", range: "建议与 collapsedThreshold 同为 0.12", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorBonusCap": { label: "直接锚创新上限 CA", summary: "自适应异常锚激活后可增加的最大绝对分数。", range: "0 ~ 0.2；默认 0.10", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorActivationZ": { label: "锚异常阈值 z", summary: "锚激活阈值为批均值加多少倍标准差，并与固定下限取大。", range: "0 ~ 5；默认 2", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorActivationFloor": { label: "锚激活固定下限", summary: "自适应批阈值不能低于该值。", range: "0 ~ 1；默认 0.05", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorSaturation": { label: "锚激活饱和尺度 sA", summary: "锚强度达到该值后 SmoothStep 激活饱和。", range: "0 ~ 1；默认 0.20", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorFrontierContrast": { label: "最强锚前沿对比", summary: "最强锚至少达到次强锚的该倍数，才可升格为 direct answer。", range: "1 ~ 10；默认 2", tone: RIVER_CRITICAL },
  "dstc.topologyV3AnchorFrontierAbsFloor": { label: "最强锚前沿绝对下限", summary: "最强锚升格前还必须达到的绝对强度。", range: "0 ~ 1；默认 0.10", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleCaps": { label: "角色奖励上限", summary: "不同查询角色可获得的条件拓扑创新硬上限。", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleCaps.atomic_concept": { label: "原子概念上限", summary: "atomic concept 的拓扑创新上限。", range: "0 ~ 0.2；默认 0.08", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleCaps.direct_answer": { label: "直接答案上限", summary: "direct answer 的拓扑创新上限；直接性主要由基础场与锚通道表达。", range: "0 ~ 0.1；默认 0.02", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleCaps.structural_explanation": { label: "结构解释上限", summary: "structural explanation 的拓扑创新上限。", range: "0 ~ 0.15；默认 0.045", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleCaps.thematic_neighbor": { label: "主题邻居上限", summary: "thematic neighbor 的拓扑创新上限。", range: "0 ~ 0.05；默认 0.008", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleMultipliers": { label: "角色创新倍率", summary: "不同角色的条件拓扑创新缩放倍率。", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleMultipliers.atomic_concept": { label: "原子概念倍率", summary: "atomic concept 的创新倍率。", range: "0 ~ 1；默认 1", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleMultipliers.direct_answer": { label: "直接答案倍率", summary: "direct answer 的结构创新倍率。", range: "0 ~ 1；默认 0.35", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleMultipliers.structural_explanation": { label: "结构解释倍率", summary: "structural explanation 的创新倍率。", range: "0 ~ 1；默认 0.70", tone: RIVER_CRITICAL },
  "dstc.topologyV2RoleMultipliers.thematic_neighbor": { label: "主题邻居倍率", summary: "thematic neighbor 的创新倍率。", range: "0 ~ 1；默认 0.15", tone: RIVER_CRITICAL },
  "dstc.semanticSimilarityMode": { label: "候选语义模式", summary: "候选观测使用正余弦，负相似度不转成正证据。", range: "固定 positive", tone: RIVER_CRITICAL },
  "dstc.closureMode": { label: "正文闭合模式", summary: "联合 Query→Chunk 与场加权 Tag→Chunk 闭合。", range: "固定 query_weighted", tone: RIVER_CRITICAL },
  "dstc.queryClosureWeight": { label: "Query→Chunk 闭合权重", summary: "最终闭合中原查询与候选正文相似度的权重。", range: "建议保持 0.65", tone: RIVER_CRITICAL },
  "dstc.tagClosureWeight": { label: "Tag→Chunk 闭合权重", summary: "最终闭合中场加权候选 Tag 与正文闭合的权重。", range: "建议保持 0.35", tone: RIVER_CRITICAL },
  safety: {
    label: "RiverMemo 安全策略",
    summary: "权限与异常状态的失败策略。",
    tone: RIVER_CRITICAL,
  },
  "safety.permissionViolationTolerance": { label: "权限违规容忍度", summary: "允许的权限违规质量；生产必须为 0。", range: "固定 0", tone: RIVER_CRITICAL },
  "safety.failClosed": { label: "失败关闭", summary: "权限或条件化信息不完整时拒绝放行，而不是宽松回退。", range: "生产必须开启", tone: RIVER_CRITICAL },
};

export function getRiverMemoParamMeta(path: string): ParamMeta {
  return RIVERMEMO_PARAM_METADATA[path] ?? {
    ...DEFAULT_PARAM_META,
    label: path.split(".").pop() ?? path,
    summary: "RiverMemo 高级参数；当前没有独立说明，不建议修改。",
    tone: RIVER_CRITICAL,
  };
}

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
  const leafKey = key.split(".").pop() ?? key;

  // Wormhole routing explicit ranges (must be checked before generic threshold rules).
  if (leafKey === "tensionthreshold") {
    return { min: 0.5, max: 3, step: 0.01 };
  }

  if (leafKey === "firingthreshold") {
    return { min: 0, max: 1, step: 0.01 };
  }

  // Fuzzy embedding 需要更高精度，支持 0.001 级热调参观察。
  // 注意：这里用完整路径判断，避免影响其它 threshold 类参数。
  if (key === "fuzzyembedding.threshold") {
    return { min: 0.97, max: 0.995, step: 0.001 };
  }

  if (leafKey === "basemomentum") {
    return { min: 1, max: 10, step: 0.1 };
  }

  if (leafKey === "basedecay" || leafKey === "wormholedecay") {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (leafKey === "maxsafehops") {
    return { min: 1, max: 20, step: 1 };
  }

  if (leafKey === "maxemergentnodes") {
    return { min: 1, max: 200, step: 1 };
  }

  if (leafKey === "maxneighborspernode") {
    return { min: 1, max: 20, step: 1 };
  }

  // V9.1 查询势场曲线重排显式范围。
  if (key === "geodesicrerank.alpha") {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key === "geodesicrerank.candidatekmultiplier") {
    return { min: 1, max: 6, step: 0.25 };
  }

  if (key === "geodesicrerank.maxfieldnodes") {
    return { min: 4, max: 128, step: 1 };
  }

  if (key === "geodesicrerank.maxfieldneighbors") {
    return { min: 1, max: 12, step: 1 };
  }

  if (key === "geodesicrerank.fieldkernelExponent".toLowerCase()) {
    return { min: 0.25, max: 6, step: 0.05 };
  }

  if (
    key === "geodesicrerank.fieldenergymassratio"
    || key === "geodesicrerank.fieldsimilaritythreshold"
    || key === "geodesicrerank.weakcontactthreshold"
    || key === "geodesicrerank.strongcontactthreshold"
  ) {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key === "geodesicrerank.candidatepositiondecay") {
    return { min: 0, max: 0.2, step: 0.005 };
  }

  if (
    key === "geodesicrerank.publichubfloor"
    || key === "geodesicrerank.minclosuresimilarity"
  ) {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (key === "geodesicrerank.minstrongevidence") {
    return { min: 0, max: 10, step: 0.25 };
  }

  if (
    key === "geodesicrerank.georewardfloor"
    || key === "geodesicrerank.georewardsaturation"
    || key === "geodesicrerank.directbonuscap"
    || key === "geodesicrerank.structuralbonuscap"
    || key === "geodesicrerank.thematicbonuscap"
    || key === "geodesicrerank.structuralcontinuitymin"
    || key === "geodesicrerank.thematicminpotential"
    || key === "geodesicrerank.thematicmaxisolatedratio"
    || key === "geodesicrerank.sparseassociationminconductance"
    || key === "geodesicrerank.sparseassociationminpotential"
    || key === "geodesicrerank.sparseassociationminclosure"
    || key === "geodesicrerank.sparseassociationmaxrelief"
    || key === "geodesicrerank.directsemanticminpotential"
    || key === "geodesicrerank.directsemanticsaturation"
    || key === "geodesicrerank.directconfidencefloor"
  ) {
    return { min: 0, max: 1, step: 0.005 };
  }

  if (key === "geodesicrerank.sparseassociationminsimilarity") {
    return { min: -1, max: 1, step: 0.01 };
  }

  if (
    key === "geodesicrerank.directsemanticmincontacts"
    || key === "geodesicrerank.sparseassociationmincontacts"
    || key === "geodesicrerank.sparseassociationpairsaturation"
  ) {
    return { min: 1, max: 12, step: 1 };
  }

  // 🛡️ V8: 测地线低可信地图回退开关
  if (key === "geodesicrerank.fallbacktoknnonlowtrust") {
    return { min: 0, max: 1, step: 1 };
  }

  // 🛡️ V8: 查询级地图最小激活 Tag 数
  if (key === "geodesicrerank.minfieldtags") {
    return { min: 1, max: 20, step: 1 };
  }

  // 🛡️ V8: 查询级地图熵与候选覆盖/区分度门槛
  if (
    key === "geodesicrerank.minfieldentropy"
    || key === "geodesicrerank.mingeocoverageratio"
    || key === "geodesicrerank.minmaxgeoscore"
    || key === "geodesicrerank.mingeoscorespread"
  ) {
    return { min: 0, max: 1, step: 0.01 };
  }

  // 🆕 V8: 最小采样密度门槛
  if (leafKey.includes('samples')) {
    return { min: 1, max: 20, step: 1 };
  }

  // 🆕 V8.2: 有序双向势能流形参数
  if (leafKey === 'forwardgain' || leafKey === 'reversegain'
      || leafKey === 'minreversegain' || leafKey === 'maxreversegain') {
    return { min: 0, max: 1.5, step: 0.01 };
  }
  if (leafKey === 'distancedecay') {
    return { min: 0, max: 0.5, step: 0.01 };
  }
  if (leafKey === 'reverseanchorboost' || leafKey === 'semanticgainenabled') {
    return { min: 0, max: 1, step: 1 }; // toggle 用 0/1 表达
  }
  if (leafKey === 'reverseanchormax') {
    return { min: 1, max: 3, step: 0.05 };
  }
  if (leafKey === 'semanticgainpeak') {
    return { min: 0, max: 1, step: 0.01 };
  }
  if (leafKey === 'semanticgainsigma') {
    return { min: 0.05, max: 0.6, step: 0.01 };
  }
  if (leafKey === 'semanticgainlowsimfallback') {
    return { min: 0, max: 0.5, step: 0.01 };
  }
  if (leafKey === 'reverseinversionguard') {
    return { min: 0.5, max: 1, step: 0.01 };
  }

  if (leafKey === "minlength" || leafKey === "maxscan" || leafKey === "maxlengthdiffabs") {
    return { min: 1, max: leafKey === "maxscan" ? 1000 : 500, step: 1 };
  }

  if (leafKey === "maxlengthdiffratio") {
    return { min: 0, max: 0.2, step: 0.001 };
  }

  if (leafKey === "shotgundecayfactor") {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (leafKey === "shotgunhistorysegmentlimit") {
    return { min: 0, max: 10, step: 1 };
  }

  if (leafKey.includes("days")) {
    return { min: 1, max: 365, step: 1 };
  }

  if (leafKey.includes("threshold")) {
    return { min: 0, max: 1, step: 0.01 };
  }

  if (leafKey.includes("hops") || leafKey.includes("nodes") || leafKey.includes("neighbors")) {
    return { min: 1, max: leafKey.includes('nodes') ? 200 : 20, step: 1 };
  }

  if (leafKey.includes("momentum")) {
    return { min: 1, max: 10, step: 0.1 };
  }

  // 🛠️ 修复：语言补偿器和时间衰减的浮点参数
  if (leafKey.includes("penalty") || leafKey.includes("score") || leafKey.includes("min")) {
    return { min: 0, max: 1, step: 0.01 };
  }

  // 🛠️ 修复：兜底逻辑 - 如果值本身是浮点数，自动使用小数步长
  if (typeof subVal === 'number' && !Number.isInteger(subVal)) {
    return { min: 0, max: Math.max(10, Math.ceil(subVal * 20)), step: 0.01 };
  }

  return { min: 0, max: 100, step: 1 };
}

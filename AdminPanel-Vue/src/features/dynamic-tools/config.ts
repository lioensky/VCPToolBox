import type {
  DynamicToolsCategoryRule,
  DynamicToolsConfig,
} from "../../api/dynamicTools";

export type DynamicToolsPayload = Omit<DynamicToolsConfig, "placeholder">;
export interface ConfigDraft {
  config: DynamicToolsConfig;
  aliasText: string;
  categoryRulesText: string;
  descriptionArrayText: Record<
    string,
    { categories?: string; keywords?: string }
  >;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createDefaultConfig(): DynamicToolsConfig {
  return {
    version: 2,
    enabled: true,
    placeholder: "{{VCPDynamicTools}}",
    maxBriefListItems: 120,
    maxExpandedPlugins: 4,
    maxForcedCategoryPlugins: 12,
    maxInjectionChars: 16000,
    classificationDebounceMs: 1000,
    classifierTimeoutMs: 30000,
    useRagEmbeddings: true,
    manualOverrides: {
      excludedOriginKeys: [],
      pinnedOriginKeys: [],
      categoryAliases: {},
      descriptionOverrides: {},
    },
    summary: {
      lightListTokenBudget: 15,
      briefTokenBudget: 6,
      minBriefTokenBudget: 3,
    },
    classification: {
      maxCategories: 3,
      embeddingThreshold: 0.34,
      categoryRules: clone(DEFAULT_CATEGORY_RULES),
    },
    smallModel: {
      enabled: false,
      model: "",
      maxRetries: 2,
      retryDelayMs: 250,
      maxTokens: 2048,
      temperature: 0.1,
    },
  };
}

export function createConfigDraft(config: DynamicToolsConfig): ConfigDraft {
  const defaults = createDefaultConfig();
  const normalized = clone<DynamicToolsConfig>({
    ...defaults,
    ...config,
    version: 2,
    placeholder: defaults.placeholder,
    summary: { ...defaults.summary, ...config.summary },
    classification: { ...defaults.classification, ...config.classification },
    smallModel: { ...defaults.smallModel, ...config.smallModel },
    manualOverrides: { ...defaults.manualOverrides, ...config.manualOverrides },
  });
  return {
    config: normalized,
    descriptionArrayText: {},
    aliasText: Object.entries(normalized.manualOverrides.categoryAliases)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    categoryRulesText: JSON.stringify(
      normalized.classification.categoryRules,
      null,
      2,
    ),
  };
}

function parseAliases(text: string): Record<string, string> {
  const entries: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (index < 1 || !key || !value)
      throw new Error("分类别名需每行填写 别名=分类ID");
    if (entries.some(([alias]) => alias === key))
      throw new Error(`分类别名重复：${key}`);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

export function buildConfigPayload(draft: ConfigDraft): DynamicToolsPayload {
  const c = draft.config;
  let categoryRules: DynamicToolsCategoryRule[];
  try {
    categoryRules = JSON.parse(draft.categoryRulesText);
  } catch {
    throw new Error("分类规则 JSON 格式无效，请检查引号、括号和逗号");
  }
  const payload: DynamicToolsPayload = {
    version: 2,
    enabled: c.enabled,
    maxBriefListItems: c.maxBriefListItems,
    maxExpandedPlugins: c.maxExpandedPlugins,
    maxForcedCategoryPlugins: c.maxForcedCategoryPlugins,
    maxInjectionChars: c.maxInjectionChars,
    classificationDebounceMs: c.classificationDebounceMs,
    classifierTimeoutMs: c.classifierTimeoutMs,
    useRagEmbeddings: c.useRagEmbeddings,
    summary: {
      lightListTokenBudget: c.summary.lightListTokenBudget,
      briefTokenBudget: c.summary.briefTokenBudget,
      minBriefTokenBudget: c.summary.minBriefTokenBudget,
    },
    classification: {
      maxCategories: c.classification.maxCategories,
      embeddingThreshold: c.classification.embeddingThreshold,
      categoryRules,
    },
    smallModel: {
      enabled: c.smallModel.enabled,
      model: c.smallModel.model.trim(),
      maxRetries: c.smallModel.maxRetries,
      retryDelayMs: c.smallModel.retryDelayMs,
      maxTokens: c.smallModel.maxTokens,
      temperature: c.smallModel.temperature,
    },
    manualOverrides: {
      ...c.manualOverrides,
      categoryAliases: parseAliases(draft.aliasText),
    },
  };
  const error = validateConfig({
    ...payload,
    placeholder: "{{VCPDynamicTools}}",
  });
  if (error) throw new Error(error);
  return clone(payload);
}

function validNumber(
  value: unknown,
  min: number,
  max: number,
  integer = true,
): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value))
  );
}
function validText(
  value: unknown,
  max = 300,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}
function validObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validStrings(
  value: unknown,
  max = 2000,
  allowEmpty = true,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => validText(item))
  );
}

export function validateConfig(c: DynamicToolsConfig): string | null {
  if (
    typeof c.enabled !== "boolean" ||
    typeof c.useRagEmbeddings !== "boolean" ||
    typeof c.smallModel?.enabled !== "boolean"
  )
    return "启用项必须为布尔值";
  const numbers: [unknown, number, number, string][] = [
    [c.maxBriefListItems, 1, 500, "轻量清单数量"],
    [c.maxExpandedPlugins, 0, 50, "语义命中展开数"],
    [c.maxForcedCategoryPlugins, 1, 100, "点名分类展开数"],
    [c.maxInjectionChars, 1000, 120000, "最大注入字符数"],
    [c.classificationDebounceMs, 0, 60000, "分类去抖 ms"],
    [c.classifierTimeoutMs, 100, 120000, "分类超时 ms"],
    [c.summary?.lightListTokenBudget, 1, 200, "轻量清单摘要目标"],
    [c.summary?.briefTokenBudget, 1, 200, "简述目标"],
    [c.summary?.minBriefTokenBudget, 1, 200, "简述最小目标"],
    [c.classification?.maxCategories, 1, 20, "单工具最大分类数"],
    [c.smallModel.maxRetries, 0, 5, "最大重试次数"],
    [c.smallModel.retryDelayMs, 0, 10000, "重试间隔 ms"],
    [c.smallModel.maxTokens, 64, 8192, "模型输出 token 上限"],
  ];
  for (const [value, min, max, label] of numbers)
    if (!validNumber(value, min, max))
      return `${label}需为 ${min}-${max} 之间的整数`;
  if (
    c.summary.minBriefTokenBudget > c.summary.briefTokenBudget ||
    c.summary.briefTokenBudget > c.summary.lightListTokenBudget
  )
    return "摘要目标需满足：最小简述 ≤ 简述 ≤ 轻量清单";
  if (!validNumber(c.classification.embeddingThreshold, 0, 1, false))
    return "Embedding 阈值需为 0-1 之间的数值";
  if (!validNumber(c.smallModel.temperature, 0, 2, false))
    return "模型温度需为 0-2 之间的数值";
  if (!validText(c.smallModel.model, 200, !c.smallModel.enabled))
    return "模型 ID 最多200字符；启用时需填写主 API 源支持的模型 ID";
  const rules = c.classification.categoryRules;
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 100)
    return "分类规则需为包含 1-100 项的 JSON 数组";
  const categories = new Set<string>();
  for (const rule of rules) {
    if (
      !validObject(rule) ||
      Object.keys(rule).some(
        (k) => !["category", "parent", "description", "keywords"].includes(k),
      ) ||
      !validText(rule.category, 100) ||
      !validText(rule.description, 2000) ||
      (rule.parent !== undefined && !validText(rule.parent, 100)) ||
      !validStrings(rule.keywords, 100, false)
    )
      return "分类规则每项需有 category、description 和非空 keywords 数组，parent 可选";
    const category = rule.category.trim();
    if (categories.has(category)) return `分类规则 category 重复：${category}`;
    categories.add(category);
  }
  const manual = c.manualOverrides;
  if (
    !validObject(manual) ||
    !validStrings(manual.pinnedOriginKeys) ||
    !validStrings(manual.excludedOriginKeys)
  )
    return "置顶与排除需为工具 originKey 字符串数组";
  if (
    !validObject(manual.categoryAliases) ||
    Object.entries(manual.categoryAliases).some(
      ([key, value]) => !validText(key, 100) || !validText(value, 100),
    )
  )
    return "分类别名需为非空字符串映射（每项最多100字符）";
  if (
    !validObject(manual.descriptionOverrides) ||
    Object.keys(manual.descriptionOverrides).length > 2000
  )
    return "人工说明需为工具 originKey 到说明的映射";
  for (const [origin, override] of Object.entries(
    manual.descriptionOverrides,
  )) {
    if (
      !validText(origin) ||
      !validObject(override) ||
      Object.keys(override).some(
        (k) =>
          !["brief", "fullDescription", "categories", "keywords"].includes(k),
      )
    )
      return "人工说明的工具 ID 或字段无效";
    if (override.brief !== undefined && !validText(override.brief, 4000, true))
      return "人工简述需为最多4000字符的字符串";
    if (
      override.fullDescription !== undefined &&
      !validText(override.fullDescription, 120000, true)
    )
      return "人工完整说明需为最多120000字符的字符串";
    for (const field of ["categories", "keywords"] as const)
      if (override[field] !== undefined && !validStrings(override[field], 100))
        return "人工分类和关键词需为字符串数组，每项最多100个";
  }
  return null;
}

function fingerprint(draft: ConfigDraft): string {
  return JSON.stringify(draft);
}

export function createConfigEditor() {
  const initial = createConfigDraft(createDefaultConfig());
  return {
    draft: initial,
    baseline: fingerprint(initial),
    initialized: false,
    saving: false,
    error: "",
    get dirty(): boolean {
      return fingerprint(this.draft) !== this.baseline;
    },
    refresh(config: DynamicToolsConfig) {
      if (!this.saving && (!this.initialized || !this.dirty)) {
        this.draft = createConfigDraft(config);
        this.baseline = fingerprint(this.draft);
      }
      this.initialized = true;
    },
    async save(
      submit: (payload: DynamicToolsPayload) => Promise<DynamicToolsConfig>,
    ): Promise<boolean> {
      if (this.saving) return false;
      this.error = "";
      this.saving = true;
      try {
        const payload = buildConfigPayload(this.draft);
        const submitted = fingerprint(this.draft);
        const saved = createConfigDraft(await submit(payload));
        // A response is allowed to acknowledge its own snapshot, never later edits.
        if (submitted === fingerprint(this.draft)) this.draft = saved;
        this.baseline = fingerprint(saved);
        this.initialized = true;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        this.saving = false;
      }
    },
  };
}
const DEFAULT_CATEGORY_RULES = [
  [
    "search/web",
    "search",
    "网页搜索、互联网资料查询与网页检索",
    [
      "web search",
      "web pages",
      "search the web",
      "search web",
      "google",
      "tavily",
      "serp",
      "网页搜索",
      "网页检索",
      "互联网搜索",
      "网络搜索",
    ],
  ],
  [
    "search/academic",
    "search",
    "学术论文、文献与引用检索",
    [
      "academic",
      "paper",
      "papers",
      "citation",
      "citations",
      "arxiv",
      "scholar",
      "学术",
      "论文",
      "文献",
    ],
  ],
  [
    "search/browser",
    "search",
    "浏览器自动化、网页导航、页面交互与内容抓取",
    [
      "browser",
      "playwright",
      "puppeteer",
      "web scraping",
      "浏览器",
      "页面交互",
      "网页抓取",
    ],
  ],
  [
    "file_code/file_read",
    "file_code",
    "文件读取、目录浏览与本地文件检索",
    [
      "read files",
      "read file",
      "file read",
      "directory",
      "filesystem",
      "file search",
      "读取文件",
      "文件读取",
      "目录",
      "文件检索",
    ],
  ],
  [
    "file_code/file_edit",
    "file_code",
    "文件编辑、写入文件与补丁应用",
    [
      "edit files",
      "edit file",
      "file edit",
      "write files",
      "write file",
      "patch",
      "patches",
      "文件编辑",
      "编辑文件",
      "写入文件",
      "补丁",
    ],
  ],
  [
    "file_code/code_analysis",
    "file_code",
    "代码分析、符号查询、依赖与调用关系分析",
    [
      "analyze code",
      "code analysis",
      "code dependencies",
      "symbols",
      "代码分析",
      "代码依赖",
      "符号查询",
      "调用关系",
    ],
  ],
  [
    "file_code/execution",
    "file_code",
    "终端命令、脚本与代码执行",
    [
      "terminal",
      "shell",
      "powershell",
      "execute code",
      "run code",
      "代码执行",
      "运行脚本",
      "终端",
      "执行命令",
    ],
  ],
  [
    "file_code/version_control",
    "file_code",
    "版本控制、Git仓库与代码差异管理",
    ["git", "repository", "repo", "version control", "版本控制", "代码仓库"],
  ],
  [
    "image_media/image_generation",
    "image_media",
    "图像生成、绘画与图片编辑",
    [
      "image generation",
      "generate image",
      "generate images",
      "text to image",
      "image editing",
      "图像生成",
      "图片生成",
      "绘图",
      "图片编辑",
    ],
  ],
  [
    "image_media/image_analysis",
    "image_media",
    "图像识别、OCR与截图视觉分析",
    [
      "ocr",
      "image recognition",
      "image analysis",
      "screenshot",
      "图像识别",
      "图片识别",
      "截图",
      "图像分析",
    ],
  ],
  [
    "image_media/tts",
    "image_media",
    "文本转语音、语音合成与朗读",
    [
      "tts",
      "text to speech",
      "text-to-speech",
      "speech synthesis",
      "文本转语音",
      "语音合成",
      "朗读",
    ],
  ],
  [
    "image_media/transcription",
    "image_media",
    "语音识别、音频转写与字幕",
    [
      "asr",
      "transcription",
      "speech recognition",
      "语音识别",
      "音频转写",
      "字幕",
    ],
  ],
  [
    "image_media/video_generation",
    "image_media",
    "视频生成、文生视频与视频制作",
    [
      "video generation",
      "generate video",
      "generate videos",
      "text to video",
      "text-to-video",
      "视频生成",
      "生成视频",
      "文生视频",
    ],
  ],
  [
    "image_media/media_playback",
    "image_media",
    "音乐、音频和视频播放控制",
    [
      "music",
      "playback",
      "audio player",
      "video player",
      "音乐",
      "播放控制",
      "媒体播放",
    ],
  ],
  [
    "memory_knowledge/retrieval",
    "memory_knowledge",
    "知识库检索、RAG与向量召回",
    ["rag", "knowledge", "vector", "知识库", "知识检索", "向量"],
  ],
  [
    "memory_knowledge/notes",
    "memory_knowledge",
    "长期记忆、笔记与日记管理",
    ["memory", "diary", "note", "notes", "记忆", "笔记", "日记"],
  ],
  [
    "agent_task/agents",
    "agent_task",
    "智能代理协作、任务委派与子代理调用",
    ["agent", "agents", "subagent", "代理", "任务委派"],
  ],
  [
    "agent_task/scheduling",
    "agent_task",
    "定时任务、工作流与计划调度",
    [
      "schedule",
      "scheduler",
      "workflow",
      "cron",
      "定时",
      "调度",
      "工作流",
      "任务计划",
    ],
  ],
  [
    "communication/email",
    "communication",
    "邮件发送、读取与邮箱管理",
    ["email", "mail", "邮件", "邮箱"],
  ],
  [
    "communication/messaging",
    "communication",
    "即时消息、通知推送与社交通信",
    [
      "message",
      "notification",
      "telegram",
      "wechat",
      "forum",
      "消息",
      "通知",
      "推送",
    ],
  ],
  [
    "data/database",
    "data",
    "数据库查询、SQL与结构化数据存储",
    ["database", "sql", "sqlite", "数据库"],
  ],
  [
    "data/spreadsheet",
    "data",
    "电子表格、Excel与CSV数据处理",
    ["csv", "excel", "spreadsheet", "电子表格", "表格处理"],
  ],
  [
    "data/analysis",
    "data",
    "数据分析、统计计算与可视化",
    [
      "data analysis",
      "statistics",
      "visualization",
      "数据分析",
      "统计",
      "可视化",
    ],
  ],
].map(([category, parent, description, keywords]) => ({
  category,
  parent,
  description,
  keywords,
})) as DynamicToolsCategoryRule[];

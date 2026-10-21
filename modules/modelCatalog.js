'use strict';

/**
 * 模型目录分类（本地新增）
 *
 * 背景：`/v1/models` 原来把上游返回的模型**原样透传**，于是 Google 的 63 个模型
 * （tts / nano-banana / veo / lyria / embedding / robotics…）全都挤进聊天客户端的
 * 模型下拉框。OpenAI 系同理（gpt-image / whisper / text-embedding / dall-e / sora）。
 *
 * 这里按 **模型名模式** 分类，不依赖具体厂商清单 —— 换任何 OpenAI 兼容上游都能用：
 *   chat      = 没有命中任何非对话规则（默认显示）
 *   image     = 生图
 *   video     = 视频生成
 *   music     = 音乐生成
 *   speech    = TTS / 语音转写 / 音频对话
 *   live      = 实时双向语音（Live / Realtime API）
 *   embedding = 向量
 *   other     = 机器人、computer-use、问答检索、审核、重排等
 *
 * 规则顺序很重要：先匹配更具体的类别（embedding → image → video → music → speech → live → other），
 * 例如 `lyria-realtime-exp` 必须落在 music 而不是 live。
 */

const CATEGORY_RULES = [
    {
        category: 'embedding',
        pattern: /embed|text-embedding|(^|[-_/])(bge|voyage|jina)([-_/]|$)/i
    },
    {
        category: 'image',
        // gemini-*-image、gpt-image-1、dall-e-3、flux、nano-banana、imagen、seedream…
        pattern: /(^|[-_/])(image|images|imagen|dall-e|flux|stable-diffusion|sd3|sd-3|seedream|kolors|midjourney)([-_/]|$)|nano-banana|gpt-image/i
    },
    {
        category: 'video',
        pattern: /(^|[-_/])(veo|sora|kling|hailuo|runway|pika|video)([-_/]|$)/i
    },
    {
        category: 'music',
        pattern: /(^|[-_/])(lyria|music|suno|udio|song)([-_/]|$)/i
    },
    {
        category: 'speech',
        pattern: /(^|[-_/])(tts|audio|voice|speech|whisper|transcribe)([-_/]|$)|native-audio/i
    },
    {
        category: 'live',
        pattern: /(^|[-_/])(live|realtime)([-_/]|$)|live-translate/i
    },
    {
        category: 'other',
        // deep-research 走的是独立研究 API，不在 chat/completions 上；aqa 走 generateAnswer。
        pattern: /robotics|computer-use|deep-research|(^|[-_/])aqa([-_/]|$)|moderation|rerank|(^|[-_/])guard([-_/]|$)/i
    }
];

const CHAT_CATEGORY = 'chat';

/**
 * 给单个模型 ID 归类。
 * @param {string} modelId 例如 `models/gemini-3.1-flash-image` 或 `gpt-4o-mini-tts`
 * @returns {string} 分类名，未命中任何规则时返回 'chat'
 */
function classifyModelId(modelId) {
    const id = String(modelId || '').trim();
    if (!id) return CHAT_CATEGORY;
    for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(id)) return rule.category;
    }
    return CHAT_CATEGORY;
}

/**
 * 去掉 Gemini 兼容层返回的 `models/` 命名空间前缀，让下拉框里显示干净的名字。
 * 只处理「整段前缀」，不动带自定义路径的 ID。
 */
function stripModelNamespace(modelId) {
    return String(modelId || '').replace(/^models\//, '');
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function readOptions(query = {}) {
    const requestedCategory = typeof query.category === 'string' ? query.category.trim().toLowerCase() : '';
    // 显式 ?category=xxx 优先；否则按 MODEL_LIST_MODE。
    // 缺省 all = 保持上游原有行为（全量透传），需要过滤时在 config.env 里设 chat。
    const mode = String(process.env.MODEL_LIST_MODE || 'all').trim().toLowerCase();

    return {
        // 显式 ?category=xxx 优先；否则按 MODEL_LIST_MODE（缺省 chat，填 all 则全量透传）
        category: requestedCategory || (mode === 'all' ? 'all' : CHAT_CATEGORY),
        // 强制显示 / 强制隐藏：无论配置里写 `gemini-2.5-pro` 还是 `models/gemini-2.5-pro` 都能匹配
        hide: parseList(process.env.MODEL_LIST_HIDE).map(stripModelNamespace),
        show: parseList(process.env.MODEL_LIST_SHOW).map(stripModelNamespace),
        stripNamespace: String(process.env.MODEL_LIST_STRIP_NAMESPACE || 'true').toLowerCase() !== 'false'
    };
}

/**
 * 过滤 / 标注模型列表。
 *
 * 返回结构保持 OpenAI `/v1/models` 的形状，只在每个模型上多一个 `vcp_category` 字段，
 * 客户端可以按它分组，不认这个字段的客户端照常工作。
 *
 * @param {{object?: string, data?: Array}} modelsData 上游返回的模型列表
 * @param {object} [query] 请求的 query（支持 ?category=image 等）
 * @returns {{object: string, data: Array}}
 */
function filterModelList(modelsData, query = {}) {
    const options = readOptions(query);
    const source = modelsData && Array.isArray(modelsData.data) ? modelsData.data : [];

    const decorated = source
        .filter(model => model && typeof model === 'object' && model.id)
        .map(model => {
            const sourceId = model.id;
            const category = classifyModelId(sourceId);
            const displayId = options.stripNamespace ? stripModelNamespace(sourceId) : sourceId;
            return {
                sourceId,
                model: { ...model, id: displayId, vcp_category: category }
            };
        });

    const showSet = new Set(options.show);
    const hideSet = new Set(options.hide);

    const filtered = decorated
        .filter(({ model, sourceId }) => {
            const candidateIds = [sourceId, model.id, stripModelNamespace(sourceId)];
            if (candidateIds.some(id => showSet.has(id))) return true;   // 强制显示优先
            if (candidateIds.some(id => hideSet.has(id))) return false;  // 强制隐藏
            if (options.category === 'all') return true;
            return model.vcp_category === options.category;
        })
        .map(({ model }) => model);

    return {
        ...(modelsData && typeof modelsData === 'object' ? modelsData : {}),
        object: 'list',
        data: filtered
    };
}

module.exports = {
    CHAT_CATEGORY,
    CATEGORY_RULES,
    classifyModelId,
    stripModelNamespace,
    filterModelList
};

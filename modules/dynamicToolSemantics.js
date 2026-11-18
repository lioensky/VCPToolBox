// Semantic boundaries are deliberately coarser than tokenizer or Segmenter words.
const DEFAULT_CATEGORY_RULES = [
    ['search/web', 'search', '网页搜索、互联网资料查询与网页检索', ['web search', 'web pages', 'search the web', 'search web', 'google', 'tavily', 'serp', '网页搜索', '网页检索', '互联网搜索', '网络搜索']],
    ['search/academic', 'search', '学术论文、文献与引用检索', ['academic', 'paper', 'papers', 'citation', 'citations', 'arxiv', 'scholar', '学术', '论文', '文献']],
    ['search/browser', 'search', '浏览器自动化、网页导航、页面交互与内容抓取', ['browser', 'playwright', 'puppeteer', 'web scraping', '浏览器', '页面交互', '网页抓取']],
    ['file_code/file_read', 'file_code', '文件读取、目录浏览与本地文件检索', ['read files', 'read file', 'file read', 'directory', 'filesystem', 'file search', '读取文件', '文件读取', '目录', '文件检索']],
    ['file_code/file_edit', 'file_code', '文件编辑、写入文件与补丁应用', ['edit files', 'edit file', 'file edit', 'write files', 'write file', 'patch', 'patches', '文件编辑', '编辑文件', '写入文件', '补丁']],
    ['file_code/code_analysis', 'file_code', '代码分析、符号查询、依赖与调用关系分析', ['analyze code', 'code analysis', 'code dependencies', 'symbols', '代码分析', '代码依赖', '符号查询', '调用关系']],
    ['file_code/execution', 'file_code', '终端命令、脚本与代码执行', ['terminal', 'shell', 'powershell', 'execute code', 'run code', '代码执行', '运行脚本', '终端', '执行命令']],
    ['file_code/version_control', 'file_code', '版本控制、Git仓库与代码差异管理', ['git', 'repository', 'repo', 'version control', '版本控制', '代码仓库']],
    ['image_media/image_generation', 'image_media', '图像生成、绘画与图片编辑', ['image generation', 'generate image', 'generate images', 'text to image', 'image editing', '图像生成', '图片生成', '绘图', '图片编辑']],
    ['image_media/image_analysis', 'image_media', '图像识别、OCR与截图视觉分析', ['ocr', 'image recognition', 'image analysis', 'screenshot', '图像识别', '图片识别', '截图', '图像分析']],
    ['image_media/tts', 'image_media', '文本转语音、语音合成与朗读', ['tts', 'text to speech', 'text-to-speech', 'speech synthesis', '文本转语音', '语音合成', '朗读']],
    ['image_media/transcription', 'image_media', '语音识别、音频转写与字幕', ['asr', 'transcription', 'speech recognition', '语音识别', '音频转写', '字幕']],
    ['image_media/video_generation', 'image_media', '视频生成、文生视频与视频制作', ['video generation', 'generate video', 'generate videos', 'text to video', 'text-to-video', '视频生成', '生成视频', '文生视频']],
    ['image_media/media_playback', 'image_media', '音乐、音频和视频播放控制', ['music', 'playback', 'audio player', 'video player', '音乐', '播放控制', '媒体播放']],
    ['memory_knowledge/retrieval', 'memory_knowledge', '知识库检索、RAG与向量召回', ['rag', 'knowledge', 'vector', '知识库', '知识检索', '向量']],
    ['memory_knowledge/notes', 'memory_knowledge', '长期记忆、笔记与日记管理', ['memory', 'diary', 'note', 'notes', '记忆', '笔记', '日记']],
    ['agent_task/agents', 'agent_task', '智能代理协作、任务委派与子代理调用', ['agent', 'agents', 'subagent', '代理', '任务委派']],
    ['agent_task/scheduling', 'agent_task', '定时任务、工作流与计划调度', ['schedule', 'scheduler', 'workflow', 'cron', '定时', '调度', '工作流', '任务计划']],
    ['communication/email', 'communication', '邮件发送、读取与邮箱管理', ['email', 'mail', '邮件', '邮箱']],
    ['communication/messaging', 'communication', '即时消息、通知推送与社交通信', ['message', 'notification', 'telegram', 'wechat', 'forum', '消息', '通知', '推送']],
    ['data/database', 'data', '数据库查询、SQL与结构化数据存储', ['database', 'sql', 'sqlite', '数据库']],
    ['data/spreadsheet', 'data', '电子表格、Excel与CSV数据处理', ['csv', 'excel', 'spreadsheet', '电子表格', '表格处理']],
    ['data/analysis', 'data', '数据分析、统计计算与可视化', ['data analysis', 'statistics', 'visualization', '数据分析', '统计', '可视化']]
].map(([category, parent, description, keywords]) => ({ category, parent, description, keywords }));

const DEFAULT_CONFIG = Object.freeze({
    version: 2, enabled: true, placeholder: '{{VCPDynamicTools}}',
    maxBriefListItems: 120, maxExpandedPlugins: 4, maxForcedCategoryPlugins: 12,
    maxInjectionChars: 16000, classificationDebounceMs: 1000, classifierTimeoutMs: 30000,
    useRagEmbeddings: true,
    manualOverrides: { excludedOriginKeys: [], pinnedOriginKeys: [], categoryAliases: {}, descriptionOverrides: {} },
    summary: { lightListTokenBudget: 15, briefTokenBudget: 6, minBriefTokenBudget: 3 },
    classification: { maxCategories: 3, embeddingThreshold: 0.34, categoryRules: DEFAULT_CATEGORY_RULES },
    smallModel: { enabled: false, model: '', maxRetries: 2, retryDelayMs: 250, maxTokens: 2048, temperature: 0.1 }
});

function invalid(field) {
    const error = new Error(`动态工具配置无效：${field}`);
    error.status = 400; error.statusCode = 400;
    throw error;
}
function object(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
    return value;
}
function text(value, field, max = 100, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid(field);
    return value.trim();
}
function number(value, field, min, max, integer = true) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(field);
    return value;
}
function strings(value, field, max = 2000, allowEmpty = true) {
    if (!Array.isArray(value) || value.length > max || (!allowEmpty && !value.length)) invalid(field);
    return [...new Set(value.map((item) => text(item, field, 300)))];
}
function keys(value, allowed, field, ignored = []) {
    object(value, field);
    for (const key of Object.keys(value)) if (!allowed.includes(key) && !ignored.includes(key)) invalid(`${field}.${key}`);
}
function validateConfigPatch(patch) {
    keys(patch, Object.keys(DEFAULT_CONFIG), 'config');
    const out = {};
    const numeric = { maxBriefListItems: [1, 500], maxExpandedPlugins: [0, 50], maxForcedCategoryPlugins: [1, 100], maxInjectionChars: [1000, 120000], classificationDebounceMs: [0, 60000], classifierTimeoutMs: [100, 120000] };
    for (const [key, value] of Object.entries(patch)) {
        if (numeric[key]) out[key] = number(value, key, ...numeric[key]);
        else if (['enabled', 'useRagEmbeddings'].includes(key)) {
            if (typeof value !== 'boolean') invalid(key);
            out[key] = value;
        } else if (key === 'version') {
            if (value !== 1 && value !== 2) invalid(key);
            out.version = 2;
        } else if (key === 'placeholder') {
            if (value !== DEFAULT_CONFIG.placeholder) invalid(key);
            out.placeholder = DEFAULT_CONFIG.placeholder;
        } else if (key === 'summary') {
            keys(value, Object.keys(DEFAULT_CONFIG.summary), key); out.summary = {};
            for (const [k, v] of Object.entries(value)) out.summary[k] = number(v, `summary.${k}`, 1, 200);
            const s = out.summary;
            if ((s.minBriefTokenBudget !== undefined && s.briefTokenBudget !== undefined && s.minBriefTokenBudget > s.briefTokenBudget) || (s.briefTokenBudget !== undefined && s.lightListTokenBudget !== undefined && s.briefTokenBudget > s.lightListTokenBudget) || (s.minBriefTokenBudget !== undefined && s.lightListTokenBudget !== undefined && s.minBriefTokenBudget > s.lightListTokenBudget)) invalid('summary: minBrief <= brief <= lightList');
        } else if (key === 'smallModel') {
            keys(value, Object.keys(DEFAULT_CONFIG.smallModel), key, ['useMainConfig', 'endpoint', 'apiKey', 'apiKeyEnv']); out.smallModel = {};
            for (const [k, v] of Object.entries(value)) {
                if (k === 'enabled') { if (typeof v !== 'boolean') invalid('smallModel.enabled'); out.smallModel.enabled = v; }
                if (k === 'model') out.smallModel.model = text(v, 'smallModel.model', 200, true);
                if (k === 'maxRetries') out.smallModel[k] = number(v, `smallModel.${k}`, 0, 5);
                if (k === 'retryDelayMs') out.smallModel[k] = number(v, `smallModel.${k}`, 0, 10000);
                if (k === 'maxTokens') out.smallModel[k] = number(v, `smallModel.${k}`, 64, 8192);
                if (k === 'temperature') out.smallModel[k] = number(v, `smallModel.${k}`, 0, 2, false);
            }
        } else if (key === 'classification') {
            keys(value, Object.keys(DEFAULT_CONFIG.classification), key); out.classification = {};
            if ('maxCategories' in value) out.classification.maxCategories = number(value.maxCategories, 'classification.maxCategories', 1, 20);
            if ('embeddingThreshold' in value) out.classification.embeddingThreshold = number(value.embeddingThreshold, 'classification.embeddingThreshold', 0, 1, false);
            if ('categoryRules' in value) {
                if (!Array.isArray(value.categoryRules) || !value.categoryRules.length || value.categoryRules.length > 100) invalid('classification.categoryRules');
                const seen = new Set();
                out.classification.categoryRules = value.categoryRules.map((rule) => {
                    keys(rule, ['category', 'parent', 'description', 'keywords'], 'categoryRules');
                    const category = text(rule.category, 'categoryRules.category');
                    if (seen.has(category)) invalid('categoryRules.category 重复'); seen.add(category);
                    const normalized = { category, description: text(rule.description, 'categoryRules.description', 2000), keywords: strings(rule.keywords, 'categoryRules.keywords', 100, false) };
                    if (rule.parent !== undefined) normalized.parent = text(rule.parent, 'categoryRules.parent');
                    return normalized;
                });
            }
        } else if (key === 'manualOverrides') {
            keys(value, Object.keys(DEFAULT_CONFIG.manualOverrides), key); out.manualOverrides = {};
            for (const [k, v] of Object.entries(value)) {
                if (['excludedOriginKeys', 'pinnedOriginKeys'].includes(k)) out.manualOverrides[k] = strings(v, `manualOverrides.${k}`);
                else if (k === 'categoryAliases') {
                    object(v, 'categoryAliases'); out.manualOverrides[k] = Object.fromEntries(Object.entries(v).map(([alias, target]) => [text(alias, 'categoryAliases.key'), text(target, 'categoryAliases.value')]));
                } else {
                    object(v, 'descriptionOverrides');
                    if (Object.keys(v).length > 2000) invalid('descriptionOverrides');
                    out.manualOverrides[k] = Object.fromEntries(Object.entries(v).map(([origin, override]) => {
                        text(origin, 'descriptionOverrides.origin', 300); keys(override, ['brief', 'fullDescription', 'categories', 'keywords'], 'descriptionOverrides');
                        const normalized = {};
                        for (const [field, entry] of Object.entries(override)) normalized[field] = ['categories', 'keywords'].includes(field) ? strings(entry, `descriptionOverrides.${field}`, 100) : text(entry, `descriptionOverrides.${field}`, field === 'brief' ? 4000 : 120000, true);
                        return [origin, normalized];
                    }));
                }
            }
        }
    }
    return out;
}
function mergeConfig(base, ...patches) {
    const merged = JSON.parse(JSON.stringify(base));
    for (const patch of patches) {
        if (patch === undefined || patch === null) continue;
        const normalized = validateConfigPatch(patch);
        for (const [key, value] of Object.entries(normalized)) {
            if (['manualOverrides', 'summary', 'classification', 'smallModel'].includes(key)) merged[key] = { ...merged[key], ...value };
            else merged[key] = value;
        }
    }
    return validateConfigPatch(merged);
}

function estimateTokenCount(value) {
    return (String(value || '').match(/[A-Za-z0-9_.-]+|[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
}
function truncateToTokenBudget(value, budget) {
    const source = String(value || '').trim();
    if (estimateTokenCount(source) <= budget) return source;
    const phrases = [];
    let phraseStart = 0;
    for (let i = 0; i < source.length; i++) {
        const internalDot = source[i] === '.' && /[A-Za-z0-9_-]/.test(source[i - 1] || '') && /[A-Za-z0-9_-]/.test(source[i + 1] || '');
        if (internalDot || !/[，。；！？,;.!?\n]/u.test(source[i])) continue;
        phrases.push(source.slice(phraseStart, i + 1));
        phraseStart = i + 1;
    }
    if (phraseStart < source.length) phrases.push(source.slice(phraseStart));
    let result = '';
    for (const phrase of phrases) {
        if (estimateTokenCount(result + phrase) > budget && result) break;
        if (estimateTokenCount(result + phrase) > budget && !/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(phrase)) {
            const words = [...phrase.matchAll(/\S+/g)];
            if (words.length > budget) return phrase.slice(0, words[budget - 1].index + words[budget - 1][0].length).trimEnd() + '...';
        }
        result += phrase;
        if (estimateTokenCount(result) >= budget) break;
    }
    return result.trim();
}
function hasFragmentedChinese(text) {
    return /(?:[\u3400-\u9FFF]\s+){2,}[\u3400-\u9FFF]/u.test(String(text || ''));
}
function keywordMatches(value, keyword) {
    const lower = String(value).toLowerCase(), needle = keyword.toLowerCase();
    if (!/^[\x00-\x7F]+$/.test(needle)) return lower.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(lower);
}

function stripTrailingCommas(source) {
    let result = '', quoted = false, escaped = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (quoted) {
            result += ch;
            if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false;
        } else if (ch === '"') { quoted = true; result += ch; }
        else if (ch !== ',' || !/^\s*[}\]]/.test(source.slice(i + 1))) result += ch;
    }
    return result;
}
function parseModelContent(content, validate = validateClassification) {
    if (content && typeof content === 'object' && !Array.isArray(content)) return validate(content);
    if (Array.isArray(content)) content = content.map((part) => typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')).join('');
    if (typeof content !== 'string') throw new Error('格式错误：缺少 JSON 对象');
    let validationError;
    // Consider every balanced candidate; explanatory objects must not hide the answer.
    for (let start = 0; start < content.length; start++) {
        if (content[start] !== '{') continue;
        let depth = 0, quoted = false, escaped = false;
        for (let end = start; end < content.length; end++) {
            const ch = content[end];
            if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
            if (ch === '"') quoted = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                let candidate;
                try { candidate = JSON.parse(stripTrailingCommas(content.slice(start, end + 1))); } catch { break; }
                try { return validate(candidate); } catch (error) { validationError = error; break; }
            }
        }
    }
    throw validationError || new Error('格式错误：未找到完整 JSON 对象');
}
function validateClassification(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('结构错误：需要 JSON 对象');
    if (typeof result.brief !== 'string' || !result.brief.trim()) throw new Error('结构错误：brief 必须为非空 string');
    for (const field of ['categories', 'keywords']) if (!Array.isArray(result[field]) || !result[field].length || result[field].some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`结构错误：${field} 必须为非空 string[]`);
    if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error('结构错误：confidence 必须为 0..1 number');
    return result;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_CATEGORY_RULES, validateConfigPatch, mergeConfig, estimateTokenCount, truncateToTokenBudget, hasFragmentedChinese, keywordMatches, parseModelContent, validateClassification };

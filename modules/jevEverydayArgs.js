'use strict';

// Deterministic mappings only: no tool execution or model-generated field values.
// 结构为数据驱动：部署者可按需追加自己的插件条目（actions + schemas + supported）。
const actions = {
    ScheduleManager: {
        AddSchedule: ['添加日程', '安排日程'], ListSchedules: ['查看日程', '日程列表', '列出日程'],
        DeleteSchedule: ['删除日程', '取消日程'], ClearExpired: ['清理过期日程']
    }
};
const schemas = {
    ScheduleManager: {
        AddSchedule: ['content', ['time'], ['time', 'content']], ListSchedules: [null, [], []],
        DeleteSchedule: ['id', [], ['id']], ClearExpired: [null, [], []]
    }
};
const supported = new Set(['ScheduleManager', 'AgentAssistant', 'GPTImageGen', 'DoubaoGen']);
const aliases = { 操作: 'command', 命令: 'command', 时间: 'time',
    目标: 'agent_name', agent: 'agent_name', 联络: 'agent_name', 定时: 'timely_contact', 上下文: 'river',
    查询委托: 'query_delegation', 取消委托: 'cancel_delegation', 质量: 'quality', 尺寸: 'size', 分辨率: 'resolution' };

function buildEverydayArgs(plugin, parsed, inherited = {}) {
    if (!supported.has(plugin)) return null;
    const args = {}, positions = [], imagePlugin = /^(GPTImageGen|DoubaoGen)$/.test(plugin);
    let immediate = false;
    if (/(?:不要|禁止|别|无需|不必)(?:再|去|立即|立刻|马上|现在|帮我)*(?:执行|发送|联络|通讯|委托|创建|删除|添加|清理|回复|生成|修改)/.test(parsed.intentText)) throw new Error('JEV 调用含否定动作，未执行。');
    const put = (key, value) => {
        if (Object.hasOwn(args, key)) throw new Error(`JEV ${key} 重复。`);
        args[key] = value;
    };
    for (const raw of parsed.constraints) {
        const text = plugin === 'AgentAssistant' ? raw.trim().replace(/^(?:模式|mode)[:：]\s*/, '') : raw.trim();
        if (plugin === 'AgentAssistant' && ['即时联络', '即时通讯', '立即联络', '立即通讯'].includes(text)) immediate = true;
        else if (plugin === 'AgentAssistant' && ['临时通讯', '临时联络', '临时聊天'].includes(text)) put('temporary_contact', 'true');
        else if (plugin === 'AgentAssistant' && ['异步委托', '后台委托', '异步任务'].includes(text)) put('task_delegation', 'true');
        else if (plugin === 'AgentAssistant' && /^(查询委托|取消委托)\s+\S+$/.test(text)) {
            const [label, id] = text.split(/\s+/); put(aliases[label], id);
        }
        else if (/^\d{4}-\d{2}-\d{2}[ -]\d{2}:\d{2}$/.test(text)) put(plugin === 'AgentAssistant' ? 'timely_contact' : 'time', text);
        else if (imagePlugin && /^\d+x\d+$/.test(text)) put(plugin === 'DoubaoGen' ? 'resolution' : 'size', text);
        else if (plugin === 'DoubaoGen' && /^(1K|2K|4K|adaptive)$/.test(text)) put('resolution', text);
        else if (plugin === 'GPTImageGen' && /^(高质量|高清|精细)$/.test(text)) put('quality', 'high');
        else {
            const pair = text.match(/^([^:：]+)[:：]\s*([\s\S]+)$/);
            if (pair) put(aliases[pair[1].trim()] || pair[1].trim(), pair[2].trim());
            else positions.push(text);
        }
    }
    let primary, slots = [], required = [], optional = [];
    if (schemas[plugin]) {
        if (args.command && !schemas[plugin][args.command]) {
            const operation = Object.entries(actions[plugin]).find(([id, verbs]) => id.toLowerCase() === args.command.toLowerCase() || verbs.includes(args.command));
            if (operation) args.command = operation[0];
        }
        const matches = Object.entries(actions[plugin]).filter(([, verbs]) => verbs.some(v => parsed.intentText.includes(v)));
        if (args.command && matches.some(([id]) => id !== args.command)) throw new Error('JEV 操作参数与句子动作冲突，请只保留一个操作。');
        if (!args.command) {
            if (matches.length !== 1) throw new Error(`JEV ${plugin} 请指定 [操作:命令名]。`);
            args.command = matches[0][0];
        }
        const schema = schemas[plugin][args.command];
        if (!schema) throw new Error(`JEV ${plugin} 不支持操作 ${args.command}。`);
        [primary, slots, required, optional = []] = schema;
    } else if (plugin === 'AgentAssistant') {
        if (immediate && (args.timely_contact || inherited.timely_contact || args.task_delegation === 'true' || args.query_delegation || args.cancel_delegation)) throw new Error('JEV 即时联络不能同时指定定时、异步委托或委托管理。');
        if (args.query_delegation || args.cancel_delegation) {
            if (args.query_delegation && args.cancel_delegation) throw new Error('JEV 查询和取消委托必须分开调用。');
            required = [args.query_delegation ? 'query_delegation' : 'cancel_delegation'];
            // Historical calls supplied a recipient and descriptive body even for status queries.
            primary = 'prompt'; slots = ['agent_name']; optional = ['prompt', 'agent_name'];
        } else {
            primary = 'prompt'; slots = ['agent_name']; required = ['agent_name', 'prompt'];
            optional = ['temporary_contact', 'task_delegation', 'timely_contact', 'inject_tools', 'river'];
        }
    } else {
        const images = parsed.imageUrls || [];
        if (images.length) put('image', images.length === 1 ? images[0] : images);
        if (typeof args.image === 'string' && args.image.startsWith('[')) {
            try { args.image = JSON.parse(args.image); } catch { throw new Error('JEV image 数组格式无效。'); }
        }
        const imageCount = Array.isArray(args.image) ? args.image.length : args.image ? 1 : 0;
        const gpt = plugin === 'GPTImageGen';
        args.command ||= gpt ? (imageCount ? 'GPTEditImage' : 'GPTGenerateImage') : (imageCount > 1 ? 'compose' : imageCount ? 'edit' : 'generate');
        const valid = gpt ? ['GPTGenerateImage', 'GPTEditImage', 'GPTCreateVariation', 'GPTListModels'] : ['generate', 'edit', 'compose', 'group', 'list_models'];
        if (!valid.includes(args.command)) throw new Error(`JEV ${plugin} 不支持操作 ${args.command}。`);
        if (!['GPTListModels', 'list_models'].includes(args.command)) {
            if (args.command !== 'GPTCreateVariation') { primary = 'prompt'; required.push('prompt'); }
            if (['GPTEditImage', 'GPTCreateVariation', 'edit', 'compose'].includes(args.command)) required.push('image');
            optional = gpt ? ['size', 'quality', 'background', 'n', 'response_format'] : ['resolution', 'model', 'seed', 'guidance_scale', 'watermark', 'output_format', 'showbase64', ...(args.command === 'group' ? ['max_images'] : [])];
            if (args.command === 'group') optional.push('image');
        }
    }
    if (parsed.primary.length) {
        if (!primary) throw new Error('JEV 此操作不接受【正文】。');
        put(primary, parsed.primary.join('\n'));
    }
    for (const key of slots) if (positions.length && args[key] === undefined) put(key, positions.shift());
    if (positions.length) throw new Error(`JEV 无法识别 [${positions[0]}]，请用 [参数名:值]。`);
    const allowed = new Set([...required, ...optional, 'maid', ...(plugin === 'AgentAssistant' ? [] : ['command'])]);
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`JEV ${plugin} 当前操作不支持 ${key}。`);
    if (!args.maid && inherited.maid) args.maid = inherited.maid;
    for (const key of required) if (args[key] === undefined || String(args[key]).trim() === '') throw new Error(`JEV ${plugin} 缺少 ${key}。`);
    if (args.image && typeof args.image === 'string' && args.image.startsWith('[')) {
        try { args.image = JSON.parse(args.image); } catch { throw new Error('JEV image 数组格式无效。'); }
    }
    if (args.image) {
        const images = Array.isArray(args.image) ? args.image : [args.image];
        if (!images.length || images.some(v => typeof v !== 'string' || !v.trim())) throw new Error('JEV image 必须包含有效图片地址。');
        if (args.command === 'compose' && images.length < 2) throw new Error('JEV compose 至少需要两张图片。');
        if (args.command === 'GPTCreateVariation' && images.length !== 1) throw new Error('JEV 图片变体仅接受单张图片。');
    }
    for (const key of ['temporary_contact', 'task_delegation', 'include_read', 'watermark', 'showbase64']) {
        if (args[key] !== undefined && !['true', 'false'].includes(args[key])) throw new Error(`JEV ${key} 只能为 true/false。`);
    }
    const enums = { quality: ['low', 'medium', 'high', 'auto'], background: ['opaque', 'auto', 'transparent'], response_format: ['url', 'b64_json'], output_format: ['png', 'jpeg'] };
    for (const [key, values] of Object.entries(enums)) if (args[key] !== undefined && !values.includes(args[key])) throw new Error(`JEV ${key} 值无效。`);
    for (const [key, min, max] of [['n', 1, 4], ['max_images', 1, 15], ['flowlock_heartbeat', 1, 86400], ['days', 1, 36500]]) {
        if (args[key] !== undefined && (!/^\d+$/.test(args[key]) || +args[key] < min || +args[key] > max)) throw new Error(`JEV ${key} 必须为 ${min}–${max} 的整数。`);
    }
    if (args.guidance_scale !== undefined && (!/^(\d+(\.\d+)?)$/.test(args.guidance_scale) || +args.guidance_scale > 10)) throw new Error('JEV guidance_scale 必须在 0–10。');
    if (args.seed !== undefined && !/^-?\d+$/.test(args.seed)) throw new Error('JEV seed 必须为整数。');
    if (args.size && !/^[1-9]\d*x[1-9]\d*$/.test(args.size)) throw new Error('JEV size 使用 WIDTHxHEIGHT。');
    if (args.resolution && !/^(1K|2K|4K|adaptive|[1-9]\d*x[1-9]\d*)$/.test(args.resolution)) throw new Error('JEV resolution 格式无效。');
    if (args.river && !/^(full|text|last:\d+|semantic:\d+)$/.test(args.river)) throw new Error('JEV 上下文格式无效。');
    for (const key of ['time', 'timely_contact']) if (args[key]) {
        const value = args[key].replace(/^(\d{4}-\d{2}-\d{2})-/, '$1 ');
        const date = value.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(value) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error(`JEV ${key} 请使用有效的 YYYY-MM-DD HH:mm。`);
        args[key] = key === 'time' ? value : value.replace(' ', '-');
    }
    return args;
}
module.exports = { buildEverydayArgs };

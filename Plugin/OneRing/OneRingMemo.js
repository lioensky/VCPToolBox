'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./OneRingDB.js');

const MEMO_TRIGGER_REGEX = /\[\[OneRingMemo::([^:\]\r\n]+?)\]\]/g;
const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    autoGenerate: false,
    updateIntervalMinutes: 360,
    timelineDays: 3,
    fallbackMessageCount: 30,
    model: '',
    maxContextTokens: 32000,
    maxOutputTokens: 2000
});

let projectBasePath = '';
let runtimeConfig = {};
const generationLocks = new Map();
const generationStatuses = new Map();

function createGenerationStatus(agentName, reason) {
    return {
        agentName,
        running: true,
        phase: 'preparing',
        phaseLabel: '准备摘要源数据',
        completed: 0,
        total: 1,
        mergeRound: 0,
        reason,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: null,
        error: null
    };
}

function updateGenerationStatus(agentName, patch) {
    const current = generationStatuses.get(agentName) || createGenerationStatus(agentName, patch.reason || 'manual');
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    generationStatuses.set(agentName, next);
    return next;
}

function getGenerationStatus(agentName) {
    const status = generationStatuses.get(agentName);
    return status ? { ...status } : {
        agentName,
        running: false,
        phase: 'idle',
        phaseLabel: '空闲',
        completed: 0,
        total: 0,
        mergeRound: 0,
        reason: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        error: null
    };
}

function isGenerating(agentName) {
    return generationLocks.has(agentName);
}

function normalizePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeConfig(raw = {}) {
    return {
        enabled: raw.enabled !== false,
        autoGenerate: raw.autoGenerate === true,
        updateIntervalMinutes: normalizePositiveInteger(raw.updateIntervalMinutes, DEFAULT_CONFIG.updateIntervalMinutes, 1, 525600),
        timelineDays: normalizePositiveInteger(raw.timelineDays, DEFAULT_CONFIG.timelineDays, 1, 7),
        fallbackMessageCount: normalizePositiveInteger(raw.fallbackMessageCount, DEFAULT_CONFIG.fallbackMessageCount, 1, 1000),
        model: String(raw.model || '').trim(),
        maxContextTokens: normalizePositiveInteger(raw.maxContextTokens, DEFAULT_CONFIG.maxContextTokens, 1024, 1000000),
        maxOutputTokens: normalizePositiveInteger(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 128, 100000)
    };
}

function configure(options = {}) {
    projectBasePath = options.projectBasePath || projectBasePath;
    runtimeConfig = options.runtimeConfig || runtimeConfig;
}

function getStoreDir() {
    return path.join(projectBasePath || path.join(__dirname, '..', '..'), 'Plugin', 'OneRing', 'memo');
}

function safeAgentFileName(agentName) {
    return encodeURIComponent(String(agentName || '').trim()).replace(/%/g, '_');
}

function getMemoPath(agentName) {
    return path.join(getStoreDir(), `${safeAgentFileName(agentName)}.json`);
}

function readMemo(agentName) {
    try {
        const value = JSON.parse(fs.readFileSync(getMemoPath(agentName), 'utf8'));
        return value && typeof value.summary === 'string' ? value : null;
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[OneRingMemo] Failed to read memo for "${agentName}":`, error.message);
        return null;
    }
}

function writeMemo(agentName, memo) {
    const dir = getStoreDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = getMemoPath(agentName);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(memo, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
    return memo;
}

function updateMemoText(agentName, summary) {
    if (isGenerating(agentName)) {
        const error = new Error(`Agent "${agentName}" 的摘要正在生成，完成前禁止人工覆写`);
        error.code = 'MEMO_GENERATION_IN_PROGRESS';
        throw error;
    }
    const previous = readMemo(agentName) || {};
    return writeMemo(agentName, {
        ...previous,
        agentName,
        summary: String(summary || ''),
        editedAt: new Date().toISOString(),
        source: 'manual'
    });
}

function listAgentNames() {
    const names = new Set();
    const dataDir = path.join(projectBasePath || path.join(__dirname, '..', '..'), 'Plugin', 'OneRing', 'data');
    try {
        for (const file of fs.readdirSync(dataDir)) {
            if (file.toLowerCase().endsWith('.db')) names.add(file.slice(0, -3));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[OneRingMemo] Failed to list OneRing databases:', error.message);
    }
    try {
        for (const file of fs.readdirSync(getStoreDir())) {
            if (!file.toLowerCase().endsWith('.json')) continue;
            const memo = JSON.parse(fs.readFileSync(path.join(getStoreDir(), file), 'utf8'));
            if (memo?.agentName) names.add(String(memo.agentName));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[OneRingMemo] Failed to list memo files:', error.message);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function extractTextParts(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.type === 'text' ? part.text || '' : '').join('');
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

function replaceLastMemoInContent(content, triggerText, replacement) {
    const replaceLast = text => {
        const index = text.lastIndexOf(triggerText);
        return index < 0 ? text : text.slice(0, index) + replacement + text.slice(index + triggerText.length);
    };
    if (typeof content === 'string') return replaceLast(content);
    if (Array.isArray(content)) {
        const result = content.map(part => ({ ...part }));
        for (let index = result.length - 1; index >= 0; index--) {
            if (result[index]?.type === 'text' && typeof result[index].text === 'string' && result[index].text.includes(triggerText)) {
                result[index].text = replaceLast(result[index].text);
                break;
            }
        }
        return result;
    }
    if (content && typeof content.text === 'string') return { ...content, text: replaceLast(content.text) };
    return content;
}

function injectMemo(messages) {
    if (!Array.isArray(messages)) return messages;
    let selected = null;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || message.role !== 'system') break;
        const text = extractTextParts(message.content);
        const matches = [...text.matchAll(new RegExp(MEMO_TRIGGER_REGEX.source, MEMO_TRIGGER_REGEX.flags))];
        if (matches.length > 0) selected = { index, match: matches[matches.length - 1] };
    }
    if (!selected) return messages;

    const agentName = selected.match[1].trim();
    const memo = readMemo(agentName);
    const replacement = memo?.summary?.trim() || '';
    const result = [...messages];
    result[selected.index] = {
        ...result[selected.index],
        content: replaceLastMemoInContent(result[selected.index].content, selected.match[0], replacement)
    };
    return result;
}

function formatLocalCutoff(days) {
    const cutoff = new Date(Date.now() - days * 86400000);
    const pad = value => String(value).padStart(2, '0');
    return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())} ${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
}

function selectSourceMessages(agentName, memoConfig) {
    const connection = db.getDb(agentName, projectBasePath);
    const cutoff = formatLocalCutoff(memoConfig.timelineDays);
    let rows = connection.prepare(
        `SELECT id, role, senderName, frontendSource, content, timestamp
         FROM messages WHERE agentName=? AND timestamp>=?
         ORDER BY timestamp ASC, id ASC`
    ).all(agentName, cutoff);

    if (rows.length < memoConfig.fallbackMessageCount) {
        rows = connection.prepare(
            `SELECT * FROM (
                SELECT id, role, senderName, frontendSource, content, timestamp
                FROM messages WHERE agentName=?
                ORDER BY timestamp DESC, id DESC LIMIT ?
             ) ORDER BY timestamp ASC, id ASC`
        ).all(agentName, memoConfig.fallbackMessageCount);
    }
    return rows;
}

function formatTimelineRows(rows, agentName) {
    return rows.map(row => {
        const sender = row.senderName || (row.role === 'assistant' ? agentName : '用户');
        const source = row.frontendSource ? ` @${row.frontendSource}` : '';
        return `[${row.timestamp}] [${row.role}] [来自${sender}${source}的发言]\n${row.content}`;
    }).join('\n\n');
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 3);
}

function splitByTokenBudget(text, tokenBudget) {
    if (estimateTokens(text) <= tokenBudget) return [text];
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        if (estimateTokens(paragraph) > tokenBudget) {
            if (current) chunks.push(current);
            const charBudget = Math.max(1000, tokenBudget * 3);
            for (let offset = 0; offset < paragraph.length; offset += charBudget) {
                chunks.push(paragraph.slice(offset, offset + charBudget));
            }
            current = '';
            continue;
        }
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (current && estimateTokens(candidate) > tokenBudget) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks.filter(Boolean);
}

async function callSummaryModel(model, systemPrompt, input, memoConfig) {
    const port = runtimeConfig.PORT || process.env.PORT || 3000;
    const key = runtimeConfig.Key || process.env.Key || '';
    if (!key) throw new Error('服务器 Key 未配置，无法调用本机摘要模型');
    if (!model) throw new Error('OneRingMemo 摘要模型未配置');

    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
            model,
            stream: false,
            max_tokens: memoConfig.maxOutputTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: input }
            ]
        })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`摘要模型返回 ${response.status}: ${text.slice(0, 500)}`);
    const payload = JSON.parse(text);
    const output = payload?.choices?.[0]?.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw new Error('摘要模型未返回有效文本');
    return output.trim();
}

async function recursivelySummarize(agentName, timeline, memoConfig, onProgress = () => {}) {
    const systemPrompt = `你是 OneRingMemo 客观短期时间线压缩器。请为 Agent「${agentName}」仅整理近期交互中明确发生、被观察或被直接陈述的事实。

必须遵守：
1. 只保留时间、人物、消息来源、实际事件、已执行操作、明确结果及客观状态变化。
2. 区分用户、Agent 与群聊中的其他发言者；群聊观点必须归属于具体发言者。
3. 某项内容存在争议、推测、预测或尚未验证时，只能客观记录“谁在何时表达或提出了什么”，不得把观点提升为事实。
4. 未完成事项仅可记录为“曾提出但当前输入中没有完成记录”的客观状态，不得生成建议、计划、提醒或承诺。
5. 禁止输出你的主观立场和主观认知，只陈述客观时间线事实和实际AI表达观点。
6. 不得替主 Agent 作判断，不得推断人物长期偏好或意图，不得使用命令式措辞，不得虚构。
7. 使用简洁的按日期时间线；没有明确日期时标记为“时间未明确”。仅输出客观时间线正文，不输出分析、结论或额外章节。`;
    const mergePrompt = `${systemPrompt}

输入内容是若干分段产生的客观时间线。请只做事实去重、时间排序和同一事件合并。递归合并时仍须删除决定、判断、偏好、评价、建议、承诺、待办和可续写锚点，禁止从多个事实推导新结论。`;
    const inputBudget = Math.max(512, memoConfig.maxContextTokens - memoConfig.maxOutputTokens - 800);
    let chunks = splitByTokenBudget(timeline, inputBudget);
    let summaries = [];
    onProgress({
        phase: 'summarizing',
        phaseLabel: `正在生成第一轮分段摘要（0/${chunks.length}）`,
        completed: 0,
        total: chunks.length,
        mergeRound: 0
    });
    for (let index = 0; index < chunks.length; index++) {
        summaries.push(await callSummaryModel(
            memoConfig.model,
            systemPrompt,
            `这是第 ${index + 1}/${chunks.length} 段时间线：\n\n${chunks[index]}`,
            memoConfig
        ));
        onProgress({
            phase: 'summarizing',
            phaseLabel: `正在生成第一轮分段摘要（${index + 1}/${chunks.length}）`,
            completed: index + 1,
            total: chunks.length,
            mergeRound: 0
        });
    }
    let mergeRound = 0;
    while (summaries.length > 1 || estimateTokens(summaries[0] || '') > inputBudget) {
        mergeRound++;
        const mergedInput = summaries.map((summary, index) => `【分段摘要 ${index + 1}】\n${summary}`).join('\n\n');
        const mergeChunks = splitByTokenBudget(mergedInput, inputBudget);
        const next = [];
        onProgress({
            phase: 'merging',
            phaseLabel: `正在进行第 ${mergeRound} 轮递归合并（0/${mergeChunks.length}）`,
            completed: 0,
            total: mergeChunks.length,
            mergeRound
        });
        for (let index = 0; index < mergeChunks.length; index++) {
            next.push(await callSummaryModel(memoConfig.model, mergePrompt, mergeChunks[index], memoConfig));
            onProgress({
                phase: 'merging',
                phaseLabel: `正在进行第 ${mergeRound} 轮递归合并（${index + 1}/${mergeChunks.length}）`,
                completed: index + 1,
                total: mergeChunks.length,
                mergeRound
            });
        }
        if (next.length === summaries.length && next.join('').length >= summaries.join('').length) {
            return callSummaryModel(memoConfig.model, mergePrompt, mergedInput.slice(0, inputBudget * 3), memoConfig);
        }
        summaries = next;
    }
    return summaries[0] || '';
}

async function generateMemo(agentName, rawConfig, reason = 'manual') {
    const memoConfig = normalizeConfig(rawConfig);
    if (!memoConfig.enabled) throw new Error('OneRingMemo 已禁用');
    if (generationLocks.has(agentName)) {
        const error = new Error(`Agent "${agentName}" 的摘要生成任务已在运行`);
        error.code = 'MEMO_GENERATION_IN_PROGRESS';
        throw error;
    }

    generationStatuses.set(agentName, createGenerationStatus(agentName, reason));
    const task = (async () => {
        const rows = selectSourceMessages(agentName, memoConfig);
        if (rows.length === 0) throw new Error(`Agent "${agentName}" 暂无可总结的 OneRing 消息`);
        updateGenerationStatus(agentName, {
            phase: 'summarizing',
            phaseLabel: `已读取 ${rows.length} 条源消息，准备分段摘要`
        });
        const summary = await recursivelySummarize(
            agentName,
            formatTimelineRows(rows, agentName),
            memoConfig,
            progress => updateGenerationStatus(agentName, progress)
        );
        updateGenerationStatus(agentName, {
            phase: 'writing',
            phaseLabel: '摘要合并完成，正在原子写入',
            completed: 0,
            total: 1
        });
        const memo = writeMemo(agentName, {
            agentName,
            summary,
            generatedAt: new Date().toISOString(),
            editedAt: null,
            source: reason,
            model: memoConfig.model,
            timelineDays: memoConfig.timelineDays,
            fallbackMessageCount: memoConfig.fallbackMessageCount,
            sourceMessageCount: rows.length,
            sourceFirstTimestamp: rows[0]?.timestamp || null,
            sourceLastTimestamp: rows[rows.length - 1]?.timestamp || null
        });
        updateGenerationStatus(agentName, {
            running: false,
            phase: 'completed',
            phaseLabel: '摘要生成完成',
            completed: 1,
            total: 1,
            finishedAt: new Date().toISOString()
        });
        return memo;
    })().catch(error => {
        updateGenerationStatus(agentName, {
            running: false,
            phase: 'failed',
            phaseLabel: '摘要生成失败',
            finishedAt: new Date().toISOString(),
            error: error.message
        });
        throw error;
    }).finally(() => generationLocks.delete(agentName));

    generationLocks.set(agentName, task);
    return task;
}

function startGeneration(agentName, rawConfig, reason = 'manual') {
    if (isGenerating(agentName)) {
        return { accepted: false, status: getGenerationStatus(agentName) };
    }
    const task = generateMemo(agentName, rawConfig, reason);
    task.catch(error => {
        console.warn(`[OneRingMemo] Background generation failed for "${agentName}":`, error.message);
    });
    return { accepted: true, status: getGenerationStatus(agentName) };
}

function scheduleAutoGenerate(agentName, rawConfig) {
    const memoConfig = normalizeConfig(rawConfig);
    if (!memoConfig.enabled || !memoConfig.autoGenerate || !memoConfig.model || generationLocks.has(agentName)) return;
    const memo = readMemo(agentName);
    const lastSuccess = Date.parse(memo?.generatedAt || memo?.editedAt || '');
    if (Number.isFinite(lastSuccess) && Date.now() - lastSuccess < memoConfig.updateIntervalMinutes * 60000) return;
    setImmediate(() => {
        generateMemo(agentName, memoConfig, 'auto').catch(error => {
            console.warn(`[OneRingMemo] Auto generation failed for "${agentName}":`, error.message);
        });
    });
}

module.exports = {
    DEFAULT_CONFIG,
    normalizeConfig,
    configure,
    injectMemo,
    readMemo,
    updateMemoText,
    listAgentNames,
    generateMemo,
    startGeneration,
    getGenerationStatus,
    isGenerating,
    scheduleAutoGenerate
};
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PLACEHOLDER_REGEX = /\[\[VCPTimeLine::([^:\]\r\n]+?)(?::([^:\]\r\n]+?))?(?::([^:\]\r\n]+?))?\]\]/g;
const HEADER_REGEX = /^\[?\s*(\d{4})[.-](\d{1,2})[.-](\d{1,2})(?:\.\d+)?\s*\]?\s*-\s*(.+?)\s*$/;
const MONTH_FILE_REGEX = /^(\d{4})-(\d{2})\.md$/i;

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    defaultExpandK: 3,
    defaultThreshold: 0.5,
    model: '',
    maxContextTokens: 60000,
    maxOutputTokens: 4000,
    maxConcurrentTasks: 3,
    publicFolderPrefixes: ['公共'],
    ignoreFolders: ['node_modules', '.git'],
    summaryPrompt: ''
});

class VCPTimeLine {
    constructor() {
        this.projectBasePath = path.join(__dirname, '..', '..');
        this.dailyNoteRoot = path.join(this.projectBasePath, 'dailynote');
        this.contextBridge = null;
        this.runtimeConfig = {};
        this.config = { ...DEFAULT_CONFIG };
        this.generationLocks = new Map();
        this.generationStatuses = new Map();
    }

    async initialize(config = {}, dependencies = {}) {
        this.runtimeConfig = config;
        this.projectBasePath = config.PROJECT_BASE_PATH || this.projectBasePath;
        this.dailyNoteRoot = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(this.projectBasePath, 'dailynote');
        this.contextBridge = dependencies.contextBridge || null;
        this.config = await this.readConfig();
        console.log(`[VCPTimeLine] Initialized. root=${this.dailyNoteRoot}, contextBridge=${!!this.contextBridge}`);
    }

    getConfigPath() {
        return path.join(__dirname, 'config.json');
    }

    normalizePositiveInteger(value, fallback, min = 1, max = 1000000) {
        const parsed = Math.floor(Number(value));
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }

    normalizeThreshold(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0.01 && parsed <= 0.99 ? parsed : fallback;
    }

    normalizeConfig(raw = {}) {
        return {
            enabled: raw.enabled !== false,
            defaultExpandK: this.normalizePositiveInteger(raw.defaultExpandK, DEFAULT_CONFIG.defaultExpandK, 1, 100),
            defaultThreshold: this.normalizeThreshold(raw.defaultThreshold, DEFAULT_CONFIG.defaultThreshold),
            model: String(raw.model || '').trim(),
            maxContextTokens: this.normalizePositiveInteger(raw.maxContextTokens, DEFAULT_CONFIG.maxContextTokens, 1024),
            maxOutputTokens: this.normalizePositiveInteger(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 128),
            maxConcurrentTasks: this.normalizePositiveInteger(raw.maxConcurrentTasks, DEFAULT_CONFIG.maxConcurrentTasks, 1, 20),
            publicFolderPrefixes: Array.isArray(raw.publicFolderPrefixes)
                ? raw.publicFolderPrefixes.map(String).map(item => item.trim()).filter(Boolean)
                : [...DEFAULT_CONFIG.publicFolderPrefixes],
            ignoreFolders: Array.isArray(raw.ignoreFolders)
                ? raw.ignoreFolders.map(String).map(item => item.trim()).filter(Boolean)
                : [...DEFAULT_CONFIG.ignoreFolders],
            summaryPrompt: String(raw.summaryPrompt || '').trim()
        };
    }

    async readConfig() {
        try {
            return this.normalizeConfig(JSON.parse(await fsp.readFile(this.getConfigPath(), 'utf8')));
        } catch (error) {
            if (error.code === 'ENOENT') return this.normalizeConfig(DEFAULT_CONFIG);
            throw error;
        }
    }

    async saveConfig(raw) {
        const config = this.normalizeConfig(raw);
        await this.writeJsonAtomic(this.getConfigPath(), config);
        this.config = config;
        return config;
    }

    safeAgentName(agentName) {
        const normalized = String(agentName || '').trim();
        if (!normalized || normalized === '.' || normalized === '..' || /[<>:"/\\|?*\x00-\x1F]/.test(normalized)) {
            throw new Error('Agent 名称无效');
        }
        return normalized;
    }

    getTimelineDir(agentName, create = false) {
        const safeName = this.safeAgentName(agentName);
        const expectedName = `${safeName}timeline`;
        let actualName = expectedName;

        // Linux 文件系统大小写敏感。优先复用服务器上已经存在的
        // <Agent>timeline / <Agent>TimeLine / <Agent>TIMELINE 等真实目录，
        // 避免读取时落到另一个大小写不同的新路径。
        try {
            const entries = fs.readdirSync(this.dailyNoteRoot, { withFileTypes: true });
            const existing = entries.find(entry =>
                entry.isDirectory() && entry.name.toLocaleLowerCase() === expectedName.toLocaleLowerCase()
            );
            if (existing) actualName = existing.name;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const dir = path.join(this.dailyNoteRoot, actualName);
        if (create) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    getSummaryPath() {
        return path.join(__dirname, 'timeline_summaries.json');
    }

    async readSummaryStore() {
        try {
            const value = JSON.parse(await fsp.readFile(this.getSummaryPath(), 'utf8'));
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
        }
    }

    async writeJsonAtomic(target, value) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await fsp.rename(temp, target);
    }

    extractText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(part => part?.type === 'text' ? part.text || '' : '').join('');
        if (content && typeof content.text === 'string') return content.text;
        return '';
    }

    replaceText(content, replacer) {
        if (typeof content === 'string') return replacer(content);
        if (Array.isArray(content)) {
            return content.map(part => part?.type === 'text' && typeof part.text === 'string'
                ? { ...part, text: replacer(part.text) }
                : part);
        }
        if (content && typeof content.text === 'string') return { ...content, text: replacer(content.text) };
        return content;
    }

    parsePlaceholder(match) {
        let k = this.config.defaultExpandK;
        let threshold = this.config.defaultThreshold;
        const values = [match[2], match[3]].filter(value => value !== undefined).map(value => String(value).trim());

        if (values.length === 1) {
            const raw = values[0];
            const numeric = Number(raw);
            if (/^\d+$/.test(raw) && numeric >= 1) k = Math.floor(numeric);
            else if (Number.isFinite(numeric) && numeric >= 0.01 && numeric <= 0.99) threshold = numeric;
        } else if (values.length >= 2) {
            const parsedK = Number(values[0]);
            const parsedThreshold = Number(values[1]);
            if (/^\d+$/.test(values[0]) && parsedK >= 1) k = Math.floor(parsedK);
            if (Number.isFinite(parsedThreshold) && parsedThreshold >= 0.01 && parsedThreshold <= 0.99) {
                threshold = parsedThreshold;
            }
        }

        return { placeholder: match[0], agentName: match[1].trim(), k, threshold };
    }

    findLatestRealMessage(messages, role) {
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message?.role !== role) continue;
            const text = this.extractText(message.content);
            if (!text.trim()) continue;
            if (role === 'user' && /^\s*\[系统(?:通知|提示)/.test(text)) continue;
            return text;
        }
        return '';
    }

    async buildQueryContext(messages) {
        if (!this.contextBridge) return { queryVector: null, userText: '', aiText: '' };
        const userText = this.contextBridge.sanitize(this.findLatestRealMessage(messages, 'user'), 'user');
        const aiText = this.contextBridge.sanitize(this.findLatestRealMessage(messages, 'assistant'), 'assistant');
        const [userVector, aiVector] = await Promise.all([
            userText ? this.contextBridge.embedText(userText) : null,
            aiText ? this.contextBridge.embedText(aiText) : null
        ]);
        return {
            queryVector: this.contextBridge.weightedAverage([userVector, aiVector], [0.7, 0.3]),
            userText,
            aiText
        };
    }

    async listTimelineFiles(agentName) {
        const dir = this.getTimelineDir(agentName, false);
        try {
            const names = await fsp.readdir(dir);
            const files = [];
            for (const name of names.filter(item => MONTH_FILE_REGEX.test(item)).sort()) {
                const fullPath = path.join(dir, name);
                const content = await fsp.readFile(fullPath, 'utf8');
                files.push({ month: name.slice(0, -3), name, fullPath, content });
            }
            return files;
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    async buildInjection(agentName, queryContext, k, threshold) {
        const { queryVector, userText = '', aiText = '' } = queryContext || {};
        const [store, files] = await Promise.all([this.readSummaryStore(), this.listTimelineFiles(agentName)]);
        const agentSummaries = store[agentName] || {};
        const summaryLines = Object.keys(agentSummaries).sort().map(month => `- ${month}：${agentSummaries[month]}`).filter(Boolean);
        const sections = [
            `## ${agentName}的所有时间线（月）`,
            summaryLines.length > 0 ? summaryLines.join('\n') : '（暂无月度时间线摘要）'
        ];

        if (
            !queryVector ||
            !this.contextBridge ||
            typeof this.contextBridge.searchDiary !== 'function' ||
            files.length === 0 ||
            k < 1
        ) {
            return sections.join('\n\n');
        }

        // Timeline 文档已经位于 dailynote/<Agent>timeline，由 KnowledgeBaseManager 自动建立向量索引。
        // 此处只复用 RAG 生成的 queryVector 搜索现有 chunk，绝不重新向量化 Timeline 文档。
        // 索引名称必须与服务器上的真实目录名完全一致（Linux 大小写敏感）。
        const indexName = path.basename(this.getTimelineDir(agentName, false));
        const candidateK = Math.max(k * 8, 20);
        let chunks = [];
        let retrievalMeta = null;

        if (typeof this.contextBridge.retrieveDiary === 'function') {
            const retrieval = await this.contextBridge.retrieveDiary({
                diaryNames: indexName,
                queryVector,
                k: candidateK,
                tagMemo: true,
                geodesicRerank: true,
                deduplicate: false,
                userText,
                aiText
            });
            chunks = retrieval?.results || [];
            retrievalMeta = retrieval?.meta || null;
        } else {
            // 兼容 ContextBridge 1.0：桥接层未升级时退化为普通 KNN。
            chunks = await this.contextBridge.searchDiary(indexName, queryVector, candidateK);
        }

        const fileByMonth = new Map(files.map(file => [file.month, file]));
        const bestScoreByMonth = new Map();

        for (const chunk of Array.isArray(chunks) ? chunks : []) {
            const sourcePath = String(chunk?.fullPath || chunk?.sourceFile || '').replace(/\\/g, '/');
            const fileName = path.posix.basename(sourcePath);
            const match = MONTH_FILE_REGEX.exec(fileName);
            if (!match) continue;
            const month = `${match[1]}-${match[2]}`;
            if (!fileByMonth.has(month)) continue;
            const score = Number(chunk?.rerank_score ?? chunk?.score ?? -1);
            if (!Number.isFinite(score)) continue;
            if (!bestScoreByMonth.has(month) || score > bestScoreByMonth.get(month)) {
                bestScoreByMonth.set(month, score);
            }
        }

        const expanded = [...bestScoreByMonth.entries()]
            .map(([month, score]) => ({ ...fileByMonth.get(month), score }))
            .filter(file => file.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);

        if (expanded.length > 0) {
            const retrievalMode = retrievalMeta?.tagMemoUsed
                ? `TagMemo 浪潮${retrievalMeta.geodesicRerankUsed ? ' + 测地线重排' : ''}`
                : '向量检索';
            sections.push([
                `## 与当前对话相关的完整月度时间线（Top ${expanded.length}，阈值 ${threshold}，${retrievalMode}）`,
                ...expanded.map(file => `### ${file.month}（相关度 ${file.score.toFixed(4)}）\n${file.content.trim()}`)
            ].join('\n\n'));
        }
        return sections.join('\n\n');
    }

    async processMessages(messages) {
        if (!this.config.enabled || !Array.isArray(messages)) return messages;
        const declarations = [];
        messages.forEach((message, index) => {
            if (message?.role !== 'system' && message?.role !== 'user') return;
            const text = this.extractText(message.content);
            for (const match of text.matchAll(new RegExp(PLACEHOLDER_REGEX.source, PLACEHOLDER_REGEX.flags))) {
                declarations.push({ index, ...this.parsePlaceholder(match) });
            }
        });
        if (declarations.length === 0) return messages;

        const queryContext = await this.buildQueryContext(messages);
        const replacements = await Promise.all(declarations.map(async declaration => ({
            ...declaration,
            content: await this.buildInjection(
                this.safeAgentName(declaration.agentName),
                queryContext,
                declaration.k,
                declaration.threshold
            )
        })));

        const result = messages.map(message => ({ ...message }));
        for (const replacement of replacements) {
            result[replacement.index].content = this.replaceText(
                result[replacement.index].content,
                text => text.replace(replacement.placeholder, replacement.content)
            );
        }
        return result;
    }

    parseMemoryHeader(content) {
        for (const line of String(content || '').split(/\r?\n/)) {
            if (!line.trim()) continue;
            const match = HEADER_REGEX.exec(line.trim());
            return match ? {
                month: `${match[1]}-${String(match[2]).padStart(2, '0')}`,
                author: match[4].trim()
            } : null;
        }
        return null;
    }

    shouldScanTopLevel(name, agentName) {
        const isTimelineDirectory = name.toLocaleLowerCase() === `${agentName}timeline`.toLocaleLowerCase();
        return [agentName, ...this.config.publicFolderPrefixes].some(prefix => name.startsWith(prefix))
            && !isTimelineDirectory;
    }

    async discoverMemories(agentName, startMonth, endMonth) {
        const grouped = new Map();
        let topEntries = [];
        try {
            topEntries = await fsp.readdir(this.dailyNoteRoot, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error(`dailynote 目录不存在：${this.dailyNoteRoot}`);
            throw error;
        }

        const walk = async dir => {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (!this.config.ignoreFolders.includes(entry.name)) await walk(path.join(dir, entry.name));
                    continue;
                }
                if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                const content = await fsp.readFile(fullPath, 'utf8');
                const header = this.parseMemoryHeader(content);
                if (!header || header.author !== agentName) continue;
                if (startMonth && header.month < startMonth) continue;
                if (endMonth && header.month > endMonth) continue;
                const lines = content.split(/\r?\n/);
                const firstNonEmpty = lines.findIndex(line => line.trim());
                const body = lines.filter((_, index) => index !== firstNonEmpty).join('\n').trim();
                if (!body) continue;
                if (!grouped.has(header.month)) grouped.set(header.month, []);
                grouped.get(header.month).push(body);
            }
        };

        for (const entry of topEntries) {
            if (entry.isDirectory() && this.shouldScanTopLevel(entry.name, agentName)) {
                await walk(path.join(this.dailyNoteRoot, entry.name));
            }
        }
        return grouped;
    }

    estimateTokens(text) {
        const chinese = (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length;
        return Math.ceil(chinese * 1.5 + (String(text || '').length - chinese) * 0.25);
    }

    splitByBudget(items, budget) {
        const chunks = [];
        let current = [];
        let tokens = 0;
        for (const item of items) {
            const count = this.estimateTokens(item);
            if (current.length > 0 && tokens + count > budget) {
                chunks.push(current.join('\n\n---\n\n'));
                current = [];
                tokens = 0;
            }
            current.push(item);
            tokens += count;
        }
        if (current.length > 0) chunks.push(current.join('\n\n---\n\n'));
        return chunks;
    }

    async callModel(systemPrompt, userPrompt, maxTokens = this.config.maxOutputTokens) {
        const port = this.runtimeConfig.PORT || process.env.PORT || 3000;
        const key = this.runtimeConfig.Key || process.env.Key || '';
        if (!key) throw new Error('服务器 Key 未配置');
        if (!this.config.model) throw new Error('VCPTimeLine 模型未配置');
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model: this.config.model,
                stream: false,
                max_tokens: maxTokens,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]
            })
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`模型返回 ${response.status}: ${text.slice(0, 500)}`);
        const payload = JSON.parse(text);
        const output = payload?.choices?.[0]?.message?.content;
        if (typeof output !== 'string' || !output.trim()) throw new Error('模型未返回有效内容');
        return output.trim();
    }

    async summarizeMonth(agentName, month, memories) {
        const prompt = `你是个人记忆时间线整理器。请把 Agent「${agentName}」在 ${month} 的记忆碎片整理为客观、完整、连贯的月度时间线 Markdown。保留明确人物、事件、结果、观点归属和时间线索；不得虚构。末尾仅保留一行“Tag: 标签1, 标签2, ...”。`;
        const budget = Math.max(512, this.config.maxContextTokens - this.config.maxOutputTokens - 1000);
        let chunks = this.splitByBudget(memories, budget);
        let outputs = [];
        for (let index = 0; index < chunks.length; index++) {
            outputs.push(await this.callModel(prompt, `第 ${index + 1}/${chunks.length} 段记忆：\n\n${chunks[index]}`));
        }
        while (outputs.length > 1) {
            const combined = outputs.map((value, index) => `【分段 ${index + 1}】\n${value}`).join('\n\n');
            const mergeChunks = this.splitByBudget([combined], budget);
            if (mergeChunks.length === 1) {
                outputs = [await this.callModel(prompt, `合并以下分段时间线，去重并按逻辑排序：\n\n${combined}`)];
            } else {
                outputs = [];
                for (const chunk of mergeChunks) outputs.push(await this.callModel(prompt, chunk));
            }
        }
        return outputs[0] || '';
    }

    async generateOneLineSummary(agentName, month, timeline) {
        const custom = this.config.summaryPrompt;
        const prompt = custom || `你是月度时间线摘要器。请把 Agent「${agentName}」在 ${month} 的时间线压缩成严格的一句话。只输出一句摘要，不要标题、列表、Tag、解释或前后缀；保留最重要事件和状态变化。`;
        return this.callModel(prompt, timeline, Math.min(300, this.config.maxOutputTokens));
    }

    buildTimestamp(agentName, month) {
        const [year, monthNumber] = month.split('-').map(Number);
        const lastDay = new Date(year, monthNumber, 0).getDate();
        return `[${year}-${monthNumber}-${lastDay}] - ${agentName}`;
    }

    createStatus(agentName, kind) {
        return {
            agentName,
            kind,
            running: true,
            phase: 'preparing',
            phaseLabel: '准备源数据',
            completed: 0,
            total: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            finishedAt: null,
            error: null
        };
    }

    updateStatus(agentName, patch) {
        const current = this.generationStatuses.get(agentName) || this.createStatus(agentName, patch.kind || 'timeline');
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        this.generationStatuses.set(agentName, next);
        return next;
    }

    getGenerationStatus(agentName) {
        return this.generationStatuses.get(agentName) || {
            agentName, kind: null, running: false, phase: 'idle', phaseLabel: '空闲',
            completed: 0, total: 0, startedAt: null, updatedAt: null, finishedAt: null, error: null
        };
    }

    async generateTimelines(agentName, options = {}) {
        agentName = this.safeAgentName(agentName);
        if (this.generationLocks.has(agentName)) throw Object.assign(new Error('该 Agent 已有生成任务运行中'), { code: 'TIMELINE_GENERATION_IN_PROGRESS' });
        const status = this.createStatus(agentName, 'timeline');
        this.generationStatuses.set(agentName, status);

        const task = (async () => {
            const memories = await this.discoverMemories(agentName, options.startMonth, options.endMonth);
            const months = [...memories.keys()].sort();
            this.updateStatus(agentName, { phase: 'generating', phaseLabel: '生成月度时间线', total: months.length });
            const dir = this.getTimelineDir(agentName, true);
            const generated = [];
            for (let index = 0; index < months.length; index++) {
                const month = months[index];
                const target = path.join(dir, `${month}.md`);
                if (!options.overwrite && fs.existsSync(target)) {
                    this.updateStatus(agentName, { completed: index + 1, phaseLabel: `跳过已存在月份 ${month}` });
                    continue;
                }
                const timeline = await this.summarizeMonth(agentName, month, memories.get(month));
                const document = `${this.buildTimestamp(agentName, month)}\n# ${month} ${agentName}时间线\n\n${timeline.trim()}\n`;
                await fsp.writeFile(target, document, 'utf8');
                generated.push(month);
                this.updateStatus(agentName, { completed: index + 1, phaseLabel: `已生成 ${month}` });
            }
            this.updateStatus(agentName, {
                running: false, phase: 'completed', phaseLabel: '月度时间线生成完成',
                finishedAt: new Date().toISOString()
            });
            return { generated, total: months.length };
        })().catch(error => {
            this.updateStatus(agentName, {
                running: false, phase: 'failed', phaseLabel: '生成失败',
                finishedAt: new Date().toISOString(), error: error.message
            });
            throw error;
        }).finally(() => this.generationLocks.delete(agentName));

        this.generationLocks.set(agentName, task);
        return task;
    }

    async generateSummaries(agentName, options = {}) {
        agentName = this.safeAgentName(agentName);
        if (this.generationLocks.has(agentName)) throw Object.assign(new Error('该 Agent 已有生成任务运行中'), { code: 'TIMELINE_GENERATION_IN_PROGRESS' });
        this.generationStatuses.set(agentName, this.createStatus(agentName, 'summary'));

        const task = (async () => {
            const files = await this.listTimelineFiles(agentName);
            const store = await this.readSummaryStore();
            store[agentName] = store[agentName] || {};
            this.updateStatus(agentName, { phase: 'summarizing', phaseLabel: '生成月度一句话摘要', total: files.length });
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                if (options.overwrite || !store[agentName][file.month]) {
                    store[agentName][file.month] = await this.generateOneLineSummary(agentName, file.month, file.content);
                    await this.writeJsonAtomic(this.getSummaryPath(), store);
                }
                this.updateStatus(agentName, { completed: index + 1, phaseLabel: `已处理 ${file.month}` });
            }
            this.updateStatus(agentName, {
                running: false, phase: 'completed', phaseLabel: '一句话摘要生成完成',
                finishedAt: new Date().toISOString()
            });
            return store[agentName];
        })().catch(error => {
            this.updateStatus(agentName, {
                running: false, phase: 'failed', phaseLabel: '摘要生成失败',
                finishedAt: new Date().toISOString(), error: error.message
            });
            throw error;
        }).finally(() => this.generationLocks.delete(agentName));

        this.generationLocks.set(agentName, task);
        return task;
    }

    startTask(agentName, kind, options) {
        agentName = this.safeAgentName(agentName);
        if (this.generationLocks.has(agentName)) {
            return { accepted: false, status: this.getGenerationStatus(agentName) };
        }
        const task = kind === 'summary'
            ? this.generateSummaries(agentName, options)
            : this.generateTimelines(agentName, options);
        task.catch(error => console.warn(`[VCPTimeLine] ${kind} task failed for "${agentName}":`, error.message));
        return { accepted: true, status: this.getGenerationStatus(agentName) };
    }

    async listAgents() {
        const names = new Set();
        try {
            for (const entry of await fsp.readdir(this.dailyNoteRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const match = /^(.*?)timeline$/i.exec(entry.name.trim());
                if (match?.[1]) names.add(match[1]);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const store = await this.readSummaryStore();
        Object.keys(store).forEach(name => names.add(name));
        return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    async getAgentDetail(agentName) {
        agentName = this.safeAgentName(agentName);
        const [files, store] = await Promise.all([this.listTimelineFiles(agentName), this.readSummaryStore()]);
        return {
            agentName,
            summaries: store[agentName] || {},
            files: files.map(file => ({ month: file.month, name: file.name, content: file.content })),
            status: this.getGenerationStatus(agentName)
        };
    }

    async saveTimelineFile(agentName, month, content) {
        agentName = this.safeAgentName(agentName);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份必须为 YYYY-MM');
        const dir = this.getTimelineDir(agentName, true);
        await fsp.writeFile(path.join(dir, `${month}.md`), String(content || ''), 'utf8');
    }

    async saveSummary(agentName, month, summary) {
        agentName = this.safeAgentName(agentName);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份必须为 YYYY-MM');
        const store = await this.readSummaryStore();
        store[agentName] = store[agentName] || {};
        store[agentName][month] = String(summary || '').trim();
        await this.writeJsonAtomic(this.getSummaryPath(), store);
        return store[agentName];
    }

    registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath) {
        // PluginManager 通过 registerRoutes.length >= 4 判断是否采用新版签名。
        // 必须保留四个形参，才能收到真正受管理面板鉴权保护的 adminApiRouter；
        // 两参数签名会被当成旧协议，第二个参数实际变成 pluginConfig，导致全部路由注册失败。
        void app;
        void pluginConfig;
        void projectBasePath;
        const route = (method, url, handler) => adminApiRouter[method](url, async (req, res) => {
            try {
                await handler(req, res);
            } catch (error) {
                const conflict = error.code === 'TIMELINE_GENERATION_IN_PROGRESS';
                res.status(conflict ? 409 : 500).json({ success: false, error: error.message });
            }
        });

        route('get', '/vcp-timeline/config', async (_req, res) => {
            this.config = await this.readConfig();
            res.json({ success: true, config: this.config });
        });
        route('put', '/vcp-timeline/config', async (req, res) => {
            res.json({ success: true, config: await this.saveConfig(req.body || {}), message: 'VCPTimeLine 配置已保存' });
        });
        route('get', '/vcp-timeline/agents', async (_req, res) => {
            res.json({ success: true, agents: await this.listAgents() });
        });
        route('get', '/vcp-timeline/agents/:agentName', async (req, res) => {
            res.json({ success: true, detail: await this.getAgentDetail(req.params.agentName) });
        });
        route('get', '/vcp-timeline/agents/:agentName/status', async (req, res) => {
            const agentName = this.safeAgentName(req.params.agentName);
            res.json({ success: true, status: this.getGenerationStatus(agentName) });
        });
        route('put', '/vcp-timeline/agents/:agentName/files/:month', async (req, res) => {
            await this.saveTimelineFile(req.params.agentName, req.params.month, req.body?.content);
            res.json({ success: true, message: '时间线文件已保存' });
        });
        route('put', '/vcp-timeline/agents/:agentName/summaries/:month', async (req, res) => {
            const summaries = await this.saveSummary(req.params.agentName, req.params.month, req.body?.summary);
            res.json({ success: true, summaries, message: '月度摘要已保存' });
        });
        route('post', '/vcp-timeline/agents/:agentName/generate-timelines', async (req, res) => {
            const started = this.startTask(req.params.agentName, 'timeline', req.body || {});
            res.status(started.accepted ? 202 : 409).json({ success: started.accepted, ...started });
        });
        route('post', '/vcp-timeline/agents/:agentName/generate-summaries', async (req, res) => {
            const started = this.startTask(req.params.agentName, 'summary', req.body || {});
            res.status(started.accepted ? 202 : 409).json({ success: started.accepted, ...started });
        });
    }
}

module.exports = new VCPTimeLine();
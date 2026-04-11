// Plugin/ContextFoldingV2/ContextFoldingV2.js
// 上下文语义折叠V2 - 对正文中远距离、低相关性的 AI 输出进行摘要折叠

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const chokidar = require('chokidar');

const FOLDING_PREFIX = '[VCP上下文语义折叠-本层摘要:';
// 使用 [\s\S]+? 而非 .+? 以兼容模型输出多行摘要的情况
const FOLDING_REGEX = /\[VCP上下文语义折叠-本层摘要:([\s\S]+?)\]/;
// 支持两种激活格式：双花括号（可能被 messageProcessor 替换）和双方括号（最安全）
const ACTIVATION_PLACEHOLDER = '{{ContextFoldingV2}}';
const ACTIVATION_PLACEHOLDER_BRACKET = '[[ContextFoldingV2]]';

class ContextFoldingV2 {
    constructor() {
        this.name = 'ContextFoldingV2';
        this.contextBridge = null;
        this.enabled = false;

        // 配置参数（在 initialize 中加载）
        this.summaryModel = '';
        this.summarySystemPrompt = '';
        this.summaryUserPrompt = '';
        this.minDepth = 3;
        this.maxRetries = 3;

        // 热调控参数（从 rag_params.json 实时读取）
        this.hotParams = {
            thresholdBase: 0.50,
            thresholdRange: [0.40, 0.60],
            lWeight: 0.05,
            sWeight: 0.05,
            contextWeights: [0.7, 0.3] // user : assistant 加权比例，与 RAGDiaryPlugin.mainSearchWeights 对齐
        };
        this._ragParamsWatcher = null;

        // 运行时状态
        this.pendingHashes = new Set(); // 防止并发重复触发摘要生成
    }

    /**
     * 插件初始化入口（由 PluginManager 调用）
     */
    async initialize(config, dependencies) {
        // 1. 加载插件独立 config.env
        const envPath = path.join(__dirname, 'config.env');
        dotenv.config({ path: envPath });

        this.summaryModel = process.env.FOLDING_SUMMARY_MODEL || 'gemini-3.1-flash-lite-preview';
        this.summarySystemPrompt = (process.env.FOLDING_SUMMARY_SYSTEM_PROMPT || '').replace(/\\n/g, '\n');
        this.summaryUserPrompt = (process.env.FOLDING_SUMMARY_USER_PROMPT || '').replace(/\\n/g, '\n');
        this.minDepth = Math.max(2, parseInt(process.env.FOLDING_MIN_DEPTH) || 3);
        this.maxRetries = parseInt(process.env.FOLDING_MAX_RETRIES) || 3;

        // 2. 接收 ContextBridge
        if (dependencies && dependencies.contextBridge) {
            this.contextBridge = dependencies.contextBridge;
            console.log(`[ContextFoldingV2] ContextBridge 已注入 (v${this.contextBridge.version})`);
        } else {
            console.warn('[ContextFoldingV2] ContextBridge 未注入，折叠功能将不可用');
            return;
        }

        // 3. 验证 FoldingStore 可用性
        if (!this.contextBridge.foldingStore) {
            console.warn('[ContextFoldingV2] FoldingStore 不可用，折叠功能将不可用');
            return;
        }

        const stats = this.contextBridge.foldingStore.getStats();
        if (!stats.available) {
            console.warn('[ContextFoldingV2] FoldingStore 数据库不可用');
            return;
        }

        // 4. 验证摘要 API 配置
        if (!process.env.API_URL || !process.env.API_Key) {
            console.warn('[ContextFoldingV2] API_URL 或 API_Key 未配置，摘要生成将不可用');
        }

        // 5. 加载热调控参数
        await this._loadHotParams();
        this._startHotParamsWatcher();

        this.enabled = true;
        console.log(`[ContextFoldingV2] 初始化完成 (模型: ${this.summaryModel}, 最低深度: ${this.minDepth}, 阈值基准: ${this.hotParams.thresholdBase}, Store: ${stats.count}/${stats.maxEntries}条)`);
    }

    /**
     * 从 rag_params.json 加载热调控参数
     */
    async _loadHotParams() {
        const projectBasePath = process.env.PROJECT_BASE_PATH || path.join(__dirname, '../../');
        const paramsPath = path.join(projectBasePath, 'rag_params.json');
        try {
            const data = await fs.readFile(paramsPath, 'utf-8');
            const allParams = JSON.parse(data);
            if (allParams.ContextFoldingV2) {
                this.hotParams = { ...this.hotParams, ...allParams.ContextFoldingV2 };
                console.log(`[ContextFoldingV2] 热参数已加载: 基准=${this.hotParams.thresholdBase}, 范围=[${this.hotParams.thresholdRange}], L系数=${this.hotParams.lWeight}, S系数=${this.hotParams.sWeight}`);
            }
        } catch (e) {
            console.warn(`[ContextFoldingV2] 读取 rag_params.json 失败，使用默认值: ${e.message}`);
        }
    }

    /**
     * 监听 rag_params.json 变更
     */
    _startHotParamsWatcher() {
        const projectBasePath = process.env.PROJECT_BASE_PATH || path.join(__dirname, '../../');
        const paramsPath = path.join(projectBasePath, 'rag_params.json');
        if (this._ragParamsWatcher) return;

        this._ragParamsWatcher = chokidar.watch(paramsPath, { ignoreInitial: true });
        this._ragParamsWatcher.on('change', async () => {
            console.log('[ContextFoldingV2] 🔄 检测到 rag_params.json 变更，重新加载热参数...');
            await this._loadHotParams();
        });
    }

    /**
     * 消息预处理器标准接口
     */
    async processMessages(messages, pluginConfig) {
        if (!this.enabled || !this.contextBridge || !this.contextBridge.foldingStore) {
            return messages;
        }

        try {
            // 0. 用户向开关检测：扫描 system 消息中是否存在激活占位符
            //    支持尾缀数字覆盖阈值基准：[[ContextFoldingV2:0.6]] 或 {{ContextFoldingV2:0.55}}
            let activated = false;
            let activationIndex = -1;
            let matchedPlaceholder = null;
            let overrideThreshold = null; // 占位符中指定的阈值覆盖

            // 正则匹配：{{ContextFoldingV2}} {{ContextFoldingV2:0.6}} [[ContextFoldingV2]] [[ContextFoldingV2:0.55]]
            const activationRegex = /(\{\{ContextFoldingV2(?::(\d+\.?\d*))?\}\}|\[\[ContextFoldingV2(?::(\d+\.?\d*))?\]\])/;

            for (let i = 0; i < messages.length; i++) {
                if (messages[i].role === 'system' && typeof messages[i].content === 'string') {
                    const match = messages[i].content.match(activationRegex);
                    if (match) {
                        activated = true;
                        activationIndex = i;
                        matchedPlaceholder = match[0]; // 完整匹配（含数字）
                        // 提取尾缀数字：match[2] 是 {{}} 格式的，match[3] 是 [[]] 格式的
                        const thresholdStr = match[2] || match[3];
                        if (thresholdStr) {
                            overrideThreshold = parseFloat(thresholdStr);
                            if (isNaN(overrideThreshold)) overrideThreshold = null;
                        }
                        break;
                    }
                }
            }

            if (!activated) {
                return messages;
            }

            const store = this.contextBridge.foldingStore;
            const bridge = this.contextBridge;

            // 将占位符从 system 消息中移除（它只是开关，不应出现在最终输出中）
            const newMessages = JSON.parse(JSON.stringify(messages));
            if (activationIndex >= 0 && matchedPlaceholder) {
                newMessages[activationIndex].content = newMessages[activationIndex].content
                    .replace(matchedPlaceholder, '')
                    .trim();
            }

            // 1. 识别所有 assistant 块并计算深度
            const assistantBlocks = this._identifyAssistantBlocks(messages);
            if (assistantBlocks.length === 0) return newMessages;

            // 2. 过滤出候选折叠块（depth >= minDepth）
            const candidates = assistantBlocks.filter(b => b.depth >= this.minDepth);
            if (candidates.length === 0) return newMessages;

            // 3. 获取上下文参考向量（最新 user + AI 的加权平均）
            const contextVector = await this._getContextVector(messages, bridge);
            if (!contextVector) return newMessages;

            // 4. 计算动态阈值（如果占位符指定了数字，则覆盖为 Agent 专属基准线）
            const threshold = this._computeDynamicThreshold(contextVector, bridge, overrideThreshold);

            // 5. 处理每个候选块
            const foldedFloors = [];
            let asyncTriggered = 0;

            for (const candidate of candidates) {
                const msg = newMessages[candidate.index];
                const content = this._getContent(msg);

                // 跳过已折叠的内容
                if (content.startsWith(FOLDING_PREFIX)) continue;

                // 净化并计算哈希
                const sanitized = bridge.sanitize(content, 'assistant');
                if (!sanitized || sanitized.length < 10) continue;

                const hash = store.hashContent(sanitized);

                // 获取块向量（store → bridge缓存 → embedding API）
                let blockVector = null;
                const entry = store.getEntry(hash);

                if (entry && entry.vector) {
                    blockVector = entry.vector;
                } else {
                    // 尝试从 bridge 缓存获取
                    blockVector = bridge.getEmbeddingFromCache(sanitized);
                    if (!blockVector) {
                        // 调用 embedding API
                        blockVector = await bridge.embedText(sanitized);
                    }
                    // 写入 store（无论是否有向量）
                    if (blockVector) {
                        store.upsertVector(hash, {
                            textPreview: sanitized.substring(0, 80),
                            vector: blockVector
                        });
                    }
                }

                if (!blockVector) continue;

                // 计算相似度
                const similarity = bridge.cosineSimilarity(blockVector, contextVector);
                if (isNaN(similarity)) continue;

                // 相似度 >= 阈值 → 内容相关，保留
                if (similarity >= threshold) continue;

                // 相似度 < 阈值 → 低相关，检查摘要状态
                const storeEntry = store.getEntry(hash);
                const summaryStatus = storeEntry ? storeEntry.summary_status : 'none';
                const retryCount = storeEntry ? storeEntry.retry_count : 0;

                if (summaryStatus === 'ready' && storeEntry.summary) {
                    // 摘要已就绪 → 执行折叠替换
                    this._setContent(msg, storeEntry.summary);
                    foldedFloors.push(candidate.depth);
                } else if (summaryStatus === 'none' || (summaryStatus === 'failed' && retryCount < this.maxRetries)) {
                    // 需要生成摘要 → 异步触发（不阻塞）
                    if (!this.pendingHashes.has(hash)) {
                        this._triggerAsyncSummary(hash, content, retryCount);
                        asyncTriggered++;
                    }
                }
                // 'pending' 状态 → 等待中，本次不处理
            }

            // 6. 仅在有实际动作时输出日志
            if (foldedFloors.length > 0 || asyncTriggered > 0) {
                const parts = [];
                if (foldedFloors.length > 0) parts.push(`折叠楼层: ${foldedFloors.join(',')}`);
                if (asyncTriggered > 0) parts.push(`异步生成: ${asyncTriggered}个`);
                console.log(`[ContextFoldingV2] ${parts.join(' | ')}（阈值: ${threshold.toFixed(3)}, 候选: ${candidates.length}楼）`);
            }

            return newMessages;
        } catch (error) {
            console.error('[ContextFoldingV2] processMessages 错误:', error.message);
            return messages;
        }
    }

    // ═══════════════════════════════════════════════════
    // 核心算法
    // ═══════════════════════════════════════════════════

    /**
     * 识别所有 assistant 块并计算其深度（从最新往回数）
     * depth=0 是最新的 assistant 块，depth=1 是倒数第二个，以此类推
     */
    _identifyAssistantBlocks(messages) {
        const blocks = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                blocks.push({ index: i, depth: blocks.length });
            }
        }
        // 返回时按 index 正序（方便后续遍历）
        return blocks.reverse();
    }

    /**
     * 获取上下文参考向量（最新 user + 最新 AI 消息的加权平均）
     */
    async _getContextVector(messages, bridge) {
        // 查找最新的 user 和 assistant 消息
        let lastUserContent = null;
        let lastAiContent = null;

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'user' && !lastUserContent) {
                const c = this._getContent(msg);
                // 跳过系统邀请指令
                if (!c.startsWith('[系统邀请指令:]') && !c.trim().startsWith('[系统提示:]无内容')) {
                    lastUserContent = c;
                }
            }
            if (msg.role === 'assistant' && !lastAiContent) {
                lastAiContent = this._getContent(msg);
            }
            if (lastUserContent && lastAiContent) break;
        }

        if (!lastUserContent) return null;

        // 净化
        const sanitizedUser = bridge.sanitize(lastUserContent, 'user');
        const sanitizedAi = lastAiContent ? bridge.sanitize(lastAiContent, 'assistant') : null;

        // 向量化
        const [userVec, aiVec] = await Promise.all([
            sanitizedUser ? bridge.embedText(sanitizedUser) : null,
            sanitizedAi ? bridge.embedText(sanitizedAi) : null
        ]);

        // 加权平均（默认 user 0.7, AI 0.3，可通过 rag_params.json 的 ContextFoldingV2.contextWeights 调整）
        const weights = this.hotParams.contextWeights || [0.7, 0.3];
        return bridge.weightedAverage(
            [userVec, aiVec].filter(Boolean),
            userVec && aiVec ? weights : [1.0]
        );
    }

    /**
     * 计算动态折叠阈值
     * 基于上下文向量的逻辑深度(L)和语义宽度(S)
     *
     * L 高 → 逻辑聚焦 → 阈值升高 → 更激进折叠
     * S 高 → 语义宽泛 → 阈值降低 → 保守保留
     */
    _computeDynamicThreshold(contextVector, bridge, overrideBase = null) {
        const L = bridge.computeLogicDepth(contextVector);
        const S = bridge.computeSemanticWidth(contextVector);

        // 从热参数读取（面板可实时调整，无需重启）
        const { thresholdBase, thresholdRange, lWeight, sWeight } = this.hotParams;
        // 如果占位符指定了数字（如 [[ContextFoldingV2:0.6]]），则覆盖 json 配置的基准线
        const base = overrideBase !== null ? overrideBase : thresholdBase;
        const threshold = base + lWeight * L - sWeight * S;

        return Math.max(thresholdRange[0], Math.min(thresholdRange[1], threshold));
    }

    // ═══════════════════════════════════════════════════
    // 异步摘要生成（非阻塞，指数退避）
    // ═══════════════════════════════════════════════════

    /**
     * 异步触发摘要生成（不阻塞当前 POST）
     */
    _triggerAsyncSummary(hash, originalContent, retryCount) {
        this.pendingHashes.add(hash);

        const store = this.contextBridge.foldingStore;
        store.markPending(hash);

        // 指数退避延迟：1s, 3s, 9s
        const delay = 1000 * Math.pow(3, retryCount);

        setTimeout(async () => {
            try {
                const startTime = Date.now();
                const summary = await this._generateSummary(originalContent);

                if (summary) {
                    store.upsertSummary(hash, summary, 'ready');
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`[ContextFoldingV2] ✅ 摘要生成成功: hash=${hash.substring(0, 8)}...（耗时 ${elapsed}s）`);
                } else {
                    store.upsertSummary(hash, '', 'failed');
                    console.warn(`[ContextFoldingV2] ❌ 摘要验证失败: hash=${hash.substring(0, 8)}...`);
                }
            } catch (e) {
                store.upsertSummary(hash, '', 'failed');
                console.error(`[ContextFoldingV2] ❌ 摘要生成异常: ${e.message}`);
            } finally {
                this.pendingHashes.delete(hash);
            }
        }, delay);
    }

    /**
     * 调用 LLM 生成摘要（含三级安全验证）
     * 返回完整格式的摘要文本，或 null（验证失败）
     */
    async _generateSummary(text) {
        const apiUrl = process.env.API_URL;
        const apiKey = process.env.API_Key;

        if (!apiUrl || !apiKey) {
            console.error('[ContextFoldingV2] API_URL 或 API_Key 未配置');
            return null;
        }

        // 截断过长内容（防止请求过大）
        const maxInputChars = 4000;
        const inputText = text.length > maxInputChars
            ? text.substring(0, maxInputChars) + '...(内容已截断)'
            : text;

        // 使用中文方括号标记包裹原文，与 VCP 系统标记风格一致，防止内容注入和幻觉
        const wrappedContent = `[等待摘要的原始文本:]\n${inputText}\n[原始文本结束]`;

        const userPrompt = this.summaryUserPrompt
            ? this.summaryUserPrompt.replace('{CONTENT}', wrappedContent)
            : `请严格按以下格式输出，不要输出任何其他内容：\n[VCP上下文语义折叠-本层摘要:你的摘要内容]\n\n要求：用一句话概括[等待摘要的原始文本:]和[原始文本结束]之间的AI回复核心内容，摘要不超过80字。不要复述原文，不要输出边界标记。\n\n${wrappedContent}`;

        try {
            const response = await axios.post(`${apiUrl}/v1/chat/completions`, {
                model: this.summaryModel,
                messages: [
                    { role: 'system', content: this.summarySystemPrompt || '你是一个精确的文本摘要工具。你必须严格按照指定格式输出，不要输出任何其他内容。' },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 8000,
                temperature: 0.3
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            const rawOutput = response.data?.choices?.[0]?.message?.content || '';
            return this._validateSummary(rawOutput.trim());
        } catch (e) {
            if (e.response) {
                console.error(`[ContextFoldingV2] 摘要API错误: ${e.response.status} ${JSON.stringify(e.response.data).substring(0, 200)}`);
            } else {
                console.error(`[ContextFoldingV2] 摘要请求失败: ${e.message}`);
            }
            return null;
        }
    }

    /**
     * 三级摘要安全验证
     * 返回通过验证的完整格式摘要文本，或 null
     */
    _validateSummary(rawOutput) {
        if (!rawOutput) {
            console.warn('[ContextFoldingV2] 验证失败: 空回复');
            return null;
        }

        // ═══ 第一级：结构验证 ═══
        const match = rawOutput.match(FOLDING_REGEX);
        if (!match) {
            console.warn(`[ContextFoldingV2] 验证失败[结构]: 未匹配到格式标记。原始输出: "${rawOutput.substring(0, 100)}"`);
            return null;
        }

        // 保留多行格式（模型可能返回精简代码等多行摘要），仅 trim 首尾空白
        const summaryContent = match[1].trim();
        // 使用 match[0] 直接保留原始格式，包括多行内容
        const fullSummary = `[VCP上下文语义折叠-本层摘要:${summaryContent}]`;

        // ═══ 第二级：内容验证 ═══
        if (summaryContent.length < 2) {
            console.warn('[ContextFoldingV2] 验证失败[内容]: 摘要过短');
            return null;
        }
        if (summaryContent.length > 1000) {
            console.warn(`[ContextFoldingV2] 验证失败[内容]: 摘要过长 (${summaryContent.length}字)`);
            return null;
        }

        // 检测拒绝关键词（防止模型拒答被当作摘要）
        // 策略：外部文本用 includes 严格检测，内部摘要仅用 startsWith 防止误伤合法内容
        const rejectKeywords = ['error', '无法', '抱歉', '对不起', 'sorry', 'cannot', 'unable'];

        // 1) 检测摘要标记外部的文本（模型可能在格式标记外输出拒绝话语）
        const outsideText = rawOutput.replace(match[0], '').trim().toLowerCase();
        if (outsideText.length > 0) {
            for (const keyword of rejectKeywords) {
                if (outsideText.includes(keyword)) {
                    console.warn(`[ContextFoldingV2] 验证失败[内容]: 摘要外部检测到拒绝关键词 "${keyword}"`);
                    return null;
                }
            }
        }

        // 2) 检测摘要内部是否以拒绝关键词开头（纯拒答被包裹在格式标记中的情况）
        //    仅 startsWith，避免误伤 "讨论了error处理"、"分析了无法连接的原因" 等合法摘要
        const lowerContent = summaryContent.toLowerCase();
        for (const keyword of rejectKeywords) {
            if (lowerContent.startsWith(keyword)) {
                console.warn(`[ContextFoldingV2] 验证失败[内容]: 摘要以拒绝关键词开头 "${keyword}"`);
                return null;
            }
        }

        // ═══ 第三级：写入验证（只有通过前两级才返回） ═══
        return fullSummary;
    }

    // ═══════════════════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════════════════

    /**
     * 从消息中提取文本内容（兼容字符串和多模态数组格式）
     */
    _getContent(msg) {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            return textPart ? textPart.text || '' : '';
        }
        return '';
    }

    /**
     * 设置消息内容（兼容字符串和多模态数组格式）
     */
    _setContent(msg, newText) {
        if (typeof msg.content === 'string') {
            msg.content = newText;
        } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            if (textPart) {
                textPart.text = newText;
            } else {
                msg.content.unshift({ type: 'text', text: newText });
            }
        } else {
            msg.content = newText;
        }
    }

    /**
     * 关闭插件
     */
    shutdown() {
        this.pendingHashes.clear();
        this.enabled = false;
        if (this._ragParamsWatcher) {
            this._ragParamsWatcher.close();
            this._ragParamsWatcher = null;
        }
        console.log('[ContextFoldingV2] 插件已关闭');
    }
}

module.exports = new ContextFoldingV2();
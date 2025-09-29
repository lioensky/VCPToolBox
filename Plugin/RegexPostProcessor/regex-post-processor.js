// Plugin/RegexPostProcessor/regex-post-processor.js
// 正则表达式后处理器插件

const fs = require('fs').promises;
const path = require('path');

class RegexPostProcessor {
    constructor() {
        this.regexRules = [];
        this.structuredChunkRules = []; // 新增：结构化chunk处理规则
        this.config = {};
        this.chunkBuffer = '';
        this.lastProcessTime = 0;
        this.isInitialized = false;
        this.rulesFilePath = path.join(__dirname, 'regex-rules.json');
        this.streamingBuffer = ''; // 新增：流式处理专用缓冲区
        this.lastStreamProcessTime = 0; // 新增：最后流式处理时间
        this.minChunkSize = 10; // 新增：最小chunk大小阈值
        this.maxChunkSize = 1000; // 新增：最大chunk大小阈值
        this.processInterval = 500; // 新增：处理间隔（毫秒）
        this.pendingContent = ''; // 新增：待处理内容
        this.structuredChunkDetectors = new Map(); // 新增：结构化chunk检测器
        this.activeStructuredChunks = new Map(); // 新增：活跃的结构化chunk

        // 新增：真正的流式拦截状态机属性
        this.streamingState = 'NORMAL'; // NORMAL, INTERCEPTING
        this.interceptBuffer = ''; // 拦截状态下的缓冲区
        this.interceptStartTime = null; // 拦截开始时间
        this.interceptRule = null; // 当前拦截的规则
    }

    async initialize(config) {
        this.config = config || {};
        console.log('[RegexPostProcessor] Initializing with config:', JSON.stringify(this.config, null, 2));

        try {
            // 加载正则表达式规则文件
            await this.loadRegexRules();

            this.isInitialized = true;
            console.log('[RegexPostProcessor] Initialization completed successfully');
        } catch (error) {
            console.error('[RegexPostProcessor] Initialization failed:', error);
            throw error;
        }
    }

    async loadRegexRules() {
        try {
            console.log(`[RegexPostProcessor] Loading regex rules from: ${this.rulesFilePath}`);

            // 检查规则文件是否存在
            try {
                await fs.access(this.rulesFilePath);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log('[RegexPostProcessor] Rules file not found, creating default rules file...');
                    await this.createDefaultRulesFile();
                } else {
                    throw error;
                }
            }

            // 读取并解析规则文件
            const rulesFileContent = await fs.readFile(this.rulesFilePath, 'utf-8');
            const rulesConfig = JSON.parse(rulesFileContent);

            if (rulesConfig.rules && Array.isArray(rulesConfig.rules)) {
                // 分离普通正则规则和结构化chunk规则
                const regularRules = [];
                const structuredRules = [];

                for (const rule of rulesConfig.rules) {
                    if (rule.type === 'structured_chunk') {
                        structuredRules.push(rule);
                    } else {
                        regularRules.push(rule);
                    }
                }

                // 处理普通正则规则
                this.regexRules = regularRules.map(rule => {
                    try {
                        return {
                            pattern: new RegExp(rule.pattern, rule.flags || 'g'),
                            replacement: rule.replacement || '',
                            description: rule.description || `Rule: ${rule.pattern} -> ${rule.replacement}`,
                            enabled: rule.enabled !== false
                        };
                    } catch (regexError) {
                        console.error(`[RegexPostProcessor] Invalid regex pattern "${rule.pattern}":`, regexError.message);
                        return null;
                    }
                }).filter(rule => rule !== null);

                // 处理结构化chunk规则
                this.structuredChunkRules = structuredRules.map(rule => {
                    try {
                        const structuredRule = {
                            name: rule.name || `structured_rule_${Date.now()}`,
                            startPattern: new RegExp(rule.start_pattern, rule.options?.multiline ? 'gm' : 'g'),
                            endPattern: new RegExp(rule.end_pattern, rule.options?.multiline ? 'gm' : 'g'),
                            action: rule.action || 'replace',
                            replacement: rule.replacement || '',
                            description: rule.description || `Structured chunk rule: ${rule.start_pattern} -> ${rule.end_pattern}`,
                            enabled: rule.enabled !== false,
                            options: {
                                captureGroups: rule.options?.capture_groups !== false,
                                multiline: rule.options?.multiline === true,
                                greedy: rule.options?.greedy !== false,
                                maxChunkSize: rule.options?.max_chunk_size || 10000,
                                timeoutMs: rule.options?.timeout_ms || 5000
                            },
                            metadata: rule.metadata || {}
                        };

                        console.log(`[RegexPostProcessor] Loaded structured chunk rule: ${structuredRule.name}`);
                        return structuredRule;
                    } catch (regexError) {
                        console.error(`[RegexPostProcessor] Invalid structured chunk rule "${rule.name}":`, regexError.message);
                        return null;
                    }
                }).filter(rule => rule !== null);

                console.log(`[RegexPostProcessor] Loaded ${this.regexRules.length} regex rules and ${this.structuredChunkRules.length} structured chunk rules from file`);
            } else {
                throw new Error('Invalid rules file format: missing "rules" array');
            }

        } catch (error) {
            console.error('[RegexPostProcessor] Error loading regex rules:', error);

            // 如果文件加载失败，使用内置的默认规则
            console.log('[RegexPostProcessor] Using built-in default rules as fallback');
            this.regexRules = [
                {
                    pattern: /我/g,
                    replacement: '偶',
                    description: '默认规则：将"我"替换为"偶"',
                    enabled: true
                }
            ];
        }
    }

    async createDefaultRulesFile() {
        const defaultRules = {
            rules: [
                {
                    pattern: "我",
                    replacement: "偶",
                    flags: "g",
                    description: "将'我'替换为'偶'",
                    enabled: true
                }
            ],
            version: "1.0.0",
            description: "RegexPostProcessor插件的默认正则表达式规则配置"
        };

        try {
            await fs.writeFile(this.rulesFilePath, JSON.stringify(defaultRules, null, 2), 'utf-8');
            console.log('[RegexPostProcessor] Created default rules file');
        } catch (writeError) {
            console.error('[RegexPostProcessor] Failed to create default rules file:', writeError);
        }
    }

    async processResponse(content, config, isStreaming = false, chunkBuffer = null) {
        if (!this.isInitialized) {
            await this.initialize(config);
        }

        if (!content || typeof content !== 'string') {
            console.log('[RegexPostProcessor DEBUG] No content to process or invalid content type');
            return content;
        }

        if (this.regexRules.length === 0) {
            console.log('[RegexPostProcessor DEBUG] No regex rules configured, returning original content');
            return content;
        }

        // 更新配置参数
        if (config) {
            this.minChunkSize = config.minChunkSize || 10;
            this.maxChunkSize = config.maxChunkSize || 1000;
            this.processInterval = config.processInterval || 500;
        }

        try {
            if (isStreaming) {
                return await this.processStreamingChunk(content, chunkBuffer);
            } else {
                // 非流式模式：保持原有逻辑，并支持结构化chunk处理
                console.log(`[RegexPostProcessor DEBUG] === NON-STREAMING PROCESSING START ===`);
                console.log(`[RegexPostProcessor DEBUG] Content length: ${content.length}`);
                console.log(`[RegexPostProcessor DEBUG] Content preview: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
                console.log(`[RegexPostProcessor DEBUG] Active regex rules: ${this.regexRules.filter(r => r.enabled).length}/${this.regexRules.length}`);
                console.log(`[RegexPostProcessor DEBUG] Active structured rules: ${this.structuredChunkRules.filter(r => r.enabled).length}/${this.structuredChunkRules.length}`);

                let processedContent = content;
                let rulesApplied = 0;

                // 先处理结构化chunk规则
                for (const rule of this.structuredChunkRules) {
                    if (!rule.enabled) {
                        console.log(`[RegexPostProcessor DEBUG] Skipping disabled structured rule: ${rule.description}`);
                        continue;
                    }

                    const originalContent = processedContent;
                    try {
                        // 对于非流式模式，我们可以直接应用结构化规则
                        const fullMatch = rule.startPattern.exec(processedContent);
                        if (fullMatch) {
                            // 找到了包含结束标记的完整结构化chunk
                            console.log(`[RegexPostProcessor DEBUG] ✓ Found complete structured chunk: ${rule.name}`);

                            switch (rule.action) {
                                case 'replace':
                                    // 直接替换整个匹配的内容
                                    processedContent = processedContent.replace(rule.startPattern, rule.replacement);
                                    break;
                                case 'remove':
                                    // 移除整个匹配的内容
                                    processedContent = processedContent.replace(rule.startPattern, '');
                                    break;
                                case 'modify':
                                    // 修改内容（这里可以实现更复杂的修改逻辑）
                                    processedContent = processedContent.replace(rule.startPattern, rule.replacement);
                                    break;
                            }

                            if (processedContent !== originalContent) {
                                rulesApplied++;
                                console.log(`[RegexPostProcessor DEBUG] ✓ Applied structured rule: ${rule.description}`);
                                console.log(`[RegexPostProcessor DEBUG]   Action: ${rule.action}`);
                                console.log(`[RegexPostProcessor DEBUG]   Length change: ${originalContent.length} -> ${processedContent.length}`);
                            }
                        } else {
                            console.log(`[RegexPostProcessor DEBUG] - Structured rule ${rule.name} did not match`);
                        }
                    } catch (ruleError) {
                        console.error(`[RegexPostProcessor DEBUG] ✗ Error applying structured rule ${rule.description}:`, ruleError.message);
                    }
                }

                // 应用所有启用的正则表达式规则
                for (const rule of this.regexRules) {
                    if (!rule.enabled) {
                        console.log(`[RegexPostProcessor DEBUG] Skipping disabled rule: ${rule.description}`);
                        continue;
                    }

                    const originalContent = processedContent;
                    const originalLength = originalContent.length;

                    try {
                        processedContent = processedContent.replace(rule.pattern, rule.replacement);
                        const newLength = processedContent.length;

                        if (processedContent !== originalContent) {
                            rulesApplied++;
                            console.log(`[RegexPostProcessor DEBUG] ✓ Applied rule: ${rule.description}`);
                            console.log(`[RegexPostProcessor DEBUG]   Pattern: ${rule.pattern.source}`);
                            console.log(`[RegexPostProcessor DEBUG]   Replacement: "${rule.replacement}"`);
                            console.log(`[RegexPostProcessor DEBUG]   Length change: ${originalLength} -> ${newLength}`);
                        } else {
                            console.log(`[RegexPostProcessor DEBUG] - Rule did not match: ${rule.description}`);
                        }
                    } catch (ruleError) {
                        console.error(`[RegexPostProcessor DEBUG] ✗ Error applying rule ${rule.description}:`, ruleError.message);
                    }
                }

                console.log(`[RegexPostProcessor DEBUG] === NON-STREAMING PROCESSING END ===`);
                if (rulesApplied > 0) {
                    console.log(`[RegexPostProcessor DEBUG] ✓ Applied ${rulesApplied} rule(s) to content`);
                    console.log(`[RegexPostProcessor DEBUG] ✓ Content length changed: ${content.length} -> ${processedContent.length}`);
                } else {
                    console.log('[RegexPostProcessor DEBUG] - No regex rules were applied');
                }

                return processedContent;
            }

        } catch (error) {
            console.error('[RegexPostProcessor DEBUG] ✗ Error processing content:', error);
            // 发生错误时返回原始内容
            return content;
        }
    }

    // 新增：流式chunk处理方法（状态机版本，改进版）
    async processStreamingChunk(chunkContent, chunkBuffer = null) {
        try {
            // 输入验证
            if (chunkContent === null || chunkContent === undefined) {
                console.log(`[RegexPostProcessor STREAM] Received null/undefined chunk, ignoring`);
                return '';
            }

            if (typeof chunkContent !== 'string') {
                console.log(`[RegexPostProcessor STREAM] Received non-string chunk, converting to string`);
                chunkContent = String(chunkContent);
            }

            const currentTime = Date.now();
            console.log(`[RegexPostProcessor STREAM] Processing chunk (length: ${chunkContent.length})`);
            console.log(`[RegexPostProcessor STREAM] Current state: ${this.streamingState}`);

            // 状态机处理
            const stateResult = this.processStreamingStateMachine(chunkContent);

            if (stateResult === null || stateResult.output === null) {
                // 状态机要求拦截内容
                console.log(`[RegexPostProcessor STREAM] State machine requested interception`);
                return '';
            }

            if (typeof stateResult.output === 'string') {
                if (stateResult.output === '') {
                    // 状态机返回空字符串，表示内容被过滤
                    console.log(`[RegexPostProcessor STREAM] State machine filtered content, returning empty`);
                    return '';
                } else {
                    // 状态机返回了内容，需要应用普通正则规则
                    console.log(`[RegexPostProcessor STREAM] State machine returned content, applying regex rules`);

                    let processedContent = stateResult.output;
                    let rulesApplied = 0;

                    // 安全地应用正则规则
                    for (const rule of this.regexRules) {
                        if (!rule.enabled || !rule.pattern || !rule.replacement) {
                            continue;
                        }

                        try {
                            // 重置正则表达式的lastIndex
                            rule.pattern.lastIndex = 0;
                            const originalContent = processedContent;
                            processedContent = processedContent.replace(rule.pattern, rule.replacement);

                            if (processedContent !== originalContent) {
                                rulesApplied++;
                                console.log(`[RegexPostProcessor STREAM] ✓ Applied regex rule: ${rule.description}`);
                            }
                        } catch (ruleError) {
                            console.error(`[RegexPostProcessor STREAM] ✗ Error applying regex rule ${rule.description}:`, ruleError.message);
                        }
                    }

                    if (rulesApplied > 0) {
                        console.log(`[RegexPostProcessor STREAM] ✓ Applied ${rulesApplied} regex rule(s) to state machine output`);
                    }

                    return processedContent;
                }
            }

            // 意外的状态结果
            console.error(`[RegexPostProcessor STREAM] ⚠ Unexpected state result:`, stateResult);
            return chunkContent;

        } catch (error) {
            console.error(`[RegexPostProcessor STREAM] ✗ Error in processStreamingChunk:`, error);
            // 出错时返回原始内容，确保不会丢失数据
            return chunkContent;
        }
    }

    // 新增：真正的流式拦截状态机（改进版）
    processStreamingStateMachine(chunkContent) {
        try {
            switch (this.streamingState) {
                case 'NORMAL':
                    console.log(`[RegexPostProcessor INTERCEPT] NORMAL state, checking for start patterns`);

                    // 检查当前chunk是否匹配任何结构化chunk规则的开始模式
                    const startCheckResult = this.checkForStructuredChunkStart(chunkContent);
                    if (startCheckResult.matched && startCheckResult.rule) {
                        const rule = startCheckResult.rule;
                        console.log(`[RegexPostProcessor INTERCEPT] ✓ Detected start pattern: ${rule.name}`);

                        // 验证规则是否有效
                        if (!rule.enabled) {
                            console.log(`[RegexPostProcessor INTERCEPT] - Rule ${rule.name} is disabled, ignoring`);
                            return { output: chunkContent };
                        }

                        // 进入拦截状态
                        this.streamingState = 'INTERCEPTING';
                        this.interceptRule = rule;
                        this.interceptBuffer = chunkContent;
                        this.interceptStartTime = Date.now();

                        console.log(`[RegexPostProcessor INTERCEPT] ✓ Entered INTERCEPTING state for rule: ${rule.name}`);

                        // 注意：这里不检查当前chunk是否包含完整结构
                        // 一旦检测到开始标记或片段，立即开始拦截
                        console.log(`[RegexPostProcessor INTERCEPT] ✓ Started intercepting, waiting for end marker`);
                        return { output: null };
                    }

                    // 正常状态，无需拦截
                    return { output: chunkContent };

                case 'INTERCEPTING':
                    console.log(`[RegexPostProcessor INTERCEPT] INTERCEPTING state, buffer size: ${this.interceptBuffer.length}`);

                    // 累积拦截内容
                    this.interceptBuffer += chunkContent;

                    // 检查安全限制
                    const timeoutMs = this.interceptRule?.options?.timeout_ms || 5000;
                    const maxChunkSize = this.interceptRule?.options?.max_chunk_size || 10000;

                    if (Date.now() - this.interceptStartTime > timeoutMs) {
                        console.log(`[RegexPostProcessor INTERCEPT] ⚠ Interception timed out, aborting interception`);
                        const interceptedContent = this.interceptBuffer;
                        this.resetInterceptionState();
                        return { output: interceptedContent };
                    }

                    if (this.interceptBuffer.length > maxChunkSize) {
                        console.log(`[RegexPostProcessor INTERCEPT] ⚠ Interception buffer exceeded max size, aborting interception`);
                        const interceptedContent = this.interceptBuffer;
                        this.resetInterceptionState();
                        return { output: interceptedContent };
                    }

                    // 检查结束标记
                    try {
                        const endMatch = this.interceptRule.endPattern.exec(this.interceptBuffer);
                        if (endMatch) {
                            console.log(`[RegexPostProcessor INTERCEPT] ✓ Found end marker, interception complete`);
                            this.resetInterceptionState();
                            return { output: '' };
                        }
                    } catch (error) {
                        console.error(`[RegexPostProcessor INTERCEPT] ✗ Error testing end pattern:`, error);
                        // 出错时重置状态并返回累积内容
                        const interceptedContent = this.interceptBuffer;
                        this.resetInterceptionState();
                        return { output: interceptedContent };
                    }

                    // 仍在拦截中，不输出任何内容
                    console.log(`[RegexPostProcessor INTERCEPT] Still intercepting, waiting for end marker`);
                    return { output: null };

                default:
                    console.error(`[RegexPostProcessor INTERCEPT] ⚠ Unknown streaming state: ${this.streamingState}, resetting to NORMAL`);
                    this.streamingState = 'NORMAL';
                    return { output: chunkContent };
            }
        } catch (error) {
            console.error(`[RegexPostProcessor INTERCEPT] ✗ Error in state machine:`, error);
            // 出错时重置状态并返回原始内容
            this.resetInterceptionState();
            return { output: chunkContent };
        }
    }

    // 新增：重置拦截状态的辅助方法
    resetInterceptionState() {
        this.streamingState = 'NORMAL';
        this.interceptBuffer = '';
        this.interceptStartTime = null;
        this.interceptRule = null;
        console.log(`[RegexPostProcessor INTERCEPT] ✓ Interception state reset`);
    }

    // 流式拦截状态机已重新设计，不再需要复杂的监听器管理
    // 新的状态机直接在processStreamingStateMachine中处理拦截逻辑

    // 新增：检查chunk是否匹配任何结构化规则的开始模式（改进版）
    checkForStructuredChunkStart(chunkContent) {
        if (!chunkContent || typeof chunkContent !== 'string') {
            return { matched: false };
        }

        // 检查当前chunk是否直接匹配开始模式
        for (const rule of this.structuredChunkRules) {
            if (!rule.enabled || !rule.startPattern) {
                continue;
            }

            try {
                // 重置正则表达式的lastIndex，确保从头开始匹配
                rule.startPattern.lastIndex = 0;
                const startMatch = rule.startPattern.exec(chunkContent);

                if (startMatch) {
                    console.log(`[RegexPostProcessor INTERCEPT] ✓ Detected start pattern for rule: ${rule.name}`);
                    console.log(`[RegexPostProcessor INTERCEPT] Match: "${startMatch[0]}"`);
                    return {
                        matched: true,
                        rule: rule,
                        match: startMatch
                    };
                }
            } catch (error) {
                console.error(`[RegexPostProcessor INTERCEPT] ✗ Error testing start pattern for rule ${rule.name}:`, error.message);
            }
        }

        // 检查当前chunk与拦截缓冲区的组合是否匹配开始模式
        if (this.interceptBuffer && this.streamingState === 'INTERCEPTING') {
            const combinedContent = this.interceptBuffer + chunkContent;
            for (const rule of this.structuredChunkRules) {
                if (!rule.enabled || !rule.startPattern || rule.name !== this.interceptRule?.name) {
                    continue;
                }

                try {
                    // 重置正则表达式的lastIndex
                    rule.startPattern.lastIndex = 0;
                    const startMatch = rule.startPattern.exec(combinedContent);

                    if (startMatch) {
                        console.log(`[RegexPostProcessor INTERCEPT] ✓ Detected start pattern in combined content for rule: ${rule.name}`);
                        return {
                            matched: true,
                            rule: rule,
                            match: startMatch,
                            combined: true
                        };
                    }
                } catch (error) {
                    console.error(`[RegexPostProcessor INTERCEPT] ✗ Error testing start pattern on combined content for rule ${rule.name}:`, error.message);
                }
            }
        }

        // 检查当前chunk是否包含结构化标记的片段（用于跨chunk检测）
        for (const rule of this.structuredChunkRules) {
            if (!rule.enabled) continue;

            try {
                // 检查是否包含开始标记的片段
                if (chunkContent.includes('<<<[') && chunkContent.includes('>>>')) {
                    console.log(`[RegexPostProcessor INTERCEPT] ✓ Detected potential structured chunk fragment for rule: ${rule.name}`);
                    return {
                        matched: true,
                        rule: rule,
                        fragment: true
                    };
                }
            } catch (error) {
                console.error(`[RegexPostProcessor INTERCEPT] ✗ Error testing rule ${rule.name} for fragments:`, error.message);
            }
        }

        return { matched: false };
    }

    // 新增：检测和处理结构化chunk（流式优化版本）
    detectAndProcessStructuredChunks(chunkContent) {
        // 首先检查是否有正在等待结束标记的结构化chunk
        for (const [detectorId, detector] of this.activeStructuredChunks.entries()) {
            // 将新chunk内容累积到检测器中
            detector.accumulatedContent += chunkContent;
            detector.lastActivity = Date.now();

            console.log(`[RegexPostProcessor STRUCTURED] Accumulating chunk for ${detectorId}, total size: ${detector.accumulatedContent.length}`);

            // 检查是否超时
            if (Date.now() - detector.startTime > detector.rule.options.timeoutMs) {
                console.log(`[RegexPostProcessor STRUCTURED] Structured chunk ${detectorId} timed out`);
                const result = this.completeStructuredChunk(detectorId, detector.accumulatedContent);
                this.activeStructuredChunks.delete(detectorId);
                return {
                    processed: true,
                    output: result.output
                };
            }

            // 检查结束标记
            const endMatch = detector.rule.endPattern.exec(detector.accumulatedContent);
            if (endMatch) {
                console.log(`[RegexPostProcessor STRUCTURED] Found complete structured chunk: ${detectorId}`);
                const result = this.completeStructuredChunk(detectorId, detector.accumulatedContent);
                this.activeStructuredChunks.delete(detectorId);
                return {
                    processed: true,
                    output: result.output
                };
            }

            // 检查是否超过最大大小
            if (detector.accumulatedContent.length > detector.rule.options.maxChunkSize) {
                console.log(`[RegexPostProcessor STRUCTURED] Structured chunk ${detectorId} exceeded max size`);
                const result = this.completeStructuredChunk(detectorId, detector.accumulatedContent);
                this.activeStructuredChunks.delete(detectorId);
                return {
                    processed: true,
                    output: result.output
                };
            }

            // 结构化chunk正在累积中，返回空内容（不发送给客户端）
            return {
                processed: true,
                output: ''
            };
        }

        // 检查当前chunk是否包含结构化chunk的开始标记
        for (const rule of this.structuredChunkRules) {
            if (!rule.enabled) continue;

            try {
                // 检查当前chunk是否包含完整的结构化内容
                const fullMatch = rule.startPattern.exec(chunkContent);
                if (fullMatch) {
                    console.log(`[RegexPostProcessor STRUCTURED] Detected structured chunk pattern: ${rule.name}`);

                    // 创建新的检测器
                    const detectorId = `${rule.name}_${Date.now()}`;
                    const detector = {
                        rule: rule,
                        startMatch: fullMatch,
                        accumulatedContent: chunkContent,
                        startTime: Date.now(),
                        lastActivity: Date.now()
                    };

                    this.activeStructuredChunks.set(detectorId, detector);

                    // 检查当前chunk是否已经包含完整的结构
                    const endMatch = rule.endPattern.exec(chunkContent);
                    if (endMatch) {
                        console.log(`[RegexPostProcessor STRUCTURED] Single chunk contains complete structure: ${rule.name}`);
                        const result = this.completeStructuredChunk(detectorId, chunkContent);
                        this.activeStructuredChunks.delete(detectorId);
                        return {
                            processed: true,
                            output: result.output
                        };
                    } else {
                        // 结构化chunk已开始但未完成，返回空内容（不发送给客户端）
                        console.log(`[RegexPostProcessor STRUCTURED] Started structured chunk ${detectorId}, waiting for end marker`);
                        return {
                            processed: true,
                            output: ''
                        };
                    }
                }
            } catch (error) {
                console.error(`[RegexPostProcessor STRUCTURED] Error in rule ${rule.name}:`, error.message);
            }
        }

        // 当前chunk不包含结构化内容，正常处理
        return { processed: false };
    }

    // 新增：处理活跃的结构化chunk
    processActiveStructuredChunk(detectorId, chunkContent) {
        const detector = this.activeStructuredChunks.get(detectorId);
        if (!detector) return { completed: false };

        detector.accumulatedContent += chunkContent;
        detector.lastActivity = Date.now();

        // 检查是否超时
        if (Date.now() - detector.startTime > detector.rule.options.timeoutMs) {
            console.log(`[RegexPostProcessor STRUCTURED] Structured chunk ${detectorId} timed out`);
            this.activeStructuredChunks.delete(detectorId);
            return {
                completed: true,
                output: detector.accumulatedContent // 返回原始内容
            };
        }

        // 检查结束标记
        const endMatch = detector.rule.endPattern.exec(detector.accumulatedContent);
        if (endMatch) {
            console.log(`[RegexPostProcessor STRUCTURED] Found end of structured chunk: ${detectorId}`);
            const result = this.completeStructuredChunk(detectorId, detector.accumulatedContent);
            this.activeStructuredChunks.delete(detectorId);
            return {
                completed: true,
                output: result.output
            };
        }

        // 检查是否超过最大chunk大小
        if (detector.accumulatedContent.length > detector.rule.options.maxChunkSize) {
            console.log(`[RegexPostProcessor STRUCTURED] Structured chunk ${detectorId} exceeded max size`);
            const result = this.completeStructuredChunk(detectorId, detector.accumulatedContent);
            this.activeStructuredChunks.delete(detectorId);
            return {
                completed: true,
                output: result.output
            };
        }

        return { completed: false };
    }

    // 新增：完成结构化chunk处理
    completeStructuredChunk(listenerId, content) {
        const listener = this.activeStructuredChunks.get(listenerId);
        if (!listener) {
            return { output: content };
        }

        const rule = listener.rule;
        console.log(`[RegexPostProcessor STRUCTURED] Processing structured chunk: ${rule.name}`);
        console.log(`[RegexPostProcessor STRUCTURED] Rule type: ${rule.type || 'unknown'}`);
        console.log(`[RegexPostProcessor STRUCTURED] Rule action: ${rule.action}`);
        console.log(`[RegexPostProcessor STRUCTURED] Content length: ${content.length}`);
        console.log(`[RegexPostProcessor STRUCTURED] Content preview: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);

        let processedContent = content;

        try {
            switch (rule.action) {
                case 'replace':
                    // 使用规则定义的replacement进行替换
                    processedContent = rule.replacement;
                    console.log(`[RegexPostProcessor STRUCTURED] ✓ Replaced structured chunk with: "${processedContent}"`);
                    console.log(`[RegexPostProcessor STRUCTURED] ✓ Content filtered: ${content.length} -> ${processedContent.length}`);
                    break;

                case 'remove':
                    // 完全移除内容
                    processedContent = '';
                    console.log(`[RegexPostProcessor STRUCTURED] ✓ Removed structured chunk`);
                    console.log(`[RegexPostProcessor STRUCTURED] ✓ Content removed: ${content.length} -> 0`);
                    break;

                case 'modify':
                    // 修改内容：使用规则的start_pattern进行替换
                    try {
                        processedContent = content.replace(rule.startPattern, rule.replacement);
                        console.log(`[RegexPostProcessor STRUCTURED] ✓ Modified structured chunk using pattern replacement`);
                    } catch (regexError) {
                        console.error(`[RegexPostProcessor STRUCTURED] ✗ Regex error in modify action:`, regexError.message);
                        processedContent = content; // 出错时返回原始内容
                    }
                    break;

                default:
                    console.log(`[RegexPostProcessor STRUCTURED] ⚠ Unknown action: ${rule.action}, keeping original content`);
                    processedContent = content;
            }

            // 记录处理结果
            if (processedContent !== content) {
                console.log(`[RegexPostProcessor STRUCTURED] ✓ Successfully processed structured chunk: ${rule.name}`);
                console.log(`[RegexPostProcessor STRUCTURED] ✓ Processing result: ${content.length} chars -> ${processedContent.length} chars`);
            } else {
                console.log(`[RegexPostProcessor STRUCTURED] - No changes made to structured chunk: ${rule.name}`);
            }

        } catch (error) {
            console.error(`[RegexPostProcessor STRUCTURED] ✗ Error processing structured chunk ${rule.name}:`, error);
            processedContent = content; // 出错时返回原始内容
        }

        return { output: processedContent };
    }

    // 新增：判断是否应该处理流式缓冲区（改进版）
    shouldProcessStreamingBuffer(currentTime) {
        try {
            // 如果正在拦截状态，优先处理
            if (this.streamingState === 'INTERCEPTING') {
                console.log(`[RegexPostProcessor STREAM] In INTERCEPTING state, should process`);
                return true;
            }

            // 缓冲区大小检查
            if (this.streamingBuffer.length >= this.maxChunkSize) {
                console.log(`[RegexPostProcessor STREAM] Buffer size threshold reached (${this.streamingBuffer.length} >= ${this.maxChunkSize})`);
                return true;
            }

            // 时间间隔检查
            if (this.lastStreamProcessTime > 0 && currentTime - this.lastStreamProcessTime >= this.processInterval) {
                console.log(`[RegexPostProcessor STREAM] Time interval reached (${currentTime - this.lastStreamProcessTime}ms >= ${this.processInterval}ms)`);
                return true;
            }

            // 句子结束检查（只在缓冲区不为空时检查）
            if (this.streamingBuffer.length > 0) {
                if (this.streamingBuffer.includes('。') || this.streamingBuffer.includes('.') ||
                    this.streamingBuffer.includes('！') || this.streamingBuffer.includes('!') ||
                    this.streamingBuffer.includes('？') || this.streamingBuffer.includes('?')) {
                    console.log(`[RegexPostProcessor STREAM] Sentence boundary detected`);
                    return true;
                }
            }

            // 缓冲区内容检查（防止缓冲区过小但包含重要内容）
            if (this.streamingBuffer.length > this.minChunkSize) {
                console.log(`[RegexPostProcessor STREAM] Buffer size sufficient for processing (${this.streamingBuffer.length} > ${this.minChunkSize})`);
                return true;
            }

            return false;
        } catch (error) {
            console.error(`[RegexPostProcessor STREAM] ✗ Error in shouldProcessStreamingBuffer:`, error);
            // 出错时返回true，确保内容被处理
            return true;
        }
    }

    // 新增：检查缓冲区中是否有潜在的结构化chunk模式
    hasPotentialStructuredChunk() {
        for (const rule of this.structuredChunkRules) {
            if (!rule.enabled) continue;

            try {
                if (rule.startPattern.test(this.streamingBuffer)) {
                    console.log(`[RegexPostProcessor STREAM] Found potential structured chunk pattern: ${rule.name}`);
                    return true;
                }
            } catch (error) {
                console.error(`[RegexPostProcessor STREAM] Error testing rule ${rule.name}:`, error.message);
            }
        }
        return false;
    }

    // 新增：清理过期的结构化chunk
    cleanupExpiredStructuredChunks() {
        const currentTime = Date.now();
        const expiredDetectors = [];

        for (const [detectorId, detector] of this.activeStructuredChunks.entries()) {
            if (currentTime - detector.lastActivity > detector.rule.options.timeoutMs) {
                console.log(`[RegexPostProcessor STRUCTURED] Cleaning up expired structured chunk: ${detectorId}`);
                expiredDetectors.push(detectorId);
            }
        }

        expiredDetectors.forEach(id => {
            this.activeStructuredChunks.delete(id);
        });

        if (expiredDetectors.length > 0) {
            console.log(`[RegexPostProcessor STRUCTURED] Cleaned up ${expiredDetectors.length} expired structured chunks`);
        }
    }

    async shutdown() {
        console.log('[RegexPostProcessor] Shutting down...');
        this.regexRules = [];
        this.structuredChunkRules = [];
        this.config = {};
        this.chunkBuffer = '';
        this.streamingBuffer = '';
        this.pendingContent = '';
        this.structuredChunkDetectors.clear();
        this.activeStructuredChunks.clear();

        // 重置拦截状态机属性
        this.streamingState = 'NORMAL';
        this.interceptBuffer = '';
        this.interceptStartTime = null;
        this.interceptRule = null;

        this.isInitialized = false;
        console.log('[RegexPostProcessor] Shutdown completed');
    }

    // 新增：验证结构化chunk规则的完整性
    validateStructuredChunkRule(rule) {
        const errors = [];

        if (!rule.name) {
            errors.push('Rule name is required');
        }

        if (!rule.start_pattern) {
            errors.push('Start pattern is required');
        }

        if (!rule.end_pattern) {
            errors.push('End pattern is required');
        }

        if (!['replace', 'remove', 'modify'].includes(rule.action)) {
            errors.push('Action must be one of: replace, remove, modify');
        }

        // 验证正则表达式
        try {
            new RegExp(rule.start_pattern, rule.options?.multiline ? 'gm' : 'g');
        } catch (error) {
            errors.push(`Invalid start pattern: ${error.message}`);
        }

        try {
            new RegExp(rule.end_pattern, rule.options?.multiline ? 'gm' : 'g');
        } catch (error) {
            errors.push(`Invalid end pattern: ${error.message}`);
        }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    // 获取插件状态信息
    getStatus() {
        return {
            initialized: this.isInitialized,
            ruleCount: this.regexRules.length,
            enabledRules: this.regexRules.filter(rule => rule.enabled).length,
            structuredChunkRuleCount: this.structuredChunkRules.length,
            enabledStructuredRules: this.structuredChunkRules.filter(rule => rule.enabled).length,
            chunkBufferSize: this.chunkBuffer.length,
            streamingBufferSize: this.streamingBuffer.length,
            activeStructuredChunks: this.activeStructuredChunks.size,
            lastProcessTime: this.lastProcessTime,
            lastStreamProcessTime: this.lastStreamProcessTime,
            minChunkSize: this.minChunkSize,
            maxChunkSize: this.maxChunkSize,
            processInterval: this.processInterval,
            streamingState: this.streamingState,
            interceptState: {
                state: this.streamingState,
                bufferSize: this.interceptBuffer.length,
                startTime: this.interceptStartTime,
                ruleName: this.interceptRule?.name || null
            }
        };
    }

    // 重新加载规则文件
    async reloadRules() {
        console.log('[RegexPostProcessor] Reloading regex rules from file...');
        try {
            await this.loadRegexRules();
            console.log(`[RegexPostProcessor] Reloaded ${this.regexRules.length} regex rules from file`);
            return { success: true, ruleCount: this.regexRules.length };
        } catch (error) {
            console.error('[RegexPostProcessor] Error reloading rules:', error);
            return { success: false, error: error.message };
        }
    }

    // 动态更新正则表达式规则并保存到文件
    async updateRules(newRules) {
        console.log('[RegexPostProcessor] Updating regex rules and saving to file...');
        try {
            if (newRules.rules && Array.isArray(newRules.rules)) {
                // 验证新规则
                const validatedRules = newRules.rules.map(rule => {
                    try {
                        // 验证正则表达式是否有效
                        new RegExp(rule.pattern, rule.flags || 'g');
                        return {
                            pattern: rule.pattern,
                            replacement: rule.replacement || '',
                            flags: rule.flags || 'g',
                            description: rule.description || `Rule: ${rule.pattern} -> ${rule.replacement}`,
                            enabled: rule.enabled !== false
                        };
                    } catch (regexError) {
                        console.error(`[RegexPostProcessor] Invalid regex pattern "${rule.pattern}":`, regexError.message);
                        throw new Error(`Invalid regex pattern "${rule.pattern}": ${regexError.message}`);
                    }
                });

                // 更新内存中的规则
                this.regexRules = validatedRules.map(rule => ({
                    pattern: new RegExp(rule.pattern, rule.flags),
                    replacement: rule.replacement,
                    description: rule.description,
                    enabled: rule.enabled
                }));

                // 保存到文件
                const fileContent = {
                    rules: validatedRules,
                    version: "1.0.0",
                    description: "RegexPostProcessor插件的正则表达式规则配置",
                    lastUpdated: new Date().toISOString()
                };

                await fs.writeFile(this.rulesFilePath, JSON.stringify(fileContent, null, 2), 'utf-8');

                console.log(`[RegexPostProcessor] Updated and saved ${this.regexRules.length} regex rules to file`);
                return { success: true, ruleCount: this.regexRules.length };
            } else {
                throw new Error('Invalid rules format: missing "rules" array');
            }
        } catch (error) {
            console.error('[RegexPostProcessor] Error updating rules:', error);
            return { success: false, error: error.message };
        }
    }

    // 新增：动态添加结构化chunk规则
    async addStructuredChunkRule(ruleConfig) {
        console.log('[RegexPostProcessor] Adding new structured chunk rule:', ruleConfig.name);

        try {
            const rule = {
                name: ruleConfig.name || `dynamic_rule_${Date.now()}`,
                startPattern: new RegExp(ruleConfig.start_pattern, ruleConfig.options?.multiline ? 'gm' : 'g'),
                endPattern: new RegExp(ruleConfig.end_pattern, ruleConfig.options?.multiline ? 'gm' : 'g'),
                action: ruleConfig.action || 'replace',
                replacement: ruleConfig.replacement || '',
                description: ruleConfig.description || `Dynamic structured chunk rule: ${ruleConfig.name}`,
                enabled: ruleConfig.enabled !== false,
                options: {
                    captureGroups: ruleConfig.options?.capture_groups !== false,
                    multiline: ruleConfig.options?.multiline === true,
                    greedy: ruleConfig.options?.greedy !== false,
                    maxChunkSize: ruleConfig.options?.max_chunk_size || 10000,
                    timeoutMs: ruleConfig.options?.timeout_ms || 5000
                },
                metadata: ruleConfig.metadata || {}
            };

            this.structuredChunkRules.push(rule);
            console.log(`[RegexPostProcessor] ✓ Successfully added structured chunk rule: ${rule.name}`);
            return { success: true, ruleName: rule.name };
        } catch (error) {
            console.error(`[RegexPostProcessor] ✗ Error adding structured chunk rule:`, error);
            return { success: false, error: error.message };
        }
    }

    // 新增：移除结构化chunk规则
    async removeStructuredChunkRule(ruleName) {
        console.log(`[RegexPostProcessor] Removing structured chunk rule: ${ruleName}`);

        const initialCount = this.structuredChunkRules.length;
        this.structuredChunkRules = this.structuredChunkRules.filter(rule => rule.name !== ruleName);

        if (this.structuredChunkRules.length < initialCount) {
            console.log(`[RegexPostProcessor] ✓ Successfully removed structured chunk rule: ${ruleName}`);
            return { success: true, removed: true };
        } else {
            console.log(`[RegexPostProcessor] ✗ Rule not found: ${ruleName}`);
            return { success: false, error: `Rule not found: ${ruleName}` };
        }
    }

    // 支持通过API调用的方法
    async handleApiCall(action, parameters) {
        switch (action) {
            case 'reload':
                return await this.reloadRules();
            case 'updateRules':
                return await this.updateRules(parameters);
            case 'addStructuredRule':
                return await this.addStructuredChunkRule(parameters);
            case 'removeStructuredRule':
                return await this.removeStructuredChunkRule(parameters.ruleName);
            case 'getStatus':
                return { success: true, status: this.getStatus() };
            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    }
}

// 导出插件模块
const regexProcessorInstance = new RegexPostProcessor();
module.exports = regexProcessorInstance;
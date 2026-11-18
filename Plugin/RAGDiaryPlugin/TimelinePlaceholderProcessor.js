'use strict';

const crypto = require('crypto');
const { findLastRealUserMessage } = require('../../modules/messageProcessor');

const PLACEHOLDER_REGEX = /\[\[VCPTimeLine(Summary|Recall)?::([^:\]\r\n]+?)(?::([^:\]\r\n]+?))?(?::([^:\]\r\n]+?))?\]\]/g;

/**
 * 请求级时间线适配层。只扫描原始声明；业务仍由运行时 Timeline 服务执行。
 * 时间线输出在日记管线完成后以不透明正文回填，禁止交叉递归解析。
 */
class TimelinePlaceholderProcessor {
    constructor(host) {
        this.host = host;
    }

    static parsePlaceholder(match, config) {
        let k = config.defaultExpandK;
        let threshold = config.defaultThreshold;
        const values = [match[3], match[4]].filter(value => value !== undefined).map(value => String(value).trim());
        if (values.length === 1) {
            const numeric = Number(values[0]);
            if (/^\d+$/.test(values[0]) && numeric >= 1) k = Math.floor(numeric);
            else if (Number.isFinite(numeric) && numeric >= 0.01 && numeric <= 0.99) threshold = numeric;
        } else if (values.length >= 2) {
            const parsedK = Number(values[0]);
            const parsedThreshold = Number(values[1]);
            if (/^\d+$/.test(values[0]) && parsedK >= 1) k = Math.floor(parsedK);
            if (Number.isFinite(parsedThreshold) && parsedThreshold >= 0.01 && parsedThreshold <= 0.99) {
                threshold = parsedThreshold;
            }
        }
        return { placeholder: match[0], kind: match[1] || 'combined', agentName: match[2].trim(), k, threshold };
    }

    async buildQueryContext(messages) {
        const host = this.host;
        const userText = findLastRealUserMessage(messages, {
            sanitize: host.sanitizeForEmbedding.bind(host)
        }).sanitizedContent || '';
        const lastAi = messages.findLast(message => message?.role === 'assistant');
        const aiText = host.sanitizeForEmbedding(host._extractTextFromContent(lastAi?.content), 'assistant') || '';
        const [userVector, aiVector] = await Promise.all([
            userText ? host.getSingleEmbeddingCached(userText) : null,
            aiText ? host.getSingleEmbeddingCached(aiText) : null
        ]);
        return {
            userText, aiText,
            queryVector: host._getWeightedAverageVector(
                [userVector, aiVector],
                host.ragParams?.RAGDiaryPlugin?.mainSearchWeights || [0.7, 0.3]
            )
        };
    }

    async processMessages(messages, runDiary) {
        const service = this.host.getTimelineService?.();
        if (!Array.isArray(messages) || !service || !service.config.enabled) return runDiary(messages);

        const declarations = new Map();
        const tokens = new Map();
        const prefix = `__VCP_TIMELINE_${crypto.randomUUID()}_`;
        let tokenIndex = 0;
        const masked = messages.map(message => {
            const text = this.host._extractTextFromContent(message?.content);
            if (!new RegExp(PLACEHOLDER_REGEX.source).test(text)) return message;
            const trusted = message?.role === 'system'
                || (message?.role === 'user' && /^\s*\[系统/.test(text));
            const content = this.host._replaceTextInContent(message?.content, part =>
                part.replace(new RegExp(PLACEHOLDER_REGEX.source, 'g'), (...args) => {
                    const match = args.slice(0, 5);
                    const declaration = TimelinePlaceholderProcessor.parsePlaceholder(match, service.config);
                    if (!trusted || declarations.has(declaration.kind)) return '';
                    const token = `${prefix}${tokenIndex++}__`;
                    declarations.set(declaration.kind, { ...declaration, token });
                    tokens.set(token, '');
                    return token;
                })
            );
            return content === message?.content ? message : { ...message, content };
        });
        // No original declaration: do not scan anything produced by the diary pipeline.
        if (tokenIndex === 0 && !messages.some((message, index) => masked[index] !== message)) {
            return runDiary(messages);
        }

        const timelineTask = (async () => {
            const needsQuery = [...declarations.keys()].some(kind => kind !== 'Summary');
            const queryTask = needsQuery ? this.buildQueryContext(messages).catch(error => {
                console.error('[TimelinePlaceholderProcessor] Query preparation failed:', error);
                return null;
            }) : Promise.resolve(null);
            await Promise.all([...declarations.values()].map(async declaration => {
                try {
                    const agent = service.safeAgentName(declaration.agentName);
                    const { kind, k, threshold, token } = declaration;
                    const queryContext = kind === 'Summary' ? null : await queryTask;
                    const value = kind === 'Summary'
                        ? await service.buildSummaryInjection(agent)
                        : kind === 'Recall'
                            ? await service.buildRecallInjection(agent, queryContext, k, threshold)
                            : await service.buildInjection(agent, queryContext, k, threshold);
                    tokens.set(token, String(value || ''));
                } catch (error) {
                    console.error('[TimelinePlaceholderProcessor] Timeline injection failed:', error);
                    tokens.set(declaration.token, '[时间线处理失败]');
                }
            }));
        })();
        const [processed] = await Promise.all([runDiary(masked), timelineTask]);
        // One replacement pass: inserted text is never rescanned, including $ replacement syntax.
        const tokenRegex = new RegExp(`${prefix}\\d+__`, 'g');
        return processed.map(message => {
            if (!this.host._extractTextFromContent(message.content).includes(prefix)) return message;
            const content = this.host._replaceTextInContent(message.content,
                text => text.replace(tokenRegex, token => tokens.get(token) ?? ''));
            return content === message.content ? message : { ...message, content };
        });
    }
}

module.exports = TimelinePlaceholderProcessor;
'use strict';

function createAIMemoBridge(self) {

    return Object.freeze({
        version: '1.0',

        isConfigured() {
            return !!(
                self.aiMemoHandler &&
                typeof self.aiMemoHandler.isConfigured === 'function' &&
                self.aiMemoHandler.isConfigured()
            );
        },

        /**
         * 对调用方已经召回的记忆候选执行 AIMemo+ 总结。
         * @param {object} options
         * @param {Array<object>} options.candidates - 候选项，正文可位于 text/content
         * @param {string|string[]} [options.diaryNames] - 来源日记本
         * @param {string} options.userContent - 当前查询
         * @param {string} [options.aiContent] - 可选的上一轮 AI 内容
         * @param {string} [options.displayQuery] - VCPInfo 展示查询
         * @param {string|null} [options.presetName] - AIMemo 预设
         * @param {string} [options.cacheSalt] - 调用方检索参数指纹
         * @returns {Promise<string>}
         */
        async summarizeCandidates(options = {}) {
            if (!self.aiMemoHandler || typeof self.aiMemoHandler.processAIMemoPlusAggregated !== 'function') {
                throw new Error('AIMemoHandler 尚未初始化。');
            }

            const candidates = Array.isArray(options.candidates)
                ? options.candidates
                : [];
            const sourceFiles = candidates
                .map((candidate, index) => {
                    const text = String(candidate?.text ?? candidate?.content ?? '').trim();
                    if (!text) return null;

                    return {
                        name: String(
                            candidate?.name ??
                            candidate?.sourceFile ??
                            candidate?.fullPath ??
                            `external_candidate_${index}`
                        ),
                        content: text,
                        text,
                        tokens: Number.isFinite(Number(candidate?.tokens))
                            ? Number(candidate.tokens)
                            : self._estimateTokens(text),
                        dbName: String(candidate?.dbName ?? candidate?.diaryName ?? 'ExternalMemo'),
                        score: Number(
                            candidate?.rerank_score ??
                            candidate?.hybridScore ??
                            candidate?.vectorScore ??
                            candidate?.score ??
                            0
                        ) || 0,
                        source: String(candidate?.source ?? 'external_retrieval')
                    };
                })
                .filter(Boolean);

            if (sourceFiles.length === 0) {
                throw new Error('没有可供 AIMemo 总结的有效候选。');
            }

            const rawDiaryNames = Array.isArray(options.diaryNames)
                ? options.diaryNames
                : [options.diaryNames];
            const diaryNames = [...new Set(
                rawDiaryNames
                    .map(name => String(name || '').trim())
                    .filter(Boolean)
            )];
            if (diaryNames.length === 0) {
                sourceFiles.forEach(file => {
                    if (file.dbName && !diaryNames.includes(file.dbName)) diaryNames.push(file.dbName);
                });
            }

            const userContent = String(options.userContent || '').trim();
            if (!userContent) {
                throw new Error('AIMemo 总结需要非空 userContent。');
            }

            return self.aiMemoHandler.processAIMemoPlusAggregated(
                diaryNames.length > 0 ? diaryNames : ['ExternalMemo'],
                userContent,
                String(options.aiContent || '').trim() || null,
                String(options.displayQuery || userContent),
                options.presetName ? String(options.presetName).trim() : null,
                {
                    sourceFiles,
                    baseK: Math.max(1, sourceFiles.length),
                    cacheSalt: String(options.cacheSalt || 'external_candidates')
                }
            );
        }
    });
}

module.exports = createAIMemoBridge;

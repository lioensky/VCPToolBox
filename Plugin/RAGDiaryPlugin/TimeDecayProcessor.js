// Plugin/RAGDiaryPlugin/TimeDecayProcessor.js

/**
 * TimeDecay 衰减重排处理器
 */
class TimeDecayProcessor {
    /**
     * 解析 TimeDecay 参数
     * 语法：::TimeDecay[halfLife]|[minScore]|[whitelistTags]
     */
    static parseTimeDecay(modifiers) {
        if (!modifiers) return null;
        const match = modifiers.match(/::TimeDecay(\d+)?(?:\|(\d+\.?\d*))?(?:\|([\w,]+))?/);
        if (!match) return null;

        return {
            halfLife: match[1] ? parseInt(match[1]) : null,
            minScore: match[2] ? parseFloat(match[2]) : null,
            targetTags: match[3] ? match[3].split(',') : []
        };
    }

    /**
     * 应用时间衰减重排
     */
    static applyTimeDecay(results, params, dayjs, globalConfig = {}) {
        const { halfLife: localHalfLife, minScore: localMinScore, targetTags } = params;
        const halfLife = localHalfLife ?? globalConfig.halfLifeDays ?? 30;
        const minScore = localMinScore ?? globalConfig.minScore ?? 0.5;

        const now = dayjs();

        let processed = results.map(result => {
            // 标签过滤
            if (targetTags.length > 0) {
                const isTarget = targetTags.some(tag => {
                    if (result.matchedTags && result.matchedTags.includes(tag)) return true;
                    const text = result.text;
                    const tagPattern = new RegExp(`(?:#|【|Tag:.*\\b|\\b)${tag}(?:\\b|】|,)`, 'i');
                    return tagPattern.test(text);
                });
                if (!isTarget) return result;
            }

            // 日期提取
            let dateStr = null;
            const textDateMatch = result.text.match(/\[(\d{4}-\d{2}-\d{2})\]/);
            if (textDateMatch) {
                dateStr = textDateMatch[1];
            } else {
                const pathSource = result.sourceFile || result.fullPath || '';
                const pathDateMatch = pathSource.match(/(\d{4}[-.]\d{2}[-.]\d{2})/);
                if (pathDateMatch) {
                    dateStr = pathDateMatch[1].replace(/\./g, '-');
                }
            }

            if (!dateStr) return result;

            const entryDate = dayjs(dateStr);
            if (!entryDate.isValid()) return result;

            const diffDays = Math.max(0, now.diff(entryDate, 'day'));
            const decayFactor = Math.pow(0.5, diffDays / halfLife);
            const originalScore = result.rerank_score ?? result.score ?? 0;
            const newScore = originalScore * decayFactor;

            return {
                ...result,
                score: newScore,
                original_score: originalScore,
                decay_factor: decayFactor,
                diff_days: diffDays
            };
        });

        // 重新排序
        processed.sort((a, b) => (b.score || 0) - (a.score || 0));

        // 分数过滤
        if (minScore > 0) {
            processed = processed.filter(r => (r.score || 0) >= minScore);
        }

        return processed;
    }
}

module.exports = TimeDecayProcessor;

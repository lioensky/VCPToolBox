class BM25QueryOptimizer {
    constructor(options = {}) {
        this.logger = options.logger || console;
    }

    createQueryText(input = {}) {
        const {
            userText = '',
            aiText = '',
            baseWeights = [0.7, 0.3],
            tokenize,
            normalize,
            options = {}
        } = input;

        const normalizeText = typeof normalize === 'function'
            ? normalize
            : (text) => String(text || '').trim();
        const tokenizeText = typeof tokenize === 'function'
            ? tokenize
            : this.tokenizeFallback.bind(this);

        const config = this.normalizeOptions(options);
        const normalizedUserText = normalizeText(userText);
        const normalizedAiText = normalizeText(aiText);

        if (!normalizedUserText && !normalizedAiText) {
            return {
                queryText: '',
                queryTokens: [],
                selectedTerms: [],
                userRatio: 0,
                aiRatio: 0,
                aiTopicGate: 0,
                topicOverlap: 0
            };
        }

        const userTokens = tokenizeText(normalizedUserText);
        const aiTokens = tokenizeText(normalizedAiText);
        const userTermFreq = this.buildTermFrequency(userTokens);
        const aiTermFreq = this.buildTermFrequency(aiTokens);
        const topicOverlap = this.calculateTopicOverlap(userTermFreq, aiTermFreq);

        const userWeight = Number.isFinite(Number(baseWeights[0])) ? Math.max(0, Number(baseWeights[0])) : 0.7;
        const aiWeight = Number.isFinite(Number(baseWeights[1])) ? Math.max(0, Number(baseWeights[1])) : 0.3;
        const aiTopicGate = this.calculateAiTopicGate({
            userTermFreq,
            aiTermFreq,
            topicOverlap,
            config
        });

        const userSignal = userTokens.length > 0 ? userWeight * Math.sqrt(Math.max(1, userTokens.length)) : 0;
        const aiSignal = aiTokens.length > 0 ? aiWeight * aiTopicGate * Math.sqrt(Math.max(1, aiTokens.length)) : 0;
        const signalSum = userSignal + aiSignal;
        let userRatio = signalSum > 0 ? userSignal / signalSum : 0.7;

        if (userTokens.length > 0 && aiTokens.length > 0) {
            userRatio = this.clamp(userRatio, config.minUserRatio, config.maxUserRatio);
        } else if (userTokens.length > 0) {
            userRatio = 1;
        } else {
            userRatio = 0;
        }
        const aiRatio = 1 - userRatio;

        const combinedFrequency = this.mergeFrequency(userTermFreq, aiTermFreq);
        const highFrequencyTerms = this.getLocalHighFrequencyTerms(combinedFrequency, config);
        const termScores = new Map();

        this.accumulateTermScores(termScores, userTermFreq, {
            source: 'user',
            sourceRatio: userRatio,
            highFrequencyTerms,
            config
        });
        this.accumulateTermScores(termScores, aiTermFreq, {
            source: 'ai',
            sourceRatio: aiRatio * aiTopicGate,
            highFrequencyTerms,
            config
        });

        const selectedTerms = [...termScores.entries()]
            .map(([term, data]) => ({
                term,
                score: data.score,
                userFrequency: userTermFreq.get(term) || 0,
                aiFrequency: aiTermFreq.get(term) || 0,
                repeat: this.calculateRepeat(data.score, term, config),
                isEntity: this.isEntityTerm(term),
                isHighFrequency: highFrequencyTerms.has(term)
            }))
            .filter(item => item.repeat > 0 && item.score >= config.minTermScore)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if (Number(b.isEntity) !== Number(a.isEntity)) return Number(b.isEntity) - Number(a.isEntity);
                return a.term.localeCompare(b.term);
            })
            .slice(0, config.maxTerms);

        const queryTokens = [];
        for (const item of selectedTerms) {
            for (let index = 0; index < item.repeat && queryTokens.length < config.queryTokenLimit; index++) {
                queryTokens.push(item.term);
            }
            if (queryTokens.length >= config.queryTokenLimit) break;
        }

        const queryText = queryTokens.join(' ');
        return {
            queryText,
            queryTokens,
            selectedTerms,
            userRatio,
            aiRatio,
            aiTopicGate,
            topicOverlap,
            highFrequencyTerms: [...highFrequencyTerms]
        };
    }

    normalizeOptions(options = {}) {
        const numberOrDefault = (key, defaultValue) => {
            const value = Number(options[key]);
            return Number.isFinite(value) ? value : defaultValue;
        };

        return {
            queryTokenLimit: Math.max(10, Math.round(numberOrDefault('queryTokenLimit', 120))),
            maxTerms: Math.max(5, Math.round(numberOrDefault('maxTerms', 48))),
            maxTermRepeat: Math.max(1, Math.round(numberOrDefault('maxTermRepeat', 4))),
            minTermScore: Math.max(0, numberOrDefault('minTermScore', 0.05)),
            minUserRatio: this.clamp(numberOrDefault('minUserRatio', 0.45), 0, 1),
            maxUserRatio: this.clamp(numberOrDefault('maxUserRatio', 0.9), 0, 1),
            aiTopicOverlapThreshold: this.clamp(numberOrDefault('aiTopicOverlapThreshold', 0.08), 0, 1),
            aiOffTopicWeight: this.clamp(numberOrDefault('aiOffTopicWeight', 0.08), 0, 1),
            highFrequencyTopCount: Math.max(0, Math.round(numberOrDefault('highFrequencyTopCount', 18))),
            highFrequencyMinCount: Math.max(2, Math.round(numberOrDefault('highFrequencyMinCount', 4))),
            highFrequencyPenalty: this.clamp(numberOrDefault('highFrequencyPenalty', 0.35), 0, 1),
            entityBoost: Math.max(1, numberOrDefault('entityBoost', 2.8)),
            identifierBoost: Math.max(1, numberOrDefault('identifierBoost', 2.2)),
            cjkLongTermBoost: Math.max(1, numberOrDefault('cjkLongTermBoost', 1.25)),
            singleCharPenalty: this.clamp(numberOrDefault('singleCharPenalty', 0.25), 0, 1),
            numberPenalty: this.clamp(numberOrDefault('numberPenalty', 0.35), 0, 1)
        };
    }

    buildTermFrequency(tokens = []) {
        const map = new Map();
        for (const token of tokens) {
            const term = String(token || '').toLowerCase().trim();
            if (!term) continue;
            map.set(term, (map.get(term) || 0) + 1);
        }
        return map;
    }

    mergeFrequency(...maps) {
        const merged = new Map();
        for (const map of maps) {
            for (const [term, count] of map.entries()) {
                merged.set(term, (merged.get(term) || 0) + count);
            }
        }
        return merged;
    }

    calculateTopicOverlap(userTermFreq, aiTermFreq) {
        if (!userTermFreq.size || !aiTermFreq.size) return 0;

        const userImportant = this.getImportantTermSet(userTermFreq);
        const aiImportant = this.getImportantTermSet(aiTermFreq);
        if (!userImportant.size || !aiImportant.size) return 0;

        let intersection = 0;
        for (const term of userImportant) {
            if (aiImportant.has(term)) intersection++;
        }

        const union = new Set([...userImportant, ...aiImportant]).size;
        return union > 0 ? intersection / union : 0;
    }

    getImportantTermSet(termFreq) {
        return new Set(
            [...termFreq.keys()]
                .filter(term => this.isEntityTerm(term) || String(term).length >= 2)
                .filter(term => !this.isWeakTerm(term))
        );
    }

    calculateAiTopicGate({ userTermFreq, aiTermFreq, topicOverlap, config }) {
        if (!aiTermFreq.size) return 0;
        if (!userTermFreq.size) return 1;

        const userStrongEntities = [...userTermFreq.keys()].filter(term => this.isEntityTerm(term));
        if (userStrongEntities.length > 0) {
            const sharedStrongEntity = userStrongEntities.some(term => aiTermFreq.has(term));
            if (!sharedStrongEntity && topicOverlap < config.aiTopicOverlapThreshold) {
                return config.aiOffTopicWeight;
            }
        }

        return topicOverlap < config.aiTopicOverlapThreshold
            ? config.aiOffTopicWeight
            : 1;
    }

    getLocalHighFrequencyTerms(combinedFrequency, config) {
        if (!combinedFrequency.size || config.highFrequencyTopCount <= 0) return new Set();

        return new Set(
            [...combinedFrequency.entries()]
                .filter(([term, count]) => count >= config.highFrequencyMinCount && !this.isEntityTerm(term))
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, config.highFrequencyTopCount)
                .map(([term]) => term)
        );
    }

    accumulateTermScores(termScores, termFreq, context) {
        const { source, sourceRatio, highFrequencyTerms, config } = context;
        if (sourceRatio <= 0) return;

        for (const [term, frequency] of termFreq.entries()) {
            const quality = this.getTermQuality(term, config);
            if (quality <= 0) continue;

            const frequencySignal = Math.sqrt(Math.max(1, frequency));
            const highFrequencyPenalty = highFrequencyTerms.has(term) ? config.highFrequencyPenalty : 1;
            const sourceBoost = source === 'user' ? 1.15 : 1.0;
            const score = sourceRatio * sourceBoost * frequencySignal * quality * highFrequencyPenalty;

            const existing = termScores.get(term) || { score: 0 };
            existing.score += score;
            termScores.set(term, existing);
        }
    }

    getTermQuality(term, config) {
        const value = String(term || '').toLowerCase().trim();
        if (!value) return 0;

        if (this.isEntityTerm(value)) return config.entityBoost;
        if (this.isIdentifierTerm(value)) return config.identifierBoost;
        if (/^\d+(?:\.\d+)*$/.test(value)) return config.numberPenalty;
        if (/^[\u4e00-\u9fff]$/.test(value)) return config.singleCharPenalty;
        if (/^[\u4e00-\u9fff]{3,}$/.test(value)) return config.cjkLongTermBoost;
        if (value.length <= 1) return config.singleCharPenalty;

        return 1;
    }

    calculateRepeat(score, term, config) {
        const entityBonus = this.isEntityTerm(term) ? 1 : 0;
        const repeat = Math.round(score) + entityBonus;
        return Math.max(0, Math.min(config.maxTermRepeat, repeat));
    }

    isWeakTerm(term) {
        const value = String(term || '').toLowerCase().trim();
        if (!value) return true;
        if (/^[\u4e00-\u9fff]$/.test(value)) return true;
        if (/^\d+$/.test(value)) return true;
        return false;
    }

    isIdentifierTerm(term) {
        const value = String(term || '').toLowerCase().trim();
        return /[a-z_][a-z0-9_.:/@#-]{1,}/i.test(value);
    }

    isEntityTerm(term) {
        const value = String(term || '').toLowerCase().trim();
        if (!value) return false;
        if (/[a-z]+[\w.-]*\d/i.test(value)) return true;
        if (/\d+[a-z][\w.-]*/i.test(value)) return true;
        if (/^[a-z][a-z0-9_.:/@#-]{2,}$/i.test(value)) return true;
        if (/^[\u4e00-\u9fff]{2,}(?:ai|llm|rag|api)$/i.test(value)) return true;
        return false;
    }

    tokenizeFallback(text) {
        return String(text || '')
            .toLowerCase()
            .match(/[\u4e00-\u9fff]{2,}|[a-z_][a-z0-9_.:/@#-]{1,}|\d+(?:\.\d+)*/gi) || [];
    }

    clamp(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }
}

module.exports = BM25QueryOptimizer;
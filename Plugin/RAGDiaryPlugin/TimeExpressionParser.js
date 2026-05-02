const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const TIME_EXPRESSIONS = require('./timeExpressions.config.js');

class TimeExpressionParser {
    constructor(locale = 'zh-CN', defaultTimezone = 'Asia/Shanghai') {
        this.defaultTimezone = defaultTimezone;
        this.setLocale(locale);
    }

    setLocale(locale) {
        this.locale = locale;
        this.expressions = TIME_EXPRESSIONS[locale] || TIME_EXPRESSIONS['zh-CN'];
    }

    _getDayBoundaries(date) {
        const start = dayjs(date).tz(this.defaultTimezone).startOf('day');
        const end = dayjs(date).tz(this.defaultTimezone).endOf('day');
        return { start: start.toDate(), end: end.toDate() };
    }

    parse(text) {
        console.log(`[TimeParser] Parsing text for all time expressions: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const now = dayjs().tz(this.defaultTimezone);
        let remainingText = text;
        const results = [];

        // Parse dynamic patterns first so combinations like "上周三" are not
        // consumed early by the broader hardcoded token "上周".
        for (const pattern of this.expressions.patterns) {
            const globalRegex = new RegExp(pattern.regex.source, 'g');
            let match;
            while ((match = globalRegex.exec(remainingText)) !== null) {
                console.log(`[TimeParser] Matched pattern: "${pattern.regex}" with text "${match[0]}"`);
                const result = this._handleDynamicPattern(match, pattern.type, now);
                if (result) {
                    results.push(result);
                    remainingText = remainingText.replace(match[0], '');
                }
            }
        }

        const sortedHardcodedKeys = Object.keys(this.expressions.hardcoded).sort((a, b) => b.length - a.length);
        for (const expr of sortedHardcodedKeys) {
            if (remainingText.includes(expr)) {
                const config = this.expressions.hardcoded[expr];
                console.log(`[TimeParser] Matched hardcoded expression: "${expr}"`);
                let result = null;
                if (config.days !== undefined) {
                    const targetDate = now.subtract(config.days, 'day');
                    result = this._getDayBoundaries(targetDate);
                } else if (config.type) {
                    result = this._getSpecialRange(now, config.type);
                }
                if (result) {
                    results.push(result);
                    remainingText = remainingText.replace(expr, '');
                }
            }
        }

        if (results.length > 0) {
            const uniqueRanges = new Map();
            results.forEach(r => {
                const key = `${r.start.getTime()}|${r.end.getTime()}`;
                if (!uniqueRanges.has(key)) {
                    uniqueRanges.set(key, r);
                }
            });
            const finalResults = Array.from(uniqueRanges.values());

            if (finalResults.length < results.length) {
                console.log(`[TimeParser] Deduplicated time ranges: ${results.length} -> ${finalResults.length}`);
            }

            console.log(`[TimeParser] Found ${finalResults.length} unique time expressions.`);
            finalResults.forEach((r, i) => {
                console.log(`  [${i + 1}] Range: ${r.start.toISOString()} to ${r.end.toISOString()}`);
            });
            return finalResults;
        }

        console.log('[TimeParser] No time expression found in text');
        return [];
    }

    _getSpecialRange(now, type) {
        let start = now.clone().startOf('day');
        let end = now.clone().endOf('day');

        switch (type) {
            case 'thisWeek':
                start = now.clone().startOf('week');
                end = now.clone().endOf('week');
                break;
            case 'lastWeek':
                start = now.clone().subtract(1, 'week').startOf('week');
                end = now.clone().subtract(1, 'week').endOf('week');
                break;
            case 'thisMonth':
                start = now.clone().startOf('month');
                end = now.clone().endOf('month');
                break;
            case 'lastMonth':
                start = now.clone().subtract(1, 'month').startOf('month');
                end = now.clone().subtract(1, 'month').endOf('month');
                break;
            case 'thisMonthStart':
                start = now.clone().startOf('month');
                end = now.clone().date(10).endOf('day');
                break;
            case 'lastMonthStart':
                start = now.clone().subtract(1, 'month').startOf('month');
                end = start.clone().date(10).endOf('day');
                break;
            case 'lastMonthMid':
                start = now.clone().subtract(1, 'month').startOf('month').date(11).startOf('day');
                end = now.clone().subtract(1, 'month').startOf('month').date(20).endOf('day');
                break;
            case 'lastMonthEnd':
                start = now.clone().subtract(1, 'month').startOf('month').date(21).startOf('day');
                end = now.clone().subtract(1, 'month').endOf('month');
                break;
        }
        return { start: start.toDate(), end: end.toDate() };
    }

    _handleDynamicPattern(match, type, now) {
        const numStr = match[1];
        const num = this.chineseToNumber(numStr);

        switch (type) {
            case 'daysAgo': {
                const targetDate = now.clone().subtract(num, 'day');
                return this._getDayBoundaries(targetDate.toDate());
            }

            case 'weeksAgo': {
                const weekStart = now.clone().subtract(num, 'week').startOf('week');
                const weekEnd = now.clone().subtract(num, 'week').endOf('week');
                return { start: weekStart.toDate(), end: weekEnd.toDate() };
            }

            case 'monthsAgo': {
                const monthStart = now.clone().subtract(num, 'month').startOf('month');
                const monthEnd = now.clone().subtract(num, 'month').endOf('month');
                return { start: monthStart.toDate(), end: monthEnd.toDate() };
            }

            case 'lastWeekday': {
                const weekdayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
                const targetWeekday = weekdayMap[match[1]];
                if (targetWeekday === undefined) return null;

                let lastWeekDate = now.clone().day(targetWeekday);
                if (lastWeekDate.isSame(now, 'day') || lastWeekDate.isAfter(now)) {
                    lastWeekDate = lastWeekDate.subtract(1, 'week');
                }

                return this._getDayBoundaries(lastWeekDate.toDate());
            }
        }

        return null;
    }

    chineseToNumber(chinese) {
        const numMap = {
            '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9,
            '日': 7, '天': 7
        };

        if (numMap[chinese] !== undefined) {
            return numMap[chinese];
        }

        if (chinese === '十') return 10;

        if (chinese.includes('十')) {
            const parts = chinese.split('十');
            const tensPart = parts[0];
            const onesPart = parts[1];

            let total = 0;

            if (tensPart === '') {
                total = 10;
            } else {
                total = (numMap[tensPart] || 1) * 10;
            }

            if (onesPart) {
                total += numMap[onesPart] || 0;
            }

            return total;
        }

        return parseInt(chinese, 10) || 0;
    }
}

module.exports = TimeExpressionParser;

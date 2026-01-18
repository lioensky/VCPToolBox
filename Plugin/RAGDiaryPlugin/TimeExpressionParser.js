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

    // 获取一天的开始和结束 (使用配置的时区)
    _getDayBoundaries(date) {
        const start = dayjs(date).tz(this.defaultTimezone).startOf('day');
        const end = dayjs(date).tz(this.defaultTimezone).endOf('day');
        return { start: start.toDate(), end: end.toDate() };
    }
    
    // 核心解析函数 - V2 (支持多表达式)
    parse(text) {
        console.log(`[TimeParser] Parsing text for all time expressions: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const now = dayjs().tz(this.defaultTimezone); // 获取当前配置时区的时间
        let remainingText = text;
        const results = [];

        // 1. 检查硬编码表达式 (从长到短排序)
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
                    remainingText = remainingText.replace(expr, ''); // 消费掉匹配的部分
                }
            }
        }

        // 2. 检查动态模式
        for (const pattern of this.expressions.patterns) {
            const globalRegex = new RegExp(pattern.regex.source, 'g');
            let match;
            while ((match = globalRegex.exec(remainingText)) !== null) {
                console.log(`[TimeParser] Matched pattern: "${pattern.regex}" with text "${match[0]}"`);
                const result = this._handleDynamicPattern(match, pattern.type, now);
                if (result) {
                    results.push(result);
                    // 简单替换，可能不完美但能处理多数情况
                    remainingText = remainingText.replace(match[0], '');
                }
            }
        }

        if (results.length > 0) {
            // --- V2.1: 去重 (使用时间戳以提高性能) ---
            const uniqueRanges = new Map();
            results.forEach(r => {
                const key = `${r.start.getTime()}|${r.end.getTime()}`;
                if (!uniqueRanges.has(key)) {
                    uniqueRanges.set(key, r);
                }
            });
            const finalResults = Array.from(uniqueRanges.values());

            if (finalResults.length < results.length) {
                console.log(`[TimeParser] 去重时间范围：${results.length} → ${finalResults.length}`);
            }
            
            console.log(`[TimeParser] Found ${finalResults.length} unique time expressions.`);
            finalResults.forEach((r, i) => {
                console.log(`  [${i+1}] Range: ${r.start.toISOString()} to ${r.end.toISOString()}`);
            });
            return finalResults;
        } else {
            console.log(`[TimeParser] No time expression found in text`);
            return []; // 始终返回数组
        }
    }

    _getSpecialRange(now, type) {
        let start = now.clone().startOf('day');
        let end = now.clone().endOf('day');

        switch (type) {
            case 'thisWeek':
                // dayjs 默认周日为 0，但我们希望周一为一周的开始 (locale: zh-cn)
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
            case 'thisMonthStart': // 本月初（1-10号）
                start = now.clone().startOf('month');
                end = now.clone().date(10).endOf('day');
                break;
            case 'lastMonthStart': // 上月初（1-10号）
                start = now.clone().subtract(1, 'month').startOf('month');
                end = start.clone().date(10).endOf('day');
                break;
            case 'lastMonthMid': // 上月中（11-20号）
                start = now.clone().subtract(1, 'month').startOf('month').date(11).startOf('day');
                end = now.clone().subtract(1, 'month').startOf('month').date(20).endOf('day');
                break;
            case 'lastMonthEnd': // 上月末（21号到月底）
                start = now.clone().subtract(1, 'month').startOf('month').date(21).startOf('day');
                end = now.clone().subtract(1, 'month').endOf('month');
                break;
        }
        return { start: start.toDate(), end: end.toDate() };
    }

    _handleDynamicPattern(match, type, now) {
        const numStr = match[1];
        const num = this.chineseToNumber(numStr);

        switch(type) {
            case 'daysAgo':
                const targetDate = now.clone().subtract(num, 'day');
                return this._getDayBoundaries(targetDate.toDate());
            
            case 'weeksAgo':
                const weekStart = now.clone().subtract(num, 'week').startOf('week');
                const weekEnd = now.clone().subtract(num, 'week').endOf('week');
                return { start: weekStart.toDate(), end: weekEnd.toDate() };
            
            case 'monthsAgo':
                const monthStart = now.clone().subtract(num, 'month').startOf('month');
                const monthEnd = now.clone().subtract(num, 'month').endOf('month');
                return { start: monthStart.toDate(), end: monthEnd.toDate() };
            
            case 'lastWeekday':
                const weekdayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
                const targetWeekday = weekdayMap[match[1]];
                if (targetWeekday === undefined) return null;

                // dayjs 的 weekday() 方法返回 0 (Sunday) 到 6 (Saturday)
                // 我们需要找到上一个匹配的星期几
                let lastWeekDate = now.clone().day(targetWeekday);
                
                // 如果计算出的日期是今天或未来，则减去一周
                if (lastWeekDate.isSame(now, 'day') || lastWeekDate.isAfter(now)) {
                    lastWeekDate = lastWeekDate.subtract(1, 'week');
                }
                
                return this._getDayBoundaries(lastWeekDate.toDate());
        }
        
        return null;
    }

    chineseToNumber(chinese) {
        const numMap = {
            '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9,
            '日': 7, '天': 7 // 特殊映射
        };

        if (numMap[chinese] !== undefined) {
            return numMap[chinese];
        }

        if (chinese === '十') return 10;

        // 处理 "十一" 到 "九十九"
        if (chinese.includes('十')) {
            const parts = chinese.split('十');
            const tensPart = parts[0];
            const onesPart = parts[1];

            let total = 0;

            if (tensPart === '') { // "十"开头, e.g., "十三"
                total = 10;
            } else { // "二"开头, e.g., "二十三"
                total = (numMap[tensPart] || 1) * 10;
            }

            if (onesPart) { // e.g., "二十三" 的 "三"
                total += numMap[onesPart] || 0;
            }
            
            return total;
        }

        return parseInt(chinese, 10) || 0;
    }
}

module.exports = TimeExpressionParser;
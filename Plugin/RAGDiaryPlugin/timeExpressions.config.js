// Plugin/RAGDiaryPlugin/timeExpressions.config.js
// 时间表达式配置文件

const TIME_EXPRESSIONS = {
    'zh-CN': {
        hardcoded: {
            // 基础时间词
            '今天': { days: 0 },
            '昨天': { days: 1 },
            '前天': { days: 2 },
            '大前天': { days: 3 },
            
            // 模糊时间词
            '之前': { days: 3 }, // “之前”通常指代不久前，暂定3天
            '最近': { days: 5 },
            '前几天': { days: 5 },
            '前一阵子': { days: 15 },
            '近期': { days: 7 },
            
            // 周/月相关
            '上周': { type: 'lastWeek' },
            '上个月': { type: 'lastMonth' },
            '本周': { type: 'thisWeek' },
            '这周': { type: 'thisWeek' },
            '本月': { type: 'thisMonth' },
            '这个月': { type: 'thisMonth' },
            '月初': { type: 'thisMonthStart' }, // 例如本月初
            '上个月初': { type: 'lastMonthStart' },
            '上个月中': { type: 'lastMonthMid' },
            '上个月末': { type: 'lastMonthEnd' },

            // 🌟 寒暄语触发 (用于唤起最近记忆)
            '在吗': { days: 1 },
            '在不': { days: 1 },
            '在不在': { days: 1 },
            '你好': { days: 1 },
            '哈喽': { days: 1 },
            '早上好': { days: 0 }
        },
        patterns: [
            {
                // 匹配 "3天前" 或 "三天前"
                regex: /(\d+|[一二三四五六七八九十])天前/,
                type: 'daysAgo'
            },
            {
                // 匹配 "上周一" ... "上周日", "上周天"
                regex: /上周([一二三四五六日天])/,
                type: 'lastWeekday'
            },
            {
                // 匹配 "x周前"
                regex: /(\d+|[一二三四五六七八九十])周前/,
                type: 'weeksAgo'
            },
            {
                // 匹配 "x个月前"
                regex: /(\d+|[一二三四五六七八九十])个月前/,
                type: 'monthsAgo'
            }
            // 更多模式可以加在这里
        ]
    },
    'en-US': {
        hardcoded: {
            'today': { days: 0 },
            'yesterday': { days: 1 },
            'recently': { days: 5 },
            'lately': { days: 7 },
            'a while ago': { days: 15 },
            'last week': { type: 'lastWeek' },
            'last month': { type: 'lastMonth' },
            'this week': { type: 'thisWeek' },
            'this month': { type: 'thisMonth' },
        },
        patterns: [
            {
                regex: /(\d+) days? ago/i,
                type: 'daysAgo'
            },
            {
                regex: /last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
                type: 'lastWeekday'
            },
            {
                regex: /(\d+) weeks? ago/i,
                type: 'weeksAgo'
            },
            {
                regex: /(\d+) months? ago/i,
                type: 'monthsAgo'
            }
            // More patterns can be added here
        ]
    }
};

module.exports = TIME_EXPRESSIONS;
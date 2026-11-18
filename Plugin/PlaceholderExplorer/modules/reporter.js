'use strict';

const { buildDynamicFoldObject } = require('../../../modules/foldProtocol');

function formatSummary(index) {
    const stats = index.stats;
    const editable = index.entries.filter(item => item.editable).length;
    const nested = index.entries.filter(item => item.nesting.length > 0).length;
    const lines = [
        '# PlaceholderExplorer 占位符索引',
        '',
        `扫描时间：${index.generatedAt}`,
        `占位符：${stats.placeholders}；定义：${stats.definitions}；引用：${stats.references}`,
        `可编辑：${editable}；含嵌套引用链：${nested}`,
        `死链：${stats.deadLinks}；孤儿：${stats.orphans}；扫描错误：${stats.scanErrors}`,
        '',
        '使用 PlaceholderExplorerCommand 的 Scan / Locate / Edit / Preview / CheckDeadLinks 命令查询和维护。',
        'config.env 中 Tar/Var 的修改保存后需要重启 VCP 服务生效。'
    ];
    return lines.join('\n');
}

function buildSummaryFold(index) {
    const base = formatSummary(index);
    const problems = [
        '## 检查摘要',
        '',
        `死链 (${index.checks.deadLinks.length})：`,
        ...index.checks.deadLinks.slice(0, 30).map(item => `- ${item.placeholder}`),
        '',
        `扫描错误 (${index.errors.length})：`,
        ...index.errors.slice(0, 30).map(item => `- ${item.file || 'unknown'}:${item.line || 0} ${item.message}`)
    ].join('\n');
    return buildDynamicFoldObject({
        content: [
            `[===vcp_fold: 0.0 ::desc: PlaceholderExplorer 基础索引统计与命令入口===]\n${base}`,
            `[===vcp_fold: 0.65 ::desc: 占位符死链、缺失文件与扫描错误详情===]\n${problems}`
        ].join('\n'),
        pluginDescription: 'VCP 占位符定义、引用、嵌套链及健康检查索引',
        strategy: 'toolbox_block_similarity'
    });
}

module.exports = { buildSummaryFold, formatSummary };

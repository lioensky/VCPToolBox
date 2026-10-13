'use strict';
// 共享输出契约：标准 OpenAI content part 数组 + details 结构化数据。
// 规则：text 必须能独立被 AI 读懂；details 仅供程序使用，AI 不依赖它。

/** direct 插件的标准返回：{ content, details } */
function textResult(text, details = {}, extraParts = []) {
    return {
        content: [{ type: 'text', text: String(text ?? '') }, ...extraParts],
        details,
    };
}

/** 由多个 content part 组成的返回，首段通常为摘要 */
function partsResult(parts, details = {}) {
    return { content: parts, details };
}

/** 诊断列表渲染为 markdown。title 为空时不输出标题。 */
function formatDiagnostics(diagnostics = [], title = '代码审查') {
    if (!diagnostics.length) return '';
    const lines = diagnostics.map(d =>
        `- ${d.severity === 'error' ? '❌' : '⚠️'} L${d.line || '?'}:${d.column || '?'} ${d.ruleId ? `\`${d.ruleId}\` ` : ''}${d.message}`
    );
    return `${title ? `### ${title}\n` : ''}${lines.join('\n')}`;
}

/**
 * stdio 插件使用：内部 { success, data } → VCP 协议 { status, result }。
 * 与 FileOperator 历史行为保持兼容。
 */
function convertToVCPFormat(response) {
    if (!response || !response.success) {
        return { status: 'error', error: response?.error || 'Unknown error occurred' };
    }
    const data = response.data || {};

    if (data._specialAction) {
        return {
            status: 'success',
            _specialAction: data._specialAction,
            payload: data.payload,
            result: {
                content: [{ type: 'text', text: data.message || 'Operation completed successfully' }],
                details: data.payload,
            },
        };
    }

    const content = [];
    if (data.content) {
        if (Array.isArray(data.content)) content.push(...data.content);
        else content.push({ type: 'text', text: String(data.content) });
    }
    if (data.message && !content.some(p => p.type === 'text' && p.text.includes(data.message))) {
        content.unshift({ type: 'text', text: data.message });
    }
    if (content.length === 0) {
        if (data.items) {
            content.push({ type: 'text', text: `### 发现的项目 (${data.totalItems || data.items.length}):\n${data.items.map(i => `- ${i.name} (${i.type})`).join('\n')}` });
        } else if (data.results) {
            content.push({ type: 'text', text: `### 搜索结果 (${data.totalResults || data.results.length}):\n${data.results.map(r => `- ${r.relativePath}`).join('\n')}` });
        } else if (data.details) {
            content.push({ type: 'text', text: typeof data.details === 'string' ? data.details : JSON.stringify(data.details, null, 2) });
        }
    }
    if (Array.isArray(data.validation) && data.validation.length) {
        content.push({ type: 'text', text: formatDiagnostics(data.validation, '代码验证结果') });
    }
    if (content.length === 0) {
        const { content: _c, message, details: _d, validation: _v, items: _i, results: _r, ...rest } = data;
        const extra = Object.keys(rest).length
            ? '\n\n**详细信息:**\n' + Object.entries(rest).map(([k, v]) => `- **${k}**: ${v}`).join('\n')
            : '';
        content.push({ type: 'text', text: (message || '操作成功完成') + extra });
    }
    return { status: 'success', result: { content, details: data } };
}

module.exports = { textResult, partsResult, formatDiagnostics, convertToVCPFormat };
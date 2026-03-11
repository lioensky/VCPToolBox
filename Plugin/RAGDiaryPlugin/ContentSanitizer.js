// Plugin/RAGDiaryPlugin/ContentSanitizer.js

const cheerio = require('cheerio');

/**
 * 文本净化工具类
 */
class ContentSanitizer {
    /**
     * 移除 HTML 标签
     */
    static stripHtml(html) {
        if (!html) return '';
        if (typeof html !== 'string') {
            return String(html);
        }
        try {
            const $ = cheerio.load(html);
            $('style, script').remove();
            const plainText = $.text();
            return plainText
                .replace(/^[ \t]+/gm, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        } catch (e) {
            console.error('[ContentSanitizer] stripHtml error:', e);
            return html;
        }
    }

    /**
     * 移除 Emoji
     */
    static stripEmoji(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }
        return text.replace(/[\u{1F600}-\u{1F64F}]/gu, '')
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(/[\u{2600}-\u{26FF}]/gu, '')
            .replace(/[\u{2700}-\u{27BF}]/gu, '')
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
            .replace(/[\u{200D}]/gu, '')
            .trim();
    }

    /**
     * 净化工具调用标记
     */
    static stripToolMarkers(text) {
        if (!text || typeof text !== 'string') return text;

        let processed = text.replace(/<<<\[?TOOL_REQUEST\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST\]?>>>/gi, (match, block) => {
            const blacklistedKeys = ['tool_name', 'command', 'archery', 'maid'];
            const blacklistedValues = ['dailynote', 'update', 'create', 'no_reply'];

            const results = [];
            const regex = /(\w+):\s*[「『]始[」』]([\s\S]*?)[「『]末[」』]/g;
            let m;
            while ((m = regex.exec(block)) !== null) {
                const key = m[1].toLowerCase();
                const val = m[2].trim();
                const valLower = val.toLowerCase();

                const isTechKey = blacklistedKeys.includes(key);
                const isTechVal = blacklistedValues.some(bv => valLower.includes(bv));

                if (!isTechKey && !isTechVal && val.length > 1) {
                    results.push(val);
                }
            }

            if (results.length === 0) {
                return block.split('\n')
                    .map(line => {
                        const cleanLine = line.replace(/\w+:\s*[「『]始[」』]/g, '').replace(/[「『]末[」』]/g, '').trim();
                        const lower = cleanLine.toLowerCase();
                        if (blacklistedValues.some(bv => lower.includes(bv))) return '';
                        return cleanLine;
                    })
                    .filter(l => l.length > 0)
                    .join('\n');
            }

            return results.join('\n');
        });

        return processed
            .replace(/<<<\[?TOOL_REQUEST\]?>>>/gi, '')
            .replace(/<<<\[?END_TOOL_REQUEST\]?>>>/gi, '')
            .replace(/[「」『』]始[「」『』]/g, '')
            .replace(/[「」『』]末[「」『』]/g, '')
            .replace(/[「」『』]/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /**
     * 移除系统通知
     */
    static stripSystemNotification(text) {
        if (!text || typeof text !== 'string') return text;
        return text.replace(/\[系统通知\][\s\S]*?\[系统通知结束\]/g, '').trim();
    }

    /**
     * 检测是否为 Base64
     */
    static isLikelyBase64(str) {
        if (!str || str.length < 100) return false;
        const sample = str.substring(0, 200);
        if (!/^[A-Za-z0-9+/=]+$/.test(sample)) return false;
        if (str.length % 4 !== 0 && str.length % 4 !== 2 && str.length % 4 !== 3) return false;
        const uniqueChars = new Set(sample).size;
        if (uniqueChars > 50) return true;
        return str.length > 500;
    }

    /**
     * JSON 转 Markdown
     */
    static jsonToMarkdown(obj, depth = 0) {
        if (obj === null || obj === undefined) return '';
        if (typeof obj !== 'object') return String(obj);

        let md = '';
        const indent = '  '.repeat(depth);

        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (item && typeof item === 'object' && item.type === 'text' && item.text) {
                    let textContent = item.text;
                    const jsonMatch = textContent.match(/:\s*\n(\{[\s\S]*?\}|\[[\s\S]*?\])\s*$/);
                    if (jsonMatch) {
                        try {
                            const nestedJson = JSON.parse(jsonMatch[1]);
                            const prefix = textContent.substring(0, jsonMatch.index + 1).trim();
                            const nestedMd = this.jsonToMarkdown(nestedJson, depth + 1);
                            md += `${prefix}\n${nestedMd}\n`;
                            continue;
                        } catch (e) { }
                    }
                    const inlineJsonMatch = textContent.match(/(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\])/);
                    if (inlineJsonMatch && inlineJsonMatch[0].length > 50) {
                        try {
                            const inlineJson = JSON.parse(inlineJsonMatch[0]);
                            const beforeJson = textContent.substring(0, inlineJsonMatch.index).trim();
                            const afterJson = textContent.substring(inlineJsonMatch.index + inlineJsonMatch[0].length).trim();
                            const inlineMd = this.jsonToMarkdown(inlineJson, depth + 1);
                            md += `${beforeJson}\n${inlineMd}`;
                            if (afterJson) md += `\n${afterJson}`;
                            md += '\n';
                            continue;
                        } catch (e) { }
                    }
                    md += `${textContent}\n`;
                } else if (typeof item !== 'object') {
                    md += `${indent}- ${item}\n`;
                } else {
                    md += `${this.jsonToMarkdown(item, depth)}\n`;
                }
            }
        } else {
            for (const [key, value] of Object.entries(obj)) {
                if (value === null || value === undefined) continue;
                if (typeof value === 'object') {
                    const subContent = this.jsonToMarkdown(value, depth + 1);
                    if (subContent.trim()) {
                        md += `${indent}# ${key}:\n${subContent}`;
                    }
                } else {
                    const valStr = String(value);
                    if (valStr.length > 200 && (valStr.includes('base64') || this.isLikelyBase64(valStr))) {
                        md += `${indent}* **${key}**: [Data Omitted]\n`;
                        continue;
                    }
                    if (valStr.length > 100 && (valStr.includes('{') || valStr.includes('['))) {
                        const nestedJsonMatch = valStr.match(/^(.*?)(\{[\s\S]*\}|\[[\s\S]*\])(.*)$/);
                        if (nestedJsonMatch) {
                            try {
                                const nestedJson = JSON.parse(nestedJsonMatch[2]);
                                const prefix = nestedJsonMatch[1].trim();
                                const suffix = nestedJsonMatch[3].trim();
                                const nestedMd = this.jsonToMarkdown(nestedJson, depth + 1);
                                md += `${indent}* **${key}**: `;
                                if (prefix) md += `${prefix} `;
                                md += `\n${nestedMd}`;
                                if (suffix) md += `${indent}  ${suffix}\n`;
                                continue;
                            } catch (e) { }
                        }
                    }
                    md += `${indent}* **${key}**: ${valStr}\n`;
                }
            }
        }
        return md;
    }
}

module.exports = ContentSanitizer;

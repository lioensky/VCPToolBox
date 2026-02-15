/**
 * 章节感知切分器 (T3)
 * 
 * 按 Markdown 章节标题（##）切分，超长章节在段落边界二次切分。
 * 每个 chunk 注入 Meta-Header（章节名 + 全局摘要占位 + overlap）。
 * 使用 tiktoken cl100k_base 计算 token 数。
 */

const { get_encoding } = require('@dqbd/tiktoken');

const encoding = get_encoding('cl100k_base');

const DEFAULT_TARGET_TOKENS = 2000;
const DEFAULT_OVERLAP_RATIO = 0.15;
const DEFAULT_MAX_CHUNKS = 120;

/**
 * 计算文本的 token 数
 */
function countTokens(text) {
  if (!text) return 0;
  return encoding.encode(text).length;
}

/**
 * 从 Markdown 中提取章节结构
 * @returns {Array<{ level: number, title: string, content: string }>}
 */
function extractSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let currentSection = { level: 0, title: '(Preamble)', lines: [] };

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch) {
      // Save previous section
      if (currentSection.lines.length > 0 || currentSection.title !== '(Preamble)') {
        sections.push({
          level: currentSection.level,
          title: currentSection.title,
          content: currentSection.lines.join('\n')
        });
      }
      currentSection = {
        level: headerMatch[1].length,
        title: headerMatch[2].trim(),
        lines: [line]
      };
    } else {
      currentSection.lines.push(line);
    }
  }

  // Push last section
  if (currentSection.lines.length > 0) {
    sections.push({
      level: currentSection.level,
      title: currentSection.title,
      content: currentSection.lines.join('\n')
    });
  }

  return sections;
}

/**
 * 在段落边界切分超长文本
 * @returns {string[]}
 */
function splitAtParagraphs(text, targetTokens) {
  const paragraphs = text.split(/\n\n+/);
  const pieces = [];
  let current = '';
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = countTokens(para);

    if (currentTokens + paraTokens > targetTokens && current.trim()) {
      pieces.push(current.trim());
      current = '';
      currentTokens = 0;
    }

    // Handle single paragraph exceeding limit
    if (paraTokens > targetTokens && !current.trim()) {
      const sentences = para.split(/(?<=[。？！.!?\n])/g);
      for (const sent of sentences) {
        const sentTokens = countTokens(sent);
        if (currentTokens + sentTokens > targetTokens && current.trim()) {
          pieces.push(current.trim());
          current = '';
          currentTokens = 0;
        }
        current += sent;
        currentTokens += sentTokens;
      }
      continue;
    }

    current += (current ? '\n\n' : '') + para;
    currentTokens += paraTokens;
  }

  if (current.trim()) {
    pieces.push(current.trim());
  }

  return pieces;
}

/**
 * 生成 Meta-Header
 */
function makeMetaHeader(section, globalSummary, overlapText) {
  const parts = [`[章节: ${section}]`];
  if (globalSummary) {
    parts.push(`[全局摘要: ${globalSummary}]`);
  }
  if (overlapText) {
    parts.push(`[上文衔接: ...${overlapText.slice(-200)}]`);
  }
  return parts.join('\n');
}

/**
 * 章节感知切分
 * 
 * @param {string} markdown - L0 输出的 Markdown
 * @param {object} options - { targetTokens, overlapRatio, maxChunks, globalSummary }
 * @returns {Array<{ index, section, tokenCount, text, metaHeader }>}
 */
function chunkMarkdown(markdown, options = {}) {
  const targetTokens = options.targetTokens || DEFAULT_TARGET_TOKENS;
  const overlapRatio = options.overlapRatio || DEFAULT_OVERLAP_RATIO;
  const maxChunks = options.maxChunks || DEFAULT_MAX_CHUNKS;
  const globalSummary = options.globalSummary || '';

  if (!markdown || !markdown.trim()) return [];

  const sections = extractSections(markdown);
  const chunks = [];
  let prevTail = '';

  for (const section of sections) {
    const sectionTokens = countTokens(section.content);

    if (sectionTokens <= targetTokens) {
      const metaHeader = makeMetaHeader(section.title, globalSummary, prevTail);
      const text = section.content;
      chunks.push({
        index: chunks.length,
        section: section.title,
        tokenCount: countTokens(metaHeader + '\n\n' + text),
        text,
        metaHeader
      });
      const tailLen = Math.floor(text.length * overlapRatio);
      prevTail = text.slice(-tailLen);
    } else {
      const pieces = splitAtParagraphs(section.content, targetTokens);
      for (const piece of pieces) {
        const metaHeader = makeMetaHeader(section.title, globalSummary, prevTail);
        chunks.push({
          index: chunks.length,
          section: section.title,
          tokenCount: countTokens(metaHeader + '\n\n' + piece),
          text: piece,
          metaHeader
        });
        const tailLen = Math.floor(piece.length * overlapRatio);
        prevTail = piece.slice(-tailLen);
      }
    }

    if (chunks.length >= maxChunks) break;
  }

  return chunks.slice(0, maxChunks);
}

module.exports = { chunkMarkdown, countTokens, extractSections };

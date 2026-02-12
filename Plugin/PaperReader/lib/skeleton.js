/**
 * Skeleton 骨架提取重构 (T5)
 * 
 * 从 Markdown 结构提取目录树、Abstract、Conclusion、Figure Caption，
 * 生成 Global Map。不再只读首尾2块。
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { extractSections } = require('./chunker');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');

/**
 * 从 Markdown 提取目录树（标题列表）
 */
function extractTOC(markdown) {
  const lines = markdown.split('\n');
  const toc = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      toc.push({
        level: match[1].length,
        title: match[2].trim(),
        indent: '  '.repeat(match[1].length - 1)
      });
    }
  }
  return toc;
}

/**
 * 提取关键章节全文
 */
function extractKeySections(sections) {
  const keyPatterns = [
    /abstract/i,
    /introduction/i,
    /conclusion/i,
    /discussion/i,
    /summary/i,
    /overview/i,
    /background/i,
    /preface/i,
    /executive.?summary/i,
    /摘要/,
    /引言/,
    /结论/,
    /讨论/,
    /概述/,
    /背景/,
    /前言/,
    /总结/
  ];

  const found = [];
  for (const section of sections) {
    for (const pattern of keyPatterns) {
      if (pattern.test(section.title)) {
        found.push(section);
        break;
      }
    }
  }
  return found;
}

/**
 * 从 figure_map.json 加载 Figure Captions
 */
async function loadFigureCaptions(wsDir) {
  const figMapPath = path.join(wsDir, 'figure_map.json');
  if (!fsSync.existsSync(figMapPath)) return [];
  const raw = await fs.readFile(figMapPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 从 Markdown 结构提取骨架并生成 Global Map
 * 
 * @param {string} paperId
 * @param {object} options - { focus }
 * @returns {Promise<{ globalMapPath: string, globalMapContent: string }>}
 */
async function generateSkeleton(paperId, options = {}) {
  const wsDir = path.join(WORKSPACE_ROOT, paperId);
  const mdPath = path.join(wsDir, 'full_text.md');
  const metaPath = path.join(wsDir, 'meta.json');

  if (!fsSync.existsSync(mdPath)) {
    throw new Error(`full_text.md not found: ${mdPath}`);
  }

  const markdown = await fs.readFile(mdPath, 'utf-8');
  const meta = fsSync.existsSync(metaPath)
    ? JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    : {};

  // 1. 提取目录树
  const toc = extractTOC(markdown);
  const tocText = toc.map(t => `${t.indent}- ${t.title}`).join('\n');

  // 2. 提取关键章节
  const sections = extractSections(markdown);
  const keySections = extractKeySections(sections);
  const keyText = keySections
    .map(s => `### ${s.title}\n${s.content.slice(0, 3000)}`)
    .join('\n\n');

  // 3. 加载 Figure Captions
  const figureCaptions = await loadFigureCaptions(wsDir);
  const captionText = figureCaptions.length > 0
    ? figureCaptions.map(f => `- ${f.label || f.id}: ${f.caption}`).join('\n')
    : '(无图注信息)';

  // 4. 构建 LLM prompt
  const system = [
    '你是一个"文档骨架提取器"，适用于各类长文档（学术论文、技术报告、书籍章节、法律文书等）。',
    '目标：基于目录结构、关键章节和图注，提取文档的全局地图（Global Map）。',
    '输出 Markdown，根据文档类型自适应包含以下要素：',
    '1. 核心主题（1-2句话概括本文档的核心内容）',
    '2. 核心问题/目的（本文档要解决什么问题或传达什么信息）',
    '3. 关键内容概要（主要论点、方法、流程、条款等——依文档类型而定）',
    '4. 结构路线图（文档的组织逻辑和各部分之间的关系）',
    '5. 主要结论/要点',
    '6. 局限性/注意事项/风险点',
    '7. 各章节阅读优先级标签（High/Medium/Low）',
    '8. 后续深读建议（重点关注哪些章节/图表/附录）',
    '引用原文短句时标注来自哪个章节。'
  ].join('\n');

  const user = [
    `阅读焦点：${options.focus || '通用理解（全面掌握文档核心内容与结构）'}`,
    `元信息：页数=${meta.pageCount ?? 'unknown'}`,
    `\n【目录结构】\n${tocText}`,
    `\n【关键章节内容】\n${keyText.slice(0, 15000)}`,
    `\n【图注列表】\n${captionText}`
  ].join('\n\n');

  const content = await callLLM([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);

  // 5. 写入 Global_Map.md
  const notesDir = path.join(wsDir, 'reading_notes');
  await fs.mkdir(notesDir, { recursive: true });
  const outPath = path.join(notesDir, 'Global_Map.md');
  await fs.writeFile(outPath, content || '', 'utf-8');

  return { globalMapPath: outPath, globalMapContent: content };
}

module.exports = { generateSkeleton, extractTOC, extractKeySections };

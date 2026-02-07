/**
 * pdf-parse 降级回退封装 (T2)
 * 
 * 当 MinerU API 不可用时，回退到本地 pdf-parse 纯文本抽取。
 * 输出格式与 mineru-client.js 对齐，但 figures 为空，markdown 为纯文本。
 */

const fs = require('fs').promises;
const pdfParse = require('pdf-parse');

/**
 * 使用 pdf-parse 做纯文本抽取（降级模式）
 * 
 * @param {string} pdfPath - PDF 绝对路径
 * @returns {Promise<{ markdown: string, figures: [], pageCount: number, figureMap: [], degraded: true }>}
 */
async function parsePdf(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  const parsed = await pdfParse(buffer);

  const rawText = parsed.text || '';
  const markdown = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    markdown,
    figures: [],
    pageCount: parsed.numpages || null,
    figureMap: [],
    degraded: true
  };
}

module.exports = { parsePdf };

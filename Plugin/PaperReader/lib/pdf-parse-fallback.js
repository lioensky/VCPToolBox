/**
 * pdf-parse 降级回退封装 (T2)
 *
 * 当 MinerU API 不可用时，回退到本地 pdf-parse 纯文本抽取。
 * 输出格式与 mineru-client.js 对齐，但 figures 为空，markdown 为纯文本。
 *
 * pdf-parse v2 API: new PDFParse({ data: Uint8Array }) → getText() → destroy()
 */

const fs = require('fs').promises;
const { PDFParse } = require('pdf-parse');

/**
 * 使用 pdf-parse 做纯文本抽取（降级模式）
 *
 * @param {string} pdfPath - PDF 绝对路径
 * @returns {Promise<{ markdown: string, figures: [], pageCount: number, figureMap: [], degraded: true }>}
 */
async function parsePdf(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  // pdf-parse v2 要求 Uint8Array 而非 Buffer
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const parser = new PDFParse({ data: uint8 });
  let pageCount = null;
  let rawText = '';

  try {
    const info = await parser.getInfo();
    pageCount = info.total || null;

    const textResult = await parser.getText();
    rawText = textResult.text || '';
  } finally {
    await parser.destroy();
  }

  const markdown = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    markdown,
    figures: [],
    pageCount,
    figureMap: [],
    degraded: true
  };
}

module.exports = { parsePdf };

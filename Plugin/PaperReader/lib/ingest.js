/**
 * 统一解析入口 (T1+T2)
 * 
 * 优先使用 MinerU 云端 API，失败则自动降级到 pdf-parse。
 */

const path = require('path');
const fs = require('fs').promises;
const mineruClient = require('./mineru-client');
const fallback = require('./pdf-parse-fallback');

/**
 * 统一解析入口：优先 MinerU，失败则降级
 * 
 * @param {string} pdfPath - PDF 绝对路径
 * @param {object} options - { outputDir, token, timeout, pollInterval }
 * @returns {Promise<{ markdown, figures, pageCount, figureMap, engine: 'mineru'|'pdf-parse' }>}
 */
async function ingestPdf(pdfPath, options = {}) {
  const outputDir = options.outputDir || path.dirname(pdfPath);
  const hasMineruToken = !!(options.token || process.env.MINERU_API_TOKEN);

  if (hasMineruToken) {
    try {
      const result = await mineruClient.parsePdf(pdfPath, { ...options, outputDir });
      return { ...result, engine: 'mineru' };
    } catch (err) {
      // Log degradation warning, then fall through to pdf-parse
      const errMsg = err instanceof mineruClient.MineruError
        ? `[MinerU ${err.code}] ${err.message}`
        : `[MinerU Error] ${err.message}`;
      process.stderr.write(`[PaperReader] MinerU failed, degrading to pdf-parse: ${errMsg}\n`);
    }
  }

  // Fallback to pdf-parse
  const result = await fallback.parsePdf(pdfPath);
  return { ...result, engine: 'pdf-parse' };
}

module.exports = { ingestPdf };

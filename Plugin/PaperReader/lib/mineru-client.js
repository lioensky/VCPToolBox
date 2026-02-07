/**
 * MinerU Cloud API 适配器 (T1)
 * 
 * 流程: 获取上传URL → PUT上传PDF → 轮询batch结果 → 下载zip → 提取md+figures
 */

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const MINERU_API_BASE = 'https://mineru.net/api/v4';

class MineruError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MineruError';
    this.code = code;
  }
}

/**
 * 获取预签名上传URL
 */
async function getUploadUrl(token, fileName, modelVersion) {
  const resp = await axios.post(`${MINERU_API_BASE}/file-urls/batch`, {
    files: [{ name: fileName, data_id: `pr_${Date.now()}` }],
    enable_formula: true,
    enable_table: true,
    model_version: modelVersion
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    timeout: 30000
  });

  const data = resp.data;
  if (data.code !== 0) {
    throw new MineruError('MINERU_AUTH_FAILED', `MinerU API error: code=${data.code}, msg=${data.msg || ''}`);
  }

  return {
    uploadUrl: data.data.file_urls[0],
    batchId: data.data.batch_id
  };
}

/**
 * PUT 上传文件到预签名URL
 */
async function uploadFile(uploadUrl, filePath) {
  const fileBuffer = await fs.readFile(filePath);
  // MinerU 文档明确说明：上传文件时无须设置 Content-Type 请求头
  // axios 会自动添加 Content-Type/Accept 等头部，导致 OSS 预签名 URL 签名校验失败
  // 改用 Node 原生 https 模块，只发送 Content-Length，完全匹配 Python requests.put(url, data=f) 的行为
  const { URL } = require('url');
  const https = require('https');
  const parsedUrl = new URL(uploadUrl);

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'PUT',
      headers: {
        'Content-Length': fileBuffer.length
      },
      timeout: 120000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new MineruError('MINERU_UPLOAD_FAILED',
            `Upload failed: HTTP ${res.statusCode} - ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new MineruError('MINERU_UPLOAD_FAILED', 'Upload timeout')); });
    req.write(fileBuffer);
    req.end();
  });
}

/**
 * 轮询batch结果
 */
async function pollBatchResult(token, batchId, { timeout = 300000, pollInterval = 5000 } = {}) {
  const startTime = Date.now();
  const url = `${MINERU_API_BASE}/extract-results/batch/${batchId}`;

  while (Date.now() - startTime < timeout) {
    const resp = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });

    const data = resp.data;
    if (data.code !== 0) {
      throw new MineruError('MINERU_PARSE_FAILED', `Batch poll failed: code=${data.code}`);
    }

    const results = data.data?.extract_result || [];
    if (results.length > 0) {
      const first = results[0];
      if (first.state === 'done') {
        return first;
      }
      if (first.state === 'failed') {
        throw new MineruError('MINERU_PARSE_FAILED', `Batch task failed: ${first.err_msg || 'unknown'}`);
      }
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new MineruError('MINERU_TIMEOUT', `Batch polling timeout after ${timeout}ms`);
}

/**
 * 下载并解压结果zip，提取markdown和图片
 */
async function downloadAndExtract(zipUrl, outputDir) {
  const AdmZip = require('adm-zip');

  const resp = await axios.get(zipUrl, {
    responseType: 'arraybuffer',
    timeout: 120000
  });

  const zip = new AdmZip(resp.data);
  const entries = zip.getEntries();

  let markdown = '';
  const figures = [];

  const figuresDir = path.join(outputDir, 'assets', 'figures');
  await fs.mkdir(figuresDir, { recursive: true });

  for (const entry of entries) {
    const entryName = entry.entryName;

    if (entryName.endsWith('.md') && !entry.isDirectory) {
      markdown = entry.getData().toString('utf-8');
    } else if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(entryName) && !entry.isDirectory) {
      const figName = path.basename(entryName);
      const figPath = path.join(figuresDir, figName);
      await fs.writeFile(figPath, entry.getData());
      figures.push({
        id: figName.replace(/\.[^.]+$/, ''),
        path: `assets/figures/${figName}`,
        filename: figName
      });
    }
  }

  return { markdown, figures };
}

/**
 * 从markdown中提取figure caption映射
 */
function extractFigureCaptions(markdown) {
  const captions = [];
  // 匹配 ![caption](path) 模式
  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = imgRegex.exec(markdown)) !== null) {
    captions.push({
      caption: match[1],
      originalPath: match[2],
      id: path.basename(match[2]).replace(/\.[^.]+$/, '')
    });
  }

  // 匹配 "Figure X." 或 "Fig. X:" 开头的段落
  const figTextRegex = /^(Fig(?:ure)?\.?\s*\d+[.:]\s*)(.+)$/gm;
  while ((match = figTextRegex.exec(markdown)) !== null) {
    captions.push({
      caption: match[2].trim(),
      label: match[1].trim(),
      id: `fig_text_${captions.length}`
    });
  }

  return captions;
}

/**
 * 完整流程：上传 PDF → 提交解析 → 轮询 → 返回结果
 * 
 * @param {string} pdfPath - PDF 绝对路径
 * @param {object} options - { token, timeout, pollInterval, outputDir, modelVersion }
 * @returns {Promise<{ markdown: string, figures: Array, pageCount: number, figureMap: Array }>}
 */
async function parsePdf(pdfPath, options = {}) {
  const token = options.token || process.env.MINERU_API_TOKEN;
  if (!token) {
    throw new MineruError('MINERU_AUTH_FAILED', 'MINERU_API_TOKEN is required');
  }

  const timeout = options.timeout || parseInt(process.env.MINERU_API_TIMEOUT || '300000', 10);
  const pollInterval = options.pollInterval || parseInt(process.env.MINERU_POLL_INTERVAL || '5000', 10);
  const modelVersion = options.modelVersion || process.env.MINERU_MODEL_VERSION || 'pipeline';

  const fileName = path.basename(pdfPath);
  const outputDir = options.outputDir || path.dirname(pdfPath);

  // Step 1: 获取上传URL
  const { uploadUrl, batchId } = await getUploadUrl(token, fileName, modelVersion);

  // Step 2: 上传文件
  await uploadFile(uploadUrl, pdfPath);

  // Step 3: 轮询batch结果 (file-urls/batch 自动创建解析任务)
  const batchResult = await pollBatchResult(token, batchId, { timeout, pollInterval });

  // Step 4: 下载并解压结果
  const zipUrl = batchResult.full_zip_url;
  if (!zipUrl) {
    throw new MineruError('MINERU_PARSE_FAILED', 'No zip URL in result');
  }

  const { markdown, figures } = await downloadAndExtract(zipUrl, outputDir);

  // Step 5: 提取figure captions
  const figureMap = extractFigureCaptions(markdown);

  return {
    markdown,
    figures,
    pageCount: batchResult.page_count || null,
    figureMap
  };
}

module.exports = {
  parsePdf,
  MineruError
};

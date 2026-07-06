const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
const SERVER_PORT = process.env.SERVER_PORT || process.env.PORT || '';
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY || '';
const VAR_HTTP_URL = process.env.VarHttpUrl || process.env.VAR_HTTP_URL || 'http://127.0.0.1';

const DEFAULT_OPTIONS = Object.freeze({
  migrateMultimodal: true,
  includeRaw: false,
  maxTextChars: 4000,
  maxJsonChars: 6000,
  maxRecords: 20
});

const DATA_IMAGE_URI_PATTERN = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/i;
const EMBEDDED_DATA_IMAGE_URI_PATTERN = /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/gi;

function normalizeOptions(options = {}) {
  return {
    migrateMultimodal: options.migrateMultimodal !== false && options.migrate_multimodal !== false,
    includeRaw: options.includeRaw === true || options.include_raw === true || String(options.includeRaw || options.include_raw || '').toLowerCase() === 'true',
    maxTextChars: normalizeInteger(options.maxTextChars || options.max_text_chars, DEFAULT_OPTIONS.maxTextChars, 500),
    maxJsonChars: normalizeInteger(options.maxJsonChars || options.max_json_chars, DEFAULT_OPTIONS.maxJsonChars, 1000),
    maxRecords: normalizeInteger(options.maxRecords || options.max_records || options.limit, DEFAULT_OPTIONS.maxRecords, 1)
  };
}

function normalizeInteger(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...[已截断 ${text.length - maxChars} 字符，避免上下文膨胀]`;
}

function safeJsonStringify(value, maxChars = DEFAULT_OPTIONS.maxJsonChars) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = JSON.stringify({ __serialization_error: error.message, preview: String(value).slice(0, 1000) }, null, 2);
  }
  return truncateText(text, maxChars);
}

function tryParseNestedJson(value, depth = 0) {
  if (depth > 3) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
    try {
      return tryParseNestedJson(JSON.parse(trimmed), depth + 1);
    } catch (_) {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(item => tryParseNestedJson(item, depth + 1));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = tryParseNestedJson(child, depth + 1);
    }
    return next;
  }
  return value;
}

function getImageExtension(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  return 'png';
}

function buildImageUrl(relativePath) {
  const normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/');
  if (!SERVER_PORT || !IMAGESERVER_IMAGE_KEY) {
    return `image/${normalizedRelativePath}`;
  }
  return `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${normalizedRelativePath}`;
}

function persistDataImage(dataUri, recordId, index) {
  const match = String(dataUri || '').trim().match(DATA_IMAGE_URI_PATTERN);
  if (!match) return null;

  const mimeType = match[1];
  const base64Payload = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64Payload, 'base64');
  if (!buffer.length) return null;

  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const extension = getImageExtension(mimeType);
  const safeRecordId = String(recordId || 'unknown-record').replace(/[^\w.-]+/g, '_').slice(0, 120);
  const fileName = `${String(index).padStart(2, '0')}-${hash}.${extension}`;
  const relativePath = path.join('tool-call-records', safeRecordId, fileName).replace(/\\/g, '/');
  const absolutePath = path.join(PROJECT_BASE_PATH, 'image', relativePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, buffer);
  }

  return {
    type: 'image',
    mimeType,
    bytes: buffer.length,
    fileName,
    relativePath: `image/${relativePath}`,
    url: buildImageUrl(relativePath)
  };
}

function migrateMultimodal(value, context) {
  if (!context.options.migrateMultimodal) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATA_IMAGE_URI_PATTERN.test(trimmed)) {
      DATA_IMAGE_URI_PATTERN.lastIndex = 0;
      const asset = persistDataImage(trimmed, context.recordId, ++context.assetIndex);
      if (asset) {
        context.assets.push(asset);
        return asset.url;
      }
      return '[图片数据迁移失败]';
    }

    EMBEDDED_DATA_IMAGE_URI_PATTERN.lastIndex = 0;
    return value.replace(EMBEDDED_DATA_IMAGE_URI_PATTERN, (match) => {
      const asset = persistDataImage(match, context.recordId, ++context.assetIndex);
      if (asset) {
        context.assets.push(asset);
        return asset.url;
      }
      return '[图片数据迁移失败]';
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => migrateMultimodal(item, context));
  }

  if (value && typeof value === 'object') {
    if (
      value.type === 'image_url' &&
      value.image_url &&
      typeof value.image_url === 'object' &&
      typeof value.image_url.url === 'string'
    ) {
      const migratedUrl = migrateMultimodal(value.image_url.url, context);
      return {
        ...value,
        image_url: {
          ...value.image_url,
          url: migratedUrl
        }
      };
    }

    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = migrateMultimodal(child, context);
    }
    return next;
  }

  return value;
}

function prepareRecord(record, options) {
  const context = {
    recordId: record?.id || 'unknown-record',
    options,
    assets: [],
    assetIndex: 0
  };

  const prepared = {
    ...record,
    callContent: migrateMultimodal(tryParseNestedJson(record?.callContent), context),
    returnContent: migrateMultimodal(tryParseNestedJson(record?.returnContent), context)
  };

  prepared.__migratedAssets = context.assets;
  return prepared;
}

function extractTextParts(value, output = []) {
  if (!value) return output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTextParts(item, output);
    return output;
  }
  if (typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') {
      output.push(value.text);
      return output;
    }
    if (typeof value.message === 'string') output.push(value.message);
    if (typeof value.error === 'string') output.push(value.error);
    if (typeof value.plugin_error === 'string') output.push(value.plugin_error);
    if (typeof value.plugin_execution_error === 'string') output.push(value.plugin_execution_error);
    for (const child of Object.values(value)) extractTextParts(child, output);
  }
  return output;
}

function summarizeRecord(record, options) {
  const texts = extractTextParts(record.returnContent, []);
  const summary = texts.find(text => text && text.length > 0) || record.errorText || '(无文本摘要)';
  return truncateText(summary, Math.min(options.maxTextChars, 1200));
}

function formatQueryLine(query = {}) {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return entries.length > 0 ? entries.join(', ') : '无筛选条件';
}

function formatAssetSection(assets = []) {
  if (!assets.length) return '无';
  return assets.map((asset, index) => {
    return [
      `### 图片 ${index + 1}`,
      `- URL: ${asset.url}`,
      `- 本地路径: ${asset.relativePath}`,
      `- 类型: ${asset.mimeType}`,
      `- 大小: ${asset.bytes} bytes`,
      `- 预览: <img src="${asset.url}" alt="工具调用记录图片 ${index + 1}" width="300">`
    ].join('\n');
  }).join('\n\n');
}

function formatRecordBrief(record, index, options) {
  const summary = summarizeRecord(record, options);
  const assets = record.__migratedAssets || [];
  const lines = [
    `## ${index + 1}. ${record.toolName || 'UnknownTool'} / ${record.status || 'unknown'}`,
    `- 记录ID: ${record.id}`,
    `- 调用者: ${record.callerSignature || '未知'}${record.callerType ? ` (${record.callerType})` : ''}`,
    `- 开始: ${record.startedAt || '未知'}`,
    `- 结束: ${record.finishedAt || '未知'}`,
    `- 耗时: ${record.durationMs ?? '未知'}ms`,
    `- 成功: ${record.success ? '是' : '否'}`,
    `- 多模态: ${record.hasMultimodal || assets.length > 0 ? '是' : '否'}`,
    `- 摘要: ${summary}`
  ];

  if (assets.length > 0) {
    lines.push('- 图片资源:');
    assets.forEach((asset, assetIndex) => {
      lines.push(`  - 图片 ${assetIndex + 1}: ${asset.url}`);
    });
  }

  return lines.join('\n');
}

function formatRecordDetail(record, options) {
  const summary = summarizeRecord(record, options);
  const assets = record.__migratedAssets || [];
  const lines = [
    '# 工具调用记录详情',
    '',
    '## 基本信息',
    `- 记录ID: ${record.id}`,
    `- 工具: ${record.toolName || 'UnknownTool'}`,
    `- 状态: ${record.status || 'unknown'}`,
    `- 成功: ${record.success ? '是' : '否'}`,
    `- 调用者: ${record.callerSignature || '未知'}${record.callerType ? ` (${record.callerType})` : ''}`,
    `- 来源节点: ${record.sourceNode || '未知'}`,
    `- 请求IP: ${record.requestIp || '未知'}`,
    `- 开始: ${record.startedAt || '未知'}`,
    `- 结束: ${record.finishedAt || '未知'}`,
    `- 耗时: ${record.durationMs ?? '未知'}ms`,
    `- 多模态: ${record.hasMultimodal || assets.length > 0 ? '是' : '否'}`,
    '',
    '## 返回摘要',
    truncateText(summary, options.maxTextChars),
    '',
    '## 多模态资源',
    formatAssetSection(assets),
    '',
    '## 调用参数摘要',
    '```json',
    safeJsonStringify(record.callContent, options.maxJsonChars),
    '```',
    '',
    '## 返回结构摘要',
    '```json',
    safeJsonStringify(record.returnContent, options.maxJsonChars),
    '```'
  ];

  if (record.errorText) {
    lines.push('', '## 错误信息', truncateText(record.errorText, options.maxTextChars));
  }

  if (options.includeRaw) {
    lines.push('', '## 原始记录', '```json', safeJsonStringify(record, options.maxJsonChars), '```');
  }

  lines.push('', '请优先使用上方“返回摘要”和“多模态资源”回答用户；不要复述被截断的原始 JSON。');
  return lines.join('\n');
}

function formatQueryReport(result, query = {}, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const records = Array.isArray(result?.records) ? result.records.slice(0, options.maxRecords) : [];
  const preparedRecords = records.map(record => prepareRecord(record, options));
  const allAssets = preparedRecords.flatMap(record => record.__migratedAssets || []);

  const lines = [
    '# 工具调用记录查询报告',
    '',
    `- 总数: ${result?.total ?? preparedRecords.length}`,
    `- 本次返回: ${preparedRecords.length}`,
    `- Limit: ${result?.limit ?? '未知'}`,
    `- Offset: ${result?.offset ?? 0}`,
    `- 查询条件: ${formatQueryLine(query)}`,
    `- 已迁移多模态资源: ${allAssets.length}`,
    '',
    '以下为 AI 友好摘要；大型 JSON 和 base64 图片已被摘要或迁移，避免上下文膨胀。',
    ''
  ];

  if (preparedRecords.length === 0) {
    lines.push('未找到匹配的工具调用记录。');
  } else {
    preparedRecords.forEach((record, index) => {
      lines.push(formatRecordBrief(record, index, options), '');
    });
  }

  if (allAssets.length > 0) {
    lines.push('## 本次查询迁移出的图片资源', formatAssetSection(allAssets), '');
  }

  if (options.includeRaw) {
    lines.push('## 原始查询结果摘要', '```json', safeJsonStringify({ ...result, records: preparedRecords }, options.maxJsonChars), '```');
  }

  return {
    markdown: lines.join('\n').trim(),
    records: preparedRecords,
    assets: allAssets
  };
}

function formatDetailReport(record, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  if (!record) {
    return {
      markdown: '未找到指定工具调用记录。',
      record: null,
      assets: []
    };
  }

  const preparedRecord = prepareRecord(record, options);
  return {
    markdown: formatRecordDetail(preparedRecord, options),
    record: preparedRecord,
    assets: preparedRecord.__migratedAssets || []
  };
}

module.exports = {
  formatQueryReport,
  formatDetailReport,
  normalizeOptions
};
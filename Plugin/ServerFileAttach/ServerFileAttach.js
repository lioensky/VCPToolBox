const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

let injectedConfig = {};
let projectBasePath = path.resolve(__dirname, '..', '..');

const MIME_TYPES = new Map([
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.zip', 'application/zip'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
]);

function readConfigValue(key, defaultValue = '') {
  const value = injectedConfig[key] !== undefined ? injectedConfig[key] : process.env[key];
  return value === undefined || value === null || value === '' ? defaultValue : value;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function splitRoots(value) {
  return String(value || '')
    .split(/[;\n]/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => path.resolve(projectBasePath, item));
}

function getConfig() {
  const cacheDir = String(readConfigValue('ATTACHMENT_CACHE_DIR', '.file_cache/agent_attachments')).trim();
  const authKey = String(readConfigValue('SERVER_ATTACHMENT_KEY', process.env.VCP_Key || process.env.Key || '')).trim();
  return {
    allowedRoots: splitRoots(readConfigValue('ALLOWED_ATTACHMENT_ROOTS', 'file')),
    maxBytes: parseInteger(readConfigValue('MAX_ATTACHMENT_BYTES'), 50 * 1024 * 1024),
    hashAlgorithm: String(readConfigValue('ATTACHMENT_HASH_ALGORITHM', 'sha256')).trim() || 'sha256',
    allowUnknownMime: parseBoolean(readConfigValue('ALLOW_UNKNOWN_MIME'), true),
    ttlSeconds: parseInteger(readConfigValue('ATTACHMENT_TTL_SECONDS'), 86400),
    downloadBaseUrl: String(readConfigValue('ATTACHMENT_DOWNLOAD_BASE_URL')).trim(),
    cacheDir: path.isAbsolute(cacheDir) ? cacheDir : path.resolve(projectBasePath, cacheDir),
    requireAuth: parseBoolean(readConfigValue('SERVER_ATTACHMENT_REQUIRE_AUTH'), true),
    authKey
  };
}

function isInsideRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveSourcePath(inputPath, config) {
  if (!config.allowedRoots.length) {
    const error = new Error('ALLOWED_ATTACHMENT_ROOTS is not configured. Refusing to attach server files by default.');
    error.statusCode = 403;
    throw error;
  }

  const rawPath = String(inputPath || '').trim();
  if (!rawPath) {
    const error = new Error('filePath/sourcePath/src is required.');
    error.statusCode = 400;
    throw error;
  }

  const filePath = rawPath.startsWith('file://')
    ? fileURLToPath(rawPath)
    : rawPath;
  const absolutePath = path.resolve(projectBasePath, filePath);
  const allowedRoot = config.allowedRoots.find(root => isInsideRoot(absolutePath, root));
  if (!allowedRoot) {
    const error = new Error(`Path is outside allowed attachment roots: ${absolutePath}`);
    error.statusCode = 403;
    throw error;
  }
  return { absolutePath, allowedRoot };
}

async function ensureReadableFile(filePath, config) {
  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch (error) {
    error.statusCode = 404;
    throw error;
  }
  if (!stats.isFile()) {
    const error = new Error(`Attachment source is not a file: ${filePath}`);
    error.statusCode = 400;
    throw error;
  }
  if (stats.size > config.maxBytes) {
    const error = new Error(`Attachment exceeds MAX_ATTACHMENT_BYTES (${stats.size} > ${config.maxBytes}).`);
    error.statusCode = 413;
    throw error;
  }
  return stats;
}

function detectMime(filePath, config) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES.get(ext);
  if (mime) return mime;
  if (config.allowUnknownMime) return 'application/octet-stream';
  const error = new Error(`Unknown MIME type for extension: ${ext || '(none)'}`);
  error.statusCode = 415;
  throw error;
}

function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    let hash;
    try {
      hash = crypto.createHash(algorithm);
    } catch (error) {
      reject(error);
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(`${algorithm}:${hash.digest('hex')}`));
  });
}

function indexPath(config) {
  return path.join(config.cacheDir, 'index.json');
}

async function readIndex(config) {
  try {
    return JSON.parse(await fsp.readFile(indexPath(config), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, attachments: {} };
    throw error;
  }
}

async function writeIndex(config, index) {
  await fsp.mkdir(config.cacheDir, { recursive: true });
  await fsp.writeFile(indexPath(config), JSON.stringify(index, null, 2), 'utf8');
}

function makeAttachmentId() {
  return `att_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function buildDownloadUrl(config, serverAttachmentId) {
  const relative = `/v1/attachments/${encodeURIComponent(serverAttachmentId)}`;
  return config.downloadBaseUrl
    ? `${config.downloadBaseUrl.replace(/\/$/, '')}${relative}`
    : relative;
}

function toPublicAttachment(record) {
  return {
    serverAttachmentId: record.serverAttachmentId,
    name: record.name,
    type: record.type,
    size: record.size,
    src: record.src,
    hash: record.hash,
    downloadUrl: record.downloadUrl,
    disposition: record.disposition,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}

async function registerAttachment(args = {}) {
  const config = getConfig();
  const inputPath = args.filePath || args.sourcePath || args.src;
  const { absolutePath, allowedRoot } = resolveSourcePath(inputPath, config);
  const stats = await ensureReadableFile(absolutePath, config);
  const hash = await hashFile(absolutePath, config.hashAlgorithm);
  const type = args.type || args.mimeType || detectMime(absolutePath, config);
  const now = new Date();
  const serverAttachmentId = args.serverAttachmentId || makeAttachmentId();
  const name = String(args.name || path.basename(absolutePath)).trim() || path.basename(absolutePath);

  const record = {
    serverAttachmentId,
    name,
    type,
    size: stats.size,
    src: pathToFileURL(absolutePath).href,
    sourcePath: absolutePath,
    allowedRoot,
    hash,
    downloadUrl: buildDownloadUrl(config, serverAttachmentId),
    disposition: args.disposition || 'download',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.ttlSeconds * 1000).toISOString()
  };

  const index = await readIndex(config);
  index.attachments[serverAttachmentId] = record;
  await writeIndex(config, index);

  const attachment = toPublicAttachment(record);
  return {
    messageForAI: `Attachment ready: ${attachment.name}`,
    content: [{ type: 'text', text: `Attachment ready: ${attachment.name}\nDownload URL: ${attachment.downloadUrl}` }],
    attachments: [attachment],
    vcp_attachments: [attachment],
    details: {
      command: 'AttachFile',
      indexPath: indexPath(config),
      attachment
    }
  };
}

async function getRecord(config, serverAttachmentId) {
  const index = await readIndex(config);
  const record = index.attachments[String(serverAttachmentId || '')];
  if (!record) {
    const error = new Error('Attachment ID not found.');
    error.statusCode = 404;
    throw error;
  }
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    const error = new Error('Attachment has expired.');
    error.statusCode = 404;
    throw error;
  }
  return record;
}

async function verifyRecordForDownload(record, config) {
  const { absolutePath } = resolveSourcePath(record.sourcePath, config);
  const stats = await ensureReadableFile(absolutePath, config);
  if (stats.size !== record.size) {
    const error = new Error('Attachment source size changed after registration.');
    error.statusCode = 409;
    throw error;
  }
  const hash = await hashFile(absolutePath, config.hashAlgorithm);
  if (hash !== record.hash) {
    const error = new Error('Attachment source hash changed after registration.');
    error.statusCode = 409;
    throw error;
  }
  return absolutePath;
}

async function processToolCall(args = {}) {
  const command = args.command || args.action || 'AttachFile';
  switch (command) {
    case 'AttachFile':
    case 'RegisterFile':
      return registerAttachment(args);
    default:
      throw new Error(`Unknown ServerFileAttach command: ${command}`);
  }
}

function isAuthorized(req, config) {
  if (!config.requireAuth) return true;
  if (!config.authKey) return false;
  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${config.authKey}`) return true;
  if (req.query && req.query.key === config.authKey) return true;
  return false;
}

function registerRoutes(app, pluginConfig = {}, basePath = projectBasePath) {
  injectedConfig = { ...injectedConfig, ...pluginConfig };
  projectBasePath = basePath || projectBasePath;

  app.get('/v1/attachments/:serverAttachmentId', async (req, res) => {
    const config = getConfig();
    if (!isAuthorized(req, config)) {
      res.status(403).json({ error: 'Unauthorized attachment download.' });
      return;
    }

    try {
      const record = await getRecord(config, req.params.serverAttachmentId);
      const filePath = await verifyRecordForDownload(record, config);
      res.setHeader('Content-Type', record.type || 'application/octet-stream');
      res.setHeader('Content-Length', String(record.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`);
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}

async function initialize(pluginConfig = {}) {
  injectedConfig = { ...pluginConfig };
  projectBasePath = pluginConfig.PROJECT_BASE_PATH || projectBasePath;
}

module.exports = {
  initialize,
  processToolCall,
  registerRoutes,
  _private: {
    getConfig,
    hashFile,
    readIndex,
    registerAttachment,
    resolveSourcePath,
    verifyRecordForDownload
  }
};

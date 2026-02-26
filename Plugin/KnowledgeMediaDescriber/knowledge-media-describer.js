const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

const DEBUG_MODE = (process.env.DebugMode || '').toLowerCase() === 'true';

const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg',
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg',
  '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.pdf'
]);

function debugLog(message, data) {
  if (!DEBUG_MODE) return;
  const suffix = data !== undefined ? ` ${JSON.stringify(data, null, 2)}` : '';
  console.error(`[KnowledgeMediaDescriber][Debug] ${message}${suffix}`);
}

function getKnowledgeRootPath() {
  const configuredRoot = (process.env.KNOWLEDGEBASE_ROOT_PATH || '').trim();
  const root = configuredRoot
    ? (path.isAbsolute(configuredRoot) ? configuredRoot : path.resolve(__dirname, '..', '..', configuredRoot))
    : path.join(__dirname, '..', '..', 'dailynote');
  return path.normalize(root);
}

function getSidecarSuffix() {
  return (process.env.MULTIMODAL_SIDECAR_SUFFIX || '.vcpmeta.json').trim() || '.vcpmeta.json';
}

function toFileUrl(absPath) {
  return `file://${path.normalize(absPath)}`;
}

function decodeFileUrlToPath(fileUrlOrPath) {
  if (typeof fileUrlOrPath !== 'string') return '';
  const input = fileUrlOrPath.trim();
  if (!input) return '';
  if (input.startsWith('file://')) {
    const rawPath = input.replace(/^file:\/\//i, '');
    try {
      return path.normalize(decodeURIComponent(rawPath));
    } catch (_) {
      return path.normalize(rawPath);
    }
  }
  return path.normalize(input);
}

function isPathInsideRoot(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map(tag => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(Boolean);
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeStringArray(input) {
  if (Array.isArray(input)) {
    return input
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  if (typeof input === 'string' && input.trim()) {
    return input
      .split(/[;,]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.pdf': 'application/pdf'
  };
  return map[ext] || 'application/octet-stream';
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function computeSha256(filePath) {
  const data = await fs.readFile(filePath);
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

async function resolveMediaPath(inputMediaPath) {
  const decoded = decodeFileUrlToPath(inputMediaPath);
  if (!decoded) throw new Error('mediaPath 不能为空。');

  const absolutePath = path.isAbsolute(decoded)
    ? path.normalize(decoded)
    : path.resolve(decoded);

  const stats = await fs.stat(absolutePath);
  if (!stats.isFile()) throw new Error('mediaPath 必须指向文件。');

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的媒体类型: ${ext}`);
  }

  return { mediaPath: absolutePath, stats };
}

function resolveTargetDiaryPath(targetDiaryName, knowledgeRootPath) {
  if (typeof targetDiaryName !== 'string' || !targetDiaryName.trim()) {
    return '';
  }

  const name = targetDiaryName.trim();
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('targetDiaryName 只能是日记本名称，不能包含路径分隔符。');
  }

  const absDiaryPath = path.normalize(path.join(knowledgeRootPath, name));
  if (!isPathInsideRoot(absDiaryPath, knowledgeRootPath)) {
    throw new Error('targetDiaryName 解析后的路径不在 KNOWLEDGEBASE_ROOT_PATH 范围内。');
  }
  return absDiaryPath;
}

async function resolveWritableTargetPath(targetPath, overwrite = false) {
  if (overwrite) return targetPath;

  let candidate = targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const name = path.basename(targetPath, ext);
  let index = 1;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${name}_${index}${ext}`);
      index += 1;
    } catch (_) {
      return candidate;
    }
  }
}

async function moveFileCrossDeviceSafe(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
}

async function buildAndWriteSidecar(mediaPath, knowledgeRootPath, options = {}) {
  const sidecarSuffix = getSidecarSuffix();
  const sidecarPath = `${mediaPath}${sidecarSuffix}`;
  const existing = await safeReadJson(sidecarPath);

  const mediaHash = await computeSha256(mediaPath);
  const now = new Date().toISOString();

  const presetName = typeof options.presetName === 'string' && options.presetName.trim()
    ? options.presetName.trim()
    : (typeof existing?.presetName === 'string' && existing.presetName.trim() ? existing.presetName.trim() : 'Cognito-Core');

  const tags = options.tags !== undefined
    ? normalizeTags(options.tags)
    : normalizeTags(existing?.tags);

  const generator = options.generator !== undefined
    ? normalizeStringArray(options.generator)
    : normalizeStringArray(existing?.generator);

  const description = options.description !== undefined
    ? String(options.description || '').trim()
    : (typeof existing?.description === 'string' ? existing.description.trim() : '');

  const source = typeof options.source === 'string' && options.source.trim()
    ? options.source.trim()
    : (typeof existing?.source === 'string' && existing.source.trim() ? existing.source.trim() : 'manual');

  const sidecar = {
    version: 1,
    mediaHash,
    filePath: toFileUrl(mediaPath),
    mediaPath: toFileUrl(mediaPath),
    relativePath: isPathInsideRoot(mediaPath, knowledgeRootPath) ? path.relative(knowledgeRootPath, mediaPath) : '',
    mimeType: guessMimeType(mediaPath),
    description,
    presetName,
    tags,
    generator: generator.length > 0 ? generator : [presetName],
    source,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
  return { sidecarPath, sidecar };
}

async function traceAndPersistMedia(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  await fs.access(knowledgeRootPath);

  const {
    mediaPath,
    description,
    tags,
    presetName,
    generator,
    source,
    targetDiaryName,
    targetFileName,
    relocateMode = 'copy',
    overwrite = false
  } = request || {};

  const resolved = await resolveMediaPath(mediaPath);
  debugLog('Resolved source media', resolved);

  const sourceSidecarResult = await buildAndWriteSidecar(resolved.mediaPath, knowledgeRootPath, {
    description,
    tags,
    presetName,
    generator,
    source
  });

  const result = {
    action: 'TraceKnowledgeMedia',
    source: {
      mediaPath: toFileUrl(resolved.mediaPath),
      sidecarPath: toFileUrl(sourceSidecarResult.sidecarPath),
      sidecar: sourceSidecarResult.sidecar
    },
    target: null
  };

  const normalizedDiaryName = (typeof targetDiaryName === 'string' && targetDiaryName.trim())
    ? targetDiaryName.trim()
    : (typeof request?.targetDiary === 'string' ? request.targetDiary.trim() : '');
  const targetDiaryPath = resolveTargetDiaryPath(normalizedDiaryName, knowledgeRootPath);
  if (!targetDiaryPath) {
    return result;
  }

  await ensureDirectory(targetDiaryPath);

  const isCopy = String(relocateMode || 'copy').toLowerCase() === 'copy';
  const sourceFileName = path.basename(resolved.mediaPath);
  const finalFileName = (isCopy && typeof targetFileName === 'string' && targetFileName.trim())
    ? targetFileName.trim()
    : sourceFileName;

  const requestedTargetMediaPath = path.join(targetDiaryPath, finalFileName);
  const writableTargetMediaPath = await resolveWritableTargetPath(requestedTargetMediaPath, !!overwrite);

  const sidecarSuffix = getSidecarSuffix();
  const sourceSidecarPath = sourceSidecarResult.sidecarPath;
  const writableTargetSidecarPath = `${writableTargetMediaPath}${sidecarSuffix}`;

  const shouldMove = String(relocateMode || 'copy').toLowerCase() === 'move';
  if (shouldMove) {
    await moveFileCrossDeviceSafe(resolved.mediaPath, writableTargetMediaPath);
    await moveFileCrossDeviceSafe(sourceSidecarPath, writableTargetSidecarPath);
  } else {
    await fs.copyFile(resolved.mediaPath, writableTargetMediaPath);
    await fs.copyFile(sourceSidecarPath, writableTargetSidecarPath);
  }

  const targetSidecarResult = await buildAndWriteSidecar(writableTargetMediaPath, knowledgeRootPath, {
    description,
    tags,
    presetName,
    generator,
    source: source || 'trace'
  });

  result.target = {
    mode: shouldMove ? 'move' : 'copy',
    diaryName: normalizedDiaryName,
    diaryPath: toFileUrl(targetDiaryPath),
    mediaPath: toFileUrl(writableTargetMediaPath),
    sidecarPath: toFileUrl(targetSidecarResult.sidecarPath),
    sidecar: targetSidecarResult.sidecar
  };

  return result;
}

function convertToVCPFormat(response) {
  if (response.success) {
    const data = response.data || {};
    const content = [];

    if (Array.isArray(data.content) && data.content.length > 0) {
      content.push(...data.content);
      if (data.message) {
        const hasMessage = content.some(item => item?.type === 'text' && typeof item.text === 'string' && item.text.includes(data.message));
        if (!hasMessage) {
          content.unshift({ type: 'text', text: data.message });
        }
      }
    } else {
      content.push({
        type: 'text',
        text: data.message || '操作成功。'
      });
    }

    return {
      status: 'success',
      result: {
        content,
        details: data
      }
    };
  }
  return {
    status: 'error',
    error: response.error || 'Unknown error'
  };
}

async function updateSidecarParams(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  const { diaryName, fileName, description, tags, presetName, generator, source } = request || {};

  if (!diaryName || !fileName) {
    throw new Error('diaryName 和 fileName 不能为空。');
  }

  const diaryPath = resolveTargetDiaryPath(diaryName, knowledgeRootPath);
  const mediaPath = path.join(diaryPath, fileName);

  const stats = await fs.stat(mediaPath);
  if (!stats.isFile()) {
    throw new Error(`文件不存在: ${mediaPath}`);
  }

  const sidecarResult = await buildAndWriteSidecar(mediaPath, knowledgeRootPath, {
    description,
    tags,
    presetName,
    generator,
    source
  });

  return {
    action: 'UpdateSidecarParams',
    diaryName,
    fileName,
    sidecarPath: toFileUrl(sidecarResult.sidecarPath),
    sidecar: sidecarResult.sidecar
  };
}

async function listSidecars(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  const { diaryName } = request || {};
  if (!diaryName) {
    throw new Error('diaryName 不能为空。');
  }

  const diaryPath = resolveTargetDiaryPath(diaryName, knowledgeRootPath);
  const sidecarSuffix = getSidecarSuffix();

  const entries = await fs.readdir(diaryPath, { withFileTypes: true });
  const sidecarFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(sidecarSuffix))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  const sidecars = [];
  for (const sidecarFileName of sidecarFiles) {
    const sidecarAbsPath = path.join(diaryPath, sidecarFileName);
    const parsed = await safeReadJson(sidecarAbsPath);
    sidecars.push({
      sidecarFileName,
      sidecarPath: toFileUrl(sidecarAbsPath),
      mediaFileName: sidecarFileName.slice(0, -sidecarSuffix.length),
      sidecar: parsed || null
    });
  }

  return {
    action: 'ListSidecars',
    diaryName,
    diaryPath: toFileUrl(diaryPath),
    count: sidecars.length,
    sidecars
  };
}

async function getSidecar(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  const { diaryName, fileName } = request || {};
  if (!diaryName || !fileName) {
    throw new Error('diaryName 和 fileName 不能为空。');
  }

  const diaryPath = resolveTargetDiaryPath(diaryName, knowledgeRootPath);
  const sidecarSuffix = getSidecarSuffix();
  const sidecarAbsPath = path.join(diaryPath, `${fileName}${sidecarSuffix}`);

  const stats = await fs.stat(sidecarAbsPath);
  if (!stats.isFile()) {
    throw new Error(`侧车文件不存在: ${sidecarAbsPath}`);
  }

  const parsed = await safeReadJson(sidecarAbsPath);
  if (!parsed) {
    throw new Error(`侧车文件内容无效: ${sidecarAbsPath}`);
  }

  return {
    action: 'GetSidecar',
    diaryName,
    fileName,
    sidecarPath: toFileUrl(sidecarAbsPath),
    sidecar: parsed
  };
}

async function readDiaryFile(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  const { diaryName, fileName, encoding = 'utf8' } = request || {};

  if (!diaryName || !fileName) {
    throw new Error('diaryName 和 fileName 不能为空。');
  }

  const diaryPath = resolveTargetDiaryPath(diaryName, knowledgeRootPath);
  const targetFilePath = path.join(diaryPath, fileName);

  const stats = await fs.stat(targetFilePath);
  if (!stats.isFile()) {
    throw new Error(`文件不存在: ${targetFilePath}`);
  }

  const extension = path.extname(targetFilePath).toLowerCase();
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'];
  const videoExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.avi'];

  let content = [];
  let responseEncoding = encoding;

  if (imageExtensions.includes(extension) || audioExtensions.includes(extension) || videoExtensions.includes(extension)) {
    const fileBuffer = await fs.readFile(targetFilePath);
    const mimeType = guessMimeType(targetFilePath);
    const base64Url = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

    responseEncoding = 'base64';
    content = [
      {
        type: 'text',
        text: `已读取文件 '${fileName}' (${stats.size} Bytes)。`
      },
      {
        type: 'image_url',
        image_url: {
          url: base64Url
        }
      }
    ];
  } else {
    const rawContent = await fs.readFile(targetFilePath, encoding);
    const textContent = Buffer.isBuffer(rawContent) ? rawContent.toString(encoding) : String(rawContent);
    content = [
      {
        type: 'text',
        text: `已读取文件 '${fileName}' (${stats.size} Bytes)。\n\`\`\`\n${textContent}\n\`\`\``
      }
    ];
  }

  return {
    action: 'ReadFile',
    diaryName,
    fileName,
    filePath: toFileUrl(targetFilePath),
    size: stats.size,
    sizeFormatted: `${stats.size} Bytes`,
    encoding: responseEncoding,
    lastModified: stats.mtime.toISOString(),
    content
  };
}

async function renameDiaryMedia(request) {
  const knowledgeRootPath = getKnowledgeRootPath();
  const sidecarSuffix = getSidecarSuffix();

  const {
    diaryName,
    fileName,
    newFileName,
    overwrite = false
  } = request || {};

  if (!diaryName || !fileName || !newFileName) {
    throw new Error('diaryName、fileName、newFileName 不能为空。');
  }

  const diaryPath = resolveTargetDiaryPath(diaryName, knowledgeRootPath);
  const sourceMediaPath = path.join(diaryPath, fileName);
  const requestedTargetMediaPath = path.join(diaryPath, newFileName);

  const sourceStats = await fs.stat(sourceMediaPath);
  if (!sourceStats.isFile()) {
    throw new Error(`媒体文件不存在: ${sourceMediaPath}`);
  }

  const targetMediaPath = await resolveWritableTargetPath(requestedTargetMediaPath, !!overwrite);
  const sourceSidecarPath = `${sourceMediaPath}${sidecarSuffix}`;
  const targetSidecarPath = `${targetMediaPath}${sidecarSuffix}`;

  const hasSidecar = await fs.access(sourceSidecarPath).then(() => true).catch(() => false);

  await fs.rename(sourceMediaPath, targetMediaPath);
  if (hasSidecar) {
    await fs.rename(sourceSidecarPath, targetSidecarPath);
  }

  const refreshed = await buildAndWriteSidecar(targetMediaPath, knowledgeRootPath, {});

  return {
    action: 'RenameDiaryMedia',
    diaryName,
    sourceMediaPath: toFileUrl(sourceMediaPath),
    targetMediaPath: toFileUrl(targetMediaPath),
    sourceSidecarPath: hasSidecar ? toFileUrl(sourceSidecarPath) : null,
    targetSidecarPath: toFileUrl(refreshed.sidecarPath),
    sidecar: refreshed.sidecar
  };
}

async function processRequest(request) {
  const action = request?.command;
  debugLog('Processing request', request);

  try {
    switch (action) {
      case 'TraceKnowledgeMedia': {
        const traceResult = await traceAndPersistMedia(request);
        return {
          success: true,
          data: {
            message: traceResult.target
              ? '媒体已完成：侧车写入 + 入库同步完成。'
              : '媒体已完成：侧车写入完成。',
            ...traceResult
          }
        };
      }

      case 'UpdateSidecarParams': {
        const updateResult = await updateSidecarParams(request);
        return {
          success: true,
          data: {
            message: '侧车参数更新完成。',
            ...updateResult
          }
        };
      }

      case 'ListSidecars': {
        const listResult = await listSidecars(request);
        return {
          success: true,
          data: {
            message: `侧车文件列出完成，共 ${listResult.count} 个。`,
            ...listResult
          }
        };
      }

      case 'GetSidecar': {
        const getResult = await getSidecar(request);
        return {
          success: true,
          data: {
            message: '侧车文件读取完成。',
            ...getResult
          }
        };
      }

      case 'ReadFile': {
        const fileResult = await readDiaryFile(request);
        return {
          success: true,
          data: {
            message: '文件读取完成。',
            ...fileResult
          }
        };
      }

      case 'RenameDiaryMedia': {
        const renameResult = await renameDiaryMedia(request);
        return {
          success: true,
          data: {
            message: '多模态文件重命名完成，侧车已联动刷新。',
            ...renameResult
          }
        };
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${action}`
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (data) => {
  try {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      const response = await processRequest(request);
      console.log(JSON.stringify(convertToVCPFormat(response)));
    }
  } catch (error) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Invalid request format: ${error.message}`
    }));
  }
});
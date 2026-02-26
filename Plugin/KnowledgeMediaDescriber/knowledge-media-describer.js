const fs = require('fs').promises;
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

const DEBUG_MODE = (process.env.DebugMode || '').toLowerCase() === 'true';

const KNOWLEDGE_MEDIA_EXTENSIONS = new Set([
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
  return `file://${absPath}`;
}

function decodeFileUrlToPath(fileUrlOrPath) {
  if (typeof fileUrlOrPath !== 'string') return '';
  const input = fileUrlOrPath.trim();
  if (!input) return '';
  if (input.startsWith('file://')) {
    const rawPath = input.replace(/^file:\/\//i, '');
    try {
      return decodeURIComponent(rawPath);
    } catch (_) {
      return rawPath;
    }
  }
  return input;
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

function isPathInsideRoot(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function safeReadJson(jsonPath) {
  try {
    const raw = await fs.readFile(jsonPath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function buildAutoDescription(mediaPath, stats) {
  const ext = path.extname(mediaPath).toLowerCase() || 'unknown';
  const fileName = path.basename(mediaPath);
  const sizeBytes = stats && typeof stats.size === 'number' ? stats.size : 0;
  const modifiedAt = stats && stats.mtime ? stats.mtime.toISOString() : new Date().toISOString();
  return [
    `文件名：${fileName}`,
    `类型：${ext}`,
    `大小：${sizeBytes} bytes`,
    `最近修改：${modifiedAt}`,
    `路径：${toFileUrl(mediaPath)}`
  ].join('\n');
}

async function resolveKnowledgeMediaPath(inputPath, knowledgeRootPath) {
  const decoded = decodeFileUrlToPath(inputPath);
  if (!decoded) {
    throw new Error('mediaPath 不能为空。');
  }

  const resolvedPath = path.isAbsolute(decoded)
    ? path.normalize(decoded)
    : path.normalize(path.join(knowledgeRootPath, decoded));

  if (!isPathInsideRoot(resolvedPath, knowledgeRootPath)) {
    throw new Error('mediaPath 不在 KNOWLEDGEBASE_ROOT_PATH 范围内。');
  }

  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error('mediaPath 必须指向文件。');
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (!KNOWLEDGE_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的媒体类型: ${extension}`);
  }

  return { mediaPath: resolvedPath, stats };
}

async function walkKnowledgeMediaFiles(knowledgeRootPath) {
  const result = [];
  const stack = [knowledgeRootPath];
  const sidecarSuffix = getSidecarSuffix().toLowerCase();

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry || !entry.name || entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (lowerName.endsWith(sidecarSuffix)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (KNOWLEDGE_MEDIA_EXTENSIONS.has(ext)) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

async function ensureSidecarForMedia(mediaPath, options = {}) {
  const sidecarSuffix = getSidecarSuffix();
  const sidecarPath = `${mediaPath}${sidecarSuffix}`;
  const existing = await safeReadJson(sidecarPath);

  const stats = await fs.stat(mediaPath);
  const now = new Date().toISOString();

  const regenerate = !!options.regenerate;
  const nextDescription = regenerate
    ? buildAutoDescription(mediaPath, stats)
    : (existing && typeof existing.description === 'string' && existing.description.trim()
      ? existing.description.trim()
      : buildAutoDescription(mediaPath, stats));

  const sidecar = {
    version: 1,
    filePath: toFileUrl(mediaPath),
    mediaPath: toFileUrl(mediaPath),
    presetName: existing && typeof existing.presetName === 'string' ? existing.presetName : '',
    description: nextDescription,
    tags: existing && Array.isArray(existing.tags) ? normalizeTags(existing.tags) : [],
    updatedAt: now
  };

  if (options.patch && typeof options.patch === 'object') {
    if (typeof options.patch.presetName === 'string') {
      sidecar.presetName = options.patch.presetName.trim();
    }
    if (typeof options.patch.description === 'string') {
      sidecar.description = options.patch.description.trim();
    }
    if (options.patch.tags !== undefined) {
      sidecar.tags = normalizeTags(options.patch.tags);
    }
    sidecar.updatedAt = now;
  }

  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
  return { sidecarPath, sidecar, existed: !!existing };
}

async function buildKnowledgeMediaList(knowledgeRootPath, keyword = '') {
  const mediaFiles = await walkKnowledgeMediaFiles(knowledgeRootPath);
  const loweredKeyword = (keyword || '').trim().toLowerCase();
  const sidecarSuffix = getSidecarSuffix();

  const items = [];
  for (const mediaPath of mediaFiles) {
    let stats;
    try {
      stats = await fs.stat(mediaPath);
    } catch (_) {
      continue;
    }

    const sidecarPath = `${mediaPath}${sidecarSuffix}`;
    const sidecar = await safeReadJson(sidecarPath);
    const relativePath = path.relative(knowledgeRootPath, mediaPath);
    const description = sidecar && typeof sidecar.description === 'string' ? sidecar.description : '';
    const presetName = sidecar && typeof sidecar.presetName === 'string' ? sidecar.presetName : '';
    const tags = sidecar && Array.isArray(sidecar.tags) ? normalizeTags(sidecar.tags) : [];

    const item = {
      mediaPath: toFileUrl(mediaPath),
      relativePath,
      extension: path.extname(mediaPath).toLowerCase(),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      sidecarPath: toFileUrl(sidecarPath),
      hasSidecar: !!sidecar,
      presetName,
      description,
      tags
    };

    if (loweredKeyword) {
      const searchable = [
        relativePath.toLowerCase(),
        description.toLowerCase(),
        presetName.toLowerCase(),
        tags.join(',').toLowerCase()
      ].join('\n');
      if (!searchable.includes(loweredKeyword)) {
        continue;
      }
    }

    items.push(item);
  }

  items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return items;
}

function convertToVCPFormat(response) {
  if (response.success) {
    const data = response.data || {};
    let contentArray = [];

    if (data.content) {
      if (Array.isArray(data.content)) {
        contentArray.push(...data.content);
      } else {
        contentArray.push({ type: 'text', text: String(data.content) });
      }
    }

    if (data.message) {
      contentArray.unshift({ type: 'text', text: String(data.message) });
    }

    if (contentArray.length === 0) {
      const { content, ...rest } = data;
      contentArray.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
    }

    return {
      status: 'success',
      result: {
        content: contentArray,
        details: data
      }
    };
  }

  return {
    status: 'error',
    error: response.error || 'Unknown error'
  };
}

async function processRequest(request) {
  const action = request.command;
  const knowledgeRootPath = getKnowledgeRootPath();

  debugLog('Processing request', { action, request });

  try {
    await fs.access(knowledgeRootPath);
  } catch (error) {
    return {
      success: false,
      error: `知识库根目录不可用: ${knowledgeRootPath} (${error.message})`
    };
  }

  try {
    switch (action) {
      case 'ListKnowledgeMedia': {
        const keyword = typeof request.keyword === 'string' ? request.keyword : '';
        const items = await buildKnowledgeMediaList(knowledgeRootPath, keyword);
        return {
          success: true,
          data: {
            message: `知识库多媒体列表获取成功，共 ${items.length} 项。`,
            rootPath: toFileUrl(knowledgeRootPath),
            sidecarSuffix: getSidecarSuffix(),
            total: items.length,
            items
          }
        };
      }

      case 'UpdateKnowledgeMedia': {
        const { mediaPath, description, presetName, tags } = request;
        const resolved = await resolveKnowledgeMediaPath(mediaPath, knowledgeRootPath);
        const patch = { description, presetName, tags };
        const { sidecarPath, sidecar } = await ensureSidecarForMedia(resolved.mediaPath, { patch });
        return {
          success: true,
          data: {
            message: '媒体侧车已更新。',
            mediaPath: toFileUrl(resolved.mediaPath),
            sidecarPath: toFileUrl(sidecarPath),
            sidecar
          }
        };
      }

      case 'RegenerateKnowledgeMedia': {
        const { mediaPath } = request;
        const resolved = await resolveKnowledgeMediaPath(mediaPath, knowledgeRootPath);
        const { sidecarPath, sidecar } = await ensureSidecarForMedia(resolved.mediaPath, { regenerate: true });
        return {
          success: true,
          data: {
            message: '媒体描述已重生成。',
            mediaPath: toFileUrl(resolved.mediaPath),
            sidecarPath: toFileUrl(sidecarPath),
            sidecar
          }
        };
      }

      case 'RebuildKnowledgeMedia': {
        const regenerateExisting = !!request.regenerateExisting;
        const mediaFiles = await walkKnowledgeMediaFiles(knowledgeRootPath);

        let created = 0;
        let updated = 0;
        for (const mediaPath of mediaFiles) {
          const sidecarPath = `${mediaPath}${getSidecarSuffix()}`;
          const sidecarExists = !!(await safeReadJson(sidecarPath));

          if (!sidecarExists || regenerateExisting) {
            await ensureSidecarForMedia(mediaPath, { regenerate: regenerateExisting });
            if (sidecarExists) {
              updated += 1;
            } else {
              created += 1;
            }
          }
        }

        return {
          success: true,
          data: {
            message: '知识库多媒体侧车重建完成。',
            scanned: mediaFiles.length,
            created,
            updated
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
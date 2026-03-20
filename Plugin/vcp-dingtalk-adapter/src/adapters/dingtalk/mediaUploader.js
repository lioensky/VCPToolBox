import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
};

function getMimeByFileName(fileName = '') {
  const ext = path.extname(fileName || '').toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

function extFromMime(mimeType = '') {
  const entry = Object.entries(EXT_TO_MIME).find(([, mime]) => mime === mimeType);
  return entry?.[0] || '';
}

function inferUploadType(mimeType = '', fileName = '') {
  const mime = String(mimeType || '').toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'voice';
  if (mime.startsWith('video/')) return 'video';

  const ext = path.extname(fileName || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.ogg', '.amr'].includes(ext)) return 'voice';
  if (['.mp4'].includes(ext)) return 'video';

  return 'file';
}

function decodeDataUri(dataUri) {
  const match = String(dataUri).match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) {
    throw new Error('Invalid data URI');
  }

  const mimeType = match[1] || 'application/octet-stream';
  const payload = match[2] || '';
  const isBase64 = String(dataUri).includes(';base64,');
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  return { buffer, mimeType };
}

function inferFileNameFromUrl(url, fallback = 'resource') {
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || '');
    const base = path.basename(pathname);
    return base || fallback;
  } catch {
    return fallback;
  }
}

function isPrivateHost(hostname = '') {
  const host = String(hostname).toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;

  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const n = Number(match172[1]);
    if (n >= 16 && n <= 31) return true;
  }

  return false;
}

export function isPublicHttpUrl(value = '') {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (isPrivateHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function readSource(source, options = {}) {
  const sourceValue = typeof source === 'object' && source !== null
    ? (source.source || source.url || '')
    : source;

  const preferredFileName =
    (typeof source === 'object' && source?.fileName) ||
    options.fileName ||
    '';

  const preferredMimeType =
    (typeof source === 'object' && source?.mimeType) ||
    options.mimeType ||
    '';

  if (!sourceValue) {
    throw new Error('media source is empty');
  }

  if (Buffer.isBuffer(sourceValue)) {
    return {
      buffer: sourceValue,
      fileName: preferredFileName || 'buffer.bin',
      mimeType: preferredMimeType || getMimeByFileName(preferredFileName || 'buffer.bin'),
      source: 'buffer',
    };
  }

  if (String(sourceValue).startsWith('data:')) {
    const { buffer, mimeType } = decodeDataUri(sourceValue);
    const ext = extFromMime(mimeType);
    return {
      buffer,
      fileName: preferredFileName || `inline${ext || '.bin'}`,
      mimeType,
      source: sourceValue,
    };
  }

  if (String(sourceValue).startsWith('file://')) {
    const filePath = fileURLToPath(sourceValue);
    const buffer = await fs.readFile(filePath);
    const fileName = preferredFileName || path.basename(filePath);
    return {
      buffer,
      fileName,
      mimeType: preferredMimeType || getMimeByFileName(fileName),
      source: sourceValue,
    };
  }

  if (/^https?:\/\//i.test(String(sourceValue))) {
    const resp = await fetch(sourceValue);
    if (!resp.ok) {
      throw new Error(`fetch media source failed: ${resp.status} ${sourceValue}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType =
      preferredMimeType ||
      resp.headers.get('content-type') ||
      getMimeByFileName(preferredFileName || inferFileNameFromUrl(sourceValue));

    const inferredFileName = preferredFileName || inferFileNameFromUrl(sourceValue, 'remote-resource');
    const normalizedFileName = path.extname(inferredFileName)
      ? inferredFileName
      : `${inferredFileName}${extFromMime(mimeType)}`;

    return {
      buffer,
      fileName: normalizedFileName,
      mimeType,
      source: sourceValue,
    };
  }

  throw new Error(`Unsupported media source: ${sourceValue}`);
}

async function parseUploadResponse(resp) {
  const raw = await resp.text();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createMediaUploader({
  authClient,
  logger = console,
} = {}) {
  if (!authClient || typeof authClient.getAccessToken !== 'function') {
    throw new Error('createMediaUploader requires authClient.getAccessToken');
  }

  /**
   * 通过 downloadCode 下载钉钉媒体文件
   * @param {string} downloadCode - 钉钉媒体下载码
   * @param {string} fileName - 文件名（可选）
   * @returns {Promise<{buffer: Buffer, fileName: string, mimeType: string}>}
   */
  async function downloadByCode(downloadCode, fileName = '') {
    if (!downloadCode) {
      throw new Error('downloadByCode requires downloadCode');
    }

    const accessToken = await authClient.getAccessToken();

    // 钉钉媒体文件下载 API
    const resp = await fetch(
      `https://oapi.dingtalk.com/media/download?access_token=${encodeURIComponent(accessToken)}&downloadCode=${encodeURIComponent(downloadCode)}`,
      {
        method: 'GET',
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`download media failed: ${resp.status} ${text}`);
    }

    // 获取文件信息
    const contentType = resp.headers.get('content-type') || '';
    const contentDisposition = resp.headers.get('content-disposition') || '';

    // 尝试从 Content-Disposition 提取文件名
    let inferredFileName = fileName;
    if (!inferredFileName && contentDisposition) {
      const match = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^'";\s]+)/i);
      if (match) {
        inferredFileName = decodeURIComponent(match[1]);
      }
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const mimeType = contentType || getMimeByFileName(inferredFileName || 'file.bin');
    const finalFileName = inferredFileName || `download_${Date.now()}${extFromMime(mimeType) || '.bin'}`;

    logger.info('[mediaUploader] download ok', {
      downloadCode,
      fileName: finalFileName,
      size: buffer.length,
      mimeType,
    });

    return {
      buffer,
      fileName: finalFileName,
      mimeType,
      downloadCode,
    };
  }

  /**
   * 通过 downloadCode 获取图片 URL
   * 钉钉图片可以通过特定 API 获取公网可访问的 URL
   * @param {string} downloadCode - 钉钉图片下载码
   * @returns {Promise<string>} 公网可访问的图片 URL
   */
  async function getImageUrlByCode(downloadCode) {
    if (!downloadCode) {
      throw new Error('getImageUrlByCode requires downloadCode');
    }

    const accessToken = await authClient.getAccessToken();

    // 钉钉获取图片 URL 的 API
    const resp = await fetch(
      `https://oapi.dingtalk.com/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(downloadCode)}`,
      {
        method: 'GET',
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`get image url failed: ${resp.status} ${text}`);
    }

    // 检查是否返回了 JSON（可能是错误信息）
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      if (data?.errcode && data?.errcode !== 0) {
        throw new Error(`get image url failed: ${data.errmsg || JSON.stringify(data)}`);
      }
    }

    // 如果响应是图片，直接下载并转为 base64 data URL
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = contentType || 'image/jpeg';
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    logger.info('[mediaUploader] image converted to data URL', {
      downloadCode,
      size: buffer.length,
      mimeType,
    });

    return dataUrl;
  }

  async function uploadFromSource({
    source,
    fileName = '',
    mimeType = '',
    forceType = '',
  }) {
    const asset = await readSource(source, { fileName, mimeType });
    const uploadType = forceType || inferUploadType(asset.mimeType, asset.fileName);
    const accessToken = await authClient.getAccessToken();

    const form = new FormData();
    form.append('type', uploadType);
    form.append(
      'media',
      new Blob([asset.buffer], {
        type: asset.mimeType || 'application/octet-stream',
      }),
      asset.fileName
    );

    const resp = await fetch(
      `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        body: form,
      }
    );

    const data = await parseUploadResponse(resp);

    if (!resp.ok || Number(data?.errcode || 0) !== 0 || !data?.media_id) {
      throw new Error(
        `upload media failed: ${
          typeof data === 'string' ? data : JSON.stringify(data)
        }`
      );
    }

    logger.info('[mediaUploader] upload ok', {
      uploadType,
      fileName: asset.fileName,
      mediaId: data.media_id,
    });

    return {
      ...asset,
      uploadType,
      mediaId: data.media_id,
      createdAt: data.created_at,
    };
  }

  return {
    uploadFromSource,
    downloadByCode,
    getImageUrlByCode,
  };
}
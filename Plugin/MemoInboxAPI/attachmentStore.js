const fs = require('node:fs/promises');
const path = require('node:path');

const MIME_TO_EXTENSION = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
]);

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

async function storeAttachments({ memoId, inputs = [], runtimeContext, now = new Date() }) {
  const results = [];
  const memoImageSubdir = runtimeContext.memoImageSubdir || 'memo-inbox';

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const normalized = await normalizeAttachmentInput(input);
    const relativePath = buildRelativeImagePath({
      memoId,
      sequence: index + 1,
      extension: normalized.extension,
      now,
    });
    const absolutePath = path.join(runtimeContext.memoImageRootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, normalized.buffer);

    results.push({
      imageId: `${memoId}-${index + 1}`,
      url: buildImageUrl(runtimeContext.imageServerKey, memoImageSubdir, relativePath),
      mimeType: normalized.mimeType,
      relativePath: path.posix.join(memoImageSubdir, relativePath.replace(/\\/g, '/')),
    });
  }

  return results;
}

async function normalizeAttachmentInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('INVALID_ATTACHMENT_INPUT');
  }

  if (input.kind === 'buffer') {
    const mimeType = String(input.mimeType || '').toLowerCase();
    const extension = getExtensionForMimeType(mimeType);
    if (!Buffer.isBuffer(input.buffer)) {
      throw new Error('INVALID_BUFFER_IMAGE');
    }
    return {
      mimeType,
      extension,
      buffer: input.buffer,
    };
  }

  if (input.kind === 'base64') {
    return decodeBase64Image(input.value);
  }

  if (input.kind === 'url') {
    return downloadImage(input.value);
  }

  throw new Error('UNSUPPORTED_ATTACHMENT_KIND');
}

function decodeBase64Image(value) {
  const match = String(value || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error('INVALID_BASE64_IMAGE');
  }

  const mimeType = match[1].toLowerCase();
  const extension = getExtensionForMimeType(mimeType);
  const buffer = Buffer.from(match[2], 'base64');

  return { mimeType, extension, buffer };
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
    }

    const mimeTypeHeader = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const mimeType = normalizeMimeType(mimeTypeHeader, url);
    const extension = getExtensionForMimeType(mimeType);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('ATTACHMENT_TOO_LARGE');
    }

    return { mimeType, extension, buffer };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeMimeType(mimeType, url) {
  if (MIME_TO_EXTENSION.has(mimeType)) {
    return mimeType;
  }

  const urlExtension = path.extname(new URL(url).pathname).toLowerCase();
  for (const [candidateMimeType, extension] of MIME_TO_EXTENSION.entries()) {
    if (extension === urlExtension) {
      return candidateMimeType;
    }
  }

  throw new Error('UNSUPPORTED_IMAGE_TYPE');
}

function getExtensionForMimeType(mimeType) {
  const extension = MIME_TO_EXTENSION.get(mimeType);
  if (!extension) {
    throw new Error('UNSUPPORTED_IMAGE_TYPE');
  }
  return extension;
}

function buildRelativeImagePath({ memoId, sequence, extension, now }) {
  const date = now instanceof Date ? now : new Date(now);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return path.posix.join(year, month, day, `${memoId}-${sequence}${extension}`);
}

function buildImageUrl(imageServerKey, memoImageSubdir, relativePath) {
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const prefix = imageServerKey ? `/pw=${imageServerKey}` : '';
  return `${prefix}/images/${memoImageSubdir}/${normalizedRelativePath}`;
}

module.exports = {
  storeAttachments,
};

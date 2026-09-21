'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readMediaCandidateSource } = require('./richTextNormalizer');

const ERROR_MESSAGE = 'Telegram attachment operation failed.';
const TELEGRAM_DOWNLOAD_CEILING = 20_000_000;
const TELEGRAM_UPLOAD_CEILING = 50_000_000;
const SCOPE_PATTERN = /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*):[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MESSAGE_ID_PATTERN = /^[1-9]\d*$/;
const ERROR_SECRET_NAME = /^(?:config\.env(?:\..*)?|\.env(?:\..*)?|cookies?|login data|web data|history|.*\.pem|.*\.key)$/i;
const IMAGE_KEY_PATTERN = /^[^/\\\u0000-\u001f\u007f-\u009f]{1,256}$/;
const PORT_PATTERN = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const IMAGE_EXTENSIONS = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

class AttachmentBridgeError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'AttachmentBridgeError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AttachmentBridgeError);
  }
}

function fail(code) {
  throw new AttachmentBridgeError(code);
}

function readSafeTelegramError(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (!new Set(['TELEGRAM_ABORTED', 'TELEGRAM_RATE_LIMIT', 'TELEGRAM_AUTH',
      'TELEGRAM_FORBIDDEN', 'TELEGRAM_BAD_REQUEST', 'TELEGRAM_CONFLICT', 'TELEGRAM_SERVER',
      'TELEGRAM_TIMEOUT', 'TELEGRAM_NETWORK', 'TELEGRAM_INVALID_REQUEST',
      'TELEGRAM_INVALID_RESPONSE', 'TELEGRAM_REDIRECT_REJECTED']).has(code)) return null;
    const fields = { code };
    const delay = Object.getOwnPropertyDescriptor(error, 'retryAfterSec')?.value;
    if (code === 'TELEGRAM_RATE_LIMIT' && Number.isSafeInteger(delay) && delay >= 0 && delay <= 86_400) {
      fields.retryAfterSec = delay;
    }
    return Object.freeze(fields);
  } catch { return null; }
}

function failSend(error) {
  const fields = readSafeTelegramError(error);
  if (fields) throw Object.assign(new AttachmentBridgeError(fields.code), fields);
  fail('ATTACHMENT_OUTPUT_SEND_FAILED');
}

function hashScopeKey(scopeKey) {
  if (typeof scopeKey !== 'string' || !SCOPE_PATTERN.test(scopeKey)) fail('ATTACHMENT_INPUT_INVALID');
  return crypto.createHash('sha256').update('telegram-attachment-scope-v1\0').update(scopeKey)
    .digest('hex').slice(0, 32);
}

function normalizeDeclaredSize(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('ATTACHMENT_INPUT_INVALID');
  return value;
}

function normalizeDescriptor(kind, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('ATTACHMENT_INPUT_INVALID');
  let fileId;
  let fileUniqueId;
  let fileSize;
  let fileName;
  let mime;
  try {
    fileId = value.file_id;
    fileUniqueId = value.file_unique_id;
    fileSize = value.file_size;
    fileName = value.file_name;
    mime = value.mime_type;
  } catch {
    fail('ATTACHMENT_INPUT_INVALID');
  }
  if (
    typeof fileId !== 'string' || !ID_PATTERN.test(fileId)
    || typeof fileUniqueId !== 'string' || !ID_PATTERN.test(fileUniqueId)
  ) fail('ATTACHMENT_INPUT_INVALID');
  const defaults = {
    photo: ['photo.jpg', 'image/jpeg'],
    document: ['document.bin', 'application/octet-stream'],
    voice: ['voice.ogg', 'audio/ogg'],
    audio: ['audio.bin', 'application/octet-stream'],
    video: ['video.mp4', 'video/mp4'],
    animation: ['animation.gif', 'image/gif'],
  };
  return Object.freeze({
    kind,
    fileId,
    fileUniqueId,
    declaredSize: normalizeDeclaredSize(fileSize),
    fileName: typeof fileName === 'string' && fileName !== '' ? fileName : defaults[kind][0],
    mime: typeof mime === 'string' && mime !== '' ? mime.toLowerCase() : defaults[kind][1],
  });
}

function selectMessageAttachments(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    fail('ATTACHMENT_INPUT_INVALID');
  }
  const result = [];
  let photo;
  try { photo = message.photo; } catch { fail('ATTACHMENT_INPUT_INVALID'); }
  if (photo !== undefined) {
    if (!Array.isArray(photo) || photo.length === 0 || photo.length > 32) fail('ATTACHMENT_INPUT_INVALID');
    const selected = [...photo].sort((left, right) => {
      const leftSize = Number.isSafeInteger(left?.file_size) ? left.file_size : 0;
      const rightSize = Number.isSafeInteger(right?.file_size) ? right.file_size : 0;
      const leftArea = Number.isSafeInteger(left?.width) && Number.isSafeInteger(left?.height)
        ? left.width * left.height : 0;
      const rightArea = Number.isSafeInteger(right?.width) && Number.isSafeInteger(right?.height)
        ? right.width * right.height : 0;
      return (rightSize - leftSize) || (rightArea - leftArea);
    })[0];
    result.push(normalizeDescriptor('photo', selected));
  }
  for (const kind of ['document', 'voice', 'audio', 'video', 'animation']) {
    let value;
    try { value = message[kind]; } catch { fail('ATTACHMENT_INPUT_INVALID'); }
    if (value !== undefined) result.push(normalizeDescriptor(kind, value));
  }
  return Object.freeze(result);
}

function isContained(root, target, allowEqual = false) {
  const relative = path.relative(root, target);
  if (relative === '') return allowEqual;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function ensureSafeDirectory(root, target) {
  if (!isContained(root, target, false)) fail('ATTACHMENT_PATH_UNSAFE');
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') fail('ATTACHMENT_PATH_UNSAFE');
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch { fail('ATTACHMENT_PATH_UNSAFE'); }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ATTACHMENT_PATH_UNSAFE');
    const physical = fs.realpathSync.native(current);
    if (!isContained(root, physical, false)) fail('ATTACHMENT_PATH_UNSAFE');
  }
}

function sanitizeFilename(value) {
  if (typeof value !== 'string') fail('ATTACHMENT_INPUT_INVALID');
  let normalized;
  try { normalized = value.normalize('NFKC'); } catch { fail('ATTACHMENT_INPUT_INVALID'); }
  normalized = path.basename(normalized.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (normalized === '' || normalized === '.' || normalized === '..') normalized = 'file.bin';
  if (normalized.length > 120) normalized = normalized.slice(-120);
  return normalized;
}

function safeFilePath(value) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 1024
    || path.isAbsolute(value) || value.includes('\\')
  ) fail('ATTACHMENT_DOWNLOAD_FAILED');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('ATTACHMENT_DOWNLOAD_FAILED');
  }
  return value;
}

function detectMime(bytes) {
  const value = Buffer.from(bytes);
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
  if (value.subarray(0, 6).toString('ascii') === 'GIF87a' || value.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (value.length >= 12 && value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (value.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (value.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (value.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (value.length >= 12 && value.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}

function mimeCompatible(declared, detected) {
  const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
  const sniffRequired = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf', 'audio/ogg', 'audio/mpeg', 'video/mp4',
  ]);
  if (sniffRequired.has(normalized)) return normalized === detected;
  if (declared === 'application/octet-stream' || detected === 'application/octet-stream') return true;
  if (declared === detected) return true;
  return declared === 'image/jpg' && detected === 'image/jpeg';
}

function cleanupAttachmentDirectory(root, target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      return;
    }
    if (!stat.isDirectory()) return;
    const physical = fs.realpathSync.native(target);
    if (isContained(root, physical, false)) fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}

function createAttachmentBridge(options = {}) {
  let stateDir;
  let database;
  let telegramClient;
  let downloadStream;
  let maxInboundBytes;
  let maxOutboundBytes;
  let allowedOutputRoots;
  let imageRoot;
  let vcpImageKey;
  let vcpPort;
  let clock;
  let randomUUID;
  try {
    stateDir = options.stateDir;
    database = options.database;
    telegramClient = options.telegramClient;
    downloadStream = options.downloadStream;
    maxInboundBytes = options.maxInboundBytes;
    maxOutboundBytes = options.maxOutboundBytes;
    allowedOutputRoots = options.allowedOutputRoots;
    imageRoot = options.imageRoot;
    vcpImageKey = options.vcpImageKey;
    vcpPort = options.vcpPort;
    clock = options.clock ?? Date.now;
    randomUUID = options.randomUUID ?? crypto.randomUUID;
  } catch { fail('ATTACHMENT_CONFIG_INVALID'); }
  if (
    typeof stateDir !== 'string'
    || !database || typeof database.prepare !== 'function'
    || !telegramClient || typeof telegramClient.getFile !== 'function' || typeof telegramClient.sendDocument !== 'function'
    || (downloadStream !== undefined && typeof downloadStream !== 'function')
    || !Number.isSafeInteger(maxInboundBytes) || maxInboundBytes < 1 || maxInboundBytes > TELEGRAM_DOWNLOAD_CEILING
    || !Number.isSafeInteger(maxOutboundBytes) || maxOutboundBytes < 1 || maxOutboundBytes > TELEGRAM_UPLOAD_CEILING
    || !Array.isArray(allowedOutputRoots) || allowedOutputRoots.length === 0
    || typeof clock !== 'function' || typeof randomUUID !== 'function'
  ) fail('ATTACHMENT_CONFIG_INVALID');
  let physicalState;
  let physicalImageRoot = null;
  const outputRoots = [];
  try {
    physicalState = fs.realpathSync.native(path.resolve(stateDir));
    if (!fs.statSync(physicalState).isDirectory()) fail('ATTACHMENT_CONFIG_INVALID');
    for (const root of allowedOutputRoots) {
      if (typeof root !== 'string') fail('ATTACHMENT_CONFIG_INVALID');
      const lexical = path.resolve(root);
      const stat = fs.lstatSync(lexical);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ATTACHMENT_CONFIG_INVALID');
      outputRoots.push(fs.realpathSync.native(lexical));
    }
    const mediaConfigPresent = imageRoot !== undefined || vcpImageKey !== undefined || vcpPort !== undefined;
    if (mediaConfigPresent) {
      if (
        typeof imageRoot !== 'string'
        || typeof vcpImageKey !== 'string' || !IMAGE_KEY_PATTERN.test(vcpImageKey)
        || typeof vcpPort !== 'string' || !PORT_PATTERN.test(vcpPort)
      ) fail('ATTACHMENT_CONFIG_INVALID');
      const lexicalImageRoot = path.resolve(imageRoot);
      const imageStat = fs.lstatSync(lexicalImageRoot);
      if (imageStat.isSymbolicLink() || !imageStat.isDirectory()) fail('ATTACHMENT_CONFIG_INVALID');
      physicalImageRoot = fs.realpathSync.native(lexicalImageRoot);
    }
  } catch (error) {
    if (error instanceof AttachmentBridgeError) throw error;
    fail('ATTACHMENT_CONFIG_INVALID');
  }

  const source = downloadStream ?? (async function* bufferedDownload(filePath, control) {
    const bytes = await telegramClient.downloadFile(filePath, control);
    yield bytes;
  });

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('ATTACHMENT_CLOCK_INVALID');
    return value;
  }

  function nextAttachmentId() {
    const value = randomUUID();
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('ATTACHMENT_ID_INVALID');
    return value;
  }

  function safeImageRelativePath(rawPathname) {
    const rawSegments = rawPathname.split('/');
    if (rawSegments.length < 4 || rawSegments[0] !== '' || rawSegments[2] !== 'images') {
      fail('ATTACHMENT_VCP_IMAGE_DENIED');
    }
    let routeKey;
    try { routeKey = decodeURIComponent(rawSegments[1].slice(3)); }
    catch { fail('ATTACHMENT_VCP_IMAGE_DENIED'); }
    if (!rawSegments[1].startsWith('pw=') || !IMAGE_KEY_PATTERN.test(routeKey)) {
      fail('ATTACHMENT_VCP_IMAGE_DENIED');
    }
    const actual = Buffer.from(routeKey);
    const expected = Buffer.from(vcpImageKey);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      fail('ATTACHMENT_VCP_IMAGE_DENIED');
    }
    const decoded = [];
    for (const raw of rawSegments.slice(3)) {
      let segment;
      try { segment = decodeURIComponent(raw); } catch { fail('ATTACHMENT_VCP_IMAGE_DENIED'); }
      if (
        segment === '' || segment === '.' || segment === '..'
        || /[\\/%\u0000-\u001f\u007f-\u009f]/.test(segment)
      ) fail('ATTACHMENT_VCP_IMAGE_DENIED');
      decoded.push(segment);
    }
    if (decoded.length === 0) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    return decoded.join('/');
  }

  function inspectResolvedImage(relativePath, expected = null) {
    if (physicalImageRoot === null || typeof relativePath !== 'string' || relativePath.length > 1024) {
      fail('ATTACHMENT_VCP_IMAGE_DENIED');
    }
    const segments = relativePath.split('/');
    if (segments.some((segment) => (
      segment === '' || segment === '.' || segment === '..'
      || /[\\/%\u0000-\u001f\u007f-\u009f]/.test(segment)
    ))) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    const lexical = path.resolve(physicalImageRoot, ...segments);
    if (!isContained(physicalImageRoot, lexical, false)) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    let stat;
    let physical;
    try {
      let parent = physicalImageRoot;
      for (const segment of segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        const parentStat = fs.lstatSync(parent);
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      }
      if (segments.some(segment => ERROR_SECRET_NAME.test(segment)
          || /^(?:\.ssh|\.aws|\.git|chrome|chromium|edge|firefox|browser[-_ ]?profile|user data)$/i.test(segment))) {
        fail('ATTACHMENT_OUTPUT_SECRET_DENIED');
      }
      stat = fs.lstatSync(lexical);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      }
      physical = fs.realpathSync.native(lexical);
    } catch (error) {
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_OUTPUT_INVALID');
    }
    if (!isContained(physicalImageRoot, physical, false)) fail('ATTACHMENT_OUTPUT_ROOT_DENIED');
    if (stat.size > maxOutboundBytes || stat.size > TELEGRAM_UPLOAD_CEILING) {
      fail('ATTACHMENT_OUTPUT_TOO_LARGE');
    }
    const extension = path.extname(physical).toLowerCase();
    const expectedMime = IMAGE_EXTENSIONS[extension];
    if (!expectedMime) fail('ATTACHMENT_MIME_MISMATCH');
    let handle = null;
    try {
      handle = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(handle);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size
          || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      }
      const chunks = [];
      let size = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxOutboundBytes - size + 1));
        const count = fs.readSync(handle, chunk, 0, chunk.length, null);
        if (count === 0) break;
        size += count;
        if (size > maxOutboundBytes) fail('ATTACHMENT_OUTPUT_TOO_LARGE');
        chunks.push(chunk.subarray(0, count));
      }
      const after = fs.fstatSync(handle);
      const current = fs.lstatSync(lexical);
      if (after.size !== size || after.nlink !== 1 || after.ino !== current.ino
          || after.dev !== current.dev || current.isSymbolicLink()
          || stat.size !== size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
        fail('ATTACHMENT_OUTPUT_CHANGED');
      }
      const bytes = Buffer.concat(chunks, size);
      const mime = detectMime(bytes.subarray(0, 32));
      if (mime !== expectedMime) fail('ATTACHMENT_MIME_MISMATCH');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (expected && (
        expected.size !== bytes.length || expected.mime !== mime || expected.sha256 !== sha256
      )) fail('ATTACHMENT_OUTPUT_CHANGED');
      return { lexical, bytes, mime, size: bytes.length, sha256 };
    } catch (error) {
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_OUTPUT_READ_FAILED');
    } finally {
      if (handle !== null) try { fs.closeSync(handle); } catch { /* best effort */ }
    }
  }

  function resolveVcpImageCandidate(candidate) {
    if (physicalImageRoot === null) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    const source = readMediaCandidateSource(candidate);
    if (source === null) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    if (candidate?.sourceKind === 'vcp-relative') {
      const inspected = inspectResolvedImage(source);
      return Object.freeze({
        mediaKind: inspected.mime === 'image/gif' ? 'animation' : 'photo',
        relativePath: source, mime: inspected.mime, size: inspected.size,
        sha256: inspected.sha256, alt: candidate.alt,
      });
    }
    if (candidate?.sourceKind !== 'vcp-local') fail('ATTACHMENT_VCP_IMAGE_DENIED');
    let parsed;
    try { parsed = new URL(source); } catch { fail('ATTACHMENT_VCP_IMAGE_DENIED'); }
    if (
      parsed.protocol !== 'http:'
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
      || parsed.port !== vcpPort
      || parsed.username !== '' || parsed.password !== ''
      || parsed.search !== '' || parsed.hash !== ''
    ) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    const rawPathname = /^http:\/\/[^/?#]+(\/[^?#]*)/.exec(source)?.[1];
    if (!rawPathname) fail('ATTACHMENT_VCP_IMAGE_DENIED');
    const relativePath = safeImageRelativePath(rawPathname);
    const inspected = inspectResolvedImage(relativePath);
    return Object.freeze({
      mediaKind: inspected.mime === 'image/gif' ? 'animation' : 'photo',
      relativePath,
      mime: inspected.mime,
      size: inspected.size,
      sha256: inspected.sha256,
      alt: typeof candidate.alt === 'string' ? candidate.alt.slice(0, 160) : '',
    });
  }

  async function sendRichMedia(input = {}) {
    let chatId;
    let threadId;
    let media;
    let signal;
    let replyToMessageId;
    try {
      chatId = input.chatId;
      threadId = input.threadId ?? '0';
      media = input.media;
      signal = input.signal;
      replyToMessageId = input.replyToMessageId;
    } catch { fail('ATTACHMENT_INPUT_INVALID'); }
    if (
      typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId)
      || typeof threadId !== 'string' || !/^(?:0|[1-9]\d*)$/.test(threadId)
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || (replyToMessageId !== undefined && (typeof replyToMessageId !== 'string' || !MESSAGE_ID_PATTERN.test(replyToMessageId)))
      || media === null || typeof media !== 'object' || Array.isArray(media)
      || !['photo', 'animation'].includes(media.mediaKind)
      || typeof media.relativePath !== 'string'
      || typeof media.mime !== 'string'
      || !Number.isSafeInteger(media.size) || media.size < 1
      || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
    ) fail('ATTACHMENT_INPUT_INVALID');
    if (signal?.aborted) fail('ATTACHMENT_ABORTED');
    const inspected = inspectResolvedImage(media.relativePath, media);
    if (media.mediaKind !== (inspected.mime === 'image/gif' ? 'animation' : 'photo')) fail('ATTACHMENT_INPUT_INVALID');
    const sender = media.mediaKind === 'animation'
      ? telegramClient.sendAnimation : telegramClient.sendPhoto;
    if (typeof sender !== 'function') fail('ATTACHMENT_CONFIG_INVALID');
    let response;
    try {
      response = await sender.call(telegramClient, {
        chat_id: chatId,
        message_thread_id: threadId,
        ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId } }),
      }, new Blob([inspected.bytes], { type: inspected.mime }), path.basename(media.relativePath), { signal });
    } catch (error) { failSend(error); }
    const rawMessageId = response?.message_id;
    const messageId = typeof rawMessageId === 'number' ? String(rawMessageId) : rawMessageId;
    if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) {
      fail('ATTACHMENT_OUTPUT_RESPONSE_INVALID');
    }
    return Object.freeze({ messageId });
  }

  async function ingestAttachment(input = {}) {
    let scopeKey;
    let requestId;
    let telegramMessageId;
    let descriptor;
    let signal;
    try {
      scopeKey = input.scopeKey;
      requestId = input.requestId ?? null;
      telegramMessageId = input.telegramMessageId ?? null;
      descriptor = input.descriptor;
      signal = input.signal;
    } catch { fail('ATTACHMENT_INPUT_INVALID'); }
    if (
      typeof scopeKey !== 'string' || !SCOPE_PATTERN.test(scopeKey)
      || (requestId !== null && (typeof requestId !== 'string' || !ID_PATTERN.test(requestId)))
      || (telegramMessageId !== null && (typeof telegramMessageId !== 'string' || !MESSAGE_ID_PATTERN.test(telegramMessageId)))
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    ) fail('ATTACHMENT_INPUT_INVALID');
    let normalized;
    try {
      normalized = Object.freeze({
        kind: descriptor.kind,
        fileId: descriptor.fileId,
        fileUniqueId: descriptor.fileUniqueId,
        declaredSize: normalizeDeclaredSize(descriptor.declaredSize),
        fileName: descriptor.fileName,
        mime: descriptor.mime,
      });
    } catch { fail('ATTACHMENT_INPUT_INVALID'); }
    if (
      typeof normalized.kind !== 'string'
      || typeof normalized.fileId !== 'string' || !ID_PATTERN.test(normalized.fileId)
      || typeof normalized.fileUniqueId !== 'string' || !ID_PATTERN.test(normalized.fileUniqueId)
      || typeof normalized.fileName !== 'string'
      || typeof normalized.mime !== 'string' || normalized.mime.length > 255
    ) fail('ATTACHMENT_INPUT_INVALID');
    if (normalized.declaredSize !== null && normalized.declaredSize > maxInboundBytes) {
      fail('ATTACHMENT_DECLARED_TOO_LARGE');
    }

    const attachmentId = nextAttachmentId();
    const scopeHash = hashScopeKey(scopeKey);
    const attachmentDir = path.join(physicalState, 'inbox', scopeHash, attachmentId);
    ensureSafeDirectory(physicalState, attachmentDir);
    const fileName = `${attachmentId}-${sanitizeFilename(normalized.fileName)}`;
    const absolutePath = path.join(attachmentDir, fileName);
    let handle = null;
    try {
      let telegramFile;
      try { telegramFile = await telegramClient.getFile(normalized.fileId, { signal }); }
      catch { fail('ATTACHMENT_DOWNLOAD_FAILED'); }
      const filePath = safeFilePath(telegramFile?.file_path);
      ensureSafeDirectory(physicalState, attachmentDir);
      handle = fs.openSync(absolutePath, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let size = 0;
      const magic = [];
      try {
        for await (const chunk of source(filePath, { signal, maxBytes: maxInboundBytes })) {
          if (signal?.aborted) fail('ATTACHMENT_ABORTED');
          if (!(chunk instanceof Uint8Array)) fail('ATTACHMENT_DOWNLOAD_FAILED');
          size += chunk.byteLength;
          if (size > maxInboundBytes || size > TELEGRAM_DOWNLOAD_CEILING) {
            fail('ATTACHMENT_STREAM_TOO_LARGE');
          }
          const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (magic.reduce((total, part) => total + part.length, 0) < 32) {
            const remaining = 32 - magic.reduce((total, part) => total + part.length, 0);
            magic.push(buffer.subarray(0, remaining));
          }
          hash.update(buffer);
          fs.writeSync(handle, buffer);
        }
      } catch (error) {
        if (error instanceof AttachmentBridgeError) throw error;
        fail('ATTACHMENT_DOWNLOAD_FAILED');
      }
      fs.closeSync(handle);
      handle = null;
      const storedStat = fs.lstatSync(absolutePath);
      const storedPhysical = fs.realpathSync.native(absolutePath);
      if (
        storedStat.isSymbolicLink() || !storedStat.isFile() || storedStat.nlink !== 1
        || !isContained(physicalState, storedPhysical, false)
      ) fail('ATTACHMENT_PATH_UNSAFE');
      const detectedMime = detectMime(Buffer.concat(magic));
      if (!mimeCompatible(normalized.mime.toLowerCase(), detectedMime)) fail('ATTACHMENT_MIME_MISMATCH');
      const timestamp = now();
      const relativePath = path.relative(physicalState, absolutePath).split(path.sep).join('/');
      database.prepare(`
        INSERT INTO attachments (
          attachment_id, scope_key, request_id, telegram_message_id,
          telegram_file_id, telegram_file_unique_id, relative_path, mime,
          size, sha256, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `).run(
        attachmentId, scopeKey, requestId, telegramMessageId,
        normalized.fileId, normalized.fileUniqueId, relativePath,
        detectedMime === 'application/octet-stream' ? normalized.mime.toLowerCase() : detectedMime,
        size, hash.digest('hex'), timestamp, timestamp,
      );
      const row = database.prepare('SELECT mime, size, sha256 FROM attachments WHERE attachment_id = ?')
        .get(attachmentId);
      return Object.freeze({
        attachmentId,
        scopeHash,
        absolutePath,
        relativePath,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
      });
    } catch (error) {
      if (handle !== null) try { fs.closeSync(handle); } catch { /* best effort */ }
      cleanupAttachmentDirectory(physicalState, attachmentDir);
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_WRITE_FAILED');
    }
  }

  async function ingestMessage(input = {}) {
    const descriptors = selectMessageAttachments(input.message);
    const results = [];
    for (const descriptor of descriptors) {
      results.push(await ingestAttachment({
        scopeKey: input.scopeKey,
        requestId: input.requestId ?? null,
        telegramMessageId: input.telegramMessageId ?? null,
        descriptor,
        signal: input.signal,
      }));
    }
    return Object.freeze(results);
  }

  async function uploadResult(input = {}) {
    let chatId;
    let threadId;
    let filePath;
    let caption;
    try {
      chatId = input.chatId;
      threadId = input.threadId ?? '0';
      filePath = input.filePath;
      caption = input.caption;
    } catch { fail('ATTACHMENT_INPUT_INVALID'); }
    if (
      typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId)
      || typeof threadId !== 'string' || !/^(?:0|[1-9]\d*)$/.test(threadId)
      || typeof filePath !== 'string'
      || (caption !== undefined && (typeof caption !== 'string' || caption.length > 1024))
    ) fail('ATTACHMENT_INPUT_INVALID');
    const lexical = path.resolve(filePath);
    let stat;
    let physical;
    try {
      stat = fs.lstatSync(lexical);
      if (stat.isSymbolicLink()) fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      if (!stat.isFile() || stat.nlink !== 1) fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      physical = fs.realpathSync.native(lexical);
    } catch (error) {
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_OUTPUT_INVALID');
    }
    if (!outputRoots.some((root) => isContained(root, physical, false))) {
      fail('ATTACHMENT_OUTPUT_ROOT_DENIED');
    }
    const fileName = path.basename(physical);
    if (ERROR_SECRET_NAME.test(fileName) || /(?:^|[\\/])(?:chrome|chromium|edge|firefox)[\\/]/i.test(physical)) {
      fail('ATTACHMENT_OUTPUT_SECRET_DENIED');
    }
    if (stat.size > maxOutboundBytes || stat.size > TELEGRAM_UPLOAD_CEILING) {
      fail('ATTACHMENT_OUTPUT_TOO_LARGE');
    }
    let blob;
    let fileHandle = null;
    try {
      const noFollow = fs.constants.O_NOFOLLOW ?? 0;
      fileHandle = fs.openSync(lexical, fs.constants.O_RDONLY | noFollow);
      const openedStat = fs.fstatSync(fileHandle);
      if (!openedStat.isFile() || openedStat.nlink !== 1 || openedStat.size !== stat.size) {
        fail('ATTACHMENT_OUTPUT_LINK_DENIED');
      }
      blob = new Blob([fs.readFileSync(fileHandle)], { type: 'application/octet-stream' });
      if (blob.size > maxOutboundBytes || blob.size > TELEGRAM_UPLOAD_CEILING) {
        fail('ATTACHMENT_OUTPUT_TOO_LARGE');
      }
    } catch (error) {
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_OUTPUT_READ_FAILED');
    } finally {
      if (fileHandle !== null) try { fs.closeSync(fileHandle); } catch { /* best effort */ }
    }
    let response;
    try {
      response = await telegramClient.sendDocument({
        chat_id: chatId,
        message_thread_id: threadId,
        ...(caption === undefined ? {} : { caption }),
      }, blob, fileName);
    } catch (error) { failSend(error); }
    const rawMessageId = response?.message_id;
    if (typeof rawMessageId === 'number' && (!Number.isSafeInteger(rawMessageId) || rawMessageId < 1)) {
      fail('ATTACHMENT_OUTPUT_RESPONSE_INVALID');
    }
    const messageId = typeof rawMessageId === 'number' ? String(rawMessageId) : rawMessageId;
    if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) {
      fail('ATTACHMENT_OUTPUT_RESPONSE_INVALID');
    }
    return Object.freeze({ messageId, fileName, size: stat.size });
  }

  return Object.freeze({
    ingestAttachment,
    ingestMessage,
    resolveVcpImageCandidate,
    sendRichMedia,
    uploadResult,
  });
}

function createMediaGroupCollector(options = {}) {
  const maxItems = options.maxItems;
  const settleMs = options.settleMs;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const onAlbum = options.onAlbum;
  if (
    !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100
    || !Number.isSafeInteger(settleMs) || settleMs < 1 || settleMs > 60_000
    || typeof clock !== 'function' || typeof sleep !== 'function' || typeof onAlbum !== 'function'
  ) fail('ATTACHMENT_CONFIG_INVALID');
  const groups = new Map();
  const completed = new Map();

  function snapshotMessage(message) {
    try {
      const serialized = JSON.stringify(message);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 1_048_576) {
        fail('ATTACHMENT_INPUT_INVALID');
      }
      const value = JSON.parse(serialized);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('ATTACHMENT_INPUT_INVALID');
      }
      return Object.freeze(value);
    } catch (error) {
      if (error instanceof AttachmentBridgeError) throw error;
      fail('ATTACHMENT_INPUT_INVALID');
    }
  }

  function attachmentCount(message) {
    let count = Array.isArray(message.photo) && message.photo.length > 0 ? 1 : 0;
    for (const key of ['document', 'voice', 'audio', 'video', 'animation']) if (message[key]) count += 1;
    return count;
  }

  function add(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return Promise.reject(new AttachmentBridgeError('ATTACHMENT_INPUT_INVALID'));
    }
    let safeMessage;
    try { safeMessage = snapshotMessage(message); }
    catch (error) { return Promise.reject(error); }
    const groupId = safeMessage.media_group_id;
    if (typeof groupId !== 'string' || !ID_PATTERN.test(groupId)) {
      return Promise.resolve().then(() => onAlbum(Object.freeze([safeMessage])));
    }
    if (attachmentCount(safeMessage) > maxItems) {
      return Promise.reject(new AttachmentBridgeError('ATTACHMENT_ALBUM_LIMIT'));
    }
    if (completed.has(groupId)) return Promise.resolve(completed.get(groupId));
    let group = groups.get(groupId);
    if (!group) {
      group = { messages: new Map(), itemCount: 0, promise: null, sealed: false };
      groups.set(groupId, group);
      group.promise = (async () => {
        await sleep(settleMs);
        group.sealed = true;
        const ordered = [...group.messages.values()].sort((left, right) => (
          BigInt(left.message_id) < BigInt(right.message_id) ? -1 : 1
        ));
        try {
          const result = await onAlbum(Object.freeze(ordered));
          completed.set(groupId, result);
          while (completed.size > 1000) completed.delete(completed.keys().next().value);
          return result;
        } finally {
          groups.delete(groupId);
        }
      })();
      group.promise.catch(() => {});
    }
    if (group.sealed) return group.promise;
    const messageId = safeMessage.message_id;
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      return Promise.reject(new AttachmentBridgeError('ATTACHMENT_INPUT_INVALID'));
    }
    if (!group.messages.has(String(messageId))) {
      const count = attachmentCount(safeMessage);
      if (group.itemCount + count > maxItems) {
        return Promise.reject(new AttachmentBridgeError('ATTACHMENT_ALBUM_LIMIT'));
      }
      group.itemCount += count;
      group.messages.set(String(messageId), safeMessage);
    }
    return group.promise;
  }

  function snapshot() {
    return Object.freeze({ pendingGroups: groups.size, completedGroups: completed.size });
  }
  return Object.freeze({ add, snapshot });
}

module.exports = Object.freeze({
  AttachmentBridgeError,
  createAttachmentBridge,
  createMediaGroupCollector,
  hashScopeKey,
  selectMessageAttachments,
  readSafeTelegramError,
});

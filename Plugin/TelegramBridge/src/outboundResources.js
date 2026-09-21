'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { readMediaCandidateSource, decodedUrlRepresentations } = require('./richTextNormalizer');
const { readSafeTelegramError } = require('./attachmentBridge');

const DEFAULT_MAX_BYTES = 45 * 1024 * 1024;
const SECRET_SEGMENT = /^(?:\.env(?:\..*)?|\.(?:ssh|aws|azure|gcloud|config|git|gnupg|mozilla|kube|docker|npmrc|netrc|codex)|config(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:key|pem|p12|pfx|keystore)|cookies?(?:\..*)?|login data|web data|local state|history|chrome|chromium|edge|firefox|brave|user data|profiles?(?:[ ._-].*)?|browser[-_ ]?profiles?)(?:$)/i;
const TYPES = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/gzip': '.gz',
  'text/plain': '.txt', 'text/csv': '.csv', 'text/markdown': '.md', 'application/json': '.json',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
});
const EXTENSIONS = Object.freeze({
  ...Object.fromEntries(Object.entries(TYPES).map(([mime, extension]) => [extension, mime])),
  '.jpeg': 'image/jpeg',
});
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

class OutboundResourceError extends Error {
  constructor(code) {
    super('Telegram outbound resource operation failed.');
    Object.defineProperty(this, 'name', { value: 'OutboundResourceError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, OutboundResourceError);
  }
}
function fail(code) { throw new OutboundResourceError(code); }
function contained(root, target, equal = false) {
  const relative = path.relative(root, target);
  return (equal && relative === '') || (relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// Inspect every ancestor, including the configured root: realpath alone would
// accept a junction pointing at another allowed directory.
function inspectPath(target, file = false) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  const segments = absolute.slice(current.length).split(path.sep).filter(Boolean);
  let stat;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('OUTBOUND_LINK_DENIED');
    const lastFile = file && i === segments.length - 1;
    if (lastFile ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) fail('OUTBOUND_LINK_DENIED');
  }
  if (!stat) fail('OUTBOUND_PATH_DENIED');
  return stat;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Linux has no built-in Node openat binding. procfs descriptor paths provide
// equivalent directory anchoring; O_NOFOLLOW applies to each opened component.
function openLinuxDirectory(target) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let handle = fs.openSync('/', flags);
  try {
    for (const segment of path.resolve(target).split('/').filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${handle}/${segment}`, flags);
      fs.closeSync(handle);
      handle = next;
    }
    return handle;
  } catch (error) {
    fs.closeSync(handle);
    throw error;
  }
}

function safeSegments(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) fail('OUTBOUND_PATH_DENIED');
  return value.split('/').map(raw => {
    let segment;
    try { segment = decodeURIComponent(raw); } catch { fail('OUTBOUND_PATH_DENIED'); }
    if (!segment || segment === '.' || segment === '..'
        || /[\\/%:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(segment)
        || /[. ]$/.test(segment) || SECRET_SEGMENT.test(segment.normalize('NFKC'))
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('OUTBOUND_PATH_DENIED');
    return segment;
  });
}

function rawPathname(source) {
  // URL normalizes ../ before callers can inspect it, so retain the raw path.
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(source);
  if (!match || /[\\\s\u0000-\u001f\u007f]/.test(source)) fail('OUTBOUND_URL_DENIED');
  return match[1] ?? '/';
}

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0
        || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  // Only native global unicast, excluding documentation and transition ranges.
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [first, second = '0'] = normalized.split(':').map(part => Number.parseInt(part || '0', 16));
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

function normalizedMime(value) {
  if (typeof value !== 'string') fail('OUTBOUND_MIME_DENIED');
  const mime = value.split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'application/x-zip-compressed') return 'application/zip';
  if (mime === 'audio/x-wav') return 'audio/wav';
  return mime;
}

function sniff(bytes, hint) {
  const start = bytes.subarray(0, 16);
  if (bytes.length >= 8 && start.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && start[0] === 255 && start[1] === 216 && start[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(start.toString('ascii'))) return 'image/gif';
  if (start.toString('ascii', 0, 4) === 'RIFF') {
    if (start.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (start.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  }
  if (start.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (start.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (start.toString('ascii', 0, 3) === 'ID3' || (start[0] === 255 && (start[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (start.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (start[0] === 31 && start[1] === 139) return 'application/gzip';
  if (start[0] === 80 && start[1] === 75 && [0x0403, 0x0605, 0x0807].includes(start.readUInt16LE(2))) {
    const office = {
      '.docx': 'word/', '.xlsx': 'xl/', '.pptx': 'ppt/',
    };
    const extension = TYPES[hint];
    if (office[extension] && bytes.includes(Buffer.from('[Content_Types].xml'))
        && bytes.includes(Buffer.from(office[extension]))) return hint;
    return 'application/zip';
  }
  if (TEXT_TYPES.has(hint)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('OUTBOUND_MIME_DENIED'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
        || /^\s*(?:<!doctype\s+html|<html|<svg|<script|<\?xml)/i.test(text)) fail('OUTBOUND_MIME_DENIED');
    if (hint === 'application/json') {
      try { JSON.parse(text); } catch { fail('OUTBOUND_MIME_DENIED'); }
    }
    return hint;
  }
  fail('OUTBOUND_MIME_DENIED');
}

function validateMime(bytes, extension, declared, imageOnly = false) {
  if (bytes.length === 0) fail('OUTBOUND_EMPTY');
  const extensionMime = EXTENSIONS[extension.toLowerCase()];
  const declaredMime = declared === undefined ? undefined : normalizedMime(declared);
  if (declaredMime !== undefined && declaredMime !== 'application/octet-stream'
      && !Object.hasOwn(TYPES, declaredMime)) fail('OUTBOUND_MIME_DENIED');
  const mime = sniff(bytes, extensionMime ?? declaredMime);
  if ((extensionMime && extensionMime !== mime)
      || (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== mime)
      || (imageOnly && !mime.startsWith('image/'))) fail('OUTBOUND_MIME_DENIED');
  return mime;
}

function mediaKind(mime) {
  if (mime === 'image/gif') return 'animation';
  return mime.startsWith('image/') ? 'photo' : 'document';
}

function createOutboundResources(options = {}) {
  let stateDir, imageRoot, roots, vcpFileRoot, maxBytes, timeoutMs, maxRedirects, lookup, request;
  let telegramClient, attachmentBridge, vcpPort, vcpFileKey, vcpImageKey;
  let stateIdentity, allowPortableStaging;
  try {
    ({ telegramClient, attachmentBridge, vcpPort, vcpFileKey, vcpImageKey } = options);
    maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    timeoutMs = options.timeoutMs ?? 30_000;
    maxRedirects = options.maxRedirects ?? 3;
    lookup = options.lookup ?? dns.lookup;
    request = options.request ?? https.request;
    allowPortableStaging = options.allowPortableStaging ?? false;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
        || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5
        || typeof lookup !== 'function' || typeof request !== 'function' || typeof allowPortableStaging !== 'boolean'
        || !telegramClient || typeof telegramClient.sendDocument !== 'function'
        || typeof options.stateDir !== 'string' || !path.isAbsolute(options.stateDir)
        || !Array.isArray(options.allowedOutputRoots)) fail('OUTBOUND_CONFIG_INVALID');
    const directory = value => {
      if (typeof value !== 'string' || !path.isAbsolute(value)) fail('OUTBOUND_CONFIG_INVALID');
      inspectPath(value);
      return fs.realpathSync.native(value);
    };
    stateDir = directory(options.stateDir);
    stateIdentity = inspectPath(stateDir);
    imageRoot = options.imageRoot === undefined ? null : directory(options.imageRoot);
    roots = [...new Set(options.allowedOutputRoots.map(directory))];
    vcpFileRoot = options.vcpFileRoot === undefined ? null : directory(options.vcpFileRoot);
    if (vcpFileRoot && !roots.some(root => contained(root, vcpFileRoot, true))) fail('OUTBOUND_CONFIG_INVALID');
    if (vcpPort !== undefined && !/^[1-9]\d{0,4}$/.test(String(vcpPort))) fail('OUTBOUND_CONFIG_INVALID');
    if (vcpPort !== undefined && Number(vcpPort) > 65535) fail('OUTBOUND_CONFIG_INVALID');
    vcpPort = vcpPort === undefined ? null : String(vcpPort);
    for (const key of [vcpFileKey, vcpImageKey]) {
      if (key !== undefined && (typeof key !== 'string' || !/^[^/\\\s\u0000-\u001f\u007f]{1,256}$/.test(key))) fail('OUTBOUND_CONFIG_INVALID');
    }
    if (attachmentBridge !== undefined && (!attachmentBridge
        || typeof attachmentBridge.resolveVcpImageCandidate !== 'function'
        || typeof attachmentBridge.sendRichMedia !== 'function')) fail('OUTBOUND_CONFIG_INVALID');
  } catch { fail('OUTBOUND_CONFIG_INVALID'); }
  const outbox = path.join(stateDir, 'outbox');

  function checkAbort(signal) {
    if (signal?.aborted) fail(signal.reason === 'OUTBOUND_TIMEOUT' ? 'OUTBOUND_TIMEOUT' : 'OUTBOUND_ABORTED');
  }

  async function controlled(signal, action) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('OUTBOUND_INPUT_INVALID');
    const controller = new AbortController();
    const cancel = () => controller.abort('OUTBOUND_ABORTED');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort('OUTBOUND_TIMEOUT'), timeoutMs);
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(new OutboundResourceError(controller.signal.reason));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      checkAbort(controller.signal);
      return await Promise.race([Promise.resolve().then(() => action(controller.signal)), stopped]);
    } catch (error) {
      checkAbort(controller.signal);
      if (error instanceof OutboundResourceError) throw error;
      fail('OUTBOUND_RESOURCE_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  function readLocal(target, allowedRoots) {
    if (!allowedRoots.some(root => contained(root, target))) fail('OUTBOUND_ROOT_DENIED');
    // Deny sensitive components even when the allowlist is accidentally broad.
    safeSegments(path.resolve(target).slice(path.parse(target).root.length).split(path.sep).join('/'));
    const before = inspectPath(target, true);
    if (before.size > maxBytes) fail('OUTBOUND_TOO_LARGE');
    let handle;
    try {
      handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(handle);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) fail('OUTBOUND_LINK_DENIED');
      const chunks = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
        const count = fs.readSync(handle, buffer, 0, buffer.length, null);
        if (count === 0) break;
        size += count;
        if (size > maxBytes) fail('OUTBOUND_TOO_LARGE');
        chunks.push(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(handle);
      const current = inspectPath(target, true);
      if (after.dev !== current.dev || after.ino !== current.ino || after.nlink !== 1
          || after.size !== size || before.size !== size || before.mtimeMs !== after.mtimeMs
          || before.ctimeMs !== after.ctimeMs) fail('OUTBOUND_CHANGED');
      return Buffer.concat(chunks, size);
    } finally { if (handle !== undefined) fs.closeSync(handle); }
  }

  function localTarget(source, candidate) {
    const rawPath = rawPathname(source);
    const url = new URL(source);
    if (url.username || url.password || url.search || url.hash) fail('OUTBOUND_URL_DENIED');
    if (candidate.sourceKind === 'file-local') {
      if (url.protocol !== 'file:' || url.hostname) fail('OUTBOUND_URL_DENIED');
      safeSegments(rawPath.replace(/^\/(?:[a-z]:\/)?/i, ''));
      return fileURLToPath(url);
    }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || !vcpPort || (url.port || '80') !== vcpPort) fail('OUTBOUND_URL_DENIED');
    const match = /^\/pw=([^/]+)\/(files|images)\/(.+)$/.exec(rawPath);
    const image = candidate.kind === 'image';
    if (!match || match[2] !== (image ? 'images' : 'files')) fail('OUTBOUND_URL_DENIED');
    const expectedKey = image ? vcpImageKey : vcpFileKey;
    const actualKey = Buffer.from(decodeURIComponent(match[1]));
    const expected = Buffer.from(expectedKey ?? '');
    if (!expected.length || actualKey.length !== expected.length || !crypto.timingSafeEqual(actualKey, expected)) fail('OUTBOUND_URL_DENIED');
    const segments = safeSegments(match[3]);
    if (image) {
      if (!imageRoot) fail('OUTBOUND_ROOT_DENIED');
      return path.join(imageRoot, ...segments);
    }
    if (vcpFileRoot) return path.join(vcpFileRoot, ...segments);
    const candidates = roots.map(root => path.join(root, ...segments)).filter(target => fs.existsSync(target));
    if (candidates.length !== 1) fail('OUTBOUND_ROOT_DENIED');
    return candidates[0];
  }

  function publicUrl(source) {
    rawPathname(source);
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
        || (url.port !== '' && url.port !== '443')) fail('OUTBOUND_URL_DENIED');
    const representations = decodedUrlRepresentations(source);
    if (representations === null) fail('OUTBOUND_URL_DENIED');
    for (const decoded of representations) {
      for (const key of [vcpFileKey, vcpImageKey]) {
        if (key && (decodedUrlRepresentations(key) ?? [key]).some(value => decoded.includes(value))) fail('OUTBOUND_URL_DENIED');
      }
      if (/\/pw=/i.test(decoded)) fail('OUTBOUND_URL_DENIED');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(host)) {
      if (!publicAddress(host)) fail('OUTBOUND_HOST_DENIED');
    } else if (!host.includes('.') || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(host)) fail('OUTBOUND_HOST_DENIED');
    return { url, host };
  }

  async function download(source, imageOnly, signal) {
    let current = source;
    for (let hop = 0; ; hop++) {
      checkAbort(signal);
      const { url, host } = publicUrl(current);
      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
        : await lookup(host, { all: true, verbatim: true, signal });
      checkAbort(signal);
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64
          || addresses.some(value => !value || !publicAddress(value.address) || net.isIP(value.address) !== value.family)) fail('OUTBOUND_HOST_DENIED');
      const pin = addresses.find(value => value.family === 4) ?? addresses[0];
      let req, response;
      const cancel = () => {
        response?.destroy();
        req?.destroy();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        response = await new Promise((resolve, reject) => {
          req = request(url, {
            method: 'GET', agent: false, rejectUnauthorized: true,
            servername: net.isIP(host) ? '' : host,
            headers: { accept: '*/*', 'accept-encoding': 'identity' },
            maxHeaderSize: 16 * 1024,
            lookup: (hostname, options, callback) => {
              if (hostname.replace(/^\[|\]$/g, '') !== host) return callback(new OutboundResourceError('OUTBOUND_HOST_DENIED'));
              return options?.all ? callback(null, [{ ...pin }]) : callback(null, pin.address, pin.family);
            },
          }, resolve);
          req.on('error', reject);
          req.end();
        });
        checkAbort(signal);
        let peer = response.socket?.remoteAddress;
        if (typeof peer === 'string' && peer.startsWith('::ffff:') && net.isIP(peer.slice(7)) === 4) peer = peer.slice(7);
        if (peer !== pin.address) fail('OUTBOUND_HOST_DENIED');
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (hop >= maxRedirects) fail('OUTBOUND_REDIRECT_LIMIT');
          const location = response.headers.location;
          if (typeof location !== 'string' || location.length > 4096 || /[\\\s\u0000-\u001f]/.test(location)) fail('OUTBOUND_URL_DENIED');
          current = new URL(location, url).href;
          continue;
        }
        if (response.statusCode !== 200) fail('OUTBOUND_HTTP_FAILED');
        const encoding = response.headers['content-encoding'];
        if (encoding !== undefined && encoding !== 'identity') fail('OUTBOUND_ENCODING_DENIED');
        const declared = normalizedMime(response.headers['content-type']);
        if (!Object.hasOwn(TYPES, declared) && declared !== 'application/octet-stream') fail('OUTBOUND_MIME_DENIED');
        const declaredSize = response.headers['content-length'];
        if (declaredSize !== undefined && (typeof declaredSize !== 'string' || !/^\d+$/.test(declaredSize)
          || !Number.isSafeInteger(Number(declaredSize)) || Number(declaredSize) > maxBytes)) fail('OUTBOUND_TOO_LARGE');
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          checkAbort(signal);
          if (!(chunk instanceof Uint8Array)) fail('OUTBOUND_RESOURCE_FAILED');
          size += chunk.byteLength;
          if (size > maxBytes) fail('OUTBOUND_TOO_LARGE');
          chunks.push(Buffer.from(chunk));
        }
        if (declaredSize !== undefined && Number(declaredSize) !== size) fail('OUTBOUND_SIZE_MISMATCH');
        const bytes = Buffer.concat(chunks, size);
        const mime = validateMime(bytes, path.posix.extname(url.pathname), declared, imageOnly);
        return { bytes, mime };
      } finally {
        signal.removeEventListener('abort', cancel);
        response?.destroy();
        req?.destroy();
      }
    }
  }

  function stage(bytes, mime, alt, signal) {
    checkAbort(signal);
    const anchored = process.platform === 'linux';
    // Portable Node cannot prevent a parent reparse-point swap on Windows.
    // Production fails closed; only trusted temporary fixtures may opt in.
    if (!anchored && !allowPortableStaging) fail('OUTBOUND_STAGING_UNSUPPORTED');
    let stateHandle, directoryHandle, handle, target, createdIdentity;
    let directoryIdentity;
    const validateDirectories = () => {
      if (!sameFile(stateIdentity, inspectPath(stateDir))
          || !sameFile(directoryIdentity, inspectPath(outbox))) fail('OUTBOUND_CHANGED');
    };
    try {
      if (anchored) {
        stateHandle = openLinuxDirectory(stateDir);
        if (!sameFile(stateIdentity, fs.fstatSync(stateHandle))) fail('OUTBOUND_CHANGED');
        const child = `/proc/self/fd/${stateHandle}/outbox`;
        try { fs.mkdirSync(child, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const before = fs.lstatSync(child);
        if (before.isSymbolicLink() || !before.isDirectory()) fail('OUTBOUND_LINK_DENIED');
        directoryHandle = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        directoryIdentity = fs.fstatSync(directoryHandle);
        if (!sameFile(before, directoryIdentity)) fail('OUTBOUND_CHANGED');
      } else {
        if (!sameFile(stateIdentity, inspectPath(stateDir))) fail('OUTBOUND_CHANGED');
        try { fs.mkdirSync(outbox, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        directoryIdentity = inspectPath(outbox);
      }
      const relativePath = crypto.randomBytes(16).toString('hex') + TYPES[mime];
      target = anchored ? `/proc/self/fd/${directoryHandle}/${relativePath}` : path.join(outbox, relativePath);
      handle = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      createdIdentity = fs.fstatSync(handle);
      if (!createdIdentity.isFile() || createdIdentity.nlink !== 1) fail('OUTBOUND_LINK_DENIED');
      validateDirectories();
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
      const verified = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < verified.length) {
        const count = fs.readSync(handle, verified, offset, verified.length - offset, offset);
        if (count === 0) fail('OUTBOUND_CHANGED');
        offset += count;
      }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const stored = fs.fstatSync(handle);
      const named = fs.lstatSync(target);
      if (!sameFile(stored, named) || named.isSymbolicLink() || stored.nlink !== 1
          || stored.size !== bytes.length
          || crypto.createHash('sha256').update(verified).digest('hex') !== sha256) fail('OUTBOUND_CHANGED');
      validateDirectories();
      if (anchored) fs.fsyncSync(directoryHandle);
      return Object.freeze({ mediaKind: mediaKind(mime), relativePath, mime,
        size: bytes.length, sha256, alt, storageRoot: 'outbox' });
    } catch (error) {
      if (createdIdentity) {
        try {
          if (!anchored) validateDirectories();
          if (sameFile(createdIdentity, fs.lstatSync(target))) fs.unlinkSync(target);
        } catch { /* Never follow a substituted cleanup path. */ }
      }
      throw error;
    } finally {
      for (const descriptor of [handle, directoryHandle, stateHandle]) {
        if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* best effort */ }
      }
    }
  }

  // Persistent descriptors contain no source identity. Only candidates created
  // in this process by the normalizer can authorize a fresh resolve.
  async function resolve(candidate, control = {}) {
    return controlled(control.signal, async signal => {
      const source = readMediaCandidateSource(candidate);
      if (source === null || !['file', 'image'].includes(candidate.kind)) fail('OUTBOUND_INPUT_INVALID');
      const oldImage = candidate.kind === 'image' && ['vcp-local', 'vcp-relative'].includes(candidate.sourceKind);
      if (oldImage) {
        if (candidate.sourceKind === 'vcp-local') localTarget(source, candidate);
        else safeSegments(source);
        if (attachmentBridge) return attachmentBridge.resolveVcpImageCandidate(candidate);
        if (!imageRoot) fail('OUTBOUND_ROOT_DENIED');
        const target = candidate.sourceKind === 'vcp-local' ? localTarget(source, candidate) : path.join(imageRoot, ...safeSegments(source));
        const bytes = readLocal(target, [imageRoot]);
        const mime = validateMime(bytes, path.extname(target), undefined, true);
        return Object.freeze({ mediaKind: mediaKind(mime), relativePath: path.relative(imageRoot, target).split(path.sep).join('/'),
          mime, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), alt: candidate.alt });
      }
      let bytes, mime;
      if (candidate.sourceKind === 'https') ({ bytes, mime } = await download(source, candidate.kind === 'image', signal));
      else if (candidate.kind === 'file' && ['file-local', 'vcp-file'].includes(candidate.sourceKind)) {
        const target = localTarget(source, candidate);
        bytes = readLocal(target, roots);
        mime = validateMime(bytes, path.extname(target));
      } else fail('OUTBOUND_URL_DENIED');
      return stage(bytes, mime, candidate.alt, signal);
    });
  }

  async function send(input = {}) {
    // Snapshot persisted metadata before awaiting any external operation.
    let media, chatId, threadId, replyToMessageId, signal;
    try {
      ({ chatId, replyToMessageId, signal } = input);
      threadId = input.threadId ?? '0';
      media = { ...input.media };
    } catch { fail('OUTBOUND_INPUT_INVALID'); }
    if (typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId)
        || typeof threadId !== 'string' || !/^(?:0|[1-9]\d*)$/.test(threadId)
        || (replyToMessageId !== undefined && (typeof replyToMessageId !== 'string' || !/^[1-9]\d*$/.test(replyToMessageId)))
        || !['photo', 'animation', 'document'].includes(media.mediaKind)
        || !Object.hasOwn(TYPES, media.mime) || media.mediaKind !== mediaKind(media.mime)
        || !Number.isSafeInteger(media.size) || media.size < 1 || media.size > maxBytes
        || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
        || typeof media.relativePath !== 'string'
        || (media.storageRoot !== undefined && media.storageRoot !== 'outbox')) fail('OUTBOUND_INPUT_INVALID');
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('OUTBOUND_INPUT_INVALID');
    checkAbort(signal);
    try {
      if (media.storageRoot === undefined && attachmentBridge) {
        if (media.mediaKind === 'document') fail('OUTBOUND_INPUT_INVALID');
        return await attachmentBridge.sendRichMedia({ chatId, threadId, media, signal, replyToMessageId });
      }
      const staged = media.storageRoot === 'outbox';
      const root = staged ? outbox : imageRoot;
      if (!root || (!staged && media.mediaKind === 'document')) fail('OUTBOUND_INPUT_INVALID');
      const segments = safeSegments(media.relativePath);
      if (staged && (segments.length !== 1 || !/^[a-f0-9]{32}\.[a-z0-9]+$/.test(media.relativePath))) fail('OUTBOUND_PATH_DENIED');
      const target = path.join(root, ...segments);
      const bytes = readLocal(target, [root]);
      if (bytes.length !== media.size || crypto.createHash('sha256').update(bytes).digest('hex') !== media.sha256) fail('OUTBOUND_CHANGED');
      const mime = validateMime(bytes, path.extname(target), media.mime, !staged);
      checkAbort(signal);
      const sender = telegramClient[{ photo: 'sendPhoto', animation: 'sendAnimation', document: 'sendDocument' }[media.mediaKind]];
      if (typeof sender !== 'function') fail('OUTBOUND_CONFIG_INVALID');
      const response = await sender.call(telegramClient, {
        chat_id: chatId, message_thread_id: threadId,
        ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId } }),
      }, new Blob([bytes], { type: mime }), path.basename(target), { signal });
      const raw = response?.message_id;
      if ((typeof raw === 'number' && (!Number.isSafeInteger(raw) || raw < 1))
          || !['number', 'string'].includes(typeof raw) || !/^[1-9]\d*$/.test(String(raw))) fail('OUTBOUND_RESPONSE_INVALID');
      return Object.freeze({ messageId: String(raw) });
    } catch (error) {
      const fields = readSafeTelegramError(error);
      if (fields) throw Object.assign(new OutboundResourceError(fields.code), fields);
      if (error instanceof OutboundResourceError) throw error;
      fail('OUTBOUND_SEND_FAILED');
    }
  }
  function readForModel(media) {
    try {
      if(!media || !['photo','animation'].includes(media.mediaKind) || !media.mime?.startsWith('image/')) return null;
      const root=media.storageRoot==='outbox'?outbox:imageRoot;
      if(!root || (media.storageRoot!==undefined&&media.storageRoot!=='outbox')) return null;
      const target=path.join(root,...safeSegments(media.relativePath));
      const bytes=readLocal(target,[root]);
      if(bytes.length!==media.size || crypto.createHash('sha256').update(bytes).digest('hex')!==media.sha256) return null;
      const mime=validateMime(bytes,path.extname(target),media.mime,true);
      return `data:${mime};base64,${bytes.toString('base64')}`;
    } catch { return null; }
  }
  return Object.freeze({ resolve, send, readForModel });
}

module.exports = Object.freeze({ createOutboundResources, OutboundResourceError });

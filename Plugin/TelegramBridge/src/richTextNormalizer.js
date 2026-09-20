'use strict';

const crypto = require('node:crypto');

const ERROR_MESSAGE = 'VCP rich text normalization failed.';
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxTags: 4096,
  maxTagLength: 8192,
  maxEntityLength: 64,
  maxTrailingTags: 16,
});
const BLOCKED_CONTAINERS = new Set(['script', 'style', 'svg', 'iframe']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'div', 'footer', 'header', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'main', 'nav', 'p', 'section',
]);
const NAMED_ENTITIES = Object.freeze({
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
});
const TOKEN_OPEN = '\uE100';
const TOKEN_CLOSE = '\uE101';
const MEDIA_SOURCES = new WeakMap();

class RichTextNormalizerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'RichTextNormalizerError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, RichTextNormalizerError);
  }
}

function fail(code) {
  throw new RichTextNormalizerError(code);
}

function readLimit(options, key, minimum, maximum) {
  let value;
  try { value = options[key]; } catch { fail('RICH_TEXT_OPTIONS_INVALID'); }
  if (value === undefined) return DEFAULT_LIMITS[key];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('RICH_TEXT_OPTIONS_INVALID');
  }
  return value;
}

function sanitizeControls(value) {
  return value
    .replace(/[\uE000-\uF8FF]/g, '\uFFFD')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

function decodeEntitiesOnce(value, maxEntityLength) {
  return value.replace(/&([^;\s]{1,1024});/g, (match, entity) => {
    if (entity.length > maxEntityLength) return match;
    const lowered = entity.toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, lowered)) return NAMED_ENTITIES[lowered];
    let codePoint = null;
    if (/^#\d{1,7}$/.test(entity)) codePoint = Number(entity.slice(1));
    if (/^#x[0-9a-f]{1,6}$/i.test(entity)) codePoint = Number.parseInt(entity.slice(2), 16);
    if (
      codePoint === null
      || !Number.isSafeInteger(codePoint)
      || codePoint < 0
      || codePoint > 0x10FFFF
      || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
    ) return match;
    try { return String.fromCodePoint(codePoint); } catch { return '\uFFFD'; }
  });
}

function protectMarkdown(value) {
  const protectedValues = [];
  const tokenNonce = crypto.randomBytes(12).toString('hex');
  const protect = (content) => {
    const token = `${TOKEN_OPEN}${tokenNonce}:${protectedValues.length}${TOKEN_CLOSE}`;
    protectedValues.push(content);
    return token;
  };

  let source = value;
  // Protect complete and streaming-incomplete CommonMark fenced blocks.
  const fencePattern = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n/g;
  let scanned = '';
  let cursor = 0;
  for (let match; (match = fencePattern.exec(source));) {
    const start = match.index + match[1].length;
    const endPattern = new RegExp(`(?:^|\\n)[ \\t]{0,3}${match[2][0]}{${match[2].length},}[ \\t]*(?=\\n|$)`, 'g');
    endPattern.lastIndex = fencePattern.lastIndex - 1;
    const closing = endPattern.exec(source);
    const end = closing ? endPattern.lastIndex : source.length;
    scanned += source.slice(cursor, start) + protect(source.slice(start, end));
    cursor = end;
    fencePattern.lastIndex = end;
  }
  source = scanned + source.slice(cursor);
  source = source.replace(/`[^`\n]+`/g, (match) => protect(match));
  return { source, protectedValues, tokenNonce };
}

function stableMarkdownToken(tokenNonce, index) {
  return `VCPPROTECTED${tokenNonce}X${index}END`;
}

function stabilizeMarkdownTokens(value, tokenNonce) {
  return value.replace(
    new RegExp(`${TOKEN_OPEN}${tokenNonce}:(\\d+)${TOKEN_CLOSE}`, 'g'),
    (_match, index) => stableMarkdownToken(tokenNonce, index),
  );
}

function restoreMarkdown(value, protectedValues, tokenNonce) {
  return value.replace(
    new RegExp(`VCPPROTECTED${tokenNonce}X(\\d+)END`, 'g'),
    (_match, index) => protectedValues[Number(index)] ?? '',
  );
}

function scanTag(source, start, maxTagLength) {
  let quote = null;
  const hardEnd = Math.min(source.length, start + maxTagLength + 1);
  for (let index = start + 1; index < hardEnd; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return { end: index + 1, raw: source.slice(start + 1, index) };
  }
  if (hardEnd < source.length && source[hardEnd - 1] !== '>') {
    const nextEnd = source.indexOf('>', hardEnd);
    if (nextEnd !== -1) fail('RICH_TEXT_TAG_TOO_LONG');
  }
  return null;
}

function parseTag(raw) {
  let body = raw.trim();
  if (body === '' || body.startsWith('!') || body.startsWith('?')) return null;
  const closing = body.startsWith('/');
  if (closing) body = body.slice(1).trimStart();
  const match = /^([A-Za-z][A-Za-z0-9:-]*)/.exec(body);
  if (!match) return null;
  const name = match[1].toLowerCase();
  let rest = body.slice(match[0].length);
  const selfClosing = /\/\s*$/.test(rest);
  if (selfClosing) rest = rest.replace(/\/\s*$/, '');
  return { name, closing, selfClosing, attributes: closing ? '' : rest };
}

function parseAttributes(source, maxEntityLength) {
  const attributes = Object.create(null);
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(index));
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    while (/\s/.test(source[index] ?? '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null;
      const start = index;
      if (quote !== null) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(start, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(start, index);
      }
    }
    if (!Object.hasOwn(attributes, name)) {
      attributes[name] = decodeEntitiesOnce(sanitizeControls(value), maxEntityLength);
    }
  }
  return attributes;
}

function isLoopbackHost(value) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(value.toLowerCase());
}

function safeWebUrl(value, { allowHttp, requireLoopback }) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.username !== '' || parsed.password !== '') return null;
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === 'https:') return requireLoopback || loopback ? null : parsed.href;
  if (!allowHttp || parsed.protocol !== 'http:') return null;
  if (requireLoopback !== loopback) return null;
  return parsed.href;
}

function decodedUrlRepresentations(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const representations = [];
  let current = value;
  for (let layer = 0; layer <= 4; layer++) {
    representations.push(current);
    if (!current.includes('%')) return representations;
    if (layer === 4) return null; // Ambiguous/deeper encoding fails closed.
    try { current = decodeURIComponent(current); } catch { return null; }
  }
  return null;
}

function confidentialUrl(value) {
  const representations = decodedUrlRepresentations(value);
  if (representations === null) return true;
  for (const raw of representations) {
    const decoded = decodeEntitiesOnce(raw, DEFAULT_LIMITS.maxEntityLength);
    if (/^file:|\/pw\s*=/i.test(decoded)) return true;
    let url;
    try { url = new URL(decoded); } catch { return true; }
    if (url.username || url.password) return true;
    const sensitive = /^(?:pw|pass(?:word)?|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|(?:api[_-]?|secret[_-]?)?key|secret|signature|sig|authorization|x-(?:amz|goog)-(?:credential|signature|security-token))$/i;
    for (const key of url.searchParams.keys()) if (sensitive.test(key)) return true;
  }
  return false;
}

function visibleWebUrl(value) {
  return confidentialUrl(value) ? null : safeWebUrl(value, { allowHttp: true, requireLoopback: false });
}

function classifyImageSource(value) {
  // Relative image paths are resolved under the host image root, never cwd.
  if (typeof value === 'string' && value.length > 0 && value.length <= 1024
      && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[\\/]/.test(value)) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { return null; }
    if (/[\\:%?#\u0000-\u001f\u007f-\u009f]/.test(decoded)) return null;
    const segments = decoded.split('/');
    if (segments.some(part => !part || part === '.' || part === '..')) return null;
    return { sourceKind: 'vcp-relative', canonical: decoded };
  }
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  const safe = safeWebUrl(value, {
    allowHttp: true,
    requireLoopback: parsed.protocol === 'http:',
  });
  if (!safe) return null;
  parsed = new URL(safe);
  if (parsed.protocol === 'https:') return { sourceKind: 'https', canonical: safe };
  if (!/^\/pw=[^/]{1,256}\/images\//.test(parsed.pathname)) return null;
  // Keep raw dot segments for the filesystem resolver to reject; URL.href
  // would silently normalize traversal before the security check.
  return { sourceKind: 'vcp-local', canonical: value };
}

function opaqueSourceRef(value) {
  return crypto.createHash('sha256').update('telegram-rich-media-v1\0').update(value).digest('hex');
}

function classifyFileSource(value, label = '') {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol === 'file:') return { sourceKind: 'file-local', canonical: value };
  if (/^\/pw=[^/]+\/files\//i.test(parsed.pathname)) {
    return { sourceKind: 'vcp-file', canonical: value };
  }
  if (parsed.protocol === 'https:' && (
    /download|下载|附件|文件/i.test(label)
    || /\.(?:pdf|txt|csv|json|zip|docx?|xlsx?|pptx?|mp[34]|ogg|wav)(?:$)/i.test(parsed.pathname)
  )) return { sourceKind: 'https', canonical: value };
  return null;
}

function safeMediaAlt(value, fallback, maxEntityLength) {
  const alt = sanitizeControls(decodeEntitiesOnce(value, maxEntityLength)).replace(/\s+/g, ' ').trim();
  if (/(?:[a-z][a-z0-9+.-]*:|pw(?:=|&)|[\\/]|(?:token|secret|key)\s*=)/i.test(alt)) return fallback;
  return alt.slice(0, 160);
}

function scanMarkdownImage(source, start, maximum, image = true) {
  const limit = Math.min(source.length, start + maximum);
  const labelStart = start + (image ? 2 : 1);
  let labelEnd = -1;
  let labelDepth = 1;
  for (let i = labelStart; i < limit; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '[') labelDepth++;
    if (source[i] === ']' && --labelDepth === 0) { labelEnd = i; break; }
  }
  const incomplete = { end: source.length, target: null, alt: '' };
  if (labelEnd === -1) return incomplete;
  if (labelEnd + 1 === source.length) {
    return image || /(?:[a-z][a-z0-9+.-]*:|pw=)/i.test(source.slice(labelStart, labelEnd))
      ? incomplete : null;
  }
  if (source[labelEnd + 1] !== '(') return null;
  let depth = 1;
  let quote = null;
  let angle = false;
  const targetStart = labelEnd + 2;
  for (let i = targetStart; i < limit; i++) {
    const char = source[i];
    if (char === '\\') { i++; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if ((char === '"' || char === "'") && /\s/.test(source[i - 1])) { quote = char; continue; }
    if (char === '<') { angle = true; continue; }
    if (char === '>' && angle) { angle = false; continue; }
    if (angle) continue;
    if (char === '(') depth++;
    if (char !== ')') continue;
    depth--;
    if (depth !== 0) continue;
    const raw = source.slice(targetStart, i).trim();
    const match = /^(?:<([^<>]*)>|([^\s]+?))(?:\s+["'][\s\S]*["'])?$/.exec(raw);
    return {
      end: i + 1,
      alt: source.slice(labelStart, labelEnd).replace(/\\([\[\]\\])/g, '$1'),
      target: match ? (match[1] ?? match[2]).replace(/\\([()\\])/g, '$1') : null,
    };
  }
  return incomplete;
}

function appendBlock(parts) {
  if (parts.length === 0) return;
  const current = parts.join('');
  if (!current.endsWith('\n\n')) parts.push(current.endsWith('\n') ? '\n' : '\n\n');
}

function stripTrailingVcpTags(value, maxTrailingTags) {
  let result = value.trimEnd();
  let removed = 0;
  while (removed < maxTrailingTags) {
    const lineStart = result.lastIndexOf('\n') + 1;
    if (lineStart === 0) break;
    const line = result.slice(lineStart).trim();
    const tags = line.match(/\[@!?[^\]\r\n]{1,128}\]/g);
    if (!tags || tags.join(' ') !== line || removed + tags.length > maxTrailingTags) break;
    removed += tags.length;
    result = result.slice(0, lineStart).trimEnd();
  }
  return result;
}

function normalizeWhitespace(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function redactResourceExamples(value) {
  // Code/escaped examples must never cause uploads, but their destinations are
  // still private. Run after restoring code so protection cannot bypass this.
  let result = '';
  for (let index = 0; index < value.length;) {
    const image = value.startsWith('![', index);
    if (image || value[index] === '[') {
      const link = scanMarkdownImage(value, index, 65536, image);
      if (link && (image || classifyFileSource(link.target, link.alt)
          || (link.target !== null && confidentialUrl(link.target))
          || (link.target === null && value.slice(index, link.end).includes('](')))) {
        result += image ? '🖼️ [图片]' : '📎 [文件]';
        index = link.end;
        continue;
      }
      if (link) {
        result += value.slice(index, link.end);
        index = link.end;
        continue;
      }
    }
    result += value[index++];
  }
  return result.replace(/(?:file:|https?:\/\/)[^\s<>"'`)]*/gi,
    url => confidentialUrl(url) ? '[私有资源]' : url);
}

function unwrapPreCode(content, maxTagLength) {
  const leadingLength = /^\s*/.exec(content)?.[0].length ?? 0;
  if (content[leadingLength] !== '<') return content;
  const openingScan = scanTag(content, leadingLength, maxTagLength);
  const opening = openingScan ? parseTag(openingScan.raw) : null;
  if (!opening || opening.closing || opening.name !== 'code') return content;
  const trimmedEnd = content.trimEnd();
  const closingStart = trimmedEnd.toLowerCase().lastIndexOf('</code');
  if (closingStart < openingScan.end) return content;
  const closingScan = scanTag(trimmedEnd, closingStart, maxTagLength);
  const closing = closingScan ? parseTag(closingScan.raw) : null;
  if (
    !closing || !closing.closing || closing.name !== 'code'
    || closingScan.end !== trimmedEnd.length
  ) return content;
  return content.slice(openingScan.end, closingStart);
}

function normalizeVcpRichText(input, options = {}) {
  if (typeof input !== 'string' || options === null || typeof options !== 'object') {
    fail('RICH_TEXT_INPUT_INVALID');
  }
  const maxBytes = readLimit(options, 'maxBytes', 1, 4 * 1024 * 1024);
  const maxOutputBytes = readLimit(options, 'maxOutputBytes', 1, 4 * 1024 * 1024);
  const maxTags = readLimit(options, 'maxTags', 1, 100000);
  const maxTagLength = readLimit(options, 'maxTagLength', 16, 65536);
  const maxEntityLength = readLimit(options, 'maxEntityLength', 4, 1024);
  const maxTrailingTags = readLimit(options, 'maxTrailingTags', 1, 64);
  if (Buffer.byteLength(input, 'utf8') > maxBytes) fail('RICH_TEXT_TOO_LARGE');

  const safeInput = sanitizeControls(input).replace(/\r\n?/g, '\n');
  const { source, protectedValues, tokenNonce } = protectMarkdown(safeInput);
  const parts = [];
  const media = [];
  const blockedStack = [];
  const listStack = [];
  const inlineDepth = new Map();
  const linkStack = [];
  let blockquoteDepth = 0;
  let detectedRichText = false;
  let tagCount = 0;

  const appendImage = (target, rawAlt = '') => {
    const classified = classifyImageSource(target);
    if (!classified) { parts.push('🖼️ [图片不可用]'); return; }
    const alt = safeMediaAlt(rawAlt, '图片', maxEntityLength);
    const candidate = Object.freeze({
      kind: 'image', sourceKind: classified.sourceKind,
      sourceRef: opaqueSourceRef(classified.canonical), alt,
    });
    MEDIA_SOURCES.set(candidate, classified.canonical);
    media.push(candidate);
    parts.push(alt === '' ? '🖼️ [图片]' : `🖼️ [${alt.replace(/&/g, '&amp;')}]`);
  };

  const appendFile = (classified, rawAlt = '') => {
    if (!classified) { parts.push('📎 [文件不可用]'); return; }
    const alt = safeMediaAlt(rawAlt, '文件', maxEntityLength);
    const candidate = Object.freeze({
      kind: 'file', sourceKind: classified.sourceKind,
      sourceRef: opaqueSourceRef(classified.canonical), alt,
    });
    MEDIA_SOURCES.set(candidate, classified.canonical);
    media.push(candidate);
    parts.push(`📎 [${(alt || '文件').replace(/&/g, '&amp;')}]`);
  };

  const appendInlineMarker = (name, marker, closing) => {
    const depth = inlineDepth.get(name) ?? 0;
    if (closing) {
      if (depth > 0) {
        parts.push(marker);
        inlineDepth.set(name, depth - 1);
      }
      return;
    }
    parts.push(marker);
    inlineDepth.set(name, depth + 1);
  };

  for (let index = 0; index < source.length;) {
    if (blockedStack.length === 0 && source.startsWith('![', index) && source[index - 1] !== '\\') {
      const image = scanMarkdownImage(source, index, maxTagLength);
      if (image) {
        appendImage(image.target, image.alt);
        index = image.end;
        continue;
      }
    }
    if (blockedStack.length === 0 && source[index] === '['
        && source[index - 1] !== '\\' && source[index - 1] !== '!') {
      const link = scanMarkdownImage(source, index, maxTagLength, false);
      if (link) {
        const classified = classifyFileSource(link.target, link.alt);
        if (classified || link.target === null) appendFile(classified, link.alt);
        else {
          const label = safeMediaAlt(link.alt, '链接', maxEntityLength);
          const target = visibleWebUrl(link.target);
          // Restore complete ordinary links after entity/HTML processing.
          const content = target ? `[${label}](${target})` : label;
          parts.push(`${TOKEN_OPEN}${tokenNonce}:${protectedValues.length}${TOKEN_CLOSE}`);
          protectedValues.push(content);
        }
        index = link.end;
        continue;
      }
    }
    if (source.startsWith('<!--', index)) {
      detectedRichText = true;
      const end = source.indexOf('-->', index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    if (source[index] !== '<') {
      if (blockedStack.length === 0) {
        parts.push(source[index]);
        if (source[index] === '\n' && blockquoteDepth > 0) parts.push('> ');
      }
      index += 1;
      continue;
    }

    const scanned = scanTag(source, index, maxTagLength);
    if (!scanned) {
      if (blockedStack.length === 0) {
        const looksLikeTag = /^<\/?[A-Za-z]/.test(source.slice(index, index + 4));
        if (looksLikeTag) {
          detectedRichText = true;
          break;
        }
        parts.push('<');
      }
      index += 1;
      continue;
    }
    tagCount += 1;
    if (tagCount > maxTags) fail('RICH_TEXT_TAG_LIMIT');
    const tag = parseTag(scanned.raw);
    index = scanned.end;
    if (!tag) continue;
    detectedRichText = true;

    if (blockedStack.length > 0) {
      if (!tag.closing && BLOCKED_CONTAINERS.has(tag.name) && !tag.selfClosing) {
        blockedStack.push(tag.name);
      } else if (tag.closing && tag.name === blockedStack.at(-1)) {
        blockedStack.pop();
      }
      continue;
    }
    if (!tag.closing && BLOCKED_CONTAINERS.has(tag.name)) {
      if (!tag.selfClosing) blockedStack.push(tag.name);
      continue;
    }

    if (!tag.closing && tag.name === 'pre') {
      const remainder = source.slice(index);
      const closeMatch = /<\/pre\s*>/i.exec(remainder);
      if (!closeMatch) continue;
      let content = remainder.slice(0, closeMatch.index);
      content = unwrapPreCode(content, maxTagLength);
      content = sanitizeControls(decodeEntitiesOnce(content, maxEntityLength)).replace(/\r\n?/g, '\n');
      appendBlock(parts);
      parts.push(`\`\`\`\n${content}\n\`\`\``);
      appendBlock(parts);
      index += closeMatch.index + closeMatch[0].length;
      continue;
    }
    if (!tag.closing && tag.name === 'code') {
      const remainder = source.slice(index);
      const closeMatch = /<\/code\s*>/i.exec(remainder);
      if (!closeMatch) continue;
      const content = sanitizeControls(decodeEntitiesOnce(
        remainder.slice(0, closeMatch.index),
        maxEntityLength,
      ));
      parts.push(content.includes('`') || content.includes('\n')
        ? `\`\`\`\n${content}\n\`\`\``
        : `\`${content}\``);
      index += closeMatch.index + closeMatch[0].length;
      continue;
    }

    if (BLOCK_TAGS.has(tag.name)) {
      appendBlock(parts);
      continue;
    }
    if (tag.name === 'br' && !tag.closing) {
      parts.push('\n');
      if (blockquoteDepth > 0) parts.push('> ');
      continue;
    }
    if (tag.name === 'strong' || tag.name === 'b') {
      appendInlineMarker('bold', '**', tag.closing);
      continue;
    }
    if (tag.name === 'em' || tag.name === 'i') {
      appendInlineMarker('italic', '*', tag.closing);
      continue;
    }
    if (tag.name === 'ul' || tag.name === 'ol') {
      if (tag.closing) {
        listStack.pop();
        appendBlock(parts);
      } else {
        appendBlock(parts);
        listStack.push({ ordered: tag.name === 'ol', next: 1 });
      }
      continue;
    }
    if (tag.name === 'li') {
      if (tag.closing) {
        if (!parts.join('').endsWith('\n')) parts.push('\n');
      } else {
        const current = listStack.at(-1) ?? { ordered: false, next: 1 };
        const joined = parts.join('');
        if (joined !== '' && !joined.endsWith('\n')) parts.push('\n');
        parts.push(current.ordered ? `${current.next}. ` : '• ');
        current.next += 1;
      }
      continue;
    }
    if (tag.name === 'blockquote') {
      if (tag.closing) {
        blockquoteDepth = Math.max(0, blockquoteDepth - 1);
        appendBlock(parts);
      }
      else {
        appendBlock(parts);
        blockquoteDepth += 1;
        parts.push('> ');
      }
      continue;
    }
    if (tag.name === 'a') {
      if (tag.closing) {
        const target = linkStack.pop();
        if (target) parts.push(`](${target})`);
      } else {
        const attributes = parseAttributes(tag.attributes, maxEntityLength);
        const close = /<\/a\s*>/i.exec(source.slice(index));
        const rawLabel = close ? source.slice(index, index + close.index).replace(/<[^>]*>/g, '') : '';
        const classified = classifyFileSource(attributes.href, Object.hasOwn(attributes, 'download') ? 'download' : rawLabel);
        if (classified) {
          appendFile(close ? classified : null, rawLabel);
          index = close ? index + close.index + close[0].length : source.length;
          continue;
        }
        const target = visibleWebUrl(attributes.href);
        linkStack.push(target);
        if (target) parts.push('[');
      }
      continue;
    }
    if (tag.name === 'img' && !tag.closing) {
      const attributes = parseAttributes(tag.attributes, maxEntityLength);
      appendImage(attributes.src, attributes.alt ?? '');
    }
  }

  let text = decodeEntitiesOnce(parts.join(''), maxEntityLength);
  text = stabilizeMarkdownTokens(text, tokenNonce);
  text = sanitizeControls(text);
  text = normalizeWhitespace(text);
  text = stripTrailingVcpTags(text, maxTrailingTags);
  text = restoreMarkdown(text, protectedValues, tokenNonce);
  text = redactResourceExamples(text);
  if (Buffer.byteLength(text, 'utf8') > maxOutputBytes) fail('RICH_TEXT_OUTPUT_TOO_LARGE');

  return Object.freeze({
    text,
    media: Object.freeze(media),
    detectedRichText,
  });
}

function readMediaCandidateSource(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null;
  return MEDIA_SOURCES.get(candidate) ?? null;
}

module.exports = Object.freeze({
  RichTextNormalizerError,
  normalizeVcpRichText,
  readMediaCandidateSource,
  decodedUrlRepresentations,
});

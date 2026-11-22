'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream');
const { promisify, TextDecoder } = require('node:util');
const zlib = require('node:zlib');

const LOG_ROOT = path.join(__dirname, 'logs');
const DEFAULT_BODY_LIMIT = 128 * 1024 * 1024;
const CAPTURE_PATH = /^\/v1\/(?:chat(?:\/completions)?|resp(?:onses)?)\/?$/;
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];
const DECODERS = new Map([
  ['gzip', promisify(zlib.gunzip)],
  ['x-gzip', promisify(zlib.gunzip)],
  ['deflate', promisify(zlib.inflate)],
  ['br', promisify(zlib.brotliDecompress)],
]);

function relayHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const token of String(headers.connection || '').split(',')) {
    blocked.add(token.trim().toLowerCase());
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

class BodyLimitError extends Error {}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  // Leave the request socket open on a limit error so the client can receive 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new BodyLimitError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function decodeBody(raw, contentEncoding, limit) {
  let decoded = raw;
  for (const name of String(contentEncoding || '').split(',').reverse()) {
    const encoding = name.trim().toLowerCase();
    if (!encoding || encoding === 'identity') continue;
    const decode = DECODERS.get(encoding);
    if (!decode) throw new Error('不支持的请求体编码');
    decoded = await decode(decoded, { maxOutputLength: limit });
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
}

function readableLines(value, indent = '') {
  if (typeof value === 'string') {
    return value.split(/\r\n|\n|\r/).map(line => `${indent}| ${line}`);
  }
  if (value === null || typeof value !== 'object') return [`${indent}${JSON.stringify(value)}`];
  const entries = Object.entries(value);
  if (!entries.length) return [`${indent}${Array.isArray(value) ? '[]' : '{}'}`];
  const lines = [];
  for (const [key, child] of entries) {
    lines.push(`${indent}${Array.isArray(value) ? `[${key}]` : `${JSON.stringify(key)}:`}`);
    for (const line of readableLines(child, `${indent}  `)) lines.push(line);
  }
  return lines;
}

function fencedText(value) {
  const text = readableLines(value).join('\n');
  let max = 2;
  for (const run of text.matchAll(/~{3,}/g)) max = Math.max(max, run[0].length);
  const fence = '~'.repeat(max + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function formatMarkdown(body, endpoint, capturedAt) {
  const sections = [`# 对话请求\n\n- 时间（UTC）：${capturedAt}\n- 路径：${endpoint}`];
  if (typeof body?.model === 'string') sections.push(`## 模型\n\n${fencedText(body.model)}`);
  let found = false;
  for (const key of ['messages', 'input', 'instructions']) {
    if (!Object.hasOwn(body ?? {}, key)) continue;
    found = true;
    const value = body[key];
    if (Array.isArray(value) && value.length) {
      value.forEach((item, index) => {
        const role = item?.role;
        const label = typeof role === 'string' && /^[a-z][a-z_]{0,31}$/.test(role) ? ` · ${role}` : '';
        sections.push(`## ${key}[${index}]${label}\n\n${fencedText(item)}`);
      });
    } else {
      sections.push(`## ${key}\n\n${fencedText(value)}`);
    }
  }
  if (!found) sections.push('未找到对话字段；完整内容见同目录的 request.json。');
  return `${sections.join('\n\n')}\n`;
}

async function persistRequest(root, endpoint, raw, contentEncoding, limit) {
  const timestamp = new Date().toISOString();
  let json;
  let markdown;
  let body;
  try {
    json = await decodeBody(raw, contentEncoding, limit);
    body = JSON.parse(json);
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new BodyLimitError();
    json = JSON.stringify({ contentEncoding: contentEncoding || 'identity', rawBodyBase64: raw.toString('base64') }, null, 2);
    markdown = `# 对话请求\n\n- 时间（UTC）：${timestamp}\n- 路径：${endpoint}\n\n无法解码为 JSON；原始请求体以 Base64 保存在同目录的 request.json。\n`;
  }
  markdown ??= formatMarkdown(body, endpoint, timestamp);

  const dayDir = path.join(root, timestamp.slice(0, 10));
  const id = `${timestamp.replace(/:/g, '-')}-${randomUUID()}`;
  const staging = path.join(dayDir, `.pending-${id}`);
  await fs.mkdir(dayDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(staging, 'request.json'), json, { mode: 0o600, flush: true });
    await fs.writeFile(path.join(staging, 'request.md'), markdown, { mode: 0o600, flush: true });
    await fs.rename(staging, path.join(dayDir, id));
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function replyError(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
  res.end(JSON.stringify({ error: message }));
}

function createDebugProxy(upstream, { logRoot = LOG_ROOT, bodyLimit = DEFAULT_BODY_LIMIT } = {}) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('上游必须是 HTTP(S) 基址，不含凭据、查询参数或片段');
  }
  const transport = target.protocol === 'https:' ? https : http;
  const prefix = target.pathname.replace(/\/+$/, '');

  return http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/')) {
      replyError(res, 400, '仅支持普通 HTTP API 请求');
      return;
    }
    const endpoint = req.url.split('?', 1)[0];
    const capture = req.method === 'POST' && CAPTURE_PATH.test(endpoint);
    let outgoing;
    res.once('close', () => {
      if (!res.writableFinished) outgoing?.destroy();
    });
    req.once('error', () => outgoing?.destroy());

    try {
      let body;
      if (capture) {
        body = await readBody(req, bodyLimit);
        await persistRequest(logRoot, endpoint, body, req.headers['content-encoding'], bodyLimit);
      }
      if (res.destroyed) return;

      const headers = relayHeaders(req.headers);
      delete headers.host;
      if (req.headers['transfer-encoding']?.toLowerCase() === 'chunked') {
        headers['transfer-encoding'] = 'chunked';
      }
      outgoing = transport.request(target, {
        method: req.method,
        path: `${prefix}${req.url}`,
        headers,
      }, upstreamResponse => {
        res.sendDate = false;
        res.writeHead(upstreamResponse.statusCode, upstreamResponse.statusMessage, relayHeaders(upstreamResponse.headers));
        res.flushHeaders();
        pipeline(upstreamResponse, res, () => {});
      });
      outgoing.once('error', () => {
        req.unpipe(outgoing);
        req.resume();
        replyError(res, 502, '无法转发至上游');
      });
      if (capture) outgoing.end(body);
      else req.pipe(outgoing);
    } catch (error) {
      req.resume();
      if (error instanceof BodyLimitError) {
        replyError(res, 413, '对话请求体超出调试代理记录上限，未转发');
      } else if (!res.destroyed) {
        console.error('[调试代理] 请求未转发：', error.code || error.name);
        replyError(res, 500, '调试代理处理失败，未转发');
      }
    }
  });
}

if (require.main === module) {
  try {
    try {
      process.loadEnvFile(path.join(__dirname, 'config.env'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const upstream = (process.env.VCP_DEBUG_PROXY_UPSTREAM ?? '').trim();
    const portArg = (process.env.VCP_DEBUG_PROXY_PORT ?? '6305').trim();
    const port = Number(portArg);
    if (!upstream) throw new Error('请在调试代理的 config.env 中设置 VCP_DEBUG_PROXY_UPSTREAM');
    if (!/^\d+$/.test(portArg) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('VCP_DEBUG_PROXY_PORT 必须是 1–65535 的整数');
    }
    const proxy = createDebugProxy(upstream);
    proxy.on('error', error => {
      console.error('[调试代理] 无法监听：', error.code || error.name);
      process.exitCode = 1;
    });
    proxy.listen(port, '127.0.0.1', () => {
      console.log(`[调试代理] http://127.0.0.1:${port}，对话日志：${LOG_ROOT}`);
    });
  } catch (error) {
    console.error(`[调试代理] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createDebugProxy };
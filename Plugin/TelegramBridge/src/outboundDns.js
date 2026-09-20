'use strict';

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const DNS_HOST = 'cloudflare-dns.com';
const DNS_IP = '1.1.1.1';
const MAX_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADERS = 64;
const MAX_ANSWERS = 64;

class OutboundDnsError extends Error {
  constructor(code) {
    super('Telegram outbound DNS operation failed.');
    Object.defineProperty(this, 'name', { value: 'OutboundDnsError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, OutboundDnsError);
  }
}
function fail(code = 'OUTBOUND_DNS_RESPONSE_INVALID') { throw new OutboundDnsError(code); }
function ignoreError() { /* Destruction may emit a late socket/stream error. */ }

function hostname(value, code = 'OUTBOUND_DNS_RESPONSE_INVALID') {
  if (typeof value !== 'string' || value.length > 254) fail(code);
  const name = value.replace(/\.$/, '').toLowerCase();
  const labels = name.split('.');
  if (name.length > 253 || labels.length < 2 || net.isIP(name)
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/[a-z]/.test(labels.at(-1))
      || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(name)) fail(code);
  return name;
}

function parseAnswer(bytes, host, type) {
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(); }
  if (!body || Array.isArray(body) || body.Status !== 0 || (body.TC !== undefined && body.TC !== false)
      || !Array.isArray(body.Question) || body.Question.length !== 1
      || !body.Question[0] || body.Question[0].type !== type
      || hostname(body.Question[0].name) !== host) fail();
  const records = body.Answer === undefined ? [] : body.Answer;
  if (!Array.isArray(records) || records.length > MAX_ANSWERS) fail();
  const aliases = new Map();
  const addresses = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail();
    const name = hostname(record.name);
    if (record.type === 5) {
      const target = hostname(record.data);
      if (aliases.has(name) && aliases.get(name) !== target) fail();
      aliases.set(name, target);
    } else {
      const family = type === 1 ? 4 : 6;
      if (record.type !== type || typeof record.data !== 'string'
          || record.data.includes('%') || net.isIP(record.data) !== family) fail();
      const address = family === 4 ? record.data : new URL(`https://[${record.data}]/`).hostname.slice(1, -1);
      addresses.push({ name, address, family });
    }
  }
  // Follow only the queried owner's chain. Extra owners, cycles and an address
  // coexisting with a CNAME are not evidence about this query's destination.
  const visited = new Set();
  let terminal = host;
  while (aliases.has(terminal)) {
    if (visited.has(terminal)) fail();
    visited.add(terminal);
    terminal = aliases.get(terminal);
  }
  if (visited.size !== aliases.size || addresses.some(value => value.name !== terminal)) fail();
  return { count: records.length, addresses: addresses.map(({ address, family }) => ({ address, family })) };
}

function pinnedLookup(host, options, callback) {
  if (host !== DNS_HOST) return callback(new OutboundDnsError('OUTBOUND_DNS_FAILED'));
  return options?.all ? callback(null, [{ address: DNS_IP, family: 4 }]) : callback(null, DNS_IP, 4);
}

function responseLength(response) {
  const peer = response.socket?.remoteAddress;
  if (peer !== DNS_IP && peer !== '::ffff:' + DNS_IP) fail();
  if (response.statusCode !== 200) fail();
  const raw = response.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length > MAX_HEADERS * 2
      || raw.some(value => typeof value !== 'string')
      || raw.reduce((size, value) => size + Buffer.byteLength(value) + 2, 0) > MAX_HEADER_BYTES) fail();
  const headers = response.headers;
  if (typeof headers?.['content-type'] !== 'string'
      || headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/dns-json'
      || (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')) fail();
  const length = headers['content-length'];
  if (length === undefined) return undefined;
  if (typeof length !== 'string' || !/^\d+$/.test(length)
      || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES) fail();
  return Number(length);
}

function query(request, agent, host, type, signal) {
  return new Promise((resolve, reject) => {
    let req, response, declaredLength, settled = false, size = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (response) {
        response.removeListener('data', data);
        response.removeListener('end', end);
        response.removeListener('aborted', broken);
        response.removeListener('close', broken);
        response.removeListener('error', broken);
        response.on('error', ignoreError);
        response.destroy();
      }
      if (req) {
        req.removeListener('error', broken);
        req.on('error', ignoreError);
        req.destroy();
      }
      chunks.length = 0;
      if (error) reject(error instanceof OutboundDnsError ? error : new OutboundDnsError('OUTBOUND_DNS_FAILED'));
      else resolve(result);
    };
    const abort = () => finish(new OutboundDnsError(signal.reason));
    const broken = () => finish(new OutboundDnsError('OUTBOUND_DNS_FAILED'));
    const data = chunk => {
      if (settled) return;
      if (!(chunk instanceof Uint8Array) || size + chunk.byteLength > MAX_BYTES) {
        finish(new OutboundDnsError('OUTBOUND_DNS_RESPONSE_INVALID'));
        return;
      }
      size += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      try {
        if (declaredLength !== undefined && declaredLength !== size) fail();
        finish(null, parseAnswer(Buffer.concat(chunks, size), host, type));
      } catch (error) { finish(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      const url = new URL('/dns-query', 'https://' + DNS_HOST);
      url.searchParams.set('name', host);
      url.searchParams.set('type', type === 1 ? 'A' : 'AAAA');
      req = request(url, {
        method: 'GET', agent, servername: DNS_HOST, rejectUnauthorized: true,
        checkServerIdentity: tls.checkServerIdentity, lookup: pinnedLookup,
        headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' },
        maxHeaderSize: MAX_HEADER_BYTES,
      }, incoming => {
        if (settled) {
          incoming.on('error', ignoreError);
          incoming.destroy();
          return;
        }
        response = incoming;
        response.on('error', broken);
        response.on('aborted', broken);
        response.on('close', broken);
        try { declaredLength = responseLength(response); }
        catch (error) { finish(error); return; }
        response.on('data', data);
        response.on('end', end);
      });
      // Keep one overflow header: Node otherwise silently truncates at the cap.
      req.maxHeadersCount = MAX_HEADERS + 1;
      req.on('error', broken);
      if (settled) { req.on('error', ignoreError); req.destroy(); }
      else req.end();
    } catch (error) { finish(error); }
  });
}

/**
 * Returns an async lookup(host, { all: true, signal? }) -> { address, family }[].
 * It never filters private addresses: outboundResources must validate every
 * answer before pinning. Either query failing rejects the entire lookup.
 */
function createOutboundDnsLookup(config = {}) {
  let request, timeoutMs;
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('OUTBOUND_DNS_CONFIG_INVALID');
    ({ request = https.request, timeoutMs = 10_000 } = config);
    if (typeof request !== 'function' || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1 || timeoutMs > 120_000) fail('OUTBOUND_DNS_CONFIG_INVALID');
  } catch { fail('OUTBOUND_DNS_CONFIG_INVALID'); }
  return async function lookup(host, options = { all: true }) {
    const name = hostname(host, 'OUTBOUND_DNS_INPUT_INVALID');
    let signal, all;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('OUTBOUND_DNS_INPUT_INVALID');
      ({ signal, all } = options);
      if ((all !== undefined && all !== true)
          || (signal !== undefined && !(signal instanceof AbortSignal))) fail('OUTBOUND_DNS_INPUT_INVALID');
    } catch { fail('OUTBOUND_DNS_INPUT_INVALID'); }
    if (signal?.aborted) fail('OUTBOUND_DNS_ABORTED');
    const controller = new AbortController();
    const cancel = () => controller.abort('OUTBOUND_DNS_ABORTED');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort('OUTBOUND_DNS_TIMEOUT'), timeoutMs);
    // A private native agent bypasses the global agent; empty proxyEnv also
    // disables environment proxy discovery on Node versions supporting it.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 2, maxTotalSockets: 2, proxyEnv: {} });
    try {
      const results = await Promise.all([1, 28].map(type => query(request, agent, name, type, controller.signal)));
      if (controller.signal.aborted) fail(controller.signal.reason);
      if (results.reduce((sum, result) => sum + result.count, 0) > MAX_ANSWERS) fail();
      const unique = new Map();
      for (const { addresses } of results) {
        for (const value of addresses) unique.set(value.address, value);
      }
      if (unique.size === 0) fail('OUTBOUND_DNS_EMPTY');
      return [...unique.values()];
    } catch (error) {
      if (error instanceof OutboundDnsError) throw error;
      fail('OUTBOUND_DNS_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort('OUTBOUND_DNS_FAILED');
      agent.destroy();
    }
  };
}

module.exports = Object.freeze({ createOutboundDnsLookup });

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAttachmentBridge, AttachmentBridgeError } = require('../src/attachmentBridge');
const { normalizeVcpRichText } = require('../src/richTextNormalizer');
const { createTelegramClient } = require('../src/telegramClient');

const TOKEN = '123456:fixtureTelegramToken_abcdefghijklmnop';

function responseJson(body, url) {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: false });
  return response;
}

function assertAttachmentError(error, code, forbidden = []) {
  assert.equal(error instanceof AttachmentBridgeError, true);
  assert.equal(error.code, code);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const value of forbidden) assert.equal(serialized.includes(value), false);
  return true;
}

function makeBridge(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-rich-media-'));
  const stateDir = path.join(root, 'state');
  const imageRoot = path.join(root, 'image');
  const outputRoot = path.join(root, 'outbox');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(imageRoot);
  fs.mkdirSync(outputRoot);
  const calls = [];
  const telegramClient = {
    async getFile() { throw new Error('not used'); },
    async sendDocument() { throw new Error('not used'); },
    async sendPhoto(fields, blob, filename, control) {
      calls.push({ method: 'sendPhoto', fields, blob, filename, control });
      return { message_id: '501' };
    },
    async sendAnimation(fields, blob, filename, control) {
      calls.push({ method: 'sendAnimation', fields, blob, filename, control });
      return { message_id: '502' };
    },
  };
  const bridge = createAttachmentBridge({
    stateDir,
    imageRoot,
    vcpImageKey: 'fixture-key',
    vcpPort: '6005',
    database: { prepare() { throw new Error('not used'); } },
    telegramClient,
    maxInboundBytes: 1024,
    maxOutboundBytes: options.maxOutboundBytes ?? 1024,
    allowedOutputRoots: [outputRoot, imageRoot],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { bridge, calls, imageRoot, root, telegramClient };
}

function candidate(url, alt = 'fixture image') {
  return normalizeVcpRichText(`<img src="${url}" alt="${alt}">`).media[0];
}

test('relative Markdown image paths resolve only under image root, including root-level images', (t) => {
  const item = makeBridge(t);
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24)]);
  fs.mkdirSync(path.join(item.imageRoot, 'ExampleAgent表情包'));
  fs.writeFileSync(path.join(item.imageRoot, 'ExampleAgent表情包', 'a.png'), bytes);
  fs.writeFileSync(path.join(item.imageRoot, 'root.png'), bytes);
  const relative = normalizeVcpRichText('![ExampleAgent贴贴](ExampleAgent表情包/a.png)').media[0];
  assert.equal(item.bridge.resolveVcpImageCandidate(relative).relativePath, 'ExampleAgent表情包/a.png');
  assert.equal(item.bridge.resolveVcpImageCandidate(candidate('http://localhost:6005/pw=fixture-key/images/root.png')).relativePath, 'root.png');
});

test('resolves a valid loopback VCP image without exposing its pw URL or absolute path', (t) => {
  const item = makeBridge(t);
  const directory = path.join(item.imageRoot, 'ExampleAgent');
  fs.mkdirSync(directory);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
  ]);
  fs.writeFileSync(path.join(directory, 'a.png'), bytes);
  const input = candidate('http://localhost:6005/pw=fixture-key/images/ExampleAgent/a.png');

  const resolved = item.bridge.resolveVcpImageCandidate(input);

  assert.deepEqual(resolved, {
    mediaKind: 'photo',
    relativePath: 'ExampleAgent/a.png',
    mime: 'image/png',
    size: bytes.length,
    sha256: resolved.sha256,
    alt: 'fixture image',
  });
  assert.match(resolved.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(resolved).includes('pw='), false);
  assert.equal(JSON.stringify(resolved).includes(item.root), false);
  assert.equal(Object.isFrozen(resolved), true);
});

test('rejects wrong keys, traversal, links, MIME mismatch and oversize with sanitized errors', async (t) => {
  const item = makeBridge(t, { maxOutboundBytes: 32 });
  const directory = path.join(item.imageRoot, 'safe');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'bad.png'), Buffer.from('not-a-png'));
  fs.writeFileSync(path.join(directory, 'large.png'), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40),
  ]));

  for (const [name, input, code] of [
    ['wrong-key', candidate('http://127.0.0.1:6005/pw=wrong-secret/images/safe/bad.png'), 'ATTACHMENT_VCP_IMAGE_DENIED'],
    ['traversal', candidate('http://127.0.0.1:6005/pw=fixture-key/images/%2e%2e/config.env'), 'ATTACHMENT_VCP_IMAGE_DENIED'],
    ['mime', candidate('http://127.0.0.1:6005/pw=fixture-key/images/safe/bad.png'), 'ATTACHMENT_MIME_MISMATCH'],
    ['oversize', candidate('http://127.0.0.1:6005/pw=fixture-key/images/safe/large.png'), 'ATTACHMENT_OUTPUT_TOO_LARGE'],
  ]) {
    await t.test(name, () => {
      assert.throws(
        () => item.bridge.resolveVcpImageCandidate(input),
        (error) => assertAttachmentError(error, code, ['wrong-secret', 'fixture-key', item.root]),
      );
    });
  }

  const outside = path.join(item.root, 'outside.png');
  fs.writeFileSync(outside, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8),
  ]));
  const link = path.join(directory, 'link.png');
  try {
    fs.symlinkSync(outside, link, 'file');
    assert.throws(
      () => item.bridge.resolveVcpImageCandidate(
        candidate('http://[::1]:6005/pw=fixture-key/images/safe/link.png'),
      ),
      (error) => assertAttachmentError(error, 'ATTACHMENT_OUTPUT_LINK_DENIED', [item.root]),
    );
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
});

test('sendPhoto and sendAnimation share the bounded multipart transport', async () => {
  const calls = [];
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: options.body });
      return responseJson({ ok: true, result: { message_id: calls.length } }, String(url));
    },
  });
  const photo = new Blob([Buffer.from('photo')], { type: 'image/png' });
  const animation = new Blob([Buffer.from('animation')], { type: 'image/gif' });

  await client.sendPhoto({ chat_id: '42' }, photo, 'photo.png');
  await client.sendAnimation({ chat_id: '42' }, animation, 'animation.gif');

  assert.equal(calls[0].url.endsWith('/sendPhoto'), true);
  assert.equal(calls[0].body.get('photo') instanceof Blob, true);
  assert.equal(calls[1].url.endsWith('/sendAnimation'), true);
  assert.equal(calls[1].body.get('animation') instanceof Blob, true);
});

test('legacy rich images honor cancellation and preserve reply routing', async t => {
  const item = makeBridge(t);
  fs.writeFileSync(path.join(item.imageRoot, 'a.gif'), Buffer.from('GIF89afixture'));
  const media = item.bridge.resolveVcpImageCandidate(candidate('a.gif'));
  const controller = new AbortController();
  await item.bridge.sendRichMedia({ chatId: '42', threadId: '7', media, signal: controller.signal, replyToMessageId: '123' });
  assert.deepEqual(item.calls[0].fields, { chat_id: '42', message_thread_id: '7', reply_parameters: { message_id: '123' } });
  assert.equal(item.calls[0].control.signal, controller.signal);
  controller.abort();
  await assert.rejects(item.bridge.sendRichMedia({ chatId: '42', media, signal: controller.signal }), error => error.code === 'ATTACHMENT_ABORTED');
  assert.equal(item.calls.length, 1);
});

test('legacy images reject same-root junctions, hardlinks, and normalized traversal', async t => {
  const item = makeBridge(t);
  const original = path.join(item.imageRoot, 'a.gif');
  fs.writeFileSync(original, Buffer.from('GIF89afixture'));
  const nested = path.join(item.imageRoot, 'nested');
  fs.mkdirSync(nested);
  fs.symlinkSync(nested, path.join(item.imageRoot, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(nested, 'safe.gif'), Buffer.from('GIF89afixture'));
  assert.throws(() => item.bridge.resolveVcpImageCandidate(candidate('alias/safe.gif')), error => error.code === 'ATTACHMENT_OUTPUT_LINK_DENIED');
  assert.throws(() => item.bridge.resolveVcpImageCandidate(candidate('http://localhost:6005/pw=fixture-key/images/sub/../a.gif')), error => error.code === 'ATTACHMENT_VCP_IMAGE_DENIED');
  fs.linkSync(original, path.join(item.imageRoot, 'hard.gif'));
  assert.throws(() => item.bridge.resolveVcpImageCandidate(candidate('hard.gif')), error => error.code === 'ATTACHMENT_OUTPUT_LINK_DENIED');
});

test('legacy image wrappers preserve safe Telegram cancellation and retry errors', async t => {
  const item = makeBridge(t);
  fs.writeFileSync(path.join(item.imageRoot, 'a.gif'), Buffer.from('GIF89afixture'));
  const media = item.bridge.resolveVcpImageCandidate(candidate('a.gif'));
  for (const code of ['TELEGRAM_ABORTED', 'TELEGRAM_RATE_LIMIT']) {
    item.telegramClient.sendAnimation = async () => {
      throw Object.assign(new Error('private-secret'), { code, retryAfterSec: 7, token: 'private-secret' });
    };
    await assert.rejects(item.bridge.sendRichMedia({ chatId: '42', media }), error => {
      assert.equal(error.code, code);
      assert.equal(error.retryAfterSec, code === 'TELEGRAM_RATE_LIMIT' ? 7 : undefined);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private-secret/);
      return true;
    });
  }
});

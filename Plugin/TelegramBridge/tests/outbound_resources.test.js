'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const { normalizeVcpRichText } = require('../src/richTextNormalizer');
const { createAttachmentBridge } = require('../src/attachmentBridge');

const PDF = Buffer.from('%PDF-1.7\nfixture document\n%%EOF');
const PNG = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24)]);
const GIF = Buffer.from('GIF89a' + 'fixture animation');
const PUBLIC_IP = '93.184.216.34';

function candidate(url, image = false) {
  return normalizeVcpRichText(`${image ? '!' : ''}[download](${url})`).media[0];
}

function fixture(t, extra = {}) {
  const { createOutboundResources } = require('../src/outboundResources');
  const root = physicalTempDir(path.join(os.tmpdir(), 'telegram-outbound-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const imageRoot = path.join(root, 'image');
  const outputRoot = path.join(root, 'outputs');
  for (const directory of [stateDir, imageRoot, outputRoot]) fs.mkdirSync(directory);
  const calls = [];
  const telegramClient = { async getFile() { throw new Error('unused'); } };
  for (const method of ['sendPhoto', 'sendAnimation', 'sendDocument']) {
    telegramClient[method] = async (...args) => { calls.push({ method, args }); return { message_id: 501 }; };
  }
  const options = {
    stateDir, imageRoot, allowedOutputRoots: [outputRoot, imageRoot], vcpFileRoot: outputRoot,
    vcpImageKey: 'fixture-image-key', vcpFileKey: 'fixture-file-key', vcpPort: '6005',
    maxBytes: 1024, telegramClient, allowPortableStaging: true, ...extra,
  };
  return { root, stateDir, imageRoot, outputRoot, calls, options, resources: createOutboundResources(options) };
}

function denied(code) {
  return error => {
    assert.equal(error.name, 'OutboundResourceError');
    if (code) assert.equal(error.code, code);
    assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /fixture-file-key|signature=|private-secret|C:\\outputs|127\.0\.0\.1/);
    return true;
  };
}

// Native https.request-shaped seam: runs the production DNS policy and pinned
// lookup callback. No test can replace that policy with a permissive fetch.
function network(routes, addresses = [PUBLIC_IP]) {
  const calls = [];
  const lookups = [];
  return {
    calls, lookups,
    async lookup(host, options) {
      lookups.push({ host, options });
      return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    request(url, options, callback) {
      const request = new EventEmitter();
      let response;
      let destroyed = false;
      request.destroy = error => {
        destroyed = true;
        if (response) response.destroy();
        if (error) queueMicrotask(() => request.emit('error', error));
      };
      request.end = () => queueMicrotask(async () => {
        if (destroyed) return;
        try {
          const pin = await new Promise((resolve, reject) => options.lookup(new URL(url).hostname, {},
            (error, address, family) => error ? reject(error) : resolve({ address, family })));
          calls.push({ url: String(url), options, pin });
          const route = routes[calls.length - 1] ?? routes.at(-1);
          if (route.hang) return;
          response = route.stream ?? Readable.from(route.chunks ?? [route.bytes ?? PDF]);
          response.statusCode = route.status ?? 200;
          response.headers = { 'content-type': 'application/pdf', ...route.headers };
          response.socket = { remoteAddress: route.peer ?? pin.address };
          callback(response);
        } catch (error) { request.emit('error', error); }
      });
      return request;
    },
  };
}

test('local documents are copied, persisted without source paths, and sent from verified outbox bytes', async t => {
  const item = fixture(t);
  const original = path.join(item.outputRoot, 'private-secret.pdf');
  fs.writeFileSync(original, PDF);
  const media = await item.resources.resolve(candidate(pathToFileURL(original).href));
  assert.equal(media.mediaKind, 'document');
  assert.equal(media.storageRoot, 'outbox');
  assert.equal(media.mime, 'application/pdf');
  assert.equal(media.size, PDF.length);
  assert.match(media.relativePath, /^[a-f0-9]{32}\.pdf$/);
  assert.doesNotMatch(JSON.stringify(media), /private-secret|file:|outputs|fixture-/);
  assert.deepEqual(fs.readFileSync(path.join(item.stateDir, 'outbox', media.relativePath)), PDF);
  fs.unlinkSync(original);
  const signal = new AbortController().signal;
  const result = await item.resources.send({ chatId: '42', threadId: '9', media: JSON.parse(JSON.stringify(media)), signal, replyToMessageId: '7' });
  assert.deepEqual(result, { messageId: '501' });
  assert.equal(item.calls[0].method, 'sendDocument');
  assert.deepEqual(item.calls[0].args[0], { chat_id: '42', message_thread_id: '9', reply_parameters: { message_id: '7' } });
  assert.equal(item.calls[0].args[3].signal, signal);
  assert.deepEqual(Buffer.from(await item.calls[0].args[1].arrayBuffer()), PDF);
});

test('text, CSV and JSON outputs preserve MIME and enforce local MIME and byte limits', async t => {
  const item = fixture(t, { maxBytes: 64 });
  for (const [name, content, mime] of [
    ['résumé.txt', 'owner output 文本', 'text/plain'],
    ['report.csv', 'name,value\na,2\n', 'text/csv'],
    ['report.json', '{"complete":true}', 'application/json'],
  ]) {
    const target = path.join(item.outputRoot, name);
    fs.writeFileSync(target, content);
    const media = await item.resources.resolve(candidate(pathToFileURL(target).href));
    assert.equal(media.mime, mime);
    await item.resources.send({ chatId: '42', media });
  }
  for (const [name, content] of [['spoof.pdf', 'not pdf'], ['large.txt', 'x'.repeat(65)], ['empty.txt', ''], ['bad.json', 'not json'], ['html.txt', '<html>no</html>']]) {
    const target = path.join(item.outputRoot, name);
    fs.writeFileSync(target, content);
    await assert.rejects(item.resources.resolve(candidate(pathToFileURL(target).href)), denied());
  }
});

test('configured roots may live in a worktree, but secret directories remain denied', async t => {
  const item = fixture(t);
  const worktree = path.join(item.outputRoot, '.worktrees', 'plugin');
  fs.mkdirSync(worktree, { recursive: true });
  const target = path.join(worktree, 'ok.pdf');
  fs.writeFileSync(target, PDF);
  const { createOutboundResources } = require('../src/outboundResources');
  const resources = createOutboundResources({ ...item.options, allowedOutputRoots: [worktree], vcpFileRoot: worktree });
  const media = await resources.resolve(candidate(pathToFileURL(target).href));
  assert.equal(media.mime, 'application/pdf');
});

test('VCP file roots must be allowlisted and ambiguous implicit matches are denied', async t => {
  const item = fixture(t);
  const { createOutboundResources } = require('../src/outboundResources');
  assert.throws(() => createOutboundResources({ ...item.options, vcpFileRoot: item.root }), denied('OUTBOUND_CONFIG_INVALID'));
  const resources = createOutboundResources({ ...item.options, vcpFileRoot: undefined });
  fs.writeFileSync(path.join(item.outputRoot, 'a.pdf'), PDF);
  const url = 'http://localhost:6005/pw=fixture-file-key/files/a.pdf';
  assert.equal((await resources.resolve(candidate(url))).mime, 'application/pdf');
  fs.writeFileSync(path.join(item.imageRoot, 'a.pdf'), PDF);
  await assert.rejects(resources.resolve(candidate(url)), denied('OUTBOUND_ROOT_DENIED'));
});

test('staged hardlink and outbox junction replacement cannot send or write outside state', async t => {
  const item = fixture(t);
  const target = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(target, PDF);
  const media = await item.resources.resolve(candidate(pathToFileURL(target).href));
  const staged = path.join(item.stateDir, 'outbox', media.relativePath);
  fs.linkSync(staged, path.join(item.outputRoot, 'hard.pdf'));
  await assert.rejects(item.resources.send({ chatId: '42', media }), denied('OUTBOUND_LINK_DENIED'));
  const outbox = path.join(item.stateDir, 'outbox');
  fs.renameSync(outbox, path.join(item.stateDir, 'previous-outbox'));
  const outside = path.join(item.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, outbox, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(target).href)), denied('OUTBOUND_LINK_DENIED'));
  await assert.rejects(item.resources.send({ chatId: '42', media }), denied());
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(item.calls.length, 0);
});

test('non-Linux staging fails closed unless trusted portable staging is explicitly selected', {
  skip: process.platform === 'linux',
}, async t => {
  const item = fixture(t, { allowPortableStaging: false });
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(source).href)), denied('OUTBOUND_STAGING_UNSUPPORTED'));
  assert.equal(fs.existsSync(path.join(item.stateDir, 'outbox')), false);
});

test('Linux outbox swap at the creation boundary cannot redirect writes or cleanup', {
  skip: process.platform !== 'linux',
}, async t => {
  const item = fixture(t, { allowPortableStaging: false });
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  const outbox = path.join(item.stateDir, 'outbox');
  const previous = path.join(item.stateDir, 'previous-outbox');
  const outside = path.join(item.root, 'outside');
  fs.mkdirSync(outbox);
  fs.mkdirSync(outside);
  const originalOpen = fs.openSync;
  let swapped = false;
  t.mock.method(fs, 'openSync', function (target, flags, ...args) {
    if (!swapped && typeof target === 'string' && /^[a-f0-9]{32}\.pdf$/.test(path.basename(target))) {
      swapped = true;
      fs.renameSync(outbox, previous);
      fs.symlinkSync(outside, outbox, 'dir');
    }
    return originalOpen.call(fs, target, flags, ...args);
  });
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(source).href)), denied());
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), [], 'replacement destination must remain untouched');
  assert.deepEqual(fs.readdirSync(previous), [], 'cleanup must use the original directory descriptor');
});

test('Linux pre-open outbox symlink swap is rejected before file creation', {
  skip: process.platform !== 'linux',
}, async t => {
  const item = fixture(t, { allowPortableStaging: false });
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  const outside = path.join(item.root, 'outside');
  fs.mkdirSync(outside);
  const originalOpen = fs.openSync;
  let swapped = false;
  t.mock.method(fs, 'openSync', function (target, flags, ...args) {
    if (!swapped && typeof target === 'string' && /^\/proc\/self\/fd\/\d+\/outbox$/.test(target)) {
      swapped = true;
      const outbox = path.join(item.stateDir, 'outbox');
      fs.renameSync(outbox, path.join(item.stateDir, 'previous-outbox'));
      fs.symlinkSync(outside, outbox, 'dir');
    }
    return originalOpen.call(fs, target, flags, ...args);
  });
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(source).href)), denied());
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Linux failed-write cleanup stays anchored after a parent swap and preserves replacement files', {
  skip: process.platform !== 'linux',
}, async t => {
  const item = fixture(t, { allowPortableStaging: false });
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  const outbox = path.join(item.stateDir, 'outbox');
  const previous = path.join(item.stateDir, 'previous-outbox');
  const outside = path.join(item.root, 'outside');
  fs.mkdirSync(outside);
  const originalWrite = fs.writeFileSync;
  let replacement;
  t.mock.method(fs, 'writeFileSync', function (target, bytes, ...args) {
    const result = originalWrite.call(fs, target, bytes, ...args);
    if (typeof target === 'number') {
      const basename = path.basename(fs.readlinkSync('/proc/self/fd/' + target));
      fs.renameSync(outbox, previous);
      fs.symlinkSync(outside, outbox, 'dir');
      replacement = path.join(outside, basename);
      originalWrite.call(fs, replacement, 'replacement must remain');
      throw new Error('private-secret');
    }
    return result;
  });
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(source).href)), denied());
  assert.deepEqual(fs.readdirSync(previous), []);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement must remain');
});

test('VCP files use the explicit file root and key without making HTTP requests', async t => {
  const item = fixture(t, { request() { assert.fail('local URLs must never be requested'); } });
  fs.writeFileSync(path.join(item.outputRoot, 'report.pdf'), PDF);
  fs.writeFileSync(path.join(item.imageRoot, 'report.pdf'), Buffer.from('wrong root'));
  const media = await item.resources.resolve(candidate('http://localhost:6005/pw=fixture-file-key/files/report.pdf'));
  assert.equal(media.size, PDF.length);
  for (const url of [
    'http://localhost:6005/pw=wrong-key/files/report.pdf',
    'http://localhost:6006/pw=fixture-file-key/files/report.pdf',
    'http://localhost:6005/pw=fixture-file-key/files/sub/../report.pdf',
    'http://localhost:6005/pw=fixture-file-key/files/%2e%2e/report.pdf',
    'http://localhost:6005/pw=fixture-file-key/files/%252e%252e/report.pdf',
    'http://localhost:6005/pw=fixture-file-key/files/report.pdf?key=private-secret',
    'https://public.example/pw=fixture-file-key/files/report.pdf',
  ]) await assert.rejects(item.resources.resolve(candidate(url)), denied());
});

test('local secrets, traversal, outside paths, hardlinks and symlink ancestors are denied', async t => {
  const item = fixture(t);
  for (const relative of ['config.env', '.env.local', 'id_rsa', 'private.key', 'credentials.json', 'browser-profile/ok.pdf', '.ssh/ok.pdf', 'Chrome/Default/ok.pdf', 'a.pem/report.pdf']) {
    const target = path.join(item.outputRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, PDF);
    await assert.rejects(item.resources.resolve(candidate(pathToFileURL(target).href)), denied());
  }
  const outside = path.join(item.root, 'outside.pdf');
  fs.writeFileSync(outside, PDF);
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(outside).href)), denied());
  const hardlink = path.join(item.outputRoot, 'hard.pdf');
  fs.linkSync(outside, hardlink);
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(hardlink).href)), denied());
  const directory = path.join(item.outputRoot, 'linked');
  fs.symlinkSync(item.imageRoot, directory, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(item.imageRoot, 'ok.pdf'), PDF);
  await assert.rejects(item.resources.resolve(candidate(pathToFileURL(path.join(directory, 'ok.pdf')).href)), denied());
  const rootUrl = pathToFileURL(item.outputRoot).href;
  await assert.rejects(item.resources.resolve(candidate(rootUrl + '/sub/../ok.pdf')), denied());
});

test('send rejects changed bytes, forged descriptors and aborted sends before Telegram', async t => {
  const item = fixture(t);
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  const media = await item.resources.resolve(candidate(pathToFileURL(source).href));
  for (const changed of [
    { relativePath: '../outputs/a.pdf' }, { relativePath: source }, { mime: 'image/png' },
    { mediaKind: 'photo' }, { sha256: '0'.repeat(64) }, { storageRoot: 'unknown' },
  ]) await assert.rejects(item.resources.send({ chatId: '42', media: { ...media, ...changed } }), denied());
  const control = new AbortController();
  control.abort();
  await assert.rejects(item.resources.send({ chatId: '42', media, signal: control.signal }), denied('OUTBOUND_ABORTED'));
  fs.writeFileSync(path.join(item.stateDir, 'outbox', media.relativePath), Buffer.from('%PDF-changed'));
  await assert.rejects(item.resources.send({ chatId: '42', media }), denied('OUTBOUND_CHANGED'));
  assert.equal(item.calls.length, 0);
});

test('public HTTPS resources pin validated DNS and forward no credentials or Bot client data', async t => {
  const net = network([{ bytes: PDF }]);
  const item = fixture(t, net);
  const media = await item.resources.resolve(candidate('https://cdn.example/report.pdf?signature=private-secret'));
  assert.equal(media.mediaKind, 'document');
  assert.equal(net.calls[0].pin.address, PUBLIC_IP);
  assert.equal(net.calls[0].options.agent, false);
  assert.equal(net.calls[0].options.rejectUnauthorized, true);
  assert.equal(net.calls[0].options.servername, 'cdn.example');
  assert.deepEqual(net.calls[0].options.headers, { accept: '*/*', 'accept-encoding': 'identity' });
  assert.doesNotMatch(JSON.stringify(media), /private-secret|cdn\.example|signature/);
  assert.equal(item.calls.length, 0);
});

test('private, reserved and mixed DNS answers are rejected before requests', async t => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) {
    const net = network([{}], [PUBLIC_IP, ip]);
    const item = fixture(t, net);
    await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
    assert.equal(net.calls.length, 0, ip);
  }
});

test('DNS receives cancellation and IPv4 is preferred only after every address passes policy', async t => {
  const net = network([{ bytes: PDF }], ['2606:4700::6812:1713', PUBLIC_IP]);
  const item = fixture(t, net);
  await item.resources.resolve(candidate('https://cdn.example/a.pdf'));
  assert.ok(net.lookups[0].options.signal instanceof AbortSignal);
  assert.equal(net.calls[0].pin.address, PUBLIC_IP);
  const lookup = net.calls[0].options.lookup;
  for (const all of [false, true]) {
    const result = await new Promise(resolve => lookup('cdn.example', { all }, (...values) => resolve(values)));
    assert.deepEqual(result, all ? [null, [{ address: PUBLIC_IP, family: 4 }]] : [null, PUBLIC_IP, 4]);
  }
});

test('resource deadline and caller cancellation reach a stalled DNS lookup', async t => {
  for (const abort of [false, true]) {
    let dnsSignal;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const item = fixture(t, {
      timeoutMs: 30,
      lookup(host, { signal }) { dnsSignal = signal; started(); return new Promise(() => {}); },
      request() { assert.fail('DNS did not resolve'); },
    });
    const controller = new AbortController();
    const operation = item.resources.resolve(candidate('https://cdn.example/a.pdf'), { signal: controller.signal });
    const rejection = assert.rejects(operation, denied(abort ? 'OUTBOUND_ABORTED' : 'OUTBOUND_TIMEOUT'));
    await ready;
    if (abort) controller.abort(new Error('private-secret'));
    await rejection;
    assert.equal(dnsSignal?.aborted, true);
  }
});

test('redirect domain resolving to a private address is denied before its transport', async t => {
  const net = network([{ status: 302, headers: { location: 'https://second.example/a.pdf' } }]);
  const item = fixture(t, { ...net, async lookup(host, options) {
    if (host === 'second.example') return [{ address: '10.0.0.1', family: 4 }];
    return net.lookup(host, options);
  } });
  await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
  assert.equal(net.calls.length, 1);
});

function doh(answersFor, { hang = false } = {}) {
  const calls = [];
  const { createOutboundDnsLookup } = require('../src/outboundDns');
  const lookup = createOutboundDnsLookup({ request(url, options, callback) {
    const target = new URL(url);
    const host = target.searchParams.get('name');
    const type = target.searchParams.get('type') === 'A' ? 1 : 28;
    const req = new EventEmitter();
    const call = { target, destroyed: false };
    calls.push(call);
    req.destroy = () => { call.destroyed = true; return req; };
    req.end = () => {
      if (hang) return;
      queueMicrotask(() => {
        const body = { Status: 0, Question: [{ name: host + '.', type }],
          Answer: answersFor(host).filter(address => address.includes(':') === (type === 28))
            .map(address => ({ name: host + '.', type, TTL: 0, data: address })) };
        const response = Readable.from([Buffer.from(JSON.stringify(body))]);
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/dns-json' };
        response.rawHeaders = ['content-type', 'application/dns-json'];
        response.socket = { remoteAddress: '1.1.1.1' };
        callback(response);
      });
    };
    return req;
  } });
  return { lookup, calls };
}

test('real sidecar results still undergo all public-address checks before resource transport', async t => {
  for (const addresses of [
    [PUBLIC_IP, '198.18.0.191'], [PUBLIC_IP, '10.0.0.1'], [PUBLIC_IP, '::1'],
    [PUBLIC_IP, '::ffff:127.0.0.1'], [PUBLIC_IP, 'fc00::1'],
  ]) {
    const resolver = doh(() => addresses);
    const net = network([{}]);
    const item = fixture(t, { ...net, lookup: resolver.lookup });
    await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
    assert.equal(net.calls.length, 0);
    assert.equal(resolver.calls.length, 2);
  }
});

test('real sidecar resolves and pins public resources without receiving URL secrets', async t => {
  const resolver = doh(() => ['104.18.23.19', '104.18.22.19', '2606:4700::6812:1713']);
  const net = network([{ bytes: PDF }]);
  const item = fixture(t, { ...net, lookup: resolver.lookup });
  const media = await item.resources.resolve(candidate('https://www.w3.org/private-secret.pdf?signature=private-secret'));
  assert.equal(media.mime, 'application/pdf');
  assert.equal(net.calls[0].pin.address, '104.18.23.19');
  assert.equal(resolver.calls.length, 2);
  for (const call of resolver.calls) {
    assert.equal(call.target.searchParams.get('name'), 'www.w3.org');
    assert.doesNotMatch(call.target.href, /private-secret|signature|\.pdf/);
  }
});

test('real sidecar revalidates redirect answers and preserves peer pin protection', async t => {
  const resolver = doh(host => host === 'second.example' ? ['10.0.0.1'] : [PUBLIC_IP]);
  const net = network([{ status: 302, headers: { location: 'https://second.example/a.pdf' } }]);
  const item = fixture(t, { ...net, lookup: resolver.lookup });
  await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
  assert.equal(net.calls.length, 1);
  assert.equal(resolver.calls.length, 4);
  const peer = fixture(t, { ...network([{ peer: '127.0.0.1' }]), lookup: resolver.lookup });
  await assert.rejects(peer.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
});

test('resource cancellation destroys both actual sidecar requests before its own deadline', async t => {
  for (const abort of [false, true]) {
    const resolver = doh(() => [], { hang: true });
    const item = fixture(t, { lookup: resolver.lookup, timeoutMs: 30,
      request() { assert.fail('DNS did not resolve'); } });
    const controller = new AbortController();
    const operation = item.resources.resolve(candidate('https://cdn.example/a.pdf'), { signal: controller.signal });
    const rejection = assert.rejects(operation, denied(abort ? 'OUTBOUND_ABORTED' : 'OUTBOUND_TIMEOUT'));
    await new Promise(resolve => setImmediate(resolve));
    if (abort) controller.abort(new Error('private-secret'));
    await rejection;
    assert.equal(resolver.calls.length, 2);
    assert.ok(resolver.calls.every(call => call.destroyed));
  }
});

test('unsafe protocols, numeric hosts, userinfo, and VCP keys never reach the transport', async t => {
  const net = network([{}]);
  const item = fixture(t, net);
  for (const url of [
    'http://public.example/a.pdf', 'https://127.1/a.pdf', 'https://2130706433/a.pdf',
    'https://[::1]/a.pdf', 'https://user:private-secret@cdn.example/a.pdf',
    'https://cdn.example:8443/a.pdf', 'https://cdn.example/a.pdf?key=fixture-file-key',
    'file://remote-server/share/report.pdf',
  ]) await assert.rejects(item.resources.resolve(candidate(url)), denied());
  assert.equal(net.calls.length, 0);
});

test('nested encoded configured keys are checked at every decoding layer before DNS', async t => {
  const net = network([{}]);
  const item = fixture(t, net);
  for (const key of ['fixture-file-key', 'fixture-image-key']) {
    let encoded = key.replace(/-/g, '%2D');
    for (let depth = 0; depth < 7; depth++) {
      await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf?x=' + encoded)), denied('OUTBOUND_URL_DENIED'));
      encoded = encoded.replace(/%/g, '%25');
    }
  }
  const deep = '%252525252541';
  await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf?x=' + deep)), denied('OUTBOUND_URL_DENIED'));
  assert.equal(net.lookups.length, 0);
  assert.equal(net.calls.length, 0);
});

test('safe Telegram errors retain only allowlisted codes and bounded retry delay', async t => {
  const item = fixture(t);
  const source = path.join(item.outputRoot, 'a.pdf');
  fs.writeFileSync(source, PDF);
  const media = await item.resources.resolve(candidate(pathToFileURL(source).href));
  for (const [code, rawDelay, expectedDelay] of [
    ['TELEGRAM_RATE_LIMIT', 17, 17], ['TELEGRAM_ABORTED', 99, undefined],
    ['TELEGRAM_RATE_LIMIT', Infinity, undefined], ['TELEGRAM_RATE_LIMIT', -1, undefined],
    ['TELEGRAM_RATE_LIMIT', '17', undefined], ['TELEGRAM_RATE_LIMIT', 2 ** 40, undefined],
    ['TELEGRAM_NETWORK', 17, undefined], ['PRIVATE_secret_CODE', 17, undefined],
  ]) {
    item.options.telegramClient.sendDocument = async () => {
      throw Object.assign(new Error('private-secret fixture-file-key'), { code, retryAfterSec: rawDelay,
        url: 'https://bot.invalid/private-secret', token: 'private-secret', retryable: true });
    };
    await assert.rejects(item.resources.send({ chatId: '42', media }), error => {
      assert.equal(error.code, code === 'PRIVATE_secret_CODE' ? 'OUTBOUND_SEND_FAILED' : code);
      assert.equal(error.retryAfterSec, expectedDelay);
      assert.deepEqual(Object.keys(error).sort(), expectedDelay === undefined ? ['code'] : ['code', 'retryAfterSec']);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private-secret|fixture-file-key|PRIVATE_secret_CODE/);
      return true;
    });
  }
});

test('redirect hops revalidate DNS and protocol, with bounded redirects and peer checks', async t => {
  const good = network([
    { status: 302, headers: { location: 'https://second.example/a.pdf' } }, { bytes: PDF },
  ]);
  const item = fixture(t, good);
  await item.resources.resolve(candidate('https://cdn.example/a.pdf'));
  assert.deepEqual(good.lookups.map(value => value.host), ['cdn.example', 'second.example']);
  for (const location of ['http://cdn.example/a.pdf', 'https://127.0.0.1/a.pdf', 'file:///etc/passwd', 'https://user:pass@cdn.example/a.pdf']) {
    const net = network([{ status: 302, headers: { location } }]);
    const blocked = fixture(t, net);
    await assert.rejects(blocked.resources.resolve(candidate('https://cdn.example/a.pdf')), denied());
    assert.equal(net.calls.length, 1);
  }
  const loop = fixture(t, { ...network([{ status: 302, headers: { location: '/a.pdf' } }]), maxRedirects: 1 });
  await assert.rejects(loop.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_REDIRECT_LIMIT'));
  const peer = fixture(t, network([{ peer: '127.0.0.1' }]));
  await assert.rejects(peer.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_HOST_DENIED'));
});

test('actual bytes, MIME spoofing, encoding and HTTP errors fail without staged files', async t => {
  for (const route of [
    { chunks: [PDF, Buffer.alloc(1024)], headers: { 'content-length': '1' } },
    { headers: { 'content-length': '999999' } },
    { bytes: Buffer.from('<html>error</html>') },
    { bytes: PNG },
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-encoding': 'gzip' } },
    { status: 401 }, { bytes: Buffer.alloc(0) },
  ]) {
    const item = fixture(t, network([route]));
    await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied());
    const outbox = path.join(item.stateDir, 'outbox');
    assert.deepEqual(fs.existsSync(outbox) ? fs.readdirSync(outbox) : [], []);
  }
});

test('timeouts cover stalled DNS, headers and bodies; aborts are sanitized', async t => {
  for (const net of [
    { lookup: () => new Promise(() => {}), request() { assert.fail('DNS did not complete'); } },
    network([{ hang: true }]),
    network([{ stream: new Readable({ read() {} }) }]),
  ]) {
    const item = fixture(t, { ...net, timeoutMs: 30 });
    await assert.rejects(item.resources.resolve(candidate('https://cdn.example/a.pdf')), denied('OUTBOUND_TIMEOUT'));
  }
  const item = fixture(t, network([{ hang: true }]));
  const controller = new AbortController();
  const operation = item.resources.resolve(candidate('https://cdn.example/a.pdf'), { signal: controller.signal });
  controller.abort(new Error('private-secret'));
  await assert.rejects(operation, denied('OUTBOUND_ABORTED'));
});

test('remote images stage and choose photo/animation, while old local images omit storageRoot', async t => {
  const item = fixture(t, network([
    { bytes: PNG, headers: { 'content-type': 'image/png' } },
    { bytes: GIF, headers: { 'content-type': 'image/gif' } },
  ]));
  for (const [file, kind] of [['a.png', 'photo'], ['a.gif', 'animation']]) {
    const media = await item.resources.resolve(candidate('https://cdn.example/' + file, true));
    assert.equal(media.mediaKind, kind);
    assert.equal(media.storageRoot, 'outbox');
    await item.resources.send({ chatId: '42', media });
  }
  assert.deepEqual(item.calls.map(call => call.method), ['sendPhoto', 'sendAnimation']);
  fs.writeFileSync(path.join(item.imageRoot, 'old.png'), PNG);
  const bridge = createAttachmentBridge({ ...item.options, maxInboundBytes: 1024, maxOutboundBytes: 1024,
    database: { prepare() { assert.fail('not used'); } } });
  const { createOutboundResources } = require('../src/outboundResources');
  const resources = createOutboundResources({ ...item.options, attachmentBridge: bridge });
  const media = await resources.resolve(candidate('old.png', true));
  assert.equal(Object.hasOwn(media, 'storageRoot'), false);
  assert.equal(media.relativePath, 'old.png');
  await resources.send({ chatId: '42', media });
  assert.equal(item.calls.at(-1).method, 'sendPhoto');
});

// Hosted Windows runners may expose TEMP through an 8.3 alias. Fixtures use
// the same physical paths that the bridge persists; containment checks stay strict.
function physicalTempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(prefix));
}

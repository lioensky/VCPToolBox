'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const https = require('node:https');
const tls = require('node:tls');
const { Readable } = require('node:stream');
const test = require('node:test');

const HOST = 'private-host.example';
const IPV4 = '104.18.23.19';
const IPV6 = '2606:4700::6812:1713';
const secret = () => Object.assign(new Error('private-secret ' + HOST), { code: HOST, token: 'private-secret' });
const record = (type, data, name = HOST + '.') => ({ name, type, TTL: 1, data });
const answer = (type, records = [record(type, type === 1 ? IPV4 : IPV6)]) => ({
  Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
  Question: [{ name: HOST + '.', type }], Answer: records,
});
function factory(options) {
  // Missing module is an assertion failure in the initial RED run.
  let exported;
  try { exported = require('../src/outboundDns'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof exported?.createOutboundDnsLookup, 'function', 'resolver factory must exist');
  return exported.createOutboundDnsLookup(options);
}
function denied(code) {
  return error => {
    assert.equal(error.name, 'OutboundDnsError');
    if (code) assert.equal(error.code, code);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /private-secret|private-host|104\.18|1\.1\.1\.1/);
    return true;
  };
}

// Only the network boundary is replaced; response streams, parsing, validation,
// cancellation and the Node lookup callback are all production behavior.
function transport(routeFor = () => ({})) {
  const calls = [];
  function request(url, options, callback) {
    const target = new URL(url);
    const type = { A: 1, AAAA: 28 }[target.searchParams.get('type')] ?? Number(target.searchParams.get('type'));
    const route = routeFor(type, target);
    if (route.throw) throw secret();
    const req = new EventEmitter();
    const call = { target, options, type, req, destroyed: false, response: null, deliver: null };
    calls.push(call);
    req.destroy = () => { call.destroyed = true; return req; };
    req.end = () => {
      call.ended = true;
      call.deliver = () => {
        if (route.error) { req.emit('error', secret()); return; }
        const bytes = route.bytes ?? Buffer.from(JSON.stringify(route.json ?? answer(type)));
        const response = route.stream ?? Readable.from(route.chunks ?? [bytes]);
        response.statusCode = route.status ?? 200;
        response.headers = { 'content-type': 'application/dns-json', ...route.headers };
        response.rawHeaders = route.rawHeaders ?? Object.entries(response.headers).flat();
        response.socket = { remoteAddress: route.peer ?? '1.1.1.1' };
        call.response = response;
        callback(response);
      };
      if (!route.hang && !route.manual) queueMicrotask(call.deliver);
    };
    return req;
  }
  return { calls, request };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('parallel A/AAAA requests use only the fixed TLS-verified pinned DNS origin', async () => {
  const wire = transport(() => ({ manual: true }));
  const lookup = factory({ request: wire.request });
  const operation = lookup(HOST);
  assert.equal(wire.calls.length, 2, 'both queries must start before either response');
  for (const call of wire.calls) {
    assert.equal(call.ended, true);
    assert.equal(call.target.origin, 'https://cloudflare-dns.com');
    assert.equal(call.target.pathname, '/dns-query');
    assert.equal(call.target.searchParams.get('name'), HOST);
    assert.deepEqual([...call.target.searchParams.keys()].sort(), ['name', 'type']);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.servername, 'cloudflare-dns.com');
    assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.options.checkServerIdentity, tls.checkServerIdentity);
    assert.ok(call.options.agent instanceof https.Agent);
    assert.notEqual(call.options.agent, https.globalAgent);
    assert.deepEqual(call.options.agent.options.proxyEnv, {});
    assert.deepEqual(call.options.headers, { accept: 'application/dns-json', 'accept-encoding': 'identity' });
    assert.equal(call.options.maxHeaderSize, 16 * 1024);
    assert.equal(call.req.maxHeadersCount, 65, 'retain one overflow header to reject instead of truncate');
    for (const all of [false, true]) {
      const values = await new Promise(resolve => call.options.lookup('cloudflare-dns.com', { all }, (...args) => resolve(args)));
      assert.deepEqual(values, all ? [null, [{ address: '1.1.1.1', family: 4 }]] : [null, '1.1.1.1', 4]);
    }
    await new Promise(resolve => call.options.lookup(HOST, {}, error => { denied()(error); resolve(); }));
  }
  wire.calls[1].deliver();
  wire.calls[0].deliver();
  assert.deepEqual(await operation, [{ address: IPV4, family: 4 }, { address: IPV6, family: 6 }]);
  assert.ok(wire.calls.every(call => call.destroyed && call.response.destroyed));
});

test('unique canonical addresses are IPv4 first; TTL is irrelevant and no cache is kept', async () => {
  const wire = transport(type => ({ json: answer(type, type === 1
    ? [record(1, IPV4), record(1, IPV4), { ...record(1, '104.18.22.19'), TTL: null }]
    : [record(28, '2606:4700:0:0:0:0:6812:1713'), record(28, IPV6.toUpperCase())]) }));
  const lookup = factory({ request: wire.request });
  for (let index = 0; index < 2; index++) assert.deepEqual(await lookup(HOST.toUpperCase() + '.', { all: true }), [
    { address: IPV4, family: 4 }, { address: '104.18.22.19', family: 4 }, { address: IPV6, family: 6 },
  ]);
  assert.equal(wire.calls.length, 4);
});

test('one NODATA family is allowed, but zero total addresses fail closed', async () => {
  for (const empty of [1, 28]) {
    const wire = transport(type => ({ json: answer(type, type === empty ? [] : undefined) }));
    assert.deepEqual(await factory({ request: wire.request })(HOST), [
      empty === 1 ? { address: IPV6, family: 6 } : { address: IPV4, family: 4 },
    ]);
  }
  const wire = transport(type => ({ json: { ...answer(type), Answer: undefined } }));
  await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_EMPTY'));
});

test('valid unordered CNAME chains resolve only their terminal owner without more requests', async () => {
  const wire = transport(type => ({ json: answer(type, [
    record(type, type === 1 ? IPV4 : IPV6, 'terminal.example.'),
    record(5, 'terminal.example.', 'alias.example.'),
    record(5, 'Alias.Example.', HOST.toUpperCase() + '.'),
  ]) }));
  assert.deepEqual(await factory({ request: wire.request })(HOST), [{ address: IPV4, family: 4 }, { address: IPV6, family: 6 }]);
  assert.equal(wire.calls.length, 2);
});

test('invalid hostname, lookup options and timeout configuration are rejected before transport', async () => {
  const wire = transport();
  const lookup = factory({ request: wire.request });
  for (const host of [undefined, null, {}, '', 'localhost', '127.0.0.1', '127.1', '::1', 'https://' + HOST,
    HOST + '/private-secret', HOST + '?token=private-secret', 'user@' + HOST, HOST + ':443', HOST + '\n',
    '-bad.example', 'bad-.example', 'bad..example', 'bad_name.example', 'a'.repeat(64) + '.example',
    ('a'.repeat(63) + '.').repeat(4) + 'example', 'host.local', 'host.internal', 'host.onion', '中文.example']) {
    await assert.rejects(lookup(host), denied('OUTBOUND_DNS_INPUT_INVALID'));
  }
  for (const options of [null, [], { all: false }, { signal: {} }]) {
    await assert.rejects(lookup(HOST, options), denied('OUTBOUND_DNS_INPUT_INVALID'));
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '100', 120001]) {
    assert.throws(() => factory({ request: wire.request, timeoutMs }), denied('OUTBOUND_DNS_CONFIG_INVALID'));
  }
  assert.throws(() => factory({ request: null }), denied('OUTBOUND_DNS_CONFIG_INVALID'));
  assert.equal(wire.calls.length, 0);
});

test('DNS status, question identity, record type and family are checked strictly', async () => {
  const bad = [
    null, [], {}, { ...answer(1), Status: 3 }, { ...answer(1), Status: '0' }, { ...answer(1), TC: true },
    { ...answer(1), TC: 'true' },
    { ...answer(1), Question: [] }, { ...answer(1), Question: [...answer(1).Question, ...answer(1).Question] },
    { ...answer(1), Question: [{ name: 'unrelated.example', type: 1 }] },
    { ...answer(1), Question: [{ name: HOST, type: 28 }] },
    { ...answer(1), Question: [{ name: HOST, type: '1' }] },
    { ...answer(1), Answer: {} }, { ...answer(1), Answer: [null] },
    answer(1, [record(1, IPV6)]), answer(1, [record('1', IPV4)]), answer(1, [record(28, IPV6)]),
    answer(1, [record(16, 'private-secret')]), answer(1, [record(1, '127.1')]),
    answer(1, [record(1, IPV4 + ' ')]), answer(1, [record(1, IPV4, 'unrelated.example')]),
  ];
  for (const json of bad) {
    const wire = transport(type => type === 1 ? { bytes: Buffer.from(JSON.stringify(json)) } : {});
    await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_RESPONSE_INVALID'));
    assert.ok(wire.calls.every(call => call.destroyed));
  }
  for (const data of [IPV4, 'fe80::1%eth0', '::bogus']) {
    const wire = transport(type => ({ json: answer(type, type === 28 ? [record(28, data)] : undefined) }));
    await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_RESPONSE_INVALID'));
  }
});

test('invalid configuration and throwing option accessors cannot disclose caller data', async () => {
  for (const options of [null, [], 'private-secret', { get request() { throw secret(); } }]) {
    assert.throws(() => factory(options), denied('OUTBOUND_DNS_CONFIG_INVALID'));
  }
  const wire = transport();
  const lookup = factory({ request: wire.request });
  for (const options of [{ get all() { throw secret(); } }, { get signal() { throw secret(); } }]) {
    await assert.rejects(lookup(HOST, options), denied('OUTBOUND_DNS_INPUT_INVALID'));
  }
  assert.equal(wire.calls.length, 0);
});

test('CNAME loops, conflicting owners, disconnected answers and intermediate addresses fail closed', async () => {
  for (const records of [
    [record(5, HOST)],
    [record(5, 'alias.example'), record(5, HOST, 'alias.example')],
    [record(5, 'alias.example'), record(5, 'other.example'), record(1, IPV4, 'alias.example')],
    [record(5, 'alias.example'), record(1, IPV4)],
    [record(5, 'alias.example'), record(1, IPV4, 'unrelated.example')],
    [record(1, IPV4), record(5, 'alias.example', 'unrelated.example')],
    [record(5, 'https://alias.example/private-secret')],
  ]) {
    const wire = transport(type => ({ json: answer(type, type === 1 ? records : undefined) }));
    await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_RESPONSE_INVALID'));
  }
});

test('answer records and combined returned addresses are bounded at 64', async () => {
  const records = count => Array.from({ length: count }, (_, index) => record(1, '104.18.0.' + (index + 1)));
  const good = transport(type => ({ json: answer(type, type === 1 ? records(64) : []) }));
  assert.equal((await factory({ request: good.request })(HOST)).length, 64);
  for (const wire of [
    transport(type => ({ json: answer(type, type === 1 ? records(65) : []) })),
    transport(type => ({ json: answer(type, type === 1 ? records(64) : undefined) })),
  ]) await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_RESPONSE_INVALID'));
});

test('only HTTP 200 DNS JSON with identity encoding from the pinned peer is accepted', async () => {
  for (const route of [
    ...[301, 302, 303, 307, 308, 204, 401, 429, 500].map(status => ({ status, headers: { location: 'https://other.example/private-secret' } })),
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': undefined } },
    { headers: { 'content-encoding': 'gzip' } }, { peer: '127.0.0.1' }, { peer: '1.0.0.1' },
  ]) {
    const wire = transport(() => route);
    await assert.rejects(factory({ request: wire.request })(HOST), denied());
    assert.equal(wire.calls.length, 2, 'no redirects, retries or system fallback');
    assert.ok(wire.calls.every(call => call.destroyed && (!call.response || call.response.destroyed)));
  }
  const good = transport(() => ({ peer: '::ffff:1.1.1.1', headers: { 'content-type': 'application/dns-json; charset=utf-8' } }));
  assert.equal((await factory({ request: good.request })(HOST)).length, 2);
});

test('JSON bytes, declared lengths and headers have hard bounds', async () => {
  for (const route of [
    { bytes: Buffer.from('not JSON private-secret') }, { bytes: Buffer.alloc(0) },
    { bytes: Buffer.concat([Buffer.from(JSON.stringify(answer(1))), Buffer.from([255])]) },
    { chunks: [Buffer.alloc(32768, 32), Buffer.alloc(32769, 32)] },
    { bytes: Buffer.alloc(65537, 32), headers: { 'content-length': '1' } },
    { headers: { 'content-length': '65537' } }, { headers: { 'content-length': '1' } },
    { headers: { 'content-length': '-1' } }, { headers: { 'content-length': 'NaN' } },
    { rawHeaders: ['x', 'x'.repeat(16384)] },
    { rawHeaders: Array.from({ length: 65 }, () => ['x', 'a']).flat() },
  ]) {
    const wire = transport(() => route);
    await assert.rejects(factory({ request: wire.request })(HOST), denied());
    assert.ok(wire.calls.every(call => call.destroyed && (!call.response || call.response.destroyed)));
  }
  const wire = transport(type => {
    const bytes = Buffer.from(JSON.stringify(answer(type)).padEnd(65536));
    return { bytes, headers: { 'content-length': String(bytes.length) } };
  });
  assert.equal((await factory({ request: wire.request })(HOST)).length, 2);
});

test('deadline destroys both header-stalled and body-stalled requests and removes caller listeners', async () => {
  for (const body of [false, true]) {
    const wire = transport(() => body ? { stream: new Readable({ read() {} }) } : { hang: true });
    const controller = new AbortController();
    await assert.rejects(factory({ request: wire.request, timeoutMs: 25 })(HOST, { signal: controller.signal }), denied('OUTBOUND_DNS_TIMEOUT'));
    assert.equal(wire.calls.length, 2);
    assert.ok(wire.calls.every(call => call.destroyed && (!call.response || call.response.destroyed)));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('abort before start, during headers and during body is sanitized with complete cleanup', async () => {
  for (const phase of ['before', 'headers', 'body']) {
    const controller = new AbortController();
    const wire = transport(() => phase === 'body' ? { stream: new Readable({ read() {} }) } : { hang: true });
    if (phase === 'before') controller.abort(secret());
    const operation = factory({ request: wire.request })(HOST, { signal: controller.signal });
    const rejection = assert.rejects(operation, denied('OUTBOUND_DNS_ABORTED'));
    if (phase !== 'before') { await turn(); controller.abort(secret()); }
    await rejection;
    assert.equal(wire.calls.length, phase === 'before' ? 0 : 2);
    assert.ok(wire.calls.every(call => call.destroyed && (!call.response || call.response.destroyed)));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('transport failures cancel the sibling, sanitize errors, and destroy late responses', async () => {
  for (const mode of ['throw', 'error']) {
    const wire = transport(type => type === 28 ? { [mode]: true } : { hang: true });
    await assert.rejects(factory({ request: wire.request })(HOST), denied('OUTBOUND_DNS_FAILED'));
    assert.ok(wire.calls.every(call => call.destroyed));
  }
  const wire = transport(() => ({ manual: true }));
  const controller = new AbortController();
  const operation = factory({ request: wire.request })(HOST, { signal: controller.signal });
  controller.abort(secret());
  await assert.rejects(operation, denied('OUTBOUND_DNS_ABORTED'));
  for (const call of wire.calls) {
    call.deliver();
    call.req.emit('error', secret());
    call.response.emit('error', secret());
    assert.equal(call.response.destroyed, true);
  }
});

test('response stream errors and premature close cannot yield partial addresses', async () => {
  for (const event of ['error', 'aborted', 'close']) {
    const wire = transport(type => type === 1 ? { stream: new Readable({ read() {} }) } : { hang: true });
    const operation = factory({ request: wire.request })(HOST);
    const rejection = assert.rejects(operation, denied('OUTBOUND_DNS_FAILED'));
    await turn();
    wire.calls[0].response.emit(event, secret());
    await rejection;
    assert.ok(wire.calls.every(call => call.destroyed));
  }
});

test('success clears the deadline and abort listener without aborting the caller', async t => {
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const timers = new Set();
  t.mock.method(global, 'setTimeout', (fn, ms) => {
    assert.equal(ms, 10000);
    const timer = nativeSetTimeout(fn, ms);
    timers.add(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => { timers.delete(timer); nativeClearTimeout(timer); });
  const controller = new AbortController();
  const wire = transport();
  await factory({ request: wire.request })(HOST, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(timers.size, 0);
  assert.equal(controller.signal.aborted, false);
});

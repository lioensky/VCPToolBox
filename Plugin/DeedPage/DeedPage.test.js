'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { processRequest, normalizeArguments, ENDPOINT, USER_AGENT } = require('./DeedPage');

const TOOLS = ['publish_site', 'get_site', 'delete_site'];

function mockServer({ sse = false, toolResult } = {}) {
    const requests = [];
    const authorizations = [];
    const fetch = async (url, init) => {
        const headers = new Headers(init.headers);
        assert.equal(String(url), ENDPOINT);
        assert.equal(headers.get('user-agent'), USER_AGENT);
        authorizations.push(headers.get('authorization'));
        assert.ok(init.signal, 'SDK requests remain cancellable');
        if (init.method === 'GET') {
            requests.push({ method: 'GET' });
            return new Response(null, { status: 405 });
        }
        const message = JSON.parse(init.body);
        requests.push(message);
        if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
        let result;
        if (message.method === 'initialize') {
            result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
        } else if (message.method === 'tools/list') {
            result = { tools: TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })) };
        } else if (message.method === 'tools/call') {
            const data = toolResult || { ok: true, url: 'https://quiet-river-ab12.deed.page/', slug: 'quiet-river-ab12', token: 'deed_tok_fixture' };
            result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } else throw new Error(`Unexpected method ${message.method}`);
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        const useSse = sse && message.method === 'tools/call';
        return new Response(useSse ? `event: message\ndata: ${body}\n\n` : body, {
            headers: { 'Content-Type': useSse ? 'text/event-stream' : 'application/json' }
        });
    };
    return { fetch, requests, authorizations };
}

test('publish sends HTML as index.html anonymously and returns the parsed result', async () => {
    const server = mockServer();
    const result = await processRequest({ command: 'publish_site', html: '<h1>Hi</h1>', slug: 'weekly-report', ttl_seconds: '3600' }, { ...server, token: '' });
    assert.equal(result.status, 'success');
    assert.equal(result.result.url, 'https://quiet-river-ab12.deed.page/');
    assert.equal(result.result.token, 'deed_tok_fixture');
    assert.deepEqual(server.requests.find(r => r.method === 'tools/call').params, {
        name: 'publish_site', arguments: { files: { 'index.html': '<h1>Hi</h1>' }, slug: 'weekly-report', ttl_seconds: 3600 }
    });
    assert.ok(server.requests.some(r => r.method === 'tools/list'));
    assert.ok(server.authorizations.every(value => value === null));
});

test('a configured token is sent as a Bearer header and SSE results are parsed', async () => {
    const server = mockServer({ sse: true, toolResult: { ok: true, deleted: 'weekly-report' } });
    const result = await processRequest({ command: 'delete_site', slug: 'weekly-report' }, { ...server, token: ' deed_tok_saved ' });
    assert.equal(result.status, 'success');
    assert.equal(result.result.deleted, 'weekly-report');
    assert.deepEqual(server.requests.find(r => r.method === 'tools/call').params.arguments, { slug: 'weekly-report' });
    assert.ok(server.authorizations.every(value => value === 'Bearer deed_tok_saved'));
});

test('ok:false results become VCP errors with details', async () => {
    const server = mockServer({ toolResult: { ok: false, error: 'slug_taken', message: 'That slug belongs to another owner.' } });
    const result = await processRequest({ command: 'publish_site', html: '<h1>Hi</h1>', slug: 'taken' }, { ...server, token: '' });
    assert.equal(result.status, 'error');
    assert.match(result.error, /slug_taken/);
    assert.equal(result.result.error, 'slug_taken');
});

test('HTTP failures propagate without retrying the request', async () => {
    let calls = 0;
    await assert.rejects(processRequest({ command: 'get_site', slug: 'weekly-report' }, {
        token: '',
        fetch: async () => {
            calls++;
            return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
        }
    }), error => error.code === 429 && /rate limited/.test(error.message));
    assert.equal(calls, 1);
});

test('invalid VCP arguments fail before sending requests', async () => {
    const noNetwork = { token: '', fetch: () => { assert.fail('Invalid input reached network'); } };
    for (const input of [null, [], { command: 'other' }, { command: 'publish_site' }, { command: 'publish_site', html: ' ' }, { command: 'publish_site', html: '<p>x</p>', slug: 'Bad_Slug' }, { command: 'publish_site', html: '<p>x</p>', slug: '-x' }, { command: 'publish_site', html: '<p>x</p>', ttl_seconds: '0' }, { command: 'publish_site', html: '<p>x</p>', ttl_seconds: '1.5' }, { command: 'get_site' }, { command: 'delete_site', slug: 'weekly-report' }]) {
        await assert.rejects(processRequest(input, noNetwork));
    }
    assert.equal(normalizeArguments({ command: 'publish_site', html: '<p>x</p>' }).arguments.ttl_seconds, undefined);
});

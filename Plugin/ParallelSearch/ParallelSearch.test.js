'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { processRequest, normalizeArguments, ENDPOINT, USER_AGENT } = require('./ParallelSearch');

function mockServer({ sse = false, isError = false } = {}) {
    const requests = [];
    const fetch = async (url, init) => {
        const headers = new Headers(init.headers);
        assert.equal(String(url), ENDPOINT);
        assert.equal(headers.get('user-agent'), USER_AGENT);
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-api-key'), null);
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
            result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
        } else if (message.method === 'tools/list') {
            result = { tools: ['web_search', 'web_fetch'].map(name => ({ name, inputSchema: { type: 'object' } })) };
        } else if (message.method === 'tools/call') {
            assert.equal(headers.get('mcp-session-id'), 'fixture-session');
            result = { content: [{ type: 'text', text: isError ? 'rate limited' : 'Source: https://example.com\nUseful excerpt' }], structuredContent: { results: [{ url: 'https://example.com', excerpts: ['Useful excerpt'] }], session_id: 'fixture-conversation' }, ...(isError ? { isError: true } : {}) };
        } else throw new Error(`Unexpected method ${message.method}`);
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        const useSse = sse && message.method === 'tools/call';
        return new Response(useSse ? `event: message\ndata: ${body}\n\n` : body, {
            headers: { 'Content-Type': useSse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'fixture-session' }
        });
    };
    return { fetch, requests };
}

test('search dispatches anonymous MCP initialization, discovery and useful results', async () => {
    const server = mockServer();
    const result = await processRequest({ command: 'web_search', objective: 'Find documentation', search_queries: '["node official documentation"]', session_id: 'conversation-1' }, server);
    assert.equal(result.status, 'success');
    assert.match(result.result.content[0].text, /Useful excerpt/);
    assert.equal(result.result.results[0].url, 'https://example.com');
    assert.deepEqual(server.requests.find(r => r.method === 'tools/call').params, {
        name: 'web_search', arguments: { objective: 'Find documentation', search_queries: ['node official documentation'], session_id: 'conversation-1' }
    });
    assert.ok(server.requests.some(r => r.method === 'tools/list'));
});

test('fetch dispatches JSON array text and booleans and preserves SSE content', async () => {
    const server = mockServer({ sse: true });
    const result = await processRequest({ command: 'web_fetch', urls: '["https://example.com"]', full_content: 'false', session_id: 'conversation-1' }, server);
    assert.equal(result.status, 'success');
    assert.deepEqual(server.requests.find(r => r.method === 'tools/call').params.arguments, { urls: ['https://example.com'], full_content: false, session_id: 'conversation-1' });
    assert.equal(result.result.session_id, 'fixture-conversation');
});

test('MCP tool errors retain content and structured details as a VCP error', async () => {
    const result = await processRequest({ command: 'web_fetch', urls: ['https://example.com'] }, mockServer({ isError: true }));
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'rate limited');
    assert.ok(result.result);
});

test('HTTP failures propagate without retrying the request', async () => {
    let calls = 0;
    await assert.rejects(processRequest({ command: 'web_fetch', urls: ['https://example.com'] }, {
        fetch: async (url, init) => {
            calls++;
            assert.equal(String(url), ENDPOINT);
            assert.equal(new Headers(init.headers).get('user-agent'), USER_AGENT);
            return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
        }
    }), error => error.code === 429 && /rate limited/.test(error.message));
    assert.equal(calls, 1);
});

test('invalid VCP arguments fail before sending requests', async () => {
    for (const input of [null, [], { command: 'other' }, { command: 'web_search', objective: 'x', search_queries: [] }, { command: 'web_search', objective: 'x', search_queries: 'invalid' }, { command: 'web_fetch', urls: ['file:///etc/passwd'] }, { command: 'web_fetch', urls: Array(21).fill('https://example.com') }, { command: 'web_fetch', urls: ['https://example.com'], objective: 'x'.repeat(201) }, { command: 'web_fetch', urls: ['https://example.com'], full_content: 'yes' }, { command: 'web_fetch', urls: ['https://example.com'], session_id: 'x'.repeat(101) }]) {
        await assert.rejects(processRequest(input, { fetch: () => { assert.fail('Invalid input reached network'); } }));
    }
    assert.equal(normalizeArguments({ command: 'web_fetch', urls: ['https://example.com'] }).arguments.full_content, undefined);
});


test('overall deadline aborts a pending initialized notification and closes transport', { timeout: 1000 }, async () => {
    const originalTimeout = AbortSignal.timeout;
    const server = mockServer();
    let aborted = false;
    let pendingSignal;
    AbortSignal.timeout = () => originalTimeout(30);
    // Real sockets keep the event loop alive; the pending fetch fixture needs a handle.
    const keepAlive = setInterval(() => {}, 100);
    try {
        await assert.rejects(processRequest({ command: 'web_fetch', urls: ['https://example.com'] }, {
            fetch: async (url, init) => {
                if (init.body && JSON.parse(init.body).method === 'notifications/initialized') {
                    pendingSignal = init.signal;
                    return new Promise((resolve, reject) => {
                        const onAbort = () => { aborted = true; reject(init.signal.reason); };
                        if (init.signal.aborted) onAbort();
                        else init.signal.addEventListener('abort', onAbort, { once: true });
                    });
                }
                return server.fetch(url, init);
            }
        }), /abort|closed/i);
        assert.equal(aborted, true);
        assert.equal(pendingSignal.aborted, true);
    } finally {
        clearInterval(keepAlive);
        AbortSignal.timeout = originalTimeout;
    }
});

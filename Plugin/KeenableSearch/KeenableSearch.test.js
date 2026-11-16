'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main, buildRequest, KEYLESS_URL, KEYED_URL } = require('./KeenableSearch');

const SAMPLE = { results: [
    { title: 'Keenable', url: 'https://keenable.ai', snippet: 'search for agents' },
    { title: '', url: 'https://example.com', description: 'desc only' },
    { title: 'no url' },
] };

function mockFetch(status = 200, payload = SAMPLE) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: status >= 200 && status < 300, status, json: async () => payload };
    };
    return { fetchImpl, calls };
}

test('keyless request uses the public endpoint and title header', () => {
    const { url, body, headers } = buildRequest({ query: ' agents ' }, {});
    assert.equal(url, KEYLESS_URL);
    assert.deepEqual(body, { query: 'agents', max_results: 8 });
    assert.equal(headers['X-Keenable-Title'], 'VCPToolBox');
    assert.equal(headers['X-API-Key'], undefined);
});

test('KeenableKey switches to the keyed endpoint', () => {
    const { url, headers } = buildRequest({ query: 'q' }, { KeenableKey: 'k' });
    assert.equal(url, KEYED_URL);
    assert.equal(headers['X-API-Key'], 'k');
    assert.equal(headers['X-Keenable-Title'], undefined);
});

test('optional filters and result limits', () => {
    const { body } = buildRequest({ query: 'q', max_results: 50, site: 'github.com', published_after: '2026-11-01' }, { KeenableMaxResults: '3' });
    assert.deepEqual(body, { query: 'q', max_results: 20, site: 'github.com', published_after: '2026-11-01' });
    assert.equal(buildRequest({ query: 'q' }, { KeenableMaxResults: '3' }).body.max_results, 3);
    assert.throws(() => buildRequest({ query: 'q', published_after: 'last week' }, {}), /YYYY-MM-DD/);
    assert.throws(() => buildRequest({}, {}), /query/);
});

test('formats results as markdown and skips entries without url', async () => {
    const { fetchImpl, calls } = mockFetch();
    const res = await main({ query: 'agents' }, { env: {}, fetchImpl });
    assert.equal(res.status, 'success');
    assert.equal(calls[0].url, KEYLESS_URL);
    assert.equal(calls[0].init.method, 'POST');
    const text = res.result.content[0].text;
    assert.match(text, /1\. \*\*\[Keenable\]\(https:\/\/keenable\.ai\)\*\*\n {3}search for agents/);
    assert.match(text, /2\. \*\*\[https:\/\/example\.com\]\(https:\/\/example\.com\)\*\*\n {3}desc only/);
    assert.doesNotMatch(text, /no url/);
});

test('http errors become readable messages', async () => {
    assert.match((await main({ query: 'q' }, { env: {}, fetchImpl: mockFetch(429).fetchImpl })).error, /429/);
    assert.match((await main({ query: 'q' }, { env: { KeenableKey: 'bad' }, fetchImpl: mockFetch(401).fetchImpl })).error, /KeenableKey/);
    const empty = await main({ query: 'q' }, { env: {}, fetchImpl: mockFetch(200, { results: [] }).fetchImpl });
    assert.match(empty.result.content[0].text, /未找到相关结果/);
});

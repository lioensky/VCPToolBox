'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main, buildRequest, API_URL } = require('./SpecStreamSearch');

const SAMPLE = { data: {
    kind: 'fact',
    answer: { value: 'Canberra', page: 'https://en.wikipedia.org/wiki/Canberra' },
    sources: [
        { title: 'Canberra', url: 'https://en.wikipedia.org/wiki/Canberra', site: 'en.wikipedia.org', snippet: 'capital city\nof Australia' },
        { title: '', url: 'https://example.com', snippet: '' },
        { title: 'no url' },
    ],
} };

function mockFetch(status = 200, payload = SAMPLE) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: status >= 200 && status < 300, status, json: async () => payload };
    };
    return { fetchImpl, calls };
}

test('sends the key as a Bearer token and the query as q', () => {
    const { url, body, headers } = buildRequest({ query: ' 澳大利亚首都 ' }, { SpecStreamKey: 'k' });
    assert.equal(url, API_URL);
    assert.deepEqual(body, { q: '澳大利亚首都', num: 8 });
    assert.equal(headers.Authorization, 'Bearer k');
});

test('site and published_after become query operators, results are capped', () => {
    const { body } = buildRequest(
        { query: 'agents', max_results: 50, site: 'github.com', published_after: '2026-11-01' },
        { SpecStreamKey: 'k', SpecStreamMaxResults: '3', SpecStreamSpeed: 'fast' },
    );
    assert.deepEqual(body, { q: 'agents site:github.com after:2026-11-01', num: 20, speed: 'fast' });
    assert.equal(buildRequest({ query: 'q' }, { SpecStreamKey: 'k', SpecStreamMaxResults: '3' }).body.num, 3);
    assert.throws(() => buildRequest({ query: 'q', site: 'a b' }, { SpecStreamKey: 'k' }), /域名/);
    assert.throws(() => buildRequest({ query: 'q', published_after: 'last week' }, { SpecStreamKey: 'k' }), /YYYY-MM-DD/);
    assert.throws(() => buildRequest({}, { SpecStreamKey: 'k' }), /query/);
});

test('no request is made without SpecStreamKey', async () => {
    const { fetchImpl, calls } = mockFetch();
    const res = await main({ query: 'q' }, { env: {}, fetchImpl });
    assert.equal(res.status, 'error');
    assert.match(res.error, /SpecStreamKey/);
    assert.equal(calls.length, 0);
});

test('formats the answer and sources as markdown and skips entries without url', async () => {
    const { fetchImpl, calls } = mockFetch();
    const res = await main({ query: '澳大利亚首都' }, { env: { SpecStreamKey: 'k' }, fetchImpl });
    assert.equal(res.status, 'success');
    assert.equal(calls[0].url, API_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    const text = res.result.content[0].text;
    assert.match(text, /\*\*答案\*\*: Canberra（来源: https:\/\/en\.wikipedia\.org\/wiki\/Canberra）/);
    assert.match(text, /1\. \*\*\[Canberra\]\(https:\/\/en\.wikipedia\.org\/wiki\/Canberra\)\*\* · en\.wikipedia\.org\n {3}capital city\n {3}of Australia/);
    assert.match(text, /2\. \*\*\[https:\/\/example\.com\]\(https:\/\/example\.com\)\*\*$/m);
    assert.doesNotMatch(text, /no url/);
});

test('http errors become readable messages', async () => {
    const env = { SpecStreamKey: 'bad' };
    assert.match((await main({ query: 'q' }, { env, fetchImpl: mockFetch(401, { error: { message: 'no' } }).fetchImpl })).error, /SpecStreamKey/);
    assert.match((await main({ query: 'q' }, { env, fetchImpl: mockFetch(402).fetchImpl })).error, /余额不足/);
    assert.match((await main({ query: 'q' }, { env, fetchImpl: mockFetch(429).fetchImpl })).error, /429/);
    assert.match((await main({ query: 'q' }, { env, fetchImpl: mockFetch(422, { error: { message: 'q is too long' } }).fetchImpl })).error, /422.*q is too long/);
    const empty = await main({ query: 'q' }, { env, fetchImpl: mockFetch(200, { data: { answer: null, sources: [] } }).fetchImpl });
    assert.match(empty.result.content[0].text, /未找到相关结果/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatYoucomResults, searchYoucom } = require('../Plugin/YoucomSearch/YoucomSearch.js');

const YOUCOM_SEARCH_URL = 'https://ydc-index.io/v1/search';
const FAKE_KEY = 'ydc-super-secret-test-key-should-never-leak';

function makeWebItem(overrides = {}) {
    return Object.assign({
        title: '示例标题',
        url: 'https://example.com/page',
        description: '这是一个示例描述。',
        snippets: ['片段一', '片段二']
    }, overrides);
}

// ---------------------------------------------------------------------------
// formatYoucomResults — pure formatting
// ---------------------------------------------------------------------------

test('formatYoucomResults: formats web results as a numbered markdown list', () => {
    const response = {
        results: {
            web: [
                makeWebItem({ title: '第一条', url: 'https://a.example/1', description: '描述一', snippets: ['snip-a'] }),
                makeWebItem({ title: '第二条', url: 'https://a.example/2', description: '描述二', snippets: ['snip-b'] })
            ]
        }
    };
    const md = formatYoucomResults(response);
    assert.match(md, /### 网页结果/);
    assert.match(md, /1\. \*\*\[第一条\]\(https:\/\/a\.example\/1\)\*\*/);
    assert.match(md, /描述一/);
    assert.match(md, /snip-a/);
    assert.match(md, /2\. \*\*\[第二条\]\(https:\/\/a\.example\/2\)\*\*/);
    assert.match(md, /描述二/);
    assert.match(md, /snip-b/);
});

test('formatYoucomResults: formats news results as a numbered markdown list', () => {
    const response = {
        results: {
            news: [
                makeWebItem({ title: '新闻标题', url: 'https://news.example/1', description: '新闻描述', snippets: ['新闻片段'] })
            ]
        }
    };
    const md = formatYoucomResults(response);
    assert.match(md, /### 新闻结果/);
    assert.match(md, /1\. \*\*\[新闻标题\]\(https:\/\/news\.example\/1\)\*\*/);
    assert.match(md, /新闻描述/);
    assert.match(md, /新闻片段/);
});

test('formatYoucomResults: web and news together continue numbering across sections', () => {
    const response = {
        results: {
            web: [makeWebItem({ title: 'W1' })],
            news: [makeWebItem({ title: 'N1' })]
        }
    };
    const md = formatYoucomResults(response);
    assert.match(md, /1\. \*\*\[W1\]/);
    assert.match(md, /2\. \*\*\[N1\]/);
});

test('formatYoucomResults: both web and news absent -> not-found message', () => {
    const md = formatYoucomResults({ results: {} });
    assert.equal(md, '未找到相关搜索结果。\n');
});

test('formatYoucomResults: empty web and news arrays -> not-found message', () => {
    const md = formatYoucomResults({ results: { web: [], news: [] } });
    assert.equal(md, '未找到相关搜索结果。\n');
});

test('formatYoucomResults: missing title falls back to placeholder, still renders url', () => {
    const md = formatYoucomResults({ results: { web: [makeWebItem({ title: undefined })] } });
    assert.match(md, /\*\*\[\(无标题\)\]\(https:\/\/example\.com\/page\)\*\*/);
});

test('formatYoucomResults: missing url renders empty url without throwing', () => {
    const md = formatYoucomResults({ results: { web: [makeWebItem({ url: undefined })] } });
    assert.match(md, /\*\*\[示例标题\]\(\)\*\*/);
});

test('formatYoucomResults: missing description omits the description line', () => {
    const item = makeWebItem({ description: undefined, snippets: [] });
    const md = formatYoucomResults({ results: { web: [item] } });
    assert.match(md, /\*\*\[示例标题\]/);
    assert.doesNotMatch(md, /这是一个示例描述/);
});

test('formatYoucomResults: empty snippets array renders no snippet lines', () => {
    const item = makeWebItem({ snippets: [] });
    const md = formatYoucomResults({ results: { web: [item] } });
    assert.doesNotMatch(md, /- 片段/);
});

test('formatYoucomResults: blank/whitespace-only snippets are filtered out', () => {
    const item = makeWebItem({ snippets: ['真实片段', '   ', '', '\n\t', 'another'] });
    const md = formatYoucomResults({ results: { web: [item] } });
    assert.match(md, /- 真实片段/);
    assert.match(md, /- another/);
    // Only the two real snippets should produce "- " bullet lines
    const bulletLines = md.split('\n').filter(line => line.trim().startsWith('- '));
    assert.equal(bulletLines.length, 2);
});

test('formatYoucomResults: unicode/Chinese content is preserved intact', () => {
    const item = makeWebItem({
        title: '中文标题🎉',
        description: '中文描述，包含标点符号——和表情😀。',
        snippets: ['中文片段一', '日本語スニペット', 'emoji 🚀 snippet']
    });
    const md = formatYoucomResults({ results: { web: [item] } });
    assert.match(md, /中文标题🎉/);
    assert.match(md, /中文描述，包含标点符号——和表情😀。/);
    assert.match(md, /中文片段一/);
    assert.match(md, /日本語スニペット/);
    assert.match(md, /emoji 🚀 snippet/);
});

test('formatYoucomResults: defensive against results:null', () => {
    assert.equal(formatYoucomResults({ results: null }), '未找到相关搜索结果。\n');
});

test('formatYoucomResults: defensive against web:null and news:null', () => {
    assert.equal(formatYoucomResults({ results: { web: null, news: null } }), '未找到相关搜索结果。\n');
});

test('formatYoucomResults: defensive against completely empty/undefined response', () => {
    assert.equal(formatYoucomResults(undefined), '未找到相关搜索结果。\n');
    assert.equal(formatYoucomResults(null), '未找到相关搜索结果。\n');
    assert.equal(formatYoucomResults({}), '未找到相关搜索结果。\n');
});

// ---------------------------------------------------------------------------
// searchYoucom — request construction (injected fake httpGet, no network)
// ---------------------------------------------------------------------------

function makeFakeHttpGet(dataOrFn) {
    const calls = [];
    const fn = async (url, config) => {
        calls.push({ url, config });
        if (typeof dataOrFn === 'function') {
            return dataOrFn(url, config, calls.length);
        }
        return { data: dataOrFn };
    };
    fn.calls = calls;
    return fn;
}

test('searchYoucom: sends correct URL, X-API-Key header, and default params', async () => {
    const fakeGet = makeFakeHttpGet({ results: { web: [makeWebItem()] } });
    const result = await searchYoucom('测试查询', { apiKey: FAKE_KEY }, fakeGet);

    assert.equal(result.status, 'success');
    assert.equal(fakeGet.calls.length, 1);
    const call = fakeGet.calls[0];
    assert.equal(call.url, YOUCOM_SEARCH_URL);
    assert.equal(call.config.headers['X-API-Key'], FAKE_KEY);
    assert.equal(call.config.params.query, '测试查询');
    assert.equal(call.config.params.count, 10); // default
});

test('searchYoucom: count caps at 20 when requested higher', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: 999 }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 20);
});

test('searchYoucom: count defaults to 10 when omitted', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 10);
});

test('searchYoucom: count accepts a valid numeric string', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: '15' }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 15);
});

test('searchYoucom: negative count falls back to default 10', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: -5 }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 10);
});

test('searchYoucom: zero count falls back to default 10', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: 0 }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 10);
});

test('searchYoucom: huge count caps at 20', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: 100000 }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 20);
});

test('searchYoucom: non-numeric count falls back to default 10', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, count: 'not-a-number' }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.count, 10);
});

test('searchYoucom: freshness passthrough only when provided and valid', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, freshness: 'week' }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.freshness, 'week');
});

test('searchYoucom: freshness omitted when not provided', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal('freshness' in fakeGet.calls[0].config.params, false);
});

test('searchYoucom: invalid freshness value is dropped, not passed through', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, freshness: 'decade' }, fakeGet);
    assert.equal('freshness' in fakeGet.calls[0].config.params, false);
});

test('searchYoucom: country passthrough only when provided', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, country: 'CN' }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.country, 'CN');
});

test('searchYoucom: country omitted when not provided', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal('country' in fakeGet.calls[0].config.params, false);
});

test('searchYoucom: language passthrough only when provided', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY, language: 'zh-Hans' }, fakeGet);
    assert.equal(fakeGet.calls[0].config.params.language, 'zh-Hans');
});

test('searchYoucom: language omitted when not provided', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal('language' in fakeGet.calls[0].config.params, false);
});

test('searchYoucom: single query performs exactly one request', async () => {
    const fakeGet = makeFakeHttpGet({ results: { web: [makeWebItem()] } });
    const result = await searchYoucom('单一查询', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(fakeGet.calls.length, 1);
    assert.equal(result.status, 'success');
    assert.match(result.result, /示例标题/);
});

// ---------------------------------------------------------------------------
// searchYoucom — || multi-query concurrency
// ---------------------------------------------------------------------------

test('searchYoucom: || multi-query, all succeed, runs concurrently and merges output', async () => {
    const fakeGet = makeFakeHttpGet((url, config) => {
        const q = config.params.query;
        return { data: { results: { web: [makeWebItem({ title: `结果-${q}` })] } } };
    });
    const result = await searchYoucom('查询A || 查询B || 查询C', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(fakeGet.calls.length, 3);
    assert.match(result.result, /查询: 查询A/);
    assert.match(result.result, /查询: 查询B/);
    assert.match(result.result, /查询: 查询C/);
    assert.match(result.result, /结果-查询A/);
    assert.match(result.result, /结果-查询B/);
    assert.match(result.result, /结果-查询C/);
    assert.doesNotMatch(result.result, /以下查询失败/);
});

test('searchYoucom: || multi-query, some fail, returns partial success plus failure section', async () => {
    const fakeGet = makeFakeHttpGet(async (url, config) => {
        const q = config.params.query;
        if (q === '失败查询') {
            throw new Error('模拟网络错误');
        }
        return { data: { results: { web: [makeWebItem({ title: `成功-${q}` })] } } };
    });
    const result = await searchYoucom('成功查询 || 失败查询', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.match(result.result, /成功-成功查询/);
    assert.match(result.result, /以下查询失败/);
    assert.match(result.result, /失败查询/);
    assert.match(result.result, /模拟网络错误/);
});

test('searchYoucom: || multi-query, all fail, returns error status', async () => {
    const fakeGet = makeFakeHttpGet(async () => {
        throw new Error('全部失败');
    });
    const result = await searchYoucom('查询1 || 查询2', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'error');
    assert.match(result.error, /Youcom Search Error/);
    assert.match(result.error, /全部失败/);
});

test('searchYoucom: query containing only "||" with no real terms returns clean error, no throw', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    const result = await searchYoucom('||', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'error');
    assert.equal(fakeGet.calls.length, 0);
});

test('searchYoucom: whitespace-only query returns clean error, no throw', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    const result = await searchYoucom('   \n\t  ', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'error');
    assert.equal(fakeGet.calls.length, 0);
});

// ---------------------------------------------------------------------------
// searchYoucom — key handling and error paths
// ---------------------------------------------------------------------------

test('searchYoucom: missing apiKey returns error object, never throws, never calls httpGet', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    const result = await searchYoucom('some query', {}, fakeGet);
    assert.equal(result.status, 'error');
    assert.match(result.error, /YoucomKey environment variable not set/);
    assert.equal(fakeGet.calls.length, 0);
});

test('searchYoucom: empty-string apiKey returns error object', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    const result = await searchYoucom('some query', { apiKey: '' }, fakeGet);
    assert.equal(result.status, 'error');
    assert.match(result.error, /YoucomKey environment variable not set/);
});

test('searchYoucom: comma-separated apiKey picks one of the provided keys', async () => {
    const keys = ['keyA', 'keyB', 'keyC'];
    const seenKeys = new Set();
    for (let i = 0; i < 20; i++) {
        const fakeGet = makeFakeHttpGet({ results: {} });
        await searchYoucom('q', { apiKey: keys.join(',') }, fakeGet);
        const usedKey = fakeGet.calls[0].config.headers['X-API-Key'];
        assert.ok(keys.includes(usedKey));
        seenKeys.add(usedKey);
    }
    // Over 20 tries, expect randomness to surface (not a strict requirement, just sanity)
    assert.ok(seenKeys.size >= 1);
});

test('searchYoucom: comma-separated apiKey with only commas/whitespace returns error', async () => {
    const fakeGet = makeFakeHttpGet({ results: {} });
    const result = await searchYoucom('q', { apiKey: ' , , ,  ' }, fakeGet);
    assert.equal(result.status, 'error');
    assert.equal(fakeGet.calls.length, 0);
});

test('searchYoucom: httpGet rejection produces a clean error object (single query)', async () => {
    const fakeGet = makeFakeHttpGet(async () => {
        throw new Error('connection reset');
    });
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'error');
    assert.match(result.error, /Youcom Search Error/);
    assert.match(result.error, /connection reset/);
});

test('searchYoucom: malformed response body (missing results) -> not-found, not a throw', async () => {
    const fakeGet = makeFakeHttpGet({ foo: 'bar' });
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: empty response body ({}) -> not-found', async () => {
    const fakeGet = makeFakeHttpGet({});
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: null response body -> not-found, no throw', async () => {
    const fakeGet = makeFakeHttpGet(null);
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: response.data undefined -> not-found, no throw', async () => {
    const fakeGet = async () => ({});
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: results:null in response body -> not-found, no throw', async () => {
    const fakeGet = makeFakeHttpGet({ results: null });
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: web:null in results -> not-found, no throw', async () => {
    const fakeGet = makeFakeHttpGet({ results: { web: null } });
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'success');
    assert.equal(result.result, '未找到相关搜索结果。\n');
});

test('searchYoucom: httpGet throwing a non-Error value still yields a clean error object', async () => {
    const fakeGet = async () => { throw 'plain string rejection'; };
    const result = await searchYoucom('q', { apiKey: FAKE_KEY }, fakeGet);
    assert.equal(result.status, 'error');
    assert.match(result.error, /Youcom Search Error/);
});

// ---------------------------------------------------------------------------
// Adversarial: never throw, never leak the key
// ---------------------------------------------------------------------------

test('adversarial: searchYoucom never throws across a battery of hostile inputs', async () => {
    const hostileInputs = [
        [undefined, {}],
        [null, {}],
        [123, {}],
        [{}, {}],
        ['', {}],
        ['   ', {}],
        ['||', {}],
        ['|| || ||', {}],
        ['query', { count: {} }],
        ['query', { count: [] }],
        ['query', { count: null }],
        ['query', { freshness: 123 }],
        ['query', { country: 123 }],
        ['query', { language: {} }],
        ['query', { apiKey: null }],
        ['query', { apiKey: 12345 }],
        ['query', { apiKey: FAKE_KEY, count: NaN }]
    ];

    for (const [query, options] of hostileInputs) {
        const fakeGet = makeFakeHttpGet({ results: { web: [makeWebItem()] } });
        let result;
        let threw = false;
        try {
            result = await searchYoucom(query, options, fakeGet);
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, false, `searchYoucom threw for query=${JSON.stringify(query)} options=${JSON.stringify(options)}`);
        assert.ok(result && typeof result === 'object', 'result must be an object');
        assert.ok(result.status === 'success' || result.status === 'error', 'result must have a valid status');
    }
});

test('adversarial: the fake API key never appears in any success or error output', async () => {
    const scenarios = [
        // success path
        async () => searchYoucom('q', { apiKey: FAKE_KEY }, makeFakeHttpGet({ results: { web: [makeWebItem()] } })),
        // http error path
        async () => searchYoucom('q', { apiKey: FAKE_KEY }, makeFakeHttpGet(async () => { throw new Error(`failed for key ${FAKE_KEY}`); })),
        // missing key path
        async () => searchYoucom('q', {}, makeFakeHttpGet({ results: {} })),
        // multi-query partial failure path
        async () => searchYoucom('a || b', { apiKey: FAKE_KEY }, makeFakeHttpGet(async (url, config) => {
            if (config.params.query === 'b') throw new Error(`bad request using ${FAKE_KEY}`);
            return { data: { results: { web: [makeWebItem()] } } };
        }))
    ];

    for (const scenario of scenarios) {
        const result = await scenario();
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes(FAKE_KEY), false, `output leaked the API key: ${serialized}`);
    }
});

test('adversarial: comma-separated key never leaks any of its component keys in error output', async () => {
    const keys = ['secret-key-one', 'secret-key-two'];
    const fakeGet = makeFakeHttpGet(async () => {
        throw new Error('upstream rejected the request');
    });
    const result = await searchYoucom('q', { apiKey: keys.join(',') }, fakeGet);
    const serialized = JSON.stringify(result);
    for (const k of keys) {
        assert.equal(serialized.includes(k), false, `output leaked component key ${k}`);
    }
});

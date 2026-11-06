const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DynamicToolRegistry, validateConfigPatch } = require('../modules/dynamicToolRegistry');

const valid = { brief: '浏览器自动化，网页检索。', categories: ['search/web'], keywords: ['网页检索'], confidence: 0.9 };
const response = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
function record(description = '浏览器自动化，网页检索。') {
  return { originKey: 'local:Browser', pluginName: 'Browser', displayName: '浏览器工具', description, brief: description, fullDescription: description, sourceHash: 'hash', enabled: true, online: true, available: true };
}
async function setup(t, config = {}, classifier = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-semantic-'));
  const registry = new DynamicToolRegistry();
  await registry.initialize({ projectBasePath: root, watchConfigFiles: false, config: { classificationDebounceMs: 60000, classifierTimeoutMs: 500, useRagEmbeddings: false, ...config }, classifier });
  t.after(async () => { clearTimeout(registry.classificationTimer); registry._closeConfigWatchers(); await registry.writePromise.catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { registry, root };
}
function mainEnv(t) {
  const oldUrl = process.env.API_URL, oldKey = process.env.API_Key;
  process.env.API_URL = 'https://main.invalid/v1'; process.env.API_Key = 'main-secret';
  t.after(() => { if (oldUrl === undefined) delete process.env.API_URL; else process.env.API_URL = oldUrl; if (oldKey === undefined) delete process.env.API_Key; else process.env.API_Key = oldKey; });
}

test('Chinese summaries preserve browser and complete punctuation-delimited phrases', async (t) => {
  const { registry } = await setup(t);
  const brief = registry._compactBrief(record(), ['search/web'], '浏览器自动化，网页检索与页面交互。');
  assert.equal(brief, '浏览器自动化，');
  assert.equal(/\p{Script=Han}\s+\p{Script=Han}/u.test(brief), false);
  assert.equal(registry._compactBrief(record(), [], '文本转语音'), '文本转语音');
  assert.equal(registry._compactBrief(record(), [], 'Searches web references with extensive implementation instructions to follow.'), 'Searches web references with extensive implementation...');
});

test('legacy spaced Chinese cache is recovered from manifest before light-list display', async (t) => {
  const { registry } = await setup(t); const rec = record('浏览器自动化，网页检索。');
  registry.catalog.set(rec.originKey, rec);
  registry.categories.set(rec.originKey, { ...valid, brief: '浏 览 器 自 动 化...' });
  const shown = registry.getAdminState().records[0].brief;
  assert.ok(shown.includes('浏览器自动化')); assert.doesNotMatch(shown, /浏 览/);
});

test('keyword fallback separates fine capabilities and ignores incidental read/write usage', async (t) => {
  const { registry } = await setup(t);
  const cases = [
    ['Search public web pages', 'search/web'], ['Search academic papers and citations', 'search/academic'],
    ['Edit files and apply patches', 'file_code/file_edit'], ['Analyze code dependencies and symbols', 'file_code/code_analysis'],
    ['Convert text to speech using TTS', 'image_media/tts'], ['Generate videos from text prompts', 'image_media/video_generation']
  ];
  for (const [description, category] of cases) assert.ok(registry._fallbackClassify(record(description)).categories.includes(category), description);
  const incidental = registry._fallbackClassify({ ...record('Search the web'), fullDescription: 'read result and write response; parse JSON message' });
  assert.ok(incidental.categories.includes('search/web'));
  assert.equal(incidental.categories.some((c) => c.startsWith('file_code')), false);
});

test('parent category directives and manual aliases expand fine categories', async (t) => {
  const { registry } = await setup(t, { maxExpandedPlugins: 0, manualOverrides: { categoryAliases: { research: 'search' } } });
  const rec = record(); registry.catalog.set(rec.originKey, rec); registry.categories.set(rec.originKey, valid);
  assert.match(await registry.buildInjection({ messages: [{ content: '[[VCPDynamicTools:category=research:all]]' }] }), /Expanded tool usage/);
  assert.match(await registry.buildInjection({ messages: [{ content: 'show full search tools' }] }), /Expanded tool usage/);
});

test('fine rule definitions drive embedding threshold and category limit', async (t) => {
  const { registry } = await setup(t, { useRagEmbeddings: true, classification: { maxCategories: 1, embeddingThreshold: 0.9, categoryRules: [{ category: 'custom/science', parent: 'search', description: 'Academic scientific papers', keywords: ['science'] }] } });
  const texts = []; registry._resolveEmbeddingProvider = () => async (text) => { texts.push(text); return [1, 0]; };
  const result = await registry._classifyWithEmbeddings(record());
  assert.deepEqual(result.categories, ['custom/science']); assert.ok(texts.some((text) => text.includes('Academic scientific papers')));
});

for (const [label, content] of [
  ['object', valid], ['text parts', [{ type: 'text', text: JSON.stringify(valid) }]],
  ['fenced with explanation', `Note {not JSON}\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nDone.`],
  ['trailing comma', '{"brief":"浏览器自动化","categories":["search/web",],"keywords":["browser"],"confidence":0.9,}']
]) test(`small model repairs ${label} deterministically`, async (t) => {
  mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } });
  t.mock.method(globalThis, 'fetch', async () => response(content));
  const result = await registry._classifyWithSmallModel(record(), 'test');
  assert.equal(result?.classifiedBy, 'small_model'); assert.ok(result.brief.includes('浏览器自动化'));
});

test('small model retries invalid shape with correction, then clears task error on success', async (t) => {
  mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { requests.push(JSON.parse(options.body)); return response(requests.length === 1 ? { ...valid, categories: 'search', confidence: '0.9' } : valid); });
  registry.lastError = '小模型分类失败：Browser（结构错误）';
  const result = await registry._classifyWithSmallModel(record(), 'test');
  assert.equal(result?.classifiedBy, 'small_model'); assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /categories/); assert.equal(registry.lastError, null);
  assert.equal(requests[0].max_tokens, 2048);
  assert.match(requests[0].messages[1].content, /search\/academic/);
});

for (const bad of [ {}, { ...valid, brief: '' }, { ...valid, brief: 1 }, { ...valid, categories: [] }, { ...valid, keywords: [9] }, { ...valid, confidence: 1.1 } ]) {
  test(`invalid model shape exhausts exactly three attempts: ${JSON.stringify(bad)}`, async (t) => {
    mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } }); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response(bad); });
    const result = await registry._classifyRecord(record(), 'test');
    assert.equal(calls, 3); assert.equal(result.classifiedBy, 'keyword_fallback');
    assert.match(registry.lastError, /小模型/); assert.doesNotMatch(registry.lastError, /main-secret|private-body/);
  });
}

for (const status of [400, 401, 403, 429, 500]) test(`HTTP ${status} retry policy`, async (t) => {
  mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } }); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: false, status }; });
  assert.equal(await registry._classifyWithSmallModel(record(), 'test'), null);
  assert.equal(calls, [400, 401, 403].includes(status) ? 1 : 3); assert.match(registry.lastError, new RegExp(String(status)));
});

for (const phase of ['request', 'body']) test(`timeout aborts ${phase} under one total deadline`, async (t) => {
  mainEnv(t); const { registry } = await setup(t, { classifierTimeoutMs: 100, smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } }); let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; if (phase === 'request') return new Promise(() => {}); return { ok: true, json: () => new Promise(() => {}) }; });
  const started = Date.now(); const result = await Promise.race([registry._classifyWithSmallModel(record(), 'timeout'), new Promise((resolve) => setTimeout(() => resolve('deadline missed'), 400))]);
  assert.equal(result, null); assert.equal(signal?.aborted, true); assert.ok(Date.now() - started < 600); assert.match(registry.lastError, /超时/);
});

test('legacy independent endpoint never changes main API routing', async (t) => {
  mainEnv(t); const { registry } = await setup(t); const config = registry._resolveSmallModelRequestConfig({ enabled: true, model: 'tiny', useMainConfig: false, endpoint: 'https://wrong.invalid', apiKey: 'wrong-secret' });
  assert.equal(config.endpoint, 'https://main.invalid/v1/chat/completions'); assert.equal(config.apiKey, 'main-secret');
});

test('v1 migrates only enabled/model from env once; v2 save and reopen ignore stale env', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-migration-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'ToolConfigs')); await fs.mkdir(path.join(root, 'Plugin', 'DynamicToolBridge'), { recursive: true });
  const configPath = path.join(root, 'ToolConfigs', 'dynamic_tool_bridge.config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1, smallModel: { enabled: false, model: 'old', endpoint: 'https://private.invalid', apiKey: 'private-secret', useMainConfig: false } }));
  await fs.writeFile(path.join(root, 'Plugin', 'DynamicToolBridge', 'config.env'), 'SmallModel_Enabled=true\nSmallModel_Model=官方/deepseek-flash\nSmallModel_API_Key=env-secret');
  const registry = new DynamicToolRegistry(); await registry.initialize({ projectBasePath: root, watchConfigFiles: false });
  assert.equal(registry.config.version, 2); assert.equal(registry.config.smallModel.model, '官方/deepseek-flash');
  await registry.updateConfig({ smallModel: { enabled: false, model: 'saved' } });
  await registry.reloadConfigFromDisk(); assert.equal(registry.config.smallModel.model, 'saved'); assert.equal(registry.config.smallModel.enabled, false);
  const reopened = new DynamicToolRegistry(); await reopened.initialize({ projectBasePath: root, watchConfigFiles: false });
  assert.equal(reopened.config.smallModel.model, 'saved'); assert.doesNotMatch(await fs.readFile(configPath, 'utf8'), /endpoint|apiKey|secret|useMainConfig/);
});

test('config patch validator rejects invalid types and preserves partial semantics', async () => {
  assert.equal(typeof validateConfigPatch, 'function');
  for (const patch of [{ enabled: 'false' }, { maxBriefListItems: Infinity }, { smallModel: { maxRetries: -1 } }, { summary: { minBriefTokenBudget: 10, briefTokenBudget: 6 } }, { classification: { categoryRules: [] } }, { manualOverrides: { pinnedOriginKeys: [3] } }]) assert.throws(() => validateConfigPatch(patch), (error) => error.status === 400);
  assert.deepEqual(validateConfigPatch({ smallModel: { model: ' new ' } }), { smallModel: { model: 'new' } });
});

test('invalid reload and failed writes preserve last-known-good config and disk', async (t) => {
  const { registry } = await setup(t, { maxBriefListItems: 7 }); const before = JSON.stringify(registry.config);
  await fs.writeFile(registry.configPath, '{invalid'); await registry.reloadConfigFromDisk(); assert.equal(JSON.stringify(registry.config), before);
  await fs.writeFile(registry.configPath, JSON.stringify({ ...registry.config, enabled: 'false' })); await registry.reloadConfigFromDisk(); assert.equal(JSON.stringify(registry.config), before);
  const disk = await fs.readFile(registry.configPath, 'utf8'); t.mock.method(registry, '_writeJsonAtomic', async () => { throw new Error('write failure'); });
  await assert.rejects(registry.updateConfig({ maxBriefListItems: 9 }), /write failure/); assert.equal(JSON.stringify(registry.config), before); assert.equal(await fs.readFile(registry.configPath, 'utf8'), disk);
});

test('partial updates retain nested settings and reject merged summary ordering', async (t) => {
  const { registry } = await setup(t, { smallModel: { maxTokens: 1024 } });
  await registry.updateConfig({ smallModel: { model: 'new' } }); assert.equal(registry.config.smallModel.maxTokens, 1024);
  await assert.rejects(registry.updateConfig({ summary: { lightListTokenBudget: 2 } }), (error) => error.status === 400);
});

test('config generation prevents old async classification from overwriting new rules', async (t) => {
  let release, start; const started = new Promise((resolve) => { start = resolve; }); const blocker = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const { registry } = await setup(t, {}, async (_record, { config }) => { calls++; if (calls === 1) { start(); await blocker; } return { ...valid, brief: config.smallModel.model || 'old', categories: [config.smallModel.model || 'old'] }; });
  const rec = record(); registry.catalog.set(rec.originKey, rec); registry.enqueueClassification(rec); const pending = registry.flushClassificationQueue(); await started;
  await registry.updateConfig({ smallModel: { model: 'new' } }); release(); await pending;
  assert.deepEqual(registry.categories.get(rec.originKey).categories, ['new']); assert.equal(calls, 2);
});

test('saved manual overrides refresh immediately without waiting for classification', async (t) => {
  const { registry } = await setup(t); const rec = record(); registry.catalog.set(rec.originKey, rec); registry.categories.set(rec.originKey, valid);
  await registry.updateConfig({ manualOverrides: { descriptionOverrides: { [rec.originKey]: { brief: '学术论文检索', categories: ['search/academic'] } } } });
  assert.equal(registry.getAdminState().records[0].brief, '学术论文检索'); assert.deepEqual(registry.getAdminState().records[0].categories, ['search/academic']);
});

test('clearing manual fields restores automatic categories and summary without sticky overrides', async (t) => {
  const { registry } = await setup(t); const rec = record(); registry.catalog.set(rec.originKey, rec); registry.categories.set(rec.originKey, valid);
  await registry.updateConfig({ manualOverrides: { descriptionOverrides: { [rec.originKey]: { brief: '学术论文检索', categories: ['search/academic'], keywords: ['学术'] } } } });
  await registry.updateConfig({ manualOverrides: { descriptionOverrides: { [rec.originKey]: { brief: '', categories: [], keywords: [] } } } });
  assert.deepEqual(registry.getAdminState().records[0].categories, valid.categories);
  assert.ok(registry.getAdminState().records[0].brief.includes('浏览器自动化'));
});

test('concurrent partial saves serialize against latest committed configuration', async (t) => {
  const { registry } = await setup(t);
  await Promise.all([registry.updateConfig({ smallModel: { model: 'saved' } }), registry.updateConfig({ smallModel: { maxTokens: 1024 } })]);
  assert.equal(registry.config.smallModel.model, 'saved'); assert.equal(registry.config.smallModel.maxTokens, 1024);
  assert.deepEqual(JSON.parse(await fs.readFile(registry.configPath, 'utf8')), registry.config);
});

test('retry delay and attempts share the single total classifier timeout', async (t) => {
  mainEnv(t); const { registry } = await setup(t, { classifierTimeoutMs: 100, smallModel: { enabled: true, model: 'tiny', retryDelayMs: 90 } }); let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return { ok: false, status: 429 }; });
  const started = Date.now(); assert.equal(await registry._classifyWithSmallModel(record(), 'deadline'), null);
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.ok(Date.now() - started < 250);
});

test('native fetch body timeout really disconnects local HTTP response', async (t) => {
  mainEnv(t); const http = require('node:http'); let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"choices":['); res.on('close', disconnected); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  process.env.API_URL = `http://127.0.0.1:${server.address().port}`;
  const { registry } = await setup(t, { classifierTimeoutMs: 100, smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } });
  assert.equal(await registry._classifyWithSmallModel(record(), 'real-abort'), null);
  assert.equal(await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 500))]), true);
});

test('small-model config changes abort old request and classify once with the new model', async (t) => {
  mainEnv(t); let start; const started = new Promise((resolve) => { start = resolve; }); let firstSignal; const models = [];
  const { registry } = await setup(t, { smallModel: { enabled: true, model: 'old', retryDelayMs: 0 } });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const model = JSON.parse(options.body).model; models.push(model);
    if (model === 'old') { firstSignal = options.signal; start(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
    return response(valid);
  });
  const rec = record(); registry.catalog.set(rec.originKey, rec); registry.enqueueClassification(rec); const pending = registry.flushClassificationQueue(); await started;
  await registry.updateConfig({ smallModel: { model: 'new' } }); await pending;
  assert.equal(firstSignal.aborted, true); assert.deepEqual(models, ['old', 'new']); assert.equal(registry.categories.get(rec.originKey).classifiedBy, 'small_model'); assert.equal(registry.lastError, null);
});

test('embedding results preserve manual category and keyword overrides', async (t) => {
  const { registry } = await setup(t, { useRagEmbeddings: true, manualOverrides: { descriptionOverrides: { 'local:Browser': { brief: '人工语音摘要', categories: ['image_media/tts'], keywords: ['语音'] } } } });
  registry._resolveEmbeddingProvider = () => async () => [1, 0];
  const rec = record(); registry.catalog.set(rec.originKey, rec); registry.enqueueClassification(rec); await registry.flushClassificationQueue();
  assert.deepEqual(registry.categories.get(rec.originKey).categories, ['image_media/tts']);
  assert.deepEqual(registry.categories.get(rec.originKey).keywords, ['语音']);
});

test('error response body is cancelled even when HTTP authentication failure is not retried', async (t) => {
  mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny' } }); let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, body: { cancel: async () => { cancelled++; } } }));
  await registry._classifyWithSmallModel(record(), 'auth'); assert.equal(cancelled, 1);
});

test('embedding cache cannot be poisoned by an old rule finishing after config activation', async (t) => {
  let release, start; const started = new Promise((resolve) => { start = resolve; }); const blocked = new Promise((resolve) => { release = resolve; });
  const { registry } = await setup(t); const oldRule = { category: 'custom', description: 'old', keywords: ['old'] }, nextRule = { category: 'custom', description: 'new', keywords: ['new'] };
  const pending = registry._getCategoryEmbedding(oldRule, async () => { start(); await blocked; return [1, 0]; }); await started;
  await registry.updateConfig({ classification: { categoryRules: [nextRule] } }); release(); await pending;
  assert.deepEqual(await registry._getCategoryEmbedding(nextRule, async () => [0, 1]), [0, 1]);
});

for (const query of ['show full search/web tools', 'show [[VCPDynamicTools:category=search/web:all]]']) {
  test(`review-3 fine category directives do not widen through parent substring: ${query}`, async (t) => {
    const { registry } = await setup(t, { maxExpandedPlugins: 0 });
    for (const [name, category] of [['Web', 'search/web'], ['Scholar', 'search/academic'], ['Navigation', 'search/browser']]) {
      const rec = { ...record('CAPABILITY'), originKey: `local:${name}`, pluginName: name, displayName: name, fullDescription: `EXPANDED_${name}` };
      registry.catalog.set(rec.originKey, rec); registry.categories.set(rec.originKey, { ...valid, categories: [category] });
    }
    const injection = await registry.buildInjection({ messages: [{ content: query }] });
    assert.match(injection, /EXPANDED_Web/); assert.doesNotMatch(injection, /EXPANDED_Scholar|EXPANDED_Navigation/);
    const parent = await registry.buildInjection({ messages: [{ content: 'show full search tools' }] });
    assert.match(parent, /EXPANDED_Web/); assert.match(parent, /EXPANDED_Scholar/); assert.match(parent, /EXPANDED_Navigation/);
  });
}

test('review-4 config cancellation never falls into a hanging embedding provider', async (t) => {
  mainEnv(t); let start, releaseEmbedding; const started = new Promise((resolve) => { start = resolve; });
  const { registry } = await setup(t, { useRagEmbeddings: true, classifierTimeoutMs: 1000, smallModel: { enabled: true, model: 'old', retryDelayMs: 0 } });
  let embeddingCalls = 0, allowEmbedding = false; const models = [];
  registry._resolveEmbeddingProvider = () => async () => { embeddingCalls++; if (allowEmbedding) return [1, 0]; return new Promise((resolve) => { releaseEmbedding = () => resolve([1, 0]); }); };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const model = JSON.parse(options.body).model; models.push(model);
    if (model === 'old') { start(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
    return response(valid);
  });
  const rec = record(); registry.catalog.set(rec.originKey, rec); registry.enqueueClassification(rec); const pending = registry.flushClassificationQueue(); await started;
  await registry.updateConfig({ smallModel: { model: 'new' } });
  const finished = await Promise.race([pending.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 150))]);
  // Cleanup must not leave a failed test holding its pending classification.
  allowEmbedding = true;
  registry._resolveEmbeddingProvider = () => null;
  if (releaseEmbedding) releaseEmbedding();
  await pending;
  assert.equal(finished, true); assert.equal(embeddingCalls, 0); assert.deepEqual(models, ['old', 'new']);
});

test('review-4 same-generation model timeout still permits embedding fallback', async (t) => {
  mainEnv(t); const { registry } = await setup(t, { useRagEmbeddings: true, classifierTimeoutMs: 100, smallModel: { enabled: true, model: 'tiny' } });
  let embeddingCalls = 0; registry._resolveEmbeddingProvider = () => async () => { embeddingCalls++; return [1, 0]; };
  t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  const result = await registry._classifyRecord(record(), 'same-generation-timeout');
  assert.equal(result.classifiedBy, 'rag_embedding_fallback'); assert.ok(embeddingCalls > 0);
});

for (const useRagEmbeddings of [false, true]) test(`review-5 extracted manual brief never becomes automatic base: embeddings=${useRagEmbeddings}`, async (t) => {
  const { registry } = await setup(t, { useRagEmbeddings, manualOverrides: { descriptionOverrides: { 'local:RawTool': { brief: '人工摘要保留', fullDescription: 'MANUAL FULL DESCRIPTION' } } } });
  const manifest = { name: 'RawTool', description: '', capabilities: { invocationCommands: [{ command: 'run', description: '浏览器自动化，网页检索。' }] } };
  registry.pluginManager = { plugins: new Map([['RawTool', manifest]]) };
  if (useRagEmbeddings) registry._resolveEmbeddingProvider = () => async () => [1, 0];
  await registry.syncFromPluginManager('real-extract'); await registry.flushClassificationQueue();
  assert.equal(registry.getAdminState().records[0].brief, '人工摘要保留');
  await registry.updateConfig({ manualOverrides: { descriptionOverrides: { 'local:RawTool': { brief: '', fullDescription: 'MANUAL FULL DESCRIPTION' } } } });
  const shown = registry.getAdminState().records[0].brief;
  assert.ok(shown.includes('浏览器自动化'), shown); assert.doesNotMatch(shown, /人工摘要/);
  assert.equal(registry.getRecord('local:RawTool').fullDescription, 'MANUAL FULL DESCRIPTION');
});

test('review-6 explanation JSON candidates do not hide a later valid classification', async (t) => {
  mainEnv(t); const { registry } = await setup(t, { smallModel: { enabled: true, model: 'tiny', retryDelayMs: 0 } }); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response('<think>schema: {}</think>\n```json\n' + JSON.stringify(valid) + '\n```'); });
  const result = await registry._classifyWithSmallModel(record(), 'candidates');
  assert.equal(result?.classifiedBy, 'small_model'); assert.equal(calls, 1);
});

for (const phrase of ['调用 GPT-4.1 模型进行图像识别。', '使用 Node.js 执行代码。', '访问 docs.example.com 查询文档。']) {
  test(`review-7 mixed semantic phrase preserves dotted identifiers: ${phrase}`, () => {
    const { truncateToTokenBudget } = require('../modules/dynamicToolSemantics');
    assert.equal(truncateToTokenBudget(phrase, 3), phrase);
  });
}

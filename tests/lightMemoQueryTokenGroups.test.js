'use strict';

// LightMemo 下发给原生检索的查询词：原始词最多 256 个，语义组按组下发，组再大也不挤占查询词名额。
// 之前整组并入 queryTokens，一个 285 词的组就超过 rust-vexus-lite/src/light_memo.rs 的 256 上限，整条回忆报 LIGHTMEMO_INVALID_PLAN。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('../Plugin/LightMemo/LightMemo');
const { search } = require('../Plugin/LightMemo/nativeQuery');

function fakePlugin({ tokens, groups }) {
    const plans = [];
    const fake = {
        excludedFolders: [],
        _parseMaidScopedFolder: () => ({ maid: '', folder: null }),
        _mergeFolderScopes: value => value,
        _parseBoolean: (value, fallback) => value ?? fallback,
        _parseBooleanAlias: () => true,
        _parseNumber: (value, fallback) => value ?? fallback,
        _parseEngineMode: () => 'rivermemo',
        _parseStringArray: value => value || [],
        _tokenize: () => tokens,
        _expandQueryTokens: () => groups.flat(),
        _expandQueryTokenGroups: () => groups,
        getSingleEmbedding: async () => [1, 0],
        vectorDBManager: { executeLightMemoQuery: async (_query, options) => { plans.push(options); return { results: [] }; } },
        _detectColdKnowledgeRoute: () => null,
        _parseRerankOptions: () => ({ enabled: false }),
        _parseAIMemoOptions: () => ({ enabled: false }),
        formatResults: () => 'ok',
    };
    return { fake, plans };
}

test('a 285-word group goes down as one group and leaves the query words alone', async () => {
    const tokens = ['vps', 'unraid', 'wireguard', '拓扑', '集群'];
    const group = Array.from({ length: 285 }, (_, i) => `黑话${i}`);
    const { fake, plans } = fakePlugin({ tokens, groups: [group] });
    await search.call(fake, { query: '全网VPS与Unraid网络拓扑 WireGuard 集群', folder: '日记' });
    assert.deepEqual(plans[0].queryTokens, tokens);
    assert.equal(plans[0].queryTokenGroups.length, 1);
    assert.equal(plans[0].queryTokenGroups[0].length, 285);
});

test('a long query keeps its first 256 words; groups are bounded too', async () => {
    const tokens = Array.from({ length: 400 }, (_, i) => `词${i}`);
    const groups = Array.from({ length: 80 }, (_, g) => Array.from({ length: 100 }, (_, i) => `组${g}-${i}`));
    const { fake, plans } = fakePlugin({ tokens, groups });
    await search.call(fake, { query: '很长的查询', folder: '日记' });
    assert.equal(plans[0].queryTokens.length, 256);
    assert.equal(plans[0].queryTokens[0], '词0');
    assert.ok(plans[0].queryTokenGroups.length <= 64);
    assert.ok(plans[0].queryTokenGroups.flat().length <= 4096);
});

test('real LightMemo: activated groups come back one list per group, flat expansion unchanged', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lightmemo-token-groups-'));
    const file = path.join(base, 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const slang = ['vps', 'wireguard', 'unraid', ...Array.from({ length: 282 }, (_, i) => `synonym_${i}`)];
    fs.writeFileSync(file, JSON.stringify({ groups: { 'VPS与IDC黑话': { words: slang }, '前端': { words: ['javascript', 'js'] } } }), 'utf-8');
    const previous = plugin.projectBasePath;
    try {
        plugin.projectBasePath = base;
        await plugin.loadSemanticGroups();
    } finally {
        plugin.projectBasePath = previous;
        fs.rmSync(base, { recursive: true, force: true });
    }
    const tokens = ['vps', 'unraid', 'js'];
    const groups = plugin._expandQueryTokenGroups(tokens);
    assert.equal(groups.length, 2, 'one entry per activated group, even when two words hit the same group');
    assert.equal(groups[0].length, 283, 'members already in the query are left out');
    assert.ok(!groups[0].includes('vps') && !groups[0].includes('unraid'));
    assert.deepEqual(groups[1], ['javascript']);
    assert.deepEqual(plugin._expandQueryTokens(tokens), groups.flat());
});

test('the limits match the Rust plan check', () => {
    const rust = fs.readFileSync(path.join(__dirname, '../rust-vexus-lite/src/light_memo.rs'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../Plugin/LightMemo/nativeQuery.js'), 'utf8');
    for (const name of ['MAX_QUERY_TOKENS', 'MAX_TOKEN_GROUPS', 'MAX_GROUP_WORDS']) {
        const rustValue = Number(new RegExp(`const ${name}: usize = (\\d+);`).exec(rust)?.[1]);
        const jsValue = Number(new RegExp(`const ${name} = (\\d+);`).exec(js)?.[1]);
        assert.ok(rustValue > 0, name);
        assert.equal(jsValue, rustValue, name);
    }
});

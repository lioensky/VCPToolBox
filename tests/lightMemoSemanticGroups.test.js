'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('../Plugin/LightMemo/LightMemo');

async function loadGroups(groups) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lightmemo-groups-'));
    const file = path.join(base, 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ groups }), 'utf-8');
    const previous = plugin.projectBasePath;
    try {
        plugin.projectBasePath = base;
        await plugin.loadSemanticGroups();
    } finally {
        plugin.projectBasePath = previous;
        fs.rmSync(base, { recursive: true, force: true });
    }
}

test('semantic group words outside the jieba dictionary still activate their group', async () => {
    // From semantic_groups.json.example: jieba's default dictionary splits these words.
    await loadGroups({ '克莱恩·莫雷蒂': { words: ['愚者', '塔罗会', '源堡', '道恩'], weight: 1.2 } });
    const tokens = plugin._tokenize('塔罗会今晚在源堡聚会吗');
    assert.ok(tokens.includes('塔罗会'));
    assert.ok(tokens.includes('源堡'));
    assert.deepEqual(plugin._expandQueryTokens(tokens).sort(), ['愚者', '道恩'].sort());
});

test('mixed-case group words keep matching after lowercasing', async () => {
    await loadGroups({ '编程学习': { words: ['JavaScript', 'Node.js'], weight: 1.0 } });
    const tokens = plugin._tokenize('我用Node.js写了个脚本');
    assert.ok(tokens.includes('node.js'));
    assert.deepEqual(plugin._expandQueryTokens(tokens), ['javascript']);
});

test('registering group words leaves unrelated sentences segmented as before', async () => {
    const before = plugin._tokenize('资源堡垒很坚固');
    await loadGroups({ '克莱恩·莫雷蒂': { words: ['源堡'], weight: 1.0 } });
    assert.deepEqual(plugin._tokenize('资源堡垒很坚固'), before);
});

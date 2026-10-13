'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(ROOT, 'TVStxt', 'JevToolCallDecision.txt');

const WAVE8_THIRD_PARTY_FOLDERS = [
    'TinyFishBrowser',
    'FlashDeepSearch'
];

function loadBackendManifest(folder) {
    const p = path.join(ROOT, 'Plugin', folder, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeWave8Planner() {
    const registry = new JevThirdPartyRegistry();
    const items = WAVE8_THIRD_PARTY_FOLDERS.map(folder => ({
        manifest: loadBackendManifest(folder),
        origin: 'local'
    }));
    const snapshot = registry.build(items);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });
    return { registry, snapshot, planner };
}

test('Wave 8: TinyFishBrowser 与 FlashDeepSearch 通过第三方注册表校验且状态为 valid', () => {
    const { snapshot } = makeWave8Planner();
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'info_retrieval');
    }
});

test('Wave 8: 离线规划验证 TinyFishBrowser 结构化搜索与真实无头浏览器 JS 渲染抓取', async () => {
    const { planner } = makeWave8Planner();

    // 1. 结构化搜索
    const [searchCall] = await planner.plan('请使用 {信息获取} 中的 `TinyFishBrowser`，搜索【web automation tools】[国家:US][语言:en]。');
    assert.equal(searchCall.name, 'TinyFishBrowser');
    assert.equal(searchCall.args.command, 'TinyFishSearch');
    assert.equal(searchCall.args.q, 'web automation tools');
    assert.equal(searchCall.args.location, 'US');
    assert.equal(searchCall.args.language, 'en');

    // 2. 真实无头浏览器 JS 动态页面抓取
    const [fetchCall] = await planner.plan('请使用 {信息获取} 中的 `TinyFishBrowser`，抓取网页【https://docs.tinyfish.ai】[格式:markdown]。');
    assert.equal(fetchCall.name, 'TinyFishBrowser');
    assert.equal(fetchCall.args.command, 'TinyFishFetch');
    assert.equal(fetchCall.args.urls, 'https://docs.tinyfish.ai');
    assert.equal(fetchCall.args.format, 'markdown');
});

test('Wave 8: 离线规划验证 FlashDeepSearch 子Agent深度研究研报主题与广度约束', async () => {
    const { planner } = makeWave8Planner();

    const [researchCall] = await planner.plan('请使用 {信息获取} 中的 `FlashDeepSearch`，深度研究【探讨人工智能在气候变化建模中的应用及其伦理影响】[广度:12]。');
    assert.equal(researchCall.name, 'FlashDeepSearch');
    assert.equal(researchCall.args.command, 'StartResearch');
    assert.equal(researchCall.args.SearchContent, '探讨人工智能在气候变化建模中的应用及其伦理影响');
    assert.equal(researchCall.args.SearchBroadness, '12');
});
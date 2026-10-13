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

const WAVE5_THIRD_PARTY_FOLDERS = [
    'ArtistMatcher',
    'DailyNoteSearcher'
];

function loadBackendManifest(folder) {
    const p = path.join(ROOT, 'Plugin', folder, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeWave5Planner() {
    const registry = new JevThirdPartyRegistry();
    const items = WAVE5_THIRD_PARTY_FOLDERS.map(folder => ({
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

test('Wave 5: ArtistMatcher 与 DailyNoteSearcher 通过第三方注册表校验且有效（SciCalculator 由官方一级目录集中管理）', () => {
    const { snapshot } = makeWave5Planner();
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
    }
});

test('Wave 5: 离线规划验证 SciCalculator 复杂微积分与带数组方括号公式的无损透传', async () => {
    const { planner } = makeWave5Planner();

    // 显式目录 + 含数组方括号 [2,4,4,4,5,5,7,9] 的复杂数学公式，验证【】内部方括号不被误判为约束
    const complexFormula = "sqrt(variance([2,4,4,4,5,5,7,9])) + integral('exp(-x**2)', '-inf', 'inf')";
    const [calcCall1] = await planner.plan(`请使用 {日用工具} 计算【${complexFormula}】。`);
    assert.equal(calcCall1.name, 'SciCalculator');
    assert.equal(calcCall1.args.expression, complexFormula);

    // 隐式目录高置信度触发
    const [calcCall2] = await planner.plan("请计算【confidence_interval([10.2, 10.5, 9.8, 10.1, 10.4], 0.95)】。");
    assert.equal(calcCall2.name, 'SciCalculator');
    assert.equal(calcCall2.args.expression, 'confidence_interval([10.2, 10.5, 9.8, 10.1, 10.4], 0.95)');
});

test('Wave 5: 离线规划验证 ArtistMatcher 查询特定画师与无主负载随机画师灵感串路由', async () => {
    const { planner } = makeWave5Planner();

    const [findCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ArtistMatcher`，查询画师【Krenz Cushart】。');
    assert.equal(findCall.name, 'ArtistMatcher');
    assert.equal(findCall.args.command, 'FindArtist');
    assert.equal(findCall.args.artist_name, 'Krenz Cushart');

    const [randomCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ArtistMatcher`，生成随机画师串。');
    assert.equal(randomCall.name, 'ArtistMatcher');
    assert.equal(randomCall.args.command, 'GetRandomArtistString');
});

test('Wave 5: 离线规划验证 DailyNoteSearcher 全库精确检索与指定目录 BM25 检索路由', async () => {
    const { planner } = makeWave5Planner();

    // 1. 默认全库冷知识库精确搜索
    const [textCall] = await planner.plan('请使用 {便利操作} 中的 `DailyNoteSearcher`，搜索知识库【TriviumDB search_hybrid】[知识库][文件夹:TDBdocs]。');
    assert.equal(textCall.name, 'DailyNoteSearcher');
    assert.equal(textCall.args.query, 'TriviumDB search_hybrid');
    assert.equal(textCall.args.mode, 'text');
    assert.equal(textCall.args.root_path, 'knowledge');
    assert.equal(textCall.args.folder, 'TDBdocs');

    // 2. 指定角色目录与 Tag 行的 BM25 召回（测试单槽位无前缀 folder 自动绑定）
    const [bm25Call] = await planner.plan('请使用 {便利操作} 中的 `DailyNoteSearcher`，搜索日记【桌面图标和壁纸操作】[bm25][标签行][VCP桌面知识]。');
    assert.equal(bm25Call.name, 'DailyNoteSearcher');
    assert.equal(bm25Call.args.query, '桌面图标和壁纸操作');
    assert.equal(bm25Call.args.mode, 'bm25');
    assert.equal(bm25Call.args.root_path, 'dailynote');
    assert.equal(bm25Call.args.bm25_search_mode, 'tag');
    assert.equal(bm25Call.args.folder, 'VCP桌面知识');
});
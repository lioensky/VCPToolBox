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
const FRONT_DIR = path.join(ROOT, '..', 'VCPChat', 'VCPDistributedServer', 'Plugin');

function loadBackendManifest(name) {
    const p = path.join(ROOT, 'Plugin', name, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadFrontendManifest(folder) {
    const p = path.join(FRONT_DIR, folder, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('Wave 3: 全部 9 个媒体娱乐与生活服务多模态插件通过注册表校验且有效', () => {
    const registry = new JevThirdPartyRegistry();
    const items = [
        // 前端分布式插件 (1个)
        { manifest: loadFrontendManifest('VCPSuperDice'), origin: 'cloud' },
        // 后端插件 (8个)
        { manifest: loadBackendManifest('Randomness'), origin: 'local' },
        { manifest: loadBackendManifest('TarotDivination'), origin: 'local' },
        { manifest: loadBackendManifest('DigitalOracle'), origin: 'local' },
        { manifest: loadBackendManifest('BangumiOperator'), origin: 'local' },
        { manifest: loadBackendManifest('NeteaseMusic'), origin: 'local' },
        { manifest: loadBackendManifest('SunoGen'), origin: 'local' },
        { manifest: loadBackendManifest('MimoDubbing'), origin: 'local' },
        { manifest: loadBackendManifest('TomatoNovel'), origin: 'local' }
    ];

    const snapshot = registry.build(items);
    assert.equal(snapshot.total, items.length);
    assert.equal(snapshot.validCount, items.length);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.ok(
            entry.category === 'media_entertainment' || entry.category === 'life_services',
            `${entry.pluginName} 目录异常: ${entry.category}`
        );
    }
});

test('Wave 3: 离线规划验证 SuperDice 3D 物理骰子材质与魔法枚举裁决', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadFrontendManifest('VCPSuperDice'), origin: 'cloud' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `SuperDice`，投掷【2d6+1d20】并选用[宝石]材质、[月面慢落]魔法与[颜色:#8B5CF6]。');
    assert.equal(call.name, 'SuperDice');
    assert.equal(call.args.command, 'roll');
    assert.equal(call.args.notation, '2d6+1d20');
    assert.equal(call.args.theme, 'gemstone');
    assert.equal(call.args.magic, 'moon');
    assert.equal(call.args.themecolor, '#8B5CF6');
});

test('Wave 3: 离线规划验证 Randomness TRPG 掷骰、塔罗与卢恩符文三命令路由', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('Randomness'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `Randomness`，执行跑团掷骰【(2d8+1d6)kh2+5】。');
    assert.equal(call1.name, 'Randomness');
    assert.equal(call1.args.command, 'rollDice');
    assert.equal(call1.args.diceString, '(2d8+1d6)kh2+5');

    const [call2] = await planner.plan('请使用 {休闲娱乐} 中的 `Randomness`，进行[卢恩符文]占卜[数量:3]。');
    assert.equal(call2.name, 'Randomness');
    assert.equal(call2.args.command, 'castRunes');
    assert.equal(call2.args.count, '3');
});

test('Wave 3: 离线规划验证 TarotDivination 牌阵与日月星三起源枚举裁决', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('TarotDivination'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `TarotDivination`，以[星起源]进行一次[三牌阵]塔罗占卜[检定数:77]。');
    assert.equal(call1.name, 'TarotDivination');
    assert.equal(call1.args.command, 'draw_three_card_spread');
    assert.equal(call1.args.origin, '星');
    assert.equal(call1.args.fate_check_number, '77');

    const [call2] = await planner.plan('请使用 {游戏互动} 中的 `TarotDivination`，执行[凯尔特十字]深度占卜并选择[月起源]。');
    assert.equal(call2.name, 'TarotDivination');
    assert.equal(call2.args.command, 'draw_celtic_cross');
    assert.equal(call2.args.origin, '月');
});

test('Wave 3: 离线规划验证 DigitalOracle 全球金融宏观看板与定向信源抓取', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('DigitalOracle'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {生活服务} 中的 `DigitalOracle`，拉取【全球金融监控面板】。');
    assert.equal(call1.name, 'DigitalOracle');
    assert.equal(call1.args.command, 'DigitalOracleGlobalMacroDashboard');

    const [call2] = await planner.plan('请使用 {出行与金融} 中的 `DigitalOracle`，抓取市场数据[雅虎财经][标的:GC=F]。');
    assert.equal(call2.name, 'DigitalOracle');
    assert.equal(call2.args.command, 'DigitalOracleFetchMarketData');
    assert.equal(call2.args.provider, 'yahoo');
    assert.equal(call2.args.symbol, 'GC=F');
});

test('Wave 3: 离线规划验证 BangumiOperator 每日放送表与番剧角色搜索', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('BangumiOperator'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `BangumiOperator`，查看【每日放送】新番时间表。');
    assert.equal(call1.name, 'BangumiOperator');
    assert.equal(call1.args.command, 'GetDailyBroadcast');

    const [call2] = await planner.plan('请使用 {影音娱乐} 中的 `BangumiOperator`，搜番剧【葬送的芙莉莲】[动画][条数:5]。');
    assert.equal(call2.name, 'BangumiOperator');
    assert.equal(call2.args.command, 'SearchSubjects');
    assert.equal(call2.args.keyword, '葬送的芙莉莲');
    assert.equal(call2.args.subject_type, '2');
    assert.equal(call2.args.limit, '5');

    const [call3] = await planner.plan('请使用 {媒体娱乐} 中的 `BangumiOperator`，搜角色【牧濑红莉栖】。');
    assert.equal(call3.name, 'BangumiOperator');
    assert.equal(call3.args.command, 'SearchCharacters');
    assert.equal(call3.args.keyword, '牧濑红莉栖');
});

test('Wave 3: 离线规划验证 NeteaseMusic 搜歌与每日推荐', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('NeteaseMusic'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `NeteaseMusic`，[搜索歌曲]【晴天 周杰伦】。');
    assert.equal(call1.name, 'NeteaseMusic');
    assert.equal(call1.args.action, 'search');
    assert.equal(call1.args.keywords, '晴天 周杰伦');

    const [call2] = await planner.plan('请使用 {媒体娱乐} 中的 `NeteaseMusic`，获取今日[每日推荐]歌单。');
    assert.equal(call2.name, 'NeteaseMusic');
    assert.equal(call2.args.action, 'daily_recommend');
});

test('Wave 3: 离线规划验证 SunoGen AI 作曲与纯音乐伴奏布尔裁决', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('SunoGen'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `SunoGen`，创作【一首关于星空与数学梦想的安静钢琴曲】[纯音乐][v4]。');
    assert.equal(call.name, 'SunoGen');
    assert.equal(call.args.command, 'generate_song');
    assert.equal(call.args.gpt_description_prompt, '一首关于星空与数学梦想的安静钢琴曲');
    assert.equal(call.args.make_instrumental, 'true');
    assert.equal(call.args.mv, 'chirp-v4');
});

test('Wave 3: 离线规划验证 MimoDubbing 多声线语音合成与状态查询', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('MimoDubbing'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `MimoDubbing`，用[冰糖]音色配音【你终于来了，我等你好久了！】[指导:欣喜轻快]。');
    assert.equal(call1.name, 'MimoDubbing');
    assert.equal(call1.args.command, 'submit');
    assert.equal(call1.args.text1, '你终于来了，我等你好久了！');
    assert.equal(call1.args.voice, '冰糖');
    assert.equal(call1.args.instruction, '欣喜轻快');

    const [call2] = await planner.plan('请使用 {媒体娱乐} 中的 `MimoDubbing`，查询配音【12345678-1234-4123-8123-123456789abc】。');
    assert.equal(call2.name, 'MimoDubbing');
    assert.equal(call2.args.command, 'query');
    assert.equal(call2.args.request_id, '12345678-1234-4123-8123-123456789abc');
});

test('Wave 3: 离线规划验证 TomatoNovel 搜书与大纲提取', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('TomatoNovel'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `TomatoNovel`，[搜书]【十日终焉】。');
    assert.equal(call1.name, 'TomatoNovel');
    assert.equal(call1.args.action, 'search');
    assert.equal(call1.args.query, '十日终焉');

    const [call2] = await planner.plan('请使用 {媒体娱乐} 中的 `TomatoNovel`，[提取大纲]【7580018670118652952】。');
    assert.equal(call2.name, 'TomatoNovel');
    assert.equal(call2.args.action, 'download_intro');
    assert.equal(call2.args.query, '7580018670118652952');
});
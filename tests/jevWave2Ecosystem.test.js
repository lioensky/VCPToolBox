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

test('Wave 2: 前后端便利操作与物联网控制插件全部通过校验且有效', () => {
    const registry = new JevThirdPartyRegistry();
    const items = [
        // 后端插件 (6个)
        { manifest: loadBackendManifest('ScheduleManager'), origin: 'local' },
        { manifest: loadBackendManifest('AgentMessage'), origin: 'local' },
        { manifest: loadBackendManifest('VCPEverything'), origin: 'local' },
        { manifest: loadBackendManifest('AnkiSearch'), origin: 'local' },
        { manifest: loadBackendManifest('JapaneseHelper'), origin: 'local' },
        { manifest: loadBackendManifest('LexibankOperator'), origin: 'local' },
        // 前端分布式插件 (6个)
        { manifest: loadFrontendManifest('WaitingForUrReply'), origin: 'cloud' },
        { manifest: loadFrontendManifest('TableLampRemote'), origin: 'cloud' },
        { manifest: loadFrontendManifest('TopicMemo'), origin: 'cloud' },
        { manifest: loadFrontendManifest('DeepMemo'), origin: 'cloud' },
        { manifest: loadFrontendManifest('TopicSponsor'), origin: 'cloud' },
        { manifest: loadFrontendManifest('VCPEverything'), origin: 'cloud' }
    ];

    const snapshot = registry.build(items);
    assert.equal(snapshot.total, items.length);
    assert.equal(snapshot.validCount, items.length);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.ok(
            entry.category === 'convenience' || entry.category === 'iot_control' || entry.category === 'info_retrieval',
            `${entry.pluginName} 目录异常: ${entry.category}`
        );
    }
});

test('Wave 2: 离线规划验证 WaitingForUrReply 桌面弹窗等待回复', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadFrontendManifest('WaitingForUrReply'), origin: 'cloud' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {便利操作} 中的 `WaitingForUrReply`，询问【这个方案是否继续推进？】[标题:请确认]。');
    assert.equal(call.name, 'WaitingForUrReply');
    assert.equal(call.args.command, 'WaitForUserInput');
    assert.equal(call.args.prompt, '这个方案是否继续推进？');
    assert.equal(call.args.title, '请确认');
});

test('Wave 2: 离线规划验证 TopicMemo 话题回忆与历史对话阅读', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadFrontendManifest('TopicMemo'), origin: 'cloud' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `TopicMemo`，列出往期【话题列表】。');
    assert.equal(call1.name, 'TopicMemo');
    assert.equal(call1.args.command, 'ListTopics');

    const [call2] = await planner.plan('请使用 {日常便利} 中的 `TopicMemo`，读取话题内容【topic_1766100505346】。');
    assert.equal(call2.name, 'TopicMemo');
    assert.equal(call2.args.command, 'GetTopicContent');
    assert.equal(call2.args.topic_id, 'topic_1766100505346');
});

test('Wave 2: 离线规划验证 DeepMemo 跨话题深度回忆', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadFrontendManifest('DeepMemo'), origin: 'cloud' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {便利操作} 中的 `DeepMemo`，深度回忆【系统架构设计】[窗口:8]。');
    assert.equal(call.name, 'DeepMemo');
    assert.equal(call.args.command, 'DeepMemo');
    assert.equal(call.args.keyword, '系统架构设计');
    assert.equal(call.args.window_size, '8');
});

test('Wave 2: 离线规划验证 TopicSponsor 未读与未锁定话题查询', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadFrontendManifest('TopicSponsor'), origin: 'cloud' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `TopicSponsor`，查看是否有[未读话题]。');
    assert.equal(call1.name, 'TopicSponsor');
    assert.equal(call1.args.command, 'CheckUnreadMessages');

    const [call2] = await planner.plan('请使用 {便利操作} 中的 `TopicSponsor`，列出【未锁定话题】。');
    assert.equal(call2.name, 'TopicSponsor');
    assert.equal(call2.args.command, 'ListUnlockedTopics');
});

test('Wave 2: 离线规划验证 ScheduleManager 查看、新增与删除日程', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('ScheduleManager'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `ScheduleManager`，查看当前所有【日程列表】。');
    assert.equal(call1.name, 'ScheduleManager');
    assert.equal(call1.args.command, 'ListSchedules');

    const [call2] = await planner.plan('请使用 {日常协作} 中的 `ScheduleManager`，新增日程【参加学术研讨会】[时间:2026-10-15 14:00]。');
    assert.equal(call2.name, 'ScheduleManager');
    assert.equal(call2.args.command, 'AddSchedule');
    assert.equal(call2.args.text, '参加学术研讨会');
    assert.equal(call2.args.time, '2026-10-15 14:00');

    const [call3] = await planner.plan('请使用 {便利操作} 中的 `ScheduleManager`，删除日程【1735564800000】。');
    assert.equal(call3.name, 'ScheduleManager');
    assert.equal(call3.args.command, 'DeleteSchedule');
    assert.equal(call3.args.id, '1735564800000');
});

test('Wave 2: 离线规划验证 AgentMessage 桌面即时通知推送', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('AgentMessage'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {便利操作} 中的 `AgentMessage`，推送桌面通知【主人，咖啡已经泡好了哦～】。');
    assert.equal(call.name, 'AgentMessage');
    assert.equal(call.args.command, 'AgentMessage');
    assert.equal(call.args.message, '主人，咖啡已经泡好了哦～');
});

test('Wave 2: 离线规划验证 ServerSearchController 本地文件秒搜', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('VCPEverything'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {便利操作} 中的 `ServerSearchController`，搜索文件【*.pdf CMC数学竞赛】[数量:30]。');
    assert.equal(call.name, 'ServerSearchController');
    assert.equal(call.args.command, 'search');
    assert.equal(call.args.query, '*.pdf CMC数学竞赛');
    assert.equal(call.args.maxResults, '30');
});

test('Wave 2: 离线规划验证 AnkiSearch 卡片搜索与牌组统计', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('AnkiSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `AnkiSearch`，查看所有【牌组列表】。');
    assert.equal(call1.name, 'AnkiSearch');
    assert.equal(call1.args.command, 'anki_get_decks');

    const [call2] = await planner.plan('请使用 {便利操作} 中的 `AnkiSearch`，搜索卡片【deck:默认 is:due】。');
    assert.equal(call2.name, 'AnkiSearch');
    assert.equal(call2.args.command, 'anki_search_cards');
    assert.equal(call2.args.query, 'deck:默认 is:due');
});

test('Wave 2: 离线规划验证 JapaneseHelper 日语查词与假名阅读辅助', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('JapaneseHelper'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `JapaneseHelper`，查询日语单词【利害関係者】。');
    assert.equal(call1.name, 'JapaneseHelper');
    assert.equal(call1.args.command, 'JapaneseHelperLookup');
    assert.equal(call1.args.word, '利害関係者');

    const [call2] = await planner.plan('请使用 {便利操作} 中的 `JapaneseHelper`，进行句子阅读辅助【彼女は毎朝公園を走っている。】[N3]。');
    assert.equal(call2.name, 'JapaneseHelper');
    assert.equal(call2.args.command, 'JapaneseHelperPhase2');
    assert.equal(call2.args.text, '彼女は毎朝公園を走っている。');
    assert.equal(call2.args.target_level, 'N3');
});

test('Wave 2: 离线规划验证 LexibankOperator 全球词源智能路由与概念检索', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadBackendManifest('LexibankOperator'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {信息获取} 中的 `LexibankOperator`，进行词源追溯【日耳曼语系里 water 的同源词音变路径】[语系:Indo-European]。');
    assert.equal(call1.name, 'LexibankOperator');
    assert.equal(call1.args.command, 'JevRoute');
    assert.equal(call1.args.query, '日耳曼语系里 water 的同源词音变路径');
    assert.equal(call1.args.family, 'Indo-European');

    const [call2] = await planner.plan('请使用 {信息获取} 中的 `LexibankOperator`，按概念检索【water】。');
    assert.equal(call2.name, 'LexibankOperator');
    assert.equal(call2.args.command, 'concept_lookup');
    assert.equal(call2.args.concept, 'water');
});
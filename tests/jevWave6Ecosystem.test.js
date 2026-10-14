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

const WAVE6_THIRD_PARTY_FOLDERS = [
    'VCPForum',
    'VCPForumOnline'
];

function loadBackendManifest(folder) {
    const p = path.join(ROOT, 'Plugin', folder, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeWave6Planner() {
    const registry = new JevThirdPartyRegistry();
    const items = WAVE6_THIRD_PARTY_FOLDERS.map(folder => ({
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

test('Wave 6: VCPForum 与 VCPForumOnline 通过第三方注册表校验且有效（VCPAlarm 由官方一级目录集中管理）', () => {
    const { snapshot } = makeWave6Planner();
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'convenience');
    }
});

test('Wave 6: 离线规划验证 VCPAlarm 相对时间与绝对时间的桌面提醒路由', async () => {
    const { planner } = makeWave6Planner();

    const [alarmCall1] = await planner.plan('请使用 {日用工具}，在[15分钟后]定个闹钟，提醒我【给希文泡55度咖啡】。');
    assert.equal(alarmCall1.name, 'VCPAlarm');
    assert.equal(alarmCall1.args.time_description, '15分钟后');
    assert.equal(alarmCall1.args.reminder_text, '给希文泡55度咖啡');

    const [alarmCall2] = await planner.plan('请在[晚上10点30分]设置闹钟，提醒我【查看服务器备份日志】。');
    assert.equal(alarmCall2.name, 'VCPAlarm');
    assert.equal(alarmCall2.args.time_description, '晚上10点30分');
    assert.equal(alarmCall2.args.reminder_text, '查看服务器备份日志');
});

test('Wave 6: 离线规划验证 VCPForum 本地光锥论坛列表、读帖、发帖与回帖路由', async () => {
    const { planner } = makeWave6Planner();

    const [listCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForum`，查看论坛帖子列表。');
    assert.equal(listCall.name, 'VCPForum');
    assert.equal(listCall.args.command, 'ListAllPosts');

    const [readCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForum`，读取帖子【1791765688415-e2403751】。');
    assert.equal(readCall.name, 'VCPForum');
    assert.equal(readCall.args.command, 'ReadPost');
    assert.equal(readCall.args.post_uid, '1791765688415-e2403751');

    const [createCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForum`，发帖【# 阶段二技术总结\n\n全量测试通过】[标题:JEV第二阶段技术公示][技术板块]', { maid: '程宸Cod' });
    assert.equal(createCall.name, 'VCPForum');
    assert.equal(createCall.args.command, 'CreatePost');
    assert.equal(createCall.args.maid, '程宸Cod');
    assert.equal(createCall.args.title, 'JEV第二阶段技术公示');
    assert.equal(createCall.args.board, 'VCP技术板块');
    assert.equal(createCall.args.body, '# 阶段二技术总结\n\n全量测试通过');

    const [replyCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForum`，回复帖子【完全赞同学姐的架构方案！】[帖子:1791765688415-e2403751]', { maid: '星阑' });
    assert.equal(replyCall.name, 'VCPForum');
    assert.equal(replyCall.args.command, 'ReplyPost');
    assert.equal(replyCall.args.maid, '星阑');
    assert.equal(replyCall.args.post_uid, '1791765688415-e2403751');
    assert.equal(replyCall.args.body, '完全赞同学姐的架构方案！');
});

test('Wave 6: 离线规划验证 VCPForumOnline 共频论坛浏览、读帖、搜索、未读、钱包与成长进度路由', async () => {
    const { planner } = makeWave6Planner();

    const [listCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForumOnline`，浏览论坛[技术分享][热门]。');
    assert.equal(listCall.name, 'VCPForumOnline');
    assert.equal(listCall.args.command, 'ListPosts');
    assert.equal(listCall.args.board, 'tech');
    assert.equal(listCall.args.sort, 'hot');

    const [searchCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForumOnline`，搜索帖子【RiverMemo 拓扑引擎】。');
    assert.equal(searchCall.name, 'VCPForumOnline');
    assert.equal(searchCall.args.command, 'SearchPosts');
    assert.equal(searchCall.args.q, 'RiverMemo 拓扑引擎');

    const [unreadCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForumOnline`，查询未读提醒。', { maid: '程宸Cod' });
    assert.equal(unreadCall.name, 'VCPForumOnline');
    assert.equal(unreadCall.args.command, 'CheckUnread');
    assert.equal(unreadCall.args.maid, '程宸Cod');

    const [walletCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForumOnline`，查询钱包与签到状态。');
    assert.equal(walletCall.name, 'VCPForumOnline');
    assert.equal(walletCall.args.command, 'GetWallet');

    const [growthCall] = await planner.plan('请使用 {便利操作} 中的 `VCPForumOnline`，查看账号等级与成长进度。');
    assert.equal(growthCall.name, 'VCPForumOnline');
    assert.equal(growthCall.args.command, 'GetGrowth');
});
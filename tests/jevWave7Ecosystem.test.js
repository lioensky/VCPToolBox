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

function loadManifestFromBlock(folder) {
    const p = path.join(ROOT, 'Plugin', folder, 'plugin-manifest.json.block');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeWave7Planner() {
    const registry = new JevThirdPartyRegistry();
    const items = [
        { manifest: loadManifestFromBlock('VCPClawMail'), origin: 'local' }
    ];
    const snapshot = registry.build(items);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });
    return { registry, snapshot, planner };
}

test('Wave 7: VCPClawMail 邮件助手通过第三方注册表校验且状态为 valid', () => {
    const { snapshot } = makeWave7Planner();
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.validCount, 1);
    assert.equal(snapshot.invalidCount, 0);

    const entry = snapshot.entries[0];
    assert.equal(entry.pluginName, 'VCPClawMail');
    assert.equal(entry.validation.status, 'valid');
    assert.equal(entry.category, 'convenience');
    assert.equal(entry.commands.length, 3);
});

test('Wave 7: 离线规划验证 VCPClawMail 最近邮件、子邮箱槽位与未读布尔裁决', async () => {
    const { planner } = makeWave7Planner();

    // 1. 最近邮件 + 子邮箱 mail1 + 仅未读
    const [listCall] = await planner.plan('请使用 {便利操作} 中的 `VCPClawMail`，查看收件箱最近邮件[未读][mail1]。');
    assert.equal(listCall.name, 'VCPClawMail');
    assert.equal(listCall.args.command, 'list_recent');
    assert.equal(listCall.args.mailbox, 'mail1');
    assert.equal(listCall.args.unreadOnly, 'true');

    // 2. 读取特定邮件 + 标记已读布尔裁决
    const [readCall] = await planner.plan('请使用 {便利操作} 中的 `VCPClawMail`，读取邮件【msg_987654321】[标记已读]。');
    assert.equal(readCall.name, 'VCPClawMail');
    assert.equal(readCall.args.command, 'read_mail');
    assert.equal(readCall.args.mailId, 'msg_987654321');
    assert.equal(readCall.args.markRead, 'true');

    // 3. 邮箱文件夹列表
    const [folderCall] = await planner.plan('请使用 {便利操作} 中的 `VCPClawMail`，查看邮箱文件夹列表。');
    assert.equal(folderCall.name, 'VCPClawMail');
    assert.equal(folderCall.args.command, 'list_folders');
});

test('Wave 7: 架构边界守卫验证 DailyHot 与 WeatherInfoNow 静态折叠插件被注册表合规阻断', () => {
    const registry = new JevThirdPartyRegistry();
    const dailyHotManifest = loadManifestFromBlock('DailyHot');
    const weatherInfoManifest = loadManifestFromBlock('WeatherInfoNow');

    // 为 DailyHot 与 WeatherInfoNow 模拟附加合法的 jev 结构
    dailyHotManifest.jev = {
        schemaVersion: 1,
        enabled: true,
        category: '信息获取',
        jevDescPrompt: '每日热榜',
        jevPrompt: '获取热榜',
        commands: [{ commandIdentifier: 'get_hot', description: '获取热榜' }]
    };
    weatherInfoManifest.jev = {
        schemaVersion: 1,
        enabled: true,
        category: '信息获取',
        jevDescPrompt: '实时天气',
        jevPrompt: '查看天气',
        commands: [{ commandIdentifier: 'get_weather', description: '查看天气' }]
    };

    const snapshot = registry.build([
        { manifest: dailyHotManifest, origin: 'local' },
        { manifest: weatherInfoManifest, origin: 'local' }
    ]);

    // 两者均为 static 插件，必须被注册表物理阻断判定为 invalid
    assert.equal(snapshot.validCount, 0);
    assert.equal(snapshot.invalidCount, 2);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'invalid');
        const hasTypeError = entry.validation.errors.some(err => err.includes('不是可调用工具类型'));
        assert.equal(hasTypeError, true, `${entry.pluginName} 应当因 pluginType: static 被阻断`);
    }
});
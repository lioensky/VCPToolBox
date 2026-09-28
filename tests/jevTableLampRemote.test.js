'use strict';

// 用真实的 TableLampRemote 分布式插件 manifest 走一遍 JEV 第三方链路：
// 声明校验 → 反引号精确工具名路由 → 插件内部确定性参数裁决。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'VCPDistributedServer', 'Plugin', 'TableLampRemote', 'plugin-manifest.json');
const CONFIG_PATH = path.join(ROOT, 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(ROOT, 'TVStxt', 'JevToolCallDecision.txt');

function loadManifest() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    // 模拟主服务器 registerDistributedTools 之后的形态
    return { ...manifest, isDistributed: true, serverId: 'dist-test-node' };
}

function makePlanner({ configured = false, answers = {} } = {}) {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest(), origin: 'cloud', serverId: 'dist-test-node' }]);
    const decisions = [];
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' },
        jevClient: {
            isConfigured: () => configured,
            async decide(state, questions) {
                decisions.push({ state, questions });
                return { answers };
            }
        }
    });
    return { planner, registry, decisions };
}

test('TableLampRemote 声明通过校验并登记为分布式物联网控制插件', () => {
    const { registry } = makePlanner();
    const entry = registry.getEntry('TableLampRemote');
    assert.ok(entry, '应进入注册表');
    assert.equal(entry.validation.status, 'valid', entry.validation.errors.join('\n'));
    assert.equal(entry.category, 'iot_control');
    assert.equal(entry.origin, 'cloud');
    assert.equal(entry.serverId, 'dist-test-node');
    assert.equal(entry.callTemplate, '{物联网控制} `TableLampRemote` 【主要内容】[约束]');
});

test('打开台灯并设置亮度与色温：确定性裁决，不调用 JEV', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        '{物联网控制} `TableLampRemote` 打开台灯【我要看书】[亮度:80][色温:4000]',
        { args: { maid: 'Nova' } }
    );
    assert.equal(call.name, 'TableLampRemote');
    assert.deepEqual(call.args, {
        command: 'LampControl',
        power: 'true',
        brightness: '80',
        color_temperature: '4000',
        maid: 'Nova'
    });
    assert.equal(decisions.length, 0);
});

test('关灯只传 power=false', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 关灯【准备睡觉了】');
    assert.deepEqual(call.args, { command: 'LampControl', power: 'false' });
});

test('查询状态路由到 GetLampStatus 且不带控制参数', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 查询台灯状态【台灯】');
    assert.deepEqual(call.args, { command: 'GetLampStatus' });
});

test('只调亮度时 power 未决：JEV 概率居中则不传 power', async () => {
    const { planner, decisions } = makePlanner({
        configured: true,
        answers: { p_power: { type: 'noul', noul: 0.5 } }
    });
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 调节台灯【调暗一点】[亮度:30]');
    assert.deepEqual(call.args, { command: 'LampControl', brightness: '30' });
    assert.equal(decisions.length, 1);
    assert.deepEqual(Object.keys(decisions[0].questions), ['p_power']);
    assert.equal(decisions[0].state.plugin, 'TableLampRemote');
});

test('工具名、目录不符或文本超长时拒绝，不生成调用', async () => {
    const { planner } = makePlanner();
    await assert.rejects(
        planner.plan('{物联网控制} `tablelampremote` 打开台灯【看书】'),
        /逐字精确.*TableLampRemote/
    );
    await assert.rejects(
        planner.plan('{信息获取} `TableLampRemote` 打开台灯【看书】'),
        /注册在 \{物联网控制\}/
    );
    await assert.rejects(
        planner.plan('{物联网控制} `TableLampRemote` 打开台灯【看书】[亮度:12345]'),
        /超过上限 4/
    );
});
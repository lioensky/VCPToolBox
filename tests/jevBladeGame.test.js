'use strict';

// 用真实的 BladeGame / TableLampRemote 分布式插件 manifest 验证锚点主次：
// 【】主要目标决定命令与招式；[] 次要约束只做整条标签匹配，
// 自由文本台词只作为 reason 原样搬运，不参与意图识别。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const PLUGIN_ROOT = path.join(ROOT, 'VCPDistributedServer', 'Plugin');
const CONFIG_PATH = path.join(ROOT, 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(ROOT, 'TVStxt', 'JevToolCallDecision.txt');

function loadManifest(folder) {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, folder, 'plugin-manifest.json'), 'utf8'));
    return { ...manifest, isDistributed: true, serverId: 'dist-test-node' };
}

function makePlanner({ configured = false, answers = {} } = {}) {
    const registry = new JevThirdPartyRegistry();
    registry.build([
        { manifest: loadManifest('BladeGame'), origin: 'cloud', serverId: 'dist-test-node' },
        { manifest: loadManifest('TableLampRemote'), origin: 'cloud', serverId: 'dist-test-node' }
    ]);
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

test('BladeGame 声明通过校验并登记为媒体娱乐插件', () => {
    const { registry } = makePlanner();
    const entry = registry.getEntry('BladeGame');
    assert.ok(entry, '应进入注册表');
    assert.equal(entry.validation.status, 'valid', entry.validation.errors.join('\n'));
    assert.equal(entry.category, 'media_entertainment');
    assert.equal(entry.callTemplate, '{媒体娱乐} `BladeGame` 【主要内容】[约束]');
});

test('开始游戏：【】命中 StartGame，继承 maid，难度走前缀约束', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        '{媒体娱乐} `BladeGame` 【开始游戏】[难度:困难]',
        { args: { maid: '猫娘小克' } }
    );
    assert.equal(call.name, 'BladeGame');
    assert.deepEqual(call.args, {
        command: 'StartGame',
        difficulty: '困难',
        maid: '猫娘小克'
    });
    assert.equal(decisions.length, 0);
});

test('我决定使出【寒梅逐鹿】，[台词]：招式确定性命中，台词原样作为 reason', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        '{媒体娱乐} `BladeGame` 我决定使出【寒梅逐鹿】，[哼哼，你接得住我这一招吗！]'
    );
    assert.deepEqual(call.args, {
        command: 'PlayTurn',
        action: 'PlumBlossom',
        reason: '哼哼，你接得住我这一招吗！'
    });
    assert.equal(decisions.length, 0);
});

test('台词中出现其他招式名，不能覆盖【】主要目标', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan(
        '{媒体娱乐} `BladeGame` 使出【回光无影】[先蓄势再格挡？不，我偏要一剑定胜负！]'
    );
    assert.equal(call.args.command, 'PlayTurn');
    assert.equal(call.args.action, 'Flash');
    assert.equal(call.args.reason, '先蓄势再格挡？不，我偏要一剑定胜负！');
});

test('七个游戏招式名全部确定性映射', async () => {
    const { planner } = makePlanner();
    const moves = [
        ['蓄势', 'Charge'],
        ['斩击', 'Slash'],
        ['轻霜踏雪', 'LightStep'],
        ['寒梅逐鹿', 'PlumBlossom'],
        ['回光无影', 'Flash'],
        ['御剑格挡', 'Block'],
        ['太极两仪', 'Taiji']
    ];
    for (const [label, expected] of moves) {
        const [call] = await planner.plan(`{媒体娱乐} \`BladeGame\` 我决定使出【${label}】`);
        assert.equal(call.args.command, 'PlayTurn', label);
        assert.equal(call.args.action, expected, label);
        assert.equal(call.args.reason, undefined, label);
    }
});

test('只描述意图时招式交给 JEV，在七个候选内选择', async () => {
    const { planner, decisions } = makePlanner({
        configured: true,
        answers: { p_action: { type: 'choice', choice: 'Taiji', confidence: 0.9 } }
    });
    const [call] = await planner.plan(
        '{媒体娱乐} `BladeGame` 出招【对方剑气满了，我得防住他的大招】[看我以柔克刚。]'
    );
    assert.equal(call.args.command, 'PlayTurn');
    assert.equal(call.args.action, 'Taiji');
    assert.equal(call.args.reason, '看我以柔克刚。');
    assert.equal(decisions.length, 1);
    assert.deepEqual(
        Object.keys(decisions[0].questions.p_action.criteria).sort(),
        ['Block', 'Charge', 'Flash', 'LightStep', 'PlumBlossom', 'Slash', 'Taiji']
    );
});

test('招式无法判定且 JEV 不可用时拒绝执行，不猜测招式', async () => {
    const { planner } = makePlanner();
    await assert.rejects(
        planner.plan('{媒体娱乐} `BladeGame` 出招【随便来一下】'),
        /缺少必填参数 action/
    );
});

test('台词超长直接报错，不截断', async () => {
    const { planner } = makePlanner();
    await assert.rejects(
        planner.plan(`{媒体娱乐} \`BladeGame\` 使出【斩击】[${'喝'.repeat(201)}]`),
        /超过上限 200/
    );
});

test('台灯回归：意图写在【】里的两种措辞都确定性关灯，不依赖 JEV', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    for (const expression of [
        '请使用 {物联网控制} 中的 `TableLampRemote`，执行【关闭台灯】。',
        '请使用 {物联网控制} 中的 `TableLampRemote`，围绕【关闭台灯】来完成任务。'
    ]) {
        const [call] = await planner.plan(expression);
        assert.equal(call.name, 'TableLampRemote', expression);
        assert.deepEqual(call.args, { command: 'LampControl', power: 'false' }, expression);
    }
    assert.equal(decisions.length, 0);
});

test('目录不符时拒绝', async () => {
    const { planner } = makePlanner();
    await assert.rejects(
        planner.plan('{物联网控制} `BladeGame` 【开始游戏】'),
        /注册在 \{媒体娱乐\}/
    );
});
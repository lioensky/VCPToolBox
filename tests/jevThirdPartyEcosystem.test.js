// ======================================================================
//   🌌 华空城 JEV 第三方生态全域测试大典 (Consolidated Ecosystem Suite)
//   合并自 10 大生态测试：BladeGame、TableLampRemote 与 Wave 1 ~ Wave 8
//   特性：全用例独立沙箱、安全清单加载、缺失插件优雅跳过 (t.skip)
// ======================================================================

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
const LOCAL_DIST_ROOT = path.join(ROOT, 'VCPDistributedServer', 'Plugin');
const LOCAL_DIST_SPACED_ROOT = path.join(ROOT, 'VCP Distributed Server', 'Plugin');
const SIBLING_DIST_ROOT = path.join(ROOT, '..', 'VCPChat', 'VCPDistributedServer', 'Plugin');
const SIBLING_DIST_SPACED_ROOT = path.join(ROOT, '..', 'VCPChat', 'VCP Distributed Server', 'Plugin');

/**
 * 安全加载插件 Manifest 清单，不产生未捕获的 ENOENT 异常
 * @param {string} pluginName 插件名称
 * @param {'any'|'local'|'cloud'} [preferredOrigin='any'] 偏好来源
 * @returns {{manifest: object, origin: string, serverId?: string}|null}
 */
function safeLoadManifest(pluginName, preferredOrigin = 'any') {
    const localBackend = { path: path.join(ROOT, 'Plugin', pluginName, 'plugin-manifest.json'), origin: 'local' };
    const localBlock = { path: path.join(ROOT, 'Plugin', pluginName, 'plugin-manifest.json.block'), origin: 'local' };
    const localDist = { path: path.join(LOCAL_DIST_ROOT, pluginName, 'plugin-manifest.json'), origin: 'cloud' };
    const localDistSpaced = { path: path.join(LOCAL_DIST_SPACED_ROOT, pluginName, 'plugin-manifest.json'), origin: 'cloud' };
    const siblingDist = { path: path.join(SIBLING_DIST_ROOT, pluginName, 'plugin-manifest.json'), origin: 'cloud' };
    const siblingDistSpaced = { path: path.join(SIBLING_DIST_SPACED_ROOT, pluginName, 'plugin-manifest.json'), origin: 'cloud' };

    let candidates = [];
    if (preferredOrigin === 'cloud') {
        candidates = [localDist, localDistSpaced, siblingDist, siblingDistSpaced, localBackend, localBlock];
    } else if (preferredOrigin === 'local') {
        candidates = [localBackend, localBlock, localDist, localDistSpaced, siblingDist, siblingDistSpaced];
    } else {
        candidates = [localBackend, localBlock, localDist, localDistSpaced, siblingDist, siblingDistSpaced];
    }

    for (const c of candidates) {
        if (fs.existsSync(c.path)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(c.path, 'utf8'));
                const isDist = c.origin === 'cloud' || c.path.includes('VCPDistributedServer') || c.path.includes('VCP Distributed Server');
                return {
                    manifest: isDist ? { ...manifest, isDistributed: true, serverId: 'dist-test-node' } : manifest,
                    origin: c.origin,
                    serverId: isDist ? 'dist-test-node' : undefined
                };
            } catch {
                return null;
            }
        }
    }
    return null;
}

// 兼容老单测中的直接 loadManifest 调用
function loadManifest(name) {
    const item = safeLoadManifest(name);
    return item ? item.manifest : null;
}
function loadBackendManifest(name) {
    const item = safeLoadManifest(name, 'local');
    return item ? item.manifest : null;
}
function loadFrontendManifest(name) {
    const item = safeLoadManifest(name, 'cloud');
    return item ? item.manifest : null;
}
const loadManifestFromBlock = loadBackendManifest;

const WAVE1_PLUGINS = [
    'ZhihuSearch',
    'XiaohongshuFetch',
    'VolcSearch',
    'YoutubeFetch',
    'YoucomSearch',
    'BrowserSearch',
    'DeepWikiVCP',
    'DomainSafetyChecker',
    'TimedTaskQuery',
    'PubMedSearch'
];

/**
 * 生态测试规划器工厂：提供插件就绪守卫与优雅跳过机制
 * @param {object} t Node.js test 上下文
 * @param {string[]} pluginNames 依赖的插件列表
 * @param {object} options 配置选项
 * @returns {{registry: JevThirdPartyRegistry, snapshot: object, planner: JevToolCallExp, decisions: Array}|null}
 */
function makeEcosystemPlanner(t, pluginNames = [], { configured = false, answers = {} } = {}) {
    const missing = [];
    const items = [];
    for (const name of pluginNames) {
        const found = safeLoadManifest(name);
        if (!found) {
            missing.push(name);
        } else {
            items.push(found);
        }
    }
    if (missing.length > 0) {
        if (t && typeof t.skip === 'function') {
            t.skip(`[环境提示] 缺少可选插件 [${missing.join(', ')}]，当前环境优雅跳过`);
        }
        return null;
    }
    const registry = new JevThirdPartyRegistry();
    const snapshot = registry.build(items);
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
    return { registry, snapshot, planner, decisions };
}


// ----------------------------------------------------------------------
// 来源测试: tests/jevBladeGame.test.js
// 依赖插件: BladeGame, TableLampRemote
// ----------------------------------------------------------------------

test('BladeGame 声明通过校验并登记为媒体娱乐插件', (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { registry } = __env;
    const entry = registry.getEntry('BladeGame');
    assert.ok(entry, '应进入注册表');
    assert.equal(entry.validation.status, 'valid', entry.validation.errors.join('\n'));
    assert.equal(entry.category, 'media_entertainment');
    assert.equal(entry.callTemplate, '{媒体娱乐} `BladeGame` 【主要内容】[约束]');
});

test('开始游戏：【】命中 StartGame，继承 maid，难度走前缀约束', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"], { configured: true });
    if (!__env) return;
    const { planner, decisions } = __env;
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

test('我决定使出【寒梅逐鹿】，[台词]：招式确定性命中，台词原样作为 reason', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"], { configured: true });
    if (!__env) return;
    const { planner, decisions } = __env;
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

test('台词中出现其他招式名，不能覆盖【】主要目标', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    const [call] = await planner.plan(
        '{媒体娱乐} `BladeGame` 使出【回光无影】[先蓄势再格挡？不，我偏要一剑定胜负！]'
    );
    assert.equal(call.args.command, 'PlayTurn');
    assert.equal(call.args.action, 'Flash');
    assert.equal(call.args.reason, '先蓄势再格挡？不，我偏要一剑定胜负！');
});

test('七个游戏招式名全部确定性映射', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
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

test('只描述意图时招式交给 JEV，在七个候选内选择', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"], {
        configured: true,
        answers: { p_action: { type: 'choice', choice: 'Taiji', confidence: 0.9 } }
    });
    if (!__env) return;
    const { planner, decisions } = __env;
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

test('招式无法判定且 JEV 不可用时拒绝执行，不猜测招式', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    await assert.rejects(
        planner.plan('{媒体娱乐} `BladeGame` 出招【随便来一下】'),
        /缺少必填参数 action/
    );
});

test('台词超长直接报错，不截断', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    await assert.rejects(
        planner.plan(`{媒体娱乐} \`BladeGame\` 使出【斩击】[${'喝'.repeat(201)}]`),
        /超过上限 200/
    );
});

test('台灯回归：意图写在【】里的两种措辞都确定性关灯，不依赖 JEV', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"], { configured: true });
    if (!__env) return;
    const { planner, decisions } = __env;
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

test('目录不符时拒绝', async (t) => {
    const __env = makeEcosystemPlanner(t, ["BladeGame","TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    await assert.rejects(
        planner.plan('{物联网控制} `BladeGame` 【开始游戏】'),
        /注册在 \{媒体娱乐\}/
    );
});


// ----------------------------------------------------------------------
// 来源测试: tests/jevTableLampRemote.test.js
// 依赖插件: TableLampRemote
// ----------------------------------------------------------------------

test('TableLampRemote 声明通过校验并登记为分布式物联网控制插件', (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"]);
    if (!__env) return;
    const { registry } = __env;
    const entry = registry.getEntry('TableLampRemote');
    assert.ok(entry, '应进入注册表');
    assert.equal(entry.validation.status, 'valid', entry.validation.errors.join('\n'));
    assert.equal(entry.category, 'iot_control');
    assert.equal(entry.origin, 'cloud');
    assert.equal(entry.serverId, 'dist-test-node');
    assert.equal(entry.callTemplate, '{物联网控制} `TableLampRemote` 【主要内容】[约束]');
});

test('打开台灯并设置亮度与色温：确定性裁决，不调用 JEV', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"], { configured: true });
    if (!__env) return;
    const { planner, decisions } = __env;
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

test('关灯只传 power=false', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 关灯【准备睡觉了】');
    assert.deepEqual(call.args, { command: 'LampControl', power: 'false' });
});

test('查询状态路由到 GetLampStatus 且不带控制参数', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 查询台灯状态【台灯】');
    assert.deepEqual(call.args, { command: 'GetLampStatus' });
});

test('只调亮度时 power 未决：JEV 概率居中则不传 power', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"], {
        configured: true,
        answers: { p_power: { type: 'noul', noul: 0.5 } }
    });
    if (!__env) return;
    const { planner, decisions } = __env;
    const [call] = await planner.plan('{物联网控制} `TableLampRemote` 调节台灯【调暗一点】[亮度:30]');
    assert.deepEqual(call.args, { command: 'LampControl', brightness: '30' });
    assert.equal(decisions.length, 1);
    assert.deepEqual(Object.keys(decisions[0].questions), ['p_power']);
    assert.equal(decisions[0].state.plugin, 'TableLampRemote');
});

test('工具名、目录不符或文本超长时拒绝，不生成调用', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TableLampRemote"]);
    if (!__env) return;
    const { planner } = __env;
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


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave1Ecosystem.test.js
// 依赖插件: ZhihuSearch, XiaohongshuFetch, VolcSearch, YoutubeFetch, YoucomSearch, BrowserSearch, DeepWikiVCP, DomainSafetyChecker, TimedTaskQuery, PubMedSearch
// ----------------------------------------------------------------------

test('Wave 1: 全部 10 个信息获取/日常协作插件声明通过注册表校验且全部为 valid', (t) => {
    const __env = makeEcosystemPlanner(t, WAVE1_PLUGINS);
    if (!__env) return;
    const { snapshot } = __env;

    assert.equal(snapshot.total, WAVE1_PLUGINS.length);
    assert.equal(snapshot.validCount, WAVE1_PLUGINS.length);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.ok(entry.category === 'info_retrieval' || entry.category === 'convenience');
    }
});

test('Wave 1: 离线规划验证 ZhihuSearch 站内与全局搜索', async (t) => {
    const __env = makeEcosystemPlanner(t, ['ZhihuSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {信息获取} 中的 `ZhihuSearch`，在知乎上搜索【大语言模型】并限定[知乎站内]。');
    assert.equal(call1.name, 'ZhihuSearch');
    assert.equal(call1.args.command, 'ZhihuSearch');
    assert.equal(call1.args.query, '大语言模型');
    assert.equal(call1.args.search_type, 'zhihu_search');

    const [call2] = await planner.plan('请使用 {资讯获取} 中的 `ZhihuSearch`，进行[全网]学术搜索【量子计算】。');
    assert.equal(call2.name, 'ZhihuSearch');
    assert.equal(call2.args.search_type, 'global_search');
    assert.equal(call2.args.query, '量子计算');
});

test('Wave 1: 离线规划验证 XiaohongshuFetch 笔记抓取', async (t) => {
    const __env = makeEcosystemPlanner(t, ['XiaohongshuFetch']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {信息获取} 中的 `XiaohongshuFetch`，抓取小红书笔记【https://www.xiaohongshu.com/discovery/item/123456】。');
    assert.equal(call.name, 'XiaohongshuFetch');
    assert.equal(call.args.url, 'https://www.xiaohongshu.com/discovery/item/123456');
});

test('Wave 1: 离线规划验证 VolcSearch 中文检索与条数约束', async (t) => {
    const __env = makeEcosystemPlanner(t, ['VolcSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {信息获取} 中的 `VolcSearch`，检索【2026年开源大模型最新发布】，返回[条数:5]。');
    assert.equal(call.name, 'VolcSearch');
    assert.equal(call.args.query, '2026年开源大模型最新发布');
    assert.equal(call.args.count, '5');
});

test('Wave 1: 离线规划验证 YoutubeFetch 视频详情与多命令路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ['YoutubeFetch']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {信息获取} 中的 `YoutubeFetch`，获取视频详情【https://www.youtube.com/watch?v=dQw4w9WgXcQ】。');
    assert.equal(call1.name, 'YoutubeFetch');
    assert.equal(call1.args.command, 'YoutubeFetch');
    assert.equal(call1.args.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const [call2] = await planner.plan('请使用 {信息获取} 中的 `YoutubeFetch`，提取字幕【https://www.youtube.com/watch?v=dQw4w9WgXcQ】并排版为[纯文本]。');
    assert.equal(call2.name, 'YoutubeFetch');
    assert.equal(call2.args.command, 'YoutubeTranscript');
    assert.equal(call2.args.action, 'transcript');
    assert.equal(call2.args.format, 'merged');
});

test('Wave 1: 离线规划验证 YoucomSearch 国际网络搜索', async (t) => {
    const __env = makeEcosystemPlanner(t, ['YoucomSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {信息获取} 中的 `YoucomSearch`，检索【AGI前沿论文进展】，限定[一周内]。');
    assert.equal(call.name, 'YoucomSearch');
    assert.equal(call.args.query, 'AGI前沿论文进展');
    assert.equal(call.args.freshness, 'week');
});

test('Wave 1: 离线规划验证 BrowserSearch 真实浏览器搜索与引擎路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ['BrowserSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {信息获取} 中的 `BrowserSearch`，在[必应]上检索【Rust MoonAST 符号引擎】。');
    assert.equal(call.name, 'BrowserSearch');
    assert.equal(call.args.command, 'search');
    assert.equal(call.args.query, 'Rust MoonAST 符号引擎');
    assert.equal(call.args.engine, 'bing_cn');
});

test('Wave 1: 离线规划验证 DeepWikiVCP 开源架构问答与目录结构', async (t) => {
    const __env = makeEcosystemPlanner(t, ['DeepWikiVCP']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {信息获取} 中的 `DeepWikiVCP`，基于[仓库:lioensky/VCPToolBox]询问【插件生命周期管理机制】。');
    assert.equal(call1.name, 'DeepWikiVCP');
    assert.equal(call1.args.command, 'wiki_ask');
    assert.equal(call1.args.url, 'lioensky/VCPToolBox');
    assert.equal(call1.args.question, '插件生命周期管理机制');

    const [call2] = await planner.plan('请使用 {信息获取} 中的 `DeepWikiVCP`，查看文档目录[项目:lioensky/VCPChat]。');
    assert.equal(call2.name, 'DeepWikiVCP');
    assert.equal(call2.args.command, 'wiki_structure');
    assert.equal(call2.args.url, 'lioensky/VCPChat');
});

test('Wave 1: 离线规划验证 DomainSafetyChecker 域名与网址安全核查', async (t) => {
    const __env = makeEcosystemPlanner(t, ['DomainSafetyChecker']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {信息获取} 中的 `DomainSafetyChecker`，核查链接【https://suspicious-login.com/auth】的安全性。');
    assert.equal(call.name, 'DomainSafetyChecker');
    assert.equal(call.args.command, 'CheckUrlSafety');
    assert.equal(call.args.url, 'https://suspicious-login.com/auth');
});

test('Wave 1: 离线规划验证 TimedTaskQuery 定时任务查询与取消', async (t) => {
    const __env = makeEcosystemPlanner(t, ['TimedTaskQuery']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `TimedTaskQuery`，查询定时任务【task-1779106560000-650e398d】的执行结果。');
    assert.equal(call1.name, 'TimedTaskQuery');
    assert.equal(call1.args.command, 'QueryTimedTaskResult');
    assert.equal(call1.args.task_id, 'task-1779106560000-650e398d');
    assert.equal(call1.args.action, 'query');

    const [call2] = await planner.plan('请使用 {日常协作} 中的 `TimedTaskQuery`，[取消]排队定时任务【task-1779106560000-99999999】。');
    assert.equal(call2.name, 'TimedTaskQuery');
    assert.equal(call2.args.action, 'cancel');
});

test('Wave 1: 离线规划验证 PubMedSearch 生物医学文献检索与摘要获取', async (t) => {
    const __env = makeEcosystemPlanner(t, ['PubMedSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {信息获取} 中的 `PubMedSearch`，检索【CRISPR Cas9 基因治疗】并按[最新发表]排序。');
    assert.equal(call1.name, 'PubMedSearch');
    assert.equal(call1.args.command, 'search_articles');
    assert.equal(call1.args.query, 'CRISPR Cas9 基因治疗');
    assert.equal(call1.args.sort, 'pub_date');

    const [call2] = await planner.plan('请使用 {信息获取} 中的 `PubMedSearch`，获取文献摘要【37912345】。');
    assert.equal(call2.name, 'PubMedSearch');
    assert.equal(call2.args.command, 'get_abstract');
    assert.equal(call2.args.pmid, '37912345');
});


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave2Ecosystem.test.js
// 依赖插件: ScheduleManager, AgentMessage, VCPEverything, AnkiSearch, JapaneseHelper, LexibankOperator, WaitingForUrReply, TopicMemo, DeepMemo, TopicSponsor, LocalSearchController
// ----------------------------------------------------------------------

test('Wave 2: 前后端便利操作与物联网控制插件全部通过校验且有效', (t) => {
    const specs = [
        // 后端插件 (6个)
        { name: 'ScheduleManager', origin: 'local', load: loadBackendManifest },
        { name: 'AgentMessage', origin: 'local', load: loadBackendManifest },
        { name: 'VCPEverything', origin: 'local', load: loadBackendManifest },
        { name: 'AnkiSearch', origin: 'local', load: loadBackendManifest },
        { name: 'JapaneseHelper', origin: 'local', load: loadBackendManifest },
        { name: 'LexibankOperator', origin: 'local', load: loadBackendManifest },
        // 前端分布式插件 (6个)
        { name: 'WaitingForUrReply', origin: 'cloud', load: loadFrontendManifest },
        { name: 'TableLampRemote', origin: 'cloud', load: loadFrontendManifest },
        { name: 'TopicMemo', origin: 'cloud', load: loadFrontendManifest },
        { name: 'DeepMemo', origin: 'cloud', load: loadFrontendManifest },
        { name: 'TopicSponsor', origin: 'cloud', load: loadFrontendManifest },
        { name: 'VCPEverything', origin: 'cloud', load: loadFrontendManifest }
    ];
    const missing = [];
    const items = [];
    for (const s of specs) {
        const manifest = s.load(s.name);
        if (!manifest) {
            missing.push(`${s.name}(${s.origin})`);
        } else {
            items.push({ manifest, origin: s.origin });
        }
    }
    if (missing.length > 0) {
        t.skip(`[环境提示] 缺少可选插件 [${missing.join(', ')}]，当前环境优雅跳过`);
        return;
    }

    const registry = new JevThirdPartyRegistry();
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

test('Wave 2: 离线规划验证 WaitingForUrReply 桌面弹窗等待回复', async (t) => {
    const manifest = loadFrontendManifest('WaitingForUrReply');
    if (!manifest) {
        t.skip('[环境提示] 缺少可选插件 [WaitingForUrReply]，当前环境优雅跳过');
        return;
    }
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, origin: 'cloud' }]);
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

test('Wave 2: 离线规划验证 TopicMemo 话题回忆与历史对话阅读', async (t) => {
    const manifest = loadFrontendManifest('TopicMemo');
    if (!manifest) {
        t.skip('[环境提示] 缺少可选插件 [TopicMemo]，当前环境优雅跳过');
        return;
    }
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, origin: 'cloud' }]);
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

test('Wave 2: 离线规划验证 DeepMemo 跨话题深度回忆', async (t) => {
    const manifest = loadFrontendManifest('DeepMemo');
    if (!manifest) {
        t.skip('[环境提示] 缺少可选插件 [DeepMemo]，当前环境优雅跳过');
        return;
    }
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, origin: 'cloud' }]);
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

test('Wave 2: 离线规划验证 TopicSponsor 未读与未锁定话题查询', async (t) => {
    const manifest = loadFrontendManifest('TopicSponsor');
    if (!manifest) {
        t.skip('[环境提示] 缺少可选插件 [TopicSponsor]，当前环境优雅跳过');
        return;
    }
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, origin: 'cloud' }]);
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

test('Wave 2: 离线规划验证 ScheduleManager 查看、新增与删除日程', async (t) => {
    const __env = makeEcosystemPlanner(t, ['ScheduleManager']);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 2: 离线规划验证 AgentMessage 桌面即时通知推送', async (t) => {
    const __env = makeEcosystemPlanner(t, ['AgentMessage']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {便利操作} 中的 `AgentMessage`，推送桌面通知【主人，咖啡已经泡好了哦～】。');
    assert.equal(call.name, 'AgentMessage');
    assert.equal(call.args.command, 'AgentMessage');
    assert.equal(call.args.message, '主人，咖啡已经泡好了哦～');
});

test('Wave 2: 离线规划验证 ServerSearchController 本地文件秒搜', async (t) => {
    const manifest = loadBackendManifest('VCPEverything');
    if (!manifest) {
        t.skip('[环境提示] 缺少可选插件 [VCPEverything]，当前环境优雅跳过');
        return;
    }
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, origin: 'local' }]);
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

test('Wave 2: 离线规划验证 AnkiSearch 卡片搜索与牌组统计', async (t) => {
    const __env = makeEcosystemPlanner(t, ['AnkiSearch']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `AnkiSearch`，查看所有【牌组列表】。');
    assert.equal(call1.name, 'AnkiSearch');
    assert.equal(call1.args.command, 'anki_get_decks');

    const [call2] = await planner.plan('请使用 {便利操作} 中的 `AnkiSearch`，搜索卡片【deck:默认 is:due】。');
    assert.equal(call2.name, 'AnkiSearch');
    assert.equal(call2.args.command, 'anki_search_cards');
    assert.equal(call2.args.query, 'deck:默认 is:due');
});

test('Wave 2: 离线规划验证 JapaneseHelper 日语查词与假名阅读辅助', async (t) => {
    const __env = makeEcosystemPlanner(t, ['JapaneseHelper']);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 2: 离线规划验证 LexibankOperator 全球词源智能路由与概念检索', async (t) => {
    const __env = makeEcosystemPlanner(t, ['LexibankOperator']);
    if (!__env) return;
    const { planner } = __env;

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


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave3Ecosystem.test.js
// 依赖插件: VCPSuperDice, Randomness, TarotDivination, DigitalOracle, BangumiOperator, NeteaseMusic, SunoGen, MimoDubbing, TomatoNovel
// ----------------------------------------------------------------------

test('Wave 3: 全部 9 个媒体娱乐与生活服务多模态插件通过注册表校验且有效', (t) => {
    const __env = makeEcosystemPlanner(t, [
        'VCPSuperDice',
        'Randomness',
        'TarotDivination',
        'DigitalOracle',
        'BangumiOperator',
        'NeteaseMusic',
        'SunoGen',
        'MimoDubbing',
        'TomatoNovel'
    ]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 9);
    assert.equal(snapshot.validCount, 9);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.ok(
            entry.category === 'media_entertainment' || entry.category === 'life_services',
            `${entry.pluginName} 目录异常: ${entry.category}`
        );
    }
});

test('Wave 3: 离线规划验证 SuperDice 3D 物理骰子材质与魔法枚举裁决', async (t) => {
    const __env = makeEcosystemPlanner(t, ['VCPSuperDice']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `SuperDice`，投掷【2d6+1d20】并选用[宝石]材质、[月面慢落]魔法与[颜色:#8B5CF6]。');
    assert.equal(call.name, 'SuperDice');
    assert.equal(call.args.command, 'roll');
    assert.equal(call.args.notation, '2d6+1d20');
    assert.equal(call.args.theme, 'gemstone');
    assert.equal(call.args.magic, 'moon');
    assert.equal(call.args.themecolor, '#8B5CF6');
});

test('Wave 3: 离线规划验证 Randomness TRPG 掷骰、塔罗与卢恩符文三命令路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ['Randomness']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `Randomness`，执行跑团掷骰【(2d8+1d6)kh2+5】。');
    assert.equal(call1.name, 'Randomness');
    assert.equal(call1.args.command, 'rollDice');
    assert.equal(call1.args.diceString, '(2d8+1d6)kh2+5');

    const [call2] = await planner.plan('请使用 {休闲娱乐} 中的 `Randomness`，进行[卢恩符文]占卜[数量:3]。');
    assert.equal(call2.name, 'Randomness');
    assert.equal(call2.args.command, 'castRunes');
    assert.equal(call2.args.count, '3');
});

test('Wave 3: 离线规划验证 TarotDivination 牌阵与日月星三起源枚举裁决', async (t) => {
    const __env = makeEcosystemPlanner(t, ['TarotDivination']);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 3: 离线规划验证 DigitalOracle 全球金融宏观看板与定向信源抓取', async (t) => {
    const __env = makeEcosystemPlanner(t, ['DigitalOracle']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {生活服务} 中的 `DigitalOracle`，拉取【全球金融监控面板】。');
    assert.equal(call1.name, 'DigitalOracle');
    assert.equal(call1.args.command, 'DigitalOracleGlobalMacroDashboard');

    const [call2] = await planner.plan('请使用 {出行与金融} 中的 `DigitalOracle`，抓取市场数据[雅虎财经][标的:GC=F]。');
    assert.equal(call2.name, 'DigitalOracle');
    assert.equal(call2.args.command, 'DigitalOracleFetchMarketData');
    assert.equal(call2.args.provider, 'yahoo');
    assert.equal(call2.args.symbol, 'GC=F');
});

test('Wave 3: 离线规划验证 BangumiOperator 每日放送表与番剧角色搜索', async (t) => {
    const __env = makeEcosystemPlanner(t, ['BangumiOperator']);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 3: 离线规划验证 NeteaseMusic 搜歌与每日推荐', async (t) => {
    const __env = makeEcosystemPlanner(t, ['NeteaseMusic']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `NeteaseMusic`，[搜索歌曲]【晴天 周杰伦】。');
    assert.equal(call1.name, 'NeteaseMusic');
    assert.equal(call1.args.action, 'search');
    assert.equal(call1.args.keywords, '晴天 周杰伦');

    const [call2] = await planner.plan('请使用 {媒体娱乐} 中的 `NeteaseMusic`，获取今日[每日推荐]歌单。');
    assert.equal(call2.name, 'NeteaseMusic');
    assert.equal(call2.args.action, 'daily_recommend');
});

test('Wave 3: 离线规划验证 SunoGen AI 作曲与纯音乐伴奏布尔裁决', async (t) => {
    const __env = makeEcosystemPlanner(t, ['SunoGen']);
    if (!__env) return;
    const { planner } = __env;

    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `SunoGen`，创作【一首关于星空与数学梦想的安静钢琴曲】[纯音乐][v4]。');
    assert.equal(call.name, 'SunoGen');
    assert.equal(call.args.command, 'generate_song');
    assert.equal(call.args.gpt_description_prompt, '一首关于星空与数学梦想的安静钢琴曲');
    assert.equal(call.args.make_instrumental, 'true');
    assert.equal(call.args.mv, 'chirp-v4');
});

test('Wave 3: 离线规划验证 MimoDubbing 多声线语音合成与状态查询', async (t) => {
    const __env = makeEcosystemPlanner(t, ['MimoDubbing']);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 3: 离线规划验证 TomatoNovel 搜书与大纲提取', async (t) => {
    const __env = makeEcosystemPlanner(t, ['TomatoNovel']);
    if (!__env) return;
    const { planner } = __env;

    const [call1] = await planner.plan('请使用 {媒体娱乐} 中的 `TomatoNovel`，[搜书]【十日终焉】。');
    assert.equal(call1.name, 'TomatoNovel');
    assert.equal(call1.args.action, 'search');
    assert.equal(call1.args.query, '十日终焉');

    const [call2] = await planner.plan('请使用 {媒体娱乐} 中的 `TomatoNovel`，[提取大纲]【7580018670118652952】。');
    assert.equal(call2.name, 'TomatoNovel');
    assert.equal(call2.args.action, 'download_intro');
    assert.equal(call2.args.query, '7580018670118652952');
});

// ----------------------------------------------------------------------
// 来源测试: tests/jevWave4Ecosystem.test.js
// 依赖插件: FluxGen, NovelAIGen, ComfyUIGen, ComfyCloudGen, WebUIGen, DMXDoubaoGen, GeminiImageGen, QwenImageGen, SenseGen, AgnesGen, AgnesVideoGen, GrokVideo, VideoGenerator, SunoMusicGen
// ----------------------------------------------------------------------

test('Wave 4: 全部 14 个第三方视觉创作、视频与音乐生成插件通过注册表校验且有效（DoubaoGen 由官方一级目录集中管理）', (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 14);
    assert.equal(snapshot.validCount, 14);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'media_entertainment');
    }
});

test('Wave 4: 离线规划验证 FluxGen 画幅枚举裁决', async (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { planner } = __env;
    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `FluxGen`，生成图片【赛博朋克雨夜中的橙发少女，霓虹光影】[壁纸]。');
    assert.equal(call.name, 'FluxGen');
    assert.equal(call.args.prompt, '赛博朋克雨夜中的橙发少女，霓虹光影');
    assert.equal(call.args.resolution, '1024x576');
});

test('Wave 4: 离线规划验证 NovelAIGen 多命令路由（文生图、放大、标签建议、订阅查询）', async (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { planner } = __env;

    const [genCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【1girl, silver hair, golden eyes, masterpiece】[竖屏][负面:lowres]。');
    assert.equal(genCall.name, 'NovelAIGen');
    assert.equal(genCall.args.command, 'NovelAIGenerate');
    assert.equal(genCall.args.prompt, '1girl, silver hair, golden eyes, masterpiece');
    assert.equal(genCall.args.resolution, '832x1216');
    assert.equal(genCall.args.uc, 'lowres');

    const [upCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，高清放大[https://example.com/anime.png]。');
    assert.equal(upCall.name, 'NovelAIGen');
    assert.equal(upCall.args.command, 'NovelAIUpscale');
    assert.equal(upCall.args.image, 'https://example.com/anime.png');

    const [subCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，查询余额与订阅状态。');
    assert.equal(subCall.name, 'NovelAIGen');
    assert.equal(subCall.args.command, 'NovelAISubscription');
});

test('Wave 4: 离线规划验证 ComfyUIGen、ComfyCloudGen 与 WebUIGen', async (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { planner } = __env;

    const [comfyCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ComfyUIGen`，工作流生图【1girl, blue eyes, cinematic】[工作流:AnimaEZGen][负面:bad hands]。');
    assert.equal(comfyCall.name, 'ComfyUIGen');
    assert.equal(comfyCall.args.prompt, '1girl, blue eyes, cinematic');
    assert.equal(comfyCall.args.workflow, 'AnimaEZGen');
    assert.equal(comfyCall.args.negative_prompt, 'bad hands');

    const [cloudCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ComfyCloudGen`，云端生图【a beautiful anime girl with pink hair】[模板:FluxDev]。');
    assert.equal(cloudCall.name, 'ComfyCloudGen');
    assert.equal(cloudCall.args.command, 'GenerateImage');
    assert.equal(cloudCall.args.workflow, 'FluxDev');

    const [webuiCall] = await planner.plan('请使用 {媒体娱乐} 中的 `WebUIGen`，WebUI生图【a cute anime girl】[高清方图]。');
    assert.equal(webuiCall.name, 'WebUIGen');
    assert.equal(webuiCall.args.resolution, '1024x1024');
});

test('Wave 4: 离线规划验证 DMXDoubaoGen、DoubaoGen、GeminiImageGen、QwenImageGen 与 SenseGen', async (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { planner } = __env;

    const [dmxCall] = await planner.plan('请使用 {媒体娱乐} 中的 `DMXDoubaoGen`，修图【给女孩戴上墨镜】[https://example.com/girl.png]。');
    assert.equal(dmxCall.name, 'DMXDoubaoGen');
    assert.equal(dmxCall.args.command, 'DoubaoEditImage');
    assert.equal(dmxCall.args.image, 'https://example.com/girl.png');

    const [doubaoCall] = await planner.plan("请使用 {图片生成} 能力，用 '豆包' 生成【身披未来机甲的猫咪武士】[高清方图]。");
    assert.equal(doubaoCall.name, 'DoubaoGen');
    assert.equal(doubaoCall.args.prompt, '身披未来机甲的猫咪武士');
    assert.equal(doubaoCall.args.size, '2048x2048');

    const [geminiCall] = await planner.plan('请使用 {媒体娱乐} 中的 `GeminiImageGen`，编辑图片【在旁边加一只羊驼】[https://example.com/me.png]。');
    assert.equal(geminiCall.name, 'GeminiImageGen');
    assert.equal(geminiCall.args.command, 'GeminiEditImage');
    assert.equal(geminiCall.args.image_url, 'https://example.com/me.png');

    const [qwenCall] = await planner.plan('请使用 {媒体娱乐} 中的 `QwenImageGen`，千问生图【宇航员猫咪在月球】[横屏]。');
    assert.equal(qwenCall.name, 'QwenImageGen');
    assert.equal(qwenCall.args.command, 'GenerateImage');
    assert.equal(qwenCall.args.image_size, '1664x928');

    const [senseCall] = await planner.plan('请使用 {媒体娱乐} 中的 `SenseGen`，生成信息图【AI时代个人知识管理系统三栏架构】[横版PPT]。');
    assert.equal(senseCall.name, 'SenseGen');
    assert.equal(senseCall.args.command, 'SenseGenerateDocumentImage');
    assert.equal(senseCall.args.size, '2752x1536');
});

test('Wave 4: 离线规划验证 AgnesGen、AgnesVideoGen、GrokVideoGen、Wan2.1VideoGen 与 SunoMusicGen', async (t) => {
    const __env = makeEcosystemPlanner(t, ["FluxGen","NovelAIGen","ComfyUIGen","ComfyCloudGen","WebUIGen","DMXDoubaoGen","GeminiImageGen","QwenImageGen","SenseGen","AgnesGen","AgnesVideoGen","GrokVideo","VideoGenerator","SunoMusicGen"]);
    if (!__env) return;
    const { planner } = __env;

    const [agnesImg] = await planner.plan('请使用 {媒体娱乐} 中的 `AgnesGen`，生成图像【云雾峡谷上的发光浮空城】[竖屏]。');
    assert.equal(agnesImg.name, 'AgnesGen');
    assert.equal(agnesImg.args.size, '768x1024');

    const [agnesVid] = await planner.plan('请使用 {媒体娱乐} 中的 `AgnesVideoGen`，生成视频【赛博朋克猫咪雨夜漫步】[10秒]。');
    assert.equal(agnesVid.name, 'AgnesVideoGen');
    assert.equal(agnesVid.args.command, 'submit');
    assert.equal(agnesVid.args.num_frames, '241');

    const [grokVid] = await planner.plan('请使用 {媒体娱乐} 中的 `GrokVideoGen`，图生视频【镜头缓缓推进】[https://example.com/city.png]。');
    assert.equal(grokVid.name, 'GrokVideoGen');
    assert.equal(grokVid.args.command, 'submit');
    assert.equal(grokVid.args.image_url, 'https://example.com/city.png');

    const [wanVid] = await planner.plan('请使用 {媒体娱乐} 中的 `Wan2.1VideoGen`，生成视频【橘猫在太空漫步】[文生视频][竖屏]。');
    assert.equal(wanVid.name, 'Wan2.1VideoGen');
    assert.equal(wanVid.args.command, 'submit');
    assert.equal(wanVid.args.mode, 't2v');
    assert.equal(wanVid.args.resolution, '720x1280');

    const [sunoAsync] = await planner.plan('请使用 {媒体娱乐} 中的 `SunoMusicGen`，创作音乐【深夜阅读的安静大提琴曲】[纯音乐][V5]。');
    assert.equal(sunoAsync.name, 'SunoMusicGen');
    assert.equal(sunoAsync.args.command, 'submit');
    assert.equal(sunoAsync.args.instrumental, 'true');
    assert.equal(sunoAsync.args.model, 'V5');
});


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave5Ecosystem.test.js
// 依赖插件: ArtistMatcher, DailyNoteSearcher
// ----------------------------------------------------------------------

test('Wave 5: ArtistMatcher 与 DailyNoteSearcher 通过第三方注册表校验且有效（SciCalculator 由官方一级目录集中管理）', (t) => {
    const __env = makeEcosystemPlanner(t, ["ArtistMatcher","DailyNoteSearcher"]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
    }
});

test('Wave 5: 离线规划验证 SciCalculator 复杂微积分与带数组方括号公式的无损透传', async (t) => {
    const __env = makeEcosystemPlanner(t, ["ArtistMatcher","DailyNoteSearcher"]);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 5: 离线规划验证 ArtistMatcher 查询特定画师与无主负载随机画师灵感串路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ["ArtistMatcher","DailyNoteSearcher"]);
    if (!__env) return;
    const { planner } = __env;

    const [findCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ArtistMatcher`，查询画师【Krenz Cushart】。');
    assert.equal(findCall.name, 'ArtistMatcher');
    assert.equal(findCall.args.command, 'FindArtist');
    assert.equal(findCall.args.artist_name, 'Krenz Cushart');

    const [randomCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ArtistMatcher`，生成随机画师串。');
    assert.equal(randomCall.name, 'ArtistMatcher');
    assert.equal(randomCall.args.command, 'GetRandomArtistString');
});

test('Wave 5: 离线规划验证 DailyNoteSearcher 全库精确检索与指定目录 BM25 检索路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ["ArtistMatcher","DailyNoteSearcher"]);
    if (!__env) return;
    const { planner } = __env;

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


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave6Ecosystem.test.js
// 依赖插件: VCPForum, VCPForumOnline
// ----------------------------------------------------------------------

test('Wave 6: VCPForum 与 VCPForumOnline 通过第三方注册表校验且有效（VCPAlarm 由官方一级目录集中管理）', (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPForum","VCPForumOnline"]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'convenience');
    }
});

test('Wave 6: 离线规划验证 VCPAlarm 相对时间与绝对时间的桌面提醒路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPForum","VCPForumOnline"]);
    if (!__env) return;
    const { planner } = __env;

    const [alarmCall1] = await planner.plan('请使用 {日用工具}，在[15分钟后]定个闹钟，提醒我【给希文泡55度咖啡】。');
    assert.equal(alarmCall1.name, 'VCPAlarm');
    assert.equal(alarmCall1.args.time_description, '15分钟后');
    assert.equal(alarmCall1.args.reminder_text, '给希文泡55度咖啡');

    const [alarmCall2] = await planner.plan('请在[晚上10点30分]设置闹钟，提醒我【查看服务器备份日志】。');
    assert.equal(alarmCall2.name, 'VCPAlarm');
    assert.equal(alarmCall2.args.time_description, '晚上10点30分');
    assert.equal(alarmCall2.args.reminder_text, '查看服务器备份日志');
});

test('Wave 6: 离线规划验证 VCPForum 本地光锥论坛列表、读帖、发帖与回帖路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPForum","VCPForumOnline"]);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 6: 离线规划验证 VCPForumOnline 共频论坛浏览、读帖、搜索、未读、钱包与成长进度路由', async (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPForum","VCPForumOnline"]);
    if (!__env) return;
    const { planner } = __env;

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


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave7Ecosystem.test.js
// 依赖插件: VCPClawMail
// ----------------------------------------------------------------------

test('Wave 7: VCPClawMail 邮件助手通过第三方注册表校验且状态为 valid', (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPClawMail"]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.validCount, 1);
    assert.equal(snapshot.invalidCount, 0);

    const entry = snapshot.entries[0];
    assert.equal(entry.pluginName, 'VCPClawMail');
    assert.equal(entry.validation.status, 'valid');
    assert.equal(entry.category, 'convenience');
    assert.equal(entry.commands.length, 3);
});

test('Wave 7: 离线规划验证 VCPClawMail 最近邮件、子邮箱槽位与未读布尔裁决', async (t) => {
    const __env = makeEcosystemPlanner(t, ["VCPClawMail"]);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 7: 架构边界守卫验证 DailyHot 与 WeatherInfoNow 静态折叠插件被注册表合规阻断', (t) => {
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


// ----------------------------------------------------------------------
// 来源测试: tests/jevWave8Ecosystem.test.js
// 依赖插件: TinyFishBrowser, FlashDeepSearch
// ----------------------------------------------------------------------

test('Wave 8: TinyFishBrowser 与 FlashDeepSearch 通过第三方注册表校验且状态为 valid', (t) => {
    const __env = makeEcosystemPlanner(t, ["TinyFishBrowser","FlashDeepSearch"]);
    if (!__env) return;
    const { snapshot } = __env;
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.validCount, 2);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'info_retrieval');
    }
});

test('Wave 8: 离线规划验证 TinyFishBrowser 结构化搜索与真实无头浏览器 JS 渲染抓取', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TinyFishBrowser","FlashDeepSearch"]);
    if (!__env) return;
    const { planner } = __env;

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

test('Wave 8: 离线规划验证 FlashDeepSearch 子Agent深度研究研报主题与广度约束', async (t) => {
    const __env = makeEcosystemPlanner(t, ["TinyFishBrowser","FlashDeepSearch"]);
    if (!__env) return;
    const { planner } = __env;

    const [researchCall] = await planner.plan('请使用 {信息获取} 中的 `FlashDeepSearch`，深度研究【探讨人工智能在气候变化建模中的应用及其伦理影响】[广度:12]。');
    assert.equal(researchCall.name, 'FlashDeepSearch');
    assert.equal(researchCall.args.command, 'StartResearch');
    assert.equal(researchCall.args.SearchContent, '探讨人工智能在气候变化建模中的应用及其伦理影响');
    assert.equal(researchCall.args.SearchBroadness, '12');
});


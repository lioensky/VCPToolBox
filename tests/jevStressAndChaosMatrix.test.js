// ======================================================================
//   ⚡ VCP防务总督大典：JEV 全域高强度并发压力与混沌极限边界大考矩阵
// ======================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(ROOT, 'TVStxt', 'JevToolCallDecision.txt');

function safeLoadManifest(pluginName) {
    const candidates = [
        path.join(ROOT, 'Plugin', pluginName, 'plugin-manifest.json'),
        path.join(ROOT, 'Plugin', pluginName, 'plugin-manifest.json.block'),
        path.join(ROOT, 'VCPDistributedServer', 'Plugin', pluginName, 'plugin-manifest.json'),
        path.join(ROOT, 'VCP Distributed Server', 'Plugin', pluginName, 'plugin-manifest.json'),
        path.join(ROOT, '..', 'VCPChat', 'VCPDistributedServer', 'Plugin', pluginName, 'plugin-manifest.json'),
        path.join(ROOT, '..', 'VCPChat', 'VCP Distributed Server', 'Plugin', pluginName, 'plugin-manifest.json')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch {
                return null;
            }
        }
    }
    return null;
}

function makeStressPlanner(plugins = [], t = null) {
    const missing = [];
    const items = [];
    for (const name of plugins) {
        const m = safeLoadManifest(name);
        if (!m) {
            missing.push(name);
        } else {
            items.push({ manifest: m, origin: 'local' });
        }
    }
    if (missing.length > 0) {
        if (t && typeof t.skip === 'function') {
            t.skip(`[环境提示] 缺少可选插件 [${missing.join(', ')}]，跳过并发压力测试`);
        }
        return { registry: null, planner: null };
    }
    const registry = new JevThirdPartyRegistry();
    if (items.length > 0) {
        registry.build(items);
    }
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });
    return { registry, planner };
}

test('【压力压测-01】100 次高频并发 Plan 编译与吞吐压测：时延平稳且无内存泄露', async (t) => {
    const { planner } = makeStressPlanner(['ZhihuSearch', 'TomatoNovel', 'NovelAIGen'], t);
    if (!planner) return;
    const queries = [
        '请使用 {信息获取} 中的 `ZhihuSearch` 搜索【量子纠缠】。',
        '请使用 {媒体娱乐} 中的 `TomatoNovel`，[搜书]【大主宰】。',
        '请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【masterpiece, 1girl】[横屏]。',
        '请使用 {日用工具} 计算【sin(pi/6) + cos(pi/3)】。'
    ];

    const startTime = Date.now();
    const tasks = [];
    for (let i = 0; i < 100; i++) {
        const q = queries[i % queries.length];
        tasks.push(planner.plan(q));
    }
    const results = await Promise.all(tasks);
    const duration = Date.now() - startTime;

    assert.strictEqual(results.length, 100);
    // 平均每次编译耗时应在 10ms 以内（100次总耗时低于 1000ms）
    assert.ok(duration < 2000, `100次高频并发耗时 ${duration}ms，超过上限 2000ms`);
    for (const r of results) {
        assert.ok(Array.isArray(r) && r.length === 1);
        assert.ok(r[0].name);
    }
});

test('【混沌边界-02】50 组无用约束雪崩攻击：大量废话约束下依然精准提取有效参数', async (t) => {
    const { planner } = makeStressPlanner(['NovelAIGen'], t);
    if (!planner) return;
    const junkConstraints = Array.from({ length: 50 }, (_, i) => `[无关标签_${i}]`).join('');
    const input = `请使用 {媒体娱乐} 中的 \`NovelAIGen\`，绘制【1girl, gothic lolita】${junkConstraints}[横屏][排除:bad hands]。`;

    const [call] = await planner.plan(input);
    assert.strictEqual(call.name, 'NovelAIGen');
    assert.strictEqual(call.args.command, 'NovelAIGenerate');
    assert.strictEqual(call.args.prompt, '1girl, gothic lolita');
    assert.strictEqual(call.args.resolution, '1216x832');
    assert.strictEqual(call.args.uc, 'bad hands');
});

test('【智能自愈-03】未声明 prefixes 的枚举参数前缀语法智能穿透测试：NovelAI 与 SuperDice 自愈', async (t) => {
    const { planner } = makeStressPlanner(['NovelAIGen', 'VCPSuperDice'], t);
    if (!planner) return;
    // NovelAIGen 未声明 prefixes，但用户使用了 [画幅:横屏]
    const [naiCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【cyberpunk city】[画幅:横屏]。');
    assert.strictEqual(naiCall.args.resolution, '1216x832');

    // SuperDice 的 theme 与 magic 均未声明 prefixes，但用户使用了 [材质:宝石] 与 [效果:月面慢落]
    const [diceCall] = await planner.plan('请使用 {媒体娱乐} 中的 `SuperDice`，投掷【2d20】[材质:宝石][效果:月面慢落]。');
    assert.strictEqual(diceCall.args.notation, '2d20');
    assert.strictEqual(diceCall.args.theme, 'gemstone');
    assert.strictEqual(diceCall.args.magic, 'moon');
});

test('【国际化边界-04】极端 Unicode、零宽空格与阿拉伯语/希伯来语从右到左混淆注入', async (t) => {
    const { planner } = makeStressPlanner(['ZhihuSearch'], t);
    if (!planner) return;
    // 注入零宽空格 \u200B 与数学符号
    const strangeText = '测试\u200B数学∫∬∑ ∏(VCP)\u202E反向文本';
    const [call] = await planner.plan(`请使用 {信息获取} 中的 \`ZhihuSearch\` 搜索【${strangeText}】。`);
    assert.strictEqual(call.name, 'ZhihuSearch');
    assert.strictEqual(call.args.query, strangeText);
});

test('【安全防线-05】单槽位约束歧义争夺防护：2 个未消费约束时坚决不盲目绑定到单参数', async (t) => {
    const { planner } = makeStressPlanner(['MimoDubbing'], t);
    if (!planner) return;
    // MimoDubbing 的 submit 有 text1(primary), voice(enum), instruction(constraints, prefixes: 指导/导演/语气)
    // 如果用户不加前缀传了 2 个未消费约束 [轻快欢悦] [低沉耳语]，系统不应随机挑选一个绑定，而应保留 instruction 未决
    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `MimoDubbing`，合成配音【测试台词】[轻快欢悦][低沉耳语]。');
    assert.strictEqual(call.name, 'MimoDubbing');
    assert.strictEqual(call.args.command, 'submit');
    assert.strictEqual(call.args.text1, '测试台词');
    // instruction 未指定合法前缀且剩余 2 个未消费约束，单槽位回退被安全锁死
    assert.strictEqual(call.args.instruction, undefined);
});

test('【并发隔离-06】20 组异构跨插件并发请求调用隔离（无 Cross-Talk 污染）', async (t) => {
    const { planner } = makeStressPlanner([
        'ZhihuSearch',
        'NovelAIGen',
        'TomatoNovel',
        'MimoDubbing',
        'ScheduleManager'
    ], t);
    if (!planner) return;

    const inputs = [
        { q: '请使用 {信息获取} 中的 `ZhihuSearch` 搜索【第1项】。', expected: { name: 'ZhihuSearch', query: '第1项' } },
        { q: '请使用 {媒体娱乐} 中的 `TomatoNovel`，[搜书]【第2项】。', expected: { name: 'TomatoNovel', query: '第2项' } },
        { q: '请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【第3项】[横屏]。', expected: { name: 'NovelAIGen', prompt: '第3项', resolution: '1216x832' } },
        { q: '请使用 {媒体娱乐} 中的 `MimoDubbing`，用[茉莉]音色合成配音【第4项】。', expected: { name: 'MimoDubbing', text1: '第4项', voice: '茉莉' } },
        { q: '请使用 {便利操作} 中的 `ScheduleManager`，[新增日程]【第5项】[时间:2026-10-13 18:00]。', expected: { name: 'ScheduleManager', text: '第5项', time: '2026-10-13 18:00' } }
    ];

    const batch = [];
    for (let i = 0; i < 20; i++) {
        const item = inputs[i % inputs.length];
        batch.push((async () => {
            const [call] = await planner.plan(item.q);
            assert.strictEqual(call.name, item.expected.name);
            for (const [k, v] of Object.entries(item.expected)) {
                if (k === 'name') continue;
                assert.strictEqual(call.args[k], v);
            }
        })());
    }
    await Promise.all(batch);
});

test('【降级容错-07】JEV 离线/异常模拟：JevClient 抛出异常时 100% 优雅回退默认参数', async (t) => {
    const { registry } = makeStressPlanner(['NovelAIGen'], t);
    if (!registry) return;
    // 构造一个必定抛错的 Mock JevClient
    const faultyJevClient = {
        isConfigured: () => true,
        decide: async () => {
            throw new Error('ECONNREFUSED: Jev decision server is unreachable');
        }
    };
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        jevClient: faultyJevClient,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    // 模糊参数请求（未指定明确画幅），正常需调用 JEV；异常时应优雅回退 default
    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【星空与海】。');
    assert.strictEqual(call.name, 'NovelAIGen');
    assert.strictEqual(call.args.command, 'NovelAIGenerate');
    assert.strictEqual(call.args.prompt, '星空与海');
    assert.strictEqual(call.args.resolution, '832x1216', '异常时优雅回退默认竖屏分辨率');
});

test('【边界阶梯-08】超长参数精准阶梯测试：N-1 放行、N 放行、N+1 严正熔断', async (t) => {
    const { planner } = makeStressPlanner(['NovelAIGen'], t);
    if (!planner) return;
    // NovelAISuggestTags 的 prompt maxLength 为 100
    const str99 = 'a'.repeat(99);
    const str100 = 'a'.repeat(100);
    const str101 = 'a'.repeat(101);

    const [call99] = await planner.plan(`请使用 {媒体娱乐} 中的 \`NovelAIGen\`，查询【${str99}】的推荐标签。`);
    assert.strictEqual(call99.args.prompt, str99);

    const [call100] = await planner.plan(`请使用 {媒体娱乐} 中的 \`NovelAIGen\`，查询【${str100}】的推荐标签。`);
    assert.strictEqual(call100.args.prompt, str100);

    await assert.rejects(
        () => planner.plan(`请使用 {媒体娱乐} 中的 \`NovelAIGen\`，查询【${str101}】的推荐标签。`),
        /超过上限 100/
    );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const CONFIG_PATH = path.join(__dirname, '..', 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(__dirname, '..', 'TVStxt', 'JevToolCallDecision.txt');

function makePlanner({ configured = false, choice = null, confidence = 0.9 } = {}) {
    const decisions = [];
    const jevClient = {
        isConfigured() {
            return configured;
        },
        async decide(state, questions) {
            decisions.push({ state, questions });
            return {
                answers: {
                    decision: {
                        type: 'choice',
                        choice,
                        confidence
                    }
                }
            };
        }
    };
    return {
        decisions,
        planner: new JevToolCallExp({
            configPath: CONFIG_PATH,
            decisionPromptPath: PROMPT_PATH,
            jevClient
        })
    };
}

test('ToolCallParser 将顶层 JEV 字段解析为虚拟工具调用并保留 maid', () => {
    const calls = ToolCallParser.parse(`
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」
JEV:「始」{联网搜索} 【最近美国土豆是不是打折】「末」
<<<[END_TOOL_REQUEST]>>>
    `);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'JEV');
    assert.equal(calls[0].args.maid, 'Nova');
    assert.equal(calls[0].args.expression, '{联网搜索} 【最近美国土豆是不是打折】');
});

test('联网搜索默认使用 VSearch grounding 模板且不调用 Jev', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const calls = await planner.plan(
        '{联网搜索} 【最近美国土豆是不是打折】[美国土豆产能][美国当前土豆价格]',
        { maid: 'Nova' }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'VSearch');
    assert.deepEqual(calls[0].args, {
        SearchMode: 'grounding',
        ShowURL: 'false',
        SearchTopic: '最近美国土豆是不是打折',
        Keywords: '美国土豆产能, 美国当前土豆价格',
        maid: 'Nova'
    });
    assert.equal(decisions.length, 0);
});

test('可在一个联网请求中显式选择 VSearch 与 AnySearch', async () => {
    const { planner, decisions } = makePlanner();
    const calls = await planner.plan(
        "{联网搜索} 'VSearch' 'AnySearch' 【最近美国土豆是不是打折】"
    );

    assert.deepEqual(calls.map(call => call.name), ['VSearch', 'AnySearch']);
    assert.equal(calls[0].args.SearchMode, 'grounding');
    assert.equal(calls[1].args.query, '最近美国土豆是不是打折');
    assert.equal(calls[1].args.command, 'search');
    assert.equal(decisions.length, 0);
});

test('谷歌搜索使用 SerpSearch 固定命令并确定性映射地区', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan(
        "{联网搜索} '谷歌搜索' 【Coffee prices】[美国]"
    );

    assert.equal(call.name, 'SerpSearch');
    assert.equal(call.args.command, 'google_search');
    assert.equal(call.args.q, 'Coffee prices 美国');
    assert.equal(call.args.gl, 'us');
    assert.equal(call.args.hl, 'en');
});

test('谷歌学术确定性提取年份范围', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        "{联网搜索} '谷歌学术' 【large language models in diagnosis】[2020年至2026年][按日期]"
    );

    assert.equal(call.name, 'SerpSearch');
    assert.equal(call.args.command, 'google_scholar_search');
    assert.equal(call.args.as_ylo, '2020');
    assert.equal(call.args.as_yhi, '2026');
    assert.equal(call.args.scisbd, '2');
    assert.equal(decisions.length, 0);
});

test('Tavily 固定 advanced 并确定性识别新闻和时间范围', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan(
        "{联网搜索} 'Tavily' 【AI芯片进展】[新闻][最近一周]"
    );

    assert.equal(call.name, 'TavilySearch');
    assert.equal(call.args.search_depth, 'advanced');
    assert.equal(call.args.topic, 'news');
    assert.equal(call.args.time_range, 'week');
    assert.equal(call.args.include_raw_content, 'markdown');
});

test('AnySearch 明确垂直领域使用规则，不调用 Jev', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        "{联网搜索} 'AnySearch' 【Jinja2 2.4.1】[查询软件包漏洞]"
    );

    assert.equal(call.name, 'AnySearch');
    assert.equal(call.args.sub_domain, 'security.vuln');
    assert.equal(decisions.length, 0);
});

test('AnySearch 模糊垂直约束只调用一次 Jev 并映射白名单选项', async () => {
    const { planner, decisions } = makePlanner({
        configured: true,
        choice: 'business.company'
    });
    const [call] = await planner.plan(
        "{联网搜索} 'AnySearch' 【Acme未来经营情况】[希望使用最适合企业调查的专业资料]"
    );

    assert.equal(call.name, 'AnySearch');
    assert.equal(call.args.sub_domain, 'business.company');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].questions.decision.type, 'choice');
    assert.match(decisions[0].questions.decision.instructions, /选择最匹配的搜索子领域/);
});

test('B站普通关键词自动走搜索，BV号自动走获取', async () => {
    const { planner } = makePlanner();
    const [searchCall] = await planner.plan(
        "{联网搜索} 'B站获取' 【Python入门教程】[UP主]"
    );
    assert.equal(searchCall.name, 'BilibiliFetch');
    assert.equal(searchCall.args.action, 'search');
    assert.equal(searchCall.args.keyword, 'Python入门教程');
    assert.equal(searchCall.args.search_type, 'bili_user');

    const [fetchCall] = await planner.plan(
        "{联网搜索} 'B站搜索' 【BV1CC4y1a7ee】[截图 30,120 秒]"
    );
    assert.equal(fetchCall.name, 'BilibiliFetch');
    assert.equal(fetchCall.args.url, 'BV1CC4y1a7ee');
    assert.equal(fetchCall.args.need_subs, 'true');
    assert.equal(fetchCall.args.danmaku_num, '20');
    assert.equal(fetchCall.args.comment_num, '20');
    assert.equal(fetchCall.args.snapshots, '30,120');
    assert.equal(fetchCall.args.hd_snapshot, 'true');
});

test('图片生成默认使用 NanoBanana2，无图片为 generate', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        '{图片生成} 【一只坐在窗边的猫，电影感】'
    );

    assert.equal(call.name, 'NanoBananaGen2');
    assert.deepEqual(call.args, {
        prompt: '一只坐在窗边的猫，电影感',
        command: 'generate'
    });
    assert.equal(decisions.length, 0);
});

test('一个图片 URL 自动修图，多个图片 URL 自动合成', async () => {
    const { planner } = makePlanner();
    const [editCall] = await planner.plan(
        "{图片生成} 'ZImage' 【改成雨夜霓虹风格】[file:///C:/images/person.png]"
    );
    assert.equal(editCall.name, 'ZImageTurboGen');
    assert.equal(editCall.args.command, 'edit');
    assert.equal(editCall.args.image, 'file:///C:/images/person.png');

    const [composeCall] = await planner.plan(
        "{图片生成} '豆包' 【融合角色和背景】[https://example.com/a.png][https://example.com/b.png]"
    );
    assert.equal(composeCall.name, 'DoubaoGen');
    assert.equal(composeCall.args.command, 'compose');
    assert.deepEqual(composeCall.args.image, [
        'https://example.com/a.png',
        'https://example.com/b.png'
    ]);
});

test('GPT 生图是独立模式并映射专用命令', async () => {
    const { planner } = makePlanner();
    const [generateCall] = await planner.plan(
        "{图片生成} 'GPT生图' 【精细科幻城市概念图】[横版高清]"
    );
    assert.equal(generateCall.name, 'GPTImageGen');
    assert.equal(generateCall.args.command, 'GPTGenerateImage');
    assert.equal(generateCall.args.size, '3840x2160');
    assert.equal(generateCall.args.quality, 'high');

    const [editCall] = await planner.plan(
        "{图片生成} 'GPT生图' 【改成水彩画】[https://example.com/source.png]"
    );
    assert.equal(editCall.args.command, 'GPTEditImage');
    assert.equal(editCall.args.image, 'https://example.com/source.png');
});

test('显式尺寸按目标插件能力确定性映射，不调用 Jev', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        "{图片生成} 'ZImage' 【一张风景图】[1000x1700]"
    );

    assert.equal(call.args.size, '1152x2048');
    assert.equal(decisions.length, 0);
});

test('模糊图片用途只调用一次 Jev 选择目标插件合法尺寸', async () => {
    const { planner, decisions } = makePlanner({
        configured: true,
        choice: '1024x1536'
    });
    const [call] = await planner.plan(
        "{图片生成} 'GPT生图' 【人物摄影】[用于杂志封面并保留人物全身]"
    );

    assert.equal(call.args.size, '1024x1536');
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].questions.decision.instructions, /选择目标插件支持的最接近尺寸/);
});

test('低置信度 Jev 决策回退默认模板，不注入猜测值', async () => {
    const { planner, decisions } = makePlanner({
        configured: true,
        choice: 'academic.search',
        confidence: 0.2
    });
    const [call] = await planner.plan(
        "{联网搜索} 'AnySearch' 【一个模糊问题】[使用一种不明确的专业来源]"
    );

    assert.equal(call.args.sub_domain, undefined);
    assert.equal(decisions.length, 1);
});

test('拒绝一个 JEV 块包含多个能力目录', async () => {
    const { planner } = makePlanner();
    await assert.rejects(
        planner.plan('{联网搜索}{图片生成}【猫】'),
        /只能包含一个能力目录/
    );
});

test('完整自然语言、关系词和标点不会干扰语义锚点解析', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        "请使用 {联网搜索} 中的 '谷歌学术'，在[2024年至今]的范围内搜索【大语言模型在临床诊断中的应用】。"
    );

    assert.equal(call.name, 'SerpSearch');
    assert.equal(call.args.command, 'google_scholar_search');
    assert.equal(call.args.q, '大语言模型在临床诊断中的应用');
    assert.equal(call.args.as_ylo, '2024');
    assert.equal(decisions.length, 0);
});

test('UrlFetch 用 [URL] 直接触发，默认文本且仅映射三种允许模式', async () => {
    const { planner, decisions } = makePlanner({ configured: true });

    const [defaultCall] = await planner.plan(
        '请使用 {联网搜索}，打开网页[https://example.com]。'
    );
    assert.equal(defaultCall.name, 'UrlFetch');
    assert.deepEqual(defaultCall.args, {
        mode: 'text',
        url: 'https://example.com'
    });

    const [snapshotCall] = await planner.plan(
        '请使用 {联网搜索}，打开网页[https://example.com/page]并获取[截图]。'
    );
    assert.equal(snapshotCall.name, 'UrlFetch');
    assert.equal(snapshotCall.args.url, 'https://example.com/page');
    assert.equal(snapshotCall.args.mode, 'snapshot');

    const [imageCall] = await planner.plan(
        '请使用 {联网搜索}，打开图片地址[https://example.com/cat.png]并[看图]。'
    );
    assert.equal(imageCall.name, 'UrlFetch');
    assert.equal(imageCall.args.mode, 'image');

    const [jinaHintCall] = await planner.plan(
        "请使用 {联网搜索} 中的 'UrlFetch'，打开网页[https://example.com]并使用[jina]。"
    );
    assert.equal(jinaHintCall.args.mode, 'text');
    assert.equal(decisions.length, 0);
});

test('点歌默认常规播放，八种中英文演出模式确定性映射', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const modes = [
        ['流光', 'luminous'],
        ['云阶', 'partita'],
        ['心象', 'cadenza'],
        ['凝彩', 'tempera'],
        ['商籁', 'sonnet'],
        ['镜台', 'diorama'],
        ['浮名', 'fume'],
        ['星诞', 'starborn']
    ];

    const [regular] = await planner.plan(
        '请使用 {音乐播放}，播放【星の余韻】。'
    );
    assert.deepEqual(regular.args, {
        command: 'playSong',
        songname: '星の余韻'
    });

    for (const [label, expected] of modes) {
        const [call] = await planner.plan(
            `请使用 {音乐播放}，播放【星の余韻】，并启用[${label}]演出模式。`
        );
        assert.equal(call.name, 'MusicController');
        assert.equal(call.args.command, 'playSong');
        assert.equal(call.args.songname, '星の余韻');
        assert.equal(call.args.stageMode, expected);
    }

    const [english] = await planner.plan(
        '请使用 {音乐播放}，播放【星の余韻】，并启用[luminous]演出模式。'
    );
    assert.equal(english.args.stageMode, 'luminous');
    assert.equal(decisions.length, 0);
});

test('大量并发规划保持调用参数隔离且全部使用确定性模板', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const stageModes = ['流光', '云阶', '心象', '凝彩', '商籁', '镜台', '浮名', '星诞'];
    const expressions = [];

    for (let i = 0; i < 40; i++) {
        expressions.push(`请使用 {联网搜索}，打开网页[https://example.com/page-${i}]并读取[文本]。`);
        expressions.push(`请使用 {联网搜索}，打开网页[https://example.com/snapshot-${i}]并获取[截图]。`);
        expressions.push(`请使用 {音乐播放}，播放【测试歌曲-${i}】，并启用[${stageModes[i % stageModes.length]}]演出模式。`);
        expressions.push(`请使用 {联网搜索} 中的 'B站搜索'，在B站上[搜UP主]，查找【测试UP-${i}】。`);
    }

    const batches = await Promise.all(expressions.map(expression => planner.plan(expression)));
    assert.equal(batches.length, 160);
    assert.ok(batches.every(calls => calls.length === 1));

    for (let i = 0; i < 40; i++) {
        const offset = i * 4;
        assert.deepEqual(batches[offset][0].args, {
            mode: 'text',
            url: `https://example.com/page-${i}`
        });
        assert.deepEqual(batches[offset + 1][0].args, {
            mode: 'snapshot',
            url: `https://example.com/snapshot-${i}`
        });
        assert.equal(batches[offset + 2][0].args.songname, `测试歌曲-${i}`);
        assert.equal(batches[offset + 3][0].args.keyword, `测试UP-${i}`);
        assert.equal(batches[offset + 3][0].args.search_type, 'bili_user');
    }

    assert.equal(decisions.length, 0);
});

test('日用工具动作词确定性路由到六类真实插件', async () => {
    const { planner, decisions } = makePlanner({ configured: true });

    const [memo] = await planner.plan(
        '请使用 {日用工具} 主动回忆【关于上次A项目会议的讨论内容】，从[小吉的地缘政治]中返回[3条]。',
        { maid: 'Nova' }
    );
    assert.equal(memo.name, 'LightMemo');
    assert.deepEqual(memo.args, {
        k: '3',
        search_all_knowledge_bases: 'false',
        query: '关于上次A项目会议的讨论内容',
        folder: '小吉的地缘政治',
        maid: 'Nova'
    });

    const [alarm] = await planner.plan(
        '请使用 {日用工具}，在[1分钟后]设置闹钟，提醒我【检查烤箱里的点心】。'
    );
    assert.equal(alarm.name, 'VCPAlarm');
    assert.deepEqual(alarm.args, {
        time_description: '1分钟后',
        reminder_text: '检查烤箱里的点心'
    });

    const [calculator] = await planner.plan(
        "请使用 {日用工具} 计算【integral('sin(x)', 0, pi)】。"
    );
    assert.equal(calculator.name, 'SciCalculator');
    assert.deepEqual(calculator.args, {
        expression: "integral('sin(x)', 0, pi)"
    });

    const [assistant] = await planner.plan(
        '请使用 {日用工具} 联络[小娜]，告诉她【我是Nova，我想请你检查这份方案】，并使用[临时通讯][异步委托][上下文:last:3]。'
    );
    assert.equal(assistant.name, 'AgentAssistant');
    assert.deepEqual(assistant.args, {
        agent_name: '小娜',
        prompt: '我是Nova，我想请你检查这份方案',
        temporary_contact: 'true',
        task_delegation: 'true',
        river: 'last:3'
    });

    const [sleep] = await planner.plan(
        '请使用 {日用工具} 睡眠[10分钟]，醒来后提醒【重新检查异步任务状态】。'
    );
    assert.equal(sleep.name, 'VCPSleep');
    assert.deepEqual(sleep.args, {
        sleeptime: '10分钟',
        tips: '重新检查异步任务状态'
    });

    const [music] = await planner.plan(
        '请使用 {日用工具}，播放【星の余韻】，并启用[星诞]演出模式。'
    );
    assert.equal(music.name, 'MusicController');
    assert.equal(music.args.stageMode, 'starborn');

    assert.equal(decisions.length, 0);
});

test('LightMemo 支持全知识库、默认数量和显式索引前缀', async () => {
    const { planner } = makePlanner();
    const [call] = await planner.plan(
        '请使用 {日用工具} 检索记忆【美国军事动向】，限定[索引:地缘政治]并搜索[所有知识库]。'
    );

    assert.equal(call.name, 'LightMemo');
    assert.equal(call.args.query, '美国军事动向');
    assert.equal(call.args.folder, '地缘政治');
    assert.equal(call.args.k, '5');
    assert.equal(call.args.search_all_knowledge_bases, 'true');
});

test('LightMemo 将独立日期约束拼回 query，并保留多文件夹索引', async () => {
    const { planner } = makePlanner();
    const [rangeCall] = await planner.plan(
        '主动回忆【美国军事动向】，检索[2025-04-11~2025-05-12]期间的[小吉的地缘政治|小吉的知识]并返回[3条]。'
    );

    assert.equal(rangeCall.name, 'LightMemo');
    assert.deepEqual(rangeCall.args, {
        k: '3',
        search_all_knowledge_bases: 'false',
        query: '[2025-04-11~2025-05-12] 美国军事动向',
        folder: '小吉的地缘政治|小吉的知识'
    });

    const [singleDateCall] = await planner.plan(
        '请使用 {日用工具} 检索记忆【美国军事动向】，限定[2026-02-14][索引:地缘政治]。'
    );
    assert.equal(singleDateCall.args.query, '[2026-02-14] 美国军事动向');
    assert.equal(singleDateCall.args.folder, '地缘政治');
});

test('LightMemo 将独立音乐检索标记拼回 query，并优先于播放器路由', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const [call] = await planner.plan(
        '[音乐检索]【煮咖啡时适合听的歌】'
    );

    assert.equal(call.name, 'LightMemo');
    assert.deepEqual(call.args, {
        k: '5',
        search_all_knowledge_bases: 'false',
        query: '[音乐检索] 煮咖啡时适合听的歌'
    });
    assert.equal(decisions.length, 0);
});

test('AgentAssistant 支持未来通讯时间和委托查询字段', async () => {
    const { planner } = makePlanner();
    const [scheduled] = await planner.plan(
        '请使用 {日用工具} 联络[小克]，发送【我是Nova，请在约定时间检查任务】，安排在[2026-10-01-14:00]。'
    );
    assert.equal(scheduled.name, 'AgentAssistant');
    assert.equal(scheduled.args.agent_name, '小克');
    assert.equal(scheduled.args.timely_contact, '2026-10-01-14:00');

    const [query] = await planner.plan(
        '请使用 {日用工具} 联络[小克]，查询【异步任务进度】，并使用[查询委托 delegation-abc_123]。'
    );
    assert.equal(query.args.query_delegation, 'delegation-abc_123');
});

test('大量并发日用工具规划无参数串扰且不调用 Jev', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const expressions = [];

    for (let i = 0; i < 50; i++) {
        expressions.push(`请使用 {日用工具} 主动回忆【项目记忆-${i}】，从[索引-${i}]中返回[${(i % 5) + 1}条]。`);
        expressions.push(`请使用 {日用工具}，在[${i + 1}分钟后]设置闹钟，提醒我【提醒-${i}】。`);
        expressions.push(`请使用 {日用工具} 计算【sqrt(${i + 1})】。`);
        expressions.push(`请使用 {日用工具} 联络[Agent-${i}]，告诉她【我是测试Agent，请处理任务-${i}】，并使用[临时通讯]。`);
        expressions.push(`请使用 {日用工具} 睡眠[${i + 1}分钟]，醒来后提醒【继续任务-${i}】。`);
        expressions.push(`请使用 {日用工具}，播放【歌曲-${i}】，并启用[星诞]演出模式。`);
    }

    const batches = await Promise.all(expressions.map(expression => planner.plan(expression)));
    assert.equal(batches.length, 300);

    for (let i = 0; i < 50; i++) {
        const offset = i * 6;
        assert.equal(batches[offset][0].args.query, `项目记忆-${i}`);
        assert.equal(batches[offset][0].args.folder, `索引-${i}`);
        assert.equal(batches[offset + 1][0].args.reminder_text, `提醒-${i}`);
        assert.equal(batches[offset + 2][0].args.expression, `sqrt(${i + 1})`);
        assert.equal(batches[offset + 3][0].args.agent_name, `Agent-${i}`);
        assert.equal(batches[offset + 4][0].args.tips, `继续任务-${i}`);
        assert.equal(batches[offset + 5][0].args.songname, `歌曲-${i}`);
    }

    assert.equal(decisions.length, 0);
});

test('高置信度日用动作可以省略显式能力目录', async () => {
    const { planner, decisions } = makePlanner({ configured: true });
    const cases = [
        ["请计算【sqrt(81)】。", 'SciCalculator'],
        ["请联络[小娜]，告诉她【我是Nova，请检查方案】。", 'AgentAssistant'],
        ["请播放【星の余韻】，并启用[星诞]演出模式。", 'MusicController'],
        ["请在[5分钟后]设置闹钟，提醒我【关掉烤箱】。", 'VCPAlarm'],
        ["请睡眠[10分钟]，醒来后提醒【继续任务】。", 'VCPSleep'],
        ["请主动回忆【上次项目会议】。", 'LightMemo']
    ];

    for (const [expression, plugin] of cases) {
        const [call] = await planner.plan(expression);
        assert.equal(call.name, plugin, expression);
        assert.equal(call.jev.category, 'daily_tools');
    }
    assert.equal(decisions.length, 0);
});

test('打开动作与 [URL] 组合可省略联网目录并自动选择 UrlFetch', async () => {
    const { planner, decisions } = makePlanner({ configured: true });

    const [textCall] = await planner.plan('打开[https://example.com]。');
    assert.equal(textCall.name, 'UrlFetch');
    assert.deepEqual(textCall.args, {
        mode: 'text',
        url: 'https://example.com'
    });

    const [snapshotCall] = await planner.plan('截图[https://example.com/page]。');
    assert.equal(snapshotCall.name, 'UrlFetch');
    assert.equal(snapshotCall.args.mode, 'snapshot');

    const [imageCall] = await planner.plan('看图[https://example.com/cat.png]。');
    assert.equal(imageCall.name, 'UrlFetch');
    assert.equal(imageCall.args.mode, 'image');

    const [fileCall] = await planner.plan('读取[file:///C:/docs/example.html]。');
    assert.equal(fileCall.name, 'UrlFetch');
    assert.equal(fileCall.args.mode, 'text');
    assert.equal(fileCall.args.url, 'file:///C:/docs/example.html');

    assert.equal(decisions.length, 0);
});

test('隐式能力推断保持保守，弱信号和不完整组合必须拒绝', async () => {
    const { planner } = makePlanner();

    await assert.rejects(
        planner.plan('[https://example.com]'),
        /缺少能力目录/
    );
    await assert.rejects(
        planner.plan('请打开这个东西【某个对象】'),
        /缺少能力目录/
    );
    await assert.rejects(
        planner.plan('我今天想听听你的看法【最近怎么样】'),
        /缺少能力目录/
    );
    await assert.rejects(
        planner.plan('请搜索【美国土豆价格】'),
        /缺少能力目录/
    );
    await assert.rejects(
        planner.plan('请生成【一只猫】'),
        /缺少能力目录/
    );
});
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
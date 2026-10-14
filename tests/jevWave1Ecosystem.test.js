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

function loadManifest(pluginName) {
    const p = path.join(ROOT, 'Plugin', pluginName, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('Wave 1: 全部 10 个信息获取/日常协作插件声明通过注册表校验且全部为 valid', () => {
    const registry = new JevThirdPartyRegistry();
    const items = WAVE1_PLUGINS.map(name => ({ manifest: loadManifest(name), origin: 'local' }));
    const snapshot = registry.build(items);

    assert.equal(snapshot.total, WAVE1_PLUGINS.length);
    assert.equal(snapshot.validCount, WAVE1_PLUGINS.length);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.ok(entry.category === 'info_retrieval' || entry.category === 'convenience');
    }
});

test('Wave 1: 离线规划验证 ZhihuSearch 站内与全局搜索', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('ZhihuSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

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

test('Wave 1: 离线规划验证 XiaohongshuFetch 笔记抓取', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('XiaohongshuFetch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {信息获取} 中的 `XiaohongshuFetch`，抓取小红书笔记【https://www.xiaohongshu.com/discovery/item/123456】。');
    assert.equal(call.name, 'XiaohongshuFetch');
    assert.equal(call.args.url, 'https://www.xiaohongshu.com/discovery/item/123456');
});

test('Wave 1: 离线规划验证 VolcSearch 中文检索与条数约束', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('VolcSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {信息获取} 中的 `VolcSearch`，检索【2026年开源大模型最新发布】，返回[条数:5]。');
    assert.equal(call.name, 'VolcSearch');
    assert.equal(call.args.query, '2026年开源大模型最新发布');
    assert.equal(call.args.count, '5');
});

test('Wave 1: 离线规划验证 YoutubeFetch 视频详情与多命令路由', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('YoutubeFetch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

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

test('Wave 1: 离线规划验证 YoucomSearch 国际网络搜索', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('YoucomSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {信息获取} 中的 `YoucomSearch`，检索【AGI前沿论文进展】，限定[一周内]。');
    assert.equal(call.name, 'YoucomSearch');
    assert.equal(call.args.query, 'AGI前沿论文进展');
    assert.equal(call.args.freshness, 'week');
});

test('Wave 1: 离线规划验证 BrowserSearch 真实浏览器搜索与引擎路由', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('BrowserSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {信息获取} 中的 `BrowserSearch`，在[必应]上检索【Rust MoonAST 符号引擎】。');
    assert.equal(call.name, 'BrowserSearch');
    assert.equal(call.args.command, 'search');
    assert.equal(call.args.query, 'Rust MoonAST 符号引擎');
    assert.equal(call.args.engine, 'bing_cn');
});

test('Wave 1: 离线规划验证 DeepWikiVCP 开源架构问答与目录结构', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('DeepWikiVCP'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

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

test('Wave 1: 离线规划验证 DomainSafetyChecker 域名与网址安全核查', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('DomainSafetyChecker'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call] = await planner.plan('请使用 {信息获取} 中的 `DomainSafetyChecker`，核查链接【https://suspicious-login.com/auth】的安全性。');
    assert.equal(call.name, 'DomainSafetyChecker');
    assert.equal(call.args.command, 'CheckUrlSafety');
    assert.equal(call.args.url, 'https://suspicious-login.com/auth');
});

test('Wave 1: 离线规划验证 TimedTaskQuery 定时任务查询与取消', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('TimedTaskQuery'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [call1] = await planner.plan('请使用 {便利操作} 中的 `TimedTaskQuery`，查询定时任务【task-1779106560000-650e398d】的执行结果。');
    assert.equal(call1.name, 'TimedTaskQuery');
    assert.equal(call1.args.command, 'QueryTimedTaskResult');
    assert.equal(call1.args.task_id, 'task-1779106560000-650e398d');
    assert.equal(call1.args.action, 'query');

    const [call2] = await planner.plan('请使用 {日常协作} 中的 `TimedTaskQuery`，[取消]排队定时任务【task-1779106560000-99999999】。');
    assert.equal(call2.name, 'TimedTaskQuery');
    assert.equal(call2.args.action, 'cancel');
});

test('Wave 1: 离线规划验证 PubMedSearch 生物医学文献检索与摘要获取', async () => {
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest: loadManifest('PubMedSearch'), origin: 'local' }]);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

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
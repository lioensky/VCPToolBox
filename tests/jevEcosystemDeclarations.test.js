'use strict';

// ======================================================================
//   JEV 生态声明并网测试：manifest invocationCommands 声明 → 目录制规划
//   本用例组继承自 #491 的生态矩阵设计：插件能力声明（capabilities.invocationCommands）
//   作为唯一事实来源，由 scripts/sync_jev_tool_catalog.py 生成 ToolConfigs/jev_tool_catalog.json，
//   规划器只从目录中选择已声明工具、动作与字段，不做任何未声明的推断。
// ======================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const catalog = require('../ToolConfigs/jev_tool_catalog.json');
const offlinePlanner = new JevToolCallExp({ jevClient: { isConfigured: () => false } });

async function plan(expression, args) {
    const calls = await offlinePlanner.plan(expression, { args: { maid: 'Nova', ...args } });
    return calls[0];
}

test('manifest 声明并网：所有声明 invocationCommands 的启用插件均进入目录且类别齐全', () => {
    const declared = [];
    for (const dir of fs.readdirSync(path.join(ROOT, 'Plugin'), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const file = path.join(ROOT, 'Plugin', dir.name, 'plugin-manifest.json');
        if (!fs.existsSync(file)) continue;
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const commands = manifest.capabilities?.invocationCommands || [];
        if (commands.length === 0) continue;
        declared.push(manifest.name);
    }
    assert.ok(declared.length >= 40, `上游声明插件数量异常: ${declared.length}`);
    for (const name of declared) {
        const tool = catalog.tools[name];
        assert.ok(tool, `已声明插件 ${name} 未进入目录`);
        assert.ok(catalog.categories[tool.category], `${name} 类别 ${tool.category} 不存在`);
        assert.equal(tool.distributed, false);
    }
    assert.deepEqual(
        catalog.tools.DeepWikiVCP.commands.map(c => c.id).sort(),
        ['wiki_ask', 'wiki_content', 'wiki_structure'],
        '目录命令应逐字来自 manifest 声明'
    );
});

test('DeepWikiVCP 单命令插件自动路由：负载与条件字段各归其位', async () => {
    const call = await plan('请使用 {插件工具} 中的 `DeepWikiVCP`，[操作:wiki_ask]【这个仓库的架构】[url:https://deepwiki.com/x]。');
    assert.equal(call.name, 'DeepWikiVCP');
    assert.equal(call.args.command, 'wiki_ask');
    assert.equal(call.args.question, '这个仓库的架构');
    assert.equal(call.args.url, 'https://deepwiki.com/x');
    assert.equal(call.args.maid, 'Nova');
});

test('TimedTaskQuery 无自然语言路由时要求 JEVArgs 精确参数，精确模式下字段逐字传递', async () => {
    await assert.rejects(
        () => plan('请使用 {插件工具} 中的 `TimedTaskQuery`，[操作:QueryTimedTaskResult] [task_id:task-77]。'),
        /需要 JEVArgs 精确参数/
    );
    const call = await plan('请使用 {插件工具} 中的 `TimedTaskQuery` 完成任务。', {
        JEVArgs: JSON.stringify({ command: 'QueryTimedTaskResult', task_id: 'task-77' })
    });
    assert.equal(call.args.command, 'QueryTimedTaskResult');
    assert.equal(call.args.task_id, 'task-77');
});

test('VCPClawMail 无负载命令可直接规划，字段名逐字匹配声明（mailId 非 mail_id）', async () => {
    const call = await plan('请使用 {插件工具} 中的 `VCPClawMail`，[操作:list_recent] [limit:10]。');
    assert.equal(call.args.command, 'list_recent');
    assert.equal(call.args.limit, '10');

    const read = await plan('请使用 {插件工具} 中的 `VCPClawMail`，[操作:read_mail] [mailId:42]。');
    assert.equal(read.args.command, 'read_mail');
    assert.equal(read.args.mailId, '42');

    await assert.rejects(
        () => plan('请使用 {插件工具} 中的 `VCPClawMail`，[操作:read_mail] [mail_id:42]。'),
        /无法识别约束 \[mail_id/
    );
});

test('JEVArgs 显式参数模式无损转译：类型、嵌套与数组保持结构', async () => {
    const args = {
        command: 'wiki_ask',
        question: '嵌套 (payload) 【保留】 [原样]',
        url: 'https://deepwiki.com/a/b',
        tags: ['rust', 'napi'],
        meta: { depth: 2, follow: false, empty: '' }
    };
    const call = await plan('请使用 {插件工具} 中的 `DeepWikiVCP` 完成任务。', { JEVArgs: JSON.stringify(args) });
    assert.deepEqual({ ...call.args, maid: undefined }, { ...args, maid: undefined });
    assert.equal(call.args.maid, 'Nova');
    assert.equal(call.args.meta.depth, 2);
    assert.equal(call.args.meta.follow, false);
    assert.equal(call.args.meta.empty, '');
    assert.deepEqual(call.args.tags, ['rust', 'napi']);
});

test('声明字段白名单：未声明字段不进入插件参数', async () => {
    await assert.rejects(
        () => plan('请使用 {插件工具} 中的 `DeepWikiVCP`，[操作:wiki_ask]【架构问题】[url:https://d.w/x] [engine:hacked]。'),
        /无法识别约束 \[engine/
    );
});

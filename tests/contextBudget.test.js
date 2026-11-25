'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const contextBudget = require('../modules/contextBudget');
const contextManager = require('../modules/contextManager');
const StreamHandler = require('../modules/handlers/streamHandler');

function withEnv(values, fn) {
    const previous = {};
    for (const key of Object.keys(values)) {
        previous[key] = process.env[key];
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
    }
    const restore = () => {
        for (const key of Object.keys(values)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        contextBudget.resetModelRatios();
        contextManager.resetPruneWatermarks();
    };
    let result;
    try { result = fn(); } catch (error) { restore(); throw error; }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
}

test('文本估算：汉字按 2、其余按 1，除以 3', () => {
    assert.equal(contextBudget.estimateTextTokens(''), 0);
    assert.equal(contextBudget.estimateTextTokens('abcdef'), 2);
    assert.equal(contextBudget.estimateTextTokens('你好世界'), 3);
});

test('消息估算计入原生工具调用参数，图片按固定值而不是 Base64 长度', () => {
    const call = { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: 'x'.repeat(3000) } }] };
    assert.ok(contextBudget.estimateMessageTokens(call) >= 1000);
    const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(900000) } }] };
    assert.ok(contextBudget.estimateMessageTokens(image) < 1000);
});

test('请求体估算包含工具定义', () => {
    const messages = [{ role: 'user', content: 'abc' }];
    const withTools = contextBudget.estimateBodyTokens({ messages, tools: [{ type: 'function', function: { name: 'x'.repeat(300) } }] });
    assert.ok(withTools > contextBudget.estimateBodyTokens({ messages }) + 100);
});

test('没有上限或关闭时不检查', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(30000) }] };
    assert.equal(contextBudget.createBudgetGuard({ limit: undefined }).check(body).over, false);
    process.env.ContextBudgetGuard = 'off';
    assert.equal(contextBudget.createBudgetGuard({ limit: 10 }).check(body).over, false);
}));

test('默认是 observe：报告超出但不拦截', () => withEnv({ ContextBudgetGuard: undefined }, () => {
    const guard = contextBudget.createBudgetGuard({ limit: 100 });
    assert.equal(guard.mode, 'observe');
    assert.equal(guard.enforcing, false);
    assert.equal(guard.check({ messages: [{ role: 'user', content: 'x'.repeat(3000) }] }, 'outbound', { silent: true }).over, true);
}));

test('上游用量校准本请求后续估算，并记住该模型的比例', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(29988) }] }; // 估算 10000
    const guard = contextBudget.createBudgetGuard({ limit: 8000, model: 'm' });
    assert.equal(guard.check(body, 'outbound', { silent: true }).over, true);
    guard.noteRequest(body);
    guard.noteUsage({ prompt_tokens: 7000 });
    assert.equal(guard.check(body, 'outbound', { silent: true }).estimated, 7000);
    assert.equal(guard.check(body, 'outbound', { silent: true }).over, false);
    // 同一模型的下一个请求从学到的比例起步；别的模型不受影响。
    assert.equal(contextBudget.createBudgetGuard({ limit: 8000, model: 'm' }).estimate(body), 7000);
    assert.equal(contextBudget.createBudgetGuard({ limit: 8000, model: 'other' }).estimate(body), 10000);
}));

test('请求太小时不校准：固定开销占比大，比例没有代表性', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(2988) }] }; // 估算 1000
    const guard = contextBudget.createBudgetGuard({ limit: 800, model: 'm' });
    guard.noteRequest(body);
    guard.noteUsage({ prompt_tokens: 2400 });
    assert.equal(guard.estimate(body), 1000);
    assert.equal(contextBudget.createBudgetGuard({ limit: 800, model: 'm' }).estimate(body), 1000);
}));

test('用量里的输入 token：缓存读写部分要算进去', () => {
    assert.equal(contextBudget.promptTokensFromUsage({ prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 800 } }), 900);
    assert.equal(contextBudget.promptTokensFromUsage({ input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }), 9512);
    assert.equal(contextBudget.promptTokensFromUsage({ input_tokens: 0 }), null);
    assert.equal(contextBudget.promptTokensFromUsage(null), null);
});

test('非法的上限当作没有；服务端硬上限与请求上限取小，请求没带时也生效', () => {
    for (const bad of [-100, 0, 'abc', NaN, Infinity, null, undefined, '', true, {}]) {
        assert.equal(contextBudget.normalizeLimit(bad), null, String(bad));
    }
    assert.equal(contextBudget.normalizeLimit('60000'), 60000);
    withEnv({ ContextBudgetGuard: 'enforce', ContextBudgetHardCap: undefined }, () => {
        assert.equal(contextBudget.createBudgetGuard({ limit: -100 }).active, false);
        assert.equal(contextBudget.createBudgetGuard({ limit: 8000000 }).limit, 8000000);
    });
    withEnv({ ContextBudgetGuard: 'enforce', ContextBudgetHardCap: '200000' }, () => {
        assert.equal(contextBudget.createBudgetGuard({ limit: 8000000 }).limit, 200000);
        assert.equal(contextBudget.createBudgetGuard({ limit: 60000 }).limit, 60000);
        const noLimit = contextBudget.createBudgetGuard({});
        assert.equal(noLimit.limit, 200000);
        assert.equal(noLimit.enforcing, true);
    });
});

test('超出说明带各部分占用', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const body = {
        messages: [
            { role: 'system', content: 's'.repeat(2988) },
            { role: 'user', content: 'h'.repeat(5988) },
            { role: 'assistant', content: 'a'.repeat(2988) },
            { role: 'user', content: 'q'.repeat(288) },
        ],
        tools: [{ type: 'function', function: { name: 'f', description: 'd'.repeat(600) } }],
    };
    const guard = contextBudget.createBudgetGuard({ limit: 100, model: 'm' });
    const parts = guard.breakdown(body);
    assert.deepEqual([parts.system, parts.history, parts.currentTurn], [1000, 3000, 100]);
    assert.ok(parts.tools > 200);
    const message = contextBudget.exceededMessage(guard.check(body, 'outbound', { silent: true }), 'outbound', parts);
    assert.match(message, /系统提示约 1000、历史对话约 3000、本轮内容约 100、工具定义约 \d+/);
}));

test('校准比例有上下界，离谱的用量不会把估算带偏', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(2988) }] };
    const guard = contextBudget.createBudgetGuard({ limit: 800, model: 'm' });
    guard.noteRequest({ messages: [{ role: 'user', content: 'x'.repeat(29988) }] });
    guard.noteUsage({ prompt_tokens: 1 });
    assert.equal(guard.estimate(body), 400);
}));

const payload = text => ({ role: 'user', content: `<!-- VCP_TOOL_PAYLOAD -->\nResults: ${text}\n<!-- VCP_TOOL_PAYLOAD_END -->` });

test('压缩较早的工具结果：保留起止标记，不动当前轮和普通消息', () => {
    const messages = [
        { role: 'user', content: 'q'.repeat(5000) },
        payload('旧'.repeat(5000)),
        { role: 'assistant', content: 'a' },
        payload('新'.repeat(5000)),
    ];
    const slimmed = contextBudget.slimEarlierToolResults(messages, 2);
    assert.equal(slimmed, 1);
    assert.equal(messages[0].content.length, 5000);
    assert.ok(messages[1].content.length < 1000);
    assert.ok(messages[1].content.startsWith('<!-- VCP_TOOL_PAYLOAD -->'));
    assert.ok(messages[1].content.endsWith('<!-- VCP_TOOL_PAYLOAD_END -->'));
    assert.match(messages[1].content, /已省略 \d+ 个字符/);
    assert.ok(messages[3].content.length > 5000);
    assert.equal(contextBudget.slimEarlierToolResults(messages, 2), 0);
});

const resultBlock = (text, id = 'tcr-1700000000000-0a1b2c3d') =>
    `[[VCP调用结果信息汇总:\n- 工具名称: FileOperator\n- 执行状态: ✅ SUCCESS\n- 调用记录: ${id}\n- 返回内容: ${text}\nVCP调用结果结束]]`;

test('压缩历史里写在 assistant 正文中的工具结果块：保留头尾、标记和调用记录编号', () => {
    const before = `我先读一下文件。\n${resultBlock('旧'.repeat(50000))}\n读完了，结论是 X。`;
    const after = contextBudget.slimToolResultBlocks(before);
    assert.ok(after.length < 1200);
    assert.ok(after.startsWith('我先读一下文件。\n[[VCP调用结果信息汇总:\n- 工具名称: FileOperator'));
    assert.ok(after.endsWith('VCP调用结果结束]]\n读完了，结论是 X。'));
    assert.match(after, /已省略 \d+ 个字符以节省上下文，完整内容见调用记录 tcr-1700000000000-0a1b2c3d/);
    // 再压一次不再变化：同一段历史每次压出来的结果一致。
    assert.equal(contextBudget.slimToolResultBlocks(after), after);
});

test('压缩工具结果块：嵌套按标记配对，代码围栏里的示例、没有结束标记的残块、短块都不动', () => {
    const nested = resultBlock(`外层 ${resultBlock('内'.repeat(3000), 'tcr-1700000000001-ffffffff')} ${'尾'.repeat(3000)}`);
    const slimNested = contextBudget.slimToolResultBlocks(nested);
    assert.equal(slimNested.split('[[VCP调用结果信息汇总:').length, 2);
    assert.equal(slimNested.split('VCP调用结果结束]]').length, 2);
    assert.ok(slimNested.endsWith('VCP调用结果结束]]'));
    assert.ok(slimNested.length < 1200);

    const fenced = `格式示例：\n\`\`\`\n${resultBlock('例'.repeat(3000))}\n\`\`\`\n真正的结果：${resultBlock('真'.repeat(3000))}`;
    const slimFenced = contextBudget.slimToolResultBlocks(fenced);
    assert.ok(slimFenced.includes('例'.repeat(3000)));
    assert.ok(!slimFenced.includes('真'.repeat(3000)));

    const broken = `开头 [[VCP调用结果信息汇总:\n${'残'.repeat(5000)}`;
    assert.equal(contextBudget.slimToolResultBlocks(broken), broken);
    const short = `x ${resultBlock('短')} ${'正文'.repeat(2000)}`;
    assert.equal(contextBudget.slimToolResultBlocks(short), short);
});

test('分级压缩：远的历史压紧、最近几轮留宽，够了就不碰当前轮的工具结果', () => {
    const build = () => [
        { role: 'system', content: `系统 ${resultBlock('示'.repeat(3000))}` },
        { role: 'user', content: '很早的问题' },
        { role: 'assistant', content: resultBlock('远'.repeat(30000)) },
        { role: 'user', content: '问题二' }, { role: 'assistant', content: '答' },
        { role: 'user', content: '问题三' }, { role: 'assistant', content: '答' },
        { role: 'user', content: '上一轮的问题' },
        { role: 'assistant', content: resultBlock('近'.repeat(30000)) },
        { role: 'user', content: '新问题' },
        { role: 'assistant', content: '调用一' },
        payload('一'.repeat(60000)),
        { role: 'assistant', content: '调用二' },
        payload('二'.repeat(60000)),
    ];
    // 第一级就够：远的压成紧凑存根，最近三轮内的留 6000 + 2000，当前轮不动。
    const first = build();
    const original = first[2];
    assert.equal(contextBudget.slimToFit(first, 12, () => false), 2);
    assert.ok(first[2].content.length < 1200);
    assert.ok(original.content.length > 30000); // 原对象不被改写
    assert.ok(first[8].content.length > 8000 && first[8].content.length < 8500);
    assert.ok(first[0].content.includes('示'.repeat(3000)));
    assert.ok(first[11].content.length > 60000);

    // 一直不够：最近几轮也压紧，当前轮较早一步先留 18000 + 6000 再压紧，最新一步始终不动。
    const all = build();
    let checks = 0;
    contextBudget.slimToFit(all, 12, () => { checks++; return true; });
    assert.ok(all[8].content.length < 1200);
    assert.ok(all[11].content.length < 1000);
    assert.ok(all[13].content.length > 60000);
    assert.equal(checks, 3);

    // 压到第三级就够：当前轮较早一步保留宽裕的头尾。
    const third = build();
    let calls = 0;
    contextBudget.slimToFit(third, 12, () => ++calls < 3);
    assert.ok(third[11].content.length > 24000 && third[11].content.length < 24300);

    // 出站前没有工具循环：只压历史。
    const outbound = build();
    contextBudget.slimToFit(outbound, undefined, () => true);
    assert.ok(outbound[8].content.length < 1200);
    assert.ok(outbound[11].content.length > 60000);
});

const roleDivider = require('../modules/roleDivider');
// 一条真实落盘的历史回复：发起调用 + 用角色分割标记包着的工具批次 + 后续结论。
const persistedToolTurn = (text, conclusion = '结论') =>
    `调用 <<<[TOOL_REQUEST]>>>x<<<[END_TOOL_REQUEST]>>>\n<<<[ROLE_DIVIDE_USER]>>>\n` +
    `<<<[VCP_TOOL_BATCH_START:2026-11-25T11:08:27.499+08:00]>>>\n${resultBlock(text)}\n` +
    `<<<[VCP_TOOL_BATCH_END:2026-11-25T11:08:27.499+08:00]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>\n${conclusion}`;

test('角色分割拆出来的历史工具结果仍被认作工具结果，不当成用户发言', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const split = roleDivider.process([
        { role: 'system', content: 'S' },
        { role: 'user', content: '第一问'.padEnd(900, 'x') },
        { role: 'assistant', content: persistedToolTurn('旧'.repeat(3000)) },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: persistedToolTurn('新'.repeat(3000), '') },
    ], { skipCount: 1 });
    const toolIndexes = split.map((m, i) => (contextBudget.isToolResultMessage(m) ? i : -1)).filter(i => i >= 0);
    assert.equal(toolIndexes.length, 2);
    assert.ok(toolIndexes.every(i => split[i].role === 'user'));
    // 当前轮从「第二问」开始，而不是从末尾那条拆出来的工具结果开始。
    const turnStart = contextBudget.lastRealUserIndex(split);
    assert.equal(split[turnStart].content, '第二问');
    // 调用和它的结果是同一个删除单元。
    const units = contextManager.computeDeletableUnits(split, contextManager.computeMustKeepIndices(split));
    assert.ok(units.some(unit => unit.length === 2 && unit[1] === toolIndexes[0]));
    // 只需要删掉第一问就够，但第一条留下来的不能是没头的调用或工具结果。
    const total = contextManager.estimateTokens(split);
    const pruned = contextManager.pruneMessages(split, total - 100);
    assert.equal(pruned[1].content, '第二问');
    // 压缩时逐块压，保留块的起止标记和工具名；当前轮不动。
    const slimmed = split.slice();
    assert.equal(contextBudget.slimEarlierToolResults(slimmed, turnStart), 1);
    assert.match(slimmed[toolIndexes[0]].content, /\[\[VCP调用结果信息汇总:\n- 工具名称: FileOperator[\s\S]*已省略[\s\S]*VCP调用结果结束\]\]/);
    assert.ok(slimmed[toolIndexes[1]].content.includes('新'.repeat(3000)));
}));

test('当前轮起点：续写提示这类系统替用户说的话不算，找不到真正发言时退回最后一条 user', () => {
    const messages = [
        { role: 'user', content: '真正的问题' },
        { role: 'assistant', content: '调用' },
        payload('结果'),
        { role: 'assistant', content: '写到一半' },
        { role: 'user', content: '[系统提示:] 请继续' },
    ];
    assert.equal(contextBudget.lastRealUserIndex(messages), 0);
    assert.equal(contextBudget.lastRealUserIndex([{ role: 'system', content: 'S' }, { role: 'user', content: '[系统提示:] 唤醒' }]), 1);
    assert.equal(contextBudget.lastRealUserIndex([{ role: 'system', content: 'S' }]), -1);
    const formula = Object.defineProperty({ role: 'user', content: '$$x$$' }, '__vcpMetaThinkingV3__', { value: true });
    assert.equal(contextBudget.lastRealUserIndex([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, formula]), 0);
});

test('压缩工具结果块：四个反引号的围栏、行内反引号不会让状态翻转；截断不劈开 emoji', () => {
    const real = resultBlock('真'.repeat(3000));
    const fourTicks = `\`\`\`\`markdown\n\`\`\`\n示例\n\`\`\`\`\n${real}`;
    assert.ok(contextBudget.slimToolResultBlocks(fourTicks).length < 1500);
    const inline = `请不要用 \`\`\` 包裹。\n${real}`;
    assert.ok(contextBudget.slimToolResultBlocks(inline).length < 1500);
    const tilde = `~~~\n${resultBlock('例'.repeat(3000))}\n~~~\n${real}`;
    const slimTilde = contextBudget.slimToolResultBlocks(tilde);
    assert.ok(slimTilde.includes('例'.repeat(3000)));
    assert.ok(!slimTilde.includes('真'.repeat(3000)));

    const emoji = `[[VCP调用结果信息汇总:${'a'.repeat(499)}${'🔍'.repeat(3000)}VCP调用结果结束]]`;
    assert.ok(contextBudget.slimToolResultBlocks(emoji).isWellFormed());
    const messages = [payload(`${'a'.repeat(490)}${'🔍'.repeat(3000)}`), { role: 'user', content: 'q' }];
    contextBudget.slimEarlierToolResults(messages, 1);
    assert.ok(messages[0].content.isWellFormed());
});

test('保留的头尾长度可以用环境变量调', () => withEnv({ ContextSlimHeadChars: '6000', ContextSlimTailChars: '2000' }, () => {
    const out = contextBudget.slimToolResultBlocks(resultBlock('旧'.repeat(50000)));
    assert.ok(out.length > 8000 && out.length < 8400);
    assert.equal(contextBudget.slimToolResultBlocks(resultBlock('旧'.repeat(7000))).length, resultBlock('旧'.repeat(7000)).length);
}));

test('图片占比高的请求只校准本请求，不改这个模型的长期比例', () => withEnv({ ContextBudgetGuard: 'enforce' }, () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2988) }, ...Array(15).fill(image)] }] };
    const guard = contextBudget.createBudgetGuard({ limit: 100000, model: 'm' });
    const before = guard.estimate(body);
    guard.noteRequest(body);
    guard.noteUsage({ prompt_tokens: before * 2 });
    assert.equal(guard.estimate(body), before * 2);
    assert.equal(contextBudget.createBudgetGuard({ limit: 100000, model: 'm' }).estimate(body), before);
}));

const nativeCall = (id, text = '') => ({ role: 'assistant', content: text, tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }] });
const nativeResult = (id, text) => ({ role: 'tool', tool_call_id: id, content: text });
const hasOrphan = messages => messages.some((message, index) =>
    message.role === 'tool' && !messages.slice(0, index).some(m => m.tool_calls?.some(call => call.id === message.tool_call_id)));

test('裁剪：工具调用和结果同进同退，不留孤立的工具结果', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: '问'.repeat(1000) },
        nativeCall('c1', '想'.repeat(3000)),
        nativeResult('c1', '果'.repeat(500)),
        { role: 'assistant', content: '答'.repeat(500) },
        { role: 'user', content: '再问'.repeat(250) },
    ];
    const limit = contextManager.estimateTokens(messages) - 600;
    const out = contextManager.pruneMessages(messages, limit);
    assert.equal(hasOrphan(out), false);
    assert.ok(contextManager.estimateTokens(out) <= limit);
    assert.equal(out[out.length - 1], messages[5]);
}));

test('裁剪：工具链进行到一半时，当前轮（用户发言、调用、结果）完整保留', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: '旧'.repeat(3000) },
        { role: 'assistant', content: '旧答'.repeat(1000) },
        { role: 'user', content: '问'.repeat(300) },
        nativeCall('c1'),
        nativeResult('c1', '果'.repeat(1500)),
        nativeResult('c2', '果'.repeat(1500)),
    ];
    const out = contextManager.pruneMessages(messages, 2500);
    assert.deepEqual(out, [messages[0], ...messages.slice(3)]);
}));

test('裁剪：VCP 文本协议的工具回执和发起调用的回复也是一个单元', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'a'.repeat(300) },
        { role: 'assistant', content: 'CALL'.repeat(300) },
        payload('r'.repeat(300)),
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'next' },
    ];
    const out = contextManager.pruneMessages(messages, contextManager.estimateTokens(messages) - 150);
    assert.deepEqual(out, [messages[0], messages[4], messages[5]]);
}));

test('裁剪：删光可删的仍超出时原样交给出站检查，不动必须保留的消息', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: '字'.repeat(50000) },
    ];
    const out = contextManager.pruneMessages(messages, 1000);
    assert.equal(out[0], messages[0]);
    assert.equal(out[out.length - 1], messages[3]);
    assert.ok(contextManager.estimateTokens(out) > 1000);
}));

const turns = count => {
    const messages = [{ role: 'system', content: 'S' }];
    for (let i = 0; i < count; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `${i}:`.padEnd(288, 'x') }); // 每条 100
    return messages;
};

test('裁剪：ContextPruneTargetRatio 成档地删，对话在同一档内增长时前缀不变', () => withEnv({ ContextPruneEnabled: 'true', ContextPruneTargetRatio: '0.5' }, () => {
    // 上限 1900，一档 950。20 轮（约 2005）到 28 轮（约 2805）都落在第一档：删掉的是同一批。
    const firstKept = [];
    for (const count of [20, 22, 24, 26, 28]) {
        const out = contextManager.pruneMessages(turns(count), 1900);
        assert.ok(contextManager.estimateTokens(out) <= 1900, `count=${count}`);
        assert.equal(out[1].role, 'user');
        firstKept.push(out[1].content.slice(0, 3));
    }
    assert.equal(new Set(firstKept).size, 1, firstKept.join(','));
    // 默认（比例 1）下每长一轮边界就挪一次。
    process.env.ContextPruneTargetRatio = '1';
    contextManager.resetPruneWatermarks();
    const moving = [20, 22, 24].map(count => contextManager.pruneMessages(turns(count), 1900)[1].content.slice(0, 3));
    assert.equal(new Set(moving).size, 3);
}));

test('裁剪：边界只进不退，总量回落也不会把上一轮删掉的消息放回来', () => withEnv({ ContextPruneEnabled: 'true', ContextPruneTargetRatio: '0.5' }, () => {
    const firstKept = out => out[1].content.slice(0, 3);
    // 这一轮超出刚过一档的线，删了两档。
    const big = contextManager.pruneMessages(turns(30), 1900);
    // 下一轮上限因为校准宽了一点（等价于记忆注入变短），按当轮算只需要删一档。
    const next = contextManager.pruneMessages(turns(30), 2100);
    assert.equal(firstKept(next), firstKept(big));
    // 没有记录时，同样的输入确实只删一档：说明上面保持不动靠的是水位。
    contextManager.resetPruneWatermarks();
    assert.notEqual(firstKept(contextManager.pruneMessages(turns(30), 2100)), firstKept(big));
    // 对话明显变短（用户删了大半）后水位作废，不再裁剪。
    contextManager.pruneMessages(turns(30), 1900);
    const short = turns(8);
    assert.equal(contextManager.pruneMessages(short, 1900), short);
    // 对话被改写、边界消息不在了：按当轮重新算。
    contextManager.pruneMessages(turns(30), 1900);
    const edited = turns(30).map((m, i) => (i > 0 && i < 25 ? { ...m, content: `改${m.content}` } : m));
    assert.ok(contextManager.estimateTokens(contextManager.pruneMessages(edited, 2400)) <= 2400);
}));

test('裁剪：留下来的第一条不会是没头的 assistant 回复', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u1'.padEnd(600, 'x') },
        { role: 'assistant', content: 'a1'.padEnd(600, 'x') },
        { role: 'user', content: 'u2'.padEnd(600, 'x') },
        { role: 'assistant', content: 'a2'.padEnd(600, 'x') },
        { role: 'user', content: 'u3' },
    ];
    // 只需要删掉 u1 就够，但那样 a1 会变成开头的孤儿。
    const out = contextManager.pruneMessages(messages, 700);
    assert.deepEqual(out.map(m => m.content.slice(0, 2)), ['S', 'u2', 'a2', 'u3']);
}));

test('裁剪：非法上限不裁剪', () => withEnv({ ContextPruneEnabled: 'true' }, () => {
    const messages = turns(20);
    for (const bad of [-100, 'abc', NaN, 0]) assert.equal(contextManager.pruneMessages(messages, bad), messages);
}));

const sse = text => ({ ok: true, body: Readable.from([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
]) });

function loopHarness({ limit, toolText, initialMessages = [] }) {
    const sent = [];
    const writes = [];
    const result = { success: true, raw: toolText, content: [{ type: 'text', text: toolText }] };
    let turn = 0;
    const ctx = {
        originalBody: { model: 'test', messages: initialMessages, requestId: 'r' },
        pluginManager: { messagePreprocessors: new Map() },
        abortController: new AbortController(),
        budgetGuard: contextBudget.createBudgetGuard({ limit, model: 'test', requestId: 'r' }),
        maxVCPLoopStream: 4,
        ToolCallParser: {
            parse: text => text === 'CALL' ? [{ name: 'Demo' }] : [],
            separate: calls => ({ normal: calls, archery: [] }),
        },
        toolExecutor: { execute: async () => result, executeAll: async () => [result] },
        isToolResultError: () => false,
        fetchWithRetry: async (_url, options) => {
            sent.push(JSON.parse(options.body));
            return sse(++turn < 2 ? 'CALL' : 'done');
        },
    };
    const res = {
        writableEnded: false, destroyed: false,
        write(value, callback) { writes.push(value); callback?.(); },
        end() { this.writableEnded = true; },
    };
    return { ctx, res, sent, writes, run: () => new StreamHandler(ctx).handle({}, res, sse('CALL')) };
}

test('工具循环 enforce：先压缩较早的工具结果，能容纳就继续', () => withEnv({ ContextBudgetGuard: 'enforce' }, async () => {
    const harness = loopHarness({ limit: 2500, toolText: 'r'.repeat(6000) });
    await harness.run();
    // 第一轮结果 2000 token 在预算内；第二轮再加 2000 超出，压缩第一轮的结果后继续。
    assert.equal(harness.sent.length, 2);
    const payloads = harness.sent[1].messages.filter(message => contextBudget.isToolResultMessage(message));
    assert.equal(payloads.length, 2);
    assert.ok(payloads[0].content.length < 1000);
    assert.ok(payloads[1].content.length > 6000);
    assert.equal(harness.writes.some(text => text.includes('vcp_context_budget')), false);
}));

test('工具循环 enforce：压缩后仍超出则停止循环并告知客户端', () => withEnv({ ContextBudgetGuard: 'enforce' }, async () => {
    const harness = loopHarness({ limit: 1500, toolText: 'r'.repeat(6000) });
    const outcome = await harness.run();
    assert.equal(harness.sent.length, 0);
    assert.equal(outcome.completed, false);
    const notice = harness.writes.find(text => text.includes('vcp_context_budget'));
    assert.ok(notice);
    assert.match(notice, /超过上限 1500/);
    assert.ok(harness.writes.some(text => text.includes('[DONE]')));
    assert.equal(harness.res.writableEnded, true);
}));

test('工具循环 observe：超出也照常发送，内容不改', () => withEnv({ ContextBudgetGuard: 'observe' }, async () => {
    const harness = loopHarness({ limit: 1500, toolText: 'r'.repeat(6000) });
    await harness.run();
    assert.equal(harness.sent.length, 2);
    assert.ok(harness.sent[1].messages.filter(message => contextBudget.isToolResultMessage(message))
        .every(message => message.content.length > 6000));
}));

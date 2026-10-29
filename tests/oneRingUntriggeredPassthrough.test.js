'use strict';

// 未写 OneRing 触发标记的请求必须原样放行。工作视图会删掉 [系统提示…] 开头的 user 消息、
// 剥掉开头的 [系统通知]…[系统通知结束]，这些只该作用于 OneRing 自己的处理。
const test = require('node:test');
const assert = require('node:assert/strict');

const oneRing = require('../Plugin/OneRing/OneRing.js');

const system = content => ({ role: 'system', content });
const user = content => ({ role: 'user', content });

test('untriggered requests keep pseudo-system user messages and leading system notices', async () => {
    const messages = [
        system('你是测试助手。'),
        user('第一个问题'),
        { role: 'assistant', content: '回答一' },
        user('[系统提示:]\n本轮记忆：思维托盘搬运的内容'),
        user('[系统通知]\n工具调用一律用 VCP 语法。\n[系统通知结束]\n第二个问题'),
    ];
    const result = await oneRing.processMessages(messages.map(message => ({ ...message })), {});
    assert.deepEqual(result.map(message => ({ role: message.role, content: message.content })), messages);
});

test('MemoryThinkingTray output survives OneRing when OneRing is not triggered', async () => {
    const tray = require('../Plugin/MemoryThinkingTray/MemoryThinkingTray.js');
    const moved = await tray.processMessages([
        system('你是测试助手。\n<---VCP记忆思维区Start--->\n本轮暗号：海鸥七三。\n<---VCP记忆思维区End--->'),
        user('暗号是什么？'),
    ], {});
    const result = await oneRing.processMessages(moved, {});
    assert.ok(result.some(message => message.role === 'user' && String(message.content).includes('海鸥七三')));
});

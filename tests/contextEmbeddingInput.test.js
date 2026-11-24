'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getTokenCount } = require('../TextChunker');
const { projectContextEmbeddingInput: project } = require('../modules/contextEmbeddingInput');

test('short context stays intact and non-context embeddings are not limited', () => {
    assert.equal(project('short user message', 'user'), 'short user message');
    assert.equal(project('short assistant message', 'assistant'), 'short assistant message');
    const doc = '数据库迁移。'.repeat(14000);
    assert.equal(project(doc), doc);
});

test('oversized user and assistant text preserves both ends within 5000 tokens', () => {
    const content = `附件：交付说明\n${'测试工程中文🚀🧪字节覆盖。'.repeat(20000)}\n用户问题：哪些地方没有通过回归？`;
    const user = project(content, 'user');
    const assistant = project(content, 'assistant');
    const budget = 5000;
    for (const input of [user, assistant]) {
        assert.ok(input.startsWith('附件：交付说明'));
        assert.ok(input.endsWith('用户问题：哪些地方没有通过回归？'));
        assert.ok(input.isWellFormed());
        assert.ok(getTokenCount(input) <= budget);
        assert.ok(getTokenCount(input) >= budget * 0.9);
    }
    assert.equal(project(user, 'user'), user);
    assert.equal(project(assistant, 'assistant'), assistant);
});

test('large fence is compressed before prose; OneRing tail does not change the input', () => {
    const fence = '```';
    const content = `写入 router.js\n${fence}js\n${'export const route = 1;\n'.repeat(20000)}${fence}\n验收：租户回归失败。`;
    const projection = project(content, 'assistant');
    assert.ok(projection.length < 1000);
    assert.ok(projection.includes('router.js'));
    assert.ok(projection.endsWith('验收：租户回归失败。'));
    assert.equal(project(`${content}\n[OneRing通知:Kerr于2026-11-20 18:31:02发送于VChat]`, 'assistant'), projection);
});
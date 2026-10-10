'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../Plugin/OneRing/OneRing.js');
const fuzzy = require('../Plugin/OneRing/OneRingFuzzy.js');
const main = '[[OneRing::小克::VCPChat]]';
const mobile = '[[OneRing临时契约::VCPMobile]]';
const system = content => ({ role: 'system', content });
const user = content => ({ role: 'user', content });
const rag = text => `<!-- VCP_RAG_BLOCK_START -->${text}<!-- VCP_RAG_BLOCK_END -->`;

function loadRing() {
    const sandbox = {
        module: { exports: {} },
        __dirname: path.dirname(filename),
        console,
        process,
        require(name) {
            if (name === './OneRingFuzzy.js') return fuzzy;
            if (name === './OneRingMemo.js') {
                return { DEFAULT_CONFIG: {}, injectMemo: messages => messages };
            }
            if (name === './OneRingTimelineCommon.js') {
                return { getClientTimestampBindingsFromConfig: () => ({ bindings: [], rawCount: 0 }) };
            }
            if (name.startsWith('./') || name === 'chokidar') return {};
            return require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const ring = sandbox.module.exports;
    // Isolate contract resolution from SQLite, watchers and background persistence.
    ring._createTimelineStrategy = () => ({
        hasClientTimestampTruth: false,
        buildWorkingView: () => null
    });
    ring._processRecordOnlyMessages = async (messages, agent, frontend) =>
        ring._attachMeta(messages, agent, frontend);
    ring._processOnlyMessagesForUpstream = ring._processRecordOnlyMessages;
    ring._scheduleRecordOnlyPersistence = () => {};
    return ring;
}

test('temporary contract overrides the request frontend before/after the main system block', async () => {
    for (const blocks of [
        [system(`${main}\n${mobile}`)],
        [system(mobile), system(main)],
        [system(main), system(mobile)],
        [system({ text: mobile }), system([{ type: 'text', text: main }])]
    ]) {
        const ring = loadRing();
        const result = await ring.processMessages([...blocks, user('你好')], {});
        assert.equal(result.__oneRingMeta.agentName, '小克');
        assert.equal(result.__oneRingMeta.frontendSource, 'VCPMobile');
        assert.match(fuzzy.extractText(result.find(m =>
            fuzzy.extractText(m.content).includes('OneRing系统已启动')).content), /当前客户端VCPMobile/);
        assert.equal(ring.extractMetaFromMessages(JSON.parse(JSON.stringify(result))).frontendSource, 'VCPMobile');
    }
});

test('temporary contract is request-local and preserves Only mode', async () => {
    const ring = loadRing();
    const result = await ring.processMessages([
        system('[[OneRing::小克::VCPChat::Only]]'), system(mobile), user('你好')
    ], {});
    assert.match(result[0].content, /当前客户端VCPMobile，当前模式Only/);
    const desktop = await ring.processMessages([system(main), user('桌面消息')], {});
    assert.equal(desktop.__oneRingMeta.frontendSource, 'VCPChat');
});

test('last valid temporary contract wins; invalid values and untrusted locations are ignored', async () => {
    const cases = [
        [[system(main), user(mobile)], 'VCPChat'],
        [[system(main), user('正文'), system(mobile)], 'VCPChat'],
        [[system(`${main}\n${rag(mobile)}`), user('正文')], 'VCPChat'],
        [[system(`${main}\n[[OneRing临时契约:: ]]\n[[OneRing临时契约::A::B]]`), user('正文')], 'VCPChat'],
        [[system(`${main}\n[[OneRing临时契约::VCP\nMobile]]`), user('正文')], 'VCPChat'],
        [[system(`${main}\n${mobile}\n[[OneRing临时契约::{{Frontend}}]]`), user('正文')], 'VCPMobile'],
        [[system(`${main}\n${mobile}\n[[OneRing临时契约:: OtherClient ]]`), user('正文')], 'OtherClient']
    ];
    for (const [messages, expected] of cases) {
        const ring = loadRing();
        const result = await ring.processMessages(messages, {});
        assert.equal(result.__oneRingMeta.frontendSource, expected);
        assert.equal(ring.extractMetaFromMessages(JSON.parse(JSON.stringify(result))).frontendSource, expected);
    }
});

test('temporary contract alone cannot activate OneRing', async () => {
    const ring = loadRing();
    const messages = [system(mobile), user('你好')];
    const result = await ring.processMessages(messages, {});
    assert.equal(result.__oneRingMeta, undefined);
    assert.equal(ring.extractMetaFromMessages(result), null);
});

test('final metadata recovery honors temporary contract over attached metadata and old desktop tail', () => {
    const ring = loadRing();
    const messages = [
        system(main), system(mobile),
        user('旧消息\n[OneRing通知:Ryan于2026-10-10 12:00:00发送于VCPChat]')
    ];
    ring._attachMeta(messages, '小克', 'VCPChat', { turnId: 'existing-turn' });
    const meta = ring.extractMetaFromMessages(messages);
    assert.equal(meta.frontendSource, 'VCPMobile');
    assert.equal(meta.turnId, 'existing-turn');
    assert.equal(meta.lastUserTimestamp, '2026-10-10 12:00:00');
    assert.match(messages[2].content, /发送于VCPChat/);
    assert.equal(ring.extractMetaFromMessages(JSON.parse(JSON.stringify(messages))).frontendSource, 'VCPMobile');
});
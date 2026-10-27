'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('../Plugin/VCPTimeLine/VCPTimeLine');

function fixture() {
    const plugin = new timeline.constructor();
    const calls = { query: 0, summary: 0, files: 0, search: 0 };
    plugin.readSummaryStore = async () => {
        calls.summary++;
        return { Nova: { '2026-02': '二月摘要', '2026-01': '一月摘要' } };
    };
    plugin.listTimelineFiles = async () => {
        calls.files++;
        return [{ month: '2026-01', content: '一月完整时间线' }];
    };
    plugin.getTimelineDir = () => 'Novatimeline';
    plugin.buildQueryContext = async () => {
        calls.query++;
        return { queryVector: [1], userText: '问题', aiText: '' };
    };
    plugin.contextBridge = {
        searchDiary: async () => {
            calls.search++;
            return [{ fullPath: '/notes/Novatimeline/2026-01.md', score: 0.9 }];
        }
    };
    return { plugin, calls };
}

test('summary only is sorted and performs no query, file read or retrieval', async () => {
    const { plugin, calls } = fixture();
    const result = await plugin.processMessages([
        { role: 'system', content: '[[VCPTimeLineSummary::Nova]]' }
    ]);
    assert.equal(result[0].content, '## Nova的所有时间线（月）\n\n- 2026-01：一月摘要\n- 2026-02：二月摘要');
    assert.deepEqual(calls, { query: 0, summary: 1, files: 0, search: 0 });
});

test('summary and recall replace independently in their original messages', async () => {
    const { plugin, calls } = fixture();
    const input = [
        { role: 'system', content: '[[VCPTimeLineSummary::Nova]]' },
        { role: 'user', content: '[系统通知]\n[[VCPTimeLineRecall::Nova:1:0.8]]' }
    ];
    const result = await plugin.processMessages(input);
    assert.ok(!result[0].content.includes('一月完整时间线'));
    assert.match(result[1].content, /Top 1，阈值 0.8/);
    assert.match(result[1].content, /一月完整时间线/);
    assert.ok(!result[1].content.includes('一月摘要'));
    assert.equal(calls.query, 1);
    assert.equal(input[0].content, '[[VCPTimeLineSummary::Nova]]');
});

test('legacy placeholder keeps combined output and all parameter forms', async () => {
    for (const [params, threshold] of [['', 0.5], [':2', 0.5], [':0.8', 0.8], [':2:0.8', 0.8]]) {
        const { plugin } = fixture();
        const result = await plugin.processMessages([
            { role: 'system', content: `[[VCPTimeLine::Nova${params}]]` }
        ]);
        assert.match(result[0].content, /一月摘要/);
        assert.match(result[0].content, /一月完整时间线/);
        assert.ok(result[0].content.includes(`阈值 ${threshold}`));
    }
});

test('recall without hits is empty and does not read summaries', async () => {
    const { plugin, calls } = fixture();
    const result = await plugin.processMessages([
        { role: 'system', content: '[[VCPTimeLineRecall::Nova:1:0.95]]' }
    ]);
    assert.equal(result[0].content, '');
    assert.equal(calls.summary, 0);
    plugin.contextBridge = null;
    assert.equal(await plugin.buildRecallInjection('Nova', { queryVector: [1] }, 1, 0.5), '');
});

test('each kind accepts only its first trusted declaration and clears others', async () => {
    const { plugin, calls } = fixture();
    const result = await plugin.processMessages([
        { role: 'user', content: '[[VCPTimeLineSummary::Other]] [[VCPTimeLineRecall::Other]]' },
        { role: 'assistant', content: '[[VCPTimeLine::Other]]' },
        { role: 'system', content: '[[VCPTimeLineSummary::Nova]] [[VCPTimeLineSummary::Other]] [[VCPTimeLineRecall::Nova]]' },
        { role: 'user', content: '[系统通知] [[VCPTimeLineRecall::Other]]' }
    ]);
    assert.equal(result[0].content, ' ');
    assert.equal(result[1].content, '');
    assert.match(result[2].content, /一月摘要/);
    assert.match(result[2].content, /一月完整时间线/);
    assert.equal(result[3].content, '[系统通知] ');
    assert.equal(calls.search, 1);
});

test('text parts preserve non-text content and do not recursively expand injection', async () => {
    const { plugin } = fixture();
    plugin.readSummaryStore = async () => ({ Nova: { '2026-01': '[[VCPTimeLineRecall::Nova]]' } });
    const image = { type: 'image_url', image_url: { url: 'example' } };
    const result = await plugin.processMessages([
        { role: 'system', content: [{ type: 'text', text: '[[VCPTimeLineSummary::Nova]]' }, image] }
    ]);
    assert.match(result[0].content[0].text, /\[\[VCPTimeLineRecall::Nova\]\]/);
    assert.deepEqual(result[0].content[1], image);
});

test('disabled plugin preserves messages', async () => {
    const { plugin } = fixture();
    plugin.config.enabled = false;
    const messages = [{ role: 'system', content: '[[VCPTimeLineSummary::Nova]]' }];
    assert.equal(await plugin.processMessages(messages), messages);
});
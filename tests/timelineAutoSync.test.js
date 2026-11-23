'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
// These tests exercise generation and persistence, not RAG placeholder rendering.
const ragPath = require.resolve('../Plugin/RAGDiaryPlugin/TimelinePlaceholderProcessor');
const cachedRag = require.cache[ragPath];
require.cache[ragPath] = { loaded: true, exports: class {
    constructor() {
        throw new Error('RAG placeholder rendering is outside the auto-sync test scope');
    }
} };
let timeline;
try {
    timeline = require('../Plugin/VCPTimeLine/VCPTimeLine');
} finally {
    if (cachedRag) require.cache[ragPath] = cachedRag;
    else delete require.cache[ragPath];
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-timeline-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    function make(config) {
        const plugin = new timeline.constructor();
        plugin.dailyNoteRoot = path.join(root, 'dailynote');
        plugin.getSummaryPath = () => path.join(root, 'summaries.json');
        plugin.getAutoSyncStatePath = () => path.join(root, 'state.json');
        plugin.config = plugin.normalizeConfig(config);
        return plugin;
    }
    return { make };
}

test('restart retries only the failed summary; a clean third run calls no model', async t => {
    const { make } = await fixture(t);
    const config = { autoSync: { enabled: true, agents: ['Nova'] } };
    const first = make(config);
    const dir = path.join(first.dailyNoteRoot, 'Nova');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'entry.txt'), '[2026-11-15] - Nova\nA note.');
    const scan = plugin => plugin.runAutoSync(new Date('2026-11-30T16:01:00Z'), 'Asia/Shanghai');
    const calls = { timeline: 0, summary: 0 };
    first.summarizeMonth = async () => { calls.timeline++; return 'Monthly timeline'; };
    first.generateOneLineSummary = async () => { calls.summary++; throw new Error('injected summary failure'); };

    await scan(first);
    assert.deepEqual(calls, { timeline: 1, summary: 1 });
    assert.deepEqual(await first.readSummaryStore(), {});
    const state = async plugin => JSON.parse(await fs.readFile(plugin.getAutoSyncStatePath(), 'utf8')).Nova['2026-11'];
    const before = await state(first);
    assert.match(before.inputDigest, /^[0-9a-f]{64}$/);
    assert.equal(before.summarySourceHash, undefined);
    const [file] = await first.listTimelineFiles('Nova', ['2026-11']);
    assert.match(file.content, /Monthly timeline/);

    const restarted = make(config);
    restarted.summarizeMonth = first.summarizeMonth;
    restarted.generateOneLineSummary = async () => { calls.summary++; return 'One sentence'; };
    await scan(restarted);
    assert.deepEqual(calls, { timeline: 1, summary: 2 });
    assert.equal((await restarted.readSummaryStore()).Nova['2026-11'], 'One sentence');
    assert.equal((await state(restarted)).summarySourceHash, createHash('sha256').update(file.content).digest('hex'));
    await scan(restarted);
    assert.deepEqual(calls, { timeline: 1, summary: 2 });
});

test('current-month changes wait seven days and older months are not generated', async t => {
    const { make } = await fixture(t);
    const plugin = make({ autoSync: { enabled: true, agents: ['Nova'] } });
    const dir = path.join(plugin.dailyNoteRoot, 'Nova');
    await fs.mkdir(dir, { recursive: true });
    const note = path.join(dir, 'current.txt');
    await fs.writeFile(note, '[2027-01-01] - Nova\nFirst.');
    await fs.writeFile(path.join(dir, 'old.txt'), '[2026-11-01] - Nova\nOld.');
    const generated = [];
    plugin.summarizeMonth = async (_agent, month, notes) => {
        generated.push(month);
        return notes.join('\n');
    };
    plugin.generateOneLineSummary = async () => 'Summary';
    const scan = day => plugin.runAutoSync(new Date(`2027-01-${day}T12:00:00Z`), 'Asia/Shanghai');
    await scan('01');
    await fs.writeFile(note, '[2027-01-01] - Nova\nUpdated.');
    await scan('07');
    assert.deepEqual(generated, ['2027-01']);
    await scan('08');
    assert.deepEqual(generated, ['2027-01', '2027-01']);
    assert.deepEqual((await plugin.listTimelineFiles('Nova')).map(file => file.month), ['2027-01']);
});

test('concurrent Agent generation and manual saves preserve all summary entries', { timeout: 5000 }, async t => {
    const { make } = await fixture(t);
    const plugin = make();
    assert.equal(plugin.config.autoSync.enabled, false);
    await plugin.saveTimelineFile('Nova', '2026-11', 'Nova timeline');
    await plugin.saveTimelineFile('Nova', '2026-10', 'Out of scope');
    await plugin.saveTimelineFile('Forge', '2026-11', 'Forge timeline');
    const bothStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    const started = [];
    plugin.generateOneLineSummary = async (agent, month) => {
        started.push(`${agent}/${month}`);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
        return `${agent} summary`;
    };

    const options = { overwrite: true, months: ['2026-11'] };
    const nova = plugin.generateSummaries('Nova', options);
    const forge = plugin.generateSummaries('Forge', options);
    await bothStarted.promise;
    const manual = plugin.saveSummary('Nova', '2026-10', 'Manual summary');
    release.resolve();
    await Promise.all([nova, forge, manual]);

    assert.deepEqual(started.sort(), ['Forge/2026-11', 'Nova/2026-11']);
    assert.deepEqual(await plugin.readSummaryStore(), {
        Nova: { '2026-10': 'Manual summary', '2026-11': 'Nova summary' },
        Forge: { '2026-11': 'Forge summary' }
    });
});

test('two auto-sync Agents overlap and persist both results', { timeout: 5000 }, async t => {
    const { make } = await fixture(t);
    assert.equal(make().config.autoSync.maxConcurrentAgents, 0);
    assert.equal(make({ autoSync: { agents: ['Nova', ' Nova ', ''] } }).config.autoSync.maxConcurrentAgents, 1);
    assert.equal(make({ autoSync: { agents: ['Nova', 'Forge', 'Miyu', 'Kerr'], maxConcurrentAgents: 20 } }).config.autoSync.maxConcurrentAgents, 3);
    const agents = ['Nova', 'Forge'];
    const plugin = make({ autoSync: { enabled: true, agents, maxConcurrentAgents: 1 } });
    assert.equal(plugin.config.autoSync.maxConcurrentAgents, 2);
    const month = '2026-11';
    for (const agent of agents) {
        const dir = path.join(plugin.dailyNoteRoot, agent);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'entry.txt'), `[2026-11-15] - ${agent}\nA note.`);
    }

    const started = new Set();
    const bothRunning = Promise.withResolvers();
    plugin.summarizeMonth = async agent => {
        started.add(agent);
        if (started.size === agents.length) bothRunning.resolve();
        await bothRunning.promise;
        return `${agent} timeline`;
    };
    plugin.generateOneLineSummary = async agent => `${agent} summary`;

    await plugin.runAutoSync(new Date('2026-11-30T16:01:00Z'), 'Asia/Shanghai');

    assert.deepEqual(started, new Set(agents));
    const store = await plugin.readSummaryStore();
    const state = JSON.parse(await fs.readFile(plugin.getAutoSyncStatePath(), 'utf8'));
    for (const agent of agents) {
        assert.equal(store[agent][month], `${agent} summary`);
        assert.match(state[agent][month].inputDigest, /^[0-9a-f]{64}$/);
        const [file] = await plugin.listTimelineFiles(agent, [month]);
        assert.equal(state[agent][month].summarySourceHash, createHash('sha256').update(file.content).digest('hex'));
    }
});

'use strict';
// End-to-end hook test: spawn scripts/vcp-memory-recall-hook.js as a real child
// process against a loopback fake memory server. Covers the stdin→stdout
// contract, both transcript shapes, silent failure paths, cooldown and budget.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const HOOK = path.resolve(__dirname, '..', 'scripts', 'vcp-memory-recall-hook.js');
const TOKEN = 'fixture-read-token';

function runHook({ payload, env = {}, timeoutMs = 9000 }) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`hook timed out; stdout=${stdout} stderr=${stderr}`));
        }, timeoutMs);
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on('error', reject);
        child.stdin.end(JSON.stringify(payload));
    });
}

async function fakeServer(t, handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            requests.push({
                method: req.method,
                url: req.url,
                authorization: req.headers.authorization,
                body: body ? JSON.parse(body) : null
            });
            handler(req, res, requests.length);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

function baseEnv(origin, extra = {}) {
    return {
        VCP_MEMORY_URL: origin,
        VCP_MEMORY_TOKEN: TOKEN,
        VCP_MEMORY_DIARIES: 'notes',
        VCP_MEMORY_COOLDOWN_MS: '0',
        ...extra
    };
}

function claudeTranscript(t, lines) {
    const file = path.join(os.tmpdir(), `claude-transcript-${crypto.randomBytes(6).toString('hex')}.jsonl`);
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
    t.after(() => fs.rmSync(file, { force: true }));
    return file;
}

const recallPayload = {
    direct: [
        { rank: 1, diary: 'notes', file: 'a.md', text: 'write backups before destructive operations', score: 0.91, scoreSource: 'retrieval' }
    ],
    associated: [
        { rank: 1, diary: 'notes', file: 'b.md', text: 'verify rollback targets by hash', score: 0.5, scoreSource: 'retrieval', seedCount: 2 }
    ]
};

test('meta thinking accepts named pools and config objects, and honors explicit off', async t => {
    const { requests, origin } = await fakeServer(t, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ direct: [] }));
    });
    for (const value of ['ExampleStarPool', 'false']) {
        await runHook({ payload: stdinPayload(), env: baseEnv(origin, { VCP_MEMORY_METATHINKING: value }) });
    }
    assert.deepEqual(requests[0].body.metaThinking, { pool: 'ExampleStarPool' });
    assert.equal(requests[1].body.metaThinking, undefined);
    const config = path.join(os.tmpdir(), `memory-hook-config-${crypto.randomUUID()}.json`);
    fs.writeFileSync(config, JSON.stringify({ metaThinking: { pool: 'ConfiguredPool', group: true } }));
    t.after(() => fs.rmSync(config, { force: true }));
    await runHook({ payload: stdinPayload(), env: baseEnv(origin, {
        VCP_MEMORY_HOOK_CONFIG: config, VCP_MEMORY_METATHINKING: ''
    }) });
    assert.deepEqual(requests[2].body.metaThinking, { pool: 'ConfiguredPool', group: true });
});

const stdinPayload = transcriptPath => ({
    session_id: 'session-fixture',
    transcript_path: transcriptPath,
    cwd: os.tmpdir(),
    hook_event_name: 'UserPromptSubmit',
    prompt: 'how should I clean up old files?'
});

test('end-to-end: claude transcript shapes the conversation and recall reaches stdout', async t => {
    const { requests, origin } = await fakeServer(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(recallPayload));
    });
    const transcript = claudeTranscript(t, [
        { type: 'user', message: { role: 'user', content: 'earlier question about cleanup' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'use git stash first' }] } },
        { type: 'system', subtype: 'hook', content: 'noise to skip' },
        { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }
    ]);
    const env = baseEnv(origin, { VCP_MEMORY_ASSOCIATE: '1' });
    const { code, stdout, stderr } = await runHook({ payload: stdinPayload(transcript), env });
    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout.trim());
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(context, /write backups before destructive operations/);
    assert.match(context, /verify rollback targets by hash/);
    // server received the contract body
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(body.query, 'how should I clean up old files?');
    assert.deepEqual(body.diaries, ['notes']);
    assert.equal(body.associate, true);
    // conversation ends with the exact current prompt, history precedes it
    const last = body.conversation[body.conversation.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content, body.query);
    assert.ok(body.conversation.some(m => m.role === 'assistant' && /git stash/.test(m.content)));
    assert.ok(!body.conversation.some(m => /meta noise/.test(m.content)));
});

test('codex transcript shape: response_item payloads, developer excluded', async t => {
    const { requests, origin } = await fakeServer(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ direct: recallPayload.direct }));
    });
    const transcript = claudeTranscript(t, [
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev instructions' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex user question' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer' }] } },
        { type: 'event_msg', payload: { type: 'noise' } }
    ]);
    const { code, stdout } = await runHook({ payload: stdinPayload(transcript), env: baseEnv(origin) });
    assert.equal(code, 0);
    assert.ok(stdout.trim().length > 0);
    const conversation = requests[0].body.conversation;
    assert.ok(conversation.some(m => /codex answer/.test(m.content)));
    assert.ok(!conversation.some(m => /dev instructions/.test(m.content)));
});

test('silent paths: wrong event, slash command, empty prompt, plaintext remote, missing config', async t => {
    const { requests, origin } = await fakeServer(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(recallPayload));
    });
    const env = baseEnv(origin);
    for (const [label, payload, envOverride] of [
        ['wrong event', { ...stdinPayload(), hook_event_name: 'PreToolUse' }, env],
        ['slash command', { ...stdinPayload(), prompt: '/compact now' }, env],
        ['empty prompt', { ...stdinPayload(), prompt: '   ' }, env],
        ['plaintext remote host', stdinPayload(), { ...env, VCP_MEMORY_URL: 'http://192.168.1.10:6005' }],
        ['missing token', stdinPayload(), { ...env, VCP_MEMORY_TOKEN: '' }],
        ['missing diaries', stdinPayload(), { ...env, VCP_MEMORY_DIARIES: '' }]
    ]) {
        const { code, stdout } = await runHook({ payload, env: envOverride });
        assert.equal(code, 0, label);
        assert.equal(stdout.trim(), '', label);
    }
    assert.equal(requests.length, 0);
});

test('server failure is silent and arms the cooldown', async t => {
    let hits = 0;
    const { origin } = await fakeServer(t, (req, res) => {
        hits++;
        res.writeHead(500).end('boom');
    });
    const env = baseEnv(origin, { VCP_MEMORY_COOLDOWN_MS: '60000' });
    const first = await runHook({ payload: stdinPayload(), env });
    assert.equal(first.stdout.trim(), '');
    assert.equal(hits, 1);
    // second run within cooldown must not hit the server at all
    const second = await runHook({ payload: stdinPayload(), env });
    assert.equal(second.stdout.trim(), '');
    assert.equal(hits, 1);
});

test('output never exceeds the character budget', async t => {
    const huge = {
        direct: Array.from({ length: 8 }, (_, index) => ({
            rank: index + 1, diary: 'notes', file: `f${index}.md`, text: 'x'.repeat(3000), score: 0.5, scoreSource: 'retrieval'
        }))
    };
    const { origin } = await fakeServer(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(huge));
    });
    const env = baseEnv(origin, { VCP_MEMORY_MAX_CHARS: '1500' });
    const { stdout } = await runHook({ payload: stdinPayload(), env });
    const output = JSON.parse(stdout.trim());
    assert.ok(output.hookSpecificOutput.additionalContext.length <= 1600, output.hookSpecificOutput.additionalContext.length);
});

test('hook without any transcript still recalls with the bare prompt', async t => {
    const { requests, origin } = await fakeServer(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(recallPayload));
    });
    const env = baseEnv(origin);
    const { stdout } = await runHook({ payload: stdinPayload(path.join(os.tmpdir(), 'does-not-exist.jsonl')), env });
    assert.ok(stdout.trim().length > 0);
    assert.equal(requests[0].body.conversation, undefined);
});

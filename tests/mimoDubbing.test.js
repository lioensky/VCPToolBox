'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const core = require('../Plugin/MimoDubbing/core');
const plugin = require('../Plugin/MimoDubbing/MimoDubbing');

function response(pcm, ending = true) {
    const data = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm.toString('base64') } } }] })}\r\n\r\n`;
    return new Response(data + (ending ? 'data: [DONE]\r\n\r\n' : ''), {
        headers: { 'content-type': 'text/event-stream' }
    });
}

test('SRT / VTT / JSON timestamps, multiline text, overlaps and bounds', () => {
    const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n第一行\r\n第二行';
    assert.deepEqual(core.parseTimeline(srt)[0], { start: 1, end: 3, text: '第一行\n第二行' });
    assert.equal(core.parseTimeline('WEBVTT\n\ncue\n00:01.000 --> 00:02.000 align:start\n你好')[0].end, 2);
    assert.equal(core.parseTimeline('[{"start":0,"end":1,"text":"你好"}]').length, 1);
    for (const input of [[], [{ start: -1, end: 1, text: 'a' }],
        [{ start: 1, end: 1, text: 'a' }], [{ start: 0, end: 1801, text: 'a' }],
        [{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }],
        [{ start: '00:99:01.000', end: 1, text: 'a' }]]) {
        assert.throws(() => core.parseTimeline(input));
    }
});

test('three models, suffix normalization, director prompt and preview flag', () => {
    const request = core.buildRequest({ text: '你好', mode: 'voicedesign', instruction: '角色：温暖青年', optimize_text_preview: 'false' }, 'mimo-v2.5-tts-voiceclone');
    assert.equal(request.model, 'mimo-v2.5-tts-voicedesign');
    assert.equal(request.optimize_text_preview, false);
    assert.equal(request.messages[0].role, 'user');
    assert.equal(request.messages[1].role, 'assistant');
    assert.throws(() => core.buildRequest({ text: '你好', mode: 'voicedesign' }, 'mimo-v2.5-tts'));
    assert.throws(() => core.buildRequest({ text: '你好', voice: 'bad' }, 'mimo-v2.5-tts'));
    assert.equal(core.buildRequest({ text: '你好', voice: '冰糖' }, 'mimo-v2.5-tts-voicedesign').audio.voice, '冰糖');
    assert.equal(core.endpoint('https://www.dmxapi.cn/v1/'), 'https://www.dmxapi.cn/v1/chat/completions');
    assert.equal(core.endpoint('https://api.xiaomimimo.com'), 'https://api.xiaomimimo.com/v1/chat/completions');
});

test('styles merge, inline controls preserved, singing excludes mixed styles', () => {
    assert.equal(core.styledText('（开心）你好', '变快'), '(变快 开心)你好');
    assert.equal(core.styledText('[轻笑]你好', '开心'), '(开心)[轻笑]你好');
    assert.equal(core.styledText('[吸气]你好'), '[吸气]你好');
    assert.equal(core.styledText('(singing)歌词'), '(singing)歌词');
    assert.throws(() => core.styledText('(唱歌 开心)歌词'));
    assert.throws(() => core.styledText('(sing)歌词', '悲伤'));
    assert.throws(() => core.styledText('你好', '(开心)'));
});

test('clone audio validates MIME and signature, does not enter text output', () => {
    const uri = `data:audio/wav;base64,${core.wav(Buffer.alloc(48)).toString('base64')}`;
    const request = core.buildRequest({ text: '你好', mode: 'voiceclone', reference_audio: uri, instruction: '自然' }, 'mimo-v2.5-tts');
    assert.equal(request.model, 'mimo-v2.5-tts-voiceclone');
    assert.equal(request.messages[0].content[0].input_audio.data, uri);
    assert.equal(request.messages[1].content, '你好');
    assert.throws(() => core.referenceAudio(uri.replace('audio/wav', 'audio/mpeg')));
    assert.throws(() => core.referenceAudio('https://example.com/a.wav'));
    assert.throws(() => core.referenceAudio('data:audio/wav;base64,AAAA'));
});

test('SSE split bytes, UTF8 comments, multiline data and final no-newline event', async () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const text = ': 心跳\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"audio":{"data":"AQACAA=="}}}]}\r\n\r\ndata: [DONE]';
    const bytes = Buffer.from(text);
    const stream = new ReadableStream({
        start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
        }
    });
    assert.deepEqual(await core.readAudio(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), pcm);
    await assert.rejects(core.readAudio(response(pcm, false)), /提前断开/);
    await assert.rejects(core.readAudio(response(Buffer.from([1]))), /PCM16/);
    await assert.rejects(core.readAudio(response(pcm), 2), /大小限制/);
    await assert.rejects(core.readAudio(new Response('data: {"error":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } })), /流内错误/);
    await assert.rejects(core.readAudio(new Response('secret', { status: 401 })), /HTTP 401/);
});

test('nonstream audio fallback and invalid base64', async () => {
    const request = new Response(JSON.stringify({ choices: [{ message: { audio: { data: 'AQACAA==' } } }] }));
    assert.deepEqual(await core.readAudio(request), Buffer.from([1, 0, 2, 0]));
    await assert.rejects(core.readAudio(new Response('{"choices":[{"message":{"audio":{"data":"!!!"}}}]}')), /Base64/);
});

test('timeline rendering preserves leading/gap/trailing silence, WAV layout and cue override', async () => {
    const cues = core.parseTimeline([{ start: 1, end: 2, text: 'a', voice: '冰糖' }, { start: 3, end: 4, text: 'b' }]);
    const pcm = Buffer.alloc(24000);
    pcm.writeInt16LE(1234, 0);
    const requests = [];
    const output = await core.synthesize(cues, { voice: 'Mia' },
        { model: 'mimo-v2.5-tts', key: 'test', url: 'https://example.com' }, new AbortController().signal,
        async (_, options) => { requests.push(JSON.parse(options.body)); return response(pcm); });
    assert.equal(output.audio.length, 44 + 4 * 24000 * 2);
    assert.equal(output.audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(output.audio.readUInt32LE(24), 24000);
    assert.equal(output.audio.readInt16LE(44), 0);
    assert.equal(output.audio.readInt16LE(44 + 48000), 1234);
    assert.equal(output.audio.readInt16LE(44 + 96000), 0);
    assert.equal(output.audio.readInt16LE(44 + 144000), 1234);
    assert.equal(requests[0].audio.voice, '冰糖');
    assert.equal(requests[1].audio.voice, 'Mia');
});

test('overflow fails safely, explicit truncation works, fit enforces speed cap', async () => {
    const cues = core.parseTimeline([{ start: 0, end: 1, text: 'a' }]);
    const config = { model: 'mimo-v2.5-tts', key: 'test', url: 'https://example.com', maxSpeed: 2 };
    const fetchMock = async () => response(Buffer.alloc(3 * 48000));
    await assert.rejects(core.synthesize(cues, {}, config, new AbortController().signal, fetchMock), /超出字幕窗口/);
    const output = await core.synthesize(cues, { overflow: 'truncate' }, config, new AbortController().signal, fetchMock);
    assert.equal(output.report[0].action, 'truncate');
    assert.equal(output.audio.length, 48044);
    await assert.rejects(core.synthesize(cues, { overflow: 'fit' }, config, new AbortController().signal, fetchMock), /超过配置上限/);
});

test('query rejects traversal, invalid submit rejects before billable API calls', async () => {
    const run = input => new Promise(resolve => {
        const child = spawn(process.execPath, [path.resolve(__dirname, '../Plugin/MimoDubbing/MimoDubbing.js')], { env: { ...process.env, MIMO_API_KEY: '' } });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('close', () => resolve(JSON.parse(output)));
        child.stdin.end(JSON.stringify(input));
    });
    assert.equal((await run({ command: 'query', request_id: '../../secret' })).status, 'error');
    assert.match((await run({ timeline: [] })).error, /MIMO_API_KEY/);
    assert.equal(plugin.safeError(new SyntaxError('data: secret')), '输入或上游 JSON 格式无效。');
});

test('async stdio receipt precedes upstream completion, callback and query return accessible WAV', async t => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'mimo-dubbing-'));
    let callbackPayload;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.url === '/v1/chat/completions') {
            await barrier;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.alloc(48).toString('base64') } } }] })}\n\ndata: [DONE]\n\n`);
        } else {
            callbackPayload = JSON.parse(body);
            res.writeHead(200); res.end('{}');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, MIMO_API_KEY: 'mock-key', MIMO_API_URL: `${base}/v1`,
        CALLBACK_BASE_URL: `${base}/plugin-callback`, MIMO_PUBLIC_BASE_URL: base,
        PROJECT_BASE_PATH: project, IMAGESERVER_FILE_KEY: 'test-file-key' };
    const entry = path.resolve(__dirname, '../Plugin/MimoDubbing/MimoDubbing.js');
    const child = spawn(process.execPath, [entry], { env });
    const closed = new Promise(resolve => child.on('close', resolve));
    let stdout = '';
    const receipt = new Promise(resolve => child.stdout.on('data', data => {
        stdout += data;
        if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0]));
    }));
    const receiptTimeout = setTimeout(() => release(), 5000);
    t.after(async () => {
        clearTimeout(receiptTimeout);
        release();
        child.kill();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(project, { recursive: true, force: true });
    });
    child.stdin.end(JSON.stringify({ timeline: '[{"start":0,"end":1,"text":"测试"}]' }));
    const first = await receipt;
    assert.equal(first.status, 'success');
    assert.equal(callbackPayload, undefined);
    release();
    assert.equal(await closed, 0);
    assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal(callbackPayload.status, 'Succeed');
    const id = callbackPayload.requestId;
    t.after(() => fs.rm(path.resolve(__dirname, `../Plugin/MimoDubbing/state/${id}.json`), { force: true }));
    assert.match(first.result, new RegExp(`VCP_ASYNC_RESULT::MimoDubbing::${id}`));
    assert.equal((await fs.readFile(path.join(project, 'file/mimo-dubbing', `${id}.wav`))).length, 48044);
    assert.equal(JSON.stringify(callbackPayload).includes('mock-key'), false);
    const query = spawn(process.execPath, [entry], { env });
    let result = '';
    query.stdout.on('data', data => { result += data; });
    const queryClosed = new Promise(resolve => query.on('close', resolve));
    query.stdin.end(JSON.stringify({ command: 'query', request_id: id }));
    assert.equal(await queryClosed, 0);
    assert.equal(JSON.parse(JSON.parse(result).result).callbackDelivered, true);
});

test('optional real FFmpeg fit handles approximate atempo duration without truncation', {
    skip: process.env.MIMO_TEST_FFMPEG !== 'true'
}, async () => {
    const pcm = Buffer.alloc(72000);
    for (let frame = 0; frame < 36000; frame++) {
        pcm.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 440 / 24000) * 10000), frame * 2);
    }
    const output = await core.synthesize(core.parseTimeline([{ start: 0, end: 1, text: '离线波形' }]),
        { overflow: 'fit' },
        { model: 'mimo-v2.5-tts', key: 'mock', url: 'https://example.com', maxSpeed: 2, ffmpeg: 'ffmpeg' },
        new AbortController().signal, async () => response(pcm));
    assert.equal(output.audio.length, 48044);
    assert.equal(output.report[0].action, 'speed');
    assert.ok(output.report[0].placedSeconds > 0 && output.report[0].placedSeconds <= 1);
});

test('numbered segments reject gaps, ambiguous sources, unknown fields and mixed timing', () => {
    assert.equal(core.parseSegments({ command1: 'speak', text1: 'a', text2: 'b' }).length, 2);
    for (const args of [
        { text1: 'a', text3: 'b' }, { text2: 'b' }, { text01: 'a' },
        { text1: 'a', timeline: [] }, { text1: 'a', unsupported1: 'x' },
        { text1: 'a', command1: 'submit' }, { text1: 'a', pause_after1: -1 },
        { text1: 'a', pause_after1: '' }, { text1: 'a', pause_after1: 61 },
        { text1: 'a', start1: 0, end1: 1, text2: 'b' },
        { text1: 'a', start1: 0, end1: 1, pause_after1: 0 },
        { text1: 'a', overflow: 'truncate' }
    ]) assert.throws(() => core.parseSegments(args));
    const timed = core.parseSegments({ text1: 'a', start1: '0', end1: '2', text2: 'b', start2: '3', end2: '4' });
    assert.equal(timed[1].start, 3);
});

test('numbered voices and directors produce one continuous WAV with measured timing and pauses', async () => {
    const args = { voice: 'Mia', instruction: '全局指导', pause_after: '0.1',
        text1: 'a', voice1: '冰糖', instruction1: '女性，欣喜', pause_after1: '0.3',
        text2: 'b', voice2: 'Dean', instruction2: '男性，温柔',
        text3: 'c', mode3: 'voicedesign', instruction3: '沙哑低沉' };
    const cues = core.parseSegments(args);
    const requests = [];
    const output = await core.synthesize(cues, args, { model: 'mimo-v2.5-tts', key: 'mock', url: 'https://example.com' },
        new AbortController().signal, async (_, options) => {
            requests.push(JSON.parse(options.body));
            const pcm = Buffer.alloc(24000);
            pcm.writeInt16LE(1234, 0);
            return response(pcm);
        });
    assert.equal(output.arrangement, 'sequence');
    assert.equal(output.duration, 2);
    assert.equal(output.audio.length, 96044);
    assert.deepEqual(output.report.map(cue => [cue.start, cue.end]), [[0, 0.5], [0.8, 1.3], [1.4, 1.9]]);
    assert.equal(output.audio.readInt16LE(44 + 24000), 0);
    assert.equal(output.audio.readInt16LE(44 + 38400), 1234);
    assert.equal(requests[0].audio.voice, '冰糖');
    assert.equal(requests[1].audio.voice, 'Dean');
    assert.equal(requests[0].messages[0].content, '女性，欣喜');
    assert.equal(requests[1].messages[0].content, '男性，温柔');
    assert.equal(requests[2].model, 'mimo-v2.5-tts-voicedesign');
    assert.ok(output.report.every(cue => cue.action === 'concat'));
});
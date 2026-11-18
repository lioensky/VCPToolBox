'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sovits = require('../Plugin/MimoDubbing/sovits');
const core = require('../Plugin/MimoDubbing/core');
const audio = `${'a'.repeat(64)}.wav`;
const preset = { id: 'sample', name: '测试音色', audio, promptText: '参考文本',
    emotion: '默认', promptLang: 'all_zh', textLang: 'zh', speed: 1, engineVoice: 'default', sampleSteps: 4 };
const config = { engine: 'sovits', presets: [preset], referenceDir: 'Z:/remote-only/refs',
    url: 'http://example.invalid', key: '', ffmpeg: process.env.MIMO_FFMPEG_PATH || 'ffmpeg', maxSpeed: 2 };

test('remote path is a string only; no backend file access or URL accepted', () => {
    assert.equal(sovits.referencePath('Z:\\remote-only\\refs\\', audio), `Z:/remote-only/refs/${audio}`);
    assert.equal(sovits.referencePath('/remote/refs', audio), `/remote/refs/${audio}`);
    for (const dir of ['', 'relative', 'file:///refs', 'https://example.com', 'H:/中文']) {
        assert.throws(() => sovits.referencePath(dir, audio));
    }
    assert.throws(() => sovits.referencePath('/refs', '../x.wav'));
    assert.throws(() => sovits.endpoint('http://user:pass@example.com'));
});

test('request uses remote local path, independent output language and multiplied speed', () => {
    const request = sovits.buildRequest({ text: 'こんにちは', voice: 'gsv:sample', text_lang: 'all_ja', speed: '1.2' }, config);
    assert.equal(request.ref_audio_path, `Z:/remote-only/refs/${audio}`);
    assert.equal(request.prompt_lang, 'all_zh');
    assert.equal(request.text_lang, 'all_ja');
    assert.equal(request.speed_factor, 1.2);
    assert.equal(request.voice, 'default');
    for (const override of [{ voice: 'missing' }, { text_lang: 'xx' }, { speed: 4 },
        { instruction: '开心' }, { mode: 'voicedesign' }, { reference_audio: 'anything' }]) {
        assert.throws(() => sovits.buildRequest({ text: 'x', voice: 'sample', ...override }, config));
    }
    const result = JSON.stringify(sovits.listVoices([preset]));
    assert.ok(!result.includes(audio));
    assert.ok(!result.includes('参考文本'));
});

test('presets validate versions, duplicate IDs and metadata without refs', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovits-presets-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'presets.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, presets: [preset] }));
    assert.equal((await sovits.loadPresets(file))[0].id, 'sample');
    await fs.writeFile(file, JSON.stringify({ version: 1, presets: [preset, preset] }));
    await assert.rejects(sovits.loadPresets(file));
    await fs.writeFile(file, '{"version":2,"presets":[]}');
    await assert.rejects(sovits.loadPresets(file));
});

test('audio errors are bounded and never echo upstream secrets', async () => {
    const signal = new AbortController().signal;
    await assert.rejects(sovits.boundedAudio(new Response('SECRET', { status: 403 }), signal), /HTTP 403/);
    await assert.rejects(sovits.boundedAudio(new Response('{}'), signal), /未返回音频/);
    await assert.rejects(sovits.boundedAudio(new Response('bad', { headers: { 'content-type': 'audio/wav' } }), signal), /无效 WAV/);
});

test('real FFmpeg normalizes WAV and bilingual sequence calls only tts without auth', async () => {
    const requests = [];
    const args = { voice: 'sample', text1: '你好', text_lang1: 'all_zh', pause_after1: '0.1',
        text2: 'こんにちは', text_lang2: 'all_ja', speed2: '1.1' };
    const output = await core.synthesize(core.parseSegments(args), args, config, new AbortController().signal,
        async (url, options) => {
            assert.equal(url, 'http://example.invalid/tts');
            assert.equal(options.headers.Authorization, undefined);
            assert.equal(options.redirect, 'error');
            requests.push(JSON.parse(options.body));
            return new Response(core.wav(Buffer.alloc(24000)), { headers: { 'content-type': 'audio/wav' } });
        });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].text_lang, 'all_ja');
    assert.equal(requests[1].prompt_lang, 'all_zh');
    assert.equal(output.duration, 1.1);
    assert.equal(output.report[1].model, 'sovits');
    assert.equal(output.audio.readUInt32LE(24), 24000);
    const source = core.wav(Buffer.alloc(48000));
    source.writeUInt32LE(48000, 24);
    source.writeUInt32LE(96000, 28);
    const normalized = await sovits.toPcm(source, config.ffmpeg, new AbortController().signal);
    assert.equal(normalized.length, 24000);
});

test('list_voices stdio works without engine URL, callback, file key or MiMo key', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovits-list-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'presets.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, presets: [preset] }));
    const child = spawn(process.execPath, [path.resolve(__dirname, '../Plugin/MimoDubbing/MimoDubbing.js')],
        { env: { ...process.env, SOVITS_PRESETS_PATH: file, SOVITS_API_URL: '', MIMO_API_KEY: '', IMAGESERVER_FILE_KEY: '' } });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    const closed = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ command: 'list_voices', engine: 'sovits' }));
    assert.equal(await closed, 0);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.status, 'success');
    assert.equal(JSON.parse(envelope.result).voices[0].id, 'gsv:sample');
});
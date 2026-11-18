'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const LANGUAGES = ['auto', 'auto_yue', 'zh', 'all_zh', 'en', 'ja', 'all_ja', 'ko', 'all_ko', 'yue', 'all_yue'];
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PCM = 24000 * 2 * 1800;

function endpoint(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('SOVITS_API_URL 必须为不含凭据或查询参数的 HTTP/HTTPS 服务地址。');
    }
    return url.href.replace(/\/+$/, '');
}

function referencePath(directory, audio) {
    if (typeof directory !== 'string' || !directory ||
        !/^[\x20-\x7e]+$/.test(directory) || /[?#\0]/.test(directory) ||
        !(path.win32.isAbsolute(directory) || path.posix.isAbsolute(directory)) ||
        /^[a-z]+:\/\//i.test(directory)) {
        throw new Error('SOVITS_REFERENCE_DIR 必须为推理器电脑上的 ASCII 绝对目录，不是 URL。');
    }
    if (!/^[a-f0-9]{64}\.wav$/.test(audio)) throw new Error('预设 audio 必须为哈希 WAV 文件名。');
    // Never resolve/stat/read this remote path on the backend.
    return `${directory.replace(/\\/g, '/').replace(/\/+$/, '')}/${audio}`;
}

async function loadPresets(file) {
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error('SoVITS 预设 JSON 超过 2 MB。');
    const doc = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (doc.version !== 1 || !Array.isArray(doc.presets) || doc.presets.length > 5000) {
        throw new Error('SoVITS 预设版本或列表无效。');
    }
    const ids = new Set();
    return doc.presets.map(p => {
        if (!p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id) ||
            typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 ||
            !/^[a-f0-9]{64}\.wav$/.test(p.audio) ||
            typeof p.promptText !== 'string' || !p.promptText.trim() || p.promptText.length > 10000 ||
            !LANGUAGES.includes(p.promptLang) || !LANGUAGES.includes(p.textLang) ||
            !Number.isFinite(p.speed) || p.speed < 0.1 || p.speed > 3 ||
            ![4, 8, 16, 32].includes(p.sampleSteps) ||
            typeof p.engineVoice !== 'string' || !p.engineVoice || p.engineVoice.length > 120) {
            throw new Error('SoVITS 预设字段无效或 ID 重复。');
        }
        ids.add(p.id);
        return { ...p };
    });
}

function buildRequest(args, config) {
    if ((args.mode !== undefined && args.mode !== 'preset') ||
        ['instruction', 'style', 'reference_audio', 'optimize_text_preview'].some(k => args[k] !== undefined)) {
        throw new Error('SoVITS 使用参考预设，不支持 MiMo 导演、风格、设计或克隆参数。');
    }
    const id = String(args.voice || '').replace(/^gsv:/, '');
    const preset = config.presets.find(p => p.id === id);
    if (!preset) throw new Error('未知 SoVITS 音色，请先使用 command=list_voices, engine=sovits 查询。');
    const lang = args.text_lang ?? preset.textLang;
    if (!LANGUAGES.includes(lang)) throw new Error('SoVITS text_lang 不受支持。');
    const multiplier = args.speed === undefined ? 1 : Number(args.speed);
    const speed = multiplier * preset.speed;
    if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isFinite(speed) || speed < 0.1 || speed > 3) {
        throw new Error('SoVITS 预设语速 × speed 必须在 0.1–3 之间。');
    }
    return {
        text: args.text, text_lang: lang,
        ref_audio_path: referencePath(config.referenceDir, preset.audio),
        prompt_text: preset.promptText, prompt_lang: preset.promptLang,
        voice: preset.engineVoice, speed_factor: speed,
        text_split_method: 'cut1', sample_steps: preset.sampleSteps,
        top_k: 5, top_p: 1, temperature: 1, repetition_penalty: 1.35,
        seed: -1, dbcache: 'off', skip_first_step: 0
    };
}

async function boundedAudio(response, signal) {
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SoVITS 上游 HTTP ${response.status}，请检查服务、鉴权与参考目录访问权限。`);
    }
    if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('audio/')) {
        await response.body?.cancel();
        throw new Error('SoVITS 未返回音频。');
    }
    const chunks = [];
    let size = 0;
    if (!response.body) throw new Error('SoVITS 返回空响应。');
    const reader = response.body.getReader();
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES) throw new Error('SoVITS 音频超过大小限制。');
            chunks.push(Buffer.from(value));
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const wav = Buffer.concat(chunks, size);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('SoVITS 返回无效 WAV。');
    }
    return wav;
}

function toPcm(wav, executable, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
            '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'],
        { shell: false, windowsHide: true, signal });
        const chunks = [];
        let size = 0;
        let exceeded = false;
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_PCM) { exceeded = true; child.kill(); }
            else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => reject(new Error('SoVITS 音频转换无法启动或被取消，请检查 MIMO_FFMPEG_PATH。')));
        child.on('close', code => {
            if (code !== 0 || exceeded || !size || size % 2) return reject(new Error('SoVITS WAV 转换失败或音频超过 30 分钟。'));
            resolve(Buffer.concat(chunks, size));
        });
        child.stdin.end(wav);
    });
}

async function synthesize(request, config, signal, fetchImpl = fetch) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.key) headers.Authorization = `Bearer ${config.key}`;
    const response = await fetchImpl(`${config.url}/tts`, {
        method: 'POST', headers, body: JSON.stringify(request), signal, redirect: 'error'
    });
    return toPcm(await boundedAudio(response, signal), config.ffmpeg, signal);
}

function listVoices(presets) {
    return { engine: 'sovits', languages: LANGUAGES, voices: presets.map(p => ({
        id: `gsv:${p.id}`, name: p.name, emotion: p.emotion || '默认',
        promptLang: p.promptLang, textLang: p.textLang
    })) };
}

module.exports = { endpoint, referencePath, loadPresets, buildRequest, boundedAudio, toPcm, synthesize, listVoices, LANGUAGES };
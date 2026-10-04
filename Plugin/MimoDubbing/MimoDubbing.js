'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');

const STATE_DIR = path.join(__dirname, 'state');
const PROJECT = process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '../..');
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function numberConfig(name, fallback, min, max) {
    const value = Number(process.env[name] || fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 配置超出范围。`);
    return value;
}

function config() {
    const key = process.env.MIMO_API_KEY;
    if (!key) throw new Error('请在插件 config.env 配置 MIMO_API_KEY。');
    return {
        key,
        model: process.env.MIMO_MODEL || 'mimo-v2.5-tts',
        url: core.endpoint(process.env.MIMO_API_URL || 'https://www.dmxapi.cn/v1/chat/completions'),
        timeout: numberConfig('MIMO_TASK_TIMEOUT_MS', 1800000, 1000, 7200000),
        maxSpeed: numberConfig('MIMO_MAX_SPEED', 2, 1, 4),
        ffmpeg: process.env.MIMO_FFMPEG_PATH || 'ffmpeg'
    };
}

function callbackBase() {
    const base = new URL(process.env.CALLBACK_BASE_URL || `http://127.0.0.1:${process.env.SERVER_PORT || process.env.PORT || 6005}/plugin-callback`);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('CALLBACK_BASE_URL 无效。');
    base.pathname = base.pathname.replace(/\/+$/, '');
    if (!base.pathname.endsWith('/plugin-callback')) base.pathname += '/plugin-callback';
    return base.toString().replace(/\/$/, '');
}

function fileBase() {
    if (!process.env.IMAGESERVER_FILE_KEY) throw new Error('需要启用 ImageServer 并配置 File_Key，才能返回音频链接。');
    const base = new URL(process.env.MIMO_PUBLIC_BASE_URL || process.env.VarHttpUrl || 'http://127.0.0.1');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('公开资源基础 URL 无效。');
    if (!process.env.MIMO_PUBLIC_BASE_URL && !base.port) base.port = process.env.SERVER_PORT || process.env.PORT || '6005';
    return `${base.toString().replace(/\/$/, '')}/pw=${encodeURIComponent(process.env.IMAGESERVER_FILE_KEY)}/files/mimo-dubbing`;
}

async function saveState(id, payload) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const destination = path.join(STATE_DIR, `${id}.json`);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await fs.rename(temporary, destination);
}

async function callback(base, id, payload) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(`${base}/MimoDubbing/${id}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error'
            });
            await response.body?.cancel();
            if (response.ok) return true;
        } catch (_) { /* bounded retry, never print endpoint secrets */ }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    return false;
}

function safeError(error) {
    let text = String(error.message || '任务失败');
    for (const secret of [process.env.MIMO_API_KEY, process.env.IMAGESERVER_FILE_KEY]) {
        if (secret) text = text.split(secret).join('[REDACTED]');
    }
    // JSON parsing diagnostics can include upstream/reference data.
    if (error instanceof SyntaxError) return '输入或上游 JSON 格式无效。';
    return text.slice(0, 700);
}

async function background(id, cues, args, settings, callbackUrl, publicBase) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeout);
    let payload;
    try {
        const output = await core.synthesize(cues, args, settings, controller.signal);
        const directory = path.join(PROJECT, 'file', 'mimo-dubbing');
        await fs.mkdir(directory, { recursive: true });
        const fileName = `${id}.wav`;
        const target = path.join(directory, fileName);
        const temporary = `${target}.tmp`;
        await fs.writeFile(temporary, output.audio, { flag: 'wx' });
        await fs.rename(temporary, target);
        const audioUrl = `${publicBase}/${fileName}`;
        payload = {
            requestId: id, status: 'Succeed', audioUrl,
            result: {
                content: [{ type: 'text', text: `MiMo 配音完成，共 ${cues.length} 句，时长 ${output.duration.toFixed(3)} 秒。\n[播放/下载 WAV](${audioUrl})` }],
                details: { audioUrl, fileUrl: audioUrl, fileName, serverPath: `file/mimo-dubbing/${fileName}`,
                    sampleRate: core.SAMPLE_RATE, channels: 1, duration: output.duration,
                    arrangement: output.arrangement, segments: output.report }
            }
        };
    } catch (error) {
        payload = { requestId: id, status: 'Failed', error: controller.signal.aborted ? '配音任务超时或被取消。' : safeError(error) };
    } finally { clearTimeout(timer); }
    await saveState(id, { ...payload, updatedAt: new Date().toISOString(), callbackDelivered: false });
    const delivered = await callback(callbackUrl, id, payload);
    await saveState(id, { ...payload, updatedAt: new Date().toISOString(), callbackDelivered: delivered });
    if (!delivered) process.stderr.write(`[MimoDubbing] ${id} 回调失败，可使用 query 获取最终结果。\n`);
}

async function readInput() {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error('插件输入超过 16 MB 限制。');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
    const args = await readInput();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须为对象。');
    const command = args.command || 'submit';
    if (command === 'query') {
        if (!ID_PATTERN.test(args.request_id || '')) throw new Error('request_id 必须为提交返回的 UUID。');
        let state;
        try { state = JSON.parse(await fs.readFile(path.join(STATE_DIR, `${args.request_id}.json`), 'utf8')); }
        catch (error) {
            if (error.code === 'ENOENT') throw new Error('未找到该任务。');
            throw error;
        }
        // Flat envelope/string avoids legacy async stdout parser matching nested objects early.
        process.stdout.write(JSON.stringify({ status: 'success', result: JSON.stringify(state) }) + '\n');
        return;
    }
    if (command !== 'submit') throw new Error('command 仅支持 submit 或 query。');
    const settings = config();
    const callbackUrl = callbackBase();
    const publicBase = fileBase();
    const cues = core.parseSegments(args);
    if (!['error', 'fit', 'truncate'].includes(args.overflow || 'error')) throw new Error('overflow 参数无效。');
    // Validate every cue before acknowledging or making billable calls.
    for (const cue of cues) core.buildRequest({ ...args, ...cue }, settings.model);
    const id = crypto.randomUUID();
    await saveState(id, { requestId: id, status: 'Running', cueCount: cues.length,
        createdAt: new Date().toISOString(), timeoutMs: settings.timeout });
    process.stdout.write(JSON.stringify({
        status: 'success',
        result: `MiMo 配音任务已提交，任务 ID: ${id}。请原文返回动态结果占位符：{{VCP_ASYNC_RESULT::MimoDubbing::${id}}}`
    }) + '\n');
    await background(id, cues, args, settings, callbackUrl, publicBase);
}

if (require.main === module) {
    main().catch(error => {
        process.stdout.write(JSON.stringify({ status: 'error', error: safeError(error) }) + '\n');
        process.exitCode = 1;
    });
}

module.exports = { callbackBase, fileBase, safeError };
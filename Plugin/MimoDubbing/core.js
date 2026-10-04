'use strict';

const { spawn } = require('node:child_process');
const SAMPLE_RATE = 24000;
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
const MAX_SECONDS = 1800;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;

function time(value) {
    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    }
    const match = String(value).match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
    if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
        throw new Error('时间必须为非负秒数或 HH:MM:SS.mmm / MM:SS.mmm。');
    }
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseTimeline(input) {
    let cues = input;
    if (typeof input === 'string') {
        const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
        if (text.startsWith('[')) cues = JSON.parse(text);
        else {
            cues = [];
            for (const block of text.split(/\n[ \t]*\n/)) {
                if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
                const lines = block.split('\n');
                const index = lines.findIndex(line => line.includes('-->'));
                if (index < 0) throw new Error('字幕块缺少 --> 时间范围。');
                const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
                if (!match) throw new Error('字幕时间范围格式无效。');
                cues.push({ start: match[1], end: match[2], text: lines.slice(index + 1).join('\n') });
            }
        }
    }
    if (!Array.isArray(cues) || !cues.length || cues.length > 200) throw new Error('时间轴必须包含 1–200 条字幕。');
    let previousEnd = 0;
    let totalText = 0;
    return cues.map((cue, index) => {
        if (!cue || typeof cue !== 'object' || typeof cue.text !== 'string' || !cue.text.trim()) {
            throw new Error(`第 ${index + 1} 条字幕缺少正文。`);
        }
        const start = time(cue.start);
        const end = time(cue.end);
        if (end <= start || start < previousEnd || end > MAX_SECONDS) {
            throw new Error(`第 ${index + 1} 条字幕时间无效、重叠或超过 30 分钟。`);
        }
        if (Math.round(end * SAMPLE_RATE) <= Math.round(start * SAMPLE_RATE)) throw new Error('字幕时长不足一个采样点。');
        previousEnd = end;
        totalText += cue.text.length;
        if (cue.text.length > 4000 || totalText > 40000) throw new Error('单句最多 4000 字符，任务最多 40000 字符。');
        return { ...cue, start, end, text: cue.text.trim() };
    });
}

function parseSegments(args) {
    const fields = new Set(['command', 'text', 'voice', 'mode', 'instruction', 'style',
        'reference_audio', 'optimize_text_preview', 'start', 'end', 'pause_after']);
    const groups = new Map();
    for (const [key, value] of Object.entries(args)) {
        const match = key.match(/^([a-z_]+)(\d+)$/i);
        if (!match) continue;
        const field = match[1].toLowerCase();
        if (!fields.has(field)) throw new Error(`未知分段字段 ${key}。`);
        const index = Number(match[2]);
        if (String(index) !== match[2] || index < 1 || index > 200) throw new Error('分段编号必须为 1–200，不允许前导零。');
        if (!groups.has(index)) groups.set(index, {});
        const group = groups.get(index);
        if (Object.hasOwn(group, field)) throw new Error(`第 ${index} 段存在重复字段。`);
        group[field] = value;
    }
    if (!groups.size) return parseTimeline(args.timeline);
    if (args.timeline !== undefined) throw new Error('编号分段和 timeline 不能同时提供。');
    const cues = [];
    let totalText = 0;
    for (let index = 1; index <= groups.size; index++) {
        const cue = groups.get(index);
        if (!cue) throw new Error('分段编号必须从 1 连续递增，不能断档。');
        if (cue.command !== undefined && cue.command !== 'speak') throw new Error(`command${index} 只支持 speak。`);
        delete cue.command;
        if (typeof cue.text !== 'string' || !cue.text.trim()) throw new Error(`第 ${index} 段缺少正文。`);
        totalText += cue.text.length;
        if (cue.text.length > 4000 || totalText > 40000) throw new Error('单段最多 4000 字符，任务最多 40000 字符。');
        cue.text = cue.text.trim();
        cues.push(cue);
    }
    const timed = cues.some(cue => cue.start !== undefined || cue.end !== undefined);
    if (timed) {
        if (args.pause_after !== undefined || cues.some(cue => cue.pause_after !== undefined)) {
            throw new Error('固定时间轴不支持 pause_after，请用起止时间表达停顿。');
        }
        return parseTimeline(cues);
    }
    let totalPause = 0;
    for (const cue of cues) {
        const raw = cue.pause_after ?? args.pause_after ?? 0;
        if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+(?:\.\d+)?$/.test(String(raw))) {
            throw new Error('pause_after 必须为非负秒数。');
        }
        cue.pause_after = Number(raw);
        if (!Number.isFinite(cue.pause_after) || cue.pause_after > 60) throw new Error('单段停顿最多 60 秒。');
        totalPause += cue.pause_after;
    }
    if (totalPause >= MAX_SECONDS) throw new Error('总停顿不能达到 30 分钟。');
    if (args.overflow !== undefined) throw new Error('连续拼接不使用 overflow；需要限时请填写每段 start/end。');
    return cues;
}

function bool(value, fallback = false) {
    if (value === undefined) return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Error('布尔参数必须为 true 或 false。');
}

function styledText(text, style = '') {
    if (typeof style !== 'string' || /[()[\]（）]/.test(style)) throw new Error('style 只填写风格词，不包含括号。');
    let prefix = text.match(/^(?:\(([^)]*)\)|（([^）]*)）|\[([^\]]*)\])/);
    const inlineTags = new Set(['吸气', '深呼吸', '叹气', '紧张', '激动', '疲惫', '颤抖', '气声', '笑', '轻笑', '抽泣', '哽咽']);
    if (prefix?.[3] && inlineTags.has(prefix[3])) prefix = null;
    const styles = `${style} ${prefix ? prefix.slice(1).find(v => v !== undefined) : ''}`.trim();
    const tokens = styles.split(/[\s,，、]+/).filter(Boolean);
    if (tokens.some(token => /^(唱歌|sing|singing)$/i.test(token)) && tokens.length !== 1) {
        throw new Error('唱歌风格不能与其他开头风格混用。');
    }
    // Independent style and an existing prefix are merged into one leading group.
    return styles ? `(${styles})${prefix ? text.slice(prefix[0].length) : text}` : text;
}

function referenceAudio(uri) {
    if (typeof uri !== 'string') throw new Error('voiceclone 必须提供 reference_audio Data URI。');
    const match = uri.match(/^data:(audio\/(?:wav|x-wav|mpeg|mp3));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > 10 * 1024 * 1024) throw new Error('参考音频只支持 WAV/MP3 Data URI，Base64 上限 10 MB。');
    const buffer = decodeBase64(match[2]);
    const wav = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
    const mp3 = buffer.toString('ascii', 0, 3) === 'ID3' ||
        (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0);
    const format = /wav/.test(match[1]) ? 'wav' : 'mp3';
    if ((format === 'wav' && !wav) || (format === 'mp3' && !mp3)) throw new Error('参考音频 MIME 与文件格式不一致。');
    return { data: uri, format };
}

function decodeBase64(data) {
    if (typeof data !== 'string' || !data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) {
        throw new Error('音频 Base64 无效。');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw new Error('音频 Base64 无效。');
    return buffer;
}

function buildRequest(args, baseModel) {
    const mode = args.mode || 'preset';
    if (!['preset', 'voicedesign', 'voiceclone'].includes(mode)) throw new Error('mode 必须为 preset、voicedesign 或 voiceclone。');
    const model = baseModel.replace(/-(?:voicedesign|voiceclone)$/, '') + (mode === 'preset' ? '' : `-${mode}`);
    const instruction = args.instruction || '';
    if (typeof instruction !== 'string' || instruction.length > 12000) throw new Error('instruction 必须为最多 12000 字符的文本。');
    if (mode === 'voicedesign' && !instruction.trim()) throw new Error('音色设计必须填写 instruction。');
    const messages = [];
    if (mode === 'voiceclone') {
        const audio = referenceAudio(args.reference_audio);
        const content = [{ type: 'input_audio', input_audio: audio }];
        if (instruction) content.push({ type: 'text', text: instruction });
        messages.push({ role: 'user', content });
    } else if (instruction) messages.push({ role: 'user', content: instruction });
    messages.push({ role: 'assistant', content: styledText(args.text, args.style) });
    const audio = { format: 'pcm16' };
    if (mode === 'preset') {
        audio.voice = args.voice || 'mimo_default';
        if (!VOICES.includes(audio.voice)) throw new Error('未知预置音色。');
    }
    const request = { model, messages, audio, stream: true };
    if (mode === 'voicedesign' && args.optimize_text_preview !== undefined) {
        request.optimize_text_preview = bool(args.optimize_text_preview);
    }
    return request;
}

function endpoint(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API URL 无效。');
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/chat/completions') ? pathname :
        `${pathname.endsWith('/v1') ? pathname : `${pathname}/v1`}/chat/completions`;
    return url.toString();
}

async function readAudio(response, maxBytes = MAX_AUDIO_BYTES) {
    if (!response.ok) {
        // Never echo upstream bodies: providers may include credentials or reference inputs.
        await response.body?.cancel();
        throw new Error(`MiMo 上游 HTTP ${response.status}，请检查密钥、模型权限、额度和服务端配置。`);
    }
    const chunks = [];
    let bytes = 0;
    let complete = false;
    const accept = obj => {
        if (obj.error) throw new Error('MiMo 上游返回流内错误。');
        const choice = obj.choices?.[0];
        if (choice?.finish_reason && !['stop', 'completed'].includes(choice.finish_reason)) throw new Error('MiMo 音频生成未正常完成。');
        if (choice?.finish_reason) complete = true;
        const data = choice?.delta?.audio?.data || choice?.message?.audio?.data;
        if (data) {
            const chunk = decodeBase64(data);
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error('上游音频超出大小限制。');
            chunks.push(chunk);
        }
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const isSse = (response.headers.get('content-type') || '').includes('text/event-stream');
    const dispatch = block => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { complete = true; return; }
        accept(JSON.parse(data));
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
            pending = pending.replace(/\r\n/g, '\n');
            if (isSse) {
                let split;
                while ((split = pending.indexOf('\n\n')) >= 0) {
                    dispatch(pending.slice(0, split));
                    pending = pending.slice(split + 2);
                }
            }
            if (pending.length > Math.ceil(maxBytes * 4 / 3) + 1024 * 1024) throw new Error('上游响应超出大小限制。');
            if (done) break;
        }
        if (isSse) {
            if (pending.trim()) dispatch(pending);
            if (!complete) throw new Error('MiMo SSE 提前断开，未收到结束标志。');
        } else accept(JSON.parse(pending));
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const pcm = Buffer.concat(chunks, bytes);
    if (!pcm.length || pcm.length % 2) throw new Error('MiMo 未返回有效的 PCM16 音频。');
    return pcm;
}

function wav(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function speedUp(pcm, ratio, executable, signal) {
    if (!Number.isFinite(ratio) || ratio < 1 || ratio > 4) throw new Error('加速倍率无效。');
    const factors = [];
    while (ratio > 2) { factors.push('atempo=2'); ratio /= 2; }
    factors.push(`atempo=${ratio.toFixed(8)}`);
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [
            '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE),
            '-ac', '1', '-i', 'pipe:0', '-af', factors.join(','), '-f', 's16le', 'pipe:1'
        ], { shell: false, windowsHide: true, signal });
        const chunks = [];
        let total = 0;
        let overflow = false;
        child.stdout.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_AUDIO_BYTES) { overflow = true; child.kill(); }
            else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => reject(new Error('FFmpeg 启动失败或任务被取消，请核对 MIMO_FFMPEG_PATH。')));
        child.on('close', code => code === 0 && !overflow ? resolve(Buffer.concat(chunks)) : reject(new Error('FFmpeg 音频加速失败。')));
        child.stdin.end(pcm);
    });
}

async function synthesize(cues, args, config, signal, fetchImpl = fetch) {
    const sequential = cues[0].end === undefined;
    const timeline = sequential ? null : Buffer.alloc(Math.round(cues.at(-1).end * SAMPLE_RATE) * 2);
    const parts = [];
    let totalBytes = 0;
    const report = [];
    const policy = args.overflow || 'error';
    if (!['error', 'fit', 'truncate'].includes(policy)) throw new Error('overflow 必须为 error、fit 或 truncate。');
    for (let index = 0; index < cues.length; index++) {
        signal.throwIfAborted();
        const cue = cues[index];
        const request = buildRequest({ ...args, ...cue }, config.model);
        const response = await fetchImpl(config.url, {
            method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(request), signal, redirect: 'error'
        });
        let pcm = await readAudio(response, sequential ? MAX_AUDIO_BYTES - totalBytes : MAX_AUDIO_BYTES);
        const originalSeconds = pcm.length / (SAMPLE_RATE * 2);
        if (sequential) {
            const pauseBytes = Math.round(cue.pause_after * SAMPLE_RATE) * 2;
            if (totalBytes + pcm.length + pauseBytes > MAX_AUDIO_BYTES) throw new Error('连续音轨超过 30 分钟限制。');
            const start = totalBytes / (SAMPLE_RATE * 2);
            parts.push(pcm);
            totalBytes += pcm.length;
            const end = totalBytes / (SAMPLE_RATE * 2);
            if (pauseBytes) parts.push(Buffer.alloc(pauseBytes));
            totalBytes += pauseBytes;
            report.push({ index: index + 1, start, end, model: request.model,
                originalSeconds, placedSeconds: originalSeconds, pauseAfter: pauseBytes / (SAMPLE_RATE * 2), action: 'concat' });
            continue;
        }
        const startFrame = Math.round(cue.start * SAMPLE_RATE);
        const frames = Math.round(cue.end * SAMPLE_RATE) - startFrame;
        const slotBytes = frames * 2;
        let action = 'pad';
        if (pcm.length > slotBytes) {
            if (policy === 'error') throw new Error(`第 ${index + 1} 句音频 ${originalSeconds.toFixed(3)} 秒超出字幕窗口 ${(frames / SAMPLE_RATE).toFixed(3)} 秒；请缩短正文、调整表演或使用 overflow=fit。`);
            if (policy === 'fit') {
                let ratio = pcm.length / slotBytes;
                if (ratio > config.maxSpeed) throw new Error(`第 ${index + 1} 句需要 ${ratio.toFixed(2)} 倍加速，超过配置上限。`);
                const original = pcm;
                // atempo duration is approximate. Retry locally from the original PCM,
                // never retry a billable API call or silently discard spoken samples.
                for (let attempt = 0; attempt < 4; attempt++) {
                    pcm = await speedUp(original, ratio, config.ffmpeg, signal);
                    if (!pcm.length || pcm.length % 2) throw new Error('FFmpeg 未返回有效 PCM16 音频。');
                    if (pcm.length <= slotBytes) break;
                    if (ratio >= config.maxSpeed) break;
                    ratio = Math.min(config.maxSpeed, ratio * (pcm.length / slotBytes) * 1.02);
                }
                if (pcm.length > slotBytes) throw new Error(`第 ${index + 1} 句加速后仍超出窗口，请扩大字幕时长。`);
                action = 'speed';
            } else { pcm = pcm.subarray(0, slotBytes); action = 'truncate'; }
        }
        pcm.copy(timeline, startFrame * 2);
        report.push({ index: index + 1, start: cue.start, end: cue.end, model: request.model,
            originalSeconds, placedSeconds: pcm.length / (SAMPLE_RATE * 2), action });
    }
    const pcm = sequential ? Buffer.concat(parts, totalBytes) : timeline;
    return { audio: wav(pcm), report, duration: pcm.length / (SAMPLE_RATE * 2),
        arrangement: sequential ? 'sequence' : 'timeline' };
}

module.exports = { SAMPLE_RATE, VOICES, parseTimeline, parseSegments, bool, styledText, referenceAudio,
    buildRequest, endpoint, readAudio, wav, synthesize };
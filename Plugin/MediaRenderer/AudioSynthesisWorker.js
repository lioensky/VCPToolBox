'use strict';

const fs = require('fs/promises');

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        process.stdin.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_STDIN_BYTES) {
                reject(new Error(`输入超过 ${MAX_STDIN_BYTES} 字节限制。`));
                process.stdin.destroy();
                return;
            }
            chunks.push(chunk);
        });
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

function noteToFrequency(note) {
    if (typeof note === 'number') return note;
    const match = String(note || '').trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) throw new Error(`无效音符: ${note}`);
    const semitones = {
        C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11
    };
    let midi = (Number(match[3]) + 1) * 12 + semitones[match[1].toUpperCase()];
    if (match[2] === '#') midi++;
    if (match[2] === 'b') midi--;
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function oscillator(type, phase, duty = 0.5) {
    const normalized = phase - Math.floor(phase);
    switch (String(type || 'sine').toLowerCase()) {
        case 'square':
        case 'pulse':
            return normalized < Math.max(0.01, Math.min(0.99, duty)) ? 1 : -1;
        case 'triangle':
            return 1 - 4 * Math.abs(normalized - 0.5);
        case 'saw':
        case 'sawtooth':
            return normalized * 2 - 1;
        case 'sine':
            return Math.sin(normalized * Math.PI * 2);
        default:
            throw new Error(`未知波形: ${type}`);
    }
}

function envelope(time, duration, options = {}) {
    if (time < 0 || time >= duration) return 0;
    const attack = Math.max(0, Number(options.attack ?? 0.005));
    const decay = Math.max(0, Number(options.decay ?? 0.04));
    const sustain = Math.max(0, Math.min(1, Number(options.sustain ?? 0.75)));
    const release = Math.max(0, Number(options.release ?? 0.04));
    if (attack > 0 && time < attack) return time / attack;
    if (decay > 0 && time < attack + decay) {
        return 1 - (1 - sustain) * ((time - attack) / decay);
    }
    if (release > 0 && time > duration - release) {
        return sustain * Math.max(0, (duration - time) / release);
    }
    return sustain;
}

function createRandom(seed) {
    let state = (Number(seed) >>> 0) || 0x9e3779b9;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function panGains(pan) {
    const normalized = Math.max(-1, Math.min(1, Number(pan) || 0));
    const angle = (normalized + 1) * Math.PI / 4;
    return [Math.cos(angle), Math.sin(angle)];
}

function createSynthesisApi(request, channelData) {
    const random = createRandom(request.seed);
    const api = {
        sampleRate: request.sampleRate,
        durationMs: request.durationMs,
        duration: request.durationMs / 1000,
        channels: request.channels,
        channelData,
        left: channelData[0],
        right: channelData[1] || channelData[0],
        tempo: request.tempo,
        seed: request.seed,
        Math,
        noteToFrequency,
        oscillator,
        envelope,
        random,
        noise: () => random() * 2 - 1,
        secondsPerBeat: 60 / request.tempo,
        beatToSeconds(beats) {
            return Number(beats) * 60 / request.tempo;
        },
        addSample(channel, frame, value) {
            const target = channelData[channel];
            if (target && frame >= 0 && frame < target.length && Number.isFinite(value)) {
                target[frame] += value;
            }
        },
        addNote(options = {}) {
            const frequency = noteToFrequency(options.note ?? options.frequency ?? 440);
            const start = Number(options.start ?? 0);
            const duration = Math.max(0, Number(options.duration ?? 0.25));
            const volume = Number(options.volume ?? 0.2);
            const wave = options.wave || 'square';
            const duty = Number(options.duty ?? 0.5);
            const [leftGain, rightGain] = panGains(options.pan);
            const startFrame = Math.max(0, Math.floor(start * request.sampleRate));
            const endFrame = Math.min(
                channelData[0].length,
                Math.ceil((start + duration) * request.sampleRate)
            );
            let phase = Number(options.phase || 0);
            const phaseStep = frequency / request.sampleRate;
            for (let frame = startFrame; frame < endFrame; frame++) {
                const localTime = frame / request.sampleRate - start;
                const amp = envelope(localTime, duration, options);
                const value = oscillator(wave, phase, duty) * amp * volume;
                channelData[0][frame] += value * (request.channels === 1 ? 1 : leftGain);
                if (request.channels > 1) channelData[1][frame] += value * rightGain;
                phase += phaseStep;
            }
        }
    };
    return Object.freeze(api);
}

function runUserSynthesis(code, api) {
    const factory = new Function(
        'api',
        `"use strict";
${code}
if (typeof synthesize !== "function") {
    throw new Error("代码必须声明 function synthesize(api) 或 const synthesize = (api) => ...");
}
return synthesize(api);`
    );
    return factory(api);
}

function normalizeSamples(channelData, masterVolume) {
    let peak = 0;
    for (const channel of channelData) {
        for (let index = 0; index < channel.length; index++) {
            const value = channel[index];
            if (!Number.isFinite(value)) {
                channel[index] = 0;
                continue;
            }
            peak = Math.max(peak, Math.abs(value));
        }
    }
    const gain = peak > 1 ? 1 / peak : 1;
    for (const channel of channelData) {
        for (let index = 0; index < channel.length; index++) {
            channel[index] = Math.max(-1, Math.min(1, channel[index] * gain * masterVolume));
        }
    }
    return peak;
}

function applyTailFade(channelData, sampleRate, fadeMs) {
    const fadeFrames = Math.min(
        channelData[0].length,
        Math.floor(sampleRate * Math.max(0, fadeMs) / 1000)
    );
    if (fadeFrames <= 0) return;
    for (const channel of channelData) {
        for (let offset = 0; offset < fadeFrames; offset++) {
            const frame = channel.length - fadeFrames + offset;
            channel[frame] *= 1 - offset / fadeFrames;
        }
    }
}

function encodeWav(channelData, sampleRate) {
    const channels = channelData.length;
    const frameCount = channelData[0].length;
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = frameCount * blockAlign;
    const buffer = Buffer.allocUnsafe(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    let offset = 44;
    for (let frame = 0; frame < frameCount; frame++) {
        for (let channel = 0; channel < channels; channel++) {
            const value = channelData[channel][frame];
            const pcm = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
            buffer.writeInt16LE(Math.max(-32768, Math.min(32767, pcm)), offset);
            offset += 2;
        }
    }
    return buffer;
}

async function main() {
    const rawInput = await readStdin();
    const request = JSON.parse(rawInput);
    const frameCount = Math.ceil(request.durationMs * request.sampleRate / 1000);
    const channelData = Array.from(
        { length: request.channels },
        () => new Float32Array(frameCount)
    );
    const api = createSynthesisApi(request, channelData);
    const returned = runUserSynthesis(request.code, api);
    if (returned && typeof returned.then === 'function') await returned;

    const peakBeforeNormalization = normalizeSamples(channelData, request.masterVolume);
    applyTailFade(channelData, request.sampleRate, request.fadeOutMs);
    const wav = encodeWav(channelData, request.sampleRate);
    await fs.writeFile(request.outputPath, wav);

    process.stdout.write(JSON.stringify({
        status: 'success',
        frameCount,
        byteLength: wav.length,
        peakBeforeNormalization
    }));
}

main().catch(error => {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
});
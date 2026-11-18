'use strict';

// 参数：--library <G1 库副本>。输出只含数值，耗时为毫秒，内存为字节。
// 第 1 行：节点数、维数、压缩数组字节数、仅余弦耗时、余弦和距离耗时、分配前和扫描后 RSS。
// 第 2 行：读取并精算的节点数、Tag 数、Chunk 数、耗时。失败输出负数检查编号。

const { parseArgs } = require('node:util');
const { createAtlas, transformInto } = require('../lib/atlas');
const { dotAt, coarseCosine, clampCosine } = require('../lib/compact');
const { createGeometry } = require('../lib/geometry');
const { openLibrary } = require('../lib/library');

const READ_COUNT = 4096 + 512;

function synthetic() {
    const count = 100_000;
    const dim = 3072;
    const geometry = createGeometry({ profileKind: 1, profile: [0.15], config: {
        throatPhi0: 1.5, angularScaleKappa: 2, angularTau: 0, angularEta: 1,
    } });
    const rq = 0.42;
    const qLeg = geometry.leg(rq);
    const radii = Float64Array.from({ length: 64 }, (_, i) => 0.35 + i * 0.3 / 63);
    const legs = Array.from(radii, r => geometry.leg(r));
    let seed = 20261119;
    function next() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
    }

    const rssBefore = process.memoryUsage.rss();
    const codes = new Int8Array(count * dim);
    const scale = new Float32Array(count).fill(0.0004);
    const norm = new Float64Array(count).fill(1);
    const slack = new Float64Array(count).fill(0.01);
    const block = Int8Array.from({ length: dim * 64 }, () => next() % 255 - 127);
    for (let at = 0; at < codes.length; at += block.length) {
        codes.set(block.subarray(0, Math.min(block.length, codes.length - at)), at);
    }
    const probe = Float32Array.from({ length: dim }, () => (next() - 127.5) / 128);
    const probeNorm = Math.sqrt(dotAt(probe, probe, 0));
    const cosine = new Float64Array(count);
    const started = performance.now();
    for (let i = 0; i < count; i++) cosine[i] = coarseCosine(probe, probeNorm, codes, i * dim, scale[i], norm[i]);
    const cosineMs = performance.now() - started;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const ri = i % radii.length;
        sum += geometry.distance(rq, radii[ri], Math.acos(clampCosine(cosine[i])), qLeg, legs[ri]);
    }
    const totalMs = performance.now() - started;
    if (!(sum > 0 && Number.isFinite(sum))) throw new Error();
    const bytes = codes.byteLength + scale.byteLength + norm.byteLength + slack.byteLength;
    return [1, count, dim, bytes, cosineMs, totalMs, rssBefore, process.memoryUsage.rss()];
}

function prepare(atlas, library, kind, count) {
    const field = atlas.fieldOf(kind);
    const { index, geometry } = field;
    const dim = index.dimension;
    const read = library.vectorReader(kind === 'tag' ? 'tags' : 'chunks');
    const ids = index.ids.slice(0, count);
    const unit = new Float32Array(dim);
    const scratch = new Float64Array(dim);
    const probe = new Float32Array(dim);
    const probeNorm = transformInto(index, read(ids[0]), probe, 0, scratch);
    const legs = Array.from(index.radius.slice(0, ids.length), r => geometry.leg(r));
    return { ids, index, geometry, read, unit, scratch, probe, probeNorm, legs };
}

function refine(batch) {
    const { ids, index, geometry, read, unit, scratch, probe, probeNorm, legs } = batch;
    let count = 0;
    let sum = 0;
    const rq = index.radius[0];
    for (let i = 0; i < ids.length; i++) {
        const raw = read(ids[i]);
        if (!raw || raw.length !== index.dimension) continue;
        const norm = transformInto(index, raw, unit, 0, scratch);
        if (!norm) continue;
        const cosine = clampCosine(dotAt(probe, unit, 0) / probeNorm / norm);
        sum += geometry.distance(rq, index.radius[i], Math.acos(cosine), legs[0], legs[i]);
        count++;
    }
    if (!(sum > 0 && Number.isFinite(sum))) throw new Error();
    return count;
}

function measureReads(directory) {
    const library = openLibrary(directory);
    let atlas;
    try {
        atlas = createAtlas({ directory });
        // G1 的 Tag 场少于 4608 个节点。用 Chunk 场补齐，计时段内每个节点只读一次。
        const tag = prepare(atlas, library, 'tag', READ_COUNT);
        const chunk = tag.ids.length < READ_COUNT ? prepare(atlas, library, 'chunk', READ_COUNT - tag.ids.length) : null;
        const started = performance.now();
        const tags = refine(tag);
        const chunks = chunk ? refine(chunk) : 0;
        const ms = performance.now() - started;
        const measured = tags + chunks;
        console.log(JSON.stringify([2, measured, tags, chunks, ms]));
        if (measured !== READ_COUNT) process.exitCode = 1;
    } finally {
        atlas?.close();
        library.close();
    }
}

let stage = 0;
try {
    const { values } = parseArgs({ options: { library: { type: 'string' } } });
    if (!values.library) throw new Error();
    stage = 1;
    console.log(JSON.stringify(synthetic()));
    stage = 2;
    measureReads(values.library);
} catch {
    console.error(JSON.stringify([-90, stage]));
    process.exitCode = 1;
}

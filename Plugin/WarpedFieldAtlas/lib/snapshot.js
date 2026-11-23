'use strict';

// 只读解析 RiverMemo V5 的双曲场快照（Tag 场 .vcpwf、Chunk 场 .vcpwc）。
// 格式对应上游 rust-vexus-lite/crates/vcp-tdb-index/src/index/quiver/hyperbolic/warped_snapshot.rs 的 snapshot_bytes，
// 外层封装对应 rust-vexus-lite/src/warped_field_snapshot.rs（Tag）和 warped_chunks.rs（Chunk）。
// 只认版本 1；不认识的版本直接报错，不猜。

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SUPPORTED_VERSION = 1;

class SnapshotError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function cursor(buffer, start, end) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let at = start;
    const need = bytes => {
        if (at + bytes > end) throw new SnapshotError('TRUNCATED', '快照文件不完整。');
    };
    const u64 = () => {
        need(8);
        const value = view.getBigUint64(at, true);
        at += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SnapshotError('RANGE', '快照里的数值超出范围。');
        return Number(value);
    };
    const f64 = () => {
        need(8);
        const value = view.getFloat64(at, true);
        at += 8;
        return value;
    };
    const copy = (bytes, Type) => {
        need(bytes);
        // 偏移不一定按 4 或 8 对齐，所以复制一份再建类型数组。
        const out = new Type(buffer.buffer.slice(buffer.byteOffset + at, buffer.byteOffset + at + bytes));
        at += bytes;
        return out;
    };
    return {
        u64, f64,
        counted(Type) {
            const count = u64();
            return copy(count * Type.BYTES_PER_ELEMENT, Type);
        },
        ids() {
            const count = u64();
            const out = new Array(count);
            for (let i = 0; i < count; i++) out[i] = u64();
            return out;
        },
        skipCounted(width) {
            const count = u64();
            need(count * width);
            at += count * width;
            return count;
        },
        raw: bytes => copy(bytes, Uint8Array),
        get offset() { return at; },
    };
}

/** 索引本体：Tag 场和 Chunk 场共用。 */
function parseIndexPayload(buffer, start, end) {
    const c = cursor(buffer, start, end);
    const version = c.u64();
    if (version !== SUPPORTED_VERSION) {
        throw new SnapshotError('UNSUPPORTED_VERSION', `不支持的快照版本 ${version}（本工具只认版本 ${SUPPORTED_VERSION}）。`);
    }
    const dimension = c.u64();
    const profileKind = c.u64();
    const profile = [c.f64(), c.f64(), c.f64()];
    const config = {
        radiusMax: c.f64(), meanSubtractBeta: c.f64(), throatPhi0: c.f64(), angularScaleKappa: c.f64(),
        angularTau: c.f64(), angularEta: c.f64(), pruneAlpha: c.f64(),
    };
    config.degree = c.u64();
    config.constructionWidth = c.u64();
    config.adaptiveCompass = c.u64() === 1;
    const ids = c.ids();
    const slotCount = c.skipCounted(8);
    const meanAxis = c.counted(Float64Array);
    const table = c.counted(Float32Array);
    const trained = c.u64();
    if (trained !== ids.length || meanAxis.length !== dimension) {
        throw new SnapshotError('SHAPE', '快照各段长度对不上。');
    }
    // 每个节点 32 字节元数据；节点半径在第 8 字节（depth）。
    const meta = c.raw(trained * 32);
    const metaView = new DataView(meta.buffer);
    const radius = new Float32Array(trained);
    for (let i = 0; i < trained; i++) radius[i] = metaView.getFloat32(i * 32 + 8, true);
    const planeWords = c.u64();
    const chunks = Math.ceil(dimension / 64);
    if (planeWords !== trained * chunks * 2) throw new SnapshotError('SHAPE', '快照编码段长度对不上。');
    const planes = c.raw(planeWords * 8);
    const graph = c.counted(Uint32Array);
    const offsets = c.counted(Uint32Array);
    const entries = c.counted(Uint32Array);
    const directionLandmarks = c.counted(Uint32Array);
    const shellLandmarks = c.counted(Uint32Array);
    if (c.offset !== end || offsets.length !== trained + 1 || offsets[trained] !== graph.length) {
        throw new SnapshotError('SHAPE', '快照导航图长度对不上。');
    }
    return {
        version, dimension, profileKind, profile, config, ids, identitySlots: slotCount === 0,
        meanAxis, table, radius, planes, graph, offsets, entries, directionLandmarks, shellLandmarks,
    };
}

function readHeader(buffer, at, length, limit) {
    if (length > limit || at + length > buffer.length) throw new SnapshotError('HEADER', '快照文件头长度不对。');
    return JSON.parse(buffer.subarray(at, at + length).toString('utf8'));
}

/** Tag 场：VCPWF001 | 头长 | 本体长 | 头 JSON | 入度分位 f32×节点数 | 本体 | CRC32。 */
function parseTagField(buffer) {
    if (buffer.length < 28 || buffer.subarray(0, 8).toString('latin1') !== 'VCPWF001') {
        throw new SnapshotError('MAGIC', '不是双曲 Tag 场快照。');
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const end = buffer.length - 4;
    if ((zlib.crc32(buffer.subarray(0, end)) >>> 0) !== view.getUint32(end, true)) {
        throw new SnapshotError('CHECKSUM', '快照校验和不对，文件可能损坏。');
    }
    const headerLength = Number(view.getBigUint64(8, true));
    const payloadLength = Number(view.getBigUint64(16, true));
    const header = readHeader(buffer, 24, headerLength, 65536);
    const quantileStart = 24 + headerLength;
    const payloadStart = quantileStart + header.nodes * 4;
    if (payloadStart + payloadLength !== end) throw new SnapshotError('SHAPE', '快照各段长度对不上。');
    const inboundQuantile = new Float32Array(buffer.buffer.slice(buffer.byteOffset + quantileStart, buffer.byteOffset + payloadStart));
    const index = parseIndexPayload(buffer, payloadStart, end);
    if (index.ids.length !== header.nodes) throw new SnapshotError('SHAPE', '快照节点数对不上。');
    return {
        kind: 'tag', index, inboundQuantile,
        preset: header.preset, artifact: header.identity.artifact, geometry: header.identity.geometry, model: header.identity.model,
        activeTags: header.active_tags, rankedTags: header.ranked_tags,
        checksum: view.getUint32(end, true).toString(16).padStart(8, '0'),
    };
}

/** Chunk 场：VCPWC001 | 头长 | 头 JSON | 本体 | SHA-256。 */
function parseChunkField(buffer) {
    if (buffer.length < 48 || buffer.subarray(0, 8).toString('latin1') !== 'VCPWC001') {
        throw new SnapshotError('MAGIC', '不是双曲 Chunk 场快照。');
    }
    const end = buffer.length - 32;
    const digest = crypto.createHash('sha256').update(buffer.subarray(0, end)).digest();
    if (!digest.equals(buffer.subarray(end))) throw new SnapshotError('CHECKSUM', '快照校验和不对，文件可能损坏。');
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const headerLength = Number(view.getBigUint64(8, true));
    const header = readHeader(buffer, 16, headerLength, 64 * 1024 * 1024);
    const index = parseIndexPayload(buffer, 16 + headerLength, end);
    return {
        kind: 'chunk', index,
        rule: header.identity.rule, model: header.identity.model, facts: header.identity.facts,
        mean: Float64Array.from(header.mean || []),
        alignmentQuantiles: Float64Array.from(header.alignment_quantiles || []),
        versions: header.versions && typeof header.versions === 'object' ? header.versions : null,
        checksum: digest.subarray(0, 4).toString('hex'),
        fullDigest: Buffer.from(buffer.subarray(end)).toString('hex'),
    };
}

/** Chunk 转换侧车：VCPWI001 | 头长 | 头 JSON(base, versions) | 尾编码 | SHA-256。 */
function parseConvertedTail(buffer, expectedBase = null) {
    if (buffer.length < 48 || buffer.subarray(0, 8).toString('latin1') !== 'VCPWI001') {
        throw new SnapshotError('MAGIC', '不是双曲 Chunk 转换侧车。');
    }
    const end = buffer.length - 32;
    const digest = crypto.createHash('sha256').update(buffer.subarray(0, end)).digest();
    if (!digest.equals(buffer.subarray(end))) throw new SnapshotError('CHECKSUM', '侧车校验和不对，文件可能损坏。');
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const headerLength = Number(view.getBigUint64(8, true));
    const header = readHeader(buffer, 16, headerLength, 64 * 1024 * 1024);
    if (expectedBase && header.base !== expectedBase) {
        return null;
    }
    const versions = header.versions && typeof header.versions === 'object' ? header.versions : {};
    const chunkIds = Object.keys(versions).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
    return {
        kind: 'chunk-converted-tail',
        base: header.base,
        chunkIds,
        versions,
    };
}

module.exports = { parseTagField, parseChunkField, parseConvertedTail, SnapshotError, SUPPORTED_VERSION };

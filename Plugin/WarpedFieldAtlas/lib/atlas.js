'use strict';

// 双曲场图的数据服务。对知识库只读；缓存只写在 cacheDirectory（插件自己的目录）里。
// 接口（都是 GET，返回 JSON）：
//   /status                      知识库里有哪些场、快照是否当前一代、距离函数自检结果
//   /field/<tag|chunk>           全部节点：半径、角度、话题团、名称等，画全景图用
//   /field/<kind>/node/<id>      一个节点的详情：数值、连线、对应的片段或 Tag
//   /field/<kind>/query?node=<id>  以一个节点为查询：夹角、距离、等距离线和精算名次保证
//   /field/<kind>/query?message=<hash>  以一条对话消息为查询（向量取自 ContextFolding 存的，不调用嵌入接口）
//   /messages?q=<文字>             可以当查询的对话消息

const fs = require('node:fs');
const path = require('node:path');
const { parseTagField, parseChunkField } = require('./snapshot');
const { createGeometry } = require('./geometry');
const { computeLayout, LAYOUT_VERSION } = require('./layout');
const { openLibrary, openReadOnly } = require('./library');
const { encode, matchesCode, dotAt, coarseCosine, clampCosine } = require('./compact');

const CONTOUR_RANKS = [5, 10, 20, 40];
const FLAG_ENTRY = 1;
const FLAG_DIRECTION = 2;
const FLAG_SHELL = 4;

const round = (value, digits) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const rounded = (values, digits) => Array.from(values, v => round(v, digits));
const displayTheta = theta => round(theta * 180 / Math.PI, 3);
const displayDistance = distance => round(distance, 5);

class AtlasError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** 把原始向量换到场的坐标，保持原有运算次序，返回存入 Float32 后的模长。 */
function transformInto(index, raw, out, at, scratch) {
    const { dimension: dim, meanAxis: axis } = index;
    const beta = index.config.meanSubtractBeta;
    let length = 0;
    for (let j = 0; j < dim; j++) length += raw[j] * raw[j];
    length = Math.sqrt(length);
    let alignment = 0;
    for (let j = 0; j < dim; j++) alignment += raw[j] / length * axis[j];
    let residual = 0;
    for (let j = 0; j < dim; j++) {
        const value = raw[j] / length - beta * alignment * axis[j];
        scratch[j] = value;
        residual += value * value;
    }
    residual = Math.sqrt(residual);
    let squared = 0;
    for (let j = 0; j < dim; j++) {
        const value = Math.fround(scratch[j] / residual);
        out[at + j] = value;
        squared += value * value;
    }
    return Math.sqrt(squared);
}

/**
 * exactMegabytes：一个场的向量按原样全部放进内存最多占多少（MB）。超过了就改用压缩装法（见 loadVectors）。
 * 默认 256：3072 维时两万个节点以内全部精确。
 */
function createAtlas({
    directory, cacheDirectory = null, messageStore = null, exactMegabytes = 256, refine = 4096, refineCosine = 512,
}) {
    const library = openLibrary(directory);
    const mb = Number(exactMegabytes);
    const exactBytes = (Number.isFinite(mb) || mb === Infinity ? Math.max(0, mb) : 256) * 1024 * 1024;
    const fields = new Map();
    let tagNames = null;
    let messageDb;

    function names() {
        if (!tagNames) tagNames = new Map(library.tags().map(row => [row.id, row.name]));
        return tagNames;
    }

    function layoutFor(kind, snapshot) {
        const index = snapshot.index;
        const file = cacheDirectory && path.join(cacheDirectory, `layout-${kind}-${snapshot.checksum}-${index.ids.length}-v${LAYOUT_VERSION}.json`);
        if (file && fs.existsSync(file)) {
            try {
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (saved.angle.length === index.ids.length) {
                    return { angle: Float32Array.from(saved.angle), group: Int32Array.from(saved.group), groups: saved.groups, cached: true, ms: 0 };
                }
            } catch { /* 缓存读不出来就重算 */ }
        }
        const started = performance.now();
        const layout = computeLayout(index.ids.length, index.offsets, index.graph);
        const ms = performance.now() - started;
        if (file) {
            fs.mkdirSync(cacheDirectory, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ angle: rounded(layout.angle, 5), group: Array.from(layout.group), groups: layout.groups }));
        }
        return { ...layout, cached: false, ms };
    }

    function build(kind) {
        const located = kind === 'tag' ? library.tagSnapshot() : library.chunkSnapshot();
        if (!located) throw new AtlasError(404, kind === 'tag' ? '这个知识库还没有双曲 Tag 场文件。' : '这个知识库还没有双曲 Chunk 场文件。');
        const snapshot = kind === 'tag' ? parseTagField(fs.readFileSync(located.file)) : parseChunkField(fs.readFileSync(located.file));
        const index = snapshot.index;
        const count = index.ids.length;
        const geometry = createGeometry(index);
        const check = geometry.supported ? geometry.selfCheck(index.table, index.config.radiusMax) : { ok: false, reason: geometry.reason };
        const layout = layoutFor(kind, snapshot);
        const indexOf = new Map(index.ids.map((id, i) => [id, i]));
        const flags = new Uint8Array(count);
        for (const i of index.entries) flags[i] |= FLAG_ENTRY;
        for (const i of index.directionLandmarks) flags[i] |= FLAG_DIRECTION;
        for (const i of index.shellLandmarks) flags[i] |= FLAG_SHELL;
        const field = { kind, located, snapshot, index, count, geometry, check, layout, indexOf, flags, vectors: null, legs: null, river: undefined };
        if (kind === 'tag') {
            const all = names();
            field.labels = index.ids.map(id => all.get(id) || `Tag#${id}`);
            const residual = library.residuals(snapshot.geometry);
            field.residual = index.ids.map(id => residual.ratio.get(id));
            field.outside = [...all].filter(([id]) => !indexOf.has(id))
                .map(([id, name]) => ({ id, name, reason: residual.reason.get(id) || null }));
        } else {
            const rows = new Map(library.chunks().map(row => [row.id, row]));
            field.rows = rows;
            field.labels = index.ids.map(id => {
                const row = rows.get(id);
                if (!row) return `片段#${id}`;
                const name = path.basename(String(row.path || '')).replace(/\.(txt|md)$/i, '');
                return `${row.diary} · ${name}${row.position ? ` #${row.position + 1}` : ''}`;
            });
        }
        field.groups = layout.groups.map((g, order) => ({ ...g, order, rep: -1 }));
        for (let i = 0; i < count; i++) {
            const g = field.groups[layout.group[i]];
            if (g.rep < 0 || index.radius[i] < index.radius[g.rep]) g.rep = i;
        }
        if (kind === 'chunk') {
            // 片段的话题团用团里最多的日记本命名。
            const tally = field.groups.map(() => new Map());
            index.ids.forEach((id, i) => {
                const diary = field.rows.get(id)?.diary || '';
                const t = tally[layout.group[i]];
                t.set(diary, (t.get(diary) || 0) + 1);
            });
            field.groups.forEach((g, order) => { g.label = [...tally[order]].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; });
        } else {
            field.groups.forEach(g => { g.label = g.rep >= 0 ? field.labels[g.rep] : ''; });
        }
        return field;
    }

    function fieldOf(kind) {
        if (kind !== 'tag' && kind !== 'chunk') throw new AtlasError(404, '没有这个场。');
        if (!fields.has(kind)) fields.set(kind, build(kind));
        return fields.get(kind);
    }

    /**
     * 把全场节点的向量读进内存，查询视图要拿它们和查询逐个比。两种装法：
     *   全量（exact）：每维 4 字节的原样向量，全部精确。向量总量不超过 exactBytes 时用这种，我们自己的库就是。
     *   压缩（compact）：每维压成 1 字节（每个向量按自己的最大分量定刻度），十万个 3072 维的节点约 0.3 GB，是全量的四分之一。
     *     查询时先用压缩向量粗算全场，再对最近的一批从库里读原始向量精算（见 scan）。
     *     slack 记下每个向量压缩前后差了多少，用它能算出粗算的余弦最多偏多少。
     */
    function loadVectors(field) {
        if (field.vectors) return field.vectors;
        const { index, count } = field;
        const dim = index.dimension;
        const exact = count * dim * 4 <= exactBytes;
        const read = library.vectorReader(field.kind === 'tag' ? 'tags' : 'chunks');
        const norm = new Float64Array(count);
        const missing = [];
        const scratch = new Float64Array(dim);
        if (exact) {
            const unit = new Float32Array(count * dim);
            for (let i = 0; i < count; i++) {
                const raw = read(index.ids[i]);
                if (!raw || raw.length !== dim) { missing.push(i); continue; }
                norm[i] = transformInto(index, raw, unit, i * dim, scratch);
            }
            field.vectors = { exact: true, unit, norm, missing, dim };
            return field.vectors;
        }
        const codes = new Int8Array(count * dim);
        const scale = new Float32Array(count);
        const slack = new Float64Array(count);
        const one = new Float32Array(dim);
        for (let i = 0; i < count; i++) {
            const raw = read(index.ids[i]);
            if (!raw || raw.length !== dim) { missing.push(i); continue; }
            norm[i] = transformInto(index, raw, one, 0, scratch);
            if (!norm[i]) continue;
            const encoded = encode(one, norm[i], codes, i * dim);
            scale[i] = encoded.scale;
            slack[i] = encoded.slack;
        }
        field.vectors = { exact: false, codes, scale, slack, norm, missing, dim, read, one, scratch };
        return field.vectors;
    }

    /** 一个节点的精确向量（场的坐标）。压缩装法下现从库里读，写进 vectors.one；读不出来返回 null。 */
    function exactUnit(field, v, i) {
        if (v.exact) return v.norm[i] ? v.unit.subarray(i * v.dim, (i + 1) * v.dim) : null;
        const raw = v.read(field.index.ids[i]);
        if (!raw || raw.length !== v.dim) return null;
        return transformInto(field.index, raw, v.one, 0, v.scratch) ? v.one : null;
    }

    /**
     * 拿一个查询（场坐标里的向量 probe、半径 rq）和全场每个节点比：夹角 theta（弧度）和双曲距离 distance；skip 是查询自己（没有就是 −1）。
     * 全量装法：全部精确。
     * 压缩装法：先粗算全场；再取粗算距离最近的 refine 个和粗算余弦最大的 refineCosine 个，读原始向量精算。
     *   其余节点留粗算值。同时算出可以证明的两个数：
     *   distanceRank —— 按距离的前多少名与全部精算的结果完全一致；cosineRank —— 按余弦的前多少名完全一致。
     *   证明：没精算的节点，真实余弦不会超过“粗算余弦 + slack”，真实距离不会小于按这个余弦算出来的距离（半径不变时距离随夹角增大）；
     *   精算过的节点里，比所有这些下界都近的那些，名次就不可能被没精算的节点插队。
     */
    function scan(f, v, probe, probeNorm, rq, legQ, skip, radius, legs, diagnostics = false) {
        const { norm, dim } = v;
        const count = f.count;
        const theta = new Float64Array(count).fill(NaN);
        const distance = new Float64Array(count).fill(NaN);
        const cosine = new Float64Array(count).fill(NaN);
        if (skip >= 0) {
            theta[skip] = 0;
            distance[skip] = 0;
            cosine[skip] = 1;
        }
        if (v.exact) {
            const unit = v.unit;
            for (let i = 0; i < count; i++) {
                if (i === skip || !norm[i]) continue;
                cosine[i] = clampCosine(dotAt(probe, unit, i * dim) / probeNorm / norm[i]);
                theta[i] = Math.acos(cosine[i]);
                distance[i] = f.geometry.distance(rq, radius[i], theta[i], legQ, legs[i]);
            }
            return { theta, distance, cosine, exact: { all: true } };
        }
        const { codes, scale, slack } = v;
        const coarse = new Float64Array(count).fill(NaN);
        const candidates = [];
        for (let i = 0; i < count; i++) {
            if (i === skip || !norm[i]) continue;
            coarse[i] = coarseCosine(probe, probeNorm, codes, i * dim, scale[i], norm[i]);
            cosine[i] = clampCosine(coarse[i]);
            theta[i] = Math.acos(cosine[i]);
            distance[i] = f.geometry.distance(rq, radius[i], theta[i], legQ, legs[i]);
            candidates.push(i);
        }
        const refined = new Uint8Array(count);
        const byDistance = candidates.slice().sort((a, b) => distance[a] - distance[b] || a - b).slice(0, Math.max(0, refine));
        const byCosine = candidates.slice().sort((a, b) => coarse[b] - coarse[a] || a - b).slice(0, Math.max(0, refineCosine));
        let done = 0;
        for (const i of [...byDistance, ...byCosine]) {
            if (refined[i]) continue;
            const unit = exactUnit(f, v, i);
            if (!unit) continue;
            // 压缩向量是载入时做的，精算用的向量是现在从库里读的。两者对不上，说明库里这个向量在载入之后变了：
            // 缓存作废，这次请求让调用方重试（重试时重新载入）。只看读到的这些向量，库里别处的写入不会让缓存作废。
            if (!matchesCode(unit, norm[i], codes, i * dim, scale[i], slack[i])) {
                f.vectors = null;
                throw new AtlasError(409, '知识库的向量在载入之后有变动，请重试。');
            }
            cosine[i] = clampCosine(dotAt(probe, unit, 0) / probeNorm / norm[i]);
            theta[i] = Math.acos(cosine[i]);
            distance[i] = f.geometry.distance(rq, radius[i], theta[i], legQ, legs[i]);
            refined[i] = 1;
            done++;
        }
        // 没精算的节点：真实距离的下界里最小的那个、真实余弦的上界里最大的那个。
        let nearestBound = Infinity;
        let cosineBound = -Infinity;
        for (const i of candidates) {
            if (refined[i]) continue;
            const most = clampCosine(coarse[i] + slack[i]);
            if (most > cosineBound) cosineBound = most;
            const bound = f.geometry.distance(rq, radius[i], Math.acos(most), legQ, legs[i]);
            if (bound < nearestBound) nearestBound = bound;
        }
        // 接口会舍入夹角和距离。舍入后仍严格优于界限，前缀才不会在显示时与粗算节点并列。
        const distanceLimit = displayDistance(nearestBound);
        const thetaLimit = cosineBound === -Infinity ? Infinity : displayTheta(Math.acos(cosineBound));
        let distanceRank = 0;
        let cosineRank = 0;
        for (const i of candidates) {
            if (!refined[i]) continue;
            if (displayDistance(distance[i]) < distanceLimit) distanceRank++;
            if (displayTheta(theta[i]) < thetaLimit) cosineRank++;
        }
        const exact = { all: false, refined: done, distanceRank, cosineRank };
        const result = { theta, distance, cosine, exact };
        return diagnostics ? { ...result, coarse, refined, slack: slack.slice() } : result;
    }

    function legsOf(field) {
        if (!field.legs) field.legs = Array.from(field.index.radius, r => field.geometry.leg(r));
        return field.legs;
    }

    function riverOf(field) {
        if (field.river !== undefined) return field.river;
        const network = field.kind === 'tag' ? library.riverNetwork(field.snapshot.artifact) : null;
        if (network) {
            const incoming = network.ids.map(() => []);
            for (let source = 0; source < network.ids.length; source++) {
                for (let e = network.offsets[source]; e < network.offsets[source + 1]; e++) incoming[network.targets[e]].push([source, network.weights[e]]);
            }
            network.incoming = incoming;
            network.position = new Map(network.ids.map((id, i) => [id, i]));
        }
        field.river = network;
        return network;
    }

    function status() {
        const out = { fields: {} };
        for (const kind of ['tag', 'chunk']) {
            try {
                const f = fieldOf(kind);
                out.fields[kind] = {
                    available: true, nodes: f.count, file: path.basename(f.located.file), current: f.located.current !== false,
                    distanceCheck: f.check, layoutCached: f.layout.cached, layoutMs: round(f.layout.ms, 1),
                };
            } catch (error) {
                out.fields[kind] = { available: false, reason: error.message };
            }
        }
        out.messages = { available: !!messages() };
        return out;
    }

    function fieldPayload(kind) {
        const f = fieldOf(kind);
        const { index } = f;
        return {
            kind, count: f.count, ids: index.ids, labels: f.labels,
            radius: rounded(index.radius, 4), angle: rounded(f.layout.angle, 5), group: Array.from(f.layout.group),
            quantile: kind === 'tag' ? rounded(f.snapshot.inboundQuantile, 3) : null,
            residual: kind === 'tag' ? f.residual.map(v => (v == null ? null : round(v, 3))) : null,
            flags: Array.from(f.flags),
            groups: f.groups.map(g => ({ start: round(g.start, 5), end: round(g.end, 5), count: g.count, label: g.label, rep: g.rep })),
            outside: kind === 'tag' ? f.outside : [],
            radiusRange: [0.35, index.config.radiusMax],
            geometry: f.geometry.supported ? { base: f.geometry.base, alpha: f.geometry.alpha, phi0: f.geometry.phi0, kappa: f.geometry.kappa } : null,
            snapshot: {
                file: path.basename(f.located.file), current: f.located.current !== false, preset: f.snapshot.preset || null,
                rule: f.snapshot.rule || null, degree: index.config.degree, dimension: index.dimension,
                activeTags: f.snapshot.activeTags ?? null,
            },
            distanceCheck: f.check,
        };
    }

    function navigationOf(f, i) {
        return Array.from(f.index.graph.subarray(f.index.offsets[i], f.index.offsets[i + 1]));
    }

    function tagDetail(id) {
        const f = fieldOf('tag');
        const i = f.indexOf.get(id);
        const name = names().get(id);
        if (name === undefined) throw new AtlasError(404, '没有这个 Tag。');
        const fragments = library.chunksOfTag(id);
        let chunkIndex = null;
        try { chunkIndex = fieldOf('chunk').indexOf; } catch { /* 没有 Chunk 场时片段只列出、不能跳转 */ }
        const chunks = { total: fragments.total, rows: fragments.rows.map(row => ({ ...row, index: chunkIndex?.get(row.id) ?? null })) };
        if (i === undefined) {
            const outside = f.outside.find(row => row.id === id);
            return { kind: 'tag', id, name, inField: false, reason: outside?.reason || null, chunks };
        }
        const network = riverOf(f);
        let river = null;
        if (network && network.position.has(id)) {
            const p = network.position.get(id);
            const describe = (other, weight, wormhole) => {
                const otherId = network.ids[other];
                return { id: otherId, name: names().get(otherId) || `Tag#${otherId}`, index: f.indexOf.get(otherId) ?? null, weight: round(weight, 4), wormhole };
            };
            const outgoing = [];
            for (let e = network.offsets[p]; e < network.offsets[p + 1]; e++) {
                outgoing.push(describe(network.targets[e], network.weights[e], network.isWormhole(id, network.ids[network.targets[e]])));
            }
            const incoming = network.incoming[p].map(([source, weight]) => describe(source, weight, network.isWormhole(network.ids[source], id)));
            const byWeight = (a, b) => b.weight - a.weight || a.id - b.id;
            river = {
                outgoing: outgoing.sort(byWeight), incoming: incoming.sort(byWeight),
                inboundMass: network.inbound.has(id) ? round(network.inbound.get(id), 4) : null,
            };
        }
        return {
            kind: 'tag', id, name, inField: true, index: i,
            radius: round(f.index.radius[i], 4), quantile: round(f.snapshot.inboundQuantile[i], 3),
            residual: f.residual[i] == null ? null : round(f.residual[i], 3),
            group: f.layout.group[i], flags: f.flags[i],
            navigation: navigationOf(f, i), river, chunks,
        };
    }

    function chunkDetail(id) {
        const f = fieldOf('chunk');
        const i = f.indexOf.get(id);
        const row = library.chunkDetail(id);
        if (!row) throw new AtlasError(404, '没有这个片段。');
        let tagIndex = null;
        try { tagIndex = fieldOf('tag').indexOf; } catch { /* 没有 Tag 场时 Tag 只列出 */ }
        const tags = row.tags.map(tag => ({ ...tag, index: tagIndex?.get(tag.id) ?? null }));
        const base = { kind: 'chunk', id, label: i === undefined ? null : f.labels[i], diary: row.diary, path: row.path, position: row.position, text: row.text, tags };
        if (i === undefined) return { ...base, inField: false };
        return { ...base, inField: true, index: i, radius: round(f.index.radius[i], 4), group: f.layout.group[i], flags: f.flags[i], navigation: navigationOf(f, i) };
    }

    /** 把一个原始向量换到场的坐标（与 loadVectors 里对节点做的相同）。 */
    function toFieldUnit(f, raw) {
        const dim = f.index.dimension;
        if (!raw || raw.length !== dim) throw new AtlasError(400, '查询向量的维数与场不一致。');
        const axis = f.index.meanAxis;
        const beta = f.index.config.meanSubtractBeta;
        let length = 0;
        for (let j = 0; j < dim; j++) length += raw[j] * raw[j];
        length = Math.sqrt(length);
        if (!(length > 1e-12)) throw new AtlasError(400, '查询向量是零向量。');
        let alignment = 0;
        for (let j = 0; j < dim; j++) alignment += raw[j] / length * axis[j];
        const scratch = new Float64Array(dim);
        let residual = 0;
        for (let j = 0; j < dim; j++) { const v = raw[j] / length - beta * alignment * axis[j]; scratch[j] = v; residual += v * v; }
        residual = Math.sqrt(residual);
        const unit = new Float32Array(dim);
        let squared = 0;
        for (let j = 0; j < dim; j++) { unit[j] = scratch[j] / residual; squared += unit[j] * unit[j]; }
        return { unit, norm: Math.sqrt(squared) };
    }

    /**
     * Chunk 场给查询定半径的办法（上游 warped_chunks.rs）：看查询与全库平均方向有多贴合，贴合度在全库里排到几分位，
     * 越贴合越靠里圈。旧规则（chunk-axis-residual-v1）直接用贴合度。
     */
    function chunkQueryRadius(f, raw) {
        const mean = f.snapshot.mean;
        const knots = f.snapshot.alignmentQuantiles;
        let length = 0;
        let meanLength = 0;
        for (let j = 0; j < raw.length; j++) { length += raw[j] * raw[j]; meanLength += mean[j] * mean[j]; }
        length = Math.sqrt(length);
        meanLength = Math.sqrt(meanLength);
        let aligned = 0;
        if (meanLength > 1e-12) for (let j = 0; j < raw.length; j++) aligned += raw[j] / length * mean[j] / meanLength;
        if (!knots.length) return Math.fround(0.35 + 0.30 * Math.sqrt(Math.max(0, 1 - Math.min(1, Math.max(-1, aligned)) ** 2)));
        const value = Math.min(1, Math.abs(aligned));
        let lo = 0;
        while (lo < knots.length && knots[lo] < value) lo++;
        let hi = lo;
        while (hi < knots.length && knots[hi] <= value) hi++;
        let percentile;
        if (lo !== hi) percentile = (lo + hi - 1) / (2 * (knots.length - 1));
        else if (lo === 0) percentile = 0;
        else if (lo === knots.length) percentile = 1;
        else percentile = ((lo - 1) + (value - knots[lo - 1]) / (knots[lo] - knots[lo - 1])) / (knots.length - 1);
        return Math.fround(0.35 + 0.30 * (1 - percentile) ** 1.10);
    }

    // ---- 对话消息：ContextFolding 给每条消息存过向量（和知识库同一个嵌入模型），拿来当真实查询，不用调嵌入接口 ----
    const NOT_CHAT = /^[>\[{<#]|TOOL_REQUEST|VCP调用结果|tool_name|<<<\[|本轮回复异常|\[系统|^---/;
    function messages() {
        if (messageDb !== undefined) return messageDb;
        messageDb = null;
        if (messageStore && fs.existsSync(messageStore)) {
            try { messageDb = openReadOnly(messageStore); } catch { messageDb = null; }
        }
        return messageDb;
    }
    function listMessages(text, limit = 30) {
        const db = messages();
        if (!db) throw new AtlasError(404, '没有找到对话消息的向量（ContextFolding 的存储）。');
        const needle = String(text || '').trim().slice(0, 200);
        const columns = 'SELECT content_hash AS hash, text_preview AS text, created_at AS at FROM folding_entries WHERE vector IS NOT NULL';
        const rows = needle
            ? db.all(`${columns} AND instr(lower(text_preview), lower(?)) > 0 ORDER BY created_at DESC LIMIT 600`, needle)
            : db.all(`${columns} ORDER BY created_at DESC LIMIT 600`);
        const out = [];
        for (const row of rows) {
            const clean = String(row.text || '').replace(/\s+/g, ' ').trim();
            // 只留真实的对话：工具结果、协议块、系统提示和太短太长的都不要。
            if (clean.length < 12 || clean.length > 600 || NOT_CHAT.test(clean)) continue;
            out.push({ hash: row.hash, text: clean.slice(0, 200), at: row.at });
            if (out.length >= limit) break;
        }
        return { rows: out };
    }
    function messageVector(hash) {
        const db = messages();
        if (!db) throw new AtlasError(404, '没有找到对话消息的向量（ContextFolding 的存储）。');
        const row = db.get('SELECT text_preview AS text, vector FROM folding_entries WHERE content_hash=? AND vector IS NOT NULL', hash);
        if (!row || !row.vector || row.vector.byteLength % 4) throw new AtlasError(404, '没有这条对话消息。');
        const blob = row.vector;
        return {
            raw: new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)),
            text: String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        };
    }

    /**
     * 查询视图的数据：对全场每个节点算夹角和距离。开发对照可取舍入前的数据和压缩诊断。
     * target.node：以场里的一个节点为查询，用它自己的向量和半径。
     * target.message：以一条对话消息为查询。Tag 场的查询半径在生产里由 EPA 信号决定，这里取一个常见值（可用 radius 指定）；
     *   Chunk 场的查询半径按上游的规则由向量本身算出。
     */
    function query(kind, target, { diagnostics = false } = {}) {
        const f = fieldOf(kind);
        if (!f.geometry.supported) throw new AtlasError(409, f.geometry.reason);
        if (!f.check.ok) throw new AtlasError(409, '距离函数与快照里的距离表对不上，查询视图停用。');
        const started = performance.now();
        const vectors = loadVectors(f);
        const { norm } = vectors;
        const legs = legsOf(f);
        const radius = f.index.radius;
        let q = -1;
        let probe;
        let probeNorm;
        let rq;
        let legQ;
        let described;
        if (target.message != null) {
            const message = messageVector(String(target.message));
            const converted = toFieldUnit(f, message.raw);
            probe = converted.unit;
            probeNorm = converted.norm;
            const asked = target.radius == null || target.radius === '' ? NaN : Number(target.radius);
            rq = kind === 'chunk' ? chunkQueryRadius(f, message.raw)
                : Math.fround(Number.isFinite(asked) ? Math.min(f.index.config.radiusMax, Math.max(0.35, asked)) : 0.42);
            legQ = f.geometry.leg(rq);
            described = { message: String(target.message), index: null, label: message.text, radius: round(rq, 4), radiusFrom: kind === 'chunk' ? 'rule' : 'default' };
        } else {
            q = f.indexOf.get(target.node);
            if (q === undefined) throw new AtlasError(404, '这个节点不在场里，不能当查询。');
            const own = norm[q] ? exactUnit(f, vectors, q) : null;
            if (!own) throw new AtlasError(409, '这个节点的原始向量读不出来。');
            // 压缩装法下 exactUnit 给的是一块反复使用的缓冲，后面精算别的节点时会被覆盖，所以抄一份。
            probe = vectors.exact ? own : Float32Array.from(own);
            probeNorm = norm[q];
            rq = radius[q];
            legQ = legs[q];
            described = { id: target.node, index: q, label: f.labels[q], radius: round(rq, 4), radiusFrom: 'node' };
        }
        const result = scan(f, vectors, probe, probeNorm, rq, legQ, q, radius, legs, diagnostics);
        if (diagnostics) return { ...result, radius: rq, skip: q };
        const { theta, distance, exact } = result;
        const order = [];
        for (let i = 0; i < f.count; i++) if (i !== q && Number.isFinite(distance[i])) order.push(i);
        order.sort((a, b) => distance[a] - distance[b] || a - b);
        const steps = 24;
        const grid = Array.from({ length: steps + 1 }, (_, k) => 0.35 + (f.index.config.radiusMax - 0.35) * k / steps);
        const contours = CONTOUR_RANKS.filter(rank => rank <= order.length).map(rank => {
            const level = distance[order[rank - 1]];
            const angles = f.geometry.contour(rq, level, grid);
            return { rank, distance: round(level, 4), points: grid.map((r, k) => (angles[k] == null ? null : [round(r, 4), round(angles[k] * 180 / Math.PI, 3)])).filter(Boolean) };
        });
        let throat = 0;
        const sample = order.slice(0, 40);
        for (const i of sample) if (f.geometry.regime(rq, radius[i], theta[i], legQ, legs[i]) === 'throat') throat++;
        return {
            kind, query: described,
            theta: Array.from(theta, v => (Number.isFinite(v) ? displayTheta(v) : null)),
            distance: Array.from(distance, v => (Number.isFinite(v) ? displayDistance(v) : null)),
            contours, throatShare: sample.length ? round(throat / sample.length, 3) : null,
            // 全量装法是 { all: true }；压缩装法是 { all: false, refined, distanceRank, cosineRank }（见 scan）。
            exact,
            ms: round(performance.now() - started, 1),
        };
    }

    /**
     * 用一个原始向量和给定的查询半径，对全场算距离并排序，附上精算名次保证。
     * radiusOverride 只给自动核对的反向对照用：换一套节点半径重排。
     */
    function rankVector(kind, raw, queryRadius, { radiusOverride = null } = {}) {
        const f = fieldOf(kind);
        if (!f.geometry.supported) throw new AtlasError(409, f.geometry.reason);
        const { unit: q, norm: qNorm } = toFieldUnit(f, raw);
        const radius = radiusOverride || f.index.radius;
        const legs = radiusOverride ? Array.from(radiusOverride, r => f.geometry.leg(r)) : legsOf(f);
        const legQ = f.geometry.leg(queryRadius);
        const vectors = loadVectors(f);
        const { cosine, distance, exact } = scan(f, vectors, q, qNorm, queryRadius, legQ, -1, radius, legs);
        const rows = [];
        for (let i = 0; i < f.count; i++) {
            if (!Number.isFinite(distance[i])) continue;
            rows.push({ id: f.index.ids[i], cosine: cosine[i], distance: distance[i] });
        }
        rows.sort((a, b) => a.distance - b.distance || a.id - b.id);
        rows.exact = exact;
        return rows;
    }

    /** 路由：pathname 不含插件前缀。 */
    function handle(pathname, params = new URLSearchParams()) {
        const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts.length === 1 && parts[0] === 'status') return status();
        if (parts[0] === 'field' && parts.length === 2) return fieldPayload(parts[1]);
        if (parts[0] === 'field' && parts[2] === 'node' && parts.length === 4) {
            const id = Number(parts[3]);
            if (!Number.isSafeInteger(id)) throw new AtlasError(400, '节点编号不对。');
            if (parts[1] === 'tag') return tagDetail(id);
            if (parts[1] === 'chunk') return chunkDetail(id);
        }
        if (parts[0] === 'field' && parts[2] === 'query' && parts.length === 3) {
            if (params.get('message')) return query(parts[1], { message: params.get('message'), radius: params.get('radius') });
            const id = Number(params.get('node'));
            if (!Number.isSafeInteger(id)) throw new AtlasError(400, '节点编号不对。');
            return query(parts[1], { node: id });
        }
        if (parts.length === 1 && parts[0] === 'messages') return listMessages(params.get('q'));
        throw new AtlasError(404, '没有这个接口。');
    }

    return {
        handle, status, fieldOf, loadVectors, query, rankVector, chunkQueryRadius,
        close: () => { library.close(); messageDb?.close(); },
    };
}

module.exports = { createAtlas, transformInto, AtlasError, FLAG_ENTRY, FLAG_DIRECTION, FLAG_SHELL };

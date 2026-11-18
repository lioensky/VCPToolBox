'use strict';

// 双曲场图与原生检索的自动核对（开发期和每次上游合并后跑；不随插件加载）。
//
// 做法：在一份知识库副本上，用生产代码（KnowledgeBaseManager 和生产 .node）跑一批真实查询向量，
// 从诊断信息里取出 Tag 场第 0 层的查询半径和返回的 Tag 编号；再让本工具用同一个向量、同一个半径算出全场精确排序，两边对比。
//
// 判定线（先定后测）：
//   1. 原生返回的条目，在本工具排序里的先后一致：必须 100%。
//   2. 原生返回的条目与本工具前 K 名的重合率：平均不低于 95%。原生是近似检索，可以漏掉个别真正的近邻，漏掉的逐条列出。
//   3. 反向对照：把节点半径打乱后，第 1 条必须在多数查询上不成立，证明这个核对查得出错。
//
// 不调用任何付费接口：查询向量是 ContextFolding 存过的真实对话消息；嵌入和 Jev 的地址都指到本机空端口。
// 用法：
//   node dev/check-native.js --snapshot <库备份目录> --queries <含 queries[].vector 的 JSON> --toolbox <toolbox 代码目录>
//        --runtime <临时运行父目录> [--modules <node_modules 目录>]
//        [--out <报告.json>] [--exact-mb <数字>] [--refine <个数> --refine-cosine <个数>]
// 每次在 --runtime 下新建一份运行副本。库所用的 EmbeddingModelSig 等设置可由调用者通过进程环境提供。
// 标准输出两行：Tag 的节点数、自检通过数、比较数、顺序一致数、平均重合率、打乱后顺序一致数、通过标记，
// 然后是 Chunk 的节点数、比较数、返回数、已知节点数、最大距离差（无数据为 -1）、顺序一致数、通过标记。
// --out 写详细的数值报告。跳过原因编码：1 表示原生调用出错，2 表示没有可比较的双曲结果。
// 失败行 [-90, 0] 表示参数不全，[-90, 1] 表示运行未完成。
// 加 --verbose 显示后端和原生模块的日志以及出错原因（日志里可能有库里的文字，默认不显示）。
// --exact-mb 0 强制用压缩装法；再把 --refine 调小，绝大多数节点留在粗算，才是对压缩装法的真核对。

const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function argument(name, fallback = null) {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const snapshot = argument('snapshot');
const queriesFile = argument('queries');
const toolbox = argument('toolbox');
const runtime = argument('runtime');
if (!snapshot || !queriesFile || !toolbox || !runtime) {
    console.error('[-90,0]');
    process.exit(2);
}
const modules = argument('modules', path.join(toolbox, 'node_modules'));
const outFile = argument('out');

const { createAtlas } = require('../lib/atlas');
const { parseExactMegabytes } = require('../lib/compact');

function prepareRuntime(queries) {
    const parent = path.resolve(runtime);
    fs.mkdirSync(parent, { recursive: true });
    const rt = fs.mkdtempSync(path.join(parent, 'warped-atlas-native-'));
    const store = path.join(rt, 'VectorStore');
    const notes = path.join(rt, 'dailynote');
    const privateConfig = new Set(['config.env', '.env', 'auth.json']);
    const filter = file => !privateConfig.has(path.basename(file).toLowerCase()) && !fs.lstatSync(file).isSymbolicLink();
    fs.cpSync(path.join(snapshot, 'VectorStore'), store, { recursive: true, filter });
    if (fs.existsSync(path.join(snapshot, 'dailynote'))) {
        fs.cpSync(path.join(snapshot, 'dailynote'), notes, { recursive: true, filter });
    } else {
        fs.mkdirSync(notes);
    }

    // 让生产代码在工作副本缺少依赖时使用 --modules 指定的目录。
    process.env.NODE_PATH = [path.resolve(modules), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    require('node:module').Module._initPaths();
    Object.assign(process.env, {
        KNOWLEDGEBASE_ROOT_PATH: notes,
        KNOWLEDGEBASE_STORE_PATH: store,
        VECTORDB_DIMENSION: process.env.VECTORDB_DIMENSION || String(queries[0].vector.length),
        API_URL: 'http://127.0.0.1:9', API_Key: 'warped-atlas-check-no-paid-calls',
        JEV_API_URL: 'http://127.0.0.1:9/jev', JEV_API_KEY: '',
    });
    return store;
}

function compare(nativeIds, ranked) {
    const position = new Map(ranked.map((row, n) => [row.id, n]));
    const places = nativeIds.map(id => (position.has(id) ? position.get(id) : -1));
    const unknown = places.filter(p => p < 0).length;
    let ordered = unknown === 0;
    for (let n = 1; n < places.length && ordered; n++) if (places[n] <= places[n - 1]) ordered = false;
    const k = nativeIds.length;
    const top = new Set(ranked.slice(0, k).map(row => row.id));
    const shared = nativeIds.filter(id => top.has(id)).length;
    const missed = ranked.slice(0, k).filter(row => !nativeIds.includes(row.id)).map(row => ({ id: row.id, distance: row.distance }));
    return { ordered, overlap: k ? shared / k : 1, unknown, missed, deepest: Math.max(-1, ...places) + 1 };
}

async function compareLibrary(kb, directory, queries, scope) {
    await kb.initialize();
    // 副本刚打开时后台会先扫一遍日记文件，这期间的观测会报“数据库在请求中变了”；等它停下来，个别撞上的再重试。
    await new Promise(resolve => setTimeout(resolve, Number(argument('settle', '25000'))));
    const native = [];
    for (const q of queries) {
        const text = String(q.text || '');
        let item = null;
        for (let attempt = 0; attempt < 4 && !item; attempt++) {
            let prepared = null;
            try {
                // 与 executeNativeRiverQuery 取 Tag 观测时的调用相同（KnowledgeBaseManager.js）。
                prepared = await kb.prepareUnifiedMemoObservation({ text, vector: q.vector },
                    { diaryNames: scope, topK: 5, candidateK: 30, coreTags: [], enabled: true, tagRoutingMode: 'warped_ags', queryText: text, vector: q.vector });
                const routing = prepared?.sourceObservationResult?.diagnostics?.nativePipeline?.tagRouting;
                const first = (routing?.attempts || []).find(a => a.level === 0);
                item = { n: q.n, used: routing?.used || null, fallbackReason: routing?.fallbackReason || null,
                    radius: first?.radius ?? null, ids: first?.ids || [], levels: (routing?.attempts || []).length };
            } catch (error) {
                const message = `${error.code || ''} ${error.message}`.trim().slice(0, 200);
                if (!/STALE|database changed/i.test(message) || attempt === 3) item = { n: q.n, error: true };
                else await new Promise(resolve => setTimeout(resolve, 3000));
            } finally {
                if (prepared) { try { kb.releaseMemoObservation?.(prepared); } catch { /* 释放失败不影响对照 */ } }
            }
        }
        native.push(item);
    }

    // Chunk 场：原生的纯向量检索直接给出每条的分数（负的双曲距离），可以逐条比数值。
    const { openReadOnly } = require('../lib/library');
    const diaryDb = openReadOnly(path.join(directory, 'knowledge_base.sqlite'));
    const diaries = diaryDb.all('SELECT DISTINCT diary_name AS name FROM files').map(row => row.name).filter(Boolean);
    diaryDb.close();
    const nativeChunks = [];
    for (const q of queries) {
        try {
            const hits = await kb.searchKnn(diaries, q.vector, 10) || [];
            // warpedScore 是负的双曲距离。只比较原生明确返回双曲分数的结果。
            const scored = hits.filter(hit => Number.isFinite(hit.warpedScore));
            nativeChunks.push({ n: q.n, hits: scored.map(hit => ({ id: Number(hit.chunkId ?? hit.id), score: hit.warpedScore })) });
        } catch {
            nativeChunks.push({ n: q.n, error: true });
        }
    }

    const atlas = createAtlas({
        directory, exactMegabytes: parseExactMegabytes(argument('exact-mb')),
        ...(argument('refine') ? { refine: Number(argument('refine')) } : {}),
        ...(argument('refine-cosine') ? { refineCosine: Number(argument('refine-cosine')) } : {}),
    });
    const field = atlas.fieldOf('tag');
    // 反向对照用的打乱半径（固定种子）。
    let seed = 20261118;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const shuffled = Float32Array.from(field.index.radius);
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }

    const rows = [];
    for (const item of native) {
        if (item.error || item.used !== 'warped_ags' || item.radius == null || !item.ids.length) {
            rows.push({ n: item.n, skipped: item.error ? 1 : 2 });
            continue;
        }
        const vector = Float32Array.from(queries.find(q => q.n === item.n).vector);
        const real = compare(item.ids, atlas.rankVector('tag', vector, item.radius));
        const control = compare(item.ids, atlas.rankVector('tag', vector, item.radius, { radiusOverride: shuffled }));
        rows.push({ n: item.n, k: item.ids.length, radius: item.radius, levels: item.levels, ...real, controlOrdered: control.ordered, controlOverlap: control.overlap });
    }

    // Chunk 场的对照：同一个向量、按上游规则算出的查询半径；原生分数应当等于负的本工具距离。
    const chunkRows = [];
    let chunkField = null;
    try { chunkField = atlas.fieldOf('chunk'); } catch { chunkRows.push({ skipped: 2 }); }
    if (chunkField) {
        for (const item of nativeChunks) {
            if (item.error || !item.hits.length) { chunkRows.push({ n: item.n, skipped: item.error ? 1 : 2 }); continue; }
            const vector = Float32Array.from(queries.find(q => q.n === item.n).vector);
            const radius = atlas.chunkQueryRadius(chunkField, vector);
            const ranked = atlas.rankVector('chunk', vector, radius);
            const mine = new Map(ranked.map(row => [row.id, row.distance]));
            const known = item.hits.filter(hit => mine.has(hit.id));
            const difference = known.length ? Math.max(...known.map(hit => Math.abs(-hit.score - mine.get(hit.id)))) : null;
            const real = compare(known.map(hit => hit.id), ranked);
            chunkRows.push({ n: item.n, k: item.hits.length, radius, known: known.length, difference, ordered: real.ordered, overlap: real.overlap });
        }
    }
    atlas.close();

    const done = rows.filter(r => !r.skipped);
    const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
    const summary = {
        nodes: field.count, distanceCheck: { ok: field.check.ok, compared: field.check.compared, identical: field.check.identical },
        queries: rows.length, compared: done.length, skipped: rows.length - done.length,
        ordered: done.filter(r => r.ordered).length,
        meanOverlap: +mean(done.map(r => r.overlap)).toFixed(4),
        minOverlap: done.length ? +Math.min(...done.map(r => r.overlap)).toFixed(4) : null,
        missedTotal: done.reduce((n, r) => n + r.missed.length, 0),
        unknownIds: done.reduce((n, r) => n + r.unknown, 0),
        controlOrdered: done.filter(r => r.controlOrdered).length,
        controlMeanOverlap: +mean(done.map(r => r.controlOverlap)).toFixed(4),
    };
    summary.pass = done.length > 0 && summary.ordered === done.length && summary.meanOverlap >= 0.95 && summary.controlOrdered < done.length / 2;
    const chunkDone = chunkRows.filter(r => !r.skipped);
    summary.chunk = {
        nodes: chunkField ? chunkField.count : 0, compared: chunkDone.length, skipped: chunkRows.length - chunkDone.length,
        hits: chunkDone.reduce((n, r) => n + r.k, 0), knownHits: chunkDone.reduce((n, r) => n + r.known, 0),
        // 原生分数与负的本工具距离之差（绝对值）的最大值；判定线 1e-6。
        maxDifference: chunkDone.length ? Math.max(...chunkDone.map(r => r.difference ?? 0)) : null,
        ordered: chunkDone.filter(r => r.ordered).length,
        meanOverlap: +mean(chunkDone.map(r => r.overlap)).toFixed(4),
    };
    summary.chunk.pass = summary.chunk.knownHits > 0 && summary.chunk.knownHits === summary.chunk.hits
        && summary.chunk.maxDifference < 1e-6 && summary.chunk.ordered === chunkDone.length;
    return { summary, rows, chunkRows };
}

async function main() {
    if (process.send) {
        const { queries, scopes } = JSON.parse(fs.readFileSync(queriesFile, 'utf8'));
        if (!Array.isArray(queries) || queries.length === 0
            || queries.some(query => !Number.isSafeInteger(query?.n) || !Array.isArray(query.vector) || !query.vector.length)
            || new Set(queries.map(query => query.n)).size !== queries.length) {
            throw new Error('查询编号或向量无效。');
        }
        const directory = prepareRuntime(queries);
        const scope = Array.isArray(scopes) && scopes.length ? scopes[scopes.length - 1] : [];
        const kb = require(path.join(path.resolve(toolbox), 'KnowledgeBaseManager.js'));
        let report;
        try {
            report = await compareLibrary(kb, directory, queries, scope);
        } finally {
            // 收尾时写检查点可能因为环境里的嵌入模型名与库里记的不一致而失败；对照已经做完，不让它把结果丢掉。
            try { await kb.shutdown(); } catch (error) { console.error(error); }
        }
        process.send(report, error => process.exit(error ? 3 : 0));
        return;
    }

    // 后端和原生模块的日志可能含私有内容。丢弃子进程日志，只通过 IPC 取数值报告。
    const report = await new Promise((resolve, reject) => {
        const output = process.argv.includes('--verbose') ? 'inherit' : 'ignore';
        const child = fork(__filename, process.argv.slice(2), { stdio: ['ignore', output, output, 'ipc'] });
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('原生核对未返回结果。')));
    });
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
    const { summary } = report;
    const { chunk } = summary;
    console.log(JSON.stringify([summary.nodes, summary.distanceCheck.identical ?? 0, summary.compared,
        summary.ordered, summary.meanOverlap, summary.controlOrdered, Number(summary.pass)]));
    console.log(JSON.stringify([chunk.nodes, chunk.compared, chunk.hits, chunk.knownHits,
        chunk.maxDifference ?? -1, chunk.ordered, Number(chunk.pass)]));
    process.exitCode = summary.pass && chunk.pass ? 0 : 1;
}

main().catch(error => {
    if (process.argv.includes('--verbose')) console.error(error);
    console.error('[-90,1]');
    process.exit(3);
});

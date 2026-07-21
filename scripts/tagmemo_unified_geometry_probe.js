'use strict';

/**
 * TagMemo 统一几何构型离线探针
 *
 * 目标：
 * 1. 从现有 SQLite 事实层重建 V9.1 风格有向传播核；
 * 2. 比较有限跳软非回溯脉冲场、节点 Resolvent、边状态非回溯 Resolvent；
 * 3. 检验场诱导软域与候选 Tag 曲线几何是否给出一致读出；
 * 4. 使用拓扑-only 与随机场消融，避免仅凭“都用了同一张图”得出循环结论。
 *
 * 本脚本只以 readonly + query_only 打开数据库，不初始化 KnowledgeBaseManager，
 * 不写 SQLite、WAL、配置或派生资产。
 *
 * 用法：
 *   node scripts/tagmemo_unified_geometry_probe.js
 *   node scripts/tagmemo_unified_geometry_probe.js --seeds "TagA,TagB" --probes 12
 *   node scripts/tagmemo_unified_geometry_probe.js --db /data/VectorStore/knowledge_base.sqlite --json report.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = process.env.KNOWLEDGEBASE_STORE_PATH
    ? path.join(process.env.KNOWLEDGEBASE_STORE_PATH, 'knowledge_base.sqlite')
    : path.join(ROOT, 'VectorStore', 'knowledge_base.sqlite');

function parseArgs(argv) {
    const out = {
        db: DEFAULT_DB,
        config: path.join(ROOT, 'rag_params.json'),
        json: null,
        md: null,
        seeds: [],
        probes: 12,
        maxFiles: 20000,
        maxNodes: 6000,
        maxTagsPerFile: 100,
        maxNeighbors: 20,
        maxCurveFiles: 1500,
        hops: 4,
        resolventSteps: 80,
        tolerance: 1e-9,
        domainMass: 0.80,
        alphaScales: [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.55, 0.70, 0.85, 1.00],
        hopScales: [1, 2, 4],
        randomizations: 100,
        seed: 7331
    };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--help' || key === '-h') out.help = true;
        else if (key === '--db' && value) { out.db = path.resolve(value); i++; }
        else if (key === '--config' && value) { out.config = path.resolve(value); i++; }
        else if (key === '--json' && value) { out.json = path.resolve(value); i++; }
        else if (key === '--md' && value) { out.md = path.resolve(value); i++; }
        else if (key === '--seeds' && value) {
            out.seeds = value.split(',').map(item => item.trim()).filter(Boolean);
            i++;
        } else if (key === '--probes' && value) { out.probes = positiveInt(value, out.probes); i++; }
        else if (key === '--max-files' && value) { out.maxFiles = positiveInt(value, out.maxFiles); i++; }
        else if (key === '--max-nodes' && value) { out.maxNodes = positiveInt(value, out.maxNodes); i++; }
        else if (key === '--max-neighbors' && value) { out.maxNeighbors = positiveInt(value, out.maxNeighbors); i++; }
        else if (key === '--curve-files' && value) { out.maxCurveFiles = positiveInt(value, out.maxCurveFiles); i++; }
        else if (key === '--steps' && value) { out.resolventSteps = positiveInt(value, out.resolventSteps); i++; }
        else if (key === '--tolerance' && value) { out.tolerance = positiveNumber(value, out.tolerance); i++; }
        else if (key === '--domain-mass' && value) {
            out.domainMass = clamp(positiveNumber(value, out.domainMass), 0.5, 0.99);
            i++;
        } else if (key === '--alpha-scales' && value) {
            out.alphaScales = parseNumberList(value, out.alphaScales)
                .map(item => clamp(item, 0.01, 1));
            i++;
        } else if (key === '--hop-scales' && value) {
            out.hopScales = [...new Set(
                parseNumberList(value, out.hopScales)
                    .map(item => Math.max(1, Math.floor(item)))
            )].sort((a, b) => a - b);
            i++;
        } else if (key === '--randomizations' && value) {
            out.randomizations = positiveInt(value, out.randomizations);
            i++;
        } else if (key === '--random-seed' && value) { out.seed = positiveInt(value, out.seed); i++; }
        else if (key.startsWith('-')) throw new Error(`未知参数: ${key}`);
    }
    return out;
}

function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumberList(value, fallback) {
    const parsed = String(value)
        .split(',')
        .map(item => Number(item.trim()))
        .filter(Number.isFinite);
    return parsed.length ? parsed : [...fallback];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function printHelp() {
    console.log(`
TagMemo 统一几何构型离线探针

参数:
  --db PATH             SQLite 路径
  --config PATH         rag_params.json 路径
  --seeds A,B,C         指定单 Tag 查询种子；缺省时自动分层抽样
  --probes N            自动探针数，默认 12
  --max-files N         构图最多读取文件数，默认 20000
  --max-nodes N         按连接质量保留节点数，默认 6000
  --max-neighbors N     每个节点保留出边数，默认 20
  --curve-files N       几何读出最多文件数，默认 1500
  --steps N             Resolvent 最大迭代次数，默认 80
  --tolerance X         固定点收敛阈值，默认 1e-9
  --domain-mass X       软域累计场质量，默认 0.80
  --alpha-scales LIST   Resolvent 尺度列表，默认 0.05 至 1.00 的低尺度加密网格
  --hop-scales LIST     有限阶场跳数列表，默认 1,2,4
  --randomizations N    每查询随机场消融次数，默认 100
  --random-seed N       可复现随机种子
  --json PATH           写出 JSON 原始报告
  --md PATH             写出可直接分享的 Markdown 报告
`);
}

function loadConfig(configPath) {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const kb = raw.KnowledgeBaseManager || {};
    return {
        v9: kb.v9 || {},
        spike: kb.spikeRouting || {},
        ordered: kb.orderedCooccurrence || {}
    };
}

function openReadonly(dbPath) {
    if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    db.pragma('foreign_keys = ON');
    return db;
}

function assertSchema(db) {
    const required = ['files', 'chunks', 'tags', 'file_tags'];
    const existing = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    );
    const missing = required.filter(name => !existing.has(name));
    if (missing.length) throw new Error(`数据库缺少事实表: ${missing.join(', ')}`);
    return existing;
}

function loadFacts(db, options, tables) {
    const tagRows = db.prepare(
        'SELECT id, name FROM tags WHERE vector IS NOT NULL ORDER BY id'
    ).all();
    const tagNames = new Map(tagRows.map(row => [Number(row.id), row.name]));

    const residuals = new Map();
    if (tables.has('tag_intrinsic_residuals')) {
        const columns = new Set(
            db.prepare('PRAGMA table_info(tag_intrinsic_residuals)').all().map(row => row.name)
        );
        const valueColumn = columns.has('v9_anchor_gain') ? 'v9_anchor_gain' : 'residual_energy';
        for (const row of db.prepare(
            `SELECT tag_id, ${valueColumn} AS gain FROM tag_intrinsic_residuals`
        ).all()) {
            if (Number.isFinite(Number(row.gain))) {
                residuals.set(Number(row.tag_id), clamp(Number(row.gain), 0.5, 2));
            }
        }
    }

    const pairSimilarity = new Map();
    let modelSig = null;
    if (tables.has('tag_pair_similarity')) {
        modelSig = db.prepare(
            'SELECT model_sig, COUNT(*) AS c FROM tag_pair_similarity GROUP BY model_sig ORDER BY c DESC LIMIT 1'
        ).get()?.model_sig || null;
        if (modelSig) {
            for (const row of db.prepare(
                'SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?'
            ).iterate(modelSig)) {
                pairSimilarity.set(`${row.tag_a}:${row.tag_b}`, Number(row.similarity));
            }
        }
    }

    const selectedFiles = db.prepare(
        `SELECT file_id
         FROM file_tags
         GROUP BY file_id
         HAVING COUNT(*) BETWEEN 2 AND ?
         ORDER BY file_id DESC
         LIMIT ?`
    ).all(options.maxTagsPerFile, options.maxFiles).map(row => Number(row.file_id));
    if (!selectedFiles.length) throw new Error('没有可用于构图的 file_tags 数据');

    const fileSet = new Set(selectedFiles);
    const chains = new Map();
    for (const row of db.prepare(
        'SELECT file_id, tag_id, position FROM file_tags ORDER BY file_id, position, tag_id'
    ).iterate()) {
        const fileId = Number(row.file_id);
        if (!fileSet.has(fileId)) continue;
        if (!chains.has(fileId)) chains.set(fileId, []);
        chains.get(fileId).push({
            id: Number(row.tag_id),
            position: Math.max(0, Number(row.position) || 0)
        });
    }

    return { tagNames, residuals, pairSimilarity, modelSig, chains };
}

function pairKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function semanticGain(sim, cfg) {
    const enabled = cfg.semanticGainEnabled === true || Number(cfg.semanticGainEnabled) === 1;
    if (!enabled || !Number.isFinite(sim)) return 1;
    if (sim < 0.15) return 0.4 + sim;
    const peak = Number(cfg.semanticGainPeak ?? 0.65);
    const sigma = Math.max(0.02, Number(cfg.semanticGainSigma ?? 0.25));
    return 0.5 + 0.8 * Math.exp(-((sim - peak) ** 2) / (2 * sigma * sigma));
}

function buildFactMatrix(facts, config) {
    const matrix = new Map();
    const ordered = config.ordered;
    const reverseGain = clamp(
        Number(ordered.reverseGain ?? 0.42),
        Number(ordered.minReverseGain ?? 0.25),
        Number(ordered.maxReverseGain ?? 0.70)
    );
    const inversionGuard = clamp(Number(ordered.reverseInversionGuard ?? 0.95), 0, 1);
    const distanceDecay = Math.max(0, Number(ordered.distanceDecay ?? 0));
    const anchorBoost = ordered.reverseAnchorBoost === true
        || Number(ordered.reverseAnchorBoost) >= 1;
    const anchorMax = Math.max(1, Number(ordered.reverseAnchorMax ?? 1.5));
    const lowFallback = Number(ordered.semanticGainLowSimFallback ?? 0.1);

    const add = (from, to, weight) => {
        if (!(weight > 0)) return;
        if (!matrix.has(from)) matrix.set(from, new Map());
        const row = matrix.get(from);
        row.set(to, (row.get(to) || 0) + weight);
    };

    for (const chain of facts.chains.values()) {
        const n = chain.length;
        const orderedChain = chain.some(item => item.position > 0);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = chain[i];
                const b = chain[j];
                if (a.id === b.id) continue;
                const sim = facts.pairSimilarity.get(pairKey(a.id, b.id)) ?? lowFallback;
                const sem = semanticGain(sim, ordered);
                if (!orderedChain) {
                    const weight = 0.49 * sem;
                    add(a.id, b.id, weight);
                    add(b.id, a.id, weight);
                    continue;
                }
                const phiA = 0.9 - 0.4 * Math.max(0, a.position - 1) / Math.max(1, n - 1);
                const phiB = 0.9 - 0.4 * Math.max(0, b.position - 1) / Math.max(1, n - 1);
                const delta = Math.max(1, b.position - a.position);
                const base = phiA * phiB * Math.exp(-distanceDecay * (delta - 1)) * sem;
                const forward = base * Number(ordered.forwardGain ?? 1);
                let reverse = reverseGain;
                if (anchorBoost) reverse *= Math.min(anchorMax, facts.residuals.get(a.id) ?? 1);
                reverse = clamp(
                    reverse,
                    Number(ordered.minReverseGain ?? 0.25),
                    Number(ordered.maxReverseGain ?? 0.70)
                );
                add(a.id, b.id, forward);
                add(b.id, a.id, Math.min(base * reverse, forward * inversionGuard));
            }
        }
    }
    return matrix;
}

function retainGraph(matrix, facts, options) {
    const mass = new Map();
    for (const [source, edges] of matrix) {
        let out = 0;
        for (const [target, weight] of edges) {
            out += weight;
            mass.set(target, (mass.get(target) || 0) + weight);
        }
        mass.set(source, (mass.get(source) || 0) + out);
    }
    const retained = new Set(
        [...mass.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, options.maxNodes)
            .map(item => item[0])
    );
    const graph = new Map();
    for (const [source, edges] of matrix) {
        if (!retained.has(source)) continue;
        const row = [...edges.entries()]
            .filter(([target]) => retained.has(target))
            .sort((a, b) => b[1] - a[1])
            .slice(0, options.maxNeighbors);
        if (row.length) graph.set(source, new Map(row));
    }
    const chains = new Map();
    for (const [fileId, chain] of facts.chains) {
        const filtered = chain.filter(item => retained.has(item.id));
        if (filtered.length >= 2) chains.set(fileId, filtered);
        if (chains.size >= options.maxCurveFiles) break;
    }
    return { graph, retained, chains, mass };
}

function buildKernel(graph, residuals, v9) {
    const outboundMass = clamp(Number(v9.outboundMass ?? 0.95), 0.01, 1);
    const compression = Math.max(0.01, Number(v9.evidenceCompression ?? 1));
    const wormholeGain = Math.max(1, Number(v9.wormholeGain ?? 1.35));
    const tensionThreshold = Math.max(0, Number(v9.tensionThreshold ?? 1));
    const hubExponent = clamp(Number(v9.hubPenaltyExponent ?? 0.3), 0, 1);
    const hubFloor = clamp(Number(v9.hubPenaltyFloor ?? 0.55), 0.05, 1);
    const hubCeiling = clamp(Number(v9.hubPenaltyCeiling ?? 1.8), 1, 4);
    const rawRows = new Map();
    const inflow = new Map();

    for (const [source, edges] of graph) {
        const row = [];
        for (const [target, weight] of edges) {
            const evidence = Math.log1p(Math.max(0, weight) * compression);
            const wormhole = evidence * (residuals.get(target) ?? 1) >= tensionThreshold;
            const conductance = evidence * (wormhole ? wormholeGain : 1);
            if (!(conductance > 0)) continue;
            row.push([target, conductance, wormhole]);
            inflow.set(target, (inflow.get(target) || 0) + conductance);
        }
        if (row.length) rawRows.set(source, row);
    }

    const values = [...inflow.values()].filter(value => value > 0).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)] || 1;
    const kernel = new Map();
    const wormholes = new Set();
    for (const [source, row] of rawRows) {
        const adjusted = row.map(([target, value, wormhole]) => {
            const relative = (inflow.get(target) || 0) / (median * 1.1);
            const penalty = clamp(Math.pow(Math.max(1e-9, relative), -hubExponent), hubFloor, hubCeiling);
            return [target, value * penalty, wormhole];
        });
        const sum = adjusted.reduce((total, item) => total + item[1], 0);
        if (!(sum > 0)) continue;
        const normalized = new Map();
        for (const [target, value, wormhole] of adjusted) {
            normalized.set(target, outboundMass * value / sum);
            if (wormhole) wormholes.add(`${source}:${target}`);
        }
        kernel.set(source, normalized);
    }
    return { kernel, wormholes, inflow };
}

function buildTransport(kernelData, spikeConfig) {
    const baseDecay = clamp(Number(spikeConfig.baseDecay ?? 0.25), 0, 1);
    const wormholeDecay = clamp(Number(spikeConfig.wormholeDecay ?? 0.70), 0, 1);
    const transport = new Map();
    let maxRowMass = 0;
    for (const [source, edges] of kernelData.kernel) {
        const row = new Map();
        let rowMass = 0;
        for (const [target, conductance] of edges) {
            const decay = kernelData.wormholes.has(`${source}:${target}`)
                ? wormholeDecay
                : baseDecay;
            const weight = conductance * decay;
            if (weight > 0) {
                row.set(target, weight);
                rowMass += weight;
            }
        }
        if (row.size) transport.set(source, row);
        maxRowMass = Math.max(maxRowMass, rowMass);
    }
    return { transport, maxRowMass };
}

function addTo(map, key, value) {
    map.set(key, (map.get(key) || 0) + value);
}

function normalizeField(field) {
    let sum = 0;
    for (const value of field.values()) sum += Math.max(0, value);
    const out = new Map();
    if (!(sum > 0)) return out;
    for (const [id, value] of field) {
        if (value > 0) out.set(id, value / sum);
    }
    return out;
}

function finiteSpikeField(seedId, transport, config, hops) {
    const threshold = Math.max(0, Number(config.firingThreshold ?? 0.10));
    const returnFactor = clamp(Number(config.v91ReturnFlowFactor ?? 0.15), 0, 1);
    const gamma = clamp(Number(config.v91FirGamma ?? 0.6), 0.05, 0.95);
    const fir = Array.from({ length: hops + 1 }, (_, hop) => gamma ** hop);
    const firSum = fir.reduce((a, b) => a + b, 0);
    for (let i = 0; i < fir.length; i++) fir[i] /= firSum;

    let states = new Map([[`seed:${seedId}`, {
        previous: null, node: seedId, energy: 1
    }]]);
    const field = new Map([[seedId, fir[0]]]);
    for (let hop = 0; hop < hops; hop++) {
        const next = new Map();
        for (const state of states.values()) {
            if (state.energy < threshold) continue;
            const row = transport.get(state.node);
            if (!row) continue;
            for (const [target, weight] of row) {
                const factor = state.previous === target ? returnFactor : 1;
                const energy = state.energy * weight * factor;
                if (energy < 0.01) continue;
                const key = `${state.node}:${target}`;
                const existing = next.get(key);
                if (existing) existing.energy += energy;
                else next.set(key, { previous: state.node, node: target, energy });
            }
        }
        for (const state of next.values()) addTo(field, state.node, state.energy * fir[hop + 1]);
        states = next;
        if (!states.size) break;
    }
    return normalizeField(field);
}

function nodeResolvent(seedId, transport, options, alpha = 1) {
    const scale = clamp(alpha, 0.01, 1);
    // 归一化后的场形状不受统一源项系数影响，因此固定源质量为 1；
    // alpha 只控制每次输运的有效扩散尺度。
    const source = new Map([[seedId, 1]]);
    let field = new Map(source);
    let residual = Infinity;
    let iterations = 0;
    for (; iterations < options.resolventSteps; iterations++) {
        const next = new Map(source);
        for (const [node, energy] of field) {
            const row = transport.get(node);
            if (!row) continue;
            for (const [target, weight] of row) {
                addTo(next, target, energy * weight * scale);
            }
        }
        residual = l1Distance(field, next);
        field = next;
        if (residual <= options.tolerance) break;
    }
    return {
        field: normalizeField(field),
        residual,
        iterations: iterations + 1,
        alpha: scale
    };
}

function edgeResolvent(seedId, transport, options, returnFactor) {
    const sourceKey = `seed:${seedId}`;
    const source = new Map([[sourceKey, {
        previous: null, node: seedId, energy: 1
    }]]);
    let states = new Map(source);
    let residual = Infinity;
    let iterations = 0;
    for (; iterations < options.resolventSteps; iterations++) {
        const next = new Map(source);
        for (const state of states.values()) {
            const row = transport.get(state.node);
            if (!row) continue;
            for (const [target, weight] of row) {
                const factor = state.previous === target ? returnFactor : 1;
                const energy = state.energy * weight * factor;
                if (!(energy > 0)) continue;
                const key = `${state.node}:${target}`;
                const existing = next.get(key);
                if (existing) existing.energy += energy;
                else next.set(key, { previous: state.node, node: target, energy });
            }
        }
        residual = stateL1Distance(states, next);
        states = next;
        if (residual <= options.tolerance) break;
    }
    const field = new Map();
    for (const state of states.values()) addTo(field, state.node, state.energy);
    return {
        field: normalizeField(field),
        residual,
        iterations: iterations + 1,
        stateCount: states.size
    };
}

function l1Distance(left, right) {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let total = 0;
    for (const key of keys) total += Math.abs((left.get(key) || 0) - (right.get(key) || 0));
    return total;
}

function stateL1Distance(left, right) {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let total = 0;
    for (const key of keys) {
        total += Math.abs((left.get(key)?.energy || 0) - (right.get(key)?.energy || 0));
    }
    return total;
}

function cosineMaps(left, right) {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let dot = 0;
    let a2 = 0;
    let b2 = 0;
    for (const key of keys) {
        const a = left.get(key) || 0;
        const b = right.get(key) || 0;
        dot += a * b;
        a2 += a * a;
        b2 += b * b;
    }
    return a2 > 0 && b2 > 0 ? dot / Math.sqrt(a2 * b2) : 0;
}

function averageTieRanks(field, ids) {
    const sorted = [...ids]
        .map(id => [id, Number(field.get(id)) || 0])
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const ranks = new Map();
    let start = 0;
    while (start < sorted.length) {
        let end = start + 1;
        while (end < sorted.length && sorted[end][1] === sorted[start][1]) end++;
        const averageRank = ((start + 1) + end) / 2;
        for (let i = start; i < end; i++) ranks.set(sorted[i][0], averageRank);
        start = end;
    }
    return ranks;
}

function spearmanMaps(left, right, limit = 200, explicitIds = null) {
    const ids = explicitIds
        ? new Set(explicitIds)
        : new Set([
            ...[...left.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(item => item[0]),
            ...[...right.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(item => item[0])
        ]);
    if (ids.size < 3) return 0;
    const leftRank = averageTieRanks(left, ids);
    const rightRank = averageTieRanks(right, ids);
    return pearson(
        [...ids].map(id => leftRank.get(id)),
        [...ids].map(id => rightRank.get(id))
    );
}

function safeSpearmanMaps(left, right, limit = 200, explicitIds = null) {
    const ids = explicitIds
        ? new Set(explicitIds)
        : new Set([...left.keys(), ...right.keys()]);
    if (ids.size < 3) return null;
    return spearmanMaps(left, right, limit, ids);
}

function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return 0;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let covariance = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        covariance += dx * dy;
        vx += dx * dx;
        vy += dy * dy;
    }
    return vx > 0 && vy > 0 ? covariance / Math.sqrt(vx * vy) : 0;
}

function withoutSeeds(field, seedIds) {
    const filtered = new Map();
    for (const [id, value] of field) {
        if (!seedIds.has(id) && value > 0) filtered.set(id, value);
    }
    return normalizeField(filtered);
}

function massDomain(field, massTarget) {
    const domain = new Set();
    let mass = 0;
    for (const [id, value] of [...normalizeField(field).entries()].sort((a, b) => b[1] - a[1])) {
        domain.add(id);
        mass += value;
        if (mass >= massTarget) break;
    }
    return domain;
}

function topKDomain(field, k) {
    return new Set(
        [...field.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, k)
            .map(item => item[0])
    );
}

function jaccard(left, right) {
    const union = new Set([...left, ...right]);
    if (!union.size) return 1;
    let intersection = 0;
    for (const value of left) if (right.has(value)) intersection++;
    return intersection / union.size;
}

function weightedJaccard(left, right, excludedIds = new Set()) {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let intersection = 0;
    let union = 0;
    for (const id of keys) {
        if (excludedIds.has(id)) continue;
        const a = Math.max(0, Number(left.get(id)) || 0);
        const b = Math.max(0, Number(right.get(id)) || 0);
        intersection += Math.min(a, b);
        union += Math.max(a, b);
    }
    return union > 0 ? intersection / union : 1;
}

function setOverlap(left, right) {
    let intersection = 0;
    for (const id of left) if (right.has(id)) intersection++;
    return {
        leftSize: left.size,
        rightSize: right.size,
        intersection,
        precision: right.size ? intersection / right.size : 1,
        recall: left.size ? intersection / left.size : 1,
        jaccard: jaccard(left, right)
    };
}

function fieldMassOnSet(field, ids) {
    let mass = 0;
    for (const id of ids) mass += Math.max(0, Number(field.get(id)) || 0);
    return mass;
}

function effectiveSupportSize(field, method = 'shannon') {
    const normalized = normalizeField(field);
    if (!normalized.size) return 0;
    if (method === 'participation') {
        let squared = 0;
        for (const value of normalized.values()) squared += value * value;
        return squared > 0 ? 1 / squared : 0;
    }
    let entropy = 0;
    for (const value of normalized.values()) {
        if (value > 0) entropy -= value * Math.log(value);
    }
    return Math.exp(entropy);
}

function spectralGapDomain(field, maxNodes = 200) {
    const sorted = [...normalizeField(field).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxNodes);
    if (sorted.length <= 1) return new Set(sorted.map(item => item[0]));
    let bestIndex = 1;
    let bestRatio = 1;
    for (let i = 0; i + 1 < sorted.length; i++) {
        const ratio = sorted[i][1] / Math.max(1e-15, sorted[i + 1][1]);
        if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = i + 1;
        }
    }
    return new Set(sorted.slice(0, bestIndex).map(item => item[0]));
}

function adaptiveDomains(field) {
    const shannonSize = Math.max(1, Math.round(effectiveSupportSize(field, 'shannon')));
    const participationSize = Math.max(1, Math.round(effectiveSupportSize(field, 'participation')));
    return {
        shannon: topKDomain(field, shannonSize),
        participation: topKDomain(field, participationSize),
        spectralGap: spectralGapDomain(field),
        mass80: massDomain(field, 0.80),
        mass90: massDomain(field, 0.90)
    };
}

function compareAdaptiveDomains(reference, candidate) {
    const left = adaptiveDomains(reference);
    const right = adaptiveDomains(candidate);
    const result = {};
    for (const key of Object.keys(left)) {
        result[key] = setOverlap(left[key], right[key]);
    }
    return result;
}

function strictFieldDiagnostics(reference, candidate, seedIds) {
    const left = withoutSeeds(reference, seedIds);
    const right = withoutSeeds(candidate, seedIds);
    const equalK = Math.min(left.size, right.size, 20);
    const leftTop = topKDomain(left, equalK);
    const rightTop = topKDomain(right, equalK);
    const unionTop = new Set([...leftTop, ...rightTop]);
    const common = new Set([...left.keys()].filter(id => right.has(id)));
    const referenceSupport = new Set(left.keys());
    return {
        referenceSupport: left.size,
        candidateSupport: right.size,
        supportExpansion: left.size ? right.size / left.size : 0,
        seedlessCosine: cosineMaps(left, right),
        seedlessWeightedJaccard: weightedJaccard(left, right),
        commonSupportSpearman: common.size >= 3
            ? spearmanMaps(left, right, 200, common)
            : 0,
        equalTopK: {
            k: equalK,
            ...setOverlap(leftTop, rightTop),
            spearman: unionTop.size >= 3
                ? spearmanMaps(left, right, equalK, unionTop)
                : 0
        },
        candidateMassOnReferenceSupport: fieldMassOnSet(right, referenceSupport),
        candidateTailMass: Math.max(0, 1 - fieldMassOnSet(right, referenceSupport)),
        adaptiveDomains: compareAdaptiveDomains(left, right)
    };
}

function curveScores(chains, field, transport, mode) {
    const scores = new Map();
    const contacted = new Set();
    for (const [fileId, chain] of chains) {
        let potential = 0;
        let continuity = 0;
        let softPathQuality = 0;
        let action = 0;
        let topology = 0;
        let contacts = 0;
        let segments = 0;
        let supportedSegments = 0;
        for (let i = 0; i < chain.length; i++) {
            const u = field.get(chain[i].id) || 0;
            potential += u;
            if (u > 0) contacts++;
            if (i + 1 >= chain.length) continue;
            const v = field.get(chain[i + 1].id) || 0;
            const forward = transport.get(chain[i].id)?.get(chain[i + 1].id) || 0;
            const reverse = transport.get(chain[i + 1].id)?.get(chain[i].id) || 0;
            const conductance = Math.max(forward, reverse);
            const conductanceGain = 0.65 + 0.35 * Math.sqrt(conductance);
            const segmentPotential = Math.sqrt(u * v);
            continuity += segmentPotential * conductanceGain;
            if (u > 0 && v > 0) {
                softPathQuality += segmentPotential * conductanceGain;
                supportedSegments++;
            } else if (u > 0 || v > 0) {
                // 单点接触不是完整连续路径，但应保留受局部导通支持的低权重证据。
                softPathQuality += 0.20 * Math.max(u, v) * conductanceGain;
                supportedSegments++;
            }
            if (u > 0 || v > 0) {
                action += 1 / Math.max(1e-6, segmentPotential + 0.25 * conductance);
            }
            topology += conductance;
            segments++;
        }
        if (contacts > 0) contacted.add(fileId);
        const meanPotential = potential / Math.max(1, chain.length);
        const meanContinuity = continuity / Math.max(1, segments);
        const meanSoftPath = softPathQuality / Math.max(1, supportedSegments);
        const contactCoverage = contacts / Math.max(1, chain.length);
        const meanTopology = topology / Math.max(1, segments);
        let score;
        if (mode === 'topology') score = meanTopology;
        else if (mode === 'action') {
            score = contacts > 0
                ? Math.exp(-action / Math.max(1, segments)) * (1 - Math.exp(-contacts))
                : 0;
        } else if (mode === 'boundedPath') {
            // 软域、长度归一化路径质量：允许单点接触，但完整连续片段权重更高。
            // 所有分量均有界，避免无限稳态长尾触发无界倒数惩罚。
            score = Math.max(0, Math.min(
                1,
                0.35 * meanPotential
                + 0.50 * meanSoftPath
                + 0.15 * contactCoverage
            ));
        } else {
            score = 0.65 * meanPotential + 0.35 * meanContinuity;
        }
        scores.set(fileId, score);
    }
    return { scores, contacted };
}

function shuffledField(field, random) {
    const ids = [...field.keys()];
    const values = [...field.values()];
    for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
    }
    return new Map(ids.map((id, index) => [id, values[index]]));
}

function mulberry32(seed) {
    return function random() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function quantile(values, q) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * q;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values) {
    return quantile(values, 0.5);
}

function medianFinite(values) {
    return median(values.filter(Number.isFinite));
}

function summarizeDistribution(values, observed = null) {
    const finite = values.filter(Number.isFinite);
    const summary = {
        samples: finite.length,
        mean: mean(finite),
        median: median(finite),
        standardDeviation: 0,
        p025: quantile(finite, 0.025),
        p975: quantile(finite, 0.975)
    };
    if (finite.length) {
        summary.standardDeviation = Math.sqrt(
            mean(finite.map(value => (value - summary.mean) ** 2))
        );
    }
    if (Number.isFinite(observed)) {
        summary.observed = observed;
        summary.observedPercentile = finite.length
            ? mean(finite.map(value => observed >= value ? 1 : 0))
            : 0;
        summary.empiricalPUpper = (1 + finite.filter(value => value >= observed).length)
            / (finite.length + 1);
    }
    return summary;
}

function shortHash(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex')
        .slice(0, 16);
}

function chooseSeeds(options, graphData, facts) {
    if (options.seeds.length) {
        const byName = new Map(
            [...facts.tagNames.entries()].map(([id, name]) => [String(name).toLowerCase(), id])
        );
        const resolved = options.seeds.map(name => {
            const id = byName.get(name.toLowerCase());
            if (!id || !graphData.retained.has(id)) {
                throw new Error(`指定种子不在保留图中或无向量: ${name}`);
            }
            return id;
        });
        return [...new Set(resolved)];
    }

    const candidates = [...graphData.retained]
        .filter(id => graphData.graph.has(id))
        .map(id => ({
            id,
            mass: graphData.mass.get(id) || 0,
            residual: facts.residuals.get(id) || 1
        }))
        .sort((a, b) => a.mass - b.mass);
    if (!candidates.length) throw new Error('保留图中没有可传播的种子');

    const selected = [];
    const buckets = Math.min(options.probes, candidates.length);
    for (let i = 0; i < buckets; i++) {
        const start = Math.floor(i * candidates.length / buckets);
        const end = Math.max(start + 1, Math.floor((i + 1) * candidates.length / buckets));
        const bucket = candidates.slice(start, end);
        bucket.sort((a, b) => b.residual - a.residual);
        selected.push(bucket[Math.floor(bucket.length / 3)]?.id || bucket[0].id);
    }
    return [...new Set(selected)].slice(0, options.probes);
}
function retainTrustedField(field, maxNodes = 200, relativeFloor = 1e-4) {
    const sorted = [...field.entries()].sort((a, b) => b[1] - a[1]);
    const maximum = sorted[0]?.[1] || 0;
    return normalizeField(new Map(
        sorted
            .filter(([, value]) => value >= maximum * relativeFloor)
            .slice(0, maxNodes)
    ));
}

function verdict(summary) {
    const dynamicsStrong = summary.convergenceRate >= 0.9
        && summary.medianFieldCosine >= 0.95
        && summary.medianTrustedFieldSpearman >= 0.75;
    const dynamicsPartial = summary.convergenceRate >= 0.9
        && summary.medianFieldCosine >= 0.85
        && summary.medianTrustedFieldSpearman >= 0.55;
    const domainStrong = summary.medianSeedlessWeightedJaccard >= 0.70
        && summary.medianTop10Jaccard >= 0.65;
    const domainPartial = summary.medianSeedlessWeightedJaccard >= 0.45
        && summary.medianTop10Jaccard >= 0.35;
    const geometryStrong = summary.medianRewardGeometrySpearman >= 0.75
        && summary.medianActionGeometrySpearman >= 0.70
        && summary.medianAblationMargin >= 0.15;
    const geometryPartial = summary.medianRewardGeometrySpearman >= 0.50
        && summary.medianActionGeometrySpearman >= 0.45
        && summary.medianAblationMargin >= 0.05;

    let level;
    let text;
    if (dynamicsStrong && domainStrong && geometryStrong) {
        level = 'strong-full-unification-supported';
        text = '强支持完整统一：稳定生成算子同时复现浪潮主体、去源查询域及同泛函曲线几何，并显著优于消融。';
    } else if (dynamicsPartial && domainPartial && geometryPartial) {
        level = 'partial-full-unification-supported';
        text = '支持部分完整统一：动力学、域和曲线几何均呈一致性，但至少一层尚未达到强证据门槛。';
    } else if (dynamicsStrong) {
        level = 'dynamics-unified-geometry-inconclusive';
        text = '强支持动力学统一；域或曲线几何尚未同时通过门槛，因此完整“场自带域”构型仍待验证。';
    } else if (dynamicsPartial) {
        level = 'partial-dynamics-unification';
        text = '部分支持动力学统一，但当前证据不足以确认稳定域与统一曲线几何。';
    } else {
        level = 'unification-not-supported';
        text = '当前数据未能证明统一生成算子稳定复现浪潮主体，因而不支持完整统一。';
    }
    return {
        level,
        text,
        layers: {
            dynamics: dynamicsStrong ? 'strong' : dynamicsPartial ? 'partial' : 'unsupported',
            domain: domainStrong ? 'strong' : domainPartial ? 'partial' : 'unsupported',
            geometry: geometryStrong ? 'strong' : geometryPartial ? 'partial' : 'unsupported'
        }
    };
}

function runProbe(seedId, context) {
    const { options, config, graphData, facts, transportData, random } = context;
    const spike = finiteSpikeField(seedId, transportData.transport, config.spike, options.hops);
    const node = nodeResolvent(seedId, transportData.transport, options);
    const edge = edgeResolvent(
        seedId,
        transportData.transport,
        options,
        clamp(Number(config.spike.v91ReturnFlowFactor ?? 0.15), 0, 1)
    );
    const trustedSpike = retainTrustedField(spike);
    const trustedEdge = retainTrustedField(edge.field);
    const seedIds = new Set([seedId]);
    const seedlessSpike = withoutSeeds(trustedSpike, seedIds);
    const seedlessEdge = withoutSeeds(trustedEdge, seedIds);

    const spikeDomain = massDomain(seedlessSpike, options.domainMass);
    const edgeDomain = massDomain(seedlessEdge, options.domainMass);
    const top5Spike = topKDomain(seedlessSpike, 5);
    const top5Edge = topKDomain(seedlessEdge, 5);
    const top10Spike = topKDomain(seedlessSpike, 10);
    const top10Edge = topKDomain(seedlessEdge, 10);
    const top20Spike = topKDomain(seedlessSpike, 20);
    const top20Edge = topKDomain(seedlessEdge, 20);
    const strictInfinite = strictFieldDiagnostics(trustedSpike, trustedEdge, seedIds);
    const spikeAdaptive = adaptiveDomains(seedlessSpike);

    // 严格二乘二设计：两种场分别进入完全相同的 reward 与 action 泛函。
    const spikeReward = curveScores(graphData.chains, trustedSpike, transportData.transport, 'reward');
    const edgeReward = curveScores(graphData.chains, trustedEdge, transportData.transport, 'reward');
    const spikeAction = curveScores(graphData.chains, trustedSpike, transportData.transport, 'action');
    const edgeAction = curveScores(graphData.chains, trustedEdge, transportData.transport, 'action');
    const spikeBounded = curveScores(
        graphData.chains,
        trustedSpike,
        transportData.transport,
        'boundedPath'
    );
    const edgeBounded = curveScores(
        graphData.chains,
        trustedEdge,
        transportData.transport,
        'boundedPath'
    );
    const topologyCurve = curveScores(
        graphData.chains,
        new Map(),
        transportData.transport,
        'topology'
    );

    // 只在任一真实场确实接触的候选上比较，零接触候选不参与秩统计。
    const trustedCandidates = new Set([
        ...spikeReward.contacted,
        ...edgeReward.contacted
    ]);
    const rewardGeometry = spearmanMaps(
        spikeReward.scores,
        edgeReward.scores,
        300,
        trustedCandidates
    );
    const actionGeometry = spearmanMaps(
        spikeAction.scores,
        edgeAction.scores,
        300,
        trustedCandidates
    );
    const functionalAgreementSpike = spearmanMaps(
        spikeReward.scores,
        spikeAction.scores,
        300,
        trustedCandidates
    );
    const functionalAgreementEdge = spearmanMaps(
        edgeReward.scores,
        edgeAction.scores,
        300,
        trustedCandidates
    );
    const topologyAgreement = spearmanMaps(
        spikeReward.scores,
        topologyCurve.scores,
        300,
        trustedCandidates
    );
    const boundedCandidates = new Set([
        ...spikeBounded.contacted,
        ...edgeBounded.contacted
    ]);
    const boundedPathGeometry = safeSpearmanMaps(
        spikeBounded.scores,
        edgeBounded.scores,
        300,
        boundedCandidates
    );

    const randomAgreements = [];
    for (let index = 0; index < options.randomizations; index++) {
        const randomReward = curveScores(
            graphData.chains,
            shuffledField(trustedEdge, random),
            transportData.transport,
            'reward'
        );
        randomAgreements.push(spearmanMaps(
            spikeReward.scores,
            randomReward.scores,
            300,
            trustedCandidates
        ));
    }
    const randomNull = summarizeDistribution(randomAgreements, rewardGeometry);
    const randomAgreement = randomNull.median;
    const ablationMargin = rewardGeometry - Math.max(topologyAgreement, randomAgreement);

    const alphaScan = options.alphaScales.map(alpha => {
        const scaled = nodeResolvent(seedId, transportData.transport, options, alpha);
        const trusted = retainTrustedField(scaled.field);
        const diagnostics = strictFieldDiagnostics(trustedSpike, trusted, seedIds);
        const seedless = withoutSeeds(trusted, seedIds);
        const scaledReward = curveScores(
            graphData.chains,
            trusted,
            transportData.transport,
            'reward'
        );
        const scaledBounded = curveScores(
            graphData.chains,
            trusted,
            transportData.transport,
            'boundedPath'
        );
        const rewardCandidates = new Set([
            ...spikeReward.contacted,
            ...scaledReward.contacted
        ]);
        const pathCandidates = new Set([
            ...spikeBounded.contacted,
            ...scaledBounded.contacted
        ]);
        return {
            alpha,
            converged: scaled.residual <= options.tolerance,
            residual: scaled.residual,
            iterations: scaled.iterations,
            trustedNodes: trusted.size,
            diagnostics,
            baselineCandidateCount: trustedCandidates.size,
            rewardCandidateCount: rewardCandidates.size,
            boundedPathCandidateCount: pathCandidates.size,
            rewardCandidateCoverage: trustedCandidates.size
                ? rewardCandidates.size / trustedCandidates.size
                : null,
            boundedPathCandidateCoverage: trustedCandidates.size
                ? pathCandidates.size / trustedCandidates.size
                : null,
            rewardGeometrySpearman: safeSpearmanMaps(
                spikeReward.scores,
                scaledReward.scores,
                300,
                rewardCandidates
            ),
            boundedPathGeometrySpearman: safeSpearmanMaps(
                spikeBounded.scores,
                scaledBounded.scores,
                300,
                pathCandidates
            )
        };
    });

    const hopScan = options.hopScales.map(hops => {
        const finite = finiteSpikeField(
            seedId,
            transportData.transport,
            config.spike,
            hops
        );
        const trusted = retainTrustedField(finite);
        return {
            hops,
            trustedNodes: trusted.size,
            diagnosticsVsInfinite: strictFieldDiagnostics(
                trusted,
                trustedEdge,
                seedIds
            )
        };
    });

    return {
        seedId,
        seedName: facts.tagNames.get(seedId) || `#${seedId}`,
        support: {
            spikeNodes: spike.size,
            trustedSpikeNodes: trustedSpike.size,
            nodeResolventNodes: node.field.size,
            edgeResolventNodes: edge.field.size,
            trustedEdgeNodes: trustedEdge.size,
            edgeStateCount: edge.stateCount,
            trustedCurveCandidates: trustedCandidates.size
        },
        convergence: {
            maxTransportRowMass: transportData.maxRowMass,
            nodeResidual: node.residual,
            nodeIterations: node.iterations,
            edgeResidual: edge.residual,
            edgeIterations: edge.iterations,
            converged: edge.residual <= options.tolerance
        },
        field: {
            spikeVsNodeCosine: cosineMaps(spike, node.field),
            spikeVsEdgeCosine: cosineMaps(spike, edge.field),
            trustedSpikeVsEdgeSpearman: spearmanMaps(trustedSpike, trustedEdge),
            spikeVsEdgeWeightedJaccard: weightedJaccard(trustedSpike, trustedEdge),
            nodeVsEdgeSpearman: spearmanMaps(node.field, edge.field),
            strictInfinite
        },
        domain: {
            seedlessSpikeSize: spikeDomain.size,
            seedlessEdgeSize: edgeDomain.size,
            seedlessMassJaccard: jaccard(spikeDomain, edgeDomain),
            seedlessWeightedJaccard: weightedJaccard(seedlessSpike, seedlessEdge),
            top5Jaccard: jaccard(top5Spike, top5Edge),
            top10Jaccard: jaccard(top10Spike, top10Edge),
            top20Jaccard: jaccard(top20Spike, top20Edge)
        },
        geometry: {
            rewardSameFunctionalSpearman: rewardGeometry,
            actionSameFunctionalSpearman: actionGeometry,
            boundedPathCandidateCount: boundedCandidates.size,
            boundedPathSameFunctionalSpearman: boundedPathGeometry,
            rewardVsActionSpikeSpearman: functionalAgreementSpike,
            rewardVsActionEdgeSpearman: functionalAgreementEdge,
            rewardVsTopologySpearman: topologyAgreement,
            rewardVsRandomFieldSpearman: randomAgreement,
            randomNull,
            ablationMargin
        },
        scaleFamily: {
            alphaScan,
            hopScan
        }
    };
}
function summarizeScaleFamily(probes, key, scaleKey) {
    const scales = probes[0]?.scaleFamily?.[key]?.map(item => item[scaleKey]) || [];
    return scales.map(scale => {
        const records = probes.map(probe =>
            probe.scaleFamily[key].find(item => item[scaleKey] === scale)
        ).filter(Boolean);
        const diagnosticsKey = key === 'alphaScan' ? 'diagnostics' : 'diagnosticsVsInfinite';
        return {
            [scaleKey]: scale,
            probes: records.length,
            convergenceRate: key === 'alphaScan'
                ? mean(records.map(item => item.converged ? 1 : 0))
                : undefined,
            medianSeedlessCosine: median(records.map(
                item => item[diagnosticsKey].seedlessCosine
            )),
            medianEqualTopKJaccard: median(records.map(
                item => item[diagnosticsKey].equalTopK.jaccard
            )),
            medianEqualTopKSpearman: median(records.map(
                item => item[diagnosticsKey].equalTopK.spearman
            )),
            medianTailMass: median(records.map(
                item => item[diagnosticsKey].candidateTailMass
            )),
            medianSupportExpansion: median(records.map(
                item => item[diagnosticsKey].supportExpansion
            )),
            medianRewardGeometrySpearman: key === 'alphaScan'
                ? medianFinite(records.map(item => item.rewardGeometrySpearman))
                : undefined,
            medianBoundedPathGeometrySpearman: key === 'alphaScan'
                ? medianFinite(records.map(item => item.boundedPathGeometrySpearman))
                : undefined,
            medianRewardCandidateCoverage: key === 'alphaScan'
                ? medianFinite(records.map(item => item.rewardCandidateCoverage))
                : undefined,
            medianBoundedPathCandidateCoverage: key === 'alphaScan'
                ? medianFinite(records.map(item => item.boundedPathCandidateCoverage))
                : undefined,
            validRewardProbes: key === 'alphaScan'
                ? records.filter(item => Number.isFinite(item.rewardGeometrySpearman)).length
                : undefined,
            validBoundedPathProbes: key === 'alphaScan'
                ? records.filter(item => Number.isFinite(item.boundedPathGeometrySpearman)).length
                : undefined
        };
    });
}

function v3Verdict(summary, scaleSummary) {
    const alphaCandidates = scaleSummary.alphaScan.filter(item =>
        item.convergenceRate >= 0.9
    );
    const bestDynamics = [...alphaCandidates].sort((left, right) =>
        (right.medianSeedlessCosine + right.medianEqualTopKJaccard)
        - (left.medianSeedlessCosine + left.medianEqualTopKJaccard)
    )[0] || null;

    // 防止极小 alpha 通过只覆盖少量候选获得虚高秩相关。
    // 几何尺度必须覆盖至少一半基线候选，且至少 75% 查询具有可定义相关。
    const minimumValidGeometryProbes = Math.ceil(summary.probes * 0.75);
    const geometryCandidates = alphaCandidates.filter(item =>
        item.medianBoundedPathCandidateCoverage >= 0.50
        && item.validBoundedPathProbes >= minimumValidGeometryProbes
    );
    const bestGeometry = [...geometryCandidates].sort((left, right) =>
        right.medianBoundedPathGeometrySpearman
        - left.medianBoundedPathGeometrySpearman
    )[0] || null;

    const stability = summary.convergenceRate >= 0.9 ? 'strong' : 'unsupported';
    const dynamics = bestDynamics
        && bestDynamics.medianSeedlessCosine >= 0.90
        && bestDynamics.medianEqualTopKJaccard >= 0.65
        ? 'strong'
        : bestDynamics
            && bestDynamics.medianSeedlessCosine >= 0.75
            && bestDynamics.medianEqualTopKJaccard >= 0.45
            ? 'partial'
            : 'unsupported';
    const domain = bestDynamics
        && bestDynamics.medianTailMass <= 0.35
        && bestDynamics.medianSupportExpansion <= 3
        ? 'strong'
        : bestDynamics
            && bestDynamics.medianTailMass <= 0.60
            ? 'partial'
            : 'unsupported';
    const geometry = bestGeometry
        && bestGeometry.medianBoundedPathGeometrySpearman >= 0.70
        ? 'strong'
        : bestGeometry
            && bestGeometry.medianBoundedPathGeometrySpearman >= 0.45
            ? 'partial'
            : 'unsupported';

    return {
        level: stability === 'strong' && dynamics === 'strong'
            ? geometry === 'strong'
                ? 'v3-scaled-field-full-unification-supported'
                : 'v3-scaled-dynamics-supported-geometry-inconclusive'
            : dynamics === 'partial'
                ? 'v3-partial-scaled-dynamics'
                : 'v3-unification-not-supported',
        layers: { stability, dynamics, domain, geometry },
        bestDynamicsAlpha: bestDynamics?.alpha ?? null,
        bestGeometryAlpha: bestGeometry?.alpha ?? null,
        bestGeometryCandidateCoverage:
            bestGeometry?.medianBoundedPathCandidateCoverage ?? null,
        geometryCoverageThreshold: 0.50,
        minimumValidGeometryProbes,
        note: 'V3.1 判决将算子稳定、去源动力学、支持域和有界曲线几何分层；几何尺度必须满足候选覆盖率与有效查询数门槛。'
    };
}

function buildReport(options, config, facts, graphData, kernelData, transportData, probes) {
    const summary = {
        probes: probes.length,
        convergenceRate: mean(probes.map(item => item.convergence.converged ? 1 : 0)),
        medianFieldCosine: median(probes.map(item => item.field.spikeVsEdgeCosine)),
        medianTrustedFieldSpearman: median(probes.map(item => item.field.trustedSpikeVsEdgeSpearman)),
        medianFieldWeightedJaccard: median(probes.map(item => item.field.spikeVsEdgeWeightedJaccard)),
        medianNodeVsEdgeSpearman: median(probes.map(item => item.field.nodeVsEdgeSpearman)),
        medianSeedlessMassJaccard: median(probes.map(item => item.domain.seedlessMassJaccard)),
        medianSeedlessWeightedJaccard: median(probes.map(item => item.domain.seedlessWeightedJaccard)),
        medianTop5Jaccard: median(probes.map(item => item.domain.top5Jaccard)),
        medianTop10Jaccard: median(probes.map(item => item.domain.top10Jaccard)),
        medianTop20Jaccard: median(probes.map(item => item.domain.top20Jaccard)),
        medianRewardGeometrySpearman: median(probes.map(item => item.geometry.rewardSameFunctionalSpearman)),
        medianActionGeometrySpearman: median(probes.map(item => item.geometry.actionSameFunctionalSpearman)),
        medianRewardActionSpike: median(probes.map(item => item.geometry.rewardVsActionSpikeSpearman)),
        medianRewardActionEdge: median(probes.map(item => item.geometry.rewardVsActionEdgeSpearman)),
        medianTopologyAgreement: median(probes.map(item => item.geometry.rewardVsTopologySpearman)),
        medianRandomAgreement: median(probes.map(item => item.geometry.rewardVsRandomFieldSpearman)),
        medianAblationMargin: median(probes.map(item => item.geometry.ablationMargin)),
        medianStrictSeedlessCosine: median(probes.map(
            item => item.field.strictInfinite.seedlessCosine
        )),
        medianStrictEqualTopKJaccard: median(probes.map(
            item => item.field.strictInfinite.equalTopK.jaccard
        )),
        medianStrictTailMass: median(probes.map(
            item => item.field.strictInfinite.candidateTailMass
        )),
        medianStrictSupportExpansion: median(probes.map(
            item => item.field.strictInfinite.supportExpansion
        )),
        medianBoundedPathGeometrySpearman: medianFinite(probes.map(
            item => item.geometry.boundedPathSameFunctionalSpearman
        )),
        medianRandomEmpiricalP: median(probes.map(
            item => item.geometry.randomNull.empiricalPUpper
        )),
        p25TrustedFieldSpearman: quantile(probes.map(item => item.field.trustedSpikeVsEdgeSpearman), 0.25),
        p25RewardGeometrySpearman: quantile(probes.map(item => item.geometry.rewardSameFunctionalSpearman), 0.25)
    };
    const scaleSummary = {
        alphaScan: summarizeScaleFamily(probes, 'alphaScan', 'alpha'),
        hopScan: summarizeScaleFamily(probes, 'hopScan', 'hops')
    };
    return {
        schemaVersion: 'tagmemo-unified-geometry-probe-v3.1',
        generatedAt: new Date().toISOString(),
        readonly: true,
        database: options.db,
        config: options.config,
        reproducibility: {
            configHash: shortHash(config),
            probeOptions: {
                probes: options.probes,
                maxFiles: options.maxFiles,
                maxNodes: options.maxNodes,
                maxNeighbors: options.maxNeighbors,
                maxCurveFiles: options.maxCurveFiles,
                hops: options.hops,
                alphaScales: options.alphaScales,
                hopScales: options.hopScales,
                randomizations: options.randomizations,
                randomSeed: options.seed
            }
        },
        dataset: {
            modelSig: facts.modelSig,
            tagsWithVectors: facts.tagNames.size,
            residuals: facts.residuals.size,
            pairSimilarities: facts.pairSimilarity.size,
            sampledFiles: facts.chains.size,
            retainedNodes: graphData.retained.size,
            curveFiles: graphData.chains.size,
            kernelSources: kernelData.kernel.size,
            wormholeEdges: kernelData.wormholes.size,
            maxTransportRowMass: transportData.maxRowMass
        },
        hypothesis: {
            null: '浪潮场、查询域与测地曲线读出需要实质独立的数学构型。',
            alternative: '同一个稳定输运 Resolvent 可生成浪潮主体、去源查询域与同泛函曲线几何。',
            warning: '这是结构一致性与收敛探针，不是带人工相关性标签的检索质量基准。'
        },
        thresholds: {
            dynamicsStrong: { convergenceRate: 0.9, fieldCosine: 0.95, fieldSpearman: 0.75 },
            dynamicsPartial: { convergenceRate: 0.9, fieldCosine: 0.85, fieldSpearman: 0.55 },
            domainStrong: { weightedJaccard: 0.70, top10Jaccard: 0.65 },
            domainPartial: { weightedJaccard: 0.45, top10Jaccard: 0.35 },
            geometryStrong: { rewardSpearman: 0.75, actionSpearman: 0.70, ablationMargin: 0.15 },
            geometryPartial: { rewardSpearman: 0.50, actionSpearman: 0.45, ablationMargin: 0.05 }
        },
        summary,
        scaleSummary,
        legacyVerdict: verdict(summary),
        verdict: v3Verdict(summary, scaleSummary),
        probes
    };
}

function printReport(report) {
    const s = report.summary;
    console.log('\n=== TagMemo 统一几何构型探针 V3 ===');
    console.log(`只读模式:               ${report.readonly ? '是' : '否'}`);
    console.log(`采样文件 / 节点:        ${report.dataset.sampledFiles} / ${report.dataset.retainedNodes}`);
    console.log(`最大输运行质量:         ${report.dataset.maxTransportRowMass.toFixed(6)}`);
    console.log(`固定点收敛率:           ${(s.convergenceRate * 100).toFixed(1)}%`);
    console.log(`场 cosine 中位数:       ${s.medianFieldCosine.toFixed(4)}`);
    console.log(`可信场 Spearman:         ${s.medianTrustedFieldSpearman.toFixed(4)}`);
    console.log(`去源加权 Jaccard:        ${s.medianSeedlessWeightedJaccard.toFixed(4)}`);
    console.log(`严格去源 cosine:         ${s.medianStrictSeedlessCosine.toFixed(4)}`);
    console.log(`严格等长 Top-K Jaccard:  ${s.medianStrictEqualTopKJaccard.toFixed(4)}`);
    console.log(`无限场尾部质量:         ${s.medianStrictTailMass.toFixed(4)}`);
    console.log(`Top-10 域 Jaccard:       ${s.medianTop10Jaccard.toFixed(4)}`);
    console.log(`同 reward 曲线相关:      ${s.medianRewardGeometrySpearman.toFixed(4)}`);
    console.log(`有界路径曲线相关:       ${s.medianBoundedPathGeometrySpearman.toFixed(4)}`);
    console.log(`随机消融经验 p 中位数:  ${s.medianRandomEmpiricalP.toFixed(4)}`);
    console.log(`\n判决: ${report.verdict.level}`);
    console.log(
        `分层: stability=${report.verdict.layers.stability}, ` +
        `dynamics=${report.verdict.layers.dynamics}, domain=${report.verdict.layers.domain}, ` +
        `geometry=${report.verdict.layers.geometry}`
    );
    console.log(
        `最佳动力学 alpha=${report.verdict.bestDynamicsAlpha}, ` +
        `最佳几何 alpha=${report.verdict.bestGeometryAlpha}`
    );
    console.log(report.verdict.note);
}

function markdownNumber(value, digits = 4) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'N/A';
}

function buildMarkdownReport(report) {
    const s = report.summary;
    const probeRows = report.probes.map(item => [
        String(item.seedName).replace(/\|/g, '\\|'),
        item.seedId,
        markdownNumber(item.field.spikeVsEdgeCosine),
        markdownNumber(item.field.trustedSpikeVsEdgeSpearman),
        markdownNumber(item.domain.seedlessWeightedJaccard),
        markdownNumber(item.domain.top10Jaccard),
        markdownNumber(item.geometry.rewardSameFunctionalSpearman),
        markdownNumber(item.geometry.actionSameFunctionalSpearman),
        markdownNumber(item.geometry.rewardVsTopologySpearman),
        markdownNumber(item.geometry.rewardVsRandomFieldSpearman),
        markdownNumber(item.geometry.ablationMargin),
        item.support.trustedCurveCandidates,
        item.convergence.converged ? '是' : '否'
    ].join(' | ')).join('\n');

    return `# TagMemo 统一几何构型探针 V2 报告

> V2 修正了首轮的源质量域退化、评分泛函错配及零值并列秩问题。全程只读，不初始化 KnowledgeBaseManager。

## 1. 分层结论

**总判决：\`${report.verdict.level}\`**

- 动力学：**${report.verdict.layers.dynamics}**
- 场诱导域：**${report.verdict.layers.domain}**
- 曲线几何：**${report.verdict.layers.geometry}**

${report.verdict.text}

## 2. 数据概况

| 项目 | 值 |
|---|---:|
| 生成时间 | ${report.generatedAt} |
| 数据库 | \`${String(report.database).replace(/\\/g, '/')}\` |
| 模型签名 | \`${report.dataset.modelSig || '未发现'}\` |
| 有向量 Tag | ${report.dataset.tagsWithVectors} |
| 采样文件 / 保留节点 | ${report.dataset.sampledFiles} / ${report.dataset.retainedNodes} |
| Pairwise / 残差 | ${report.dataset.pairSimilarities} / ${report.dataset.residuals} |
| 曲线文件 | ${report.dataset.curveFiles} |
| 虫洞边 | ${report.dataset.wormholeEdges} |
| 最大输运行质量 | ${markdownNumber(report.dataset.maxTransportRowMass, 6)} |
| 耗时 | ${report.elapsedMs} ms |

## 3. 核心指标

| 层级 | 指标 | 结果 |
|---|---|---:|
| 动力学 | 固定点收敛率 | ${(s.convergenceRate * 100).toFixed(1)}% |
| 动力学 | 场 cosine | ${markdownNumber(s.medianFieldCosine)} |
| 动力学 | 可信场 Spearman | ${markdownNumber(s.medianTrustedFieldSpearman)} |
| 动力学 | 场加权 Jaccard | ${markdownNumber(s.medianFieldWeightedJaccard)} |
| 动力学 | 节点/非回溯场 Spearman | ${markdownNumber(s.medianNodeVsEdgeSpearman)} |
| 域 | 去源 80% 质量域 Jaccard | ${markdownNumber(s.medianSeedlessMassJaccard)} |
| 域 | 去源加权 Jaccard | ${markdownNumber(s.medianSeedlessWeightedJaccard)} |
| 域 | Top-5 / Top-10 / Top-20 Jaccard | ${markdownNumber(s.medianTop5Jaccard)} / ${markdownNumber(s.medianTop10Jaccard)} / ${markdownNumber(s.medianTop20Jaccard)} |
| 几何 | 同 reward 泛函 Spearman | ${markdownNumber(s.medianRewardGeometrySpearman)} |
| 几何 | 同 action 泛函 Spearman | ${markdownNumber(s.medianActionGeometrySpearman)} |
| 几何 | 脉冲场 reward/action 一致性 | ${markdownNumber(s.medianRewardActionSpike)} |
| 几何 | 稳态场 reward/action 一致性 | ${markdownNumber(s.medianRewardActionEdge)} |
| 消融 | 静态拓扑相关 | ${markdownNumber(s.medianTopologyAgreement)} |
| 消融 | 随机场相关 | ${markdownNumber(s.medianRandomAgreement)} |
| 消融 | 统一场优势 | ${markdownNumber(s.medianAblationMargin)} |

## 4. V2 控制变量

1. 所有 Spearman 使用平均并列秩。
2. 域比较先移除查询种子，再独立归一化。
3. 同一 reward 泛函分别读取脉冲场和 Resolvent 场。
4. 同一 action 泛函分别读取脉冲场和 Resolvent 场。
5. 曲线秩相关只计算至少被一个真实查询场接触的候选。
6. 随机场与静态拓扑作为消融，不再与大量零接触候选混算。

## 5. 逐种子结果

| 种子 | ID | cosine | 可信场 ρ | 去源加权 J | Top10 J | reward ρ | action ρ | 拓扑 ρ | 随机场 ρ | 消融优势 | 接触曲线 | 收敛 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
${probeRows}

## 6. 解读边界

- 动力学强、域强、几何强：支持完整的“场—域—度量”统一。
- 动力学强但域弱：稳态场存在，但有限脉冲截断定义了额外边界。
- 域强但几何消融优势弱：场可自带域，但曲线排序可能主要由静态拓扑驱动。
- reward 同泛函高而 action 同泛函低：场可替换，但当前作用量公式仍需重构。
- 本报告不替代带人工相关性标签的 NDCG、Recall 或线上 A/B 测试。
`;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const startedAt = Date.now();
    const config = loadConfig(options.config);
    const db = openReadonly(options.db);
    try {
        const tables = assertSchema(db);
        console.log(`[probe] 只读打开数据库: ${options.db}`);
        console.log('[probe] 加载事实层与现有派生资产...');
        const facts = loadFacts(db, options, tables);
        console.log(`[probe] 构建有向事实矩阵: files=${facts.chains.size}, tags=${facts.tagNames.size}`);
        const factMatrix = buildFactMatrix(facts, config);
        const graphData = retainGraph(factMatrix, facts, options);
        const kernelData = buildKernel(graphData.graph, facts.residuals, config.v9);
        const transportData = buildTransport(kernelData, config.spike);
        const seeds = chooseSeeds(options, graphData, facts);
        const random = mulberry32(options.seed);

        console.log(
            `[probe] 执行 ${seeds.length} 个查询探针: nodes=${graphData.retained.size}, ` +
            `kernelSources=${kernelData.kernel.size}, curves=${graphData.chains.size}`
        );

        const context = {
            options, config, facts, graphData, kernelData, transportData, random
        };
        const probes = seeds.map((seedId, index) => {
            console.log(`[probe] ${index + 1}/${seeds.length} seed=${facts.tagNames.get(seedId) || seedId}`);
            return runProbe(seedId, context);
        });
        const report = buildReport(
            options,
            config,
            facts,
            graphData,
            kernelData,
            transportData,
            probes
        );
        report.elapsedMs = Date.now() - startedAt;
        printReport(report);

        if (options.json) {
            fs.mkdirSync(path.dirname(options.json), { recursive: true });
            fs.writeFileSync(options.json, JSON.stringify(report, null, 2), 'utf8');
            console.log(`\nJSON 报告已写入: ${options.json}`);
        }
        if (options.md) {
            fs.mkdirSync(path.dirname(options.md), { recursive: true });
            fs.writeFileSync(options.md, buildMarkdownReport(report), 'utf8');
            console.log(`Markdown 报告已写入: ${options.md}`);
        }
    } finally {
        db.close();
    }
}

try {
    main();
} catch (error) {
    console.error(`[probe] 失败: ${error.message}`);
    if (process.env.TAGMEMO_PROBE_DEBUG === '1' && error.stack) console.error(error.stack);
    process.exitCode = 1;
}
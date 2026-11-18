'use strict';

// 全景图的角度。半径是场里的实际数值，这里只给每个节点排一个角度，让近邻挨着。
// 近邻关系直接取快照里的导航图（不读向量）：
//   1. 多级社区划分（Louvain，固定顺序，结果可重现），得到话题团的层级；
//   2. 每一层里，同一个上级下面的各团按相互连边的多少排成一串，层层往下直到节点；
//   3. 角度按排位均匀铺开，最上层的团之间留缝。
// 角度只表示“同属一个话题团、彼此相邻”，角度差不代表场里的实际远近。

const LAYOUT_VERSION = 2;

/** 把有向的导航图合成无向带权图：一条边权重 1，互相指向的权重 2。 */
function symmetrize(count, offsets, targets) {
    const maps = Array.from({ length: count }, () => new Map());
    for (let i = 0; i < count; i++) {
        for (let e = offsets[i]; e < offsets[i + 1]; e++) {
            const j = targets[e];
            if (j === i || j >= count) continue;
            maps[i].set(j, (maps[i].get(j) || 0) + 1);
            maps[j].set(i, (maps[j].get(i) || 0) + 1);
        }
    }
    return toGraph(maps, new Float64Array(count));
}

function toGraph(maps, selfLoop) {
    const count = maps.length;
    const neighbors = new Array(count);
    const weights = new Array(count);
    const degree = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const keys = [...maps[i].keys()].sort((a, b) => a - b);
        neighbors[i] = Int32Array.from(keys);
        weights[i] = Float64Array.from(keys, key => maps[i].get(key));
        let sum = 2 * selfLoop[i];
        for (const w of weights[i]) sum += w;
        degree[i] = sum;
    }
    return { count, neighbors, weights, degree, selfLoop };
}

/** Louvain 的一层：逐个节点挪到模块度增益最大的邻居团，直到不再有节点移动。 */
function louvainPass(graph) {
    const { count, neighbors, weights, degree } = graph;
    let total = 0;
    for (const d of degree) total += d;
    const community = Int32Array.from({ length: count }, (_, i) => i);
    const sum = Float64Array.from(degree);
    const linked = new Float64Array(count).fill(-1);
    const touched = [];
    let improved = false;
    for (let pass = 0, moved = true; moved && pass < 40; pass++) {
        moved = false;
        for (let i = 0; i < count; i++) {
            const current = community[i];
            touched.length = 0;
            linked[current] = 0;
            touched.push(current);
            for (let e = 0; e < neighbors[i].length; e++) {
                const c = community[neighbors[i][e]];
                if (linked[c] < 0) { linked[c] = 0; touched.push(c); }
                linked[c] += weights[i][e];
            }
            sum[current] -= degree[i];
            let best = current;
            let bestGain = linked[current] - sum[current] * degree[i] / total;
            for (const c of touched) {
                const gain = linked[c] - sum[c] * degree[i] / total;
                if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) { best = c; bestGain = gain; }
            }
            sum[best] += degree[i];
            if (best !== current) { community[i] = best; moved = true; improved = true; }
            for (const c of touched) linked[c] = -1;
        }
    }
    const renumber = new Map();
    for (let i = 0; i < count; i++) {
        if (!renumber.has(community[i])) renumber.set(community[i], renumber.size);
        community[i] = renumber.get(community[i]);
    }
    return { community, groups: renumber.size, improved };
}

function aggregate(graph, community, groups) {
    const maps = Array.from({ length: groups }, () => new Map());
    const selfLoop = new Float64Array(groups);
    for (let i = 0; i < graph.count; i++) {
        const a = community[i];
        selfLoop[a] += graph.selfLoop[i];
        for (let e = 0; e < graph.neighbors[i].length; e++) {
            const b = community[graph.neighbors[i][e]];
            const w = graph.weights[i][e];
            if (a === b) selfLoop[a] += w / 2;
            else maps[a].set(b, (maps[a].get(b) || 0) + w);
        }
    }
    return toGraph(maps, selfLoop);
}

/** 把一组成员按相互连边排成一串：先取最亲的一对对接成链，再把链首尾相接。 */
function chain(items, graph) {
    if (items.length <= 2) return items.slice();
    const inside = new Map(items.map((item, position) => [item, position]));
    const affinity = (a, b, w) => w / Math.sqrt(graph.degree[a] * graph.degree[b] || 1);
    const edges = [];
    for (const a of items) {
        for (let e = 0; e < graph.neighbors[a].length; e++) {
            const b = graph.neighbors[a][e];
            if (b > a && inside.has(b)) edges.push([affinity(a, b, graph.weights[a][e]), a, b]);
        }
    }
    edges.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const ends = new Map(items.map(item => [item, 0]));
    const parent = new Map(items.map(item => [item, item]));
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const next = new Map(items.map(item => [item, []]));
    for (const [, a, b] of edges) {
        if (ends.get(a) >= 2 || ends.get(b) >= 2) continue;
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) continue;
        parent.set(ra, rb);
        ends.set(a, ends.get(a) + 1);
        ends.set(b, ends.get(b) + 1);
        next.get(a).push(b);
        next.get(b).push(a);
    }
    const seen = new Set();
    const paths = [];
    for (const start of items) {
        if (seen.has(start) || ends.get(start) === 2) continue;
        const path = [start];
        seen.add(start);
        for (let at = start; ;) {
            const step = next.get(at).find(x => !seen.has(x));
            if (step === undefined) break;
            path.push(step);
            seen.add(step);
            at = step;
        }
        paths.push(path);
    }
    const weightOf = (a, b) => {
        const row = graph.neighbors[a];
        let lo = 0;
        let hi = row.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (row[mid] === b) return affinity(a, b, graph.weights[a][mid]);
            if (row[mid] < b) lo = mid + 1; else hi = mid - 1;
        }
        return 0;
    };
    // 链与链相接：每次把和当前串尾最亲的那条链接上；都不相连时接最长的。
    paths.sort((x, y) => y.length - x.length || x[0] - y[0]);
    const result = paths.shift();
    while (paths.length) {
        const tail = result[result.length - 1];
        let pick = 0;
        let reverse = false;
        let best = -1;
        for (let p = 0; p < paths.length; p++) {
            const head = weightOf(tail, paths[p][0]);
            const back = weightOf(tail, paths[p][paths[p].length - 1]);
            if (head > best) { best = head; pick = p; reverse = false; }
            if (back > best) { best = back; pick = p; reverse = true; }
        }
        const [path] = paths.splice(pick, 1);
        if (reverse) path.reverse();
        for (const item of path) result.push(item);
    }
    return result;
}

/**
 * @param {number} count 节点数
 * @param {Uint32Array} offsets 导航图 CSR 行偏移（count + 1 项）
 * @param {Uint32Array} targets 导航图邻居
 * @returns {{ angle: Float32Array, group: Int32Array, groups: {start:number,end:number,count:number}[] }}
 *   angle 为弧度（0 在正上方，顺时针增大）；group 是最上层话题团在环上的序号。
 */
function computeLayout(count, offsets, targets) {
    const base = symmetrize(count, offsets, targets);
    const graphs = [base];
    const memberships = [];
    for (let level = 0; level < 12; level++) {
        const graph = graphs[graphs.length - 1];
        const pass = louvainPass(graph);
        if (!pass.improved || pass.groups === graph.count) break;
        memberships.push(pass.community);
        graphs.push(aggregate(graph, pass.community, pass.groups));
        if (pass.groups <= 2) break;
    }
    // 自上而下展开：每一层把成员按连边排好，再换成下一层的成员。
    const levels = memberships.length;
    let order = chain(Array.from({ length: graphs[levels].count }, (_, i) => i), graphs[levels]);
    let topOf = null;
    for (let level = levels - 1; level >= 0; level--) {
        const children = Array.from({ length: graphs[level + 1].count }, () => []);
        memberships[level].forEach((parentIndex, child) => children[parentIndex].push(child));
        const expanded = [];
        const top = new Int32Array(graphs[level].count);
        order.forEach((parentIndex, position) => {
            const marker = topOf ? topOf[parentIndex] : position;
            for (const child of orient(expanded, chain(children[parentIndex], graphs[level]), graphs[level])) {
                top[child] = marker;
                expanded.push(child);
            }
        });
        order = expanded;
        topOf = top;
    }
    if (!topOf) topOf = new Int32Array(count);
    const groupCount = levels ? graphs[levels].count : 1;
    const gap = Math.max(2, count * 0.0045);
    const seam = gap * 3;
    const circle = count + gap * (groupCount - 1) + seam;
    const angle = new Float32Array(count);
    const group = Int32Array.from(topOf);
    const groups = Array.from({ length: groupCount }, () => ({ start: 0, end: 0, count: 0 }));
    let position = seam / 2;
    let previous = -1;
    for (const node of order) {
        const g = group[node];
        if (previous >= 0 && g !== previous) position += gap;
        const value = (position + 0.5) / circle * 2 * Math.PI;
        angle[node] = value;
        if (!groups[g].count) groups[g].start = value;
        groups[g].end = value;
        groups[g].count++;
        position += 1;
        previous = g;
    }
    return { angle, group, groups };
}

/** 新接上的一段朝哪头接：看它的前半段和后半段，哪一半和已经排好的串尾连得更多。 */
function orient(placed, segment, graph) {
    if (!placed.length || segment.length < 4) return segment;
    const tail = new Set(placed.slice(-48));
    const half = segment.length >> 1;
    let front = 0;
    let back = 0;
    segment.forEach((item, position) => {
        let linked = 0;
        for (let e = 0; e < graph.neighbors[item].length; e++) {
            if (tail.has(graph.neighbors[item][e])) linked += graph.weights[item][e];
        }
        if (position < half) front += linked; else back += linked;
    });
    return back > front ? segment.slice().reverse() : segment;
}

/**
 * 排布质量：每个节点真正最近的 k 个邻居里，落在它左右各 window（占整圈的比例）弧内的比例。
 * truth[i] 是节点 i 按精确余弦最近的邻居下标。
 */
function neighborRecall(angle, truth, window = 0.05) {
    const limit = window * 2 * Math.PI;
    let hit = 0;
    let all = 0;
    truth.forEach((list, i) => {
        for (const j of list) {
            let d = Math.abs(angle[i] - angle[j]);
            if (d > Math.PI) d = 2 * Math.PI - d;
            if (d <= limit) hit++;
            all++;
        }
    });
    return all ? hit / all : 0;
}

module.exports = { computeLayout, neighborRecall, LAYOUT_VERSION };

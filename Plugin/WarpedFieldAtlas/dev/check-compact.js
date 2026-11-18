'use strict';

// 参数：--library <副本> [--messages <消息库>] [--baseline <从旧版本导出的 atlas.js>] [--self-test]
// 输出只含数值。第 1 行：查询数、逐位相同的夹角数、距离数、向量分量数和模长数。
// 第 2、3 行分别是节点、消息：查询数，两种名次的最小值和中位数，粗算节点检查次数，
// 余弦误差最大值、粗算节点的 slack 最大值、精算前缀的距离及余弦最大差、每次精算数的范围。
// 失败行：[负的检查编号, 查询序号, 节点编号, 实测值, 上限]。-90 为检查脚本未能正常执行。

const path = require('node:path');
const { parseArgs } = require('node:util');
const { createAtlas } = require('../lib/atlas');
const { clampCosine } = require('../lib/compact');
const { openReadOnly } = require('../lib/library');

const TOLERANCE = 1e-12;
const route = '/field/tag/query';

class CheckFailure extends Error {
    constructor(numbers) {
        super();
        this.numbers = numbers;
    }
}

function check(condition, code, query = 0, id = 0, actual = 0, limit = 0) {
    if (!condition) throw new CheckFailure([-code, query, id, actual, limit]);
}

function sampleNodes(ids, count) {
    const sampled = Array.from(ids);
    let seed = 20261119;
    for (let i = 0; i < count; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = i + Math.floor(seed / 2 ** 32 * (sampled.length - i));
        [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
    }
    return sampled.slice(0, count).map(node => ({ node }));
}

function compareBaseline(baseline, exact, ids, queries) {
    let values = 0;
    for (const [n, target] of queries.entries()) {
        const params = new URLSearchParams(target);
        const before = baseline.handle(route, params);
        const after = exact.handle(route, params);
        check(after.exact.all, 10, n + 1);
        for (const [key, code] of [['theta', 11], ['distance', 12]]) {
            check(before[key].length === ids.length && after[key].length === ids.length, code, n + 1);
            for (let i = 0; i < ids.length; i++) {
                check(Object.is(before[key][i], after[key][i]), code, n + 1, ids[i], after[key][i], before[key][i]);
            }
        }
        values += ids.length;
    }
    const oldVectors = baseline.loadVectors(baseline.fieldOf('tag'));
    const newVectors = exact.loadVectors(exact.fieldOf('tag'));
    const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    check(bytes(oldVectors.unit).equals(bytes(newVectors.unit)), 13);
    check(bytes(oldVectors.norm).equals(bytes(newVectors.norm)), 14);
    return [1, queries.length, values, values, newVectors.unit.length, newVectors.norm.length];
}

function compareRanks(expected, actual, ids, candidates, key, rank, n, ascending, code) {
    const sortBy = values => (a, b) => ascending ? values[a] - values[b] || a - b : values[b] - values[a] || a - b;
    const reference = candidates.slice().sort(sortBy(expected[key]));
    const observed = candidates.slice().sort(sortBy(actual[key]));
    let maxError = 0;
    for (let k = 0; k < rank; k++) {
        const i = reference[k];
        check(i === observed[k] && actual.refined[i] === 1, code, n, ids[i], ids[observed[k]], k + 1);
        const error = Math.abs(expected[key][i] - actual[key][i]);
        check(error <= TOLERANCE, code + 1, n, ids[i], error, TOLERANCE);
        maxError = Math.max(maxError, error);
    }
    return maxError;
}

function compareQuery(exact, compact, field, target, n, selfTest) {
    const expected = exact.query('tag', target, { diagnostics: true });
    const actual = compact.query('tag', target, { diagnostics: true });
    const { index: { ids, radius }, geometry, legs } = field;
    const { refined, distanceRank, cosineRank } = actual.exact;
    check(expected.exact.all && !actual.exact.all, 20, n);
    check(expected.skip === actual.skip && expected.radius === actual.radius, 21, n);

    const candidates = [];
    const legQ = expected.skip < 0 ? geometry.leg(expected.radius) : legs[expected.skip];
    let closestBound = Infinity;
    let largestBound = -Infinity;
    let maxError = 0;
    let maxSlack = 0;
    let unrefined = 0;
    for (let i = 0; i < ids.length; i++) {
        const valid = Number.isFinite(expected.distance[i]);
        check(valid === Number.isFinite(actual.distance[i]), 22, n, ids[i]);
        if (i === expected.skip || !valid) continue;
        candidates.push(i);
        if (actual.refined[i]) continue;

        // 用同一条断言检查正常结果和故意损坏的结果。
        const coarse = selfTest ? expected.cosine[i] + 1 : actual.coarse[i];
        const slack = selfTest ? 0 : actual.slack[i];
        const error = Math.abs(coarse - expected.cosine[i]);
        check(error <= slack, 23, n, ids[i], error, slack);
        const upperCosine = clampCosine(coarse + slack);
        const lowerDistance = geometry.distance(expected.radius, radius[i], Math.acos(upperCosine), legQ, legs[i]);
        check(lowerDistance <= expected.distance[i], 24, n, ids[i], lowerDistance, expected.distance[i]);
        closestBound = Math.min(closestBound, lowerDistance);
        largestBound = Math.max(largestBound, upperCosine);
        maxError = Math.max(maxError, error);
        maxSlack = Math.max(maxSlack, slack);
        unrefined++;
    }

    const refinedIndices = candidates.filter(i => actual.refined[i]);
    check(refined > 0 && unrefined > candidates.length / 2 && refined === refinedIndices.length, 25, n);
    const roundedDistance = distance => Math.round(distance * 1e5);
    const roundedTheta = theta => Math.round(theta * 180 / Math.PI * 1e3);
    const distanceLimit = roundedDistance(closestBound);
    const thetaLimit = roundedTheta(Math.acos(largestBound));
    check(distanceRank === refinedIndices.filter(i => roundedDistance(actual.distance[i]) < distanceLimit).length, 26, n);
    check(cosineRank === refinedIndices.filter(i => roundedTheta(actual.theta[i]) < thetaLimit).length, 27, n);
    const distanceDifference = compareRanks(expected, actual, ids, candidates, 'distance', distanceRank, n, true, 30);
    const cosineDifference = compareRanks(expected, actual, ids, candidates, 'cosine', cosineRank, n, false, 32);
    return { distanceRank, cosineRank, unrefined, maxError, maxSlack, distanceDifference, cosineDifference, refined };
}

function summary(code, rows) {
    if (!rows.length) return [code, 0];
    const middle = values => {
        values.sort((a, b) => a - b);
        return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    };
    const min = key => Math.min(...rows.map(row => row[key]));
    const max = key => Math.max(...rows.map(row => row[key]));
    return [code, rows.length,
        min('distanceRank'), middle(rows.map(row => row.distanceRank)), min('cosineRank'), middle(rows.map(row => row.cosineRank)),
        rows.reduce((sum, row) => sum + row.unrefined, 0), max('maxError'), max('maxSlack'),
        max('distanceDifference'), max('cosineDifference'), min('refined'), max('refined')];
}

function messageQueries(atlas, file) {
    if (!file) return [];
    const db = openReadOnly(file);
    try {
        const { count } = db.get('SELECT COUNT(*) AS count FROM folding_entries WHERE vector IS NOT NULL');
        if (!count) return [];
    } finally {
        db.close();
    }
    const hashes = [...new Set(atlas.handle('/messages').rows.map(row => row.hash))];
    check(hashes.length >= 10, 40, 0, 0, hashes.length, 10);
    return hashes.slice(0, 10).map(message => ({ message }));
}

function run() {
    const { values } = parseArgs({ options: {
        library: { type: 'string' }, messages: { type: 'string' }, baseline: { type: 'string' },
        'self-test': { type: 'boolean' },
    } });
    check(values.library, 1);
    const options = { directory: values.library, messageStore: values.messages };
    const exact = createAtlas({ ...options, exactMegabytes: Infinity });
    let compact;
    let baseline;
    try {
        compact = createAtlas({ ...options, exactMegabytes: 0, refine: 200, refineCosine: 40 });
        const field = exact.fieldOf('tag');
        const ids = field.index.ids;
        const count = values['self-test'] ? 1 : 40;
        check(ids.length >= count, 2, 0, 0, ids.length, count);
        const queries = sampleNodes(ids, count);
        if (!values['self-test']) {
            const baselinePath = values.baseline || path.join(__dirname,
                '../../../../scratch/codex-warped-atlas/head/lib/atlas.js');
            baseline = require(path.resolve(baselinePath)).createAtlas(options);
            console.log(JSON.stringify(compareBaseline(baseline, exact, ids, queries)));
        }
        const compare = (target, i) => compareQuery(exact, compact, field, target, i + 1, values['self-test']);
        console.log(JSON.stringify(summary(2, queries.map(compare))));
        console.log(JSON.stringify(summary(3, messageQueries(exact, values.messages).map(compare))));
    } finally {
        baseline?.close();
        compact?.close();
        exact.close();
    }
}

try {
    run();
} catch (error) {
    console.error(JSON.stringify(error instanceof CheckFailure ? error.numbers : [-90, error.status || 0]));
    process.exitCode = 1;
}

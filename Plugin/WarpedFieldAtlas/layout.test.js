'use strict';

// 角度排布的测试：造一张已知答案的图（节点本来排在一个环上，各连左右最近的几个，编号打乱），
// 排布应当把环上相邻的节点重新排到一起；随机排法做对照，确认指标分得出好坏。
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLayout, neighborRecall } = require('./lib/layout');

function ringGraph(count, reach) {
    let seed = 7;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const label = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [label[i], label[j]] = [label[j], label[i]]; }
    const neighbours = Array.from({ length: count }, () => []);
    for (let position = 0; position < count; position++) {
        for (let step = 1; step <= reach; step++) {
            neighbours[label[position]].push(label[(position + step) % count], label[(position - step + count) % count]);
        }
    }
    const offsets = new Uint32Array(count + 1);
    const targets = [];
    neighbours.forEach((list, i) => { targets.push(...list); offsets[i + 1] = targets.length; });
    return { offsets, targets: Uint32Array.from(targets), truth: neighbours, random };
}

test('把环上相邻的节点排回到一起，随机排法做不到', () => {
    const count = 600;
    const { offsets, targets, truth, random } = ringGraph(count, 4);
    const layout = computeLayout(count, offsets, targets);
    assert.equal(layout.angle.length, count);
    assert.ok(layout.groups.length >= 2);
    assert.equal(layout.groups.reduce((n, g) => n + g.count, 0), count);
    for (const value of layout.angle) assert.ok(value > 0 && value < 2 * Math.PI);
    const shuffled = Float32Array.from({ length: count }, () => random() * 2 * Math.PI);
    const mine = neighborRecall(layout.angle, truth, 0.05);
    const chance = neighborRecall(shuffled, truth, 0.05);
    assert.ok(mine > 0.85, `排布后的近邻保持率 ${mine}`);
    assert.ok(chance < 0.2, `随机排法的近邻保持率 ${chance}`);
});

test('同一张图两次排布的结果相同（缓存和截图才对得上）', () => {
    const { offsets, targets } = ringGraph(300, 3);
    const first = computeLayout(300, offsets, targets);
    const second = computeLayout(300, offsets, targets);
    assert.deepEqual(Array.from(first.angle), Array.from(second.angle));
    assert.deepEqual(Array.from(first.group), Array.from(second.group));
});

test('同一个话题团的节点在环上连成一段', () => {
    const { offsets, targets } = ringGraph(400, 4);
    const layout = computeLayout(400, offsets, targets);
    const order = Array.from({ length: 400 }, (_, i) => i).sort((a, b) => layout.angle[a] - layout.angle[b]);
    let switches = 0;
    for (let n = 1; n < order.length; n++) if (layout.group[order[n]] !== layout.group[order[n - 1]]) switches++;
    assert.equal(switches, layout.groups.length - 1);
});

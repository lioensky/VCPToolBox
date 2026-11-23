'use strict';

function trueTiles(ids, angle, radius) {
    const n = ids.length;
    if (!n || angle.length !== n || radius.length !== n) throw new Error('coordinate shape mismatch');
    const order = Array.from({ length: n }, (_, slot) => slot);
    // id arrays may contain BigInts. Return an actual Number to Array.sort.
    const tie = (a, b) => ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
    order.sort((a, b) => angle[a] - angle[b] || tie(a, b));
    const tiles = [];
    for (let i = 0; i < n; i += 64) {
        const wedge = order.slice(i, i + 64);
        wedge.sort((a, b) => radius[a] - radius[b] || tie(a, b));
        for (let j = 0; j < wedge.length; j += 16) tiles.push(wedge.slice(j, j + 16));
    }
    return tiles;
}

// Mulberry32 uint32 output, Fisher-Yates with rejection to avoid modulo bias.
function shuffledTiles(tiles, seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('invalid seed');
    let state = seed;
    function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let z = Math.imul(state ^ (state >>> 15), 1 | state);
        z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
        return (z ^ (z >>> 14)) >>> 0;
    }
    // Start in snapshot-slot order, not true-plate traversal order.
    const n = tiles.reduce((sum, t) => sum + t.length, 0);
    if (n > 0xffffffff) throw new RangeError('slot count exceeds uint32 range');
    const order = Array.from({ length: n }, (_, slot) => slot);
    for (let i = n - 1; i > 0; i--) {
        const width = i + 1, limit = 0x100000000 - 0x100000000 % width;
        let u;
        do { u = next(); } while (u >= limit);
        const j = u % width;
        [order[i], order[j]] = [order[j], order[i]];
    }
    let offset = 0;
    return tiles.map(t => {
        const start = offset;
        offset += t.length;
        return order.slice(start, offset);
    });
}

module.exports = { trueTiles, shuffledTiles };
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./store.cjs');
const { check } = require('./data.cjs');

const SYMBOL = /^[A-Za-z0-9._-]{1,32}$/;
const ID = /^board-[a-f0-9-]{8,40}$/;
const cleanSymbols = values => {
    check(Array.isArray(values) && values.length <= 5000 && values.every(value => typeof value === 'string' && SYMBOL.test(value)),
        'INVALID_BOARD', '板块证券列表无效或超过五千只。');
    return [...new Set(values)];
};
class Boards {
    constructor(store) { this.store = store; this.file = path.join(store.directory, 'settings', 'boards.json'); this.state = null; }
    async open() {
        const loaded = await fs.readFile(this.file, 'utf8').then(JSON.parse, () => null);
        this.state = loaded || { schemaVersion: 1, revision: 0, favorites: [], boards: [], receipts: {} };
        check(this.state.schemaVersion === 1 && Number.isSafeInteger(this.state.revision)
            && Array.isArray(this.state.favorites) && Array.isArray(this.state.boards)
            && this.state.receipts && typeof this.state.receipts === 'object',
        'CORRUPT_SAVE', '板块存档无效，原文件已保留。');
        cleanSymbols(this.state.favorites);
        check(this.state.boards.every(board => ID.test(board.id) && typeof board.name === 'string'
            && board.name.length > 0 && board.name.length <= 40 && Array.isArray(board.symbols)
            && Number.isSafeInteger(board.order)), 'CORRUPT_SAVE', '板块存档无效，原文件已保留。');
        this.state.boards.forEach(board => cleanSymbols(board.symbols));
    }
    list() {
        return { revision: this.state.revision, favorites: [...this.state.favorites],
            boards: this.state.boards.map(board => ({ ...board, symbols: [...board.symbols] })) };
    }
    groups(allowed) {
        const filtered = symbols => symbols.filter(symbol => allowed.has(symbol));
        return [{ id: 'favorites', name: '自选', symbols: filtered(this.state.favorites) },
            ...this.state.boards.map(board => ({ id: board.id, name: board.name, symbols: filtered(board.symbols) }))];
    }
    async change(input) {
        return this.store.serial('boards', async () => {
            const requestId = input.requestId;
            check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId),
                'INVALID_REQUEST', '板块写入需要唯一 requestId。');
            const signature = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'requestId')));
            if (this.state.receipts[requestId]) {
                check(this.state.receipts[requestId].signature === signature, 'REQUEST_CONFLICT', '同一请求标识不能更换板块操作。');
                return { ...this.state.receipts[requestId].result, duplicate: true };
            }
            check(input.expectedRevision === this.state.revision, 'STALE_BOARD', '板块版本已变化，请刷新后重试。');
            const next = structuredClone(this.state);
            let id = input.boardId;
            if (input.action === 'save') {
                const name = String(input.name || '').trim();
                check(name.length > 0 && name.length <= 40, 'INVALID_BOARD', '板块名称须为 1 至 40 字。');
                const symbols = cleanSymbols(input.symbols ?? []);
                if (id) {
                    check(ID.test(id) && next.boards.some(board => board.id === id), 'INVALID_BOARD', '板块不存在。');
                    next.boards = next.boards.map(board => board.id === id ? { ...board, name, symbols } : board);
                } else {
                    check(next.boards.length < 200, 'BOARD_LIMIT', '自建板块已达二百个。');
                    id = `board-${randomUUID()}`;
                    next.boards.push({ id, name, symbols, order: next.boards.length });
                }
            } else if (input.action === 'delete') {
                check(ID.test(id) && next.boards.some(board => board.id === id), 'INVALID_BOARD', '板块不存在。');
                next.boards = next.boards.filter(board => board.id !== id);
            } else if (input.action === 'favorites') {
                next.favorites = cleanSymbols(input.symbols);
            } else if (input.action === 'reorder') {
                check(Array.isArray(input.boardIds) && input.boardIds.length === next.boards.length
                    && new Set(input.boardIds).size === next.boards.length
                    && input.boardIds.every(value => next.boards.some(board => board.id === value)),
                'INVALID_BOARD', '板块排序须包含全部自建板块。');
                next.boards = input.boardIds.map((value, order) => ({ ...next.boards.find(board => board.id === value), order }));
            } else if (input.action === 'importLocal') {
                const incoming = Array.isArray(input.boards) ? input.boards : [];
                check(incoming.length <= 200, 'INVALID_BOARD', '导入板块数量过多。');
                const existingNames = new Set(next.boards.map(board => board.name));
                for (const board of incoming) {
                    const name = String(board?.name || '').trim();
                    if (!name || name.length > 40 || existingNames.has(name)) continue;
                    next.boards.push({ id: `board-${randomUUID()}`, name,
                        symbols: cleanSymbols(board.symbols || []), order: next.boards.length });
                    existingNames.add(name);
                }
                next.favorites = [...new Set([...next.favorites, ...cleanSymbols(input.favorites || [])])];
            } else check(false, 'INVALID_BOARD', '未知板块操作。');
            next.revision++;
            const result = { boardId: id || null, ...{ revision: next.revision,
                favorites: [...next.favorites], boards: next.boards.map(board => ({ ...board, symbols: [...board.symbols] })) } };
            next.receipts[requestId] = { signature, result };
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await atomicWrite(this.file, next);
            this.state = next;
            return result;
        });
    }
}
module.exports = { Boards };

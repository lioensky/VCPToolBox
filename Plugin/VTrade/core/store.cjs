'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { check, TradeError } = require('./data.cjs');
const { validateState } = require('./engine.cjs');

async function atomicWrite(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        const handle = await fs.open(temporary, 'wx');
        try {
            await handle.writeFile(JSON.stringify(value), 'utf8');
            await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
}
const alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
class Store {
    constructor(directory) { this.directory = path.resolve(directory); this.queues = new Map(); }
    async open() {
        await fs.mkdir(this.directory, { recursive: true });
        const lockFile = path.join(this.directory, 'writer.lock');
        try { this.lock = await fs.open(lockFile, 'wx'); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // A lock whose writer process no longer exists is left from an abnormal stop and is taken over;
            // a live owner, this process, or an unreadable lock still blocks.
            const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => ''));
            if (!Number.isSafeInteger(owner) || owner <= 0 || owner === process.pid || alive(owner)) {
                throw new TradeError('STORE_LOCKED', '模拟存储已被占用。异常退出后请先确认旧进程已停止，再移除 writer.lock。');
            }
            await fs.unlink(lockFile);
            this.lock = await fs.open(lockFile, 'wx');
        }
        await this.lock.writeFile(String(process.pid));
        await fs.mkdir(path.join(this.directory, 'sessions'), { recursive: true });
        await fs.mkdir(path.join(this.directory, 'datasets'), { recursive: true });
    }
    file(id) {
        check(/^run-[a-f0-9]{32}$/.test(id), 'INVALID_SESSION', '运行标识不合法。');
        return path.join(this.directory, 'sessions', `${id}.json`);
    }
    async read(id) {
        let state;
        try { state = JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
        catch (error) {
            if (error.code === 'ENOENT') throw new TradeError('NOT_FOUND', '模拟运行不存在。');
            throw new TradeError('CORRUPT_SAVE', '模拟存档不可读取，已保留原文件。');
        }
        validateState(state);
        check(state.id === id, 'CORRUPT_SAVE', '存档标识与文件不一致。');
        return state;
    }
    async write(state) { validateState(state); await atomicWrite(this.file(state.id), state); }
    serial(id, operation) {
        const previous = this.queues.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.queues.set(id, next);
        void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
        return next;
    }
    async list() {
        const sessions = [], unavailable = [];
        for (const name of await fs.readdir(path.join(this.directory, 'sessions'))) {
            if (!/^run-[a-f0-9]{32}\.json$/.test(name)) continue;
            const id = name.slice(0, -5);
            try {
                const s = await this.read(id);
                sessions.push({ sessionId: id, name: s.name, agentName: s.agentName, revision: s.revision,
                    ...(s.training ? { training: { pairId: s.training.pairId, role: s.training.role } } : {}) });
            } catch (error) { unavailable.push({ sessionId: id, code: error.code }); }
        }
        return { sessions, unavailable };
    }
    async close() {
        await Promise.allSettled([...this.queues.values()]);
        if (this.lock) {
            await this.lock.close(); this.lock = null;
            await fs.unlink(path.join(this.directory, 'writer.lock'));
        }
    }
}
module.exports = { Store, atomicWrite };

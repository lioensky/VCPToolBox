'use strict';

// 双曲场图的后端插件（service，接口挂在 /api/plugins/WarpedFieldAtlas/ 下，走后端已有的接口认证）。
// 只读：读知识库目录里的双曲场快照和 SQLite，不写知识库；缓存只写在本目录的 state/ 里。
// 单独进程读 SQLite，避免与主服的 Vexus 共享 POSIX 进程级文件锁；空闲十分钟回收。
// 界面在 Chat 的应用功能模块 modules/warpedFieldAtlas；命令行查看见同目录 cli.js。

const path = require('node:path');
const { fork } = require('node:child_process');
const { parseExactMegabytes } = require('./lib/compact');

const IDLE_MS = 10 * 60 * 1000;
const ROUTES = ['/status', '/messages', '/field/:kind', '/field/:kind/node/:id', '/field/:kind/query'];

let projectBase = null;
let settings = {};
let exactMegabytes;
let worker = null;
let idleTimer = null;
let sequence = 0;
const waiting = new Map();

/**
 * 知识库在哪由后端自己说：和 KnowledgeBaseManager 用同一个目录，不猜。
 * 插件配置里写了 WARPED_ATLAS_LIBRARY 时改看那个目录（看一份库的副本时用）。
 */
function storeDirectory() {
    if (settings.WARPED_ATLAS_LIBRARY) return path.resolve(String(settings.WARPED_ATLAS_LIBRARY));
    const manager = require(path.join(projectBase, 'KnowledgeBaseManager.js'));
    const directory = manager && manager.config && manager.config.storePath;
    if (!directory) throw Object.assign(new Error('知识库还没有就绪。'), { status: 503 });
    return directory;
}

function stopWorker(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const current = worker;
    worker = null;
    for (const [, entry] of waiting) entry.reject(Object.assign(new Error(reason || '双曲场图已停止。'), { status: 503 }));
    waiting.clear();
    if (!current || current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        current.once('close', resolve);
        current.kill('SIGKILL');
    });
}

function ensureWorker() {
    if (worker) return worker;
    const workerData = {
            directory: storeDirectory(),
            cacheDirectory: path.join(__dirname, 'state'),
            ...(exactMegabytes === undefined ? {} : { exactMegabytes }),
            // 对话消息的向量：ContextFolding（RAGDiaryPlugin）存的那一份，只读。没有这个文件就没有“以对话消息为查询”。
            messageStore: settings.WARPED_ATLAS_MESSAGES ? path.resolve(String(settings.WARPED_ATLAS_MESSAGES))
                : path.join(projectBase, 'Plugin', 'RAGDiaryPlugin', 'folding_store.db'),
    };
    const started = fork(path.join(__dirname, 'lib', 'worker.js'), [JSON.stringify(workerData)], {
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    started.on('message', message => {
        if (worker !== started) return;
        const entry = waiting.get(message.id);
        if (!entry) return;
        waiting.delete(message.id);
        if (message.ok) entry.resolve(message.body);
        else entry.reject(Object.assign(new Error(message.message), { status: message.status }));
    });
    started.on('error', error => { if (worker === started) void stopWorker(`双曲场图的子进程出错：${error.message}`); });
    started.on('close', () => { if (worker === started) void stopWorker('双曲场图的子进程已退出。'); });
    worker = started;
    return started;
}

function ask(pathname, search) {
    return new Promise((resolve, reject) => {
        const target = ensureWorker();
        const id = ++sequence;
        waiting.set(id, { resolve, reject });
        const onSend = error => {
            if (!error || !waiting.delete(id)) return;
            reject(Object.assign(error, { status: 503 }));
        };
        try {
            target.send({ id, pathname, search }, onSend);
        } catch (error) {
            onSend(error);
            return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stopWorker('双曲场图空闲，已释放。'), IDLE_MS);
        if (idleTimer.unref) idleTimer.unref();
    });
}

function registerApiRoutes(router, config, projectBasePath) {
    projectBase = projectBasePath;
    settings = config || {};
    exactMegabytes = parseExactMegabytes(settings.WARPED_ATLAS_EXACT_MB);
    router.get(ROUTES, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const search = new URLSearchParams(Object.entries(req.query || {}).filter(([, value]) => typeof value === 'string')).toString();
            const body = await ask(req.path, search);
            res.type('application/json').send(body);
        } catch (error) {
            const status = Number.isInteger(error.status) ? error.status : 500;
            if (status === 500) console.error('[WarpedFieldAtlas]', error);
            res.status(status).json({ message: status === 500 ? '读取双曲场失败。' : error.message });
        }
    });
}

function initialize() {}

function shutdown() {
    return stopWorker('后端正在关闭。');
}

module.exports = { initialize, registerApiRoutes, shutdown };

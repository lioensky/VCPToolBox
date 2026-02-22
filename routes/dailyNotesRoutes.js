const express = require('express');
const fs = require('fs').promises;
const path = require('path');

/**
 * 日记本管理模块 (安全加固版)
 * @param {string} dailyNoteRootPath 日记本根目录
 * @param {boolean} DEBUG_MODE 是否开启调试模式
 * @returns {express.Router}
 */
module.exports = function (dailyNoteRootPath, DEBUG_MODE) {
    const router = express.Router();

    // ══════════════════════════════════════════════════
    //  搜索配置
    // ══════════════════════════════════════════════════
    const SEARCH_CONFIG = {
        MAX_RESULTS: 200,
        MAX_SEARCH_TERM_LENGTH: 100,
        MAX_KEYWORDS: 5,
        TIMEOUT_MS: 30000,
        QUEUE_WAIT_TIMEOUT_MS: 10000,   // 排队等待超时
        PREVIEW_LENGTH: 100,
        MAX_FILE_SIZE: 1024 * 1024,
        MAX_DEPTH: 3,
        YIELD_EVERY_N_FILES: 50,        // 每处理 N 个文件让出事件循环
        MAX_CONCURRENT: 2,
    };

    // ══════════════════════════════════════════════════
    //  工具函数
    // ══════════════════════════════════════════════════

    /** 让出事件循环 —— 防止 CPU 独占 */
    function yieldToEventLoop() {
        return new Promise(resolve => setImmediate(resolve));
    }

    /** 安全路径检查 */
    function isPathSafe(targetPath, rootPath) {
        const resolved = path.resolve(targetPath);
        const root = path.resolve(rootPath);
        return resolved === root || resolved.startsWith(root + path.sep);
    }

    /** 符号链接检查 */
    async function isSymlink(filePath) {
        try {
            return (await fs.lstat(filePath)).isSymbolicLink();
        } catch {
            return false;
        }
    }

    // ══════════════════════════════════════════════════
    //  信号量 —— 替代手写队列，杜绝死锁
    // ══════════════════════════════════════════════════
    class Semaphore {
        constructor(max) {
            this.max = max;
            this.current = 0;
            this.queue = [];      // { resolve, reject, timer }
        }

        /**
         * 获取一个槽位，超时自动拒绝
         * @returns {Promise<void>}
         */
        acquire(timeoutMs = 10000) {
            // 有空位，立即获取
            if (this.current < this.max) {
                this.current++;
                return Promise.resolve();
            }

            // 无空位，排队等待（带超时保护）
            return new Promise((resolve, reject) => {
                const entry = { resolve: null, reject: null, timer: null };

                entry.timer = setTimeout(() => {
                    // 超时：从队列中移除自己
                    const idx = this.queue.indexOf(entry);
                    if (idx !== -1) this.queue.splice(idx, 1);
                    reject(new Error('Search queue wait timeout'));
                }, timeoutMs);

                entry.resolve = () => {
                    clearTimeout(entry.timer);
                    resolve();
                };

                this.queue.push(entry);
            });
        }

        /** 释放槽位，唤醒下一个等待者 */
        release() {
            if (this.queue.length > 0) {
                // 直接把槽位转交给下一个等待者（不减 current）
                const next = this.queue.shift();
                next.resolve();
            } else {
                this.current--;
            }
        }

        get stats() {
            return {
                active: this.current,
                waiting: this.queue.length,
                max: this.max,
            };
        }
    }

    const searchSemaphore = new Semaphore(SEARCH_CONFIG.MAX_CONCURRENT);

    // ══════════════════════════════════════════════════
    //  请求去重缓存
    // ══════════════════════════════════════════════════
    const inflightSearches = new Map(); // hash → { promise, refCount }

    function hashSearchParams(terms, folder) {
        return `${terms.join('+')}:::${folder || '*'}`;
    }

    // ══════════════════════════════════════════════════
    //  核心搜索（支持 AbortSignal + 周期性让步）
    // ══════════════════════════════════════════════════

    /**
     * @param {string[]} searchTerms
     * @param {string|null} folder
     * @param {AbortSignal} signal
     */
    async function executeSearch(searchTerms, folder, signal) {
        // ── 在每个 await 点都检查中止 ──
        const checkAbort = () => {
            if (signal.aborted) {
                throw new DOMException('Search aborted', 'AbortError');
            }
        };

        const matchedNotes = [];
        const visitedPaths = new Set();
        let filesProcessed = 0;

        // ---------- 确定搜索目录 ----------
        let foldersToSearch = [];

        if (folder) {
            const specificPath = path.join(dailyNoteRootPath, folder);
            if (!isPathSafe(specificPath, dailyNoteRootPath)) {
                throw new Error('Path traversal detected');
            }
            if (await isSymlink(specificPath)) {
                throw new Error('Cannot search in symbolic link folders');
            }
            checkAbort();
            const stat = await fs.stat(specificPath);
            if (!stat.isDirectory()) throw new Error(`'${folder}' is not a directory`);
            foldersToSearch.push({ name: folder, path: specificPath, depth: 0 });
        } else {
            checkAbort();
            const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const p = path.join(dailyNoteRootPath, entry.name);
                if (await isSymlink(p)) continue;
                foldersToSearch.push({ name: entry.name, path: p, depth: 0 });
            }
        }

        // ---------- 遍历搜索 ----------
        for (const dir of foldersToSearch) {
            checkAbort();
            if (matchedNotes.length >= SEARCH_CONFIG.MAX_RESULTS) break;
            if (dir.depth > SEARCH_CONFIG.MAX_DEPTH) continue;

            // 循环检测
            let realPath;
            try { realPath = await fs.realpath(dir.path); } catch { continue; }
            if (visitedPaths.has(realPath)) continue;
            visitedPaths.add(realPath);

            let files;
            try { files = await fs.readdir(dir.path); } catch { continue; }

            const noteFiles = files.filter(f => {
                const lower = f.toLowerCase();
                return lower.endsWith('.txt') || lower.endsWith('.md');
            });

            for (const fileName of noteFiles) {
                checkAbort();
                if (matchedNotes.length >= SEARCH_CONFIG.MAX_RESULTS) break;

                // ★ 关键：每处理 N 个文件，让出事件循环
                filesProcessed++;
                if (filesProcessed % SEARCH_CONFIG.YIELD_EVERY_N_FILES === 0) {
                    await yieldToEventLoop();
                    checkAbort(); // 让步回来再检查一次
                }

                const filePath = path.join(dir.path, fileName);
                if (!isPathSafe(filePath, dailyNoteRootPath)) continue;
                if (await isSymlink(filePath)) continue;

                try {
                    const stats = await fs.stat(filePath);
                    if (stats.size > SEARCH_CONFIG.MAX_FILE_SIZE) continue;

                    const content = await fs.readFile(filePath, 'utf-8');
                    const lower = content.toLowerCase();

                    if (searchTerms.every(t => lower.includes(t))) {
                        matchedNotes.push({
                            name: fileName,
                            folderName: dir.name,
                            lastModified: stats.mtime.toISOString(),
                            preview:
                                content.substring(0, SEARCH_CONFIG.PREVIEW_LENGTH).replace(/\n/g, ' ') +
                                (content.length > SEARCH_CONFIG.PREVIEW_LENGTH ? '...' : ''),
                        });
                    }
                } catch {
                    // 单文件读取失败，跳过
                }
            }
        }

        matchedNotes.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

        if (DEBUG_MODE) {
            console.log(`[Search] Completed: ${filesProcessed} files scanned, ${matchedNotes.length} matches`);
        }

        return matchedNotes;
    }

    // ══════════════════════════════════════════════════
    //  带去重、排队、超时、取消的搜索入口
    // ══════════════════════════════════════════════════

    /**
     * @param {string[]} searchTerms
     * @param {string|null} folder
     * @param {AbortSignal} callerSignal - 来自调用方的取消信号（如客户端断开）
     * @returns {Promise<Array>}
     */
    async function queuedSearch(searchTerms, folder, callerSignal) {
        const hash = hashSearchParams(searchTerms, folder);

        // ── 1. 请求去重：如果同样的搜索正在执行，直接复用 ──
        if (inflightSearches.has(hash)) {
            const entry = inflightSearches.get(hash);
            entry.refCount++;
            if (DEBUG_MODE) console.log(`[Search] Reusing inflight: ${hash} (refs: ${entry.refCount})`);

            try {
                return await entry.promise;
            } finally {
                entry.refCount--;
                if (entry.refCount <= 0) {
                    inflightSearches.delete(hash);
                }
            }
        }

        // ── 2. 占位，但用独立的 abort controller ──
        const ac = new AbortController();

        // 如果调用方信号取消，也取消搜索
        const onCallerAbort = () => ac.abort();
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

        // ── 3. 构建搜索 promise（不用 async executor！）──
        const searchPromise = (async () => {
            // 3a. 排队获取槽位（带超时）
            try {
                await searchSemaphore.acquire(SEARCH_CONFIG.QUEUE_WAIT_TIMEOUT_MS);
            } catch (err) {
                throw new Error('Too many concurrent searches, please retry later');
            }

            if (DEBUG_MODE) console.log(`[Search] Acquired slot: ${hash} | ${JSON.stringify(searchSemaphore.stats)}`);

            // 3b. 超时计时器
            const timer = setTimeout(() => ac.abort(), SEARCH_CONFIG.TIMEOUT_MS);

            try {
                return await executeSearch(searchTerms, folder, ac.signal);
            } finally {
                clearTimeout(timer);
                searchSemaphore.release();
                callerSignal?.removeEventListener('abort', onCallerAbort);

                if (DEBUG_MODE) console.log(`[Search] Released slot: ${hash} | ${JSON.stringify(searchSemaphore.stats)}`);
            }
        })();

        // ── 4. 注册去重缓存 ──
        const entry = { promise: searchPromise, refCount: 1 };
        inflightSearches.set(hash, entry);

        try {
            return await searchPromise;
        } finally {
            entry.refCount--;
            if (entry.refCount <= 0) {
                inflightSearches.delete(hash);
            }
        }
    }

    // ══════════════════════════════════════════════════
    //  搜索路由（带客户端断开检测）
    // ══════════════════════════════════════════════════
    router.get('/search', async (req, res) => {
        let { term, folder, limit } = req.query;

        // ── 输入验证 ──
        if (!term || typeof term !== 'string' || term.trim() === '') {
            return res.status(400).json({ error: 'Search term is required.' });
        }

        term = term.trim().substring(0, SEARCH_CONFIG.MAX_SEARCH_TERM_LENGTH);

        let searchTerms = term
            .toLowerCase()
            .split(/\s+/)
            .filter(t => t !== '')
            .slice(0, SEARCH_CONFIG.MAX_KEYWORDS);

        if (searchTerms.length === 0) {
            return res.status(400).json({ error: 'No valid search terms.' });
        }

        if (folder && typeof folder === 'string') {
            folder = folder.trim();
            if (folder.includes('..') || folder.includes('/') || folder.includes('\\')) {
                return res.status(403).json({ error: 'Invalid folder name' });
            }
            if (folder === '') folder = null;
        } else {
            folder = null;
        }

        const maxResults = Math.min(
            parseInt(limit, 10) || SEARCH_CONFIG.MAX_RESULTS,
            SEARCH_CONFIG.MAX_RESULTS
        );

        // ★ 关键：监听客户端断开，自动取消搜索
        const ac = new AbortController();
        const onClose = () => {
            ac.abort();
            if (DEBUG_MODE) console.log('[Search] Client disconnected, aborting search');
        };
        req.on('close', onClose);

        try {
            const notes = await queuedSearch(searchTerms, folder, ac.signal);
            const limited = notes.slice(0, maxResults);

            // 响应前检查连接是否还在
            if (req.destroyed) return;

            res.json({
                notes: limited,
                total: notes.length,
                limited: notes.length > maxResults,
            });
        } catch (err) {
            if (req.destroyed) return; // 客户端已断开，不发响应

            if (err.name === 'AbortError' || ac.signal.aborted) {
                return res.status(499).json({ error: 'Search cancelled' });
            }
            if (err.message.includes('timeout') || err.message.includes('Timeout')) {
                return res.status(504).json({ error: 'Search timed out, try more specific keywords' });
            }
            if (err.message.includes('Too many concurrent')) {
                return res.status(503).json({ error: err.message });
            }
            if (err.code === 'ENOENT') {
                return res.json({ notes: [], total: 0 });
            }

            console.error('[Search] Unexpected error:', err);
            res.status(500).json({ error: 'Search failed', details: err.message });
        } finally {
            req.removeListener('close', onClose);
        }
    });

    // ══════════════════════════════════════════════════
    //  队列状态接口
    // ══════════════════════════════════════════════════
    router.get('/admin/queue-status', (req, res) => {
        res.json({
            ...searchSemaphore.stats,
            inflight: inflightSearches.size,
        });
    });

    // ══════════════════════════════════════════════════
    //  以下为其他路由（folders / folder / note / move / delete 等）
    // ══════════════════════════════════════════════════

    // GET /folders - 获取所有文件夹
    router.get('/folders', async (req, res) => {
        try {
            await fs.access(dailyNoteRootPath);
            const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });

            const folders = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const folderPath = path.join(dailyNoteRootPath, entry.name);
                    if (!(await isSymlink(folderPath))) {
                        folders.push(entry.name);
                    }
                }
            }
            res.json({ folders });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.json({ folders: [] });
            } else {
                res.status(500).json({ error: 'Failed to list folders', details: error.message });
            }
        }
    });

    // GET /folder/:folderName - 获取文件夹内的笔记
    router.get('/folder/:folderName', async (req, res) => {
        const folderName = req.params.folderName;
        const specificFolderPath = path.join(dailyNoteRootPath, folderName);

        if (!isPathSafe(specificFolderPath, dailyNoteRootPath)) {
            return res.status(403).json({ error: 'Invalid folder path' });
        }

        try {
            if (await isSymlink(specificFolderPath)) {
                return res.status(403).json({ error: 'Cannot access symbolic link folders' });
            }

            await fs.access(specificFolderPath);
            const files = await fs.readdir(specificFolderPath);
            const noteFiles = files.filter(file =>
                file.toLowerCase().endsWith('.txt') ||
                file.toLowerCase().endsWith('.md')
            );

            const notes = await Promise.all(noteFiles.map(async (file) => {
                const filePath = path.join(specificFolderPath, file);
                if (await isSymlink(filePath)) return null;

                const stats = await fs.stat(filePath);
                let preview = '';
                try {
                    if (stats.size <= SEARCH_CONFIG.MAX_FILE_SIZE) {
                        const content = await fs.readFile(filePath, 'utf-8');
                        preview = content.substring(0, SEARCH_CONFIG.PREVIEW_LENGTH)
                            .replace(/\n/g, ' ') +
                            (content.length > SEARCH_CONFIG.PREVIEW_LENGTH ? '...' : '');
                    } else {
                        preview = '[文件过大，无法预览]';
                    }
                } catch {
                    preview = '[无法加载预览]';
                }
                return {
                    name: file,
                    lastModified: stats.mtime.toISOString(),
                    preview: preview
                };
            }));

            const validNotes = notes.filter(n => n !== null);
            validNotes.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
            res.json({ notes: validNotes });

        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `Folder '${folderName}' not found.` });
            } else {
                res.status(500).json({ error: `Failed to list notes`, details: error.message });
            }
        }
    });

    // GET /note/:folderName/:fileName - 获取笔记内容
    router.get('/note/:folderName/:fileName', async (req, res) => {
        const { folderName, fileName } = req.params;
        const filePath = path.join(dailyNoteRootPath, folderName, fileName);

        if (!isPathSafe(filePath, dailyNoteRootPath)) {
            return res.status(403).json({ error: 'Invalid file path' });
        }

        try {
            if (await isSymlink(filePath)) {
                return res.status(403).json({ error: 'Cannot read symbolic link files' });
            }
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File not found' });
            } else {
                res.status(500).json({ error: 'Failed to read file', details: error.message });
            }
        }
    });

    // POST /note/:folderName/:fileName - 保存笔记
    router.post('/note/:folderName/:fileName', async (req, res) => {
        const { folderName, fileName } = req.params;
        const { content } = req.body;

        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        if (folderName.includes('..') || fileName.includes('..') ||
            folderName.includes('/') || fileName.includes('/') ||
            folderName.includes('\\') || fileName.includes('\\')) {
            return res.status(403).json({ error: 'Invalid folder or file name' });
        }

        const targetFolderPath = path.join(dailyNoteRootPath, folderName);
        const filePath = path.join(targetFolderPath, fileName);

        if (!isPathSafe(filePath, dailyNoteRootPath)) {
            return res.status(403).json({ error: 'Invalid file path' });
        }

        try {
            await fs.mkdir(targetFolderPath, { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: 'Saved successfully' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to save file', details: error.message });
        }
    });

    // POST /move - 移动笔记
    router.post('/move', async (req, res) => {
        const { sourceNotes, targetFolder } = req.body;

        if (!Array.isArray(sourceNotes) || typeof targetFolder !== 'string') {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        if (targetFolder.includes('..') || targetFolder.includes('/') || targetFolder.includes('\\')) {
            return res.status(403).json({ error: 'Invalid target folder name' });
        }

        const results = { moved: [], errors: [] };
        const targetFolderPath = path.join(dailyNoteRootPath, targetFolder);

        if (!isPathSafe(targetFolderPath, dailyNoteRootPath)) {
            return res.status(403).json({ error: 'Invalid target folder path' });
        }

        try {
            await fs.mkdir(targetFolderPath, { recursive: true });
            for (const note of sourceNotes) {
                if (note.folder.includes('..') || note.file.includes('..')) {
                    results.errors.push({ note: `${note.folder}/${note.file}`, error: 'Invalid path' });
                    continue;
                }

                const sourceFilePath = path.join(dailyNoteRootPath, note.folder, note.file);
                const destinationFilePath = path.join(targetFolderPath, note.file);

                if (!isPathSafe(sourceFilePath, dailyNoteRootPath) || !isPathSafe(destinationFilePath, dailyNoteRootPath)) {
                    results.errors.push({ note: `${note.folder}/${note.file}`, error: 'Invalid path' });
                    continue;
                }

                try {
                    await fs.access(sourceFilePath);
                    try {
                        await fs.access(destinationFilePath);
                        results.errors.push({
                            note: `${note.folder}/${note.file}`,
                            error: `File already exists at destination '${targetFolder}/${note.file}'. Move aborted for this file.`
                        });
                        continue;
                    } catch {
                        // 目标不存在，可以移动
                    }
                    
                    await fs.rename(sourceFilePath, destinationFilePath);
                    results.moved.push(`${note.folder}/${note.file} to ${targetFolder}/${note.file}`);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        results.errors.push({ note: `${note.folder}/${note.file}`, error: 'Source file not found.' });
                    } else {
                        results.errors.push({ note: `${note.folder}/${note.file}`, error: error.message });
                    }
                }
            }
            const message = `Moved ${results.moved.length} note(s). ${results.errors.length > 0 ? `Encountered ${results.errors.length} error(s).` : ''}`;
            res.json({ message, moved: results.moved, errors: results.errors });
        } catch (error) {
            res.status(500).json({ error: 'Move operation failed', details: error.message });
        }
    });

    // POST /delete-batch - 批量删除
    router.post('/delete-batch', async (req, res) => {
        const { notesToDelete } = req.body;
        if (!Array.isArray(notesToDelete)) {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        const results = { deleted: [], errors: [] };
        for (const note of notesToDelete) {
            const filePath = path.join(dailyNoteRootPath, note.folder, note.file);
            if (!isPathSafe(filePath, dailyNoteRootPath)) {
                results.errors.push({ note: `${note.folder}/${note.file}`, error: 'Invalid path' });
                continue;
            }

            try {
                await fs.unlink(filePath);
                results.deleted.push(`${note.folder}/${note.file}`);
            } catch (error) {
                results.errors.push({ note: `${note.folder}/${note.file}`, error: error.message });
            }
        }
        res.json(results);
    });

    // POST /folder/delete - 删除空文件夹
    router.post('/folder/delete', async (req, res) => {
        const { folderName } = req.body;
        if (!folderName) return res.status(400).json({ error: 'Folder name required' });

        const targetFolderPath = path.join(dailyNoteRootPath, folderName);
        if (!isPathSafe(targetFolderPath, dailyNoteRootPath) || targetFolderPath === path.resolve(dailyNoteRootPath)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        try {
            await fs.access(targetFolderPath);
            
            const files = await fs.readdir(targetFolderPath);
            if (files.length > 0) {
                return res.status(400).json({
                    error: `Folder '${folderName}' is not empty.`,
                    message: '为了安全起见，非空文件夹禁止删除。请先删除或移动其中的所有内容。'
                });
            }
            
            await fs.rmdir(targetFolderPath);
            res.json({ message: `Empty folder '${folderName}' has been deleted successfully.` });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `Folder '${folderName}' not found.` });
            } else {
                res.status(500).json({ error: `Failed to delete folder ${folderName}`, details: error.message });
            }
        }
    });

    return router;
};
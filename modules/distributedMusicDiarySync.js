const fs = require('fs').promises;
const path = require('path');

const MUSIC_DIARY_DIR = path.join(__dirname, '..', 'dailynote', 'MusicDiary');
const GARBLED_CHARS = new Set(['乧', '偄', '傛', '偹', '偠', '傞', '怣', '｢', 'ﾊ', 'ｿ', 'ﾈ']);

function sanitizeFilename(name) {
    return String(name || '').replace(/[\\/*?:"<>|]/g, '').trim();
}

function fixGarbledText(value, fallback) {
    const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    if (![...GARBLED_CHARS].some(char => text.includes(char))) {
        return text;
    }

    // Node.js 默认不支持 gbk/shift-jis 转码；这里保持与旧脚本“失败则原样返回”的安全行为。
    return text;
}

function normalizeTitle(title) {
    let normalized = fixGarbledText(title, '未知曲名');
    if (normalized.toLowerCase().endsWith('.mp3')) {
        normalized = normalized.slice(0, -4);
    }
    return normalized.trim() || '未知曲名';
}

function normalizeTrack(track) {
    const title = normalizeTitle(track?.title);
    const artist = fixGarbledText(track?.artist, '未知歌手').trim() || '未知歌手';
    const album = fixGarbledText(track?.album, '未知专辑').trim() || '未知专辑';

    return {
        title,
        artist,
        album,
        filename: `${sanitizeFilename(title)}-${sanitizeFilename(artist)}-${sanitizeFilename(album)}.txt`,
        content: title
    };
}

function buildDesiredMusicFiles(tracks) {
    const desiredFiles = new Map();

    for (const track of tracks) {
        if (!track || typeof track !== 'object') {
            continue;
        }

        const normalized = normalizeTrack(track);
        if (!normalized.filename || normalized.filename === '--.txt') {
            continue;
        }

        // 与旧 process_songs.py 行为一致：同名曲目只需要一个 chunk 文件。
        if (!desiredFiles.has(normalized.filename)) {
            desiredFiles.set(normalized.filename, normalized.content);
        }
    }

    return desiredFiles;
}

async function listExistingMusicChunkFiles() {
    try {
        const entries = await fs.readdir(MUSIC_DIARY_DIR, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
            .map(entry => entry.name);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function syncDistributedMusicDiary(payload, options = {}) {
    const logger = options.logger || console;
    const data = payload && typeof payload === 'object' ? payload : {};
    const serverName = data.serverName || 'unknown-distributed-server';

    if (data.error) {
        logger.warn?.(`[DistributedMusicDiarySync] Skip sync from ${serverName}: playlist payload contains error: ${data.error}`);
        return {
            skipped: true,
            reason: 'payload_error',
            serverName,
            added: [],
            removed: [],
            kept: [],
            targetDir: MUSIC_DIARY_DIR
        };
    }

    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const desiredFiles = buildDesiredMusicFiles(tracks);

    await fs.mkdir(MUSIC_DIARY_DIR, { recursive: true });

    const existingFiles = await listExistingMusicChunkFiles();
    const existingFileSet = new Set(existingFiles);

    const added = [];
    const removed = [];
    const kept = [];

    for (const [filename, content] of desiredFiles.entries()) {
        const targetPath = path.join(MUSIC_DIARY_DIR, filename);
        if (existingFileSet.has(filename)) {
            kept.push(filename);
            continue;
        }

        await fs.writeFile(targetPath, content, 'utf8');
        added.push(filename);
    }

    for (const filename of existingFiles) {
        if (desiredFiles.has(filename)) {
            continue;
        }

        await fs.unlink(path.join(MUSIC_DIARY_DIR, filename));
        removed.push(filename);
    }

    logger.log?.(`[DistributedMusicDiarySync] ${serverName}: added ${added.length}, removed ${removed.length}, kept ${kept.length}, desired ${desiredFiles.size}.`);

    return {
        skipped: false,
        serverName,
        added,
        removed,
        kept,
        desiredCount: desiredFiles.size,
        existingCount: existingFiles.length,
        targetDir: MUSIC_DIARY_DIR
    };
}

module.exports = {
    MUSIC_DIARY_DIR,
    sanitizeFilename,
    normalizeTrack,
    buildDesiredMusicFiles,
    syncDistributedMusicDiary
};
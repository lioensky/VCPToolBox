const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_TOTAL_SIZE = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_SIZE = 512 * 1024 * 1024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

function normalizeZipEntryPath(rawPath) {
    const input = String(rawPath || '');
    if (!input || input.includes('\0')) {
        throw new Error('ZIP 包含空路径或 NUL 字符');
    }

    const slashPath = input.replace(/\\/g, '/');
    if (
        slashPath.startsWith('/') ||
        slashPath.startsWith('//') ||
        /^[A-Za-z]:/.test(slashPath)
    ) {
        throw new Error(`ZIP 包含绝对路径：${input}`);
    }

    const normalized = path.posix.normalize(slashPath);
    if (
        !normalized ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../')
    ) {
        throw new Error(`ZIP 包含越界路径：${input}`);
    }

    return normalized.replace(/\/+$/, '');
}

function getUnixMode(entry) {
    const attributes = Number(entry?.externalFileAttributes);
    if (!Number.isFinite(attributes)) return 0;
    return (attributes >>> 16) & 0xffff;
}

function isSymlinkEntry(entry) {
    return (getUnixMode(entry) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE;
}

function resolveEntryTarget(baseDir, entryPath) {
    const resolvedBase = path.resolve(baseDir);
    const target = path.resolve(resolvedBase, ...entryPath.split('/'));
    if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${path.sep}`)) {
        throw new Error(`ZIP 条目路径越界：${entryPath}`);
    }
    return target;
}

async function extractZipSafely(zipPath, destinationDir, options = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxTotalSize = options.maxTotalSize ?? DEFAULT_MAX_TOTAL_SIZE;
    const maxEntrySize = options.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
    const onEntry = typeof options.onEntry === 'function' ? options.onEntry : null;

    const archive = await unzipper.Open.file(zipPath);
    if (archive.files.length > maxEntries) {
        throw new Error(`ZIP 条目数超过限制（${maxEntries}）`);
    }

    const validatedEntries = [];
    let totalUncompressedSize = 0;

    for (const entry of archive.files) {
        if (isSymlinkEntry(entry)) {
            throw new Error(`ZIP 包含符号链接（不允许）：${entry.path}`);
        }

        const entryPath = normalizeZipEntryPath(entry.path);
        const uncompressedSize = Number(entry.uncompressedSize) || 0;
        if (uncompressedSize < 0 || uncompressedSize > maxEntrySize) {
            throw new Error(`ZIP 单条目大小超过限制：${entry.path}`);
        }

        totalUncompressedSize += uncompressedSize;
        if (totalUncompressedSize > maxTotalSize) {
            throw new Error(`ZIP 解压后总大小超过限制（${maxTotalSize} 字节）`);
        }

        validatedEntries.push({
            entry,
            entryPath,
            target: resolveEntryTarget(destinationDir, entryPath),
            uncompressedSize,
        });
    }

    await fsp.mkdir(destinationDir, { recursive: true });

    for (const item of validatedEntries) {
        if (onEntry) {
            onEntry({
                path: item.entryPath,
                type: item.entry.type,
                uncompressedSize: item.uncompressedSize,
            });
        }

        if (item.entry.type === 'Directory') {
            await fsp.mkdir(item.target, { recursive: true });
            continue;
        }

        await fsp.mkdir(path.dirname(item.target), { recursive: true });
        await pipeline(item.entry.stream(), fs.createWriteStream(item.target, { flags: 'wx' }));
    }

    return {
        entryCount: validatedEntries.length,
        totalUncompressedSize,
    };
}

module.exports = {
    extractZipSafely,
    normalizeZipEntryPath,
    isSymlinkEntry,
};
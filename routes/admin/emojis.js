const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const extract = require('extract-zip');
const tar = require('tar');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const IMAGE_ROOT_DIR = path.join(__dirname, '..', '..', 'image');
const EMOJI_LISTS_DIR = path.join(
    __dirname,
    '..',
    '..',
    'Plugin',
    'EmojiListGenerator',
    'generated_lists'
);
const ROOT_CATEGORY_NAME = '根目录';
const DEFAULT_UPLOAD_CATEGORY = '本地上传表情包';
const MAX_UPLOAD_FILES = 40;
const MAX_UPLOAD_FILE_SIZE = 8 * 1024 * 1024;
const MAX_ARCHIVE_UPLOAD_FILE_SIZE = 200 * 1024 * 1024;
const MAX_MULTER_FILE_SIZE = Math.max(
    MAX_UPLOAD_FILE_SIZE,
    MAX_ARCHIVE_UPLOAD_FILE_SIZE
);
const MAX_EXTRACTED_TOTAL_SIZE = 500 * 1024 * 1024;
const MAX_EXTRACTED_FILE_COUNT = 2000;
const GALLERY_CACHE_TTL_MS = 30_000;
const GALLERY_FORCE_REFRESH_COOLDOWN_MS = 5_000;
const TMP_UPLOAD_DIR = path.join(__dirname, '..', '..', 'tmp', 'emoji-upload');
const THUMBNAIL_CACHE_DIR = path.join(__dirname, '..', '..', 'tmp', 'emoji-thumb-cache');
const DEFAULT_THUMBNAIL_SIZE = 320;
const MIN_THUMBNAIL_SIZE = 96;
const MAX_THUMBNAIL_SIZE = 640;
const THUMBNAIL_CACHE_VERSION = 1;
const ALLOWED_IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
]);
const ALLOWED_ARCHIVE_EXTENSIONS = new Set([
    '.zip',
    '.tar',
    '.tar.gz',
    '.tgz',
]);

const TRUE_LIKE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const galleryScanCache = {
    entries: null,
    expiresAt: 0,
    scannedAt: 0,
    lastForceRefreshAt: 0,
    pendingPromise: null,
};

const MIME_EXTENSION_MAP = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
};

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function parsePositiveInt(rawValue, fallback, max = 500) {
    const parsed = Number.parseInt(String(rawValue ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function compareText(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
    });
}

function buildPreviewUrl(relativePath) {
    return `/admin_api/emojis/file?path=${encodeURIComponent(relativePath)}`;
}

function buildThumbnailUrl(relativePath, size = DEFAULT_THUMBNAIL_SIZE) {
    return `/admin_api/emojis/file?path=${encodeURIComponent(relativePath)}&variant=thumb&size=${size}`;
}

function parseBooleanValue(rawValue, fallback = false) {
    if (typeof rawValue === 'boolean') {
        return rawValue;
    }

    if (typeof rawValue !== 'string') {
        return fallback;
    }

    return TRUE_LIKE_VALUES.has(rawValue.trim().toLowerCase());
}

function parseThumbnailSize(rawValue, fallback = DEFAULT_THUMBNAIL_SIZE) {
    const parsed = parsePositiveInt(rawValue, fallback, MAX_THUMBNAIL_SIZE);
    return Math.max(parsed, MIN_THUMBNAIL_SIZE);
}

function sanitizeCategoryName(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    const trimmed = rawValue.trim();
    if (!trimmed || trimmed.length > 80) {
        return null;
    }

    if (/[\\/\0]/.test(trimmed) || trimmed.includes('..')) {
        return null;
    }

    return trimmed;
}

function deriveArchiveRootDirectoryName(rawFileName) {
    const archiveExtension = getArchiveExtension(rawFileName);
    const baseName = path.basename(String(rawFileName || ''), archiveExtension || undefined).trim();
    const safeName = sanitizeCategoryName(baseName);
    if (safeName) {
        return safeName;
    }

    return `压缩包导入-${Date.now()}`;
}

function sanitizeFileName(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    const baseName = path.basename(rawValue).trim();
    if (!baseName) {
        return null;
    }

    const safeName = baseName
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/[\x00-\x1f]/g, '')
        .trim();

    if (!safeName) {
        return null;
    }

    return safeName.slice(0, 180);
}

function extensionFromMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
        return null;
    }

    return MIME_EXTENSION_MAP[mimeType.toLowerCase()] || null;
}

function parseUploadMode(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (normalized === 'files' || normalized === 'folder' || normalized === 'archive') {
        return normalized;
    }

    return null;
}

function parseRelativePathsField(rawValue) {
    if (!rawValue) {
        return [];
    }

    if (Array.isArray(rawValue)) {
        return rawValue.map((value) => String(value));
    }

    if (typeof rawValue === 'string') {
        try {
            const parsed = JSON.parse(rawValue);
            if (Array.isArray(parsed)) {
                return parsed.map((value) => String(value));
            }
            return [rawValue];
        } catch {
            return [rawValue];
        }
    }

    return [];
}

function getArchiveExtension(fileNameOrPath) {
    const lower = String(fileNameOrPath || '').toLowerCase();
    if (lower.endsWith('.tar.gz')) {
        return '.tar.gz';
    }

    if (lower.endsWith('.tgz')) {
        return '.tgz';
    }

    if (lower.endsWith('.tar')) {
        return '.tar';
    }

    if (lower.endsWith('.zip')) {
        return '.zip';
    }

    return '';
}

function detectArchiveFormat(fileNameOrPath) {
    const extension = getArchiveExtension(fileNameOrPath);
    if (extension === '.zip') {
        return 'zip';
    }

    if (extension === '.tar' || extension === '.tar.gz' || extension === '.tgz') {
        return 'tar';
    }

    return null;
}

function isSupportedArchiveName(fileNameOrPath) {
    return ALLOWED_ARCHIVE_EXTENSIONS.has(getArchiveExtension(fileNameOrPath));
}

function safeJoin(baseDir, relativePath) {
    const normalized = sanitizeRelativePath(relativePath);
    if (!normalized) {
        throw new Error(`Invalid path: ${relativePath}`);
    }

    const target = path.resolve(baseDir, normalized);
    const resolvedBase = path.resolve(baseDir);
    if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${path.sep}`)) {
        throw new Error(`Unsafe path: ${relativePath}`);
    }

    return target;
}

async function assertSafeExtractedTree(baseDir) {
    const resolvedBase = path.resolve(baseDir);
    const queue = [resolvedBase];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error('压缩包包含符号链接，已拒绝导入');
            }

            const realPath = await fs.realpath(absolutePath);
            if (realPath !== resolvedBase && !realPath.startsWith(`${resolvedBase}${path.sep}`)) {
                throw new Error('压缩包包含越界路径，已拒绝导入');
            }

            if (entry.isDirectory()) {
                queue.push(absolutePath);
            }
        }
    }
}

async function collectImageCandidatesFromDir(rootDir) {
    const result = [];
    const queue = [{ absoluteDir: rootDir, relativeDir: '' }];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        const entries = await fs.readdir(current.absoluteDir, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(current.absoluteDir, entry.name);
            const relativePath = current.relativeDir
                ? `${current.relativeDir}/${entry.name}`
                : entry.name;

            if (entry.isDirectory()) {
                queue.push({
                    absoluteDir: absolutePath,
                    relativeDir: relativePath,
                });
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension = path.extname(entry.name).toLowerCase();
            if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
                continue;
            }

            const stat = await fs.stat(absolutePath);
            result.push({
                sourcePath: absolutePath,
                relativePath: toPosixPath(relativePath),
                extension,
                size: stat.size,
                isTempUploadFile: false,
            });
        }
    }

    return result;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function createThumbnailCacheKey(relativePath, size, stat) {
    return crypto
        .createHash('sha1')
        .update(
            [
                THUMBNAIL_CACHE_VERSION,
                relativePath,
                size,
                Math.round(Number(stat?.mtimeMs) || 0),
                Number(stat?.size) || 0,
            ].join(':')
        )
        .digest('hex');
}

async function renderThumbnailToCache(sourcePath, relativePath, stat, size) {
    await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });

    const cacheKey = createThumbnailCacheKey(relativePath, size, stat);
    const cachedPath = path.join(THUMBNAIL_CACHE_DIR, `${cacheKey}.png`);
    if (await pathExists(cachedPath)) {
        return cachedPath;
    }

    const image = await loadImage(sourcePath);
    const sourceWidth = Math.max(1, Math.round(image.width || size));
    const sourceHeight = Math.max(1, Math.round(image.height || size));
    const longestSide = Math.max(sourceWidth, sourceHeight);
    const scale = Math.min(1, size / longestSide);
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = createCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    const tempPath = path.join(
        THUMBNAIL_CACHE_DIR,
        `${cacheKey}.${process.pid}.${Date.now()}.tmp`
    );
    const buffer = canvas.toBuffer('image/png');
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, cachedPath).catch(async (error) => {
        if (error && error.code === 'EEXIST') {
            await safeUnlink(tempPath);
            return;
        }

        throw error;
    });

    return cachedPath;
}

async function safeUnlink(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') {
        return;
    }

    try {
        await fs.unlink(targetPath);
    } catch (error) {
        if (!error || error.code !== 'ENOENT') {
            console.warn('[EmojisRoute] Failed to cleanup temp upload file:', targetPath, error);
        }
    }
}

async function createUniqueFileName(targetDir, preferredName) {
    const parsed = path.parse(preferredName);
    const safeExt = parsed.ext.toLowerCase();
    const safeBaseName = (parsed.name || 'emoji').trim().slice(0, 120) || 'emoji';

    let counter = 0;
    while (counter < 5000) {
        const suffix = counter === 0 ? '' : `-${counter}`;
        const candidateName = `${safeBaseName}${suffix}${safeExt}`;
        const candidatePath = path.join(targetDir, candidateName);
        // eslint-disable-next-line no-await-in-loop
        const exists = await pathExists(candidatePath);
        if (!exists) {
            return candidateName;
        }
        counter += 1;
    }

    return `${safeBaseName}-${Date.now()}${safeExt}`;
}

function shouldTreatAsEmojiPack(categoryName) {
    return typeof categoryName === 'string' && categoryName.endsWith('表情包');
}

function resetGalleryCache() {
    galleryScanCache.entries = null;
    galleryScanCache.expiresAt = 0;
    galleryScanCache.scannedAt = 0;
}

async function getCachedGalleryEntries(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const now = Date.now();

    if (
        !forceRefresh &&
        Array.isArray(galleryScanCache.entries) &&
        now < galleryScanCache.expiresAt
    ) {
        return galleryScanCache.entries;
    }

    if (galleryScanCache.pendingPromise) {
        return galleryScanCache.pendingPromise;
    }

    galleryScanCache.pendingPromise = collectImageEntries(IMAGE_ROOT_DIR)
        .then((entries) =>
            entries.sort((left, right) => {
                const categoryCompare = compareText(left.category, right.category);
                if (categoryCompare !== 0) {
                    return categoryCompare;
                }
                return compareText(left.name, right.name);
            })
        )
        .then((entries) => {
            const scannedAt = Date.now();
            galleryScanCache.entries = entries;
            galleryScanCache.scannedAt = scannedAt;
            galleryScanCache.expiresAt = scannedAt + GALLERY_CACHE_TTL_MS;
            return entries;
        })
        .finally(() => {
            galleryScanCache.pendingPromise = null;
        });

    return galleryScanCache.pendingPromise;
}

async function extractArchiveSafely(archiveFormat, archiveFilePath, extractDir) {
    let totalUncompressedSize = 0;
    let entryCount = 0;

    const checkEntryBudget = (entrySize) => {
        entryCount += 1;
        if (entryCount > MAX_EXTRACTED_FILE_COUNT) {
            throw new Error(`压缩包条目数超过限制（${MAX_EXTRACTED_FILE_COUNT}）`);
        }

        const sizeValue = Number(entrySize) || 0;
        totalUncompressedSize += sizeValue;
        if (totalUncompressedSize > MAX_EXTRACTED_TOTAL_SIZE) {
            throw new Error(
                `压缩包解压后总大小超过限制（${Math.floor(MAX_EXTRACTED_TOTAL_SIZE / 1024 / 1024)}MB）`
            );
        }
    };

    if (archiveFormat === 'zip') {
        await extract(archiveFilePath, {
            dir: extractDir,
            onEntry(entry) {
                checkEntryBudget(entry && entry.uncompressedSize);
            },
        });
        return;
    }

    await tar.x({
        file: archiveFilePath,
        cwd: extractDir,
        strict: true,
        onentry(entry) {
            checkEntryBudget(entry && entry.size);
        },
    });
}

async function rebuildEmojiGeneratedLists() {
    await fs.mkdir(EMOJI_LISTS_DIR, { recursive: true });

    const sourceEntries = await fs.readdir(IMAGE_ROOT_DIR, { withFileTypes: true });
    const emojiDirs = sourceEntries
        .filter((entry) => entry.isDirectory() && shouldTreatAsEmojiPack(entry.name))
        .map((entry) => entry.name)
        .sort(compareText);

    const packs = [];
    for (const packName of emojiDirs) {
        const packDirPath = path.join(IMAGE_ROOT_DIR, packName);
        const packEntries = await fs.readdir(packDirPath, { withFileTypes: true });
        const imageFiles = packEntries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((fileName) => ALLOWED_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
            .sort(compareText);

        const targetFilePath = path.join(EMOJI_LISTS_DIR, `${packName}.txt`);
        await fs.writeFile(targetFilePath, imageFiles.join('|'), 'utf-8');

        packs.push({
            name: packName,
            count: imageFiles.length,
            filePath: targetFilePath,
        });
    }

    return {
        generatedCount: packs.length,
        packs,
    };
}

function sanitizeRelativePath(rawPath) {
    if (typeof rawPath !== 'string') {
        return null;
    }

    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0')) {
        return null;
    }

    const normalized = path.posix
        .normalize(trimmed.replace(/\\/g, '/'))
        .replace(/^\/+/, '');

    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        return null;
    }

    return normalized;
}

function inferCategoryFromRelativePath(rawRelativePath) {
    const normalized = sanitizeRelativePath(rawRelativePath);
    if (!normalized) {
        return ROOT_CATEGORY_NAME;
    }

    const [topLevelName] = normalized.split('/');
    return topLevelName || ROOT_CATEGORY_NAME;
}

function resolveInsideRoot(rootDir, rawRelativePath) {
    const safeRelativePath = sanitizeRelativePath(rawRelativePath);
    if (!safeRelativePath) {
        return null;
    }

    const resolvedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(resolvedRoot, safeRelativePath);
    const isInsideRoot =
        resolvedPath === resolvedRoot ||
        resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

    if (!isInsideRoot) {
        return null;
    }

    return {
        safeRelativePath,
        resolvedPath,
    };
}

async function collectImageEntries(rootDir) {
    const entries = [];
    const queue = [{ absoluteDir: rootDir, relativeDir: '' }];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        let dirEntries;
        try {
            dirEntries = await fs.readdir(current.absoluteDir, { withFileTypes: true });
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }

        for (const dirEntry of dirEntries) {
            const absolutePath = path.join(current.absoluteDir, dirEntry.name);
            const relativePath = current.relativeDir
                ? `${current.relativeDir}/${dirEntry.name}`
                : dirEntry.name;

            if (dirEntry.isDirectory()) {
                queue.push({
                    absoluteDir: absolutePath,
                    relativeDir: relativePath,
                });
                continue;
            }

            if (!dirEntry.isFile()) {
                continue;
            }

            const extension = path.extname(dirEntry.name).toLowerCase();
            if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
                continue;
            }

            const normalizedRelativePath = toPosixPath(relativePath);
            const pathSegments = normalizedRelativePath.split('/');
            const category = pathSegments.length > 1
                ? pathSegments[0]
                : ROOT_CATEGORY_NAME;

            entries.push({
                name: dirEntry.name,
                relativePath: normalizedRelativePath,
                category,
                extension: extension.slice(1),
                previewUrl: buildPreviewUrl(normalizedRelativePath),
                thumbnailUrl: buildThumbnailUrl(normalizedRelativePath),
            });
        }
    }

    return entries;
}

module.exports = function(options) {
    const router = express.Router();
    const uploadStorage = multer.diskStorage({
        destination(req, file, callback) {
            fs.mkdir(TMP_UPLOAD_DIR, { recursive: true })
                .then(() => callback(null, TMP_UPLOAD_DIR))
                .catch((error) => callback(error));
        },
        filename(req, file, callback) {
            const safeName = sanitizeFileName(file.originalname) || 'emoji-upload.bin';
            const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            callback(null, `${uniquePrefix}-${safeName}`);
        },
    });
    const upload = multer({
        storage: uploadStorage,
        limits: {
            files: MAX_UPLOAD_FILES,
            fileSize: MAX_MULTER_FILE_SIZE,
        },
    });

    async function respondEmojiList(req, res) {
        try {
            // 确保目录存在
            await fs.mkdir(EMOJI_LISTS_DIR, { recursive: true });
            
            const files = await fs.readdir(EMOJI_LISTS_DIR);
            const result = {};

            for (const file of files) {
                if (file.toLowerCase().endsWith('.txt')) {
                    const categoryName = path.basename(file, '.txt');
                    const filePath = path.join(EMOJI_LISTS_DIR, file);
                    
                    try {
                        const content = await fs.readFile(filePath, 'utf-8');
                        // 过滤掉空字符串（处理末尾分隔符或空文件）
                        const emojiNames = content.split('|').filter(name => name.trim().length > 0);
                        result[categoryName] = emojiNames;
                    } catch (readError) {
                        console.error(`[EmojisRoute] Failed to read emoji list file ${file}:`, readError);
                        // 如果读取失败，跳过该分类或标记为错误
                    }
                }
            }

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            console.error('[EmojisRoute] Error scanning emoji lists:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to list emojis',
            });
        }
    }

    /**
     * GET /emojis/list
     * 返回所有表情包类别及其包含的文件名列表
     */
    router.get('/emojis/list', respondEmojiList);

    /**
     * POST /emojis/list
     * 别名，方便某些场景下的 POST 调用，功能相同
     */
    router.post('/emojis/list', respondEmojiList);

    /**
     * POST /emojis/list/rebuild
     * 根据 image 目录实时重建 EmojiListGenerator 的 generated_lists 文件
     */
    router.post('/emojis/list/rebuild', async (req, res) => {
        try {
            const rebuildResult = await rebuildEmojiGeneratedLists();
            resetGalleryCache();

            res.json({
                success: true,
                data: rebuildResult,
            });
        } catch (error) {
            console.error('[EmojisRoute] Error rebuilding generated emoji lists:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to rebuild generated emoji lists',
            });
        }
    });

    /**
     * POST /emojis/category/create
     * 创建 image 下一级目录，用于上传分类
     */
    router.post('/emojis/category/create', async (req, res) => {
        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        const categoryName = sanitizeCategoryName(rawName);
        if (!categoryName) {
            return res.status(400).json({
                success: false,
                error: '目录名称不合法，请使用长度不超过 80 的普通目录名',
            });
        }

        try {
            const targetDir = path.join(IMAGE_ROOT_DIR, categoryName);
            const existed = await pathExists(targetDir);
            await fs.mkdir(targetDir, { recursive: true });
            resetGalleryCache();

            return res.json({
                success: true,
                data: {
                    name: categoryName,
                    existed,
                },
            });
        } catch (error) {
            console.error('[EmojisRoute] Error creating category directory:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to create category directory',
            });
        }
    });

    /**
     * GET /emojis/gallery
     * 扫描 image 目录并返回表情包文件列表（支持分页/分类/搜索）
     */
    router.get('/emojis/gallery', async (req, res) => {
        const pageSize = parsePositiveInt(req.query.pageSize, 80, 500);
        const requestedPage = parsePositiveInt(req.query.page, 1, 1_000_000);
        const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
        const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
        const forceRefreshRequested = parseBooleanValue(req.query.refresh, false);
        let forceRefresh = forceRefreshRequested;
        if (forceRefreshRequested) {
            const now = Date.now();
            const stillInCooldown =
                galleryScanCache.lastForceRefreshAt > 0 &&
                now - galleryScanCache.lastForceRefreshAt < GALLERY_FORCE_REFRESH_COOLDOWN_MS;

            if (stillInCooldown) {
                forceRefresh = false;
            } else {
                galleryScanCache.lastForceRefreshAt = now;
            }
        }

        try {
            const allEntries = await getCachedGalleryEntries({ forceRefresh });
            const categoryTotals = new Map();

            for (const entry of allEntries) {
                categoryTotals.set(entry.category, (categoryTotals.get(entry.category) || 0) + 1);
            }

            let topLevelDirEntries = [];
            try {
                topLevelDirEntries = await fs.readdir(IMAGE_ROOT_DIR, { withFileTypes: true });
            } catch (readDirError) {
                if (!readDirError || readDirError.code !== 'ENOENT') {
                    throw readDirError;
                }
            }

            for (const dirEntry of topLevelDirEntries) {
                if (!dirEntry.isDirectory()) {
                    continue;
                }

                if (!categoryTotals.has(dirEntry.name)) {
                    categoryTotals.set(dirEntry.name, 0);
                }
            }

            let filteredEntries = allEntries;

            if (category) {
                filteredEntries = filteredEntries.filter((entry) => entry.category === category);
            }

            if (keyword) {
                const needle = keyword.toLowerCase();
                filteredEntries = filteredEntries.filter((entry) =>
                    entry.name.toLowerCase().includes(needle) ||
                    entry.relativePath.toLowerCase().includes(needle)
                );
            }

            const filteredCategoryTotals = new Map();
            for (const entry of filteredEntries) {
                filteredCategoryTotals.set(
                    entry.category,
                    (filteredCategoryTotals.get(entry.category) || 0) + 1
                );
            }

            const total = filteredEntries.length;
            const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
            const page = Math.min(requestedPage, totalPages);
            const start = (page - 1) * pageSize;
            const end = start + pageSize;
            const pagedItems = filteredEntries.slice(start, end);

            const categories = Array.from(categoryTotals.entries())
                .map(([name, totalCount]) => ({
                    name,
                    totalCount,
                    matchedCount: filteredCategoryTotals.get(name) || 0,
                }))
                .sort((left, right) => compareText(left.name, right.name));

            res.json({
                success: true,
                data: {
                    items: pagedItems,
                    categories,
                    total,
                    page,
                    pageSize,
                    totalPages,
                    filters: {
                        category: category || null,
                        keyword: keyword || null,
                    },
                    cache: {
                        scannedAt: galleryScanCache.scannedAt || null,
                        expiresAt: galleryScanCache.expiresAt || null,
                        ttlMs: GALLERY_CACHE_TTL_MS,
                        refreshRequested: forceRefreshRequested,
                        refreshApplied: forceRefresh,
                        refreshCooldownMs: GALLERY_FORCE_REFRESH_COOLDOWN_MS,
                    },
                },
            });
        } catch (error) {
            console.error('[EmojisRoute] Error scanning image emoji gallery:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to list image emojis',
            });
        }
    });

    /**
     * POST /emojis/upload
     * 上传本地表情包图片到 image 目录，支持上传后可选重建 generated_lists
     */
    router.post('/emojis/upload', (req, res) => {
        upload.array('files', MAX_UPLOAD_FILES)(req, res, async (uploadError) => {
            if (uploadError) {
                if (uploadError instanceof multer.MulterError) {
                    if (uploadError.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({
                            success: false,
                            error: `单文件大小超过限制（图片 ${Math.floor(MAX_UPLOAD_FILE_SIZE / 1024 / 1024)}MB，压缩包 ${Math.floor(MAX_ARCHIVE_UPLOAD_FILE_SIZE / 1024 / 1024)}MB）`,
                        });
                    }
                    if (uploadError.code === 'LIMIT_FILE_COUNT') {
                        return res.status(400).json({
                            success: false,
                            error: `上传文件数量超过限制（最多 ${MAX_UPLOAD_FILES} 个）`,
                        });
                    }

                    return res.status(400).json({
                        success: false,
                        error: '上传失败，请检查文件后重试',
                    });
                }

                return res.status(400).json({
                    success: false,
                    error: '上传失败，请检查文件后重试',
                });
            }

            const files = Array.isArray(req.files) ? req.files : [];
            if (files.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: '未接收到文件，请使用 files 字段上传',
                });
            }

            const uploadModeHint = parseUploadMode(req.body?.uploadMode);
            const uploadRelativePaths = parseRelativePathsField(req.body?.relPaths);
            const resolvedUploadMode = uploadModeHint || (
                files.length === 1 && isSupportedArchiveName(files[0].originalname)
                    ? 'archive'
                    : uploadRelativePaths.length > 0
                        ? 'folder'
                        : 'files'
            );

            const pendingTempPaths = new Set(
                files
                    .map((file) => (typeof file?.path === 'string' ? file.path : null))
                    .filter((tempPath) => Boolean(tempPath))
            );
            const temporaryExtractDirs = new Set();

            const rawCategory = typeof req.body?.category === 'string'
                ? req.body.category
                : DEFAULT_UPLOAD_CATEGORY;
            const sanitizedCategory = sanitizeCategoryName(rawCategory);
            const shouldPreserveSourceTree =
                resolvedUploadMode === 'folder' || resolvedUploadMode === 'archive';
            if (!shouldPreserveSourceTree && !sanitizedCategory) {
                for (const tempPath of pendingTempPaths) {
                    // eslint-disable-next-line no-await-in-loop
                    await safeUnlink(tempPath);
                }

                return res.status(400).json({
                    success: false,
                    error: '目标分类目录不合法，请使用长度不超过 80 的普通目录名',
                });
            }

            const targetCategory = sanitizedCategory || DEFAULT_UPLOAD_CATEGORY;
            const shouldSyncGeneratedLists = parseBooleanValue(req.body?.syncList, true);

            const targetDir = path.join(IMAGE_ROOT_DIR, targetCategory);
            const uploaded = [];
            const rejected = [];
            const uploadCandidates = [];

            try {
                if (resolvedUploadMode === 'archive') {
                    if (files.length !== 1) {
                        return res.status(400).json({
                            success: false,
                            error: '压缩包模式仅支持单文件上传',
                        });
                    }

                    const archiveFile = files[0];
                    const archiveFormat = detectArchiveFormat(archiveFile.originalname);
                    if (!archiveFormat) {
                        return res.status(400).json({
                            success: false,
                            error: '仅支持 .zip / .tar / .tar.gz / .tgz 压缩包',
                        });
                    }

                    if (archiveFile.size > MAX_ARCHIVE_UPLOAD_FILE_SIZE) {
                        return res.status(413).json({
                            success: false,
                            error: `压缩包大小超过限制（${Math.floor(MAX_ARCHIVE_UPLOAD_FILE_SIZE / 1024 / 1024)}MB）`,
                        });
                    }

                    const extractDir = path.join(
                        TMP_UPLOAD_DIR,
                        `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                    );
                    temporaryExtractDirs.add(extractDir);
                    await fs.mkdir(extractDir, { recursive: true });

                    if (archiveFormat === 'zip') {
                        await extractArchiveSafely('zip', archiveFile.path, extractDir);
                    } else {
                        await extractArchiveSafely('tar', archiveFile.path, extractDir);
                    }

                    await assertSafeExtractedTree(extractDir);

                    const archiveRootDirectoryName = deriveArchiveRootDirectoryName(archiveFile.originalname);
                    const archiveCandidates = await collectImageCandidatesFromDir(extractDir);
                    if (archiveCandidates.length === 0) {
                        return res.status(400).json({
                            success: false,
                            error: '压缩包中未发现可导入的图片文件',
                        });
                    }

                    uploadCandidates.push(...archiveCandidates.map((entry) => ({
                        sourcePath: entry.sourcePath,
                        relativePath: toPosixPath(entry.relativePath).includes('/')
                            ? toPosixPath(entry.relativePath)
                            : `${archiveRootDirectoryName}/${toPosixPath(entry.relativePath)}`,
                        extension: entry.extension,
                        size: entry.size,
                        isTempUploadFile: false,
                        originalName: path.basename(entry.relativePath),
                    })));

                    if (archiveFile.path) {
                        pendingTempPaths.delete(archiveFile.path);
                        await safeUnlink(archiveFile.path);
                    }
                } else {
                    if (
                        resolvedUploadMode === 'folder' &&
                        uploadRelativePaths.length > 0 &&
                        uploadRelativePaths.length !== files.length
                    ) {
                        return res.status(400).json({
                            success: false,
                            error: '文件夹上传的路径映射数量与文件数量不一致',
                        });
                    }

                    for (const [index, file] of files.entries()) {
                        const tempPath = typeof file.path === 'string' ? file.path : null;
                        const rawRelativePath = resolvedUploadMode === 'folder'
                            ? (uploadRelativePaths[index] || file.originalname)
                            : file.originalname;
                        const safeRelativePath = sanitizeRelativePath(rawRelativePath);

                        if (!safeRelativePath) {
                            rejected.push({
                                fileName: file.originalname,
                                reason: '文件路径不合法',
                            });

                            if (tempPath) {
                                pendingTempPaths.delete(tempPath);
                                // eslint-disable-next-line no-await-in-loop
                                await safeUnlink(tempPath);
                            }
                            continue;
                        }

                        const extension = path.extname(safeRelativePath).toLowerCase() || extensionFromMimeType(file.mimetype);
                        if (!extension || !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
                            rejected.push({
                                fileName: file.originalname,
                                reason: `不支持的格式：${extension || 'unknown'}`,
                            });

                            if (tempPath) {
                                pendingTempPaths.delete(tempPath);
                                // eslint-disable-next-line no-await-in-loop
                                await safeUnlink(tempPath);
                            }
                            continue;
                        }

                        if (file.size > MAX_UPLOAD_FILE_SIZE) {
                            rejected.push({
                                fileName: file.originalname,
                                reason: `单文件超过限制（${Math.floor(MAX_UPLOAD_FILE_SIZE / 1024 / 1024)}MB）`,
                            });

                            if (tempPath) {
                                pendingTempPaths.delete(tempPath);
                                // eslint-disable-next-line no-await-in-loop
                                await safeUnlink(tempPath);
                            }
                            continue;
                        }

                        uploadCandidates.push({
                            sourcePath: tempPath,
                            relativePath: toPosixPath(safeRelativePath),
                            extension,
                            size: file.size,
                            isTempUploadFile: true,
                            originalName: file.originalname,
                        });
                    }
                }

                if (uploadCandidates.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: '没有可保存的图片文件',
                        data: {
                            uploadedCount: 0,
                            rejectedCount: rejected.length,
                            rejected,
                        },
                    });
                }

                if (!shouldPreserveSourceTree) {
                    await fs.mkdir(targetDir, { recursive: true });
                }
                const seenRelativePaths = new Set();

                for (const [index, candidate] of uploadCandidates.entries()) {
                    const safeRelativePath = sanitizeRelativePath(candidate.relativePath);
                    if (!safeRelativePath) {
                        rejected.push({
                            fileName: candidate.originalName,
                            reason: '文件路径不合法',
                        });
                        continue;
                    }

                    const parsed = path.parse(safeRelativePath);
                    const extension = candidate.extension || parsed.ext.toLowerCase();
                    if (!extension || !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
                        rejected.push({
                            fileName: candidate.originalName,
                            reason: `不支持的格式：${extension || 'unknown'}`,
                        });
                        continue;
                    }

                    const normalizedName = `${parsed.name || `emoji-${Date.now()}-${index}`}${extension}`;
                    const safeName = sanitizeFileName(normalizedName) || `emoji-${Date.now()}-${index}${extension}`;

                    let storedName = safeName;
                    let storedPath;

                    if (shouldPreserveSourceTree) {
                        const dedupeRelativePath = toPosixPath(
                            parsed.dir ? `${parsed.dir}/${safeName}` : safeName
                        );
                        if (seenRelativePaths.has(dedupeRelativePath)) {
                            rejected.push({
                                fileName: candidate.originalName,
                                reason: '同名文件在本次上传中重复，已自动去重',
                            });
                            continue;
                        }
                        seenRelativePaths.add(dedupeRelativePath);

                        const destinationDir = parsed.dir
                            ? safeJoin(IMAGE_ROOT_DIR, toPosixPath(parsed.dir))
                            : IMAGE_ROOT_DIR;
                        // eslint-disable-next-line no-await-in-loop
                        await fs.mkdir(destinationDir, { recursive: true });

                        storedPath = path.join(destinationDir, safeName);
                        // eslint-disable-next-line no-await-in-loop
                        const exists = await pathExists(storedPath);
                        if (exists) {
                            rejected.push({
                                fileName: candidate.originalName,
                                reason: '同名文件已存在，已自动去重跳过',
                            });

                            if (candidate.isTempUploadFile && candidate.sourcePath) {
                                pendingTempPaths.delete(candidate.sourcePath);
                                // eslint-disable-next-line no-await-in-loop
                                await safeUnlink(candidate.sourcePath);
                            }
                            continue;
                        }
                    } else {
                        const relativeDir = parsed.dir ? toPosixPath(parsed.dir) : '';
                        const destinationDir = relativeDir
                            ? safeJoin(targetDir, relativeDir)
                            : targetDir;
                        // eslint-disable-next-line no-await-in-loop
                        await fs.mkdir(destinationDir, { recursive: true });

                        // eslint-disable-next-line no-await-in-loop
                        storedName = await createUniqueFileName(destinationDir, safeName);
                        storedPath = path.join(destinationDir, storedName);
                    }

                    if (candidate.isTempUploadFile && candidate.sourcePath) {
                        // eslint-disable-next-line no-await-in-loop
                        await fs.rename(candidate.sourcePath, storedPath).catch(async (moveError) => {
                            if (moveError && moveError.code === 'EXDEV') {
                                await fs.copyFile(candidate.sourcePath, storedPath);
                                await safeUnlink(candidate.sourcePath);
                                return;
                            }
                            throw moveError;
                        });

                        pendingTempPaths.delete(candidate.sourcePath);
                    } else if (candidate.sourcePath) {
                        // eslint-disable-next-line no-await-in-loop
                        await fs.copyFile(candidate.sourcePath, storedPath);
                    } else {
                        rejected.push({
                            fileName: candidate.originalName,
                            reason: '上传文件缺少可写入的数据',
                        });
                        continue;
                    }

                    const relativePath = toPosixPath(path.relative(IMAGE_ROOT_DIR, storedPath));
                    const uploadedCategory = inferCategoryFromRelativePath(relativePath);
                    uploaded.push({
                        name: storedName,
                        relativePath,
                        category: uploadedCategory,
                        extension: extension.slice(1),
                        previewUrl: buildPreviewUrl(relativePath),
                        thumbnailUrl: buildThumbnailUrl(relativePath),
                        size: candidate.size,
                    });
                }

                if (uploaded.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: '没有可保存的图片文件',
                        data: {
                            uploadedCount: 0,
                            rejectedCount: rejected.length,
                            rejected,
                        },
                    });
                }

                const uploadedCategories = Array.from(
                    new Set(uploaded.map((entry) => entry.category).filter((value) => Boolean(value)))
                );
                const hasEmojiPackCategory = uploadedCategories.some(
                    (categoryName) =>
                        categoryName !== ROOT_CATEGORY_NAME && shouldTreatAsEmojiPack(categoryName)
                );
                const responseCategory = shouldPreserveSourceTree
                    ? (uploadedCategories[0] || ROOT_CATEGORY_NAME)
                    : targetCategory;

                let listSync = {
                    enabled: shouldSyncGeneratedLists,
                    generatedCount: 0,
                    packs: [],
                    warning: null,
                };

                if (shouldSyncGeneratedLists) {
                    try {
                        const rebuildResult = await rebuildEmojiGeneratedLists();
                        listSync = {
                            ...listSync,
                            generatedCount: rebuildResult.generatedCount,
                            packs: rebuildResult.packs,
                            warning: hasEmojiPackCategory
                                ? null
                                : shouldPreserveSourceTree
                                    ? '导入目录均不以“表情包”结尾，不会参与 EmojiListGenerator 的占位符列表。'
                                    : '当前上传目录名称不以“表情包”结尾，不会参与 EmojiListGenerator 的占位符列表。',
                        };
                    } catch (rebuildError) {
                        console.error('[EmojisRoute] Uploaded but failed to rebuild generated lists:', rebuildError);
                        listSync = {
                            ...listSync,
                            warning: '上传成功，但重建列表失败，请稍后手动重建。',
                        };
                    }
                }

                resetGalleryCache();

                res.json({
                    success: true,
                    data: {
                        category: responseCategory,
                        categories: uploadedCategories,
                        uploadedCount: uploaded.length,
                        rejectedCount: rejected.length,
                        uploaded,
                        rejected,
                        listSync,
                    },
                });
            } catch (error) {
                console.error('[EmojisRoute] Error saving uploaded emoji files:', error);
                res.status(500).json({
                    success: false,
                    error: 'Failed to save uploaded emoji files',
                });
            } finally {
                for (const tempPath of pendingTempPaths) {
                    // eslint-disable-next-line no-await-in-loop
                    await safeUnlink(tempPath);
                }

                for (const extractDir of temporaryExtractDirs) {
                    // eslint-disable-next-line no-await-in-loop
                    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
                }
            }
        });
    });

    /**
     * GET /emojis/file?path=relative/path/to/file.png
     * 返回 image 目录中的单个表情包文件（二进制流）
     */
    router.get('/emojis/file', async (req, res) => {
        const requestedPath = req.query.path;
        const requestedVariant = typeof req.query.variant === 'string'
            ? req.query.variant.trim().toLowerCase()
            : '';
        const resolved = resolveInsideRoot(IMAGE_ROOT_DIR, requestedPath);

        if (!resolved) {
            return res.status(400).json({
                success: false,
                error: 'Invalid emoji file path',
            });
        }

        const extension = path.extname(resolved.resolvedPath).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
            return res.status(403).json({
                success: false,
                error: 'Unsupported file type',
            });
        }

        try {
            const stat = await fs.stat(resolved.resolvedPath);
            if (!stat.isFile()) {
                return res.status(404).json({
                    success: false,
                    error: 'Emoji file not found',
                });
            }

            if (requestedVariant === 'thumb') {
                const thumbnailSize = parseThumbnailSize(req.query.size, DEFAULT_THUMBNAIL_SIZE);

                try {
                    const thumbnailPath = await renderThumbnailToCache(
                        resolved.resolvedPath,
                        resolved.safeRelativePath,
                        stat,
                        thumbnailSize
                    );
                    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    return res.sendFile(thumbnailPath, (sendError) => {
                        if (sendError && !res.headersSent) {
                            res.status(500).json({
                                success: false,
                                error: 'Failed to send emoji thumbnail',
                            });
                        }
                    });
                } catch (thumbError) {
                    console.warn('[EmojisRoute] Failed to render emoji thumbnail, falling back to source file:', thumbError);
                }
            }

            res.setHeader('Cache-Control', 'private, max-age=300');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.sendFile(resolved.resolvedPath, (sendError) => {
                if (sendError && !res.headersSent) {
                    if (sendError.code === 'ENOENT') {
                        res.status(404).json({
                            success: false,
                            error: 'Emoji file not found',
                        });
                        return;
                    }

                    res.status(500).json({
                        success: false,
                        error: 'Failed to send emoji file',
                    });
                }
            });
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return res.status(404).json({
                    success: false,
                    error: 'Emoji file not found',
                });
            }

            console.error('[EmojisRoute] Error reading emoji file:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to read emoji file',
            });
        }
    });

    /**
     * POST /emojis/file/delete
     * 删除 image 目录下单个表情包文件
     */
    router.post('/emojis/file/delete', async (req, res) => {
        const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
        const resolved = resolveInsideRoot(IMAGE_ROOT_DIR, rawPath);
        if (!resolved) {
            return res.status(400).json({
                success: false,
                error: 'Invalid emoji file path',
            });
        }

        const extension = path.extname(resolved.resolvedPath).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
            return res.status(400).json({
                success: false,
                error: '仅允许删除受支持的图片文件',
            });
        }

        try {
            const stat = await fs.stat(resolved.resolvedPath);
            if (!stat.isFile()) {
                return res.status(400).json({
                    success: false,
                    error: '目标路径不是文件',
                });
            }

            await fs.unlink(resolved.resolvedPath);
            resetGalleryCache();

            const shouldSyncGeneratedLists = parseBooleanValue(req.body?.syncList, false);
            let listSync = null;
            if (shouldSyncGeneratedLists) {
                try {
                    const rebuildResult = await rebuildEmojiGeneratedLists();
                    listSync = {
                        enabled: true,
                        generatedCount: rebuildResult.generatedCount,
                    };
                } catch (rebuildError) {
                    console.error('[EmojisRoute] Deleted but failed to rebuild lists:', rebuildError);
                    listSync = {
                        enabled: true,
                        generatedCount: 0,
                        warning: '删除成功，但重建列表失败，请稍后手动重建。',
                    };
                }
            }

            return res.json({
                success: true,
                data: {
                    relativePath: resolved.safeRelativePath,
                    listSync,
                },
            });
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return res.status(404).json({
                    success: false,
                    error: '目标文件不存在',
                });
            }

            console.error('[EmojisRoute] Error deleting emoji file:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to delete emoji file',
            });
        }
    });

    /**
     * POST /emojis/category/delete
     * 删除 image 目录下的一级分类目录（含其下所有文件），需二次确认
     */
    router.post('/emojis/category/delete', async (req, res) => {
        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        const rawConfirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
        const categoryName = sanitizeCategoryName(rawName);

        if (!categoryName) {
            return res.status(400).json({
                success: false,
                error: '目录名称不合法',
            });
        }

        if (categoryName === ROOT_CATEGORY_NAME) {
            return res.status(400).json({
                success: false,
                error: '禁止删除虚拟根目录',
            });
        }

        if (rawConfirm.trim() !== categoryName) {
            return res.status(400).json({
                success: false,
                error: '二次确认不匹配，请输入完整目录名',
            });
        }

        const targetDir = path.join(IMAGE_ROOT_DIR, categoryName);
        const resolvedTarget = path.resolve(targetDir);
        const resolvedRoot = path.resolve(IMAGE_ROOT_DIR);
        if (
            resolvedTarget === resolvedRoot ||
            !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Invalid category path',
            });
        }

        try {
            const stat = await fs.stat(targetDir);
            if (!stat.isDirectory()) {
                return res.status(400).json({
                    success: false,
                    error: '目标路径不是目录',
                });
            }

            await fs.rm(targetDir, { recursive: true, force: false });
            resetGalleryCache();

            const shouldSyncGeneratedLists = parseBooleanValue(req.body?.syncList, true);
            let listSync = null;
            if (shouldSyncGeneratedLists) {
                try {
                    const generatedListPath = path.join(EMOJI_LISTS_DIR, `${categoryName}.txt`);
                    await safeUnlink(generatedListPath);
                    const rebuildResult = await rebuildEmojiGeneratedLists();
                    listSync = {
                        enabled: true,
                        generatedCount: rebuildResult.generatedCount,
                    };
                } catch (rebuildError) {
                    console.error('[EmojisRoute] Deleted but failed to rebuild lists:', rebuildError);
                    listSync = {
                        enabled: true,
                        generatedCount: 0,
                        warning: '删除成功，但重建列表失败，请稍后手动重建。',
                    };
                }
            }

            return res.json({
                success: true,
                data: {
                    name: categoryName,
                    listSync,
                },
            });
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return res.status(404).json({
                    success: false,
                    error: '目标目录不存在',
                });
            }

            console.error('[EmojisRoute] Error deleting category directory:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to delete category directory',
            });
        }
    });

    return router;
};

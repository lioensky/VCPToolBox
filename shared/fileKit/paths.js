'use strict';
// 共享路径工具：路径归一化 + 白名单守卫。
// FileOperator 与 ProjectForge 共用，保证两边的路径语义一致。

const path = require('path');

/**
 * 判断 targetPath 是否位于 parentDir 之内（含其本身）。
 * 使用 path.relative 而非字符串前缀，避免 D:\VCP 误放行 D:\VCP2。
 * win32 下 path.relative 大小写不敏感；跨盘符时返回绝对路径，判为越界。
 */
function isPathInside(targetPath, parentDir) {
    if (!targetPath || !parentDir) return false;
    const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 归一化用户输入路径（与 FileOperator 历史行为保持一致）：
 * - 绝对路径：直接 resolve
 * - 以 / 开头但在当前平台非绝对：映射到 virtualRoot
 * - ./ 或 ../ 开头：相对 relativeRoot
 * - 其他裸相对路径：相对 basePath
 * 每一段都会去除首尾空白，容忍 AI 误加的空格。
 */
function resolveAndNormalizePath(inputPath, options = {}) {
    if (!inputPath || typeof inputPath !== 'string') return inputPath;
    const { basePath = process.cwd(), relativeRoot = basePath, virtualRoot = relativeRoot } = options;
    const original = inputPath.trim();

    if (path.isAbsolute(original)) return path.resolve(original);

    if (original.startsWith('/')) {
        return path.resolve(virtualRoot, original.slice(1));
    }

    const sanitized = path.join(...original.split(/[/\\]+/).map(part => part.trim()));
    const normalized = path.normalize(sanitized);
    const explicitRelative = normalized === '.' || normalized === '..'
        || normalized.startsWith(`.${path.sep}`) || normalized.startsWith(`..${path.sep}`);

    return path.resolve(explicitRelative ? relativeRoot : basePath, normalized);
}

/**
 * 创建白名单守卫。
 * @param {string[]} allowedDirs 允许的根目录；为空表示不限制。
 * @param {object} [options]
 * @param {string[]} [options.readOnlyBypassOps] 允许在白名单外执行的只读操作（仅限绝对路径）。
 */
function createPathGuard(allowedDirs = [], options = {}) {
    const dirs = allowedDirs.map(dir => String(dir).trim()).filter(Boolean).map(dir => path.resolve(dir));
    const readOnlyBypassOps = new Set(options.readOnlyBypassOps || []);

    function isAllowed(targetPath, operationType = 'generic') {
        if (dirs.length === 0) return true;
        const resolved = path.resolve(targetPath);
        if (dirs.some(dir => isPathInside(resolved, dir))) return true;
        return readOnlyBypassOps.has(operationType) && path.isAbsolute(String(targetPath));
    }

    function assertAllowed(targetPath, operationType = 'generic') {
        if (!isAllowed(targetPath, operationType)) {
            throw new Error(`Access denied: Path '${targetPath}' is not in allowed directories`);
        }
        return path.resolve(targetPath);
    }

    function addDirectory(dir) {
        const resolved = path.resolve(dir);
        if (!dirs.some(existing => existing.toLowerCase() === resolved.toLowerCase())) dirs.push(resolved);
    }

    return { dirs, isAllowed, assertAllowed, addDirectory };
}

/** 统一使用正斜杠的相对路径，便于 AI 阅读与数据库存储。 */
function toPosixRelative(fromDir, targetPath) {
    return path.relative(fromDir, targetPath).split(path.sep).join('/');
}

module.exports = {
    isPathInside,
    resolveAndNormalizePath,
    createPathGuard,
    toPosixRelative,
};
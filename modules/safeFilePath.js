'use strict';

const fs = require('fs');
const path = require('path');

function invalidPath(message = 'Invalid file path') {
    const error = new Error(message);
    error.code = 'UNSAFE_PATH';
    error.status = 400;
    error.statusCode = 400;
    return error;
}

// Apply Windows rules on every platform so deployments have identical boundaries.
// Do not URL-decode here: Express has already decoded route parameters.
function resolveSafePath(root, relative, { singleSegment = false, allowRoot = false } = {}) {
    if (typeof relative !== 'string' || /[\x00-\x1f\x7f<>:"|?*]/.test(relative)) {
        throw invalidPath();
    }
    const normalized = relative.replace(/\\/g, '/');
    if (normalized.startsWith('/') || path.win32.isAbsolute(relative)) throw invalidPath();
    if (!normalized && allowRoot) return path.resolve(root);
    const segments = normalized.split('/');
    if (singleSegment && segments.length !== 1) throw invalidPath('Expected a file name, not a path');
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
            || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) {
            throw invalidPath();
        }
    }
    const base = path.resolve(root);
    const target = path.resolve(base, ...segments);
    const rel = path.relative(base, target);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw invalidPath();
    }
    return target;
}

function checkedPaths(root, target, allowRoot) {
    const base = path.resolve(root);
    const resolved = path.resolve(target);
    const relative = path.relative(base, resolved);
    if ((!relative && !allowRoot) || relative === '..'
        || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalidPath();
    // Revalidate names even when the caller supplies an absolute, computed path.
    if (relative) resolveSafePath(base, relative);
    const paths = [base];
    let current = base;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        paths.push(current);
    }
    return paths;
}

function checkStat(stat) {
    if (stat.isSymbolicLink()) throw invalidPath('Symbolic links and junctions are not allowed');
}

// Missing descendants are valid for creation. lstat also detects dangling links.
// These checks do not replace filesystem permissions: a local process able to
// swap directories concurrently can still race path-based filesystem operations.
async function assertSafePath(root, target, { allowRoot = false } = {}) {
    for (const current of checkedPaths(root, target, allowRoot)) {
        try {
            checkStat(await fs.promises.lstat(current));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return target;
}

function assertSafePathSync(root, target, { allowRoot = false } = {}) {
    for (const current of checkedPaths(root, target, allowRoot)) {
        try {
            checkStat(fs.lstatSync(current));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return target;
}

async function safeFilePath(root, relative, options) {
    const target = resolveSafePath(root, relative, options);
    return assertSafePath(root, target, options);
}

module.exports = { invalidPath, resolveSafePath, assertSafePath, assertSafePathSync, safeFilePath };
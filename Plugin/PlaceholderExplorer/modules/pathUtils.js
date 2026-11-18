'use strict';

const fs = require('fs').promises;
const path = require('path');

function normalizePlaceholder(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.startsWith('[[') && text.endsWith(']]')) return text;
    if (text.startsWith('{{') && text.endsWith('}}')) return text;
    return `{{${text.replace(/^\{\{|\}\}$/g, '')}}}`;
}

function toPosix(value) {
    return String(value || '').replace(/\\/g, '/');
}

function toRelative(rootPath, filePath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    return toPosix(relative || '.');
}

function isPathInside(rootPath, targetPath) {
    const root = path.resolve(rootPath);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInside(rootPath, candidate) {
    const resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(rootPath, candidate);
    if (!isPathInside(rootPath, resolved)) {
        throw new Error(`路径越界：${candidate}`);
    }
    return resolved;
}

function findLine(content, needle, fromIndex = 0) {
    const index = String(content).indexOf(String(needle), Math.max(0, fromIndex));
    if (index < 0) return 1;
    return String(content).slice(0, index).split(/\r?\n/).length;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function listFilesRecursive(rootPath, extensions, options = {}) {
    const results = [];
    const extensionSet = new Set((extensions || []).map(item => item.toLowerCase()));
    const ignoredNames = new Set(options.ignoredNames || ['node_modules', '.git', 'dist', 'target']);
    const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 20000;

    if (!(await pathExists(rootPath))) return results;

    async function visit(currentPath) {
        if (results.length >= maxFiles) return;
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (results.length >= maxFiles) break;
            if (ignoredNames.has(entry.name) || entry.name.startsWith('.')) continue;
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await visit(entryPath);
            } else if (entry.isFile()) {
                const extension = path.extname(entry.name).toLowerCase();
                if (extensionSet.size === 0 || extensionSet.has(extension)) {
                    results.push(entryPath);
                }
            }
        }
    }

    await visit(rootPath);
    return results;
}

module.exports = {
    findLine,
    isPathInside,
    listFilesRecursive,
    normalizePlaceholder,
    pathExists,
    resolveInside,
    toPosix,
    toRelative
};

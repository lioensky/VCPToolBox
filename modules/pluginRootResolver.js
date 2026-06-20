// modules/pluginRootResolver.js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LEGACY_MANIFEST_FILE_NAME = 'plugin-manifest.json';
const BLOCKED_MANIFEST_SUFFIX = '.block';
const BLOCKED_MANIFEST_FILE_NAME = `${LEGACY_MANIFEST_FILE_NAME}${BLOCKED_MANIFEST_SUFFIX}`;
const VCP_PLUGIN_DIRS_ENV = 'VCP_PLUGIN_DIRS';
const VCP_PLUGIN_ALLOWED_ROOTS_ENV = 'VCP_PLUGIN_ALLOWED_ROOTS';
const VCP_PLUGIN_INSTALL_DIR_ENV = 'VCP_PLUGIN_INSTALL_DIR';

function uniqueByResolvedPath(paths) {
    const seen = new Set();
    const result = [];
    for (const value of paths) {
        if (!value) continue;
        const resolved = path.resolve(value);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(resolved);
    }
    return result;
}

function splitPathList(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return [];

    const trimmed = rawValue.trim();
    if (!trimmed) return [];

    if (trimmed.includes(';')) {
        return trimmed.split(';').map(item => item.trim()).filter(Boolean);
    }

    if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
        return [trimmed];
    }

    return trimmed.split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

function isSubPath(candidate, parent) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedParent = path.resolve(parent);
    if (resolvedCandidate === resolvedParent) return true;

    const relative = path.relative(resolvedParent, resolvedCandidate);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathKey(targetPath) {
    const resolved = path.resolve(targetPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toDisplayPath(projectRoot, absolutePath, source = 'external') {
    const resolved = path.resolve(absolutePath);
    const resolvedProjectRoot = path.resolve(projectRoot);

    if (isSubPath(resolved, resolvedProjectRoot)) {
        return path.relative(resolvedProjectRoot, resolved).replace(/\\/g, '/') || '.';
    }

    return `[${source}]/${path.basename(resolved)}`;
}

async function isManagedPathInsideRoot(candidatePath, rootPath) {
    const rootRealPath = await realpathOrResolve(rootPath);
    const candidateParentRealPath = await realpathOrResolve(path.dirname(candidatePath));
    return isSubPath(candidateParentRealPath, rootRealPath);
}

async function isPathInsideRootByRealpath(candidatePath, rootPath) {
    if (!candidatePath || !rootPath) return false;
    const rootRealPath = await realpathOrResolve(rootPath);
    const candidateRealPath = await realpathOrResolve(candidatePath);
    return isSubPath(candidateRealPath, rootRealPath);
}

function toRootRelativeDisplayPath(rootInfo, targetPath) {
    const source = rootInfo?.source === 'external' ? 'external' : 'core';
    if (!rootInfo?.rootPath || !targetPath) return `[${source}]/unknown`;

    const relative = path.relative(path.resolve(rootInfo.rootPath), path.resolve(targetPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return `[${source}]/${path.basename(path.resolve(targetPath))}`;
    }

    return `[${source}]/${relative.replace(/\\/g, '/')}`;
}

function isUnsafeRoot(projectRoot, rootPath) {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const resolvedRoot = path.resolve(rootPath);

    if (resolvedRoot === resolvedProjectRoot) {
        return 'external root must not equal project root';
    }

    const lowered = resolvedRoot.toLowerCase();
    if (lowered.includes(`${path.sep}.git${path.sep}`) || lowered.endsWith(`${path.sep}.git`)) {
        return 'external root must not be inside .git';
    }

    if (lowered.includes(`${path.sep}node_modules${path.sep}`) || lowered.endsWith(`${path.sep}node_modules`)) {
        return 'external root must not be inside node_modules';
    }

    return null;
}

async function pathExists(targetPath) {
    try {
        await fsp.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function realpathOrResolve(targetPath) {
    try {
        return await fsp.realpath(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

function realpathOrResolveSync(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

async function readManifestCandidate(filePath, state, fsPromises = fsp) {
    try {
        const stat = await fsPromises.lstat(filePath);
        if (stat.isSymbolicLink()) {
            return {
                exists: true,
                state,
                skipped: true,
                code: 'manifest_symlink_unsupported'
            };
        }
        if (!stat.isFile()) {
            return {
                exists: true,
                state,
                skipped: true,
                code: 'manifest_not_file'
            };
        }

        const raw = await fsPromises.readFile(filePath, 'utf-8');
        return {
            exists: true,
            state,
            manifest: JSON.parse(raw),
            manifestPath: filePath
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, state };
        }

        return {
            exists: true,
            state,
            skipped: true,
            code: error instanceof SyntaxError ? 'manifest_json_invalid' : 'manifest_read_error',
            errorCode: error.code || null
        };
    }
}

async function discoverLegacyManifestRecordsFromRoot(rootInfo, options = {}) {
    const fsPromises = options.fsPromises || fsp;
    const diagnostics = [];
    const records = [];

    if (!rootInfo || !rootInfo.rootPath) {
        return {
            records,
            diagnostics: [{ level: 'warn', code: 'missing_root_info', rootId: 'unknown' }]
        };
    }

    let folders;
    try {
        folders = await fsPromises.readdir(rootInfo.rootPath, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            diagnostics.push({
                level: 'warn',
                code: 'managed_root_read_error',
                rootId: rootInfo.rootId || 'unknown',
                root: rootInfo.displayPath || toRootRelativeDisplayPath(rootInfo, rootInfo.rootPath),
                errorCode: error.code || 'UNKNOWN'
            });
        }
        return { records, diagnostics };
    }

    for (const folder of folders) {
        if (!folder.isDirectory()) continue;

        const pluginPath = path.join(rootInfo.rootPath, folder.name);
        if (!isSubPath(pluginPath, rootInfo.rootPath)) {
            diagnostics.push({
                level: 'warn',
                code: 'plugin_path_outside_root',
                rootId: rootInfo.rootId || 'unknown',
                folder: folder.name
            });
            continue;
        }

        const activeManifestPath = path.join(pluginPath, LEGACY_MANIFEST_FILE_NAME);
        const blockedManifestPath = path.join(pluginPath, BLOCKED_MANIFEST_FILE_NAME);
        const active = await readManifestCandidate(activeManifestPath, 'enabled', fsPromises);
        const blocked = await readManifestCandidate(blockedManifestPath, 'disabled', fsPromises);

        if (active.exists && blocked.exists && !active.skipped) {
            diagnostics.push({
                level: 'warn',
                code: 'blocked_manifest_shadowed',
                rootId: rootInfo.rootId || 'unknown',
                folder: folder.name
            });
        }

        const selected = active.exists && !active.skipped ? active : (blocked.exists && !blocked.skipped ? blocked : null);
        for (const candidate of [active, blocked]) {
            if (candidate.exists && candidate.skipped) {
                diagnostics.push({
                    level: 'warn',
                    code: candidate.code,
                    rootId: rootInfo.rootId || 'unknown',
                    folder: folder.name,
                    state: candidate.state,
                    errorCode: candidate.errorCode || null
                });
            }
        }

        if (!selected) continue;
        if (!selected.manifest || typeof selected.manifest !== 'object' || !selected.manifest.name) {
            diagnostics.push({
                level: 'warn',
                code: 'manifest_missing_name',
                rootId: rootInfo.rootId || 'unknown',
                folder: folder.name,
                state: selected.state
            });
            continue;
        }

        records.push({
            name: selected.manifest.name,
            folderName: folder.name,
            manifest: selected.manifest,
            manifestPath: selected.manifestPath,
            activeManifestPath,
            blockedManifestPath,
            pluginPath,
            enabled: selected.state === 'enabled',
            source: rootInfo.source || 'core',
            rootId: rootInfo.rootId || null,
            rootPath: rootInfo.rootPath,
            rootDisplayPath: rootInfo.displayPath || null,
            allowConfigEnv: rootInfo.allowConfigEnv !== false,
            displayPath: toRootRelativeDisplayPath(rootInfo, pluginPath),
            pathKey: pathKey(pluginPath)
        });
    }

    return { records, diagnostics };
}

async function discoverAdminLegacyManifestRecords(rootSnapshot, options = {}) {
    const roots = [
        rootSnapshot?.coreLegacyRoot,
        ...(rootSnapshot?.externalLegacyRoots || [])
    ].filter(Boolean);
    const records = [];
    const diagnostics = [];

    for (const rootInfo of roots) {
        const result = await discoverLegacyManifestRecordsFromRoot(rootInfo, options);
        records.push(...result.records);
        diagnostics.push(...result.diagnostics);
    }

    return { records, diagnostics };
}

class PluginRootResolver {
    constructor(options = {}) {
        this.projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
        this.env = options.env || process.env;
        this.coreLegacyRoot = path.resolve(options.coreLegacyRoot || path.join(this.projectRoot, 'Plugin'));
        this.coreModernRoot = path.resolve(options.coreModernRoot || path.join(this.projectRoot, 'plugins'));
    }

    resolvePathList(rawValue) {
        return uniqueByResolvedPath(
            splitPathList(rawValue).map(item => {
                const normalized = path.normalize(item);
                return path.isAbsolute(normalized)
                    ? normalized
                    : path.resolve(this.projectRoot, normalized);
            })
        ).map(rootPath => ({
            rootPath,
            displayPath: toDisplayPath(this.projectRoot, rootPath, 'external')
        }));
    }

    resolveSinglePath(rawValue) {
        const normalized = path.normalize(String(rawValue || '').trim());
        if (!normalized) return null;
        return path.isAbsolute(normalized)
            ? normalized
            : path.resolve(this.projectRoot, normalized);
    }

    getAllowedRootsSync() {
        return this.resolvePathList(this.env[VCP_PLUGIN_ALLOWED_ROOTS_ENV])
            .map(root => realpathOrResolveSync(root.rootPath));
    }

    _buildExternalRootInfo(entry, index, allowedRoots, diagnostics, options = {}) {
        const rootId = `external:${index + 1}`;
        const rootPath = options.realpath
            ? options.realpath(entry.rootPath)
            : realpathOrResolveSync(entry.rootPath);
        const displayPath = toDisplayPath(this.projectRoot, rootPath, 'external');
        const unsafeReason = isUnsafeRoot(this.projectRoot, rootPath);

        if (unsafeReason) {
            diagnostics.push({ level: 'warn', code: 'unsafe_external_root', rootId, root: displayPath, message: unsafeReason });
            return null;
        }

        if (allowedRoots.length === 0) {
            diagnostics.push({ level: 'warn', code: 'external_roots_require_allowlist', rootId, root: displayPath });
            return null;
        }

        const allowed = allowedRoots.some(allowedRoot => isSubPath(rootPath, allowedRoot));
        if (!allowed) {
            diagnostics.push({ level: 'warn', code: 'external_root_not_allowed', rootId, root: displayPath });
            return null;
        }

        return {
            rootId,
            source: 'external',
            rootPath,
            displayPath,
            allowConfigEnv: false,
            enabled: true
        };
    }

    getExternalLegacyRootsSync() {
        const allowedRoots = this.getAllowedRootsSync();
        const diagnostics = [];
        const roots = [];

        this.resolvePathList(this.env[VCP_PLUGIN_DIRS_ENV]).forEach((entry, index) => {
            const rootInfo = this._buildExternalRootInfo(entry, index, allowedRoots, diagnostics);
            if (rootInfo) roots.push(rootInfo);
        });

        return { roots, diagnostics };
    }

    getWatchRoots() {
        return this.getPluginRootSnapshotSync().watchRoots;
    }

    getPluginRootSnapshotSync() {
        const { roots: externalLegacyRoots, diagnostics } = this.getExternalLegacyRootsSync();
        const coreLegacyRoot = {
            rootId: 'core:legacy',
            source: 'core',
            rootPath: this.coreLegacyRoot,
            displayPath: toDisplayPath(this.projectRoot, this.coreLegacyRoot, 'core'),
            allowConfigEnv: true,
            enabled: true
        };

        const coreModernRoot = {
            rootId: 'core:modern',
            source: 'core-modern',
            rootPath: this.coreModernRoot,
            displayPath: toDisplayPath(this.projectRoot, this.coreModernRoot, 'core'),
            allowConfigEnv: true,
            enabled: true
        };

        return {
            projectRoot: this.projectRoot,
            coreLegacyRoot,
            coreModernRoot,
            externalLegacyRoots,
            legacyLoadRoots: [coreLegacyRoot, ...externalLegacyRoots],
            watchRoots: uniqueByResolvedPath([
                this.coreLegacyRoot,
                this.coreModernRoot,
                ...externalLegacyRoots.map(root => root.rootPath)
            ]),
            diagnostics
        };
    }

    async getAllowedRoots() {
        const roots = this.resolvePathList(this.env[VCP_PLUGIN_ALLOWED_ROOTS_ENV]);
        const resolved = [];
        for (const root of roots) {
            resolved.push(await realpathOrResolve(root.rootPath));
        }
        return uniqueByResolvedPath(resolved);
    }

    async getExternalLegacyRoots() {
        const allowedRoots = await this.getAllowedRoots();
        const diagnostics = [];
        const roots = [];
        const entries = this.resolvePathList(this.env[VCP_PLUGIN_DIRS_ENV]);

        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const exists = await pathExists(entry.rootPath);
            const realRoot = await realpathOrResolve(entry.rootPath);
            const displayPath = toDisplayPath(this.projectRoot, realRoot, 'external');

            if (!exists) {
                diagnostics.push({ level: 'warn', code: 'external_root_missing', rootId: `external:${index + 1}`, root: displayPath });
                continue;
            }

            const rootInfo = this._buildExternalRootInfo(
                { ...entry, rootPath: realRoot },
                index,
                allowedRoots,
                diagnostics,
                { realpath: value => value }
            );
            if (rootInfo) roots.push(rootInfo);
        }

        return { roots, diagnostics };
    }

    async getPluginRootSnapshot() {
        const coreLegacyRealPath = await realpathOrResolve(this.coreLegacyRoot);
        const coreModernRealPath = await realpathOrResolve(this.coreModernRoot);
        const { roots: externalLegacyRoots, diagnostics } = await this.getExternalLegacyRoots();

        const coreLegacyRoot = {
            rootId: 'core:legacy',
            source: 'core',
            rootPath: coreLegacyRealPath,
            displayPath: toDisplayPath(this.projectRoot, coreLegacyRealPath, 'core'),
            allowConfigEnv: true,
            enabled: true
        };

        const coreModernRoot = {
            rootId: 'core:modern',
            source: 'core-modern',
            rootPath: coreModernRealPath,
            displayPath: toDisplayPath(this.projectRoot, coreModernRealPath, 'core'),
            allowConfigEnv: true,
            enabled: true
        };

        return {
            projectRoot: this.projectRoot,
            coreLegacyRoot,
            coreModernRoot,
            externalLegacyRoots,
            legacyLoadRoots: [coreLegacyRoot, ...externalLegacyRoots],
            watchRoots: uniqueByResolvedPath([
                coreLegacyRealPath,
                coreModernRealPath,
                ...externalLegacyRoots.map(root => root.rootPath)
            ]),
            diagnostics
        };
    }

    async getPluginStoreInstallRoot() {
        const rawInstallDir = this.env[VCP_PLUGIN_INSTALL_DIR_ENV];
        if (typeof rawInstallDir !== 'string' || rawInstallDir.trim() === '') {
            const coreLegacyRealPath = await realpathOrResolve(this.coreLegacyRoot);
            return {
                mode: 'legacy',
                source: 'core',
                rootId: 'core:legacy',
                rootPath: coreLegacyRealPath,
                displayPath: toDisplayPath(this.projectRoot, coreLegacyRealPath, 'core'),
                allowConfigEnv: true,
                diagnostics: []
            };
        }

        const requestedRoot = this.resolveSinglePath(rawInstallDir);
        const requestedRealPath = await realpathOrResolve(requestedRoot);
        const requestedDisplayPath = toDisplayPath(this.projectRoot, requestedRealPath, 'external');
        const allowedRoots = await this.getAllowedRoots();
        const { roots: externalLegacyRoots, diagnostics } = await this.getExternalLegacyRoots();

        if (allowedRoots.length === 0) {
            const error = new Error('VCP_PLUGIN_INSTALL_DIR requires VCP_PLUGIN_ALLOWED_ROOTS.');
            error.code = 'plugin_install_root_allowlist_required';
            error.displayPath = requestedDisplayPath;
            throw error;
        }

        const insideAllowedRoot = allowedRoots.some(allowedRoot => isSubPath(requestedRealPath, allowedRoot));
        if (!insideAllowedRoot) {
            const error = new Error('VCP_PLUGIN_INSTALL_DIR is outside VCP_PLUGIN_ALLOWED_ROOTS.');
            error.code = 'plugin_install_root_not_allowed';
            error.displayPath = requestedDisplayPath;
            throw error;
        }

        const matchedRoot = externalLegacyRoots.find(root => pathKey(root.rootPath) === pathKey(requestedRealPath));
        if (!matchedRoot) {
            const error = new Error('VCP_PLUGIN_INSTALL_DIR must match a current allowlisted external legacy root.');
            error.code = 'plugin_install_root_not_managed';
            error.displayPath = requestedDisplayPath;
            throw error;
        }

        return {
            mode: 'external',
            source: 'external',
            rootId: matchedRoot.rootId,
            rootPath: matchedRoot.rootPath,
            displayPath: matchedRoot.displayPath,
            allowConfigEnv: false,
            diagnostics
        };
    }
}

function createPluginRootResolver(options = {}) {
    return new PluginRootResolver(options);
}

module.exports = {
    createPluginRootResolver,
    PluginRootResolver,
    splitPathList,
    isSubPath,
    toDisplayPath,
    LEGACY_MANIFEST_FILE_NAME,
    BLOCKED_MANIFEST_SUFFIX,
    BLOCKED_MANIFEST_FILE_NAME,
    VCP_PLUGIN_DIRS_ENV,
    VCP_PLUGIN_ALLOWED_ROOTS_ENV,
    VCP_PLUGIN_INSTALL_DIR_ENV,
    discoverAdminLegacyManifestRecords,
    discoverLegacyManifestRecordsFromRoot,
    isManagedPathInsideRoot,
    isPathInsideRootByRealpath,
    pathKey,
    toRootRelativeDisplayPath
};

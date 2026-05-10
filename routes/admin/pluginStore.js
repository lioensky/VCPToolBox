/**
 * Plugin Store routes
 * - Manage custom sources (official registry / GitHub repos)
 * - Install from source URL, GitHub URL, or manual upload (.zip/.tar/.tar.gz/.tgz/folder)
 * - Auto-detect and run `npm install` when plugin ships a package.json
 * - Stream npm install logs via SSE
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const dns = require('dns').promises;
const net = require('net');

const multer = require('multer');
const extract = require('extract-zip');
const tar = require('tar');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'Plugin');
const TMP_DIR = path.join(ROOT, 'tmp');
const UPLOAD_DIR = path.join(TMP_DIR, 'uploads');
const BACKUP_DIR = path.join(PLUGIN_DIR, '.backup');
const SOURCES_FILE = path.join(ROOT, 'pluginStoreSources.json');

const MANIFEST_NAME = 'plugin-manifest.json';
const BLOCKED_EXT = '.block';

const BUILTIN_SOURCES = [];

// Safety limits
const FETCH_TIMEOUT_MS = 20_000;
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_FILES = 2000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SAFE_PLUGIN_NAME_RE = /^[A-Za-z0-9._-]+$/;

// =============================================================================
// Utilities
// =============================================================================

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(p) {
    try {
        await fsp.access(p);
        return true;
    } catch {
        return false;
    }
}

async function readJsonSafe(file, fallback) {
    try {
        const raw = await fsp.readFile(file, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

async function writeJson(file, data) {
    await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

function newId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

// Walk a directory to find the first folder containing plugin-manifest.json
async function findManifestRoot(dir, depth = 0) {
    if (depth > 4) return null;
    const candidate = path.join(dir, MANIFEST_NAME);
    if (await pathExists(candidate)) return dir;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.isDirectory()) {
            const found = await findManifestRoot(path.join(dir, e.name), depth + 1);
            if (found) return found;
        }
    }
    return null;
}

async function moveDir(src, dst) {
    try {
        await fsp.rename(src, dst);
    } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'EPERM') {
            await fsp.cp(src, dst, { recursive: true });
            await fsp.rm(src, { recursive: true, force: true });
        } else {
            throw err;
        }
    }
}

// Safe path join against a base dir; rejects traversal
function safeJoin(base, rel) {
    const normalized = path.normalize(rel).replace(/^(\.\.[\\/])+/, '');
    const target = path.resolve(base, normalized);
    if (!target.startsWith(path.resolve(base))) {
        throw new Error(`Unsafe path: ${rel}`);
    }
    return target;
}

// Validate plugin name: only safe chars, no dot prefix, no Windows reserved names.
// Prevents a malicious manifest from redirecting the install target outside PLUGIN_DIR.
function assertSafePluginName(name) {
    if (typeof name !== 'string') {
        throw new Error('plugin-manifest.json 的 name 字段必须是字符串');
    }
    const trimmed = name.trim();
    if (!trimmed) throw new Error('plugin-manifest.json 的 name 字段为空');
    if (trimmed.length > 100) throw new Error('plugin-manifest.json 的 name 过长（>100）');
    if (!SAFE_PLUGIN_NAME_RE.test(trimmed)) {
        throw new Error('plugin-manifest.json 的 name 含非法字符（仅允许 A-Z a-z 0-9 . _ -）');
    }
    if (trimmed.startsWith('.')) {
        throw new Error('plugin-manifest.json 的 name 不能以 . 开头');
    }
    if (WINDOWS_RESERVED_NAMES.test(trimmed)) {
        throw new Error(`plugin-manifest.json 的 name 为系统保留名：${trimmed}`);
    }
    return trimmed;
}

// Resolve target dir under PLUGIN_DIR and ensure no traversal.
function resolvePluginTarget(safeName) {
    const target = path.resolve(PLUGIN_DIR, safeName);
    const base = path.resolve(PLUGIN_DIR);
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error(`插件目标路径越界：${safeName}`);
    }
    return target;
}

// Walk an extracted tree and refuse symlinks or entries whose realpath escapes base.
// Defends against zip-slip / tar-slip regardless of the extractor's own safeguards.
async function assertSafeExtractedTree(baseDir) {
    const basePath = path.resolve(baseDir);
    async function walk(dir) {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const child = path.join(dir, e.name);
            if (e.isSymbolicLink()) {
                throw new Error(`压缩包包含符号链接（不允许）：${path.relative(basePath, child) || e.name}`);
            }
            const real = await fsp.realpath(child);
            if (real !== basePath && !real.startsWith(basePath + path.sep)) {
                throw new Error(`压缩包含逃逸路径（zip-slip）：${path.relative(basePath, child) || e.name}`);
            }
            if (e.isDirectory()) {
                await walk(child);
            }
        }
    }
    await walk(baseDir);
}

// SSRF guard: reject private / loopback / link-local / multicast targets.
function isPrivateIp(ip) {
    if (!ip) return true;
    const family = net.isIP(ip);
    if (family === 4) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a >= 224) return true; // multicast + reserved
        return false;
    }
    if (family === 6) {
        const lower = ip.toLowerCase();
        if (lower === '::' || lower === '::1') return true;
        if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
        if (lower.startsWith('fe80')) return true; // link-local
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIp(mapped[1]);
        return false;
    }
    return true; // not a valid IP literal -> be conservative
}

async function assertPublicHost(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch {
        throw new Error(`非法 URL: ${urlStr}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`仅允许 http/https，当前：${u.protocol}`);
    }
    const host = u.hostname;
    const lowered = host.toLowerCase();
    if (!lowered) throw new Error(`URL 缺少 host: ${urlStr}`);
    if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
        throw new Error(`禁止访问 localhost: ${host}`);
    }
    // If host is already an IP literal, check directly. Otherwise resolve DNS.
    if (net.isIP(host)) {
        if (isPrivateIp(host)) {
            throw new Error(`禁止访问内网地址：${host}`);
        }
        return;
    }
    try {
        const records = await dns.lookup(host, { all: true });
        for (const r of records) {
            if (isPrivateIp(r.address)) {
                throw new Error(`目标主机 ${host} 解析到内网地址 ${r.address}，已拦截`);
            }
        }
    } catch (err) {
        if (err && typeof err.message === 'string' && err.message.includes('禁止访问')) throw err;
        if (err && typeof err.message === 'string' && err.message.includes('拦截')) throw err;
        // DNS failure -> let fetch itself error out downstream
    }
}

function githubAuthHeaders() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchWithGuard(url, opts = {}) {
    await assertPublicHost(url);
    const controller = new AbortController();
    const timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : FETCH_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const isGithubApi = /^https:\/\/api\.github\.com\//i.test(url);
        const headers = {
            ...(opts.headers || {}),
            ...(isGithubApi ? githubAuthHeaders() : {}),
        };
        return await fetch(url, { ...opts, headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Simple TTL cache for GitHub API responses (default branch / tree listing).
const githubCache = new Map();

function cacheGet(key) {
    const entry = githubCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
        githubCache.delete(key);
        return undefined;
    }
    return entry.value;
}

function cacheSet(key, value, ttl = GITHUB_CACHE_TTL_MS) {
    githubCache.set(key, { value, expires: Date.now() + ttl });
}

// =============================================================================
// Install task registry (for SSE log streaming)
// =============================================================================

const tasks = new Map(); // taskId -> { bus, logs, status, message }

function createTask() {
    const taskId = newId('task');
    const bus = new EventEmitter();
    const task = { id: taskId, bus, logs: [], status: 'pending', message: '' };
    tasks.set(taskId, task);
    // Auto-cleanup after 10 minutes
    setTimeout(() => tasks.delete(taskId), 10 * 60 * 1000).unref?.();
    return task;
}

function pushLog(task, line) {
    task.logs.push(line);
    task.bus.emit('log', line);
}

function finishTask(task, status, message) {
    task.status = status;
    task.message = message;
    task.bus.emit('end', { status, message });
}

// =============================================================================
// Source discovery
// =============================================================================

async function loadSources() {
    const fileSources = await readJsonSafe(SOURCES_FILE, []);
    const combined = [];
    for (const s of BUILTIN_SOURCES) combined.push({ ...s });
    for (const s of fileSources) combined.push({ ...s, builtin: false });
    return dedupeSources(combined);
}

async function saveUserSources(list) {
    const userOnly = dedupeSources(list).filter(s => !s.builtin);
    await writeJson(SOURCES_FILE, userOnly);
}

// Parse a GitHub URL into { owner, repo, branch, subpath }
function parseGithubUrl(url) {
    // https://github.com/<owner>/<repo>                    -> default branch
    // https://github.com/<owner>/<repo>/tree/<branch>[/<subpath>]
    const m = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/]+)(?:\/(.+))?)?\/?$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], branch: m[3] || null, subpath: m[4] || '' };
}

function normalizeSourceUrl(type, rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return '';

    if (type === 'github') {
        const parsed = parseGithubUrl(input);
        if (!parsed) return input;
        const owner = parsed.owner.toLowerCase();
        const repo = parsed.repo.toLowerCase();
        const base = `https://github.com/${owner}/${repo}`;
        if (!parsed.branch) return base;
        if (parsed.subpath) return `${base}/tree/${parsed.branch}/${parsed.subpath}`;
        return `${base}/tree/${parsed.branch}`;
    }

    try {
        const u = new URL(input);
        const normalizedPath = u.pathname.replace(/\/+$/, '');
        const normalizedQuery = u.search || '';
        return `${u.origin.toLowerCase()}${normalizedPath}${normalizedQuery}`;
    } catch {
        return input;
    }
}

function sourceFingerprint(source) {
    const type = source?.type === 'github' ? 'github' : 'registry';
    return `${type}:${normalizeSourceUrl(type, source?.url)}`;
}

function dedupeSources(list) {
    const byId = new Map();
    for (const source of Array.isArray(list) ? list : []) {
        if (!source || typeof source !== 'object') continue;
        if (!source.id || !source.url) continue;
        byId.set(source.id, source);
    }

    const byFingerprint = new Map();
    for (const source of byId.values()) {
        const key = sourceFingerprint(source);
        if (!key) continue;
        if (!byFingerprint.has(key)) {
            byFingerprint.set(key, source);
            continue;
        }

        const current = byFingerprint.get(key);
        // Prefer builtin source over user-defined source when both point to same URL.
        if (!current?.builtin && source?.builtin) {
            byFingerprint.set(key, source);
        }
    }

    return Array.from(byFingerprint.values());
}

function detectArchiveFormat(fileNameOrUrl) {
    const input = String(fileNameOrUrl || '').toLowerCase();
    if (!input) return null;
    const clean = input.split('?')[0].split('#')[0];
    if (clean.endsWith('.zip')) return 'zip';
    if (clean.endsWith('.tar') || clean.endsWith('.tgz') || clean.endsWith('.tar.gz')) return 'tar';
    return null;
}

function archiveNameHintFromUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return '';
    try {
        const u = new URL(input);
        return u.pathname || input;
    } catch {
        return input;
    }
}

function isSupportedArchiveName(fileNameOrUrl) {
    return detectArchiveFormat(fileNameOrUrl) !== null;
}

function normalizeRelativePath(input) {
    return String(input || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/+/g, '/');
}

function withSubpathPrefix(prefix, relPath) {
    const p = normalizeRelativePath(prefix);
    const r = normalizeRelativePath(relPath);
    if (!p) return r;
    if (!r) return p;
    if (r === p || r.startsWith(`${p}/`)) return r;
    return `${p}/${r}`;
}

function getFirstString(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
        if (typeof obj[key] === 'string' && obj[key].trim()) {
            return obj[key].trim();
        }
    }
    return '';
}

function toGithubRef(parsed, branch, subpath) {
    return {
        owner: parsed.owner,
        repo: parsed.repo,
        branch,
        subpath: normalizeRelativePath(subpath),
    };
}

function inferPluginCategory(manifestLike) {
    const name = String(manifestLike?.name || '').toLowerCase();
    const type = String(manifestLike?.pluginType || '').toLowerCase();

    if (type === 'static') return 'data-provider';
    if (type === 'service' || type === 'hybridservice') return 'service';
    if (/image|gen|draw|flux|doubao|zimage|comfy|novelai|gemini/i.test(name)) return 'image-generation';
    if (/video|suno|music/i.test(name)) return 'media-generation';
    if (/search|fetch|crawl|wiki|serp|tavily|kegg|arxiv|pubmed|ncbi/i.test(name)) return 'information-retrieval';
    if (/weather|dailyhot|hot/i.test(name)) return 'data-source';
    if (/shell|executor|file|cos|backup|operator|everything/i.test(name)) return 'system-integration';
    if (/agent|message|assistant|dream|task/i.test(name)) return 'agent-collab';
    if (/forum|bilibili|xiaohongshu/i.test(name)) return 'social';
    if (/tarot|random|calc|japanese|helper/i.test(name)) return 'utility';
    if (/chrome|bridge|capture|screenshot/i.test(name)) return 'browser';
    return 'tool';
}

function parseComparableVersion(version) {
    const raw = String(version || '').trim();
    if (!raw) return null;
    const normalized = raw.replace(/^v/i, '');
    const matched = normalized.match(/^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?$/);
    if (!matched) return null;

    const core = matched[1].split('.').map(part => Number(part));
    if (core.some(n => Number.isNaN(n))) return null;

    const prerelease = matched[2]
        ? matched[2].split('.').map(token => {
            if (/^\d+$/.test(token)) return Number(token);
            return token.toLowerCase();
        })
        : null;

    return { core, prerelease };
}

function compareComparableVersion(a, b) {
    const va = parseComparableVersion(a);
    const vb = parseComparableVersion(b);
    if (!va || !vb) return null;

    const maxLen = Math.max(va.core.length, vb.core.length);
    for (let i = 0; i < maxLen; i++) {
        const ai = va.core[i] || 0;
        const bi = vb.core[i] || 0;
        if (ai > bi) return 1;
        if (ai < bi) return -1;
    }

    const pa = va.prerelease;
    const pb = vb.prerelease;
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;

    const preLen = Math.max(pa.length, pb.length);
    for (let i = 0; i < preLen; i++) {
        const ai = pa[i];
        const bi = pb[i];
        if (ai === undefined) return -1;
        if (bi === undefined) return 1;
        if (ai === bi) continue;

        const aiNum = typeof ai === 'number';
        const biNum = typeof bi === 'number';
        if (aiNum && biNum) return ai > bi ? 1 : -1;
        if (aiNum) return -1;
        if (biNum) return 1;
        return ai > bi ? 1 : -1;
    }

    return 0;
}

function isRemoteVersionNewer(remoteVersion, installedVersion) {
    const compared = compareComparableVersion(remoteVersion, installedVersion);
    return compared !== null && compared > 0;
}

function toPluginItemFromManifest(manifest, source, parsed, branch, pluginSubpath) {
    if (!manifest || typeof manifest !== 'object') return null;
    const name = typeof manifest.name === 'string' && manifest.name.trim()
        ? manifest.name.trim()
        : path.posix.basename(normalizeRelativePath(pluginSubpath) || parsed.repo);
    return {
        name,
        displayName: (typeof manifest.displayName === 'string' && manifest.displayName.trim())
            ? manifest.displayName.trim()
            : name,
        description: (typeof manifest.description === 'string' && manifest.description.trim())
            ? manifest.description.trim()
            : '',
        version: (typeof manifest.version === 'string' && manifest.version.trim())
            ? manifest.version.trim()
            : '',
        author: (typeof manifest.author === 'string' && manifest.author.trim())
            ? manifest.author.trim()
            : parsed.owner,
        icon: (typeof manifest.icon === 'string' && manifest.icon.trim())
            ? manifest.icon.trim()
            : 'extension',
        category: getFirstString(manifest, ['category']) || inferPluginCategory(manifest),
        sourceId: source.id,
        sourceName: source.name,
        github: toGithubRef(parsed, branch, pluginSubpath),
    };
}

function toPluginItemFromRegistryEntry(name, entry, source, parsed, branch, sourceSubpath) {
    if (!entry || typeof entry !== 'object') return null;
    const pluginName = String(name || '').trim();
    if (!pluginName) return null;

    const hasDownloadUrl = typeof entry.downloadUrl === 'string' && entry.downloadUrl.trim();
    const explicitPathHint = getFirstString(entry, ['directoryName', 'directory', 'path', 'subpath']);
    const pluginSubpath = withSubpathPrefix(sourceSubpath, explicitPathHint || pluginName);

    const item = {
        name: pluginName,
        displayName: (typeof entry.displayName === 'string' && entry.displayName.trim())
            ? entry.displayName.trim()
            : pluginName,
        description: (typeof entry.description === 'string' && entry.description.trim())
            ? entry.description.trim()
            : '',
        version: (typeof entry.version === 'string' && entry.version.trim())
            ? entry.version.trim()
            : '',
        author: (typeof entry.author === 'string' && entry.author.trim())
            ? entry.author.trim()
            : parsed.owner,
        icon: (typeof entry.icon === 'string' && entry.icon.trim())
            ? entry.icon.trim()
            : 'extension',
        category: getFirstString(entry, ['category', 'group', 'pluginCategory']) || inferPluginCategory({
            name: pluginName,
            pluginType: getFirstString(entry, ['pluginType', 'type']),
        }),
        sourceId: source.id,
        sourceName: source.name,
    };

    if (hasDownloadUrl) {
        item.downloadUrl = entry.downloadUrl.trim();
    }
    if (explicitPathHint || !hasDownloadUrl) {
        item.github = toGithubRef(parsed, branch, pluginSubpath);
    }

    return item;
}

function collectPluginsFromRegistryPayload(payload, source, parsed, branch, sourceSubpath) {
    const result = [];

    if (Array.isArray(payload)) {
        for (const entry of payload) {
            if (!entry || typeof entry !== 'object') continue;
            const name = getFirstString(entry, ['name', 'pluginName', 'id', 'manifestName']);
            const item = toPluginItemFromRegistryEntry(name, entry, source, parsed, branch, sourceSubpath);
            if (item) result.push(item);
        }
        return result;
    }

    if (!payload || typeof payload !== 'object') {
        return result;
    }

    if (Array.isArray(payload.plugins)) {
        for (const entry of payload.plugins) {
            if (!entry || typeof entry !== 'object') continue;
            const name = getFirstString(entry, ['name', 'pluginName', 'id', 'manifestName']);
            const item = toPluginItemFromRegistryEntry(name, entry, source, parsed, branch, sourceSubpath);
            if (item) result.push(item);
        }
        return result;
    }

    if (payload.plugins && typeof payload.plugins === 'object') {
        for (const [name, entry] of Object.entries(payload.plugins)) {
            const item = toPluginItemFromRegistryEntry(name, entry, source, parsed, branch, sourceSubpath);
            if (item) result.push(item);
        }
    }

    return result;
}

async function fetchJson(url) {
    const res = await fetchWithGuard(url, { headers: { Accept: 'application/json, text/plain, */*' } });
    if (!res.ok) throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
    return res.json();
}

async function fetchText(url) {
    const res = await fetchWithGuard(url);
    if (!res.ok) throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
    return res.text();
}

async function resolveGithubDefaultBranch(owner, repo) {
    const key = `default-branch:${owner}/${repo}`.toLowerCase();
    const cached = cacheGet(key);
    if (cached) return cached;
    try {
        const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`);
        const branch = data.default_branch || 'main';
        cacheSet(key, branch);
        return branch;
    } catch {
        return 'main';
    }
}

async function listGithubManifestPaths(owner, repo, branch, sourceSubpath) {
    const cacheKey = `tree:${owner}/${repo}@${branch}`.toLowerCase();
    let tree = cacheGet(cacheKey);
    if (!tree) {
        const encodedBranch = encodeURIComponent(branch);
        const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedBranch}?recursive=1`);
        tree = Array.isArray(data?.tree) ? data.tree : [];
        cacheSet(cacheKey, tree);
    }
    const prefix = normalizeRelativePath(sourceSubpath);
    const byDir = new Map();

    for (const entry of tree) {
        if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string') continue;
        const filePath = normalizeRelativePath(entry.path);
        if (!filePath) continue;
        if (prefix && !(filePath === prefix || filePath.startsWith(`${prefix}/`))) continue;
        if (!(filePath.endsWith(`/${MANIFEST_NAME}`) || filePath.endsWith(`/${MANIFEST_NAME}${BLOCKED_EXT}`))) continue;

        const dir = normalizeRelativePath(path.posix.dirname(filePath));
        const previous = byDir.get(dir);
        const preferEnabled = filePath.endsWith(`/${MANIFEST_NAME}`);
        if (!previous || preferEnabled) {
            byDir.set(dir, filePath);
        }
    }

    return Array.from(byDir.values());
}

async function listPluginsFromGithubSource(source) {
    const parsed = parseGithubUrl(source.url);
    if (!parsed) throw new Error(`Invalid GitHub URL: ${source.url}`);

    const branch = parsed.branch || await resolveGithubDefaultBranch(parsed.owner, parsed.repo);
    const sourceSubpath = normalizeRelativePath(parsed.subpath);
    const base = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}`;
    const plugins = new Map();

    const registryCandidates = [
        'plugins.json',
        'plugin-store.json',
        'plugin-registry.json',
        'placeholder-registry.json',
    ];

    for (const fileName of registryCandidates) {
        const candidatePath = withSubpathPrefix(sourceSubpath, fileName);
        const candidateUrl = `${base}/${candidatePath}`;
        try {
            const payload = await fetchJson(candidateUrl);
            const collected = collectPluginsFromRegistryPayload(payload, source, parsed, branch, sourceSubpath);
            for (const item of collected) {
                if (item?.name) plugins.set(item.name, item);
            }
        } catch {
            // Ignore missing or incompatible registry files; fallback to manifest scan below.
        }
    }

    let manifestPaths = [];
    try {
        manifestPaths = await listGithubManifestPaths(parsed.owner, parsed.repo, branch, sourceSubpath);
    } catch {
        manifestPaths = [];
    }

    if (manifestPaths.length > 0) {
        const knownDirs = new Set(
            Array.from(plugins.values())
                .map(item => normalizeRelativePath(item?.github?.subpath || ''))
                .filter(Boolean)
        );

        for (const manifestPath of manifestPaths) {
            const pluginSubpath = normalizeRelativePath(path.posix.dirname(manifestPath));
            if (knownDirs.has(pluginSubpath)) continue;

            const manifestUrl = `${base}/${manifestPath}`;
            try {
                const manifest = JSON.parse(await fetchText(manifestUrl));
                const item = toPluginItemFromManifest(manifest, source, parsed, branch, pluginSubpath);
                if (!item?.name) continue;

                if (!plugins.has(item.name)) {
                    plugins.set(item.name, item);
                    continue;
                }

                const existing = plugins.get(item.name);
                plugins.set(item.name, {
                    ...item,
                    ...existing,
                    github: existing?.github || item.github,
                });
            } catch {
                // Skip invalid manifests and continue listing others.
            }
        }
    }

    const list = Array.from(plugins.values());
    if (list.length > 0) {
        return list.sort((a, b) => {
            const an = (a.displayName || a.name || '').toLowerCase();
            const bn = (b.displayName || b.name || '').toLowerCase();
            return an.localeCompare(bn);
        });
    }

    return [{
        name: `${parsed.owner}/${parsed.repo}`,
        displayName: `${parsed.repo} (GitHub)`,
        description: `GitHub 仓库 ${source.url}`,
        version: branch,
        author: parsed.owner,
        icon: 'hub',
        sourceId: source.id,
        sourceName: source.name,
        github: toGithubRef(parsed, branch, sourceSubpath),
    }];
}

async function listPluginsFromSource(source) {
    if (source.type === 'registry') {
        const data = await fetchJson(source.url);
        const plugins = Array.isArray(data) ? data : (data.plugins || []);
        return plugins.map(p => ({ ...p, sourceId: source.id, sourceName: source.name }));
    }
    if (source.type === 'github') {
        return listPluginsFromGithubSource(source);
    }
    return [];
}

// =============================================================================
// Install pipeline
// =============================================================================

function runNpmInstall(cwd, task) {
    return new Promise((resolve) => {
        pushLog(task, `$ npm install --omit=dev  (cwd: ${cwd})`);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd,
            env: { ...process.env },
            windowsHide: true,
        });
        child.stdout.on('data', d => pushLog(task, d.toString()));
        child.stderr.on('data', d => pushLog(task, d.toString()));
        child.on('error', err => {
            pushLog(task, `[error] ${err.message}`);
            resolve({ ok: false, error: err.message });
        });
        child.on('close', code => {
            pushLog(task, `[npm exit ${code}]`);
            resolve({ ok: code === 0, code });
        });
    });
}

async function installFromDir(sourceDir, task, { force = false, pluginManager } = {}) {
    const root = await findManifestRoot(sourceDir);
    if (!root) throw new Error('未找到 plugin-manifest.json，无法识别插件');
    const manifest = JSON.parse(await fsp.readFile(path.join(root, MANIFEST_NAME), 'utf-8'));
    if (!manifest.name) throw new Error('plugin-manifest.json 缺少 name 字段');

    const safeName = assertSafePluginName(manifest.name);
    const target = resolvePluginTarget(safeName);

    if (await pathExists(target)) {
        if (!force) {
            const err = new Error(`插件目录 ${safeName} 已存在`);
            err.code = 'EEXIST';
            throw err;
        }
        await ensureDir(BACKUP_DIR);
        const backupPath = path.join(BACKUP_DIR, `${safeName}-${Date.now()}`);
        pushLog(task, `[backup] ${target} -> ${backupPath}`);
        await moveDir(target, backupPath);
    }

    pushLog(task, `[copy] ${root} -> ${target}`);
    await moveDir(root, target);

    // npm install if package.json exists
    if (await pathExists(path.join(target, 'package.json'))) {
        const result = await runNpmInstall(target, task);
        if (!result.ok) {
            pushLog(task, `[warn] npm install 失败，插件已安装但依赖可能不完整。请手动处理。`);
        }
    } else {
        pushLog(task, '[skip] 未检测到 package.json，跳过 npm install');
    }

    // Reload plugins
    try {
        if (pluginManager?.loadPlugins) {
            await pluginManager.loadPlugins();
            pushLog(task, '[reload] 插件已热加载');
        }
    } catch (err) {
        pushLog(task, `[warn] 热加载失败: ${err.message}`);
    }

    return { name: safeName, displayName: manifest.displayName || safeName };
}

async function downloadToFile(url, destFile) {
    const res = await fetchWithGuard(url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    await pipeline(res.body, fs.createWriteStream(destFile));
}

async function installFromArchive(archivePath, task, options, archiveNameHint = '') {
    let format = detectArchiveFormat(archiveNameHint || archivePath);
    if (!format) {
        // Keep compatibility for extensionless URLs that still return zip payloads.
        format = 'zip';
        pushLog(task, '[warn] 未能识别压缩包后缀，按 .zip 尝试解压');
    }

    const workDir = path.join(TMP_DIR, `extract-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    await ensureDir(workDir);
    try {
        pushLog(task, `[extract:${format}] ${archivePath} -> ${workDir}`);
        if (format === 'zip') {
            await extract(archivePath, { dir: workDir });
        } else {
            await tar.x({
                file: archivePath,
                cwd: workDir,
                strict: true,
            });
        }
        await assertSafeExtractedTree(workDir);
        return await installFromDir(workDir, task, options);
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function installFromGithub(parsed, task, options) {
    const branch = parsed.branch || await resolveGithubDefaultBranch(parsed.owner, parsed.repo);
    const zipUrl = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip/refs/heads/${branch}`;
    const zipPath = path.join(TMP_DIR, `gh-${parsed.owner}-${parsed.repo}-${Date.now()}.zip`);
    await ensureDir(TMP_DIR);
    pushLog(task, `[download] ${zipUrl}`);
    await downloadToFile(zipUrl, zipPath);
    try {
        // If a subpath was given, extract then narrow down
        const workDir = path.join(TMP_DIR, `extract-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
        await ensureDir(workDir);
        try {
            await extract(zipPath, { dir: workDir });
            await assertSafeExtractedTree(workDir);
            let searchRoot = workDir;
            if (parsed.subpath) {
                const entries = await fsp.readdir(workDir, { withFileTypes: true });
                const topLevel = entries.find(e => e.isDirectory());
                if (topLevel) {
                    searchRoot = safeJoin(path.join(workDir, topLevel.name), parsed.subpath);
                }
            }
            return await installFromDir(searchRoot, task, options);
        } finally {
            await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    } finally {
        await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
}

// =============================================================================
// Router
// =============================================================================

module.exports = function (options) {
    const router = express.Router();
    const { pluginManager } = options;

    // Ensure dirs exist (sync-friendly)
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, UPLOAD_DIR),
            filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
        }),
        limits: {
            fileSize: MAX_UPLOAD_BYTES,
            files: MAX_UPLOAD_FILES,
        },
    });

    // ---------------------------------------------------------------------
    // Sources
    // ---------------------------------------------------------------------
    router.get('/plugin-store/sources', async (req, res) => {
        try {
            res.json({ sources: await loadSources() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/plugin-store/sources', async (req, res) => {
        try {
            const { name, url, type } = req.body || {};
            if (!name || !url || !['registry', 'github'].includes(type)) {
                return res.status(400).json({ error: '参数无效：需要 name / url / type(registry|github)' });
            }
            if (type === 'github' && !parseGithubUrl(url)) {
                return res.status(400).json({ error: '无效的 GitHub URL' });
            }
            const existing = await loadSources();
            const next = { id: newId('src'), name, url, type, builtin: false };
            const duplicate = existing.find(s => sourceFingerprint(s) === sourceFingerprint(next));
            if (duplicate) {
                return res.status(409).json({
                    error: `源已存在：${duplicate.name}`,
                    source: duplicate,
                });
            }
            const entry = next;
            await saveUserSources([...existing.filter(s => !s.builtin), entry]);
            res.json({ source: entry });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/plugin-store/sources/:id', async (req, res) => {
        try {
            const list = await loadSources();
            const target = list.find(s => s.id === req.params.id);
            if (!target) return res.status(404).json({ error: '源不存在' });
            if (target.builtin) return res.status(400).json({ error: '内置源不可删除' });
            await saveUserSources(list.filter(s => s.id !== req.params.id));
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ---------------------------------------------------------------------
    // Aggregate plugin list
    // ---------------------------------------------------------------------
    router.get('/plugin-store', async (req, res) => {
        try {
            const sources = await loadSources();
            const installed = new Map();
            try {
                const entries = await fsp.readdir(PLUGIN_DIR, { withFileTypes: true });
                for (const e of entries) {
                    if (!e.isDirectory()) continue;
                    const m1 = path.join(PLUGIN_DIR, e.name, MANIFEST_NAME);
                    const m2 = m1 + BLOCKED_EXT;
                    try {
                        const content = await fsp.readFile(await pathExists(m1) ? m1 : m2, 'utf-8');
                        const mf = JSON.parse(content);
                        if (mf.name) {
                            installed.set(mf.name, {
                                version: typeof mf.version === 'string' ? mf.version.trim() : '',
                            });
                        }
                    } catch {}
                }
            } catch {}

            // Fetch all sources in parallel so one slow source doesn't block the rest.
            const results = await Promise.allSettled(
                sources.map(source => listPluginsFromSource(source))
            );

            const all = [];
            const errors = [];
            results.forEach((result, idx) => {
                const source = sources[idx];
                if (result.status === 'fulfilled') {
                    for (const p of result.value) {
                        const local = installed.get(p.name);
                        p.installed = !!local;
                        if (local?.version) {
                            p.installedVersion = local.version;
                        }
                        if (p.installed && p.version && local?.version) {
                            p.updateAvailable = isRemoteVersionNewer(p.version, local.version);
                        } else {
                            p.updateAvailable = false;
                        }
                        all.push(p);
                    }
                } else {
                    const reason = result.reason;
                    errors.push({
                        sourceId: source.id,
                        error: reason && reason.message ? reason.message : String(reason),
                    });
                }
            });
            res.json({ plugins: all, total: all.length, sources, errors });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ---------------------------------------------------------------------
    // Install (from source / github URL)
    // ---------------------------------------------------------------------
    router.post('/plugin-store/install', async (req, res) => {
        const { sourceId, pluginName, githubUrl, downloadUrl, force } = req.body || {};
        const task = createTask();

        // Respond early so client can subscribe to logs
        res.json({ taskId: task.id, message: '安装任务已启动' });

        (async () => {
            try {
                task.status = 'running';

                if (githubUrl) {
                    const parsed = parseGithubUrl(githubUrl);
                    if (!parsed) throw new Error('无效的 GitHub URL');
                    await installFromGithub(parsed, task, { force, pluginManager });
                } else if (downloadUrl) {
                    const archiveNameHint = archiveNameHintFromUrl(downloadUrl);
                    const archivePath = path.join(TMP_DIR, `dl-${Date.now()}`);
                    await ensureDir(TMP_DIR);
                    pushLog(task, `[download] ${downloadUrl}`);
                    await downloadToFile(downloadUrl, archivePath);
                    try {
                        await installFromArchive(archivePath, task, { force, pluginManager }, archiveNameHint);
                    } finally {
                        await fsp.rm(archivePath, { force: true }).catch(() => {});
                    }
                } else if (sourceId && pluginName) {
                    const sources = await loadSources();
                    const source = sources.find(s => s.id === sourceId);
                    if (!source) throw new Error('源不存在');
                    const plugins = await listPluginsFromSource(source);
                    const target = plugins.find(p => p.name === pluginName);
                    if (!target) throw new Error(`源中未找到插件 ${pluginName}`);
                    if (target.github) {
                        await installFromGithub(target.github, task, { force, pluginManager });
                    } else if (target.downloadUrl) {
                        const archiveNameHint = archiveNameHintFromUrl(target.downloadUrl);
                        const archivePath = path.join(TMP_DIR, `dl-${Date.now()}`);
                        await ensureDir(TMP_DIR);
                        pushLog(task, `[download] ${target.downloadUrl}`);
                        await downloadToFile(target.downloadUrl, archivePath);
                        try {
                            await installFromArchive(archivePath, task, { force, pluginManager }, archiveNameHint);
                        } finally {
                            await fsp.rm(archivePath, { force: true }).catch(() => {});
                        }
                    } else {
                        throw new Error('插件条目缺少 downloadUrl 或 GitHub 信息');
                    }
                } else {
                    throw new Error('请求缺少 sourceId+pluginName / githubUrl / downloadUrl');
                }

                finishTask(task, 'success', '安装完成');
            } catch (err) {
                pushLog(task, `[fatal] ${err.message}`);
                finishTask(task, err.code === 'EEXIST' ? 'conflict' : 'error', err.message);
            }
        })();
    });

    // ---------------------------------------------------------------------
    // Uninstall plugin (move to backup and hot-reload)
    // ---------------------------------------------------------------------
    router.post('/plugin-store/uninstall', async (req, res) => {
        try {
            const pluginName = String(req.body?.pluginName || '').trim();
            if (!pluginName) {
                return res.status(400).json({ error: '参数无效：需要 pluginName' });
            }

            const safeName = assertSafePluginName(pluginName);
            const target = resolvePluginTarget(safeName);

            if (!(await pathExists(target))) {
                return res.status(404).json({ error: `插件 ${safeName} 不存在` });
            }

            await ensureDir(BACKUP_DIR);
            const backupPath = path.join(BACKUP_DIR, `${safeName}-removed-${Date.now()}`);
            await moveDir(target, backupPath);

            if (pluginManager?.loadPlugins) {
                try {
                    await pluginManager.loadPlugins();
                } catch (reloadErr) {
                    return res.status(500).json({
                        error: '插件目录已移除，但热加载失败',
                        details: reloadErr.message,
                    });
                }
            }

            res.json({
                ok: true,
                message: `插件 ${safeName} 已卸载`,
                backupPath: path.relative(ROOT, backupPath),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ---------------------------------------------------------------------
    // Upload (.zip/.tar/.tar.gz/.tgz OR folder via webkitdirectory)
    // ---------------------------------------------------------------------
    router.post('/plugin-store/upload', upload.array('files'), async (req, res) => {
        const files = req.files || [];
        const force = req.body.force === 'true' || req.body.force === true;
        const relPaths = (() => {
            const v = req.body.relPaths;
            if (!v) return [];
            if (Array.isArray(v)) return v;
            try { return JSON.parse(v); } catch { return [v]; }
        })();

        const task = createTask();
        res.json({ taskId: task.id, message: '上传安装任务已启动' });

        (async () => {
            try {
                task.status = 'running';
                if (!files.length) throw new Error('未上传任何文件');

                // Case 1: single archive
                if (files.length === 1 && isSupportedArchiveName(files[0].originalname)) {
                    await installFromArchive(files[0].path, task, { force, pluginManager }, files[0].originalname);
                } else {
                    if (files.length === 1) {
                        const rel = String(relPaths[0] || files[0].originalname || '');
                        const looksLikeFolderUpload = /[\\/]/.test(rel);
                        if (!looksLikeFolderUpload) {
                            throw new Error('单文件上传仅支持 .zip / .tar / .tar.gz / .tgz，请改用受支持压缩包或选择文件夹上传。');
                        }
                    }
                    // Case 2: folder upload — reconstruct tree in a work dir
                    const workDir = path.join(TMP_DIR, `folder-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
                    await ensureDir(workDir);
                    try {
                        for (let i = 0; i < files.length; i++) {
                            const f = files[i];
                            const rel = relPaths[i] || f.originalname;
                            const dest = safeJoin(workDir, rel);
                            await ensureDir(path.dirname(dest));
                            await fsp.rename(f.path, dest).catch(async () => {
                                await fsp.copyFile(f.path, dest);
                                await fsp.rm(f.path, { force: true });
                            });
                        }
                        await installFromDir(workDir, task, { force, pluginManager });
                    } finally {
                        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
                    }
                }

                // Cleanup any leftover uploads
                for (const f of files) {
                    await fsp.rm(f.path, { force: true }).catch(() => {});
                }

                finishTask(task, 'success', '安装完成');
            } catch (err) {
                pushLog(task, `[fatal] ${err.message}`);
                finishTask(task, err.code === 'EEXIST' ? 'conflict' : 'error', err.message);
            }
        })();
    });

    // ---------------------------------------------------------------------
    // SSE: install log
    // ---------------------------------------------------------------------
    router.get('/plugin-store/install-log/:taskId', (req, res) => {
        const task = tasks.get(req.params.taskId);
        if (!task) return res.status(404).json({ error: '任务不存在' });

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Replay
        for (const line of task.logs) send('log', line);

        if (task.status === 'success' || task.status === 'error' || task.status === 'conflict') {
            send('end', { status: task.status, message: task.message });
            return res.end();
        }

        const onLog = (line) => send('log', line);
        const onEnd = (payload) => {
            send('end', payload);
            task.bus.off('log', onLog);
            task.bus.off('end', onEnd);
            res.end();
        };
        task.bus.on('log', onLog);
        task.bus.on('end', onEnd);

        req.on('close', () => {
            task.bus.off('log', onLog);
            task.bus.off('end', onEnd);
        });
    });

    router.get('/plugin-store/install-status/:taskId', (req, res) => {
        const task = tasks.get(req.params.taskId);
        if (!task) return res.status(404).json({ error: '任务不存在' });
        res.json({ id: task.id, status: task.status, message: task.message, logs: task.logs });
    });

    return router;
};

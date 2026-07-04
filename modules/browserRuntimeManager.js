const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROFILE_DIR = path.join(PROJECT_ROOT, 'Plugin', 'ChromeBridge', 'managed-profile');
const DEFAULT_EXTENSION_DIR = path.join(PROJECT_ROOT, 'Plugin', 'ChromeBridge', 'VCPChrome');
const DEFAULT_STAGED_EXTENSION_ROOT = path.join(PROJECT_ROOT, 'Plugin', 'ChromeBridge', 'managed-extension-stage');
const MANAGED_CONFIG_FILE = 'managed-runtime-config.json';
const MANAGED_TOKEN_FILE = path.join(PROJECT_ROOT, 'Plugin', 'ChromeBridge', 'managed-runtime-token.json');

let chromeProcess = null;
let launchPromise = null;
let idleTimer = null;
let managedToken = null;
let tokenCreatedAt = 0;
let currentExecutablePath = null;
let currentProfileDir = null;
let currentDebuggingPort = null;
let currentExtensionDir = null;
let lastLaunchArgs = [];
let startedAt = null;
let lastTouchedAt = null;
let lastError = null;
let shutdownHooksRegistered = false;

function readBooleanEnv(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return ['true', '1', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function readIntegerEnv(name, defaultValue, minValue = 0, maxValue = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(process.env[name], 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, minValue), maxValue);
}

function resolveProjectPath(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function resolveExtensionDir() {
    const configured = resolveProjectPath(process.env.VCP_BROWSER_EXTENSION_DIR, DEFAULT_EXTENSION_DIR);
    const configuredManifest = path.join(configured, 'manifest.json');
    if (fs.existsSync(configuredManifest)) {
        return configured;
    }

    const fallbackManifest = path.join(DEFAULT_EXTENSION_DIR, 'manifest.json');
    if (fs.existsSync(fallbackManifest)) {
        if (process.env.VCP_BROWSER_EXTENSION_DIR) {
            console.warn(`[BrowserRuntimeManager] configured VCP_BROWSER_EXTENSION_DIR is unavailable: ${configured}. Falling back to Bridge bundled extension: ${DEFAULT_EXTENSION_DIR}`);
        }
        return DEFAULT_EXTENSION_DIR;
    }

    return configured;
}

function getRuntimeConfig() {
    return {
        enabled: readBooleanEnv('VCP_BROWSER_RUNTIME_ENABLED', false),
        idleTimeoutMs: readIntegerEnv('VCP_BROWSER_IDLE_TIMEOUT_MS', 300000, 10000),
        profileDir: resolveProjectPath(process.env.VCP_BROWSER_PROFILE_DIR, DEFAULT_PROFILE_DIR),
        extensionDir: resolveExtensionDir(),
        stagedExtensionRoot: resolveProjectPath(process.env.VCP_BROWSER_STAGED_EXTENSION_DIR, DEFAULT_STAGED_EXTENSION_ROOT),
        loadExtension: readBooleanEnv('VCP_BROWSER_LOAD_VCPCHROME', true),
        headless: readBooleanEnv('VCP_BROWSER_HEADLESS', false),
        executablePath: String(process.env.VCP_BROWSER_EXECUTABLE_PATH || '').trim(),
        remoteDebuggingPort: readIntegerEnv('VCP_BROWSER_REMOTE_DEBUGGING_PORT', 0, 0, 65535),
        tokenTtlMs: readIntegerEnv('VCP_BROWSER_MANAGED_TOKEN_TTL_MS', 3600000, 60000),
        windowWidth: readIntegerEnv('VCP_BROWSER_WINDOW_WIDTH', 1280, 320, 10000),
        windowHeight: readIntegerEnv('VCP_BROWSER_WINDOW_HEIGHT', 900, 240, 10000),
        startMinimized: readBooleanEnv('VCP_BROWSER_START_MINIMIZED', false),
        windowsHide: readBooleanEnv('VCP_BROWSER_WINDOWS_HIDE', false),
        restrictExtensions: readBooleanEnv('VCP_BROWSER_RESTRICT_EXTENSIONS', false),
        maxTabs: readIntegerEnv('VCP_BROWSER_MAX_TABS', 8, 1, 200),
        serverUrl: String(process.env.VCP_BROWSER_SERVER_URL || `ws://localhost:${process.env.PORT || 6005}`).trim(),
        vcpKey: String(process.env.VCP_Key || process.env.VCP_KEY || '').trim()
    };
}

function normalizeCandidate(candidate) {
    if (!candidate) return null;
    const trimmed = String(candidate).trim().replace(/^"|"$/g, '');
    return trimmed || null;
}

function getChromeCandidates() {
    const candidates = [];
    const configured = normalizeCandidate(process.env.VCP_BROWSER_EXECUTABLE_PATH);
    if (configured) candidates.push(configured);

    if (process.platform === 'win32') {
        const roots = [
            process.env.PROGRAMFILES,
            process.env['PROGRAMFILES(X86)'],
            process.env.LOCALAPPDATA
        ].filter(Boolean);

        for (const root of roots) {
            candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
            candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
            candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
        candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    } else {
        candidates.push('/usr/bin/google-chrome');
        candidates.push('/usr/bin/google-chrome-stable');
        candidates.push('/usr/bin/chromium');
        candidates.push('/usr/bin/chromium-browser');
        candidates.push('/usr/bin/microsoft-edge');
    }

    return [...new Set(candidates.map(normalizeCandidate).filter(Boolean))];
}

function findChromeExecutable() {
    for (const candidate of getChromeCandidates()) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch (_) {
            try {
                fs.accessSync(candidate, fs.constants.F_OK);
                return candidate;
            } catch (__) {
                // continue
            }
        }
    }
    return null;
}

function isProcessAlive() {
    return !!chromeProcess && !chromeProcess.killed && chromeProcess.exitCode === null;
}

function loadPersistedManagedToken() {
    try {
        const raw = fs.readFileSync(MANAGED_TOKEN_FILE, 'utf8');
        const payload = JSON.parse(raw);
        if (payload && payload.token && payload.createdAt) {
            managedToken = String(payload.token);
            tokenCreatedAt = Number(payload.createdAt) || 0;
            return true;
        }
    } catch (_) {
        // ignore missing/invalid token file
    }
    return false;
}

function persistManagedToken() {
    try {
        fs.mkdirSync(path.dirname(MANAGED_TOKEN_FILE), { recursive: true });
        fs.writeFileSync(MANAGED_TOKEN_FILE, JSON.stringify({
            token: managedToken,
            createdAt: tokenCreatedAt,
            updatedAt: Date.now()
        }, null, 2), 'utf8');
    } catch (error) {
        console.warn('[BrowserRuntimeManager] failed to persist managed token:', error.message);
    }
}

function isTokenExpired(config = getRuntimeConfig()) {
    if (!managedToken) {
        loadPersistedManagedToken();
    }
    return !managedToken || !tokenCreatedAt || (Date.now() - tokenCreatedAt > config.tokenTtlMs);
}

function refreshManagedToken(config = getRuntimeConfig()) {
    if (isTokenExpired(config)) {
        managedToken = crypto.randomBytes(32).toString('hex');
        tokenCreatedAt = Date.now();
        persistManagedToken();
    }
    return managedToken;
}

function makeManagedRuntimePayload(config) {
    return {
        managedRuntime: true,
        clientKind: 'managed',
        managedToken: refreshManagedToken(config),
        serverUrl: config.serverUrl,
        vcpKey: config.vcpKey,
        maxTabs: config.maxTabs,
        generatedAt: new Date().toISOString()
    };
}

function buildChromeLocalStorageValue(value) {
    return {
        value,
        last_modified: `${Date.now()}000`
    };
}

async function writeManagedStorageFallback(config, payload) {
    const extensionManifest = JSON.parse(await fsp.readFile(path.join(config.extensionDir, 'manifest.json'), 'utf8'));
    const extensionKeySource = JSON.stringify({
        key: extensionManifest.key || '',
        path: config.extensionDir
    });
    const extensionId = crypto.createHash('sha256').update(extensionKeySource).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, ch => String.fromCharCode(97 + Number.parseInt(ch, 16) % 16));

    // 未打包开发扩展的 ID 由 Chrome 根据路径/key 计算，外部无法稳定复刻。
    // 因此这里不强依赖该 fallback；主路径仍是 web_accessible_resources。
    // 保留诊断文件，便于人工确认 runtime payload。
    const fallbackDir = path.join(config.profileDir, 'VCPManagedRuntime');
    await fsp.mkdir(fallbackDir, { recursive: true });
    await fsp.writeFile(path.join(fallbackDir, 'runtime-config.json'), JSON.stringify({
        extensionId,
        ...payload
    }, null, 2), 'utf8');
}

async function stageManagedExtension(config) {
    if (!config.loadExtension) return config.extensionDir;

    const sourceManifestPath = path.join(config.extensionDir, 'manifest.json');
    try {
        await fsp.access(sourceManifestPath);
    } catch (error) {
        throw new Error(`VCPChrome 源扩展目录不可用: ${config.extensionDir}`);
    }

    // 不要把 --load-extension 的 unpacked 扩展目录放进 --user-data-dir。
    // Chrome/Edge 在部分版本中会拒绝或静默忽略 user-data-dir 内部的 unpacked extension。
    const stagedRoot = config.stagedExtensionRoot;
    const stagedExtensionDir = path.join(stagedRoot, 'VCPChrome');
    await fsp.rm(stagedExtensionDir, { recursive: true, force: true });
    await fsp.mkdir(stagedRoot, { recursive: true });
    await fsp.cp(config.extensionDir, stagedExtensionDir, {
        recursive: true,
        force: true,
        filter: (src) => {
            const base = path.basename(src);
            return !['.git', 'node_modules'].includes(base);
        }
    });

    return stagedExtensionDir;
}

async function writeManagedExtensionConfig(config) {
    if (!config.loadExtension) return null;

    const manifestPath = path.join(config.extensionDir, 'manifest.json');
    try {
        await fsp.access(manifestPath);
    } catch (error) {
        throw new Error(`VCPChrome 扩展目录不可用: ${config.extensionDir}`);
    }

    const runtimeConfigPath = path.join(config.extensionDir, MANAGED_CONFIG_FILE);
    const payload = makeManagedRuntimePayload(config);

    await fsp.writeFile(runtimeConfigPath, JSON.stringify(payload, null, 2), 'utf8');
    await writeManagedStorageFallback(config, payload).catch(error => {
        console.warn('[BrowserRuntimeManager] managed storage fallback write failed:', error.message);
    });
    return runtimeConfigPath;
}

async function prepareManagedProfile(config) {
    await fsp.mkdir(config.profileDir, { recursive: true });

    const defaultProfileDir = path.join(config.profileDir, 'Default');
    await fsp.mkdir(defaultProfileDir, { recursive: true });

    const preferencesPath = path.join(defaultProfileDir, 'Preferences');
    let preferences = {};
    try {
        preferences = JSON.parse(await fsp.readFile(preferencesPath, 'utf8'));
    } catch (_) {
        preferences = {};
    }

    preferences.profile = {
        ...(preferences.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true
    };
    preferences.extensions = {
        ...(preferences.extensions || {}),
        ui: {
            ...(preferences.extensions?.ui || {}),
            developer_mode: true
        }
    };
    preferences.session = {
        ...(preferences.session || {}),
        restore_on_startup: 5
    };
    preferences.browser = {
        ...(preferences.browser || {}),
        check_default_browser: false
    };

    await fsp.writeFile(preferencesPath, JSON.stringify(preferences, null, 2), 'utf8');

    const localStatePath = path.join(config.profileDir, 'Local State');
    let localState = {};
    try {
        localState = JSON.parse(await fsp.readFile(localStatePath, 'utf8'));
    } catch (_) {
        localState = {};
    }

    localState.profile = {
        ...(localState.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true
    };
    localState.browser = {
        ...(localState.browser || {}),
        enabled_labs_experiments: []
    };
    localState.extensions = {
        ...(localState.extensions || {}),
        ui: {
            ...(localState.extensions?.ui || {}),
            developer_mode: true
        }
    };

    await fsp.writeFile(localStatePath, JSON.stringify(localState, null, 2), 'utf8');

    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lockPath = path.join(config.profileDir, lockName);
        try {
            await fsp.rm(lockPath, { force: true, recursive: true });
        } catch (_) {
            // ignore stale Chrome locks
        }
    }
}

function buildChromeArgs(config) {
    const args = [
        `--user-data-dir=${config.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        '--noerrdialogs',
        '--disable-sync',
        '--disable-popup-blocking',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,SessionRestore,InfiniteSessionRestore',
        '--enable-logging=stderr',
        '--v=1',
        `--window-size=${config.windowWidth},${config.windowHeight}`
    ];

    if (config.remoteDebuggingPort > 0) {
        args.push(`--remote-debugging-port=${config.remoteDebuggingPort}`);
    } else {
        args.push('--remote-debugging-port=0');
    }

    if (config.headless) {
        args.push('--headless=new');
    } else if (config.startMinimized) {
        args.push('--start-minimized');
    }

    if (config.loadExtension) {
        // 托管运行时必须让命令行加载的未打包扩展成为唯一扩展来源。
        // 仅使用 --load-extension 在部分 Chrome/Edge 环境中会被策略/安全提示静默禁用；
        // 与 --disable-extensions-except 同时使用是自动化场景加载 unpacked MV3 扩展的更稳定组合。
        if (config.restrictExtensions) {
            args.push(`--disable-extensions-except=${config.extensionDir}`);
        }
        args.push(`--load-extension=${config.extensionDir}`);
    }

    args.push('about:blank');
    return args;
}

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function scheduleIdleClose() {
    const config = getRuntimeConfig();
    clearIdleTimer();

    if (!config.enabled || config.idleTimeoutMs <= 0 || !isProcessAlive()) {
        return;
    }

    idleTimer = setTimeout(() => {
        closeManagedBrowser('idle_timeout').catch(error => {
            console.error('[BrowserRuntimeManager] idle close failed:', error.message);
        });
    }, config.idleTimeoutMs);
}

function touchManagedBrowser() {
    lastTouchedAt = Date.now();
    scheduleIdleClose();
    return getManagedBrowserStatus();
}

async function ensureManagedBrowser(options = {}) {
    const config = { ...getRuntimeConfig(), ...options };

    if (!config.enabled) {
        throw new Error('托管浏览器运行时未启用，请设置 VCP_BROWSER_RUNTIME_ENABLED=true');
    }

    if (isProcessAlive()) {
        touchManagedBrowser();
        return getManagedBrowserStatus();
    }

    if (launchPromise) {
        return launchPromise;
    }

    launchPromise = (async () => {
        lastError = null;
        const executablePath = config.executablePath || findChromeExecutable();
        if (!executablePath) {
            throw new Error('未找到 Chrome/Chromium/Edge 可执行文件，请设置 VCP_BROWSER_EXECUTABLE_PATH');
        }

        await prepareManagedProfile(config);
        const stagedExtensionDir = await stageManagedExtension(config);
        const launchConfig = { ...config, extensionDir: stagedExtensionDir };
        const runtimeConfigPath = await writeManagedExtensionConfig(launchConfig);
        if (launchConfig.loadExtension) {
            const stagedManifestPath = path.join(launchConfig.extensionDir, 'manifest.json');
            const stagedRuntimeConfigPath = path.join(launchConfig.extensionDir, MANAGED_CONFIG_FILE);
            await fsp.access(stagedManifestPath);
            await fsp.access(stagedRuntimeConfigPath);
        }

        const args = buildChromeArgs(launchConfig);
        lastLaunchArgs = [...args];
        console.log(`[BrowserRuntimeManager] launching managed Chrome: executable=${executablePath}, profile=${launchConfig.profileDir}, extension=${launchConfig.loadExtension ? launchConfig.extensionDir : 'disabled'}, runtimeConfig=${runtimeConfigPath || 'N/A'}`);
        chromeProcess = spawn(executablePath, args, {
            cwd: PROJECT_ROOT,
            detached: false,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: launchConfig.windowsHide
        });

        currentExecutablePath = executablePath;
        currentProfileDir = launchConfig.profileDir;
        currentDebuggingPort = launchConfig.remoteDebuggingPort;
        currentExtensionDir = launchConfig.loadExtension ? launchConfig.extensionDir : null;
        startedAt = Date.now();
        lastTouchedAt = Date.now();

        chromeProcess.stderr.on('data', data => {
            const text = data.toString().trim();
            if (text) {
                lastError = text.slice(-1000);
                if (readBooleanEnv('DebugMode', false)) {
                    console.warn('[BrowserRuntimeManager][chrome]', text);
                }
            }
        });

        chromeProcess.on('exit', (code, signal) => {
            console.log(`[BrowserRuntimeManager] managed Chrome exited. code=${code}, signal=${signal}`);
            chromeProcess = null;
            startedAt = null;
            clearIdleTimer();
        });

        chromeProcess.on('error', error => {
            lastError = error.message;
            chromeProcess = null;
            startedAt = null;
            clearIdleTimer();
        });

        registerShutdownHooks();
        scheduleIdleClose();

        return getManagedBrowserStatus();
    })();

    try {
        return await launchPromise;
    } finally {
        launchPromise = null;
    }
}

function killProcessTree(pid) {
    return new Promise(resolve => {
        if (!pid) return resolve();
        if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
                windowsHide: true,
                stdio: 'ignore'
            });
            killer.on('close', () => resolve());
            killer.on('error', () => resolve());
            return;
        }

        try {
            process.kill(pid, 'SIGTERM');
        } catch (_) {
            // ignore
        }
        setTimeout(resolve, 800);
    });
}

async function closeManagedBrowser(reason = 'manual') {
    clearIdleTimer();

    const proc = chromeProcess;
    if (!proc) {
        return getManagedBrowserStatus({ lastCloseReason: reason });
    }

    const pid = proc.pid;
    try {
        proc.kill('SIGTERM');
    } catch (_) {
        // ignore
    }

    await Promise.race([
        new Promise(resolve => proc.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2500))
    ]);

    if (chromeProcess === proc && isProcessAlive()) {
        await killProcessTree(pid);
    }

    if (chromeProcess === proc) {
        chromeProcess = null;
    }

    startedAt = null;
    return getManagedBrowserStatus({ lastCloseReason: reason });
}

async function restartManagedBrowser() {
    await closeManagedBrowser('restart');
    return ensureManagedBrowser();
}
async function readDevToolsActivePort() {
    if (!isProcessAlive()) {
        return null;
    }

    const profileDir = currentProfileDir || getRuntimeConfig().profileDir;
    const activePortPath = path.join(profileDir, 'DevToolsActivePort');

    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const content = await fsp.readFile(activePortPath, 'utf8');
            const [portLine, wsPathLine] = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const port = Number.parseInt(portLine, 10);
            if (Number.isFinite(port) && wsPathLine) {
                return { port, wsPath: wsPathLine, activePortPath };
            }
        } catch (_) {
            // Chrome 可能仍在启动，稍后重试
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return null;
}

async function getManagedBrowserWebSocketEndpoint() {
    const activePort = await readDevToolsActivePort();
    if (!activePort) return null;
    return `ws://127.0.0.1:${activePort.port}${activePort.wsPath}`;
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`DevTools JSON parse failed: ${error.message}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('DevTools request timed out'));
        });
        req.on('error', reject);
    });
}

async function getManagedBrowserDebugTargets() {
    const activePort = await readDevToolsActivePort();
    if (!activePort) {
        return {
            available: false,
            reason: 'DevToolsActivePort not available',
            devToolsActivePortFile: path.join(currentProfileDir || getRuntimeConfig().profileDir, 'DevToolsActivePort')
        };
    }

    const targets = await httpGetJson(`http://127.0.0.1:${activePort.port}/json/list`);
    const summarizedTargets = Array.isArray(targets)
        ? targets.map(target => ({
            id: target.id,
            type: target.type,
            title: target.title,
            url: target.url,
            webSocketDebuggerUrl: target.webSocketDebuggerUrl ? '[present]' : null
        }))
        : [];

    return {
        available: true,
        port: activePort.port,
        targetCount: summarizedTargets.length,
        extensionTargets: summarizedTargets.filter(target => String(target.url || '').startsWith('chrome-extension://')),
        targets: summarizedTargets
    };
}

function getManagedToken() {
    return refreshManagedToken();
}

function validateManagedToken(token) {
    if (!managedToken) {
        loadPersistedManagedToken();
    }
    return !!token && !!managedToken && token === managedToken && !isTokenExpired();
}

function getManagedBrowserStatus(extra = {}) {
    const config = getRuntimeConfig();
    return {
        enabled: config.enabled,
        running: isProcessAlive(),
        pid: isProcessAlive() ? chromeProcess.pid : null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        lastTouchedAt: lastTouchedAt ? new Date(lastTouchedAt).toISOString() : null,
        executablePath: currentExecutablePath,
        profileDir: currentProfileDir || config.profileDir,
        extensionDir: currentExtensionDir || config.extensionDir,
        sourceExtensionDir: config.extensionDir,
        stagedExtensionRoot: config.stagedExtensionRoot,
        remoteDebuggingPort: currentDebuggingPort,
        devToolsActivePortFile: path.join(currentProfileDir || config.profileDir, 'DevToolsActivePort'),
        loadExtension: config.loadExtension,
        restrictExtensions: config.restrictExtensions,
        headless: config.headless,
        windowsHide: config.windowsHide,
        startMinimized: config.startMinimized,
        idleTimeoutMs: config.idleTimeoutMs,
        maxTabs: config.maxTabs,
        tokenCreatedAt: tokenCreatedAt ? new Date(tokenCreatedAt).toISOString() : null,
        tokenValid: !!managedToken && !isTokenExpired(config),
        lastLaunchArgs,
        lastError,
        ...extra
    };
}

function registerShutdownHooks() {
    if (shutdownHooksRegistered) return;
    shutdownHooksRegistered = true;

    const cleanup = () => {
        clearIdleTimer();
        if (chromeProcess && isProcessAlive()) {
            try {
                chromeProcess.kill('SIGTERM');
            } catch (_) {
                // ignore
            }
        }
    };

    process.once('exit', cleanup);
    process.once('SIGINT', () => {
        cleanup();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        cleanup();
        process.exit(143);
    });
}

module.exports = {
    ensureManagedBrowser,
    closeManagedBrowser,
    touchManagedBrowser,
    getManagedBrowserStatus,
    restartManagedBrowser,
    getManagedBrowserWebSocketEndpoint,
    getManagedBrowserDebugTargets,
    getManagedToken,
    validateManagedToken
};
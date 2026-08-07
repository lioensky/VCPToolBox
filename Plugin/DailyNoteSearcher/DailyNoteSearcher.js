const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let serviceProcess = null;
let serviceReadyPromise = null;
let serviceShutdownPromise = null;
let serviceGeneration = 0;
let serviceConfig = {
    host: '127.0.0.1',
    port: 38765,
    timeout: 60000,
    shutdownTimeout: 5000,
    executablePath: null,
    debug: false
};

function createTextResult(text) {
    return {
        content: [{
            type: 'text',
            text: String(text ?? '')
        }]
    };
}

function getPlatformTarget() {
    const targets = {
        'win32:x64': { triple: 'x86_64-pc-windows-msvc', extension: '.exe' },
        'win32:arm64': { triple: 'aarch64-pc-windows-msvc', extension: '.exe' },
        'linux:x64': { triple: 'x86_64-unknown-linux-gnu', extension: '' },
        'linux:arm64': { triple: 'aarch64-unknown-linux-musl', extension: '' },
        'darwin:x64': { triple: 'x86_64-apple-darwin', extension: '' },
        'darwin:arm64': { triple: 'aarch64-apple-darwin', extension: '' }
    };
    return targets[`${process.platform}:${process.arch}`] || null;
}

function getExecutableCandidates() {
    const target = getPlatformTarget();
    if (!target) return [];

    const pluginDir = __dirname;
    const binaryName = `DailyNoteSearcher${target.extension}`;
    return [
        path.join(pluginDir, `DailyNoteSearcher-${target.triple}${target.extension}`),
        path.join(pluginDir, binaryName),
        path.join(pluginDir, 'src', 'target', target.triple, 'release', binaryName),
        path.join(pluginDir, 'src', 'target', target.triple, 'debug', binaryName),
        path.join(pluginDir, 'src', 'target', 'release', binaryName),
        path.join(pluginDir, 'src', 'target', 'debug', binaryName)
    ];
}

async function findExecutable() {
    const target = getPlatformTarget();
    if (!target) {
        throw new Error(`DailyNoteSearcher does not support platform ${process.platform}/${process.arch}`);
    }

    const candidates = getExecutableCandidates();
    for (const candidate of candidates) {
        try {
            await fs.access(candidate, process.platform === 'win32' ? undefined : 1);
            return candidate;
        } catch (_) {
            // Try the next platform-compatible artifact.
        }
    }
    throw new Error(
        `DailyNoteSearcher executable for ${process.platform}/${process.arch} (${target.triple}) was not found or is not executable. ` +
        `Build it with Cargo or provide one of: ${candidates.join(', ')}`
    );
}

function postJson(payload, timeoutMs = serviceConfig.timeout, requestPath = '/search') {
    const body = JSON.stringify(payload || {});
    const requestOptions = {
        hostname: serviceConfig.host,
        port: serviceConfig.port,
        path: requestPath,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(requestOptions, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
                if (data.length > 128 * 1024 * 1024) {
                    req.destroy(new Error('DailyNoteSearcher HTTP response exceeded 128MB'));
                }
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data || '{}');
                    resolve(parsed);
                } catch (error) {
                    reject(new Error(`DailyNoteSearcher returned invalid JSON: ${error.message}; body=${data.slice(0, 300)}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`DailyNoteSearcher HTTP request timed out after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForProcessExit(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener('exit', onExit);
            resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('exit', onExit);
    });
}

function forceKillProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        killer.on('error', error => {
            console.warn(`[DailyNoteSearcher Service] taskkill failed: ${error.message}`);
            try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        });
        return;
    }

    try {
        child.kill('SIGKILL');
    } catch (_) {
        // The process exited between the state check and kill.
    }
}

async function waitForServiceReady(child, instanceId, deadlineMs = 8000) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < deadlineMs) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`DailyNoteSearcher process ${child.pid} exited before becoming ready`);
        }

        try {
            const result = await postJson({}, 1000, '/health');
            if (
                result?.status === 'success' &&
                result.instance_id === instanceId &&
                Number(result.pid) === child.pid
            ) {
                return;
            }
            if (result?.status === 'success') {
                lastError = new Error(
                    `port ${serviceConfig.port} belongs to another DailyNoteSearcher instance ` +
                    `(pid=${result.pid || 'unknown'}, instance=${result.instance_id || 'unknown'})`
                );
            }
        } catch (error) {
            lastError = error;
        }
        await delay(150);
    }

    throw new Error(`DailyNoteSearcher HTTP service did not become ready: ${lastError?.message || 'timeout'}`);
}

async function ensureServiceStarted() {
    if (serviceShutdownPromise) {
        await serviceShutdownPromise;
    }
    if (serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null) {
        if (serviceReadyPromise) await serviceReadyPromise;
        return;
    }
    if (serviceReadyPromise) return serviceReadyPromise;

    const generation = ++serviceGeneration;
    serviceReadyPromise = (async () => {
        serviceConfig.executablePath = serviceConfig.executablePath || await findExecutable();
        const instanceId = crypto.randomBytes(16).toString('hex');
        const shutdownToken = crypto.randomBytes(32).toString('hex');
        const env = {
            ...process.env,
            DAILY_NOTE_SEARCHER_HOST: serviceConfig.host,
            DAILY_NOTE_SEARCHER_PORT: String(serviceConfig.port),
            DAILY_NOTE_SEARCHER_INSTANCE_ID: instanceId,
            DAILY_NOTE_SEARCHER_SHUTDOWN_TOKEN: shutdownToken
        };

        const child = spawn(serviceConfig.executablePath, ['--serve'], {
            cwd: path.resolve(__dirname, '..', '..'),
            env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        child.__dailyNoteSearcherInstanceId = instanceId;
        child.__dailyNoteSearcherShutdownToken = shutdownToken;
        serviceProcess = child;

        child.stdout.on('data', chunk => {
            if (serviceConfig.debug) {
                console.log(`[DailyNoteSearcher Service stdout] ${chunk.toString('utf8').trim()}`);
            }
        });
        child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) console.log(`[DailyNoteSearcher Service] ${text}`);
        });
        child.on('exit', (code, signal) => {
            const expected = generation !== serviceGeneration || serviceShutdownPromise !== null;
            const log = expected ? console.log : console.warn;
            log(`[DailyNoteSearcher Service] exited with code=${code}, signal=${signal}, pid=${child.pid}`);
            if (serviceProcess === child) serviceProcess = null;
        });
        child.on('error', error => {
            console.error('[DailyNoteSearcher Service] failed to start:', error.message);
            if (serviceProcess === child) serviceProcess = null;
        });

        try {
            await waitForServiceReady(child, instanceId);
        } catch (error) {
            forceKillProcess(child);
            await waitForProcessExit(child, 2000);
            if (serviceProcess === child) serviceProcess = null;
            throw error;
        }
    })();

    try {
        await serviceReadyPromise;
    } finally {
        if (generation === serviceGeneration) serviceReadyPromise = null;
    }
}

async function initialize(config = {}) {
    serviceConfig.host = String(config.DAILY_NOTE_SEARCHER_HOST || process.env.DAILY_NOTE_SEARCHER_HOST || '127.0.0.1');
    serviceConfig.port = parseInt(config.DAILY_NOTE_SEARCHER_PORT || process.env.DAILY_NOTE_SEARCHER_PORT || '38765', 10) || 38765;
    serviceConfig.timeout = parseInt(config.DAILY_NOTE_SEARCHER_TIMEOUT || process.env.DAILY_NOTE_SEARCHER_TIMEOUT || '60000', 10) || 60000;
    serviceConfig.shutdownTimeout = parseInt(
        config.DAILY_NOTE_SEARCHER_SHUTDOWN_TIMEOUT ||
        process.env.DAILY_NOTE_SEARCHER_SHUTDOWN_TIMEOUT ||
        '5000',
        10
    ) || 5000;
    serviceConfig.debug = String(config.DebugMode || process.env.DebugMode || 'false').toLowerCase() === 'true';

    await ensureServiceStarted();
    console.log(`[DailyNoteSearcher Service] Initialized on http://${serviceConfig.host}:${serviceConfig.port}`);
}

async function processToolCall(args) {
    await ensureServiceStarted();
    const result = await postJson(args || {});
    return result;
}

async function shutdown() {
    if (serviceShutdownPromise) return serviceShutdownPromise;

    const child = serviceProcess;
    ++serviceGeneration;
    serviceReadyPromise = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        if (serviceProcess === child) serviceProcess = null;
        return;
    }

    serviceShutdownPromise = (async () => {
        try {
            try {
                const response = await postJson({
                    token: child.__dailyNoteSearcherShutdownToken,
                    instance_id: child.__dailyNoteSearcherInstanceId
                }, Math.min(serviceConfig.shutdownTimeout, 2000), '/shutdown');
                if (response?.status !== 'success') {
                    throw new Error(response?.error || 'shutdown endpoint rejected the request');
                }
            } catch (error) {
                console.warn(`[DailyNoteSearcher Service] Graceful shutdown request failed: ${error.message}`);
                try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
            }

            if (!await waitForProcessExit(child, serviceConfig.shutdownTimeout)) {
                console.warn(`[DailyNoteSearcher Service] PID ${child.pid} did not exit gracefully; forcing process-tree termination.`);
                forceKillProcess(child);
                await waitForProcessExit(child, 2000);
            }
        } finally {
            try { child.stdin?.destroy(); } catch (_) { /* already closed */ }
            if (serviceProcess === child) serviceProcess = null;
            console.log(`[DailyNoteSearcher Service] Shutdown complete for pid=${child.pid}.`);
        }
    })();

    try {
        await serviceShutdownPromise;
    } finally {
        serviceShutdownPromise = null;
    }
}

function getServiceEndpoint() {
    return `http://${serviceConfig.host}:${serviceConfig.port}/search`;
}

// stdin stays open for the lifetime of the Node parent. If Node is force-killed
// before PluginManager reaches shutdown(), Rust observes EOF and exits itself.

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    getServiceEndpoint,
    ensureServiceStarted,
    postJson
};
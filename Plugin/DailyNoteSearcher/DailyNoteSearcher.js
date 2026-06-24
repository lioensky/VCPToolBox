const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let serviceProcess = null;
let serviceReadyPromise = null;
let serviceConfig = {
    host: '127.0.0.1',
    port: 38765,
    timeout: 60000,
    executablePath: null
};

function createTextResult(text) {
    return {
        content: [{
            type: 'text',
            text: String(text ?? '')
        }]
    };
}

function getExecutableCandidates() {
    const pluginDir = __dirname;
    if (process.platform === 'win32') {
        return [
            path.join(pluginDir, 'DailyNoteSearcher.exe'),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher.exe'),
            path.join(pluginDir, 'src', 'target', 'debug', 'DailyNoteSearcher.exe')
        ];
    }

    return [
        path.join(pluginDir, 'DailyNoteSearcher'),
        path.join(pluginDir, 'DailyNoteSearcher-aarch64-unknown-linux-musl'),
        path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher'),
        path.join(pluginDir, 'src', 'target', 'debug', 'DailyNoteSearcher')
    ];
}

async function findExecutable() {
    const fs = require('fs').promises;
    for (const candidate of getExecutableCandidates()) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch (_) {
            // continue
        }
    }
    throw new Error(`DailyNoteSearcher executable not found. Tried: ${getExecutableCandidates().join(', ')}`);
}

function postJson(payload, timeoutMs = serviceConfig.timeout) {
    const body = JSON.stringify(payload || {});
    const requestOptions = {
        hostname: serviceConfig.host,
        port: serviceConfig.port,
        path: '/search',
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

async function waitForServiceReady(deadlineMs = 8000) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < deadlineMs) {
        try {
            const result = await postJson({
                query: '__daily_note_searcher_healthcheck__',
                root_path: '.',
                allowed_extensions: 'unlikely_ext',
                max_results: 1
            }, 1000);
            if (result && (result.status === 'success' || result.status === 'error')) {
                return true;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    throw new Error(`DailyNoteSearcher HTTP service did not become ready: ${lastError?.message || 'timeout'}`);
}

async function ensureServiceStarted() {
    if (serviceProcess && !serviceProcess.killed) {
        return;
    }
    if (serviceReadyPromise) {
        return serviceReadyPromise;
    }

    serviceReadyPromise = (async () => {
        serviceConfig.executablePath = serviceConfig.executablePath || await findExecutable();

        const env = {
            ...process.env,
            DAILY_NOTE_SEARCHER_HOST: serviceConfig.host,
            DAILY_NOTE_SEARCHER_PORT: String(serviceConfig.port)
        };

        serviceProcess = spawn(serviceConfig.executablePath, ['--serve'], {
            cwd: path.resolve(__dirname, '..', '..'),
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        serviceProcess.stdout.on('data', chunk => {
            if (serviceConfig.debug) {
                console.log(`[DailyNoteSearcher Service stdout] ${chunk.toString('utf8').trim()}`);
            }
        });

        serviceProcess.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) console.log(`[DailyNoteSearcher Service] ${text}`);
        });

        serviceProcess.on('exit', (code, signal) => {
            console.warn(`[DailyNoteSearcher Service] exited with code=${code}, signal=${signal}`);
            serviceProcess = null;
            serviceReadyPromise = null;
        });

        serviceProcess.on('error', error => {
            console.error('[DailyNoteSearcher Service] failed to start:', error.message);
            serviceProcess = null;
            serviceReadyPromise = null;
        });

        await waitForServiceReady();
    })();

    try {
        await serviceReadyPromise;
    } catch (error) {
        serviceReadyPromise = null;
        throw error;
    }
}

async function initialize(config = {}) {
    serviceConfig.host = String(config.DAILY_NOTE_SEARCHER_HOST || process.env.DAILY_NOTE_SEARCHER_HOST || '127.0.0.1');
    serviceConfig.port = parseInt(config.DAILY_NOTE_SEARCHER_PORT || process.env.DAILY_NOTE_SEARCHER_PORT || '38765', 10) || 38765;
    serviceConfig.timeout = parseInt(config.DAILY_NOTE_SEARCHER_TIMEOUT || process.env.DAILY_NOTE_SEARCHER_TIMEOUT || '60000', 10) || 60000;
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
    if (serviceProcess && !serviceProcess.killed) {
        serviceProcess.kill();
    }
    serviceProcess = null;
    serviceReadyPromise = null;
    console.log('[DailyNoteSearcher Service] Shutdown complete.');
}

function getServiceEndpoint() {
    return `http://${serviceConfig.host}:${serviceConfig.port}/search`;
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    getServiceEndpoint,
    ensureServiceStarted,
    postJson
};
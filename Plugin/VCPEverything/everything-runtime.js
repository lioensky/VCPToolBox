const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

const EVERYTHING_PORT = parseInt(process.env.EVERYTHING_PORT || '8025', 10);
const EVERYTHING_EXE_PATH = process.env.EVERYTHING_EXE_PATH || 'D:\\VCP\\Downloads\\everything.exe';
const EVERYTHING_STARTUP_WAIT_MS = parseInt(process.env.EVERYTHING_STARTUP_WAIT_MS || '3000', 10);
const EVERYTHING_INDEX_READY_WAIT_MS = parseInt(process.env.EVERYTHING_INDEX_READY_WAIT_MS || '3000', 10);
const EVERYTHING_EMPTY_RESULT_RETRY_WAIT_MS = parseInt(process.env.EVERYTHING_EMPTY_RESULT_RETRY_WAIT_MS || '3000', 10);
const EVERYTHING_EMPTY_RESULT_RETRY_COUNT = parseInt(process.env.EVERYTHING_EMPTY_RESULT_RETRY_COUNT || '10', 10);
const EVERYTHING_PREWARM_ON_SERVER_START = String(process.env.EVERYTHING_PREWARM_ON_SERVER_START || 'true').toLowerCase() === 'true';
const EVERYTHING_PREWARM_QUERY = process.env.EVERYTHING_PREWARM_QUERY || 'everything.exe';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

function debugLog(message, data = null) {
    if (!DEBUG_MODE) return;

    const timestamp = new Date().toISOString();
    console.error(`[DEBUG ${timestamp}] ${message}`);
    if (data) {
        console.error(JSON.stringify(data, null, 2));
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function startEverythingIfConfigured() {
    if (!EVERYTHING_EXE_PATH || !fs.existsSync(EVERYTHING_EXE_PATH)) {
        throw new Error(`Everything executable not found: ${EVERYTHING_EXE_PATH}`);
    }

    debugLog('Starting Everything executable', { path: EVERYTHING_EXE_PATH });
    const child = spawn(EVERYTHING_EXE_PATH, [], {
        cwd: path.dirname(EVERYTHING_EXE_PATH),
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
}

function searchWithEverythingHTTP(query, maxResults = 100) {
    return new Promise((resolve, reject) => {
        const encodedQuery = encodeURIComponent(query);
        const requestPath = `/?s=${encodedQuery}&json=1&path_column=1&n=${maxResults}`;

        const options = {
            hostname: '127.0.0.1',
            port: EVERYTHING_PORT,
            path: requestPath,
            method: 'GET'
        };

        debugLog('Making HTTP request to Everything server', options);

        const req = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Everything HTTP server responded with status code: ${res.statusCode}`));
            }

            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                rawData += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(rawData));
                } catch (error) {
                    reject(new Error(`Failed to parse JSON response from Everything: ${error.message}`));
                }
            });
        });

        req.on('error', (error) => {
            debugLog('HTTP request to Everything failed', { error: error.message });
            if (error.code === 'ECONNREFUSED') {
                const wrappedError = new Error(`Connection to Everything HTTP server refused on port ${EVERYTHING_PORT}. Please ensure Everything is running and the HTTP server is enabled in Tools -> Options.`);
                wrappedError.code = error.code;
                reject(wrappedError);
                return;
            }

            const wrappedError = new Error(`HTTP request error: ${error.message}`);
            wrappedError.code = error.code;
            reject(wrappedError);
        });

        req.end();
    });
}

async function waitForEverythingReady(query, maxResults = 1) {
    await sleep(EVERYTHING_INDEX_READY_WAIT_MS);

    let result = await searchWithEverythingHTTP(query, maxResults);
    for (let attempt = 0; result && Number(result.totalResults) === 0 && attempt < EVERYTHING_EMPTY_RESULT_RETRY_COUNT; attempt += 1) {
        await sleep(EVERYTHING_EMPTY_RESULT_RETRY_WAIT_MS);
        result = await searchWithEverythingHTTP(query, maxResults);
    }

    return result;
}

async function prewarmEverythingForServerStart() {
    if (!EVERYTHING_PREWARM_ON_SERVER_START) {
        return { skipped: true, reason: 'disabled_by_env' };
    }

    try {
        const warmResult = await searchWithEverythingHTTP(EVERYTHING_PREWARM_QUERY, 1);
        if (Number(warmResult?.totalResults || 0) === 0) {
            const readyResult = await waitForEverythingReady(EVERYTHING_PREWARM_QUERY, 1);
            return {
                skipped: false,
                started: false,
                ready: Number(readyResult?.totalResults || 0) > 0,
                totalResults: Number(readyResult?.totalResults || 0)
            };
        }

        return {
            skipped: false,
            started: false,
            ready: Number(warmResult?.totalResults || 0) > 0,
            totalResults: Number(warmResult?.totalResults || 0)
        };
    } catch (error) {
        if (!error || error.code !== 'ECONNREFUSED') {
            throw error;
        }
    }

    startEverythingIfConfigured();
    await sleep(EVERYTHING_STARTUP_WAIT_MS);
    const result = await waitForEverythingReady(EVERYTHING_PREWARM_QUERY, 1);

    return {
        skipped: false,
        started: true,
        ready: Number(result?.totalResults || 0) > 0,
        totalResults: Number(result?.totalResults || 0)
    };
}

module.exports = {
    sleep,
    startEverythingIfConfigured,
    searchWithEverythingHTTP,
    waitForEverythingReady,
    prewarmEverythingForServerStart,
    EVERYTHING_STARTUP_WAIT_MS
};

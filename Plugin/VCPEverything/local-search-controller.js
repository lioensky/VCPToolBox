const path = require('path');
const {
    sleep,
    startEverythingIfConfigured,
    searchWithEverythingHTTP,
    waitForEverythingReady,
    EVERYTHING_STARTUP_WAIT_MS
} = require('./everything-runtime');

async function searchWithEverythingAutoStart(query, maxResults = 100) {
    try {
        return await searchWithEverythingHTTP(query, maxResults);
    } catch (error) {
        if (!error || error.code !== 'ECONNREFUSED') {
            throw error;
        }

        startEverythingIfConfigured();
        await sleep(EVERYTHING_STARTUP_WAIT_MS);
        return await waitForEverythingReady(query, maxResults);
    }
}

async function processRequest(request) {
    const { query, maxResults } = request;

    if (!query) {
        return {
            status: 'error',
            error: 'Missing required parameter: query'
        };
    }

    try {
        const everythingResponse = await searchWithEverythingAutoStart(query, maxResults);
        const filePaths = everythingResponse.results.map((item) => path.join(item.path, item.name));

        return {
            status: 'success',
            result: {
                searchQuery: query,
                resultCount: everythingResponse.totalResults,
                results: filePaths
            }
        };
    } catch (error) {
        return {
            status: 'error',
            error: error.message
        };
    }
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', async () => {
    if (!inputBuffer.trim()) {
        console.log(JSON.stringify({ status: 'error', error: 'No input received.' }));
        return;
    }

    try {
        const request = JSON.parse(inputBuffer);
        const response = await processRequest(request);
        console.log(JSON.stringify(response));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: `Invalid JSON input: ${error.message}` }));
    }
});

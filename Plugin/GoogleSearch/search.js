const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const axios = require('axios');

// --- Configuration from .env file ---
const API_KEY = process.env.GOOGLE_SEARCH_API;
const CX = process.env.GOOGLE_CX;
const PROXY_PORT = process.env.GOOGLE_PROXY_PORT;

const API_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

async function googleApiSearch(query) {
    if (!API_KEY || !CX) {
        throw new Error('Google API Key (GOOGLE_SEARCH_API) or Custom Search Engine ID (GOOGLE_CX) is not configured in config.env.');
    }

    const params = {
        key: API_KEY,
        cx: CX,
        q: query,
        num: 10 // Request top 10 results
    };

    const options = {
        params: params
    };

    if (PROXY_PORT) {
        options.proxy = {
            host: '127.0.0.1',
            port: PROXY_PORT,
            protocol: 'http'
        };
    }

    try {
        const response = await axios.get(API_ENDPOINT, options);
        
        if (response.data && response.data.items) {
            const results = response.data.items.map(item => ({
                title: item.title,
                url: item.link,
                snippet: item.snippet
            }));
            return { status: 'success', result: results };
        } else {
            return { status: 'success', result: [] }; // No results found
        }
    } catch (error) {
        let errorMessage = `Google Search API request failed.`;
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            errorMessage += ` Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            // The request was made but no response was received
            errorMessage += ` No response received. Check your network or proxy settings.`;
        } else {
            // Something happened in setting up the request that triggered an Error
            errorMessage += ` Error: ${error.message}`;
        }
        throw new Error(errorMessage);
    }
}

async function main() {
    try {
        const input = await readInput();
        const request = JSON.parse(input);
        const query = request.query;

        if (!query) {
            throw new Error('Query parameter is missing.');
        }

        const searchResult = await googleApiSearch(query);
        console.log(JSON.stringify(searchResult, null, 2));

    } catch (e) {
        console.log(JSON.stringify({ status: 'error', error: e.message }, null, 2));
        process.exit(1);
    }
}

function readInput() {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk) => { data += chunk; });
        stdin.on('end', () => { resolve(data); });
        if (stdin.isTTY) { resolve('{}'); }
    });
}

main();
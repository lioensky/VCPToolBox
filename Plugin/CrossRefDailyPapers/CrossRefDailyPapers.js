const fs = require('fs');
const path = require('path');

const cacheFilePath = path.join(__dirname, 'crossref_papers.json');

// Configuration loading function
function getConfigFromEnv() {
    const config = {};
    config.CROSSREF_QUERY_BIBLIOGRAPHIC = process.env.CROSSREF_QUERY_BIBLIOGRAPHIC || '"Long-read Sequencing" OR metagenome OR "microbial genomics" OR "pathogen detection"';
    config.CROSSREF_ROWS = parseInt(process.env.CROSSREF_ROWS, 10) || 300;
    config.CROSSREF_DAYS_RANGE = parseInt(process.env.CROSSREF_DAYS_RANGE, 10) || 1;
    if (config.CROSSREF_DAYS_RANGE < 1) config.CROSSREF_DAYS_RANGE = 1; // Ensure at least 1 day

    const debugModeEnv = process.env.CROSSREF_DEBUG_MODE;
    config.CROSSREF_DEBUG_MODE = (debugModeEnv && debugModeEnv.toLowerCase() === 'true') || false;
    return config;
}

// Utility function to clean abstract text
function cleanAbstract(abstract) {
    if (typeof abstract !== 'string') return 'N/A';
    return abstract.replace(/<\/?[^>]+(>|$)/g, "").trim();
}

// Function to parse API response items
function parsePapers(items, debugMode) {
    if (!Array.isArray(items)) {
        if (debugMode) {
            console.error('[CrossRefDailyPapers] Expected an array of items for parsing, but received:', typeof items);
        }
        return [];
    }
    return items.map(item => {
        const authors = item.author && Array.isArray(item.author) ?
            item.author.map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(name => name).join('; ')
            : 'N/A';

        const issuedDate = item.issued && item.issued['date-parts'] && Array.isArray(item.issued['date-parts']) && item.issued['date-parts'][0] && Array.isArray(item.issued['date-parts'][0]) ?
            item.issued['date-parts'][0].join('-')
            : 'N/A';
        
        const title = item.title && Array.isArray(item.title) && item.title.length > 0 ? item.title.join(', ') : (item.title || 'N/A');

        return {
            doi: item.DOI || 'N/A',
            title: title,
            authors: authors,
            issuedDate: issuedDate,
            abstract: item.abstract ? cleanAbstract(item.abstract) : 'N/A',
            publisher: item.publisher || 'N/A',
            type: item.type || 'N/A',
            journal: item['container-title'] && Array.isArray(item['container-title']) && item['container-title'].length > 0 ? item['container-title'].join(', ') : (item['container-title'] || 'N/A')
        };
    });
}

// Core logic to fetch and cache papers
async function fetchAndCachePapers(config) {
    const fetch = (await import('node-fetch')).default; // Dynamically import node-fetch

    if (config.CROSSREF_DEBUG_MODE) {
        console.error(`[CrossRefDailyPapers] Starting to fetch papers. Debug ON. Config: ${JSON.stringify(config)}`);
    }

    const today = new Date();
    const untilDateObj = new Date(today);
    const fromDateObj = new Date(today);
    fromDateObj.setDate(today.getDate() - (config.CROSSREF_DAYS_RANGE - 1));

    const fromDate = fromDateObj.toISOString().split('T')[0];
    const untilDate = untilDateObj.toISOString().split('T')[0];

    const params = new URLSearchParams({
        'filter': `from-issued-date:${fromDate},until-issued-date:${untilDate}`,
        'query.bibliographic': config.CROSSREF_QUERY_BIBLIOGRAPHIC,
        'sort': 'issued',
        'order': 'desc',
        'rows': config.CROSSREF_ROWS.toString(),
        'select': 'DOI,title,author,issued,abstract,publisher,type,container-title'
    });

    const url = `https://api.crossref.org/works?${params.toString()}`;
    if (config.CROSSREF_DEBUG_MODE) {
        console.error(`[CrossRefDailyPapers] Fetching from URL: ${url}`);
    }

    let response;
    try {
        response = await fetch(url, { headers: { 'User-Agent': 'VCPToolBox/1.0 (https://github.com/lioensky/VCPToolBox; mailto: your.email@example.com)' } });
    } catch (fetchError) {
        console.error(`[CrossRefDailyPapers] Network error during fetch: ${fetchError.message}`);
        throw new Error(`Network error: ${fetchError.message}`);
    }
    
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[CrossRefDailyPapers] API request failed with status ${response.status}. Body: ${errorBody.substring(0, 500)}`);
        throw new Error(`API request failed: ${response.status}`);
    }

    let data;
    try {
        data = await response.json();
    } catch (jsonError) {
        console.error(`[CrossRefDailyPapers] Failed to parse JSON response: ${jsonError.message}`);
        throw new Error(`Failed to parse JSON response: ${jsonError.message}`);
    }
    
    if (!data.message || !Array.isArray(data.message.items)) {
        console.error('[CrossRefDailyPapers] Unexpected API response structure. Expected data.message.items to be an array.');
        if (config.CROSSREF_DEBUG_MODE) {
            console.error('[CrossRefDailyPapers] API Response:', JSON.stringify(data, null, 2));
        }
        try {
            // Attempt to write empty array to cache, but still throw error to trigger cache fallback for stdout
            fs.writeFileSync(cacheFilePath, JSON.stringify([], null, 2), 'utf8');
            if (config.CROSSREF_DEBUG_MODE) {
                console.error('[CrossRefDailyPapers] Wrote empty array to cache due to unexpected API response structure.');
            }
        } catch (writeError) {
            console.error(`[CrossRefDailyPapers] Failed to write empty cache file: ${writeError.message}`);
        }
        throw new Error('Unexpected API response structure from CrossRef');
    }

    if (config.CROSSREF_DEBUG_MODE) {
        console.error(`[CrossRefDailyPapers] Successfully fetched ${data.message.items.length} raw items.`);
    }

    const parsedPapers = parsePapers(data.message.items, config.CROSSREF_DEBUG_MODE);
    const papersJsonString = JSON.stringify(parsedPapers, null, 2);
    
    try {
        fs.writeFileSync(cacheFilePath, papersJsonString, 'utf8');
    } catch (writeError) {
        console.error(`[CrossRefDailyPapers] Failed to write cache file '${cacheFilePath}': ${writeError.message}`);
        // If writing cache fails, we should still try to return the data if fetching was successful
        // but also make sure the error is known. For stdout, this data is primary.
        // For placeholder system, the file is primary. This is a tough spot.
        // Let's throw, so it attempts to use old cache for stdout.
        throw new Error(`Failed to write cache file: ${writeError.message}`);
    }

    if (config.CROSSREF_DEBUG_MODE) {
        console.error(`[CrossRefDailyPapers] Papers data cached to ${cacheFilePath}. Parsed count: ${parsedPapers.length}`);
    }
    return papersJsonString; // Return the JSON string of parsed papers
}

// Main execution function
async function main() {
    const config = getConfigFromEnv();

    try {
        const papersDataString = await fetchAndCachePapers(config);
        process.stdout.write(papersDataString);
        if (config.CROSSREF_DEBUG_MODE) {
            console.error("[CrossRefDailyPapers] Successfully fetched and wrote data to stdout and cache.");
        }
    } catch (error) {
        if (config.CROSSREF_DEBUG_MODE) {
            console.error("[CrossRefDailyPapers] Primary execution failed:", error.message);
        } else {
            // Avoid duplicate console.error if it's already logged in fetchAndCachePapers
            if (!error.message.startsWith("API request failed") && !error.message.startsWith("Network error") && !error.message.startsWith("Failed to parse JSON response")) {
                 console.error(`[CrossRefDailyPapers] Error during execution: ${error.message}`);
            }
        }
        
        // Try to serve from cache on error
        try {
            const cachedData = fs.readFileSync(cacheFilePath, 'utf8');
            process.stdout.write(cachedData);
            if (config.CROSSREF_DEBUG_MODE) {
                console.error("[CrossRefDailyPapers] Served from cache due to error.");
            }
        } catch (cacheError) {
            if (config.CROSSREF_DEBUG_MODE) {
                console.error("[CrossRefDailyPapers] Failed to serve from cache:", cacheError.message);
            }
            const errorMessage = `Error fetching CrossRef papers: ${error.message}. Cache also unavailable: ${cacheError.message}.`;
            process.stdout.write(errorMessage); // Output plain text error message
            console.error(`[CrossRefDailyPapers] ${errorMessage}`); // Also log to stderr
            process.exitCode = 1; 
        }
    }
}

main(); 
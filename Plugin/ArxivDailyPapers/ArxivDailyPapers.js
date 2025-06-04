const fs = require('fs');
const path = require('path');

const cacheFilePath = path.join(__dirname, 'arxiv_papers.json');
const LOG_PREFIX = '[ArxivDailyPapers]';

// Helper to pad numbers with leading zero if needed
function padZero(num) {
    return num < 10 ? '0' + num : num.toString();
}

// Helper to format Date object to YYYYMMDDHHMMSS for arXiv query
function dateToArxivFormat(date, endOfDay = false) {
    const year = date.getUTCFullYear();
    const month = padZero(date.getUTCMonth() + 1); // Months are 0-indexed
    const day = padZero(date.getUTCDate());
    const hours = endOfDay ? '23' : padZero(date.getUTCHours());
    const minutes = endOfDay ? '59' : padZero(date.getUTCMinutes());
    const seconds = endOfDay ? '59' : padZero(date.getUTCSeconds());
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// Configuration loading function
function getConfigFromEnv() {
    const config = {};
    config.ARXIV_SEARCH_TERMS = process.env.ARXIV_SEARCH_TERMS || 'all:("Large Language Models" OR "Retrieval Augmented Generation")';
    config.ARXIV_MAX_RESULTS = parseInt(process.env.ARXIV_MAX_RESULTS, 10) || 100;
    config.ARXIV_DAYS_RANGE = parseInt(process.env.ARXIV_DAYS_RANGE, 10) || 1;
    if (config.ARXIV_DAYS_RANGE < 1) config.ARXIV_DAYS_RANGE = 1; // Ensure at least 1 day

    const debugModeEnv = process.env.ARXIV_DEBUG_MODE;
    config.ARXIV_DEBUG_MODE = (debugModeEnv && debugModeEnv.toLowerCase() === 'true') || false;
    return config;
}

// Utility function to clean abstract text
function cleanAbstract(abstract) {
    if (typeof abstract !== 'string') return 'N/A';
    // Replace newlines with spaces, multiple spaces with a single space, and trim.
    return abstract.replace(/\n/g, ' ').replace(/\s\s+/g, ' ').trim();
}

// Function to extract content from a simple XML tag using regex
function extractSimpleTagContent(xmlBlock, tagName) {
    // RegExp: <tagName ...>content</tagName>
    // For new RegExp("string"), backslashes in string need to be doubled for regex specials
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = xmlBlock.match(regex);
    return match && match[1] ? match[1].trim() : 'N/A';
}

// Function to extract authors using regex
function extractAuthors(entryBlock) {
    const authors = [];
    // RegExp literal: /.../
    const authorRegex = /<author[^>]*>\s*<name[^>]*>([\s\S]*?)<\/name>\s*<\/author>/gi;
    let match;
    while ((match = authorRegex.exec(entryBlock)) !== null) {
        authors.push(match[1].trim());
    }
    return authors.length > 0 ? authors.join('; ') : 'N/A';
}

// Function to extract link (prefer PDF link) using regex
function extractLink(entryBlock) {
    // Try to find PDF link first (RegExp literal)
    const pdfLinkRegex = /<link[^>]*href="([^"]*)"[^>]*rel="related"[^>]*type="application\/pdf"[^>]*\/>/i;
    let match = entryBlock.match(pdfLinkRegex);
    if (match && match[1]) return match[1].trim();

    // Fallback to abstract/HTML page link (RegExp literal)
    const absLinkRegex = /<link[^>]*href="([^"]*)"[^>]*rel="alternate"[^>]*type="text\/html"[^>]*\/>/i;
    match = entryBlock.match(absLinkRegex);
    if (match && match[1]) return match[1].trim();
    
    // Fallback to id if no other link found (though id is not a direct link)
    return extractSimpleTagContent(entryBlock, 'id');
}

// Function to parse API response items (entries from arXiv XML string) using regex
function parseArxivPapersFromString(xmlString, debugMode) {
    const papers = [];
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi; // RegExp literal
    let entryMatch;

    if (debugMode) {
        console.error(`${LOG_PREFIX} Attempting to parse XML string with regex. Length: ${xmlString.length}`);
    }

    while ((entryMatch = entryRegex.exec(xmlString)) !== null) {
        const entryBlock = entryMatch[1]; // The content of one <entry>
        
        const id = extractSimpleTagContent(entryBlock, 'id').split('/').pop() || 'N/A';
        const titleText = extractSimpleTagContent(entryBlock, 'title');
        const title = cleanAbstract(titleText); 

        const authors = extractAuthors(entryBlock);
        const published = extractSimpleTagContent(entryBlock, 'published').split('T')[0] || 'N/A';
        
        const summaryText = extractSimpleTagContent(entryBlock, 'summary');
        const summary = cleanAbstract(summaryText); 

        const primaryCategoryMatch = entryBlock.match(/<arxiv:primary_category[^>]*term="([^"]*)"[^>]*\/>/i); // RegExp literal
        const journal = primaryCategoryMatch && primaryCategoryMatch[1] ? primaryCategoryMatch[1].trim() : 'N/A';
        
        const link = extractLink(entryBlock);

        papers.push({
            id: id,
            title: title,
            authors: authors,
            issuedDate: published,
            abstract: summary,
            publisher: 'arXiv',
            type: 'preprint',
            journal: journal, 
            link: link
        });
    }
    if (debugMode) {
        console.error(`${LOG_PREFIX} Regex parsing found ${papers.length} entries.`);
    }
    if (papers.length === 0 && xmlString.toLowerCase().includes('<entry>')) {
        if (debugMode) console.error(`${LOG_PREFIX} Regex parsing found 0 papers, but <entry> tags were present. Check regex patterns or XML structure if this is unexpected.`);
    }
    return papers;
}

// Core logic to fetch and cache papers
async function fetchAndCacheArxivPapers(config) {
    const fetch = (await import('node-fetch')).default; 

    if (config.ARXIV_DEBUG_MODE) {
        console.error(`${LOG_PREFIX} Starting to fetch papers. Debug ON. Config: ${JSON.stringify(config)}`);
    }

    const today = new Date(); 
    const toDateObj = new Date(today);
    const fromDateObj = new Date(today);
    fromDateObj.setUTCDate(today.getUTCDate() - (config.ARXIV_DAYS_RANGE - 1));

    const fromDateStr = dateToArxivFormat(fromDateObj, false); 
    const toDateStr = dateToArxivFormat(toDateObj, true);   

    const searchQuery = `${config.ARXIV_SEARCH_TERMS} AND submittedDate:[${fromDateStr} TO ${toDateStr}]`;

    const params = new URLSearchParams({
        'search_query': searchQuery,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending',
        'max_results': config.ARXIV_MAX_RESULTS.toString()
    });

    const url = `http://export.arxiv.org/api/query?${params.toString()}`;
    if (config.ARXIV_DEBUG_MODE) {
        console.error(`${LOG_PREFIX} Fetching from URL: ${url}`);
    }

    let response;
    try {
        response = await fetch(url, { headers: { 'User-Agent': 'VCPToolBox/1.0 (Plugin Contact: User)' } });
    } catch (fetchError) {
        console.error(`${LOG_PREFIX} Network error during fetch: ${fetchError.message}`);
        throw new Error(`Network error: ${fetchError.message}`);
    }
    
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`${LOG_PREFIX} API request failed with status ${response.status}. URL: ${url}. Body (first 1000 chars): ${errorBody.substring(0, 1000)}`);
        throw new Error(`API request failed: ${response.status}`);
    }

    let xmlText;
    try {
        xmlText = await response.text();
    } catch (textError) {
        console.error(`${LOG_PREFIX} Failed to get XML text response: ${textError.message}`);
        throw new Error(`Failed to get XML text response: ${textError.message}`);
    }

    let parsedPapers;
    try {
        parsedPapers = parseArxivPapersFromString(xmlText, config.ARXIV_DEBUG_MODE);
    } catch (parseError) {
        console.error(`${LOG_PREFIX} Failed to parse XML string with regex: ${parseError.message}`);
        if (config.ARXIV_DEBUG_MODE) {
            console.error(`${LOG_PREFIX} XML content that failed to parse (first 2000 chars): ${xmlText.substring(0,2000)}`);
        }
        throw new Error(`Failed to parse XML string with regex: ${parseError.message}`);
    }
    
    if (config.ARXIV_DEBUG_MODE) {
        console.error(`${LOG_PREFIX} Successfully fetched and parsed ${parsedPapers.length} items using regex.`);
    }

    const papersJsonString = JSON.stringify(parsedPapers, null, 2);
    
    try {
        fs.writeFileSync(cacheFilePath, papersJsonString, 'utf8');
    } catch (writeError) {
        console.error(`${LOG_PREFIX} Failed to write cache file '${cacheFilePath}': ${writeError.message}`);
        throw new Error(`Failed to write cache file: ${writeError.message}`);
    }

    if (config.ARXIV_DEBUG_MODE) {
        console.error(`${LOG_PREFIX} Papers data cached to ${cacheFilePath}. Parsed count: ${parsedPapers.length}`);
    }
    return papersJsonString;
}

// Main execution function
async function main() {
    const config = getConfigFromEnv();

    try {
        const papersDataString = await fetchAndCacheArxivPapers(config);
        process.stdout.write(papersDataString);
        if (config.ARXIV_DEBUG_MODE) {
            console.error(`${LOG_PREFIX} Successfully fetched and wrote data to stdout and cache.`);
        }
    } catch (error) {
        if (config.ARXIV_DEBUG_MODE) {
            console.error(`${LOG_PREFIX} Primary execution failed:`, error);
        } else {
            const errorMsg = error.message || 'Unknown error during primary execution';
             if (!errorMsg.includes("API request failed") && 
                !errorMsg.includes("Network error") &&
                !errorMsg.includes("Failed to parse XML") && 
                !errorMsg.includes("Failed to get XML text response") &&
                !errorMsg.includes("Failed to write cache file")) {
                 console.error(`${LOG_PREFIX} Error during execution: ${errorMsg}`);
            }
        }
        
        try {
            const cachedData = fs.readFileSync(cacheFilePath, 'utf8');
            process.stdout.write(cachedData);
            if (config.ARXIV_DEBUG_MODE) {
                console.error(`${LOG_PREFIX} Served from cache due to error.`);
            }
        } catch (cacheError) {
            if (config.ARXIV_DEBUG_MODE) {
                console.error(`${LOG_PREFIX} Failed to serve from cache:`, cacheError);
            }
            const primaryErrorMessage = error.message || 'Unknown primary error';
            const cacheErrorMessage = cacheError.message || 'Unknown cache error';
            const finalErrorMessage = `Error fetching Arxiv papers: ${primaryErrorMessage}. Cache also unavailable: ${cacheErrorMessage}.`;
            
            process.stdout.write(finalErrorMessage); 
            console.error(`${LOG_PREFIX} ${finalErrorMessage}`); 
            process.exitCode = 1; 
        }
    }
}

main(); 
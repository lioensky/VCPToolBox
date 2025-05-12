// Plugin/WeatherReporter/weather-reporter.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

// Load main config.env from project root
dotenv.config({ path: path.resolve(__dirname, '../../config.env') });

const CACHE_FILE_PATH = path.join(__dirname, 'weather_cache.txt');

// Helper to replace limited variables in the weather prompt
function replaceWeatherPromptVariables(text, city, tavilyResult, webPagesContent) { // Added webPagesContent
    if (text == null) return '';
    let processedText = String(text);
    const now = new Date();
    const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Date\}\}/g, date);
    if (city) {
        processedText = processedText.replace(/\{\{VarCity\}\}/g, city);
    } else {
        processedText = processedText.replace(/\{\{VarCity\}\}/g, '[城市未配置]');
    }
    if (tavilyResult) {
        processedText = processedText.replace(/\{\{TavilySearchResult\}\}/g, tavilyResult);
    } else {
        processedText = processedText.replace(/\{\{TavilySearchResult\}\}/g, '[Tavily搜索结果为空]');
    }
    // Replace the new placeholder for web page content
    if (webPagesContent) {
        processedText = processedText.replace(/\{\{WebPagesContent\}\}/g, webPagesContent);
    } else {
        processedText = processedText.replace(/\{\{WebPagesContent\}\}/g, '[网页内容抓取失败或无内容]');
    }
    return processedText;
}

// Function to fetch raw weather data using Tavily API
async function fetchRawWeatherDataWithTavily(city, tavilyApiKey) {
    const { default: fetch } = await import('node-fetch');
    if (!city || !tavilyApiKey) {
        console.error('[WeatherReporter] Tavily API Key or City is missing for fetching raw weather data.');
        return { success: false, data: null, error: new Error('Tavily API Key or City is missing.') };
    }

    const tavilyApiUrl = 'https://api.tavily.com/search'; // Standard Tavily API endpoint
    // Get current date in MM月DD日 format (Shanghai time)
    const now = new Date();
    const month = now.toLocaleDateString('zh-CN', { month: 'numeric', timeZone: 'Asia/Shanghai' });
    const day = now.toLocaleDateString('zh-CN', { day: 'numeric', timeZone: 'Asia/Shanghai' });
    const currentDateFormatted = `${month}${day}`; // e.g., "5月13日"

    const query = `${currentDateFormatted}开始，${city}的一周天气预报`; // Construct the query with date

    try {
        console.log(`[WeatherReporter] Fetching raw weather data from Tavily for city: ${city} with query: "${query}"`);
        const response = await fetch(tavilyApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: tavilyApiKey,
                query: query,
                search_depth: "advanced", // Using advanced for potentially more details like alerts
                include_answer: false, // We want raw search results for the LLM
                max_results: 5 // Limit to 5 results as requested
            }),
            timeout: 15000, // 15s timeout for Tavily API call
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Tavily API call failed: ${response.status} ${errorText.substring(0, 200)}`);
        }

        const searchResult = await response.json();
        // Extract URLs and prepare the result string for the LLM
        let urls = [];
        let resultString = '[Tavily搜索结果为空或格式错误]';
        if (searchResult.results && Array.isArray(searchResult.results)) {
            urls = searchResult.results.map(r => r.url).filter(url => url); // Extract valid URLs
            // Keep the original stringified results for potential LLM context
            resultString = JSON.stringify(searchResult.results, null, 2);
        } else {
             // Fallback if results format is unexpected
            resultString = JSON.stringify(searchResult, null, 2);
        }

        console.log(`[WeatherReporter] Successfully fetched raw weather data from Tavily for ${city}. Found ${urls.length} URLs.`);
        // Return URLs along with the original data string
        return { success: true, data: resultString, urls: urls, error: null };

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching from Tavily API: ${error.message}`);
        // Ensure urls is always defined, even on error
        return { success: false, data: null, urls: [], error: error };
    }
}

// New function to fetch content from a single URL
async function fetchWebPageContent(url) {
    const { default: fetch } = await import('node-fetch');
    const MAX_CONTENT_LENGTH = 5000; // Limit content length per page to avoid excessive data
    const TIMEOUT = 10000; // 10 seconds timeout per page fetch

    try {
        console.log(`[WeatherReporter] Fetching content from URL: ${url}`);
        const response = await fetch(url, {
            headers: {
                // Mimic a browser User-Agent
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: TIMEOUT,
            // Follow redirects
            redirect: 'follow',
            // Ignore HTTPS errors (use with caution, might be needed for some sites)
            // agent: new (require('https')) .Agent({ rejectUnauthorized: false }) // Uncomment if needed, requires 'https'
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} for ${url}`);
        }

        // Check content type - we primarily want HTML/text
        const contentType = response.headers.get('content-type');
        if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
             console.warn(`[WeatherReporter] Skipping non-text content (${contentType}) from ${url}`);
             return { success: false, url: url, error: `Skipped non-text content (${contentType})` };
        }


        let content = await response.text();

        // Basic HTML tag stripping (very rudimentary, LLM might handle raw HTML better)
        // Consider using a library like cheerio for robust parsing if needed later
        content = content.replace(/<style[^>]*>.*?<\/style>/gs, ''); // Remove style blocks
        content = content.replace(/<script[^>]*>.*?<\/script>/gs, ''); // Remove script blocks
        content = content.replace(/<[^>]+>/g, ' '); // Remove remaining tags
        content = content.replace(/\s\s+/g, ' ').trim(); // Normalize whitespace


        if (content.length > MAX_CONTENT_LENGTH) {
            console.warn(`[WeatherReporter] Content from ${url} truncated to ${MAX_CONTENT_LENGTH} chars.`);
            content = content.substring(0, MAX_CONTENT_LENGTH) + '... [内容截断]';
        }

        console.log(`[WeatherReporter] Successfully fetched and processed content from ${url} (length: ${content.length})`);
        return { success: true, url: url, content: content };

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching content from ${url}: ${error.message}`);
        return { success: false, url: url, error: error.message };
    }
}


async function getCachedWeather() {
    try {
        const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
        // Basic validation: check if it's not an error message itself
        if (cachedData && !cachedData.startsWith("[Error") && !cachedData.startsWith("[天气API请求失败")) {
            return cachedData.trim();
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[WeatherReporter] Error reading cache file ${CACHE_FILE_PATH}:`, error.message);
        }
    }
    return null;
}

async function fetchAndCacheWeather() {
    const { default: fetch } = await import('node-fetch');
    let lastError = null;

    const apiUrl = process.env.API_URL;
    const apiKey = process.env.API_Key; // For LLM
    const weatherModel = process.env.WeatherModel;
    const weatherPromptTemplate = process.env.WeatherPrompt;
    const varCity = process.env.VarCity;
    const weatherModelMaxTokens = parseInt(process.env.WeatherModelMaxTokens, 10);
    const tavilyApiKey = process.env.TavilyKey;

    if (!apiUrl || !apiKey || !weatherModel || !weatherPromptTemplate || !varCity || !tavilyApiKey) {
        lastError = new Error('天气插件错误：获取天气所需的配置不完整 (API_URL, API_Key, WeatherModel, WeatherPrompt, VarCity, TavilyKey)。');
        console.error(`[WeatherReporter] ${lastError.message}`);
        return { success: false, data: null, error: lastError };
    }

    // 1. Fetch raw weather data using Tavily (includes URLs now)
    const tavilyResult = await fetchRawWeatherDataWithTavily(varCity, tavilyApiKey);
    let webPagesContent = ''; // Initialize web pages content string

    if (!tavilyResult.success) {
        lastError = tavilyResult.error || new Error('使用Tavily获取原始天气数据失败。');
        console.error(`[WeatherReporter] ${lastError.message}`);
        // Continue, but webPagesContent will be empty or indicate failure later
    } else if (tavilyResult.urls && tavilyResult.urls.length > 0) {
        // 2. Fetch content from the URLs returned by Tavily
        console.log(`[WeatherReporter] Fetching content for ${tavilyResult.urls.length} URLs...`);
        const fetchPromises = tavilyResult.urls.map(url => fetchWebPageContent(url));
        const pageResults = await Promise.all(fetchPromises);

        // Aggregate successful results
        let successfulPages = 0;
        webPagesContent = pageResults
            .map(result => {
                if (result.success && result.content) {
                    successfulPages++;
                    return `--- 网页来源: ${result.url} ---\n${result.content}\n--- 结束来源: ${result.url} ---`;
                } else {
                    return `--- 网页来源: ${result.url} (抓取失败: ${result.error || '未知错误'}) ---`;
                }
            })
            .join('\n\n');
        console.log(`[WeatherReporter] Successfully fetched content from ${successfulPages}/${tavilyResult.urls.length} URLs.`);
    } else {
        console.log("[WeatherReporter] Tavily search succeeded but returned no URLs to fetch.");
        webPagesContent = "[Tavily未返回可抓取的网页URL]";
    }

    // 3. Prepare prompt for LLM with Tavily's result AND fetched web content
    const tavilyDataForPrompt = tavilyResult.success && tavilyResult.data
        ? tavilyResult.data
        : `[Tavily搜索失败: ${tavilyResult.error ? tavilyResult.error.message.substring(0,100) : '未知错误'}]`;

    // Note: replaceWeatherPromptVariables now takes 4 arguments
    let promptForLLM = replaceWeatherPromptVariables(weatherPromptTemplate, varCity, tavilyDataForPrompt, webPagesContent);

    try {
        // 4. Call LLM to summarize the weather info
        const llmApiPayload = {
            model: weatherModel,
            messages: [{ role: 'user', content: promptForLLM }],
        };
        if (weatherModelMaxTokens && !isNaN(weatherModelMaxTokens) && weatherModelMaxTokens > 0) {
            llmApiPayload.max_tokens = weatherModelMaxTokens;
        }

        console.log(`[WeatherReporter] Calling LLM to summarize weather. Prompt (first 200 chars): ${promptForLLM.substring(0,200)}...`);

        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(llmApiPayload),
            timeout: 30000, // 30s timeout for LLM API call
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM API调用失败: ${response.status} ${errorText.substring(0,150)}`);
        }

        const llmData = await response.json();
        const weatherContent = llmData.choices?.[0]?.message?.content || '';
        const weatherInfoMatch = weatherContent.match(/\[WeatherInfo:(.*?)\]/s);
        const successMarker = "[天气信息总结完毕]";

        if (weatherInfoMatch && weatherInfoMatch[1] && weatherContent.includes(successMarker)) {
            const extractedInfo = weatherInfoMatch[1].trim();
            await fs.writeFile(CACHE_FILE_PATH, extractedInfo, 'utf-8');
            console.log(`[WeatherReporter] Successfully summarized, fetched and cached new weather info.`);
            return { success: true, data: extractedInfo, error: null };
        } else {
            const detail = tavilyResult.success ? "LLM未能有效总结Tavily数据" : "Tavily搜索失败且LLM未能处理";
            throw new Error(`未能从LLM响应中提取有效的天气信息。${detail}。LLM内容(前100): ${weatherContent.substring(0,100)}`);
        }

    } catch (error) {
        lastError = error;
        console.error(`[WeatherReporter] LLM API call or processing error: ${error.message}`);
        return { success: false, data: null, error: lastError };
    }
}

async function main() {
    const apiResult = await fetchAndCacheWeather();
    
    if (apiResult.success && apiResult.data) {
        process.stdout.write(apiResult.data);
        process.exit(0);
    } else {
        // API failed, try to use cache
        const cachedData = await getCachedWeather();
        if (cachedData) {
            console.warn("[WeatherReporter] API fetch failed, using stale cache.");
            process.stdout.write(cachedData);
            process.exit(0); // Exit 0 because we are providing data, albeit stale.
        } else {
            // API failed AND no cache available
            const errorMessage = `[天气API请求失败且无可用缓存: ${apiResult.error ? apiResult.error.message.substring(0,100) : '未知错误'}]`;
            console.error(`[WeatherReporter] ${errorMessage}`);
            process.stdout.write(errorMessage); // Output error to stdout so Plugin.js can use it as placeholder
            process.exit(1); // Exit 1 to indicate to Plugin.js that the update truly failed to produce a usable value.
        }
    }
}

if (require.main === module) {
    main();
}

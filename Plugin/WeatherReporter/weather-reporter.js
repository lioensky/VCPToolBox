// Plugin/WeatherReporter/weather-reporter.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

// Load main config.env from project root
dotenv.config({ path: path.resolve(__dirname, '../../config.env') });

const CACHE_FILE_PATH = path.join(__dirname, 'weather_cache.txt');

// Helper to replace limited variables in the weather prompt
function replaceWeatherPromptVariables(text, city, tavilyResult) {
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
    const query = `${city}一周天气预报`;

    try {
        console.log(`[WeatherReporter] Fetching raw weather data from Tavily for city: ${city}`);
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
                max_results: 10 // User requested to increase for more robust results
            }),
            timeout: 15000, // 15s timeout for Tavily API call
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Tavily API call failed: ${response.status} ${errorText.substring(0, 200)}`);
        }

        const searchResult = await response.json();
        // We need to pass a string representation of the results to the LLM.
        // Tavily's response structure might be an array of result objects.
        // Let's stringify the whole thing for now, or pick relevant parts.
        // For simplicity, we'll stringify the results array if it exists.
        const resultString = searchResult.results ? JSON.stringify(searchResult.results, null, 2) : JSON.stringify(searchResult, null, 2);

        console.log(`[WeatherReporter] Successfully fetched raw weather data from Tavily for ${city}.`);
        return { success: true, data: resultString, error: null };

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching from Tavily API: ${error.message}`);
        return { success: false, data: null, error: error };
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

    // 1. Fetch raw weather data using Tavily
    const tavilyResult = await fetchRawWeatherDataWithTavily(varCity, tavilyApiKey);

    if (!tavilyResult.success || !tavilyResult.data) {
        lastError = tavilyResult.error || new Error('使用Tavily获取原始天气数据失败。');
        console.error(`[WeatherReporter] ${lastError.message}`);
        // The main function will handle cache fallback.
    }
    
    // 2. Prepare prompt for LLM with Tavily's result (or error message)
    const tavilyDataForPrompt = tavilyResult.success && tavilyResult.data
        ? tavilyResult.data
        : `[Tavily搜索失败: ${tavilyResult.error ? tavilyResult.error.message.substring(0,100) : '未知错误'}]`;

    // Note: replaceWeatherPromptVariables now takes 3 arguments
    let promptForLLM = replaceWeatherPromptVariables(weatherPromptTemplate, varCity, tavilyDataForPrompt);

    try {
        // 3. Call LLM to summarize the weather info from Tavily's data
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
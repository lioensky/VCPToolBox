// Plugin/WeatherReporter/weather-reporter.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
// const fetch = require('node-fetch'); // Use require for node-fetch - Removed

// Load main config.env from project root
dotenv.config({ path: path.resolve(__dirname, '../../config.env') });

const CACHE_FILE_PATH = path.join(__dirname, 'weather_cache.txt');
const CITY_CACHE_FILE_PATH = path.join(__dirname, 'city_cache.txt');

// --- Start QWeather API Functions ---

// Function to read city cache
async function readCityCache() {
    try {
        const data = await fs.readFile(CITY_CACHE_FILE_PATH, 'utf-8');
        const cache = new Map();
        data.split('\n').forEach(line => {
            const [cityName, cityId] = line.split(':');
            if (cityName && cityId) {
                cache.set(cityName.trim(), cityId.trim());
            }
        });
        console.error(`[WeatherReporter] Successfully read city cache from ${CITY_CACHE_FILE_PATH}`);
        return cache;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[WeatherReporter] Error reading city cache file ${CITY_CACHE_FILE_PATH}:`, error.message);
        }
        return new Map(); // Return empty map if file doesn't exist or error occurs
    }
}

// Function to write city cache
async function writeCityCache(cityName, cityId) {
    try {
        // Append to the file, creating it if it doesn't exist
        await fs.appendFile(CITY_CACHE_FILE_PATH, `${cityName}:${cityId}\n`, 'utf-8');
        console.error(`[WeatherReporter] Successfully wrote city cache for ${cityName}:${cityId} to ${CITY_CACHE_FILE_PATH}`);
    } catch (error) {
        console.error(`[WeatherReporter] Error writing city cache file ${CITY_CACHE_FILE_PATH}:`, error.message);
    }
}

// Function to get City ID from city name
async function getCityId(cityName, weatherKey, weatherUrl) {
    const { default: fetch } = await import('node-fetch'); // Dynamic import
    if (!cityName || !weatherKey || !weatherUrl) {
        console.error('[WeatherReporter] City name, Weather Key or Weather URL is missing for getCityId.');
        return { success: false, data: null, error: new Error('Missing parameters for getCityId.') };
    }

    // Check cache first
    const cityCache = await readCityCache();
    if (cityCache.has(cityName)) {
        const cachedCityId = cityCache.get(cityName);
        console.error(`[WeatherReporter] Using cached city ID for ${cityName}: ${cachedCityId}`);
        return { success: true, data: cachedCityId, error: null };
    }

    const lookupUrl = `https://${weatherUrl}/geo/v2/city/lookup?location=${encodeURIComponent(cityName)}&key=${weatherKey}`;

    try {
        console.error(`[WeatherReporter] Fetching city ID for: ${cityName}`);
        const response = await fetch(lookupUrl, { timeout: 10000 }); // 10s timeout

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`QWeather City Lookup API failed: ${response.status} ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        if (data.code === '200' && data.location && data.location.length > 0) {
            const cityId = data.location[0].id;
            console.error(`[WeatherReporter] Successfully found city ID: ${cityId}`);
            // Write to cache
            await writeCityCache(cityName, cityId);
            return { success: true, data: cityId, error: null };
        } else {
             const errorMsg = data.code === '200' ? 'No location found' : `API returned code ${data.code}`;
             throw new Error(`Failed to get city ID for ${cityName}. ${errorMsg}`);
        }

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching city ID: ${error.message}`);
        return { success: false, data: null, error: error };
    }
}

// Function to get Current Weather from City ID
async function getCurrentWeather(cityId, weatherKey, weatherUrl) {
    const { default: fetch } = await import('node-fetch'); // Dynamic import
    if (!cityId || !weatherKey || !weatherUrl) {
        console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for getCurrentWeather.');
        return { success: false, data: null, error: new Error('Missing parameters for getCurrentWeather.') };
    }

    const weatherUrlEndpoint = `https://${weatherUrl}/v7/weather/now?location=${cityId}&key=${weatherKey}`;

    try {
        console.error(`[WeatherReporter] Fetching current weather for city ID: ${cityId}`);
        const response = await fetch(weatherUrlEndpoint, { timeout: 10000 }); // 10s timeout

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`QWeather Current Weather API failed: ${response.status} ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
         if (data.code === '200' && data.now) {
            console.error(`[WeatherReporter] Successfully fetched current weather for ${cityId}.`);
            return { success: true, data: data.now, error: null };
        } else {
             throw new Error(`Failed to get current weather for ${cityId}. API returned code ${data.code}`);
        }

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching current weather: ${error.message}`);
        return { success: false, data: null, error: error };
    }
}

// Function to get 7-day Forecast from City ID
async function get7DayForecast(cityId, weatherKey, weatherUrl) {
    const { default: fetch } = await import('node-fetch'); // Dynamic import
     if (!cityId || !weatherKey || !weatherUrl) {
        console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for get7DayForecast.');
        return { success: false, data: null, error: new Error('Missing parameters for get7DayForecast.') };
    }

    const forecastUrlEndpoint = `https://${weatherUrl}/v7/weather/7d?location=${cityId}&key=${weatherKey}`;

    try {
        console.error(`[WeatherReporter] Fetching 7-day forecast for city ID: ${cityId}`);
        const response = await fetch(forecastUrlEndpoint, { timeout: 10000 }); // 10s timeout

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`QWeather 7-day Forecast API failed: ${response.status} ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
         if (data.code === '200' && data.daily) {
            console.error(`[WeatherReporter] Successfully fetched 7-day forecast for ${cityId}.`);
            return { success: true, data: data.daily, error: null };
        } else {
             throw new Error(`Failed to get 7-day forecast for ${cityId}. API returned code ${data.code}`);
        }

    } catch (error) {
        console.error(`[WeatherReporter] Error fetching 7-day forecast: ${error.message}`);
        return { success: false, data: null, error: error };
    }
}

// Helper to format weather data into a readable string
function formatWeatherInfo(currentWeather, forecast) {
    if (!currentWeather && (!forecast || forecast.length === 0)) {
        return "[天气信息获取失败]";
    }

    let result = "【实时天气】\n";
    if (currentWeather) {
        result += `天气: ${currentWeather.text}\n`;
        result += `温度: ${currentWeather.temp}℃\n`;
        result += `体感温度: ${currentWeather.feelsLike}℃\n`;
        result += `湿度: ${currentWeather.humidity}%\n`;
        result += `风向: ${currentWeather.windDir}\n`;
        result += `风力: ${currentWeather.windScale}级\n`;
        result += `风速: ${currentWeather.windSpeed}公里/小时\n`;
        result += `气压: ${currentWeather.pressure}百帕\n`;
        result += `能见度: ${currentWeather.vis}公里\n`;
        result += `云量: ${currentWeather.cloud}%\n`;
        result += `露点温度: ${currentWeather.dew}℃\n`;
        result += `更新时间: ${new Date(currentWeather.obsTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
    } else {
        result += "实时天气信息获取失败。\n";
    }


    if (forecast && forecast.length > 0) {
        result += "\n【未来7日天气预报】\n";
        forecast.forEach(day => {
            result += `\n日期: ${day.fxDate}\n`;
            result += `白天: ${day.textDay} (图标: ${day.iconDay}), 最高温: ${day.tempMax}℃, 风向: ${day.windDirDay}, 风力: ${day.windScaleDay}级\n`;
            result += `夜间: ${day.textNight} (图标: ${day.iconNight}), 最低温: ${day.tempMin}℃, 风向: ${day.windDirNight}, 风力: ${day.windScaleNight}级\n`;
            result += `湿度: ${day.humidity}%\n`;
            result += `降水: ${day.precip}毫米\n`;
            result += `紫外线指数: ${day.uvIndex}\n`;
        });
    } else {
         result += "\n未来7日天气预报获取失败。\n";
    }


    return result.trim();
}

// --- End QWeather API Functions ---


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
    let lastError = null;

    const varCity = process.env.VarCity;
    const weatherKey = process.env.WeatherKey;
    const weatherUrl = process.env.WeatherUrl;


    if (!varCity || !weatherKey || !weatherUrl) {
        lastError = new Error('天气插件错误：获取天气所需的配置不完整 (VarCity, WeatherKey, WeatherUrl)。');
        console.error(`[WeatherReporter] ${lastError.message}`);
        return { success: false, data: null, error: lastError };
    }

    let cityId = null;
    let currentWeather = null;
    let forecast = null;

    // 1. Get City ID
    const cityResult = await getCityId(varCity, weatherKey, weatherUrl);
    if (cityResult.success) {
        cityId = cityResult.data;
    } else {
        lastError = cityResult.error;
        console.error(`[WeatherReporter] Failed to get city ID: ${lastError.message}`);
        // Continue attempting to get weather/forecast even if city ID failed,
        // though it's unlikely to succeed without it. Log the error and proceed.
    }

    // 2. Get Current Weather (if cityId is available)
    if (cityId) {
        const currentResult = await getCurrentWeather(cityId, weatherKey, weatherUrl);
        if (currentResult.success) {
            currentWeather = currentResult.data;
        } else {
            lastError = currentResult.error;
            console.error(`[WeatherReporter] Failed to get current weather: ${lastError.message}`);
        }
    }

    // 3. Get 7-day Forecast (if cityId is available)
    if (cityId) {
        const forecastResult = await get7DayForecast(cityId, weatherKey, weatherUrl);
        if (forecastResult.success) {
            forecast = forecastResult.data;
        } else {
            lastError = forecastResult.error;
            console.error(`[WeatherReporter] Failed to get 7-day forecast: ${lastError.message}`);
        }
    }

    // 4. Format and Cache the results
    if (currentWeather || (forecast && forecast.length > 0)) {
        const formattedWeather = formatWeatherInfo(currentWeather, forecast);
        try {
            await fs.writeFile(CACHE_FILE_PATH, formattedWeather, 'utf-8');
            console.error(`[WeatherReporter] Successfully fetched, formatted, and cached new weather info.`);
            return { success: true, data: formattedWeather, error: null };
        } catch (writeError) {
            lastError = writeError;
            console.error(`[WeatherReporter] Error writing to cache file: ${writeError.message}`);
            return { success: false, data: formattedWeather, error: lastError }; // Return data even if cache write fails
        }
    } else {
        // If both current and forecast failed
        lastError = lastError || new Error("未能获取实时天气和未来7日预报。");
        console.error(`[WeatherReporter] ${lastError.message}`);
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

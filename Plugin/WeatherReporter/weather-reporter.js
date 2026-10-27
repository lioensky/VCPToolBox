// Plugin/WeatherReporter/weather-reporter.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { getFreshWeather } = require('./weather-data');
const { fetchUapiWeather } = require('./uapi-weather');

// Load main config.env from project root
dotenv.config({ path: path.resolve(__dirname, '../../config.env') });

// Load plugin-specific config.env
dotenv.config({ path: path.join(__dirname, 'config.env') });

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';

const CACHE_FILE_PATH = path.join(__dirname, 'weather_cache.txt');
const JSON_CACHE_FILE_PATH = path.join(__dirname, 'weather_cache.json');
const CITY_CACHE_FILE_PATH = path.join(__dirname, 'city_cache.txt');

function safeErrorMessage(error) {
  let message = error?.message || String(error);
  if (process.env.WeatherKey) message = message.replaceAll(process.env.WeatherKey, '[redacted]');
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]').slice(0, 240);
}

// node-fetch v3 uses AbortSignal; its signal also covers response body consumption.
async function requestWeather(url, timeoutMs = 10000) {
  const { default: fetch } = await import('node-fetch');
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`天气请求失败：${error.name === 'AbortError' ? '请求超过 10 秒' : safeErrorMessage(error)}`);
  }
}

// --- Start QWeather API Functions ---

// Function to read city cache
async function readCityCache() {
  try {
    const data = await fs.readFile(CITY_CACHE_FILE_PATH, 'utf-8');
    const cache = new Map();
    data.split('\n').forEach(line => {
      if (!line) return;
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) return;

      const cityName = line.substring(0, separatorIndex).trim();
      const cityJson = line.substring(separatorIndex + 1).trim();

      if (cityName && cityJson) {
        try {
          cache.set(cityName, JSON.parse(cityJson));
        } catch (e) {
          console.error(`[WeatherReporter] Failed to parse city cache for ${cityName}:`, e.message);
        }
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
async function writeCityCache(cityName, cityInfo) {
  try {
    const cityJson = JSON.stringify(cityInfo);
    // Append to the file, creating it if it doesn't exist
    await fs.appendFile(CITY_CACHE_FILE_PATH, `${cityName}:${cityJson}\n`, 'utf-8');
    console.error(`[WeatherReporter] Successfully wrote city cache for ${cityName} to ${CITY_CACHE_FILE_PATH}`);
  } catch (error) {
    console.error(`[WeatherReporter] Error writing city cache file ${CITY_CACHE_FILE_PATH}:`, error.message);
  }
}

// Function to get City Info from city name
async function getCityInfo(cityName, weatherKey, weatherUrl) {
  if (!cityName || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City name, Weather Key or Weather URL is missing for getCityInfo.');
    return { success: false, data: null, error: new Error('Missing parameters for getCityInfo.') };
  }

  // Check cache first
  const cityCache = await readCityCache();
  if (cityCache.has(cityName)) {
    const cachedCityInfo = cityCache.get(cityName);
    // Add validation for the cached data
    if (
      typeof cachedCityInfo === 'object' &&
      cachedCityInfo !== null &&
      cachedCityInfo.id &&
      cachedCityInfo.lat &&
      cachedCityInfo.lon &&
      cachedCityInfo.utcOffset
    ) {
      console.error(`[WeatherReporter] Using valid cached city info for ${cityName}`);
      return { success: true, data: cachedCityInfo, error: null };
    } else {
      console.error(`[WeatherReporter] Invalid or incomplete cached city info for ${cityName}. Refetching...`);
      // If cache is invalid, proceed to fetch from API as if cache didn't exist.
    }
  }

  const lookupUrl = `https://${weatherUrl}/geo/v2/city/lookup?location=${encodeURIComponent(
    cityName,
  )}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching city info for: ${cityName}`);
    const response = await requestWeather(lookupUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QWeather City Lookup API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.code === '200' && data.location && data.location.length > 0) {
      const cityInfo = data.location[0]; // Get the first and most relevant city object
      console.error(`[WeatherReporter] Successfully found city info for ${cityName}: ID ${cityInfo.id}`);
      // Write to cache
      await writeCityCache(cityName, cityInfo);
      return { success: true, data: cityInfo, error: null };
    } else {
      const errorMsg = data.code === '200' ? 'No location found' : `API returned code ${data.code}`;
      throw new Error(`Failed to get city info for ${cityName}. ${errorMsg}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching city info: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get Current Weather from City ID
async function getCurrentWeather(cityId, weatherKey, weatherUrl) {
  if (!cityId || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for getCurrentWeather.');
    return { success: false, data: null, error: new Error('Missing parameters for getCurrentWeather.') };
  }

  const weatherUrlEndpoint = `https://${weatherUrl}/v7/weather/now?location=${cityId}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching current weather for city ID: ${cityId}`);
    const response = await requestWeather(weatherUrlEndpoint);

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
    console.error(`[WeatherReporter] Error fetching current weather: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get N-day Forecast from City ID
async function getNDayForecast(cityId, weatherKey, weatherUrl, days = 7) {
  if (!cityId || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for getNDayForecast.');
    return { success: false, data: null, error: new Error('Missing parameters for getNDayForecast.') };
  }

  // Determine the correct API endpoint based on the number of days
  let endpoint;
  if (days <= 3) {
    endpoint = '3d';
  } else if (days <= 7) {
    endpoint = '7d';
  } else if (days <= 10) {
    endpoint = '10d';
  } else if (days <= 15) {
    endpoint = '15d';
  } else {
    // Fallback to 7 days if the requested number is out of a reasonable range
    console.warn(
      `[WeatherReporter] Requested forecast days (${days}) is out of typical range, falling back to 7 days.`,
    );
    endpoint = '7d';
  }

  const forecastUrlEndpoint = `https://${weatherUrl}/v7/weather/${endpoint}?location=${cityId}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching ${days}-day forecast for city ID: ${cityId}`);
    const response = await requestWeather(forecastUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QWeather 7-day Forecast API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.code === '200' && data.daily) {
      console.error(`[WeatherReporter] Successfully fetched ${days}-day forecast for ${cityId}.`);
      return { success: true, data: data.daily, updatedAt: data.updateTime, error: null };
    } else {
      throw new Error(`Failed to get ${days}-day forecast for ${cityId}. API returned code ${data.code}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching ${days}-day forecast: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get 24-hour Forecast from City ID
async function get24HourForecast(cityId, weatherKey, weatherUrl) {
  if (!cityId || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for get24HourForecast.');
    return { success: false, data: null, error: new Error('Missing parameters for get24HourForecast.') };
  }

  const forecastUrlEndpoint = `https://${weatherUrl}/v7/weather/24h?location=${cityId}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching 24-hour forecast for city ID: ${cityId}`);
    const response = await requestWeather(forecastUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QWeather 24-hour Forecast API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.code === '200' && data.hourly) {
      console.error(`[WeatherReporter] Successfully fetched 24-hour forecast for ${cityId}.`);
      return { success: true, data: data.hourly, updatedAt: data.updateTime, error: null };
    } else {
      throw new Error(`Failed to get 24-hour forecast for ${cityId}. API returned code ${data.code}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching 24-hour forecast: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get Weather Warning from City ID
async function getWeatherWarning(cityId, weatherKey, weatherUrl) {
  if (!cityId || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for getWeatherWarning.');
    return { success: false, data: null, error: new Error('Missing parameters for getWeatherWarning.') };
  }

  const warningUrlEndpoint = `https://${weatherUrl}/v7/warning/now?location=${cityId}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching weather warning for city ID: ${cityId}`);
    const response = await requestWeather(warningUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QWeather Weather Warning API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.code === '200') {
      console.error(`[WeatherReporter] Successfully fetched weather warning for ${cityId}.`);
      // The 'warning' field might be empty if no warnings exist
      return { success: true, data: data.warning || [], error: null };
    } else {
      throw new Error(`Failed to get weather warning for ${cityId}. API returned code ${data.code}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching weather warning: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get Moon Phase from City ID
async function getMoonPhase(cityId, weatherKey, weatherUrl) {
  if (!cityId || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] City ID, Weather Key or Weather URL is missing for getMoonPhase.');
    return { success: false, data: null, error: new Error('Missing parameters for getMoonPhase.') };
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const moonPhaseUrlEndpoint = `https://${weatherUrl}/v7/astronomy/moon?location=${cityId}&date=${today}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching moon phase for city ID: ${cityId}`);
    const response = await requestWeather(moonPhaseUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QWeather Moon Phase API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.code === '200') {
      console.error(`[WeatherReporter] Successfully fetched moon phase for ${cityId}.`);
      return { success: true, data: data, error: null };
    } else {
      throw new Error(`Failed to get moon phase for ${cityId}. API returned code ${data.code}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching moon phase: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get Air Quality
async function getAirQuality(latitude, longitude, weatherKey, weatherUrl) {
  if (!latitude || !longitude || !weatherKey || !weatherUrl) {
    console.error('[WeatherReporter] Latitude, Longitude, Weather Key or Weather URL is missing for getAirQuality.');
    return { success: false, data: null, error: new Error('Missing parameters for getAirQuality.') };
  }

  const airQualityUrlEndpoint = `https://${weatherUrl}/airquality/v1/current/${latitude}/${longitude}?key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching air quality for coords: ${latitude},${longitude}`);
    const response = await requestWeather(airQualityUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Air Quality API failed: ${response.status} ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    // 新 API 直接返回 { indexes, pollutants, stations }，无 code 字段
    if (data.indexes && data.indexes.length > 0) {
      const mainIndex = data.indexes.find((i) => i.code === 'us-epa') || data.indexes[0];
      const pm2p5Pollutant =
        data.pollutants && data.pollutants.find((p) => p.code === 'pm2p5');
      const now = {
        aqi: mainIndex.aqi,
        primary:
          (mainIndex.primaryPollutant && mainIndex.primaryPollutant.name) || 'NA',
        category: mainIndex.category || '',
        pm2p5: pm2p5Pollutant ? pm2p5Pollutant.concentration.value : null,
      };
      console.error(`[WeatherReporter] Successfully fetched air quality for ${latitude},${longitude}.`);
      return { success: true, data: now, error: null };
    } else {
      throw new Error(`Failed to get air quality for ${latitude},${longitude}. Response: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching air quality: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Function to get Solar Elevation Angle
async function getSolarElevationAngle(latitude, longitude, altitude, date, time, tz, weatherKey, weatherUrl) {
  if (!latitude || !longitude || !altitude || !date || !time || !tz || !weatherKey || !weatherUrl) {
    console.error(
      '[WeatherReporter] One or more parameters are missing for getSolarElevationAngle (lat, lon, alt, date, time, tz, key, url).',
    );
    return { success: false, data: null, error: new Error('Missing parameters for getSolarElevationAngle.') };
  }

  const locationString = `${longitude},${latitude}`;
  const solarAngleUrlEndpoint = `https://${weatherUrl}/v7/astronomy/solar-elevation-angle?location=${locationString}&alt=${altitude}&date=${date}&time=${time}&tz=${tz}&key=${weatherKey}`;

  try {
    console.error(`[WeatherReporter] Fetching solar elevation angle for coords: ${locationString}`);
    const response = await requestWeather(solarAngleUrlEndpoint);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[WeatherReporter] Solar Angle API request failed: ${response.status} ${errorText.substring(0, 200)}`,
      );
      return { success: false, data: null, error: new Error(`Solar Angle API request failed: ${response.status}`) };
    }

    const data = await response.json();
    if (data.code === '200') {
      console.error(`[WeatherReporter] Successfully fetched solar elevation angle for ${locationString}.`);
      return { success: true, data: data, error: null };
    } else {
      throw new Error(`Failed to get solar elevation angle for ${locationString}. API returned code ${data.code}`);
    }
  } catch (error) {
    console.error(`[WeatherReporter] Error fetching solar elevation angle: ${safeErrorMessage(error)}`);
    return { success: false, data: null, error: error };
  }
}

// Every fold carries the source/time/status so compression cannot hide stale data.
function formatWeatherInfo(data, { cached = false, error = '' } = {}) {
  const value = v => v == null || v === '' ? '--' : v;
  const time = v => new Date(v).toLocaleString('zh-CN', { timeZone: DEFAULT_TIMEZONE });
  const wind = (dir, scale) => `${value(dir)} ${value(scale)}级`;
  let current = `【天气信息】${data.city || process.env.VarCity || ''}\n`;
  current += `来源: ${data.provider === 'uapi' ? 'UAPI' : '和风天气'}\n`;
  current += `获取时间: ${time(data.lastUpdate)}\n`;
  current += `观测时间: ${time(data.sourceUpdatedAt || data.lastUpdate)}\n`;
  if (cached) current += `状态: 刷新失败，以下为 3 小时有效期内的缓存。${error}\n`;
  if (data.now) {
    current += `【当前天气】${data.now.text}，温度 ${value(data.now.temp)}℃，${wind(data.now.windDir, data.now.windScale)}\n`;
    current += `湿度: ${value(data.now.humidity)}%，气压: ${value(data.now.pressure)} hPa\n`;
  }
  if (data.airQuality) {
    const air = data.airQuality;
    current += `空气质量: ${value(air.category)} (AQI ${value(air.aqi)})，PM2.5: ${value(air.pm2p5)} μg/m³\n`;
  }
  if (data.warning === null) {
    current += '【天气预警】本次数据源未返回预警信息。\n';
  } else if (data.warning.length === 0) {
    current += '【天气预警】本次查询无有效预警。\n';
  } else {
    current += '⚠️【天气预警详情】\n';
    for (const w of data.warning) {
      current += `${value(w.title)}\n发布时间: ${time(w.pubTime)}\n`;
      if (w.endTime) current += `结束时间: ${time(w.endTime)}\n`;
      current += `级别: ${value(w.severityColor)}，类型: ${value(w.typeName)}\n${value(w.text)}\n`;
    }
  }
  const days = Math.min(15, Math.max(1, parseInt(process.env.forecastDays, 10) || 7));
  const daily = data.daily.slice(0, days);
  const dayLine = d => `${d.fxDate}: 白天${value(d.textDay)}/夜间${value(d.textNight)}，气温 ${value(d.tempMin)}~${value(d.tempMax)}℃`;
  const short = current + `\n【未来${Math.min(3, daily.length)}日预报】\n` + daily.slice(0, 3).map(dayLine).join('\n');
  let full = current + '\n【未来逐小时天气预报】\n';
  const interval = Math.min(24, Math.max(1, parseInt(process.env.hourlyForecastInterval, 10) || 2));
  const count = Math.min(24, Math.max(1, parseInt(process.env.hourlyForecastCount, 10) || 12));
  const hourly = data.hourly.filter(h => Date.parse(h.fxTime) >= Date.now());
  if (!hourly.length) full += '逐小时预报暂不可用。\n';
  for (let i = 0; i < hourly.length && i < interval * count; i += interval) {
    const h = hourly[i];
    full += `${time(h.fxTime)}: ${value(h.text)}，${value(h.temp)}℃，${wind(h.windDir, h.windScale)}，湿度 ${value(h.humidity)}%`;
    if (h.pop != null) full += `，降水概率 ${h.pop}%`;
    if (h.precip != null) full += `，降水量 ${h.precip} 毫米`;
    full += '\n';
  }
  full += `\n【未来${daily.length}日天气预报】\n`;
  if (!daily.length) full += '多日预报暂不可用。\n';
  for (const d of daily) {
    full += dayLine(d) + `\n白天风力: ${wind(d.windDirDay, d.windScaleDay)}，夜间风力: ${wind(d.windDirNight, d.windScaleNight)}\n`;
    if (d.sunrise || d.sunset) full += `日出: ${value(d.sunrise)}，日落: ${value(d.sunset)}\n`;
    if (d.precip != null) full += `降水: ${d.precip} 毫米\n`;
    if (d.uvIndex != null) full += `紫外线指数: ${d.uvIndex}\n`;
  }
  if (data.moon?.moonPhase?.length) {
    full += `\n【今日月相】${data.moon.moonPhase[0].name}\n月升: ${value(data.moon.moonrise)}，月落: ${value(data.moon.moonset)}\n`;
  }
  if (data.solarAngle) {
    full += `\n【太阳角度】高度角: ${value(data.solarAngle.solarElevationAngle)}°，方位角: ${value(data.solarAngle.solarAzimuthAngle)}°\n`;
  }
  return {
    readableText: full.trim(),
    dynamicFoldText: JSON.stringify({ vcp_dynamic_fold: true,
      plugin_description: '天气、预报、空气质量与气象预警',
      fold_blocks: [{ threshold: 0.65, content: full.trim() },
        { threshold: 0.55, content: short.trim() }, { threshold: 0, content: current.trim() }],
    }, null, 2),
  };
}

async function getCachedWeather() {
  try {
    const data = JSON.parse(await fs.readFile(JSON_CACHE_FILE_PATH, 'utf-8'));
    if (data.requestedCity !== process.env.VarCity) throw new Error('缓存城市与当前配置不匹配。');
    const provider = (process.env.WeatherProvider || 'auto').trim().toLowerCase();
    if (provider !== 'auto' && data.provider !== provider) throw new Error('缓存数据源与当前配置不匹配。');
    return getFreshWeather(data);
  } catch (error) {
    console.error(`[WeatherReporter] Cache unavailable: ${safeErrorMessage(error)}`);
    return null;
  }
}

async function fetchQWeather() {
  let lastError = null;

  const varCity = process.env.VarCity;
  const weatherKey = process.env.WeatherKey;
  const weatherUrl = normalizeHost(process.env.WeatherUrl);
  const forecastDays = parseInt(process.env.forecastDays, 10) || 7;

  if (!varCity || !weatherKey || !weatherUrl) {
    lastError = new Error('天气插件错误：获取天气所需的配置不完整 (VarCity, WeatherKey, WeatherUrl)。');
    console.error(`[WeatherReporter] ${lastError.message}`);
    throw lastError;
  }

  let cityInfo = null;
  let hourlyForecast = null;
  let weatherWarning = null;
  let forecast = null;
  let moonPhase = null;
  let airQuality = null;
  let solarAngle = null;

  // 1. Get City Info (includes ID, lat, lon)
  const cityResult = await getCityInfo(varCity, weatherKey, weatherUrl);
  if (cityResult.success) {
    cityInfo = cityResult.data;
  } else {
    lastError = cityResult.error;
    console.error(`[WeatherReporter] Failed to get city info: ${lastError.message}`);
    // If we can't get city info, we can't proceed.
    throw lastError;
  }

  const { id: cityId, lat: latitude, lon: longitude, alt: altitude = '50', tz: timezoneName, utcOffset } = cityInfo;

  // Prepare params for solar angle
  const now = new Date();
  // Use 'sv-SE' format which is 'YYYY-MM-DD HH:mm:ss' and easy to parse
  const localTimeStr = now.toLocaleString('sv-SE', { timeZone: timezoneName });
  const date = localTimeStr.substring(0, 10).replace(/-/g, ''); // YYYYMMDD
  const time = localTimeStr.substring(11, 16).replace(':', ''); // HHmm
  const tzParam = utcOffset.replace(':', '').replace('+', ''); // e.g. +08:00 -> 0800, -05:00 -> -0500

  const [nowResult, airQualityResult, solarAngleResult, hourlyResult, warningResult, forecastResult, moonResult] = await Promise.all([
    getCurrentWeather(cityId, weatherKey, weatherUrl),
    getAirQuality(latitude, longitude, weatherKey, weatherUrl),
    getSolarElevationAngle(latitude, longitude, altitude, date, time, tzParam, weatherKey, weatherUrl),
    get24HourForecast(cityId, weatherKey, weatherUrl),
    getWeatherWarning(cityId, weatherKey, weatherUrl),
    getNDayForecast(cityId, weatherKey, weatherUrl, forecastDays),
    getMoonPhase(cityId, weatherKey, weatherUrl),
  ]);
  const results = [nowResult, hourlyResult, forecastResult, warningResult, airQualityResult, solarAngleResult, moonResult];
  lastError = results.find(r => !r.success)?.error || null;
  hourlyForecast = hourlyResult.data;
  weatherWarning = warningResult.data;
  forecast = forecastResult.data;
  moonPhase = moonResult.data;
  airQuality = airQualityResult.data;
  solarAngle = solarAngleResult.data;
  if (!nowResult.data && !hourlyForecast?.length && !forecast?.length && !weatherWarning?.length) {
    throw lastError || new Error('和风天气未返回有效天气数据。');
  }
  return {
    provider: 'qweather', requestedCity: varCity, city: cityInfo.name,
    lastUpdate: new Date().toISOString(),
    sourceUpdatedAt: nowResult.data?.obsTime || hourlyResult.updatedAt || forecastResult.updatedAt,
    now: nowResult.data, hourly: hourlyForecast, warning: weatherWarning, daily: forecast,
    moon: moonPhase, airQuality, solarAngle,
  };
}

function normalizeHost(value = '') {
  const host = value.trim().replace(/^https:\/\//, '').replace(/\/$/, '');
  return /^[a-zA-Z0-9.-]+$/.test(host) ? host : '';
}

const LEGACY_HOSTS = new Set(['devapi.qweather.com', 'api.qweather.com', 'geoapi.qweather.com']);

async function fetchAndCacheWeather() {
  const provider = (process.env.WeatherProvider || 'auto').trim().toLowerCase();
  if (!['auto', 'uapi', 'qweather'].includes(provider)) throw new Error('WeatherProvider 请选择 auto、uapi 或 qweather。');
  const host = normalizeHost(process.env.WeatherUrl);
  let raw;
  if (provider === 'qweather' || (provider === 'auto' && process.env.WeatherKey && host && !LEGACY_HOSTS.has(host.toLowerCase()))) {
    try {
      if (LEGACY_HOSTS.has(host.toLowerCase())) throw new Error('请将 WeatherUrl 更新为和风天气控制台中的账号专属 API Host，或使用 WeatherProvider=auto。');
      raw = getFreshWeather(await fetchQWeather());
    } catch (error) {
      if (provider === 'qweather') throw error;
      console.error(`[WeatherReporter] QWeather unavailable; falling back to UAPI: ${safeErrorMessage(error)}`);
    }
  }
  if (!raw) {
    const requestedCity = process.env.VarCity;
    const cityCache = await readCityCache();
    const city = cityCache.get(requestedCity)?.name || requestedCity;
    raw = await fetchUapiWeather(city, requestWeather, requestedCity);
  }
  const data = getFreshWeather(raw);
  const formatted = formatWeatherInfo(data);
  // A cache write failure should not discard a valid live result.
  try {
    const temporaryPath = JSON_CACHE_FILE_PATH + `.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(temporaryPath, JSON_CACHE_FILE_PATH);
    await fs.writeFile(CACHE_FILE_PATH, formatted.readableText, 'utf-8');
  } catch (error) {
    console.error(`[WeatherReporter] Cache write failed: ${safeErrorMessage(error)}`);
  }
  return formatted.dynamicFoldText;
}

async function main() {
  let output;
  try {
    output = await fetchAndCacheWeather();
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error(`[WeatherReporter] ${message}`);
    const cached = await getCachedWeather();
    output = cached ? formatWeatherInfo(cached, { cached: true, error: message }).dynamicFoldText
      : `[天气暂不可用] ${message}；暂无有效期内的天气缓存。请稍后重试或检查天气配置。`;
  }
  // Publish an explicit unavailable status on failure: PluginManager can then replace its old value.
  process.stdout.write(output);
}

module.exports = { requestWeather, formatWeatherInfo, getCachedWeather, fetchAndCacheWeather, main };
if (require.main === module) {
  main().catch(error => {
    console.error(`[WeatherReporter] ${safeErrorMessage(error)}`);
    process.stdout.write('[天气暂不可用] 天气插件运行失败，请检查服务日志。');
  });
}

const { parseWeatherTime } = require('./weather-data');

const ICONS = { '晴': '100', '多云': '101', '阴': '104', '小雨': '305', '中雨': '306',
  '大雨': '307', '暴雨': '310', '雷阵雨': '302', '小雪': '400', '中雪': '401',
  '大雪': '402', '雨夹雪': '404', '雾': '501', '霾': '502' };
const iconFor = text => ICONS[text] || '999';
const scale = value => String(value ?? '').replace(/级$/, '');
const iso = value => {
  const time = parseWeatherTime(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

function observationTime(data, fetchedAt) {
  const absolute = iso(data.report_time);
  if (absolute) return absolute;
  // Prefer the absolute observation entry to a relative display label.
  const first = iso(data.hourly_forecast?.[0]?.time);
  if (first && Date.parse(first) <= fetchedAt + 5 * 60 * 1000) return first;
  const match = /^(\d+)\s*(秒|分钟|小时|天)前(?:发布|更新)?$/.exec(data.report_time || '');
  if (match) {
    const units = { '秒': 1000, '分钟': 60000, '小时': 3600000, '天': 86400000 };
    return new Date(fetchedAt - Number(match[1]) * units[match[2]]).toISOString();
  }
  if (/^(刚刚|刚刚发布|刚刚更新)$/.test(data.report_time || '')) return new Date(fetchedAt).toISOString();
  throw new Error('UAPI 天气响应缺少可识别的观测时间。');
}

function normalizeUapiWeather(data, requestedCity, fetchedAt = Date.now()) {
  if (!data || typeof data.weather !== 'string' || !data.weather ||
      data.temperature == null || !Number.isFinite(Number(data.temperature)) || !data.city) {
    throw new Error('UAPI 天气响应缺少城市、天气或温度。');
  }
  const observedAt = observationTime(data, fetchedAt);
  const current = {
    obsTime: observedAt, fxTime: observedAt, text: data.weather, temp: String(data.temperature),
    icon: data.weather_icon || iconFor(data.weather), humidity: data.humidity,
    windDir: data.wind_direction, windScale: scale(data.wind_power), pressure: data.pressure,
    precip: data.precipitation,
  };
  const hourly = (Array.isArray(data.hourly_forecast) ? data.hourly_forecast : [])
    .filter(h => iso(h?.time) && h.temperature != null)
    .map(h => ({ fxTime: iso(h.time), text: h.weather, temp: String(h.temperature),
      icon: h.weather_icon || iconFor(h.weather), windDir: h.wind_direction,
      windScale: scale(h.wind_scale), humidity: h.humidity, pressure: h.pressure ?? data.pressure,
      pop: h.pop, precip: h.precip }));
  // Current observations also support dashboard clients that consume hourly[0].
  if (!hourly.some(h => h.fxTime === observedAt)) hourly.unshift({ ...current });
  const daily = (Array.isArray(data.forecast) ? data.forecast : []).filter(d => d?.date).map(d => ({
    fxDate: d.date, tempMax: d.temp_max, tempMin: d.temp_min,
    textDay: d.weather_day, textNight: d.weather_night,
    iconDay: iconFor(d.weather_day), iconNight: iconFor(d.weather_night),
    windDirDay: d.wind_dir_day, windDirNight: d.wind_dir_night,
    windScaleDay: scale(d.wind_scale_day), windScaleNight: scale(d.wind_scale_night),
    humidity: d.humidity, precip: d.precip, uvIndex: d.uv_index, sunrise: d.sunrise, sunset: d.sunset,
  }));
  return {
    provider: 'uapi', requestedCity, city: data.district || data.city, adcode: data.adcode,
    lastUpdate: new Date(fetchedAt).toISOString(), sourceUpdatedAt: observedAt,
    now: current, hourly, daily,
    warning: Array.isArray(data.alerts) ? data.alerts.map(a => ({
      title: a.title, typeName: a.type, severityColor: a.level, text: a.text,
      pubTime: iso(a.publish_time), startTime: a.start_time ? iso(a.start_time) || a.start_time : null,
      endTime: a.end_time ? iso(a.end_time) || a.end_time : null, status: a.status,
    })) : null,
    airQuality: data.aqi != null ? { aqi: data.aqi, category: data.aqi_category,
      primary: data.aqi_primary || 'NA', pm2p5: data.air_pollutants?.pm25 } : null,
    moon: null, solarAngle: null,
  };
}

async function fetchUapiWeather(city, request, requestedCity = city) {
  if (!city || !city.trim()) throw new Error('请配置 VarCity 指定天气查询城市。');
  const url = new URL('https://uapis.cn/api/v1/misc/weather');
  url.search = new URLSearchParams({ city, extended: 'true', forecast: 'true', hourly: 'true', lang: 'zh' });
  const response = await request(url.toString());
  if (!response.ok) throw new Error(`UAPI 天气请求失败：HTTP ${response.status}`);
  return normalizeUapiWeather(await response.json(), requestedCity);
}

module.exports = { normalizeUapiWeather, fetchUapiWeather };

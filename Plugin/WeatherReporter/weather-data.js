// Shared freshness policy for the prompt plugin and cache consumers.
const MAX_CACHE_AGE_MS = 3 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function parseWeatherTime(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const text = value.trim();
  // UAPI's timezone-less timestamps describe China local time, regardless of server TZ.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? text.replace(' ', 'T') + '+08:00' : text;
  return Date.parse(normalized);
}

function isRecent(value, now = Date.now(), maxAge = MAX_CACHE_AGE_MS) {
  const time = parseWeatherTime(value);
  return Number.isFinite(time) && time <= now + CLOCK_SKEW_MS && now - time <= maxAge;
}

function filterActiveWarnings(warnings, now = Date.now()) {
  if (!Array.isArray(warnings)) return null; // Unknown differs from a successful empty list.
  return warnings.filter(w => {
    if (!w || typeof w !== 'object') return false;
    if (/cancel|inactive|lifted|expired|ended|resolved|解除|取消|失效/i.test(w.status || '')) return false;
    const published = parseWeatherTime(w.pubTime);
    const start = parseWeatherTime(w.startTime);
    const end = parseWeatherTime(w.endTime);
    if (!Number.isFinite(published) || published > now + CLOCK_SKEW_MS) return false;
    if (w.startTime && (!Number.isFinite(start) || start > now)) return false;
    if (w.endTime) return Number.isFinite(end) && end > now;
    // Some providers omit the end time. Keep such warnings for at most 24 hours.
    return now - published <= 24 * 60 * 60 * 1000;
  });
}

function getFreshWeather(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || !isRecent(data.lastUpdate, now) ||
      !isRecent(data.sourceUpdatedAt, now)) {
    throw new Error('天气数据已过期或缺少有效更新时间，请等待天气插件刷新。');
  }
  const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const hourly = Array.isArray(data.hourly) ? data.hourly.filter(h => {
    const time = parseWeatherTime(h?.fxTime);
    return Number.isFinite(time) && time >= now - 60 * 60 * 1000;
  }) : [];
  const daily = Array.isArray(data.daily) ? data.daily.filter(d =>
    /^\d{4}-\d{2}-\d{2}$/.test(d?.fxDate || '') && d.fxDate >= today) : [];
  const current = data.now && isRecent(data.now.obsTime, now) ? data.now : null;
  if (current && !hourly.some(h => h.fxTime === current.obsTime)) {
    hourly.unshift({ ...current, fxTime: current.obsTime });
  }
  const warning = filterActiveWarnings(data.warning, now);
  if (!current && !hourly.length && !daily.length && !warning?.length) {
    throw new Error('天气数据的有效时段已结束，请等待天气插件刷新。');
  }
  return { ...data, now: current, hourly, daily, warning };
}

module.exports = { MAX_CACHE_AGE_MS, parseWeatherTime, isRecent, filterActiveWarnings, getFreshWeather };

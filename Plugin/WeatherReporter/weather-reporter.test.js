const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs').promises;
const { getFreshWeather, filterActiveWarnings, MAX_CACHE_AGE_MS } = require('./weather-data');
const { normalizeUapiWeather, fetchUapiWeather } = require('./uapi-weather');
const { requestWeather, getCachedWeather } = require('./weather-reporter');

const NOW = Date.parse('2026-10-27T08:20:00+08:00');
function response() {
  return { city: '惠州市', district: '惠城区', adcode: '441302', weather: '晴', temperature: 0,
    humidity: 0, wind_direction: '东北风', wind_power: '3级', pressure: 1008,
    report_time: '2026-10-27 08:10:00', aqi: 0, aqi_category: '优',
    hourly_forecast: [{ time: '2026-10-27 09:00:00', temperature: 24, weather: '晴', wind_scale: '2级' }],
    forecast: [{ date: '2026-10-27', temp_min: 22, temp_max: 29, weather_day: '晴', weather_night: '晴' }],
  };
}
function weather() { return normalizeUapiWeather(response(), 'Huicheng', NOW); }

test('UAPI converts local timestamps and preserves zero-valued observations in the cache contract', () => {
  const data = getFreshWeather(weather(), NOW);
  assert.equal(data.sourceUpdatedAt, '2026-10-27T00:10:00.000Z');
  assert.equal(data.now.temp, '0');
  assert.equal(data.now.humidity, 0);
  assert.equal(data.airQuality.aqi, 0);
  assert.equal(data.now.windScale, '3');
  assert.equal(data.daily[0].fxDate, '2026-10-27');
  assert.equal(data.hourly.at(-1).fxTime, '2026-10-27T01:00:00.000Z');
  assert.equal(data.warning, null);
  assert.equal(data.requestedCity, 'Huicheng');
});

test('relative report times retain observation age and unparseable dates are rejected', () => {
  const raw = { ...response(), report_time: '10 分钟前发布', hourly_forecast: [] };
  assert.equal(normalizeUapiWeather(raw, '惠城', NOW).sourceUpdatedAt, '2026-10-27T00:10:00.000Z');
  assert.throws(() => normalizeUapiWeather({ ...raw, report_time: '未知' }, '惠城', NOW));
});

test('cache expiry checks both fetch time and source time, including clock skew', () => {
  const data = weather();
  assert.throws(() => getFreshWeather(data, NOW + MAX_CACHE_AGE_MS + 1));
  assert.throws(() => getFreshWeather({ ...data, sourceUpdatedAt: '2026-06-08T04:00:00Z' }, NOW));
  assert.throws(() => getFreshWeather({ ...data, lastUpdate: '2026-10-28T00:00:00Z' }, NOW));
  assert.throws(() => getFreshWeather({ ...data, lastUpdate: undefined }, NOW));
  assert.throws(() => getFreshWeather({ ...data, sourceUpdatedAt: undefined }, NOW));
});

test('fresh fetch metadata cannot make expired forecast periods usable', () => {
  const data = { ...weather(), now: null, hourly: [{ fxTime: '2026-06-08T13:00+08:00' }],
    daily: [{ fxDate: '2026-06-08' }], warning: [] };
  assert.throws(() => getFreshWeather(data, NOW));
});

test('warning validity covers end times, cancellations, future starts and missing end times', () => {
  const base = { pubTime: '2026-10-27T07:00+08:00', startTime: '2026-10-27T07:00+08:00' };
  const items = [
    { ...base, title: 'active', endTime: '2026-10-27T10:00+08:00' },
    { ...base, title: 'ended', endTime: '2026-10-27T08:00+08:00' },
    { ...base, title: 'cancelled', status: 'cancel', endTime: '2026-10-27T10:00+08:00' },
    { ...base, title: 'future', startTime: '2026-10-27T09:00+08:00' },
    { title: 'old-no-end', pubTime: '2026-06-07T16:20+08:00' },
    { ...base, title: 'recent-no-end' },
  ];
  assert.deepEqual(filterActiveWarnings(items, NOW).map(w => w.title), ['active', 'recent-no-end']);
  assert.equal(filterActiveWarnings(null, NOW), null);
  assert.deepEqual(filterActiveWarnings([], NOW), []);
});

test('UAPI requests encode the configured city and normalize alerts without credentials', async () => {
  const raw = response();
  raw.report_time = new Date().toISOString();
  raw.alerts = [];
  const data = await fetchUapiWeather('惠城', async url => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://uapis.cn');
    assert.equal(request.searchParams.get('city'), '惠城');
    assert.equal(request.searchParams.get('forecast'), 'true');
    assert.equal(request.searchParams.get('hourly'), 'true');
    assert.deepEqual([...request.searchParams.keys()].sort(), ['city', 'extended', 'forecast', 'hourly', 'lang']);
    return { ok: true, json: async () => raw };
  });
  assert.deepEqual(data.warning, []);
  await assert.rejects(fetchUapiWeather('惠城', async () => ({ ok: false, status: 429 })));
});

test('failure fallback uses fresh matching JSON and rejects the historical cache', async t => {
  const originalCity = process.env.VarCity;
  const originalProvider = process.env.WeatherProvider;
  t.after(() => {
    if (originalCity === undefined) delete process.env.VarCity; else process.env.VarCity = originalCity;
    if (originalProvider === undefined) delete process.env.WeatherProvider; else process.env.WeatherProvider = originalProvider;
  });
  process.env.VarCity = 'Huicheng';
  process.env.WeatherProvider = 'auto';
  const data = weather();
  data.lastUpdate = new Date().toISOString();
  data.sourceUpdatedAt = data.lastUpdate;
  data.now.obsTime = data.lastUpdate;
  t.mock.method(fs, 'readFile', async path => {
    assert.equal(String(path).endsWith('weather_cache.json'), true);
    return JSON.stringify(data);
  });
  assert.equal((await getCachedWeather()).provider, 'uapi');
  data.lastUpdate = '2026-06-08T04:00:16.288Z';
  assert.equal(await getCachedWeather(), null);
  data.lastUpdate = new Date().toISOString();
  data.requestedCity = '北京';
  assert.equal(await getCachedWeather(), null);
});

test('the request timeout aborts a stalled response body as well as connection setup', async t => {
  await import('node-fetch');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"temperature":');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await requestWeather(`http://127.0.0.1:${server.address().port}`, 100);
  await assert.rejects(response.json(), { name: 'AbortError' });
});

test('a failed refresh replaces the previous prompt value with an explicit unavailable result', async t => {
  const { main } = require('./weather-reporter');
  const previous = process.env.WeatherProvider;
  process.env.WeatherProvider = 'invalid-provider';
  t.after(() => {
    if (previous === undefined) delete process.env.WeatherProvider; else process.env.WeatherProvider = previous;
  });
  t.mock.method(fs, 'readFile', async () => JSON.stringify({
    ...weather(), requestedCity: process.env.VarCity, lastUpdate: '2026-06-08T04:00:16.288Z',
  }));
  let output = '';
  const write = t.mock.method(process.stdout, 'write', chunk => { output += chunk; return true; });
  try { await main(); } finally { write.mock.restore(); }
  // A nonempty successful stdio result is what makes PluginManager replace its old value.
  assert.equal(output.startsWith('[天气暂不可用]'), true);
});

test('the management weather endpoint refuses expired data and serves fresh normalized data', async t => {
  const express = require('express');
  const createSystemRouter = require('../../routes/admin/system');
  let data = { ...weather(), lastUpdate: '2026-06-08T04:00:16.288Z' };
  t.mock.method(fs, 'readFile', async () => JSON.stringify(data));
  const app = express();
  app.use(createSystemRouter({}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/weather`;
  const expired = await fetch(url);
  assert.equal(expired.status, 503);
  assert.equal((await expired.json()).success, false);
  const raw = response();
  raw.report_time = new Date().toISOString();
  data = normalizeUapiWeather(raw, 'Huicheng');
  const fresh = await fetch(url);
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).now.temp, '0');
});

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { fromTdx, TradeError, check } = require('./core/data.cjs');

const ASSETS = new Map([
    ...['theme.css', 'indicator-ui.css'].map(file => [`/${file}`, [file, 'text/css; charset=utf-8']]),
    ...['candle-chart.mjs', 'chart-engine.mjs', 'chart-model.mjs', 'chart-scale.mjs', 'indicators.mjs', 'indicator-layer.mjs', 'indicator-editor.mjs'].map(file => [`/${file}`, [file, 'text/javascript; charset=utf-8']]),
    ...['vcp-ui.js', 'component-manifest.js'].map(file => [`/vendor/vcp-ui/${file}`, [`vendor/vcp-ui/${file}`, 'text/javascript; charset=utf-8']]),
    ...['tokens.css', 'components.css', 'appearance.css'].map(file => [`/vendor/vcp-ui/${file}`, [`vendor/vcp-ui/${file}`, 'text/css; charset=utf-8']]),
    ['/vendor/vcp-ui/lucide-adapter.js', ['vendor/vcp-ui/lucide-adapter.js', 'text/javascript; charset=utf-8']],
    ['/vendor/lucide/lucide-subset.js', ['vendor/lucide/lucide-subset.js', 'text/javascript; charset=utf-8']],
    // The workspace page; the plugin root redirects here. Its requests use paths relative to this folder.
    ['/workspace/', ['workspace/index.html', 'text/html; charset=utf-8']],
    ...['app.mjs', 'dock.mjs', 'notice.mjs', 'panels.mjs', 'presets.mjs', 'settings.mjs', 'store.mjs']
        .map(file => [`/workspace/${file}`, [`workspace/${file}`, 'text/javascript; charset=utf-8']]),
    ['/workspace/workspace.css', ['workspace/workspace.css', 'text/css; charset=utf-8']],
    // 对决: rounds on historical problems against random traders and Agents.
    ['/duel/', ['duel/index.html', 'text/html; charset=utf-8']],
    ...['app.mjs', 'career.mjs', 'duel-chart.mjs', 'equity.mjs', 'game.mjs', 'home.mjs', 'result.mjs', 'setup.mjs', 'ui.mjs']
        .map(file => [`/duel/${file}`, [`duel/${file}`, 'text/javascript; charset=utf-8']]),
    ['/duel/duel.css', ['duel/duel.css', 'text/css; charset=utf-8']],
]);
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'" });
    res.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function body(req) {
    if (req.body !== undefined) {
        check(Buffer.byteLength(JSON.stringify(req.body)) <= 8 * 1024 * 1024, 'BODY_TOO_LARGE', '导入内容过大。');
        return req.body;
    }
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
        total += chunk.length;
        check(total <= 8 * 1024 * 1024, 'BODY_TOO_LARGE', '导入内容过大。');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new TradeError('INVALID_JSON', '请求不是有效的 JSON。'); }
}
// The admin panel's process reaches the main port over loopback and replaces Host with a loopback address.
const forwardedLocally = req => /^(?:127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ''))
    && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(req.headers.host || ''));
function authorized(actual, expected) {
    const a = Buffer.from(actual || ''), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
function createHandler(service, { accessToken, origin, adminMounted = false } = {}) {
    check(adminMounted || (accessToken && origin), 'INVALID_HOST', '预览需访问凭据；插件需挂载在管理路由后。');
    return async (req, res) => {
        try {
            if (origin) {
                check(req.headers.host === new URL(origin).host, 'FORBIDDEN', 'Host 不属于本地预览。');
            }
            const pathname = new URL(req.url, 'http://vtrade.invalid').pathname;
            if (adminMounted && req.originalUrl?.split('?')[0].endsWith('/vtrade')) {
                res.writeHead(302, { Location: `${req.originalUrl.split('?')[0]}/` }); res.end(); return;
            }
            if (req.method === 'GET' && pathname === '/') { res.writeHead(302, { Location: 'workspace/' }); res.end(); return; }
            if (req.method === 'GET' && (pathname === '/workspace' || pathname === '/duel')) {
                res.writeHead(302, { Location: `${(req.originalUrl || req.url).split('?')[0]}/` }); res.end(); return;
            }
            if (req.method === 'GET' && ASSETS.has(pathname)) {
                const [file, type] = ASSETS.get(pathname);
                send(res, 200, await fs.readFile(path.join(__dirname, 'frontend', file)), type);
                return;
            }
            check(req.method === 'POST' && ['/api/command', '/api/import', '/api/settings', '/api/market', '/api/duel'].includes(pathname),
                'NOT_FOUND', '端点不存在。');
            // Writes must come from the page itself. Browsers state this in Sec-Fetch-Site, which pages cannot set and
            // which stays correct behind the admin panel's proxy: it forwards to the main port, so Host no longer
            // matches the page's Origin. Browsers omit the header for plain-http LAN addresses; a request the local
            // panel forwarded then cannot be compared by Origin, and the JSON and X-VTrade-Request requirements below
            // still keep cross-site pages out. Any other request's Origin must match the preview origin or the Host.
            const requestOrigin = req.headers.origin, site = req.headers['sec-fetch-site'];
            if (!origin && site) check(site === 'same-origin', 'FORBIDDEN', '拒绝跨来源写入。');
            else if (requestOrigin && !(adminMounted && forwardedLocally(req))) {
                const expected = origin || `${req.protocol || 'http'}://${req.headers.host}`;
                check(requestOrigin === expected, 'FORBIDDEN', '拒绝跨来源写入。');
            }
            check(req.headers['x-vtrade-request'] === '1'
                && String(req.headers['content-type'] || '').startsWith('application/json'),
            'FORBIDDEN', '请求需使用 VTrade JSON 接口。');
            if (!adminMounted) {
                check(authorized(req.headers['x-vtrade-access'], accessToken), 'FORBIDDEN', '预览访问凭据不正确。');
            }
            const input = await body(req);
            let result;
            if (pathname === '/api/import') {
                check(input && typeof input === 'object', 'INVALID_DATA', '缺少导入数据。');
                check(['json', 'tdx', 'minute-json', 'minute-csv'].includes(input.format),
                    'INVALID_DATA', '导入格式须为日线或一分钟线 JSON/CSV。');
                if (input.format === 'minute-json' || input.format === 'minute-csv') {
                    result = await service.ingestMinutes(input.format === 'minute-json'
                        ? { ...input.dataset, requestId: input.requestId, expectedVersion: input.expectedVersion }
                        : { ...input, format: 'csv' });
                    send(res, 200, { ok: true, minuteImport: result }); return;
                }
                if (input.format === 'tdx') {
                    check(typeof input.dataBase64 === 'string' && input.dataBase64.length > 0
                        && input.dataBase64.length % 4 === 0
                        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64),
                    'INVALID_DATA', '通达信内容须为有效的 Base64。');
                }
                const data = input.format === 'tdx'
                    ? fromTdx(Buffer.from(input.dataBase64, 'base64'), input.symbol, input.name, { minimumBars: input.requestId ? 1 : 2 })
                    : input.dataset;
                result = input.requestId ? await service.ingestDataset(data, { requestId: input.requestId,
                    sourceId: input.sourceId, expectedDataVersion: input.expectedDataVersion, completedThrough: input.completedThrough })
                    : await service.importDataset(data);
            } else if (pathname === '/api/settings') {
                result = await service.settings(input);
            } else if (pathname === '/api/market') {
                result = await service.browse(input);
            } else if (pathname === '/api/duel') {
                result = await service.duel(input);
            } else { result = await service.command(input); }
            send(res, 200, { ok: true, ...result });
        } catch (error) {
            const known = error instanceof TradeError;
            send(res, error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : known ? 400 : 500,
                { ok: false, code: known ? error.code : 'INTERNAL_ERROR',
                    error: known ? error.message : 'VTrade 操作失败；请在本机检查存储与服务状态。' });
        }
    };
}
module.exports = { createHandler };

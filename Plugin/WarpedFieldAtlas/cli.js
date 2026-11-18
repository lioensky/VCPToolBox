'use strict';

// 双曲场图的命令行入口（开发和对研究用库副本查看时用）。不经过后端主进程，只监听本机地址。
// 用法：node cli.js --library <含 knowledge_base.sqlite 的目录> [--port 6471] [--cache <缓存目录>]
//        [--messages <folding_store.db>] [--exact-mb <数字>] [--ui <VCPChat 目录>]
// --messages 给出 ContextFolding 的存储后，可以拿真实对话消息当查询。
// --ui 从指定的 VCPChat 目录读取应用界面。不指定时仅提供接口。

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAtlas } = require('./lib/atlas');
const { parseExactMegabytes } = require('./lib/compact');

function argument(name, fallback = null) {
    const at = process.argv.indexOf(`--${name}`);
    if (at < 0) return fallback;
    const value = process.argv[at + 1];
    if (value && !value.startsWith('--')) return value;
    console.error(`--${name} 缺少参数值。`);
    process.exit(2);
}

const library = argument('library');
const port = Number(argument('port', '6471'));
const cache = argument('cache', path.join(os.tmpdir(), 'warped-field-atlas-cache'));
const ui = argument('ui');
if (!library) {
    console.error('用法：node cli.js --library <知识库目录> [--port 6471] [--cache <缓存目录>] [--messages <folding_store.db>] [--exact-mb <数字>] [--ui <VCPChat 目录>]');
    process.exit(2);
}

const renderer = ui ? path.resolve(ui, 'modules', 'warpedFieldAtlas', 'renderer') : null;
const atlas = createAtlas({
    directory: path.resolve(library), cacheDirectory: cache, messageStore: argument('messages'),
    exactMegabytes: parseExactMegabytes(argument('exact-mb')),
});
const ASSETS = new Map([
    ['/ui/atlas-app.js', ['atlas-app.js', 'text/javascript']],
    ['/ui/atlas.css', ['atlas.css', 'text/css']],
]);

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>双曲场图</title>
<link rel="stylesheet" href="/ui/atlas.css">
<style>html, body { height: 100%; margin: 0; background: #14110e; } #app { height: 100%; }</style>
</head>
<body>
<div id="app"></div>
<script type="module">
import { mountAtlas } from '/ui/atlas-app.js';
const get = async (route) => {
    const response = await fetch('/api' + route, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || '读取失败。');
    return body;
};
window.__atlas = mountAtlas(document.getElementById('app'), { get });
</script>
</body>
</html>`;

function send(response, status, type, body) {
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(body);
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET') return send(response, 405, 'application/json', '{"message":"只读。"}');
    if (url.pathname === '/') {
        if (renderer) return send(response, 200, 'text/html', PAGE);
        return send(response, 200, 'text/plain', '双曲场图仅提供接口（例如 /api/status）。使用 --ui <VCPChat 目录> 启用界面。');
    }
    if (url.pathname.startsWith('/api/')) {
        try {
            return send(response, 200, 'application/json', JSON.stringify(atlas.handle(url.pathname.slice(4), url.searchParams)));
        } catch (error) {
            const status = Number.isInteger(error.status) ? error.status : 500;
            if (status === 500) console.error(error);
            return send(response, status, 'application/json', JSON.stringify({ message: error.message }));
        }
    }
    const asset = renderer && ASSETS.get(url.pathname);
    if (asset) {
        const [name, type] = asset;
        try {
            const root = fs.realpathSync(renderer);
            const file = fs.realpathSync(path.join(root, name));
            if (path.dirname(file) === root && fs.statSync(file).isFile()) {
                return send(response, 200, type, fs.readFileSync(file));
            }
        } catch {
            return send(response, 404, 'text/plain', 'not found');
        }
    }
    return send(response, 404, 'text/plain', 'not found');
});

server.listen(port, '127.0.0.1', () => console.log(`双曲场图：http://127.0.0.1:${port}/`));
process.on('SIGINT', () => { atlas.close(); process.exit(0); });

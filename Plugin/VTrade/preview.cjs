'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { TradeService } = require('./core/service.cjs');
const { createHandler } = require('./http.cjs');

async function start({ port = 18880, directory = path.join(os.homedir(), '.vtrade-preview'), sourcesFile } = {}) {
    const service = await new TradeService(directory, { sourcesFile }).initialize();
    const token = randomBytes(24).toString('base64url');
    let handler;
    const server = http.createServer((req, res) => handler(req, res));
    server.requestTimeout = 15000;
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', resolve);
        });
    } catch (error) { await service.close(); throw error; }
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createHandler(service, { accessToken: token, origin });
    return { server, service, token, origin, url: `${origin}/#access=${token}`,
        async close() {
            await new Promise(resolve => server.close(resolve));
            await service.close();
        } };
}
if (require.main === module) {
    const args = process.argv.slice(2);
    const value = name => { const n = args.indexOf(name); return n < 0 ? undefined : args[n + 1]; };
    const port = Number(value('--port') || 18880);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port.');
    start({ port, directory: value('--data-dir'), sourcesFile: value('--sources-file') }).then(preview => {
        console.log(`VTrade 本地预览：${preview.url}`);
        console.log('仅监听本机。请保留窗口；Ctrl+C 停止。数据保存在本机，不随代码发布。');
        let closing = false;
        const close = async () => { if (closing) return; closing = true; await preview.close(); };
        process.on('SIGINT', close); process.on('SIGTERM', close);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { start };

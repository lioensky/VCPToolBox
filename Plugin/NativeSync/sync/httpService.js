'use strict';
// R4 wire contract on a host-owned HTTP server. Authentication and listening
// belong to VCPToolBox; the plugin opens no second server or authentication lane.
const { SyncError } = require('./centralStore');
function createSyncHttpService(store) {
    let closing = false, active = 0, drain;
    const drained = new Promise(resolve => { drain = resolve; });
    const send = (res, code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    async function handle(req, res) {
        if (closing) return send(res, 503, { error: { code: 'SYNC_SERVICE_STOPPED', message: 'Native sync service is stopping' } });
        active++;
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/pull') {
                const result=store.pull(Number(url.searchParams.get('after_seq') ?? 0), Number(url.searchParams.get('limit') ?? 100), req.nativeSyncTopics);
                return send(res,200,result);
            }
            if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, store.metrics());
            if (req.method === 'POST' && url.pathname === '/push') {
                // Express may already have consumed JSON before plugin routes.
                let op = req.body;
                if (op === undefined) {
                    let raw = '';
                    for await (const chunk of req) {
                        raw += chunk;
                        if (Buffer.byteLength(raw) > 1024 * 1024) throw new SyncError('BODY_TOO_LARGE', '1 MiB maximum', 413);
                    }
                    op = JSON.parse(raw);
                } else if (Buffer.byteLength(JSON.stringify(op)) > 1024 * 1024) throw new SyncError('BODY_TOO_LARGE', '1 MiB maximum', 413);
                return send(res, 200, store.apply(op));
            }
            return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
        } catch (error) {
            return send(res, error.status || 400, { error: { code: error.code || 'BAD_REQUEST', message: error.message } });
        } finally { active--; if (closing && active === 0) drain(); }
    }
    return { handle, async close() { closing = true; if (active > 0) await drained; store.close(); } };
}
module.exports = { createSyncHttpService };

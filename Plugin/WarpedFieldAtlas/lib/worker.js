'use strict';

// 独立进程持有场图的只读连接，不参与主服 SQLite 的进程级锁。
const { createAtlas } = require('./atlas');
const options = JSON.parse(process.argv[2]);
let atlas = null;

process.on('disconnect', () => {
    try { atlas?.close(); } finally { process.exit(0); }
});

process.on('message', ({ id, pathname, search }) => {
    let reply;
    try {
        if (!atlas) atlas = createAtlas(options);
        const body = JSON.stringify(atlas.handle(pathname, new URLSearchParams(search || '')));
        reply = { id, ok: true, body };
    } catch (error) {
        reply = { id, ok: false, status: Number.isInteger(error.status) ? error.status : 500, message: error.message };
    }
    if (process.connected) process.send(reply, () => {});
});

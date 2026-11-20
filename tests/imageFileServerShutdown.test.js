const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const imageModule = require.resolve('../Plugin/ImageFileServer/image-file-server.js');
const storeModule = require.resolve('../Plugin/VTrade/core/store.cjs');

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`ImageFileServer leaves ${signal} shutdown to the host`, (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-shutdown-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

        const child = spawnSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            const fs = require('node:fs/promises');
            const path = require('node:path');
            const [imageModule, storeModule, directory, signal] = process.argv.slice(1);
            const { Store } = require(storeModule);

            async function run() {
                const store = new Store(directory);
                await store.open();
                const lockFile = path.join(directory, 'writer.lock');
                assert.equal(await fs.readFile(lockFile, 'utf8'), String(process.pid));

                // Mirror the host contract, without booting a real server or touching its data.
                let hostShutdown;
                let image;
                process.once(signal, () => {
                    hostShutdown = (async () => {
                        await new Promise(resolve => setImmediate(resolve));
                        await image.shutdown();
                        await store.close();
                    })();
                });
                const signals = ['SIGINT', 'SIGTERM'];
                const before = signals.map(name => process.listeners(name));
                image = require(imageModule);
                assert.deepEqual(signals.map(name => process.listeners(name)), before);
                assert.equal(image.shutdown, image.stopSecurityManager);

                // Emitting in-process works on Windows too; no OS signal is sent.
                process.emit(signal);
                assert.ok(hostShutdown);
                await hostShutdown;
                await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
                const reopened = new Store(directory);
                await reopened.open();
                await reopened.close();
                console.log('host shutdown completed');
            }

            run().catch(error => {
                console.error(error);
                process.exit(1);
            });
        `, imageModule, storeModule, directory, signal], { encoding: 'utf8', timeout: 8000 });

        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /host shutdown completed/);
        assert.equal(fs.existsSync(path.join(directory, 'writer.lock')), false);
    });
}
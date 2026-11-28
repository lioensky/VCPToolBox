'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const plugin = path.resolve(__dirname, '../Plugin/GPTImageGen/GPTImageGen.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=';

function runPlugin(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [plugin], { env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `Plugin exited with code ${code}`));
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify(args));
    });
}

test('GPTImageGen accepts a root or /v1 base URL for generation, editing and chat', async t => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-image-url-'));
    t.after(() => fs.rm(project, { recursive: true }));
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const [basePath, endpoint, args, useChat] of [
        ['', '/v1/images/generations', {}, false],
        ['/proxy/v1/', '/proxy/v1/images/generations', {}, false],
        ['/proxy/v1', '/proxy/v1/images/edits', { command: 'edit', image: `data:image/png;base64,${png}` }, false],
        ['/proxy/v1', '/proxy/v1/chat/completions', {}, true],
    ]) {
        const result = await runPlugin({ prompt: 'Example', ...args }, {
            PROJECT_BASE_PATH: project,
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: `${origin}${basePath}`,
            USE_CHAT_COMPLETIONS_MODE: String(useChat),
            DEFAULT_SIZE: '1024x1024',
            DEFAULT_QUALITY: 'auto',
        });
        assert.deepEqual(requests.splice(0), [endpoint]);
        assert.equal(result.status, 'success', JSON.stringify(result));
    }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const axios = require('axios');
const { spawnSync } = require('node:child_process');

test('MagiAgent actual callback function sends server Key for success/failure, never API_Key', async t => {
    const source = fs.readFileSync(path.resolve(__dirname, '../Plugin/MagiAgent/MagiAgent.js'), 'utf8');
    const begin = source.indexOf('async function sendCompletionCallback(meeting)');
    const end = source.indexOf('// --- AI 模型调用 ---', begin);
    assert.ok(begin >= 0 && end > begin);
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body) });
            res.end('{}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const config = {
        CALLBACK_BASE_URL: `http://127.0.0.1:${server.address().port}/plugin-callback/`,
        Key: 'server-test-key', API_Key: 'upstream-not-for-callback'
    };
    const context = vm.createContext({
        serverConfig: config, axios,
        console: { log() {}, error() {} },
        formatMeetingResult: async () => ({ result: 'meeting result' }),
        sendVcpLog: null
    });
    vm.runInContext(source.slice(begin, end), context);
    const send = context.sendCompletionCallback;
    await send({ id: 'meeting-123', status: 'completed' });
    await send({ id: 'meeting-456', status: 'failed', error: 'test failure' });
    assert.equal(received.length, 2);
    assert.equal(received[0].auth, 'Bearer server-test-key');
    assert.equal(received[1].auth, 'Bearer server-test-key');
    assert.equal(received[0].url, '/plugin-callback/MagiAgent/meeting-123');
    assert.equal(received[0].body.status, 'Succeed');
    assert.equal(received[1].body.status, 'Failed');
    assert.equal(received[1].body.reason, 'test failure');
    delete config.Key;
    await send({ id: 'missing-key', status: 'completed' });
    assert.equal(received.length, 2);
});

test('MagiAgent callback does not follow redirects with server credentials', async t => {
    const source = fs.readFileSync(path.resolve(__dirname, '../Plugin/MagiAgent/MagiAgent.js'), 'utf8');
    const begin = source.indexOf('async function sendCompletionCallback(meeting)');
    const end = source.indexOf('// --- AI 模型调用 ---', begin);
    let redirected = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        if (req.url === '/leak') { redirected++; res.end('{}'); }
        else { res.writeHead(302, { Location: '/leak' }); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const context = vm.createContext({
        serverConfig: { CALLBACK_BASE_URL: `http://127.0.0.1:${server.address().port}/plugin-callback`, Key: 'test' },
        axios, console: { log() {}, error() {} }, sendVcpLog: null,
        formatMeetingResult: async () => ({ result: 'ok' })
    });
    vm.runInContext(source.slice(begin, end), context);
    await context.sendCompletionCallback({ id: 'redirect', status: 'completed' });
    assert.equal(redirected, 0);
});

test('Python video callbacks use server Key on both branches and reject redirects/errors', () => {
    // Extract and execute the production helper via AST: no image/API dependencies or billable requests.
    const script = String.raw`
import ast, os, types
from unittest.mock import patch
source = open("Plugin/VideoGenerator/video_handler.py", encoding="utf-8-sig").read()
tree = ast.parse(source)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "send_completion_callback")
calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "send_completion_callback"]
assert len(calls) == 2
seen = []
class Response:
    status_code = 200
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError("HTTP failure")
response = Response()
def post(url, **kwargs):
    seen.append((url, kwargs))
    return response
scope = {"os": os, "requests": types.SimpleNamespace(post=post)}
exec(compile(ast.Module(body=[fn], type_ignores=[]), "<production-callback>", "exec"), scope)
send = scope["send_completion_callback"]
with patch.dict(os.environ, {"Key": "server-key", "SILICONFLOW_API_KEY": "upstream-key"}, clear=True):
    send("http://callback", {"status": "Succeed"}, 30)
    send("http://callback", {"status": "PollingTimeout"}, 10)
    assert all(k["headers"]["Authorization"] == "Bearer server-key" and k["allow_redirects"] is False for _, k in seen)
    assert [k["timeout"] for _, k in seen] == [30, 10]
    for status in [302, 401]:
        response.status_code = status
        try: send("http://callback", {}, 10)
        except (ValueError, RuntimeError): pass
        else: raise AssertionError("HTTP error/redirect accepted")
with patch.dict(os.environ, {}, clear=True):
    count = len(seen)
    try: send("http://callback", {}, 10)
    except ValueError: pass
    else: raise AssertionError("missing key accepted")
    assert len(seen) == count
print("Python callback auth checks passed")
`;
    const result = spawnSync('python', ['-c', script], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});
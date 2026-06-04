const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function extractActivationId(source, constantName) {
    const pattern = new RegExp(`${constantName}\\s*=\\s*\\n?\\s*['"]([^'"]+)['"]`);
    const match = source.match(pattern);
    assert.ok(match, `missing ${constantName}`);
    return match[1];
}

test('secretless serum server authorizer binding matches route exact activation', () => {
    const routeSource = read('routes/admin/aiImageAgents.js');
    const serverSource = read('server.js');

    const routeActivationId = extractActivationId(
        routeSource,
        'SERUM_BOTTLE_SECRETLESS_EXACT_ACTIVATION_ID'
    );
    const serverActivationId = extractActivationId(
        serverSource,
        'SERUM_BOTTLE_SECRETLESS_EXACT_ACTIVATION_ID'
    );

    assert.equal(serverActivationId, routeActivationId);
    assert.equal(routeActivationId, 'AUTH-SECRETLESS-SERUM-LIVE-PROBE-20260603-012');
});

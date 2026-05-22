const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverPath = path.join(__dirname, '..', 'server.js');

test('/v1/human/tool tags direct tool calls with human-tool-route requestSource', () => {
    const source = fs.readFileSync(serverPath, 'utf8');
    const routeStart = source.indexOf("app.post('/v1/human/tool'");
    assert.notEqual(routeStart, -1, 'human tool route should exist');

    const routeEnd = source.indexOf("\n});", routeStart);
    assert.notEqual(routeEnd, -1, 'human tool route should close');

    const routeSource = source.slice(routeStart, routeEnd);
    assert.match(routeSource, /pluginManager\.processToolCall\(\s*requestedToolName,\s*parsedToolArgs,\s*clientIp,\s*\{\s*requestSource:\s*'human-tool-route'\s*\}\s*\)/);
});

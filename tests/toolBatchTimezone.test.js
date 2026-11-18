'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

for (const [timezone, instant, expected] of [
    ['Asia/Shanghai', '2026-10-29T13:25:17.192Z', '2026-10-29T21:25:17.192+08:00'],
    ['UTC', '2026-10-29T13:25:17.192Z', '2026-10-29T13:25:17.192+00:00'],
    ['Asia/Kathmandu', '2026-10-29T13:25:17.192Z', '2026-10-29T19:10:17.192+05:45'],
    ['America/New_York', '2026-07-01T00:00:00.123Z', '2026-06-30T20:00:00.123-04:00'],
    ['America/New_York', '2026-01-01T05:00:00.123Z', '2026-01-01T00:00:00.123-05:00'],
    ['invalid/timezone', '2026-10-29T13:25:17.192Z', '2026-10-29T21:25:17.192+08:00']
]) {
    test(`timezone ${timezone} at ${instant}`, () => {
        const script = `
            const assert = require('node:assert/strict');
            const batch = require('./modules/toolResultBatch');
            const divider = require('./modules/roleDivider');
            Date.now = () => Date.parse(${JSON.stringify(instant)});
            const expected = ${JSON.stringify(expected)};
            const output = batch.formatToolResultBatch(['literal']);
            const match = batch.createBatchStartScanner().exec(output);
            assert.equal(match[1], expected);
            assert.equal(Date.parse(match[1]), Date.now());
            assert.equal(output.slice(batch.findBatchEnd(output, match)).trim(), '<<<[END_ROLE_DIVIDE_USER]>>>');
            const old = '<<<[VCP_TOOL_BATCH_START:${instant}]>>>literal<<<[VCP_TOOL_BATCH_END:${instant}]>>>';
            const projected = batch.projectToolBatchForUpstream({messages:[{role:'user',content:old}]}).messages[0].content;
            assert.equal(projected, '【工具返回批次开始｜时间：' + expected + '】literal【工具返回批次结束｜时间：' + expected + '】');
            const messages = divider.process([{role:'assistant',content:'before' + output + 'after'}]);
            assert.deepEqual(messages.map(m => m.role), ['assistant','user','assistant']);
            assert.equal(messages[2].content.trim(), 'after');
        `;
        execFileSync(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, DEFAULT_TIMEZONE: timezone },
            stdio: 'pipe'
        });
    });
}
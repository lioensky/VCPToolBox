#!/usr/bin/env node
'use strict';

/**
 * LinuxShellExecutor v2.0 端到端回归套件
 *
 * 覆盖施工图中的 8 项验收用例：
 *   TC-01 多机并发广播
 *   TC-02 多机容错隔离
 *   TC-03 超时无损脱钩
 *   TC-04 queryTask 生命周期
 *   TC-05 cancelTask 终止与清理
 *   TC-06 Ctrl+C 交互穿透
 *   TC-07 stdin 文本注入
 *   TC-08 默认终端忙碌时自动升轨
 *   TC-09 安全授权管线（黑名单/特殊操作符/灰名单/二次确认/授权码逃逸）
 *   TC-10 预设命令（内存/CPU/磁盘/端口/进程）
 *
 * 运行：
 *   node Plugin/LinuxShellExecutor/test/run_suite.js
 */

const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');

const plugin = require('../LinuxShellExecutor');
const { taskStore } = plugin.__testing;

const results = [];
const createdTaskIds = new Set();
const createdTerminalIds = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(args) {
    const result = await plugin.runToolCall(args, { disconnectAfterCall: false });
    for (const item of result.results || []) {
        if (item && item.taskId) createdTaskIds.add(item.taskId);
    }
    return result;
}

function parseBlocks(text) {
    const blocks = [];
    const source = String(text || '');
    const pattern = /^<([^>\n]+)> \[([^\]\n]+)\]:\n(`{3,})\n([\s\S]*?)\n\3(?=\n|$)/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        blocks.push({
            hostId: match[1],
            meta: match[2],
            body: match[4]
        });
    }
    return blocks;
}

function assertWellFormedBlock(block, label) {
    assert.ok(block, `${label}: 未解析到主机输出块`);
    assert.ok(block.hostId, `${label}: 主机块缺少 hostId`);
    assert.ok(block.meta, `${label}: 主机块缺少 meta`);
    assert.ok(!/^\s*\{/.test(block.body), `${label}: 输出疑似嵌套 JSON`);
}

function recordTask(taskId) {
    if (taskId) createdTaskIds.add(taskId);
    return taskId;
}

async function testCase(id, name, fn) {
    const startedAt = Date.now();
    try {
        const detail = await fn();
        if (detail && detail.skip) {
            results.push({ id, name, status: 'SKIP', ms: Date.now() - startedAt, detail: detail.reason });
            console.log(`[SKIP] ${id} ${name} - ${detail.reason}`);
        } else {
            results.push({ id, name, status: 'PASS', ms: Date.now() - startedAt, detail: detail && detail.note });
            console.log(`[PASS] ${id} ${name} (${Date.now() - startedAt}ms)`);
        }
    } catch (error) {
        results.push({ id, name, status: 'FAIL', ms: Date.now() - startedAt, detail: error.message });
        console.error(`[FAIL] ${id} ${name} - ${error.message}`);
        if (process.env.VCP_TEST_VERBOSE) {
            console.error(error.stack);
        }
    }
}

function commandExists(command) {
    const probe = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    return probe.status === 0;
}

// ============================================
// TC-01 多机并发广播
// ============================================
async function testMultiHostFanout() {
    // 数组形式已移除：必须给出明确错误，而不是静默兼容。
    await assert.rejects(
        run({ command: 'echo hi', hostId: ['local'] }),
        /仅支持逗号分隔字符串/
    );

    const hostResult = await run({ action: 'listHosts' });
    const hosts = (hostResult.hosts || []).filter((host) => host.enabled !== false);
    let availableIds = hosts.map((host) => host.id);

    // 单机环境测试夹具：在内存中注册一个 local 副本，不修改 hosts.json。
    // 这样仍可验证 Promise.allSettled 并发分发与多块 Markdown 渲染。
    let syntheticHostId = null;
    if (availableIds.length < 2 && plugin.__testing.hostsConfig && plugin.__testing.hostsConfig.hosts) {
        syntheticHostId = 'local-2';
        plugin.__testing.hostsConfig.hosts[syntheticHostId] = {
            name: '测试本地副本',
            description: '仅用于回归套件的进程内 local 夹具',
            type: 'local',
            enabled: true,
            securityLevel: 'standard'
        };
        availableIds = [...availableIds, syntheticHostId];
    }

    if (availableIds.length < 2) {
        return {
            skip: true,
            reason: `仅检测到 ${availableIds.length} 台受管主机，无法执行多机并发用例`
        };
    }

    const targets = availableIds.slice(0, 2);
    try {
        const startedAt = Date.now();
        const result = await run({
            command: 'uname -srm',
            hostId: targets.join(', '),
            timeout: 10000
        });
        const elapsed = Date.now() - startedAt;
        const blocks = parseBlocks(result.output);

        assert.strictEqual(blocks.length, 2, `应返回 2 个主机块，实际 ${blocks.length}`);
        for (const block of blocks) {
            assertWellFormedBlock(block, 'TC-01');
            assert.ok(block.hostId === targets[0] || block.hostId === targets[1]);
            assert.ok(block.meta.startsWith('exit: 0'), `主机 ${block.hostId} 执行失败: ${block.meta}`);
            assert.ok(block.body.includes('Linux'), `主机 ${block.hostId} 输出异常`);
        }

        assert.ok(!String(result.output).trim().startsWith('{'), '输出不应是 JSON 包装');
        assert.ok(elapsed < 20000, `并发执行耗时异常: ${elapsed}ms`);

        const note = syntheticHostId
            ? `${targets.join(' + ')} 并行完成于 ${elapsed}ms（含进程内 local 夹具）`
            : `${targets.join(' + ')} 并行完成于 ${elapsed}ms`;
        return { note };
    } finally {
        if (syntheticHostId) {
            delete plugin.__testing.hostsConfig.hosts[syntheticHostId];
        }
    }
}

// ============================================
// TC-02 多机容错隔离
// ============================================
async function testPartialFailureIsolation() {
    const result = await run({
        command: 'echo vcp-local-ok',
        hostId: 'local, invalid-host-999',
        timeout: 8000
    });
    const blocks = parseBlocks(result.output);

    assert.strictEqual(blocks.length, 2, `应返回 2 个主机块，实际 ${blocks.length}`);
    assert.strictEqual(blocks[0].hostId, 'local');
    assert.ok(blocks[0].meta.startsWith('exit: 0'), `local 块应成功: ${blocks[0].meta}`);
    assert.ok(blocks[0].body.includes('vcp-local-ok'));

    assert.strictEqual(blocks[1].hostId, 'invalid-host-999');
    assert.ok(blocks[1].meta.startsWith('error,'));
    assert.ok(blocks[1].body.includes('目标主机 "invalid-host-999" 未在 hosts.json 中配置或不可达'));

    assert.ok(!String(result.output).trim().startsWith('{'));
    return { note: '故障主机被隔离为独立 error 块' };
}

// ============================================
// TC-03 超时无损脱钩
// ============================================
async function testTimeoutDetach() {
    const command = 'ping -c 8 127.0.0.1';
    const startedAt = Date.now();
    const result = await run({ command, hostId: 'local', timeout: 3000 });
    const elapsed = Date.now() - startedAt;

    const blocks = parseBlocks(result.output);
    assert.strictEqual(blocks.length, 1);
    assertWellFormedBlock(blocks[0], 'TC-03');
    assert.ok(blocks[0].meta.startsWith('detached, taskId:'), `应为 detached: ${blocks[0].meta}`);
    assert.ok(blocks[0].body.includes('[TIMEOUT]'));
    assert.ok(blocks[0].body.includes('日志哨兵:'));

    const taskId = recurseTaskId(result, blocks[0]);
    recordTask(taskId);
    assert.ok(taskId && taskId.startsWith('task_local_'), `taskId 异常: ${taskId}`);

    assert.ok(elapsed >= 2800 && elapsed < 6000, `脱钩耗时应约 3000ms，实际 ${elapsed}ms`);

    const task = taskStore.getTask(taskId);
    assert.ok(task, 'TaskStore 未登记脱钩任务');
    assert.ok(['running_detached', 'running'].includes(task.status), `任务状态异常: ${task.status}`);
    assert.ok(fs.existsSync(task.logPath), `日志哨兵不存在: ${task.logPath}`);

    const sizeBefore = fs.statSync(task.logPath).size;
    await sleep(1200);
    const sizeAfter = fs.statSync(task.logPath).size;
    assert.ok(sizeAfter > sizeBefore, '脱钩后日志未继续增长，进程可能已被误杀');

    return { note: `${elapsed}ms 返回 detached，日志持续增长 ${sizeBefore}->${sizeAfter} 字节` };
}

function recurseTaskId(result, block) {
    if (result && result.results && result.results[0] && result.results[0].taskId) {
        return result.results[0].taskId;
    }
    const match = String(block.meta || '').match(/taskId: (task_[A-Za-z0-9_.-]+)/);
    return match ? match[1] : null;
}

// ============================================
// TC-04 queryTask 生命周期
// ============================================
async function testTaskQueryLifecycle() {
    const detach = await run({
        command: 'ping -c 8 127.0.0.1',
        hostId: 'local',
        timeout: 3000
    });
    const taskId = recordTask((detach.results[0] || {}).taskId);
    assert.ok(taskId, 'TC-04 未获得 taskId');

    await sleep(500);
    const running = await run({ action: 'queryTask', taskId, lines: 10 });
    const runningBlock = parseBlocks(running.output)[0];
    assertWellFormedBlock(runningBlock, 'TC-04-running');
    assert.ok(runningBlock.meta.startsWith('running, taskId:'), `运行态 meta 异常: ${runningBlock.meta}`);
    assert.ok(runningBlock.meta.includes('elapsed:'));

    await sleep(6000);
    const completed = await run({ action: 'queryTask', taskId, lines: 20 });
    const completedBlock = parseBlocks(completed.output)[0];
    assertWellFormedBlock(completedBlock, 'TC-04-completed');
    assert.ok(completedBlock.meta.startsWith('completed, exit: 0, totalDuration:'), `完成态 meta 异常: ${completedBlock.meta}`);
    for (let i = 1; i <= 8; i += 1) {
        assert.ok(completedBlock.body.includes(`icmp_seq=${i}`), `缺少 icmp_seq=${i}`);
    }
    assert.ok(/packet loss/.test(completedBlock.body), '缺少 ping 汇总');

    const task = taskStore.getTask(taskId);
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.exitCode, 0);
    return { note: 'running -> completed，8 次 ping 回显完整' };
}

// ============================================
// TC-05 cancelTask 终止与清理
// ============================================
async function testTaskCancel() {
    const detach = await run({ command: 'ping -c 10 127.0.0.1', hostId: 'local', timeout: 1000 });
    const taskId = recordTask((detach.results[0] || {}).taskId);
    assert.ok(taskId, 'TC-05 未获得 taskId');

    const task = taskStore.getTask(taskId);
    assert.ok(fs.existsSync(task.pidPath), 'PID 哨兵不存在');
    const pid = Number.parseInt(fs.readFileSync(task.pidPath, 'utf8').trim(), 10);
    assert.ok(Number.isFinite(pid) && pid > 0, `PID 非法: ${pid}`);

    const cancel = await run({ action: 'cancelTask', taskId });
    const cancelBlock = parseBlocks(cancel.output)[0];
    assertWellFormedBlock(cancelBlock, 'TC-05');
    assert.ok(cancelBlock.meta.startsWith('cancelled, taskId:'), `取消 meta 异常: ${cancelBlock.meta}`);
    assert.ok(cancelBlock.body.includes('SIGTERM/SIGKILL'));
    assert.ok(cancelBlock.body.includes(String(pid)));

    await sleep(500);
    let alive = false;
    try {
        process.kill(pid, 0);
        alive = true;
    } catch (_) {}
    assert.ok(!alive, `PID ${pid} 仍存活`);

    assert.ok(!fs.existsSync(task.pidPath), 'PID 哨兵未清理');
    assert.ok(!fs.existsSync(task.logPath), '日志哨兵未清理');
    assert.ok(!fs.existsSync(task.receiptPath), '回执哨兵未清理');

    const query = await run({ action: 'queryTask', taskId });
    assert.ok(parseBlocks(query.output)[0].meta.startsWith('cancelled'));

    return { note: `PID ${pid} 已终止，哨兵文件已清理` };
}

// ============================================
// TC-06 Ctrl+C 交互穿透
// ============================================
async function testInteractiveCtrlC() {
    if (!commandExists('ping')) {
        return { skip: true, reason: '本机未安装 ping' };
    }

    const terminalId = 'debug-term';
    createdTerminalIds.add(terminalId);

    const start = await run({
        action: 'runInTerminal',
        command: 'ping 127.0.0.1',
        hostId: 'local',
        terminalId,
        startDelayMs: 700
    });
    const startBlock = parseBlocks(start.output)[0];
    assertWellFormedBlock(startBlock, 'TC-06-start');
    assert.ok(startBlock.meta.startsWith('running, terminalId: debug-term'), `启动 meta 异常: ${startBlock.meta}`);

    await sleep(900);
    const visibleBefore = await run({ action: 'queryVisible', hostId: 'local', terminalId, lines: 10 });
    const beforeBlock = parseBlocks(visibleBefore.output)[0];
    assert.ok(beforeBlock.meta.startsWith('visible_buffer, terminalId: debug-term'));
    assert.ok(/bytes from|PING/.test(beforeBlock.body), '终端未显示 ping 输出');

    const key = await run({ action: 'sendKey', hostId: 'local', terminalId, key: 'ctrl+c' });
    const keyBlock = parseBlocks(key.output)[0];
    assertWellFormedBlock(keyBlock, 'TC-06-key');
    assert.ok(keyBlock.meta.startsWith('signal: SIGINT, terminalId: debug-term'), `按键 meta 异常: ${keyBlock.meta}`);
    assert.ok(keyBlock.body.includes('\\x03'));

    await sleep(900);
    const visibleAfter = await run({ action: 'queryVisible', hostId: 'local', terminalId, lines: 20 });
    const afterBlock = parseBlocks(visibleAfter.output)[0];
    assert.ok(afterBlock.body.includes('^C'), '终端未回显 ^C');
    assert.ok(/packet loss|packets transmitted/.test(afterBlock.body), 'ping 未正常退出');

    return { note: 'Ctrl+C 命中前台 ping，终端解除阻塞' };
}

// ============================================
// TC-07 stdin 文本注入
// ============================================
async function testInteractivePaste() {
    const terminalId = 'input-term';
    createdTerminalIds.add(terminalId);

    const start = await run({
        action: 'runInTerminal',
        command: 'head -n 1',
        hostId: 'local',
        terminalId,
        startDelayMs: 600
    });
    const startBlock = parseBlocks(start.output)[0];
    assert.ok(startBlock.meta.startsWith('running, terminalId: input-term'), `启动 meta 异常: ${startBlock.meta}`);

    const paste = await run({
        action: 'pasteText',
        hostId: 'local',
        terminalId,
        text: 'y',
        submit: true
    });
    const pasteBlock = parseBlocks(paste.output)[0];
    assertWellFormedBlock(pasteBlock, 'TC-07');
    assert.ok(pasteBlock.meta.startsWith('stdin_injected, terminalId: input-term'), `注入 meta 异常: ${pasteBlock.meta}`);
    assert.ok(pasteBlock.body.includes('写入 1 个字符并追加回车'));

    await sleep(700);
    const visible = await run({ action: 'queryVisible', hostId: 'local', terminalId, lines: 20 });
    const visibleBlock = parseBlocks(visible.output)[0];
    assert.ok(visibleBlock.body.includes('y'), `未读取到注入内容: ${visibleBlock.body}`);

    return { note: 'head 成功读取 stdin 中的 y' };
}

// ============================================
// TC-08 默认终端忙碌时自动升轨
// ============================================
async function testAutoChannelPromotion() {
    createdTerminalIds.add('default');

    const background = await run({
        action: 'runInTerminal',
        command: 'ping -c 10 127.0.0.1',
        hostId: 'local',
        terminalId: 'default',
        startDelayMs: 500
    });
    const backgroundBlock = parseBlocks(background.output)[0];
    assert.ok(backgroundBlock.meta.startsWith('running, terminalId: default'), `后台终端 meta 异常: ${backgroundBlock.meta}`);

    const startedAt = Date.now();
    const dateResult = await run({ command: 'date +%s', hostId: 'local', timeout: 8000 });
    const elapsed = Date.now() - startedAt;
    const dateBlock = parseBlocks(dateResult.output)[0];

    assertWellFormedBlock(dateBlock, 'TC-08');
    assert.ok(dateBlock.meta.startsWith('exit: 0'), `date 未成功: ${dateBlock.meta}`);
    assert.ok(elapsed < 5000, `后续命令被默认终端阻塞: ${elapsed}ms`);

    const promoted = (dateResult.results[0] || {}).terminalId || '';
    assert.ok(promoted.startsWith('default_sub_'), `未自动升轨到子终端: ${promoted}`);

    // 收尾：中断 default 终端的 ping
    await run({ action: 'sendKey', hostId: 'local', terminalId: 'default', key: 'ctrl+c' });

    return { note: `默认终端忙碌，date 通过 ${promoted} 在 ${elapsed}ms 内返回` };
}

// ============================================
// TC-09 安全授权管线
// ============================================
async function testSecurityAuthorization() {
    const previousAuthCode = process.env.DECRYPTED_AUTH_CODE;
    process.env.DECRYPTED_AUTH_CODE = '123456';

    try {
        const blacklist = await run({ command: 'rm -rf /', hostId: 'local' });
        const blacklistBlock = parseBlocks(blacklist.output)[0];
        assert.ok(blacklistBlock.meta.startsWith('error,'), `黑名单未拦截: ${blacklistBlock.meta}`);
        assert.ok(blacklistBlock.body.includes('[黑名单]'), blacklistBlock.body);

        const specialOperator = await run({ command: 'echo a; echo b', hostId: 'local' });
        const specialBlock = parseBlocks(specialOperator.output)[0];
        assert.ok(specialBlock.body.includes('[安全分级]'), specialBlock.body);
        assert.ok(specialBlock.body.includes('特殊操作符'), specialBlock.body);

        const unknown = await run({ command: 'vcp-nonexistent-command-9999 --x', hostId: 'local' });
        const unknownBlock = parseBlocks(unknown.output)[0];
        assert.ok(unknownBlock.body.includes('不在任何名单中'), unknownBlock.body);

        const grayWithoutAuth = await run({ command: 'reboot --help', hostId: 'local' });
        const grayBlock = parseBlocks(grayWithoutAuth.output)[0];
        assert.ok(grayBlock.body.includes('[灰名单]'), grayBlock.body);
        assert.ok(grayBlock.body.includes('需要管理员验证码'), grayBlock.body);

        const grayWithoutDoubleConfirm = await run({
            command: 'reboot --help',
            hostId: 'local',
            requireAdmin: '123456'
        });
        const doubleBlock = parseBlocks(grayWithoutDoubleConfirm.output)[0];
        assert.ok(doubleBlock.body.includes('二次确认'), doubleBlock.body);

        const grayWithConfirm = await run({
            command: 'reboot --help',
            hostId: 'local',
            requireAdmin: '123456',
            doubleConfirm: true
        });
        const confirmedBlock = parseBlocks(grayWithConfirm.output)[0];
        assert.ok(confirmedBlock.meta.startsWith('exit: 0'), `验证码 + 二次确认未放行: ${confirmedBlock.meta}`);

        const unknownWithAuth = await run({
            command: 'vcp-nonexistent-command-9999 --x',
            hostId: 'local',
            requireAdmin: '123456'
        });
        const escapedBlock = parseBlocks(unknownWithAuth.output)[0];
        assert.ok(escapedBlock.meta.startsWith('exit: 127'), `授权码逃逸未生效: ${escapedBlock.meta}`);

        return { note: '黑名单 / 特殊操作符 / 灰名单验证码 / 二次确认 / 未知命令逃逸均生效' };
    } finally {
        if (previousAuthCode === undefined) {
            delete process.env.DECRYPTED_AUTH_CODE;
        } else {
            process.env.DECRYPTED_AUTH_CODE = previousAuthCode;
        }
    }
}

// ============================================
// TC-10 预设命令（跳过黑白灰名单）
// ============================================
async function testPresetCommands() {
    const presets = ['checkMemory', 'checkCpu', 'checkDiskUsage', 'checkPorts', 'checkProcesses'];
    for (const preset of presets) {
        const result = await run({
            command: `preset:${preset}`,
            hostId: 'local',
            timeout: 60000
        });
        const block = parseBlocks(result.output)[0];
        assertWellFormedBlock(block, `TC-10-${preset}`);
        assert.ok(block.meta.startsWith('exit: 0'), `${preset} 未成功: ${block.meta}`);
        assert.ok(block.body && block.body.length > 20, `${preset} 输出为空`);
    }
    return { note: `${presets.join(', ')} 均执行成功` };
}

// ============================================
// 清理
// ============================================
async function cleanup() {
    for (const taskId of createdTaskIds) {
        const task = taskStore.getTask(taskId);
        if (task && !['completed', 'cancelled', 'error'].includes(task.status)) {
            try {
                await run({ action: 'cancelTask', taskId });
            } catch (_) {}
        }
        if (task) {
            for (const file of [task.logPath, task.receiptPath, `${task.receiptPath}.tmp`, task.pidPath, task.scriptPath]) {
                try {
                    fs.unlinkSync(file);
                } catch (_) {}
            }
        }
        taskStore.removeTask(taskId);
    }

    const manager = plugin.__testing.getSSHManager();
    if (manager && typeof manager.closeTerminal === 'function') {
        for (const terminalId of createdTerminalIds) {
            try {
                await manager.closeTerminal('local', terminalId);
            } catch (_) {}
        }
        if (createdTerminalIds.has('default')) {
            try {
                await manager.closeTerminal('local', 'default');
            } catch (_) {}
        }
    }

    try {
        await plugin.shutdown();
    } catch (_) {}
}

// ============================================
// 主流程
// ============================================
async function main() {
    console.log('LinuxShellExecutor v2.1.0 端到端回归套件');
    console.log('='.repeat(72));

    await testCase('TC-01', 'Multi-Host Fanout Execution', testMultiHostFanout);
    await testCase('TC-02', 'Partial Failure Isolation', testPartialFailureIsolation);
    await testCase('TC-03', 'Timeout Detach & Wrapper', testTimeoutDetach);
    await testCase('TC-04', 'TaskStore Query Lifecycle', testTaskQueryLifecycle);
    await testCase('TC-05', 'TaskStore Cancel & Kill', testTaskCancel);
    await testCase('TC-06', 'Interactive Key Injection (Ctrl+C)', testInteractiveCtrlC);
    await testCase('TC-07', 'Interactive Stdin Paste', testInteractivePaste);
    await testCase('TC-08', 'Auto-Channel Elevation Under Busy', testAutoChannelPromotion);
    await testCase('TC-09', 'Security Authorization Pipeline', testSecurityAuthorization);
    await testCase('TC-10', 'Preset Commands', testPresetCommands);

    await cleanup();

    console.log('='.repeat(72));
    const passed = results.filter((item) => item.status === 'PASS').length;
    const skipped = results.filter((item) => item.status === 'SKIP').length;
    const failed = results.filter((item) => item.status === 'FAIL');

    for (const item of results) {
        const suffix = item.detail ? ` - ${item.detail}` : '';
        console.log(`${item.status.padEnd(4)} ${item.id} ${item.name} (${item.ms}ms)${suffix}`);
    }
    console.log('-'.repeat(72));
    console.log(`Total: ${passed} passed, ${skipped} skipped, ${failed.length} failed`);

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('套件执行失败:', error.stack || error.message);
    process.exitCode = 1;
});

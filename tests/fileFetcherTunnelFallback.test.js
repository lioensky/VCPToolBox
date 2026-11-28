const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { fileURLToPath } = require('node:url');
const WebSocket = require('ws');
const webSocketServer = require('../WebSocketServer');
const fileFetcherServer = require('../FileFetcherServer');

async function startTunnelHarness(t) {
    const cacheDir = fileFetcherServer.__testing.CACHE_DIR;
    const cacheDirExistedBefore = fs.existsSync(cacheDir);
    const existingCacheEntries = cacheDirExistedBefore ? new Set(fs.readdirSync(cacheDir)) : new Set();

    const httpServer = http.createServer();
    const clients = [];

    httpServer.listen(0, '::');
    await once(httpServer, 'listening');
    const { port } = httpServer.address();

    webSocketServer.setPluginManager({
        registerDistributedTools() {},
        unregisterAllDistributedTools() {},
        getPlugin() { return null; }
    });
    webSocketServer.initialize(httpServer, {
        debugMode: false,
        vcpKey: 'test-tunnel-key',
        heartbeatEnabled: false
    });
    await fileFetcherServer.initialize(webSocketServer);

    t.after(async () => {
        for (const ws of clients) {
            ws.once('error', () => {});
            ws.terminate();
        }
        fileFetcherServer.__testing.failedFetchCache.clear();
        fileFetcherServer.__testing.recentRequests.clear();
        fileFetcherServer.__testing.inFlightFetches.clear();
        await webSocketServer.shutdown();
        if (httpServer.listening) {
            await new Promise(resolve => httpServer.close(() => resolve()));
        }

        if (fs.existsSync(cacheDir)) {
            for (const entry of fs.readdirSync(cacheDir)) {
                if (!existingCacheEntries.has(entry)) {
                    fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
                }
            }
            if (!cacheDirExistedBefore && fs.readdirSync(cacheDir).length === 0) {
                fs.rmdirSync(cacheDir);
            }
        }
    });

    async function connectNode({
        host = '127.0.0.1',
        serverName = 'VCPChat-Desktop-Client-Distributed-Server',
        localIPs = ['192.168.1.50'],
        publicIP = '203.0.113.9',
        onFileRequest
    }) {
        const ws = new WebSocket(`ws://${host}:${port}/vcp-distributed-server/VCP_Key=test-tunnel-key`);
        clients.push(ws);
        const [ackBuf] = await once(ws, 'message');
        const { serverId } = JSON.parse(ackBuf.toString()).data;

        ws.send(JSON.stringify({
            type: 'register_tools',
            data: { serverName, tools: [], capabilities: {} }
        }));
        ws.send(JSON.stringify({
            type: 'report_ip',
            data: { serverName, localIPs, publicIP }
        }));

        const seenUrls = [];
        ws.on('message', async (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type !== 'execute_tool' || msg.data?.toolName !== 'internal_request_file') return;
            seenUrls.push(msg.data.toolArgs.fileUrl);
            try {
                const res = await onFileRequest(msg.data.toolArgs.fileUrl);
                ws.send(JSON.stringify({
                    type: 'tool_result',
                    data: { requestId: msg.data.requestId, status: 'success', result: res }
                }));
            } catch (err) {
                ws.send(JSON.stringify({
                    type: 'tool_result',
                    data: { requestId: msg.data.requestId, status: 'error', error: err.message }
                }));
            }
        });

        await new Promise(resolve => setTimeout(resolve, 35));
        return { ws, serverId, seenUrls };
    }

    return { connectNode, cacheDir };
}

test('1. extractAttachmentSha256 handles malformed percent in parent dirs, encoded slashes, backslashes, uppercase, and extensionless hashes', () => {
    const { extractAttachmentSha256 } = fileFetcherServer.__testing;
    const sha = 'a'.repeat(64);
    const upperSha = 'B'.repeat(64);

    assert.equal(extractAttachmentSha256(`file:///D:/VCPChat/attachments/${sha}.png`), sha);
    assert.equal(extractAttachmentSha256(`file:///D:/VCPChat/attachments/${upperSha}?v=1#hash`), 'b'.repeat(64));
    assert.equal(extractAttachmentSha256(`file:///D:/VCPChat/attachments\\${sha}.webp`), sha);
    // 父目录包含未转义 '%'，且分隔符包含 %5C / %2F 编码时仍能提取出附件哈希
    assert.equal(extractAttachmentSha256(`file:///C:/Users/100%_Admin%5Cattachments%2F${upperSha}.png`), 'b'.repeat(64));
    assert.equal(extractAttachmentSha256('file:///D:/docs/100%_report.png'), null);
    assert.equal(extractAttachmentSha256('file:///D:/docs/not_a_hash_file.png'), null);
    assert.equal(extractAttachmentSha256(`file:///D:/docs/${'c'.repeat(63)}.png`), null);
    assert.equal(extractAttachmentSha256(null), null);
    assert.equal(extractAttachmentSha256(undefined), null);
});

test('2. single tunnel node passes through arbitrary files with zero hash gate and percent-containing URLs do not throw URIError', async (t) => {
    const { connectNode } = await startTunnelHarness(t);
    const percentPayload = Buffer.from('PERCENT-REPORT-BYTES');
    const arbitraryZipPayload = Buffer.from('ARBITRARY-TUNNEL-ARCHIVE-BYTES');

    const node = await connectNode({
        host: '[::1]',
        localIPs: ['192.168.1.99'],
        publicIP: '203.0.113.10',
        onFileRequest: async (fileUrl) => {
            if (fileUrl.includes('100%_report.png')) {
                return { status: 'success', fileData: percentPayload.toString('base64'), mimeType: 'image/png' };
            }
            if (fileUrl.includes('build_artifact.zip') || fileUrl === 'file:///Users/macbook/Desktop/posix_sketch.png') {
                return { status: 'success', fileData: arbitraryZipPayload.toString('base64'), mimeType: 'application/octet-stream' };
            }
            return { status: 'error', error: 'ENOENT' };
        }
    });

    // 2a. 自报真实 IP 唯一命中时返回默认 serverName（兼容 server.js:637 POST 日志静默）
    assert.equal(webSocketServer.findServerByIp('192.168.1.99'), 'VCPChat-Desktop-Client-Distributed-Server');

    // 2b. 单节点隧道回退：::1 <-> 127.0.0.1 <-> ::ffff:127.0.0.1 对称互认并直接命中唯一在线节点
    assert.equal(webSocketServer.findServerByIp('127.0.0.1'), node.serverId);
    assert.equal(webSocketServer.findServerByIp('::ffff:127.0.0.1'), node.serverId);
    assert.equal(webSocketServer.findServerByIp('::1'), node.serverId);

    // 2c. 自报 IP 直连下含未转义 '%' 的本地文件路径不得触发 URIError
    const pctResult = await fileFetcherServer.fetchFile('file:///D:/reports/100%_report.png', '192.168.1.99');
    assert.deepEqual(pctResult.buffer, percentPayload);

    // 2d. 单节点隧道下：任意普通命名文件及跨 OS POSIX 路径（如 Mac/Linux 的 file:///Users/... 发往 Windows 主服）均零门槛直通落盘
    const cachedUrl = await fileFetcherServer.resolveFileUrl('file:///D:/workspace/build_artifact.zip', '127.0.0.1');
    assert.ok(cachedUrl.includes('.file_cache'));
    assert.deepEqual(fs.readFileSync(fileURLToPath(cachedUrl)), arbitraryZipPayload);

    const posixCachedUrl = await fileFetcherServer.resolveFileUrl('file:///Users/macbook/Desktop/posix_sketch.png', '127.0.0.1');
    assert.ok(posixCachedUrl.includes('.file_cache'));
    assert.deepEqual(fs.readFileSync(fileURLToPath(posixCachedUrl)), arbitraryZipPayload);
});

test('3. multi-node shared tunnel verifies SHA-256 across nodes, prefers newest connection, and refuses non-attachment paths', async (t) => {
    const { connectNode } = await startTunnelHarness(t);
    const realBuf = Buffer.from('REAL-SHARED-TUNNEL-ATTACHMENT');
    const fakeBuf = Buffer.from('SPOOFED-CONTENT-ON-OTHER-NODE');
    const sha = crypto.createHash('sha256').update(realBuf).digest('hex');

    const probeOrder = [];

    const n1 = await connectNode({
        host: '127.0.0.1',
        localIPs: ['10.0.0.1'],
        onFileRequest: async () => {
            probeOrder.push('n1');
            return { status: 'success', fileData: realBuf.toString('base64'), mimeType: 'image/png' };
        }
    });
    const n2 = await connectNode({
        host: '[::1]',
        localIPs: ['10.0.0.2'],
        onFileRequest: async () => {
            probeOrder.push('n2');
            return { status: 'success', fileData: fakeBuf.toString('base64'), mimeType: 'image/png' };
        }
    });
    const n3 = await connectNode({
        host: '127.0.0.1',
        localIPs: ['10.0.0.3'],
        onFileRequest: async () => {
            probeOrder.push('n3');
            return { status: 'error', error: 'ENOENT on n3' };
        }
    });

    assert.equal(webSocketServer.findServerByIp('127.0.0.1'), null);
    assert.deepEqual(
        webSocketServer.findServersByConnectionIp('127.0.0.1'),
        [n3.serverId, n2.serverId, n1.serverId]
    );

    // 无后缀大写 64-hex 附件：按 n3(ENOENT) -> n2(假哈希拒收) -> n1(真哈希采用)
    const extlessUrl = `file:///D:/VCPChat/attachments/${sha.toUpperCase()}`;
    const resolved1 = await fileFetcherServer.resolveFileUrl(extlessUrl, '127.0.0.1');
    assert.ok(resolved1.includes('.file_cache'));
    assert.deepEqual(fs.readFileSync(fileURLToPath(resolved1)), realBuf);
    assert.deepEqual(probeOrder, ['n3', 'n2', 'n1']);

    // 非附件普通路径：绝不向任何同 IP 节点发起试探
    const countsBefore = [n1.seenUrls.length, n2.seenUrls.length, n3.seenUrls.length];
    const fallbackUrl = await fileFetcherServer.resolveFileUrl('file:///D:/Users/Bob/Desktop/private_notes.png', '127.0.0.1');
    assert.equal(fallbackUrl, 'file:///D:/Users/Bob/Desktop/private_notes.png');
    assert.deepEqual([n1.seenUrls.length, n2.seenUrls.length, n3.seenUrls.length], countsBefore);

    // 新增最新节点 n4 持有真图（且测试父目录含 % 与反斜杠路径）：第一跳直接命中 n4
    const n4 = await connectNode({
        host: '127.0.0.1',
        localIPs: ['10.0.0.4'],
        onFileRequest: async () => {
            probeOrder.push('n4');
            return { status: 'success', fileData: realBuf.toString('base64'), mimeType: 'image/png' };
        }
    });
    probeOrder.length = 0;
    const backslashUrl = `file:///D:/100%_VCPChat/attachments\\${sha}.png`;
    const fetched = await fileFetcherServer.fetchFile(backslashUrl, '::ffff:127.0.0.1');
    assert.deepEqual(fetched.buffer, realBuf);
    assert.deepEqual(probeOrder, ['n4']);
    assert.ok(n4.seenUrls.includes(backslashUrl));
});

test('4. prevents duplicate default serverName hijacking across distinct client IPs and handles shared public NAT safely', async (t) => {
    const { connectNode } = await startTunnelHarness(t);
    const node1Desktop = Buffer.from('NODE-1-PRIVATE-DESKTOP-FILE');
    const node2Desktop = Buffer.from('NODE-2-TARGET-DESKTOP-FILE');
    const natAttachBuf = Buffer.from('NODE-2-SHARED-NAT-ATTACHMENT');
    const natAttachSha = crypto.createHash('sha256').update(natAttachBuf).digest('hex');

    // 两台电脑均使用默认同名 'VCPChat-Desktop-Client-Distributed-Server'，且处于同一办公室公网 NAT (203.0.113.88)
    const node1 = await connectNode({
        host: '127.0.0.1',
        serverName: 'VCPChat-Desktop-Client-Distributed-Server',
        localIPs: ['192.168.50.11'],
        publicIP: '203.0.113.88',
        onFileRequest: async (url) => {
            if (url.includes('same_path.png')) {
                return { status: 'success', fileData: node1Desktop.toString('base64'), mimeType: 'image/png' };
            }
            return { status: 'error', error: 'ENOENT on node1' };
        }
    });

    const node2 = await connectNode({
        host: '127.0.0.1',
        serverName: 'VCPChat-Desktop-Client-Distributed-Server',
        localIPs: ['192.168.50.22'],
        publicIP: '203.0.113.88',
        onFileRequest: async (url) => {
            if (url.includes('same_path.png')) {
                return { status: 'success', fileData: node2Desktop.toString('base64'), mimeType: 'image/png' };
            }
            if (url.includes(natAttachSha)) {
                return { status: 'success', fileData: natAttachBuf.toString('base64'), mimeType: 'image/png' };
            }
            return { status: 'error', error: 'ENOENT on node2' };
        }
    });

    // 4a. 按各自唯一局域网 IP 请求各自机器上的普通文件：
    // 修复前 findServerByIp 返回默认同名 serverName 导致 node2 请求被 node1 截胡报错 ENOENT；
    // 修复后 findServerByIp 检测到同名冲突自动返回唯一 serverId，精准路由至目标节点。
    assert.equal(webSocketServer.findServerByIp('192.168.50.11'), node1.serverId);
    assert.equal(webSocketServer.findServerByIp('192.168.50.22'), node2.serverId);

    const res1 = await fileFetcherServer.resolveFileUrl('file:///C:/Users/Admin/Desktop/only_node1_same_path.png', '192.168.50.11');
    const res2 = await fileFetcherServer.resolveFileUrl('file:///C:/Users/Admin/Desktop/only_node2_same_path.png', '192.168.50.22');
    assert.deepEqual(fs.readFileSync(fileURLToPath(res1)), node1Desktop);
    assert.deepEqual(fs.readFileSync(fileURLToPath(res2)), node2Desktop);
    // 4b. 当两台电脑从共享公网 NAT (203.0.113.88) 访问主服时：
    // 非附件路径严禁盲猜第一台电脑
    assert.equal(webSocketServer.findServerByIp('203.0.113.88'), null);
    await assert.rejects(
        () => fileFetcherServer.fetchFile('file:///C:/Users/Admin/Desktop/other_private.png', '203.0.113.88'),
        /未找到任何已知的分布式服务器/
    );

    // 但 SHA-256 附件可通过 findServersByReportedIp 多节点验真从 node2 顺利拉回
    const natAttachUrl = `file:///C:/Users/Admin/AppData/VCPChat/attachments/${natAttachSha}.png`;
    const natFetched = await fileFetcherServer.fetchFile(natAttachUrl, '203.0.113.88');
    assert.deepEqual(natFetched.buffer, natAttachBuf);
});

test('5. concurrent Promise.all tool calls share a single in-flight fetch (Singleflight) without self-aborting or torn reads', async (t) => {
    const { connectNode, cacheDir } = await startTunnelHarness(t);
    const largePayload = crypto.randomBytes(32 * 1024); // 32KB payload
    const sha = crypto.createHash('sha256').update(largePayload).digest('hex');

    let remoteCallCount = 0;
    await connectNode({
        host: '127.0.0.1',
        localIPs: ['10.88.0.1'],
        onFileRequest: async () => {
            remoteCallCount++;
            await new Promise(resolve => setTimeout(resolve, 60));
            return { status: 'success', fileData: largePayload.toString('base64'), mimeType: 'image/png' };
        }
    });

    const concurrentUrl = `file:///D:/VCPChat/attachments/${sha}.png`;

    // 模拟同一 Turn 中 8 个并发工具调用同时请求同一未缓存图片
    const results = await Promise.all(
        Array.from({ length: 8 }, () => fileFetcherServer.resolveFileUrl(concurrentUrl, '10.88.0.1'))
    );

    assert.equal(remoteCallCount, 1, '8 路并发请求应合并为 1 次远程 WebSocket 拉取');
    for (const resolvedUrl of results) {
        assert.ok(resolvedUrl.includes('.file_cache'));
        assert.deepEqual(fs.readFileSync(fileURLToPath(resolvedUrl)), largePayload);
    }

    // 紧接着在 5s 窗口内再次直接调 fetchFile：应直接命中本地缓存返回，绝不被 recentRequests 误拦
    const cachedRead = await fileFetcherServer.fetchFile(concurrentUrl, '10.88.0.1');
    assert.deepEqual(cachedRead.buffer, largePayload);
    assert.equal(remoteCallCount, 1);

    // 确认原子写盘未遗留任何 .tmp 临时文件
    const leftoverTmp = fs.readdirSync(cacheDir).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, []);
});

test('6. failedFetchCache is scoped by normalized requestIp and guards non-file/non-string inputs', async (t) => {
    const { connectNode } = await startTunnelHarness(t);
    const payload = Buffer.from('NODE-B-IMAGE-DATA');

    await connectNode({
        host: '127.0.0.1',
        localIPs: ['10.10.0.2'],
        publicIP: '198.51.100.2',
        onFileRequest: async () => ({ status: 'success', fileData: payload.toString('base64'), mimeType: 'image/png' })
    });

    const sharedPath = 'file:///C:/Users/Administrator/Desktop/shared_name.png';

    await assert.rejects(
        () => fileFetcherServer.fetchFile(sharedPath, '10.10.0.99'),
        /未找到任何已知的分布式服务器/
    );

    // 不同来源 IP B 请求同一路径，不应被 IP A 的失败缓存或循环保护误拦
    const resB = await fileFetcherServer.fetchFile(sharedPath, '10.10.0.2');
    assert.deepEqual(resB.buffer, payload);

    // 非法输入守卫
    assert.equal(await fileFetcherServer.resolveFileUrl(null, '10.10.0.2'), null);
    assert.equal(await fileFetcherServer.resolveFileUrl('https://example.com/a.png', '10.10.0.2'), 'https://example.com/a.png');
    await assert.rejects(
        () => fileFetcherServer.fetchFile(null, '10.10.0.2'),
        /只支持 file:\/\/ 协议/
    );
});

test('7. end-to-end cross-device CopyFile and MoveFile from client local path to server FileOperator over tunnel', async (t) => {
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const { connectNode } = await startTunnelHarness(t);

    const serverAllowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-hyperstack-move-'));
    t.after(() => fs.rmSync(serverAllowedDir, { recursive: true, force: true }));

    const clientFilePayload = Buffer.from('CROSS-DEVICE-ARBITRARY-MOVE-PAYLOAD-2026');
    await connectNode({
        host: '127.0.0.1',
        localIPs: ['192.168.31.88'],
        publicIP: '203.0.113.55',
        onFileRequest: async (fileUrl) => {
            if (fileUrl === 'file:///D:/ClientLaptop/notes_to_move.txt' || fileUrl === 'file:///D:/ClientLaptop/notes_to_copy.txt') {
                return { status: 'success', fileData: clientFilePayload.toString('base64'), mimeType: 'text/plain' };
            }
            return { status: 'error', error: 'ENOENT' };
        }
    });

    // 模拟 PluginManager.resolveArgsFileUrls 经隧道预拉取客户端任意普通命名文件
    const resolvedCopySrc = await fileFetcherServer.resolveFileUrl('file:///D:/ClientLaptop/notes_to_copy.txt', '127.0.0.1');
    const resolvedMoveSrc = await fileFetcherServer.resolveFileUrl('file:///D:/ClientLaptop/notes_to_move.txt', '127.0.0.1');
    assert.ok(resolvedCopySrc.includes('.file_cache'));
    assert.ok(resolvedMoveSrc.includes('.file_cache'));

    const destCopied = path.join(serverAllowedDir, 'copied_on_server.txt');
    const destMoved = path.join(serverAllowedDir, 'moved_on_server.txt');

    // 主服 ALLOWED_DIRECTORIES 仅授权外部 serverAllowedDir（未显式包含 .file_cache），验证跨设备 CopyFile 与 MoveFile 均畅通无阻
    const stdioOut = execFileSync(process.execPath, [path.resolve(__dirname, '../Plugin/FileOperator/FileOperator.js')], {
        encoding: 'utf8',
        input: [
            JSON.stringify({ command: 'CopyFile', sourcePath: resolvedCopySrc, destinationPath: destCopied }),
            JSON.stringify({ command: 'MoveFile', sourcePath: resolvedMoveSrc, destinationPath: destMoved })
        ].join('\n') + '\n',
        timeout: 15000,
        env: { ...process.env, ALLOWED_DIRECTORIES: serverAllowedDir, DEBUG_MODE: 'false' }
    });

    const [copyResp, moveResp] = stdioOut.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(copyResp.status, 'success', JSON.stringify(copyResp));
    assert.equal(moveResp.status, 'success', JSON.stringify(moveResp));
    assert.deepEqual(fs.readFileSync(destCopied), clientFilePayload);
    assert.deepEqual(fs.readFileSync(destMoved), clientFilePayload);
    assert.equal(fs.existsSync(fileURLToPath(resolvedMoveSrc)), false, 'MoveFile 后缓存源文件应被移走');
});

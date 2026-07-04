// Plugin/ChromeBridge/ChromeBridge.js
// 混合插件：既是Service（常驻监控），又支持Direct调用（执行命令）

const fs = require('fs');
const path = require('path');
const pluginManager = require('../../Plugin.js');
const browserRuntimeManager = require('../../modules/browserRuntimeManager.js');

let pluginConfig = {};
let debugMode = false;

// 存储连接的Chrome插件客户端
// key: clientId, value: { clientId, ws, clientKind, remoteAddress, connectedAt, lastSeenAt, capabilities, permissionLevel, managedTokenValid, activeTabInfo, maxTabs }
const connectedChromes = new Map();

// 存储等待响应的命令
// key: requestId, value: { resolve, reject, timeout, waitForPageInfo }
const pendingCommands = new Map();

const HIGH_PRIVILEGE_COMMANDS = new Set([
    'execute_script',
    'execute_saved_script',
    'cdp_network_query',
    'cdp_get_response_body',
    'cdp_clear_network',
    'cdp_runtime_evaluate',
    'cdp_network_set_extra_http_headers',
    'cdp_network_set_user_agent_override',
    'cdp_emulation_set_timezone_override',
    'cdp_emulation_set_locale_override',
    'cdp_emulation_set_device_metrics_override',
    'cdp_storage_get_cookies',
    'cdp_storage_clear_data_for_origin'
]);

const LIFECYCLE_COMMANDS = new Set([
    'open_chrome',
    'close_chrome',
    'browser_status',
    'keep_chrome_alive',
    'close_managed_tabs'
]);

function nowIso() {
    return new Date().toISOString();
}

function normalizeClientKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase();
    if (['managed', 'agent', 'user', 'distributed'].includes(normalized)) return normalized;
    return 'user';
}

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return Boolean(value);
}

function getMaxTabsLimit() {
    const parsed = Number.parseInt(process.env.VCP_BROWSER_MAX_TABS || pluginConfig.VCP_BROWSER_MAX_TABS || '8', 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 8;
}

function getClientPriority() {
    return String(process.env.VCP_BROWSER_CLIENT_PRIORITY || pluginConfig.VCP_BROWSER_CLIENT_PRIORITY || 'managed,agent,user,distributed')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(item => ['managed', 'agent', 'user', 'distributed'].includes(item));
}

function allowUserHighPrivilege() {
    return parseBoolean(process.env.VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE || pluginConfig.VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE, false);
}

function isOpen(ws) {
    return ws && ws.readyState === 1;
}

function getConnection(clientIdOrEntry) {
    if (!clientIdOrEntry) return null;
    if (typeof clientIdOrEntry === 'object' && clientIdOrEntry.ws) return clientIdOrEntry;
    return connectedChromes.get(clientIdOrEntry) || null;
}

function initialize(config) {
    pluginConfig = config || {};
    debugMode = pluginConfig.DebugMode || false;

    if (debugMode) {
        console.log('[ChromeBridge] Initializing hybrid plugin...');
    }

    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "Chrome桥接已加载，等待浏览器连接...");
}

function registerRoutes(app, config, projectBasePath) {
    if (debugMode) {
        console.log('[ChromeBridge] Registering routes...');
    }
}

function updateClientFromHello(entry, helloData = {}) {
    const declaredKind = normalizeClientKind(helloData.clientKind);
    const tokenValid = declaredKind === 'managed' && browserRuntimeManager.validateManagedToken(helloData.managedToken);

    entry.clientKind = tokenValid ? 'managed' : (declaredKind === 'managed' ? 'user' : declaredKind);
    entry.managedTokenValid = tokenValid;
    entry.permissionLevel = (tokenValid || entry.clientKind === 'agent') ? 'high' : 'restricted';
    entry.capabilities = Array.isArray(helloData.capabilities) ? helloData.capabilities : [];
    entry.extensionVersion = helloData.extensionVersion || entry.extensionVersion || null;
    entry.userAgent = helloData.userAgent || entry.userAgent || null;
    entry.platform = helloData.platform || entry.platform || null;
    entry.maxTabs = Number.parseInt(helloData.maxTabs, 10) || getMaxTabsLimit();
    entry.lastSeenAt = nowIso();

    if (tokenValid) {
        browserRuntimeManager.touchManagedBrowser();
    }

    console.log(`[ChromeBridge] 🤝 clientHello: ${entry.clientId}, kind=${entry.clientKind}, permission=${entry.permissionLevel}, tokenValid=${entry.managedTokenValid}`);
}

// WebSocketServer调用：新Chrome客户端连接
function handleNewClient(ws) {
    const clientId = ws.clientId;
    const remoteAddress = ws.clientIp || ws._socket?.remoteAddress || null;

    const entry = {
        clientId,
        ws,
        clientKind: 'user',
        remoteAddress,
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
        capabilities: [],
        permissionLevel: 'restricted',
        managedTokenValid: false,
        activeTabInfo: null,
        extensionVersion: null,
        userAgent: null,
        platform: null,
        maxTabs: getMaxTabsLimit()
    };

    connectedChromes.set(clientId, entry);

    console.log(`[ChromeBridge] ✅ Chrome客户端已连接: ${clientId}, 总数: ${connectedChromes.size}`);
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器已连接，等待页面信息...");

    ws.on('close', () => {
        connectedChromes.delete(clientId);
        console.log(`[ChromeBridge] ❌ Chrome客户端断开: ${clientId}, 剩余: ${connectedChromes.size}`);

        if (connectedChromes.size === 0) {
            pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器连接已断开。");
        }
    });

    ws.on('error', (error) => {
        console.warn(`[ChromeBridge] Chrome客户端错误 ${clientId}: ${error.message}`);
    });
}

// WebSocketServer调用：收到Chrome客户端的消息
function handleClientMessage(clientId, message) {
    const entry = connectedChromes.get(clientId);
    if (entry) {
        entry.lastSeenAt = nowIso();
        if (entry.clientKind === 'managed') {
            browserRuntimeManager.touchManagedBrowser();
        }
    }

    if (message.type === 'clientHello') {
        if (entry) {
            updateClientFromHello(entry, message.data || {});
        }
        return;
    }

    if (message.type === 'pageInfoUpdate') {
        const markdown = message.data.markdown;

        if (entry) {
            const lines = String(markdown || '').split('\n');
            const title = (lines[0] || '').replace(/^#\s*/, '').trim();
            const urlLine = lines.find(line => /^URL:\s*/i.test(line));
            entry.activeTabInfo = {
                title,
                url: urlLine ? urlLine.replace(/^URL:\s*/i, '').trim() : '',
                updatedAt: nowIso()
            };
        }

        // 更新占位符
        pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", markdown);

        if (debugMode) {
            console.log(`[ChromeBridge] 📄 收到页面更新，长度: ${markdown?.length || 0}`);
        }

        // 检查是否有等待此页面信息的命令
        pendingCommands.forEach((pendingCmd, requestId) => {
            if (pendingCmd.waitForPageInfo && pendingCmd.commandExecuted) {
                console.log(`[ChromeBridge] 🎉 命令 ${requestId} 收到页面信息，准备返回`);
                clearTimeout(pendingCmd.timeout);
                pendingCmd.resolve({
                    success: true,
                    message: pendingCmd.executionMessage,
                    result: pendingCmd.commandResult,
                    page_info: markdown
                });
                pendingCommands.delete(requestId);
            }
        });
    }
}

function buildCommandFromParams(params, suffix = '') {
    const cmd = {
        command: params[`command${suffix}`],
        browserTarget: params[`browserTarget${suffix}`] || params.browserTarget,
        target: params[`target${suffix}`],
        text: params[`text${suffix}`],
        url: params[`url${suffix}`],
        urlIncludes: params[`urlIncludes${suffix}`],
        cdpRequestId: params[`requestId${suffix}`] || params[`cdpRequestId${suffix}`],
        query: params[`query${suffix}`],
        scope: params[`scope${suffix}`],
        useRegex: params[`useRegex${suffix}`],
        caseSensitive: params[`caseSensitive${suffix}`],
        contextChars: params[`contextChars${suffix}`],
        maxResults: params[`maxResults${suffix}`],
        scriptName: params[`scriptName${suffix}`],
        direction: params[`direction${suffix}`],
        amount: params[`amount${suffix}`],
        x: params[`x${suffix}`],
        y: params[`y${suffix}`],
        behavior: params[`behavior${suffix}`],
        expression: params[`expression${suffix}`],
        selector: params[`selector${suffix}`],
        nodeId: params[`nodeId${suffix}`],
        depth: params[`depth${suffix}`],
        pierce: params[`pierce${suffix}`],
        headers: params[`headers${suffix}`],
        userAgent: params[`userAgent${suffix}`],
        acceptLanguage: params[`acceptLanguage${suffix}`],
        platform: params[`platform${suffix}`],
        timezoneId: params[`timezoneId${suffix}`],
        locale: params[`locale${suffix}`],
        width: params[`width${suffix}`],
        height: params[`height${suffix}`],
        deviceScaleFactor: params[`deviceScaleFactor${suffix}`],
        mobile: params[`mobile${suffix}`],
        origin: params[`origin${suffix}`],
        storageTypes: params[`storageTypes${suffix}`],
        cdpParams: params[`cdpParams${suffix}`]
    };

    Object.keys(cmd).forEach(key => cmd[key] === undefined && delete cmd[key]);
    return cmd;
}

function authorizeChromeCommand(entry, command) {
    if (!entry) {
        return { allowed: false, reason: '未选择浏览器客户端' };
    }

    if (LIFECYCLE_COMMANDS.has(command)) {
        return { allowed: true };
    }

    if ((entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent') {
        return { allowed: true };
    }

    if (HIGH_PRIVILEGE_COMMANDS.has(command)) {
        if (entry.clientKind === 'user' && allowUserHighPrivilege()) {
            return { allowed: true };
        }
        return {
            allowed: false,
            reason: `高权限指令 ${command} 默认只允许 managed Chrome 执行，当前目标为 ${entry.clientKind}`
        };
    }

    if (entry.clientKind === 'distributed') {
        const distributedAllowed = new Set(['open_url', 'click', 'type', 'scroll', 'query_html', 'query_js', 'list_tabs', 'switch_tab']);
        if (!distributedAllowed.has(command)) {
            return {
                allowed: false,
                reason: `distributed Chrome 默认不允许执行 ${command}`
            };
        }
    }

    return { allowed: true };
}

function getOpenClients() {
    return Array.from(connectedChromes.values()).filter(entry => isOpen(entry.ws));
}

async function waitForManagedClient(timeoutMs = 10000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const managed = getOpenClients().find(entry =>
            (entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent'
        );
        if (managed) return managed;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return null;
}

function getManagedConnectionDiagnostics() {
    const clients = getOpenClients().map(summarizeClient);
    const rejectedManagedLikeClients = clients.filter(client =>
        client.clientKind === 'user' &&
        client.managedTokenValid === false
    );

    return {
        runtime: browserRuntimeManager.getManagedBrowserStatus(),
        clients,
        rejectedManagedLikeClients,
        hint: 'open_chrome 接受 clientKind=managed 且 managedTokenValid=true 的托管 Chrome，或用户在扩展 Popup 中显式切换的 clientKind=agent 高权限模式；若没有任何 clients，优先怀疑扩展未加载或 MV3 service worker 没有启动。'
    };
}

async function selectChromeClient(cmdParams = {}, options = {}) {
    const target = normalizeClientKind(cmdParams.browserTarget || options.browserTarget || 'managed');
    const allowAutoCreate = options.allowAutoCreate !== false;
    let clients = getOpenClients();

    const findByKind = (kind) => clients.find(entry => {
        if (kind === 'managed') return (entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent';
        return entry.clientKind === kind;
    });

    if (target === 'managed') {
        let managed = findByKind('managed');
        if (!managed && allowAutoCreate) {
            await browserRuntimeManager.ensureManagedBrowser();
            managed = await waitForManagedClient();
        }
        if (!managed) {
            const diagnostics = getManagedConnectionDiagnostics();
            throw new Error(JSON.stringify({
                plugin_error: '未找到已通过 token 校验的 managed Chrome。不会回退到用户 Chrome。',
                diagnostics
            }));
        }
        return managed;
    }

    if (cmdParams.browserTarget) {
        return findByKind(target);
    }

    for (const kind of getClientPriority()) {
        const selected = findByKind(kind);
        if (selected) return selected;
    }

    if (allowAutoCreate) {
        await browserRuntimeManager.ensureManagedBrowser();
        return waitForManagedClient();
    }

    return null;
}

async function enforceManagedTabLimit(entry, cmdParams) {
    if (!entry || entry.clientKind !== 'managed' || cmdParams.command !== 'open_url') return;

    const maxTabs = getMaxTabsLimit();
    const tabsResult = await executeSingleCommand(entry, { command: 'list_tabs' }, false, false, { skipAuthorization: true, skipTouch: true });
    const result = tabsResult?.result;
    const count = Array.isArray(result) ? result.length : Number(result?.count || result?.tabs?.length || 0);

    if (count >= maxTabs) {
        throw new Error(`managed Chrome 当前标签页 ${count}/${maxTabs}，已拒绝继续打开新标签页以保护服务器 RAM。可先调用 close_tab/close_managed_tabs 清理。`);
    }
}

// 执行单个命令的辅助函数（内部使用）
async function executeSingleCommand(chromeEntryOrWs, cmdParams, waitForPageInfo = false, isInCommandChain = false, options = {}) {
    const entry = getConnection(chromeEntryOrWs) || (chromeEntryOrWs?.send ? { ws: chromeEntryOrWs, clientKind: 'user', permissionLevel: 'restricted' } : null);
    if (!entry || !isOpen(entry.ws)) {
        throw new Error('目标 Chrome 客户端不可用或已断开');
    }

    const { command } = cmdParams;
    if (!options.skipAuthorization) {
        const auth = authorizeChromeCommand(entry, command);
        if (!auth.allowed) {
            throw new Error(auth.reason);
        }
    }

    if (!options.skipTouch && entry.clientKind === 'managed') {
        browserRuntimeManager.touchManagedBrowser();
    }

    const bridgeRequestId = `cb-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // 只有会导致页面导航/交互变化的命令才默认等待页面信息；CDP/查询/脚本执行类指令直接返回结构化结果
    const pageChangingCommands = new Set(['open_url', 'click', 'type', 'scroll']);
    const needsPageLoad = (command === 'open_url' && isInCommandChain);
    const actualWaitForPageInfo = (waitForPageInfo && pageChangingCommands.has(command)) || needsPageLoad || cmdParams.wait_for_page_info === true;

    console.log(`[ChromeBridge] 🚀 执行命令: ${command}, target=${entry.clientKind}, requestId: ${bridgeRequestId}, 等待页面加载: ${actualWaitForPageInfo}`);

    // 构建命令消息，透传所有参数，但内部回调 requestId 必须最后写入，避免被 CDP 的网络 requestId 覆盖
    const commandMessage = {
        type: 'command',
        data: {
            ...cmdParams,
            requestId: bridgeRequestId,
            wait_for_page_info: actualWaitForPageInfo
        }
    };

    // 发送命令到Chrome
    entry.ws.send(JSON.stringify(commandMessage));

    // 创建Promise等待响应
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCommands.delete(bridgeRequestId);
            entry.ws.removeListener('message', messageListener);
            reject(new Error(`命令执行超时 (${command})`));
        }, 30000);

        // 注册等待
        pendingCommands.set(bridgeRequestId, {
            resolve,
            reject,
            timeout,
            waitForPageInfo: actualWaitForPageInfo,
            commandExecuted: false,
            executionMessage: null,
            commandResult: null
        });

        // 监听命令执行结果
        const messageListener = (message) => {
            try {
                const msg = JSON.parse(message);

                if (msg.type === 'command_result' && msg.data?.requestId === bridgeRequestId) {
                    const pending = pendingCommands.get(bridgeRequestId);
                    if (!pending) return;

                    if (msg.data.status === 'error') {
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(bridgeRequestId);
                        entry.ws.removeListener('message', messageListener);
                        reject(new Error(msg.data.error || '命令执行失败'));
                    } else if (!actualWaitForPageInfo) {
                        // 不需要等待页面信息，直接返回
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(bridgeRequestId);
                        entry.ws.removeListener('message', messageListener);
                        resolve({
                            success: true,
                            message: msg.data.message || '命令执行成功',
                            result: msg.data.result // 透传执行结果（如 HTML, JS 返回值, 网络日志等）
                        });
                    } else {
                        // 命令执行成功，标记并等待页面信息
                        console.log(`[ChromeBridge] ✅ 命令执行成功，等待页面加载/刷新...`);
                        pending.commandExecuted = true;
                        pending.executionMessage = msg.data.message || '命令执行成功';
                        pending.commandResult = msg.data.result;
                        // 不移除监听器，继续等待pageInfoUpdate
                    }
                }
            } catch (e) {
                console.error('[ChromeBridge] 解析消息失败:', e);
            }
        };

        entry.ws.on('message', messageListener);
    });
}

async function runLifecycleCommand(command, params = {}) {
    switch (command) {
        case 'open_chrome': {
            const timeoutMs = Number.parseInt(params.timeoutMs, 10) || 10000;
            await browserRuntimeManager.ensureManagedBrowser();
            let client = await waitForManagedClient(timeoutMs);

            if (!client) {
                console.warn('[ChromeBridge] open_chrome 未等到 managed token 连接，准备重启 managed Chrome 后重试一次。');
                await browserRuntimeManager.closeManagedBrowser('open_chrome_unverified_restart');
                await browserRuntimeManager.ensureManagedBrowser();
                client = await waitForManagedClient(timeoutMs);
            }

            if (!client) {
                const diagnostics = getManagedConnectionDiagnostics();
                diagnostics.debugTargets = await browserRuntimeManager.getManagedBrowserDebugTargets().catch(error => ({
                    available: false,
                    error: error.message
                }));
                throw new Error(JSON.stringify({
                    plugin_error: 'managed Chrome 已启动/重启，但没有通过 token 校验的 managed 扩展连接。已拒绝把用户 Chrome 当作 managed 使用。',
                    diagnostics
                }));
            }
            return {
                success: true,
                message: 'managed Chrome 已启动并通过 token 校验连接',
                result: {
                    runtime: browserRuntimeManager.getManagedBrowserStatus(),
                    connectedManagedClient: summarizeClient(client)
                }
            };
        }

        case 'close_chrome': {
            const status = await browserRuntimeManager.closeManagedBrowser('tool_call');
            return {
                success: true,
                message: '已请求关闭 managed Chrome（不会关闭用户 Chrome）',
                result: status
            };
        }

        case 'browser_status': {
            return {
                success: true,
                message: '获取浏览器运行时状态成功',
                result: {
                    runtime: browserRuntimeManager.getManagedBrowserStatus(),
                    clients: getOpenClients().map(summarizeClient),
                    maxTabs: getMaxTabsLimit()
                }
            };
        }

        case 'keep_chrome_alive': {
            return {
                success: true,
                message: '已刷新 managed Chrome idle timer',
                result: browserRuntimeManager.touchManagedBrowser()
            };
        }

        case 'close_managed_tabs': {
            const client = await selectChromeClient({ browserTarget: 'managed' }, { allowAutoCreate: false });
            if (!client) {
                return { success: true, message: '当前没有 connected managed Chrome', result: { closed: false } };
            }
            const result = await executeSingleCommand(client, { command: 'close_tab' }, false, false);
            return {
                success: true,
                message: '已请求关闭 managed Chrome 当前活动标签页',
                result
            };
        }

        default:
            throw new Error(`未知生命周期指令: ${command}`);
    }
}

function summarizeClient(entry) {
    return {
        clientId: entry.clientId,
        clientKind: entry.clientKind,
        remoteAddress: entry.remoteAddress,
        connectedAt: entry.connectedAt,
        lastSeenAt: entry.lastSeenAt,
        permissionLevel: entry.permissionLevel,
        managedTokenValid: entry.managedTokenValid,
        extensionVersion: entry.extensionVersion,
        platform: entry.platform,
        capabilities: entry.capabilities,
        maxTabs: entry.maxTabs,
        activeTabInfo: entry.activeTabInfo
    };
}

async function normalizeScriptCommand(cmd) {
    if (cmd.command !== 'execute_saved_script') return cmd;

    if (!cmd.scriptName) {
        throw new Error('execute_saved_script 缺少 scriptName 参数');
    }

    // 确保文件名安全，防止路径穿越
    const safeScriptName = path.basename(cmd.scriptName);
    const scriptsDir = path.join(__dirname, 'ChromeScripts');
    const scriptPath = path.join(scriptsDir, safeScriptName);

    try {
        if (!fs.existsSync(scriptsDir)) {
            fs.mkdirSync(scriptsDir, { recursive: true });
        }

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`持久化脚本文件不存在: ${safeScriptName}，请确保它存放在 Plugin/ChromeBridge/ChromeScripts 目录下。`);
        }

        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        // 转换为 execute_script 命令，并将脚本内容填入 text 参数
        cmd.command = 'execute_script';
        cmd.text = scriptContent;
        console.log(`[ChromeBridge] 📄 成功读取持久化脚本: ${safeScriptName}，转换为 execute_script 执行`);
        return cmd;
    } catch (err) {
        throw new Error(`读取持久化脚本失败: ${err.message}`);
    }
}

// Direct调用接口（hybridservice 使用 processToolCall）
async function processToolCall(params) {
    // 提取所有命令参数
    const commands = [];
    let commandIndex = 1;

    // 检查是否有编号的命令（command1, command2, ...）
    while (params[`command${commandIndex}`]) {
        commands.push(buildCommandFromParams(params, String(commandIndex)));
        commandIndex++;
    }

    // 如果没有编号命令，检查单个命令
    if (commands.length === 0 && params.command) {
        commands.push(buildCommandFromParams(params));
    }

    if (commands.length === 0) {
        throw new Error('未提供任何命令参数');
    }

    if (commands.length === 1 && LIFECYCLE_COMMANDS.has(commands[0].command)) {
        return runLifecycleCommand(commands[0].command, params);
    }

    console.log(`[ChromeBridge] 📋 收到 ${commands.length} 个命令，准备串行执行`);

    const isCommandChain = commands.length > 1;
    let chromeEntry = null;

    // 串行执行所有命令
    for (let i = 0; i < commands.length; i++) {
        const cmd = await normalizeScriptCommand(commands[i]);
        const isLastCommand = (i === commands.length - 1);

        console.log(`[ChromeBridge] 执行命令 ${i + 1}/${commands.length}: ${cmd.command}`);

        if (LIFECYCLE_COMMANDS.has(cmd.command)) {
            const lifecycleResult = await runLifecycleCommand(cmd.command, params);
            if (isLastCommand) return lifecycleResult;
            continue;
        }

        if (!chromeEntry || cmd.browserTarget) {
            chromeEntry = await selectChromeClient(cmd, { allowAutoCreate: true });
        }

        if (!chromeEntry) {
            throw new Error('没有可用的Chrome浏览器。请确认 VCP_BROWSER_RUNTIME_ENABLED=true 或手动连接 VCPChrome 扩展。');
        }

        await enforceManagedTabLimit(chromeEntry, cmd);

        // 最后一个命令需要等待并返回页面信息
        // open_url 在命令链中时总是需要等待页面加载完成（通过 isInCommandChain 参数）
        const result = await executeSingleCommand(
            chromeEntry,
            cmd,
            isLastCommand,  // waitForPageInfo - 只有最后一个命令返回页面信息
            isCommandChain  // isInCommandChain - 命令链中的 open_url 需要等待页面加载
        );

        console.log(`[ChromeBridge] ✅ 命令 ${i + 1}/${commands.length} 完成`);

        // 如果是最后一个命令，它的 Promise 已经 resolve 并返回结果
        if (isLastCommand) {
            return result;
        }
    }
}

async function executeManagedCommand(cmdParams, options = {}) {
    const client = await selectChromeClient({ ...cmdParams, browserTarget: 'managed' }, { allowAutoCreate: options.allowAutoCreate !== false });
    if (!client) {
        throw new Error('managed Chrome 未连接');
    }

    await enforceManagedTabLimit(client, cmdParams);
    return executeSingleCommand(client, cmdParams, options.waitForPageInfo === true, options.isInCommandChain === true);
}

function shutdown() {
    console.log('[ChromeBridge] 关闭中...');

    // 清理所有待处理的命令
    pendingCommands.forEach((pending, requestId) => {
        clearTimeout(pending.timeout);
        pending.reject(new Error('插件正在关闭'));
    });
    pendingCommands.clear();

    connectedChromes.clear();
}

module.exports = {
    initialize,
    registerRoutes,
    handleNewClient,
    handleClientMessage,
    processToolCall,
    executeManagedCommand,
    selectChromeClient,
    authorizeChromeCommand,
    shutdown
};
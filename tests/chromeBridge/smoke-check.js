'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const files = {
    bridge: path.join(root, 'Plugin', 'ChromeBridge', 'ChromeBridge.js'),
    runtime: path.join(root, 'modules', 'browserRuntimeManager.js'),
    background: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'background.js'),
    content: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'content_script.js'),
    protocolCore: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'web-agent-protocol.js'),
    pageCore: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'web-agent-page-core.js'),
    pageRuntimeCore: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'web-agent-page-runtime-core.js'),
    runtimeCore: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'web-agent-runtime-core.js'),
    adapterContract: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'adapter-contract.js'),
    chromeAdapter: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'chrome-adapter.js'),
    coreIndex: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'webcore', 'index.js'),
    popup: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'popup.js'),
    popupHtml: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'popup.html'),
    pluginManifest: path.join(root, 'Plugin', 'ChromeBridge', 'plugin-manifest.json'),
    extensionManifest: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'manifest.json'),
    managedSetup: path.join(root, 'scripts', 'open_managed_browser_setup.js'),
    fixture: path.join(root, 'tests', 'chromeBridge', 'pages', 'basic-actions.html')
};

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

function checkJavaScriptSyntax(file) {
    new vm.Script(read(file), { filename: file });
}

const checkedJavaScriptFiles = [
    files.bridge,
    files.runtime,
    files.background,
    files.content,
    files.protocolCore,
    files.pageCore,
    files.pageRuntimeCore,
    files.runtimeCore,
    files.adapterContract,
    files.chromeAdapter,
    files.coreIndex,
    files.popup,
    files.managedSetup
];
for (const file of checkedJavaScriptFiles) {
    checkJavaScriptSyntax(file);
}

const pluginManifest = JSON.parse(read(files.pluginManifest));
const extensionManifest = JSON.parse(read(files.extensionManifest));
const bridge = read(files.bridge);
const runtime = read(files.runtime);
const background = read(files.background);
const content = read(files.content);
const protocolCore = read(files.protocolCore);
const pageCore = read(files.pageCore);
const pageRuntimeCore = read(files.pageRuntimeCore);
const runtimeCore = read(files.runtimeCore);
const adapterContract = read(files.adapterContract);
const chromeAdapter = read(files.chromeAdapter);
const coreIndex = read(files.coreIndex);
const popup = read(files.popup);
const popupHtml = read(files.popupHtml);
const managedSetup = read(files.managedSetup);
const fixture = read(files.fixture);

assert.strictEqual(pluginManifest.version, '2.4.0');
assert.strictEqual(extensionManifest.manifest_version, 3);

assert.match(background, /protocolVersion:\s*3/);
assert.match(background, /stableSnapshotHash/);
assert.match(background, /sensitiveDomRedaction/);
assert.match(background, /redactSensitiveDom\s*=\s*true/);
assert.match(background, /importScripts\(/);
for (const coreFile of [
    'web-agent-protocol.js',
    'adapter-contract.js',
    'web-agent-runtime-core.js',
    'chrome-adapter.js'
]) {
    assert.match(background, new RegExp(coreFile.replace(/\./g, '\\.')), `background 缺少 Core 加载: ${coreFile}`);
}
assert.match(background, /createChromeWebAgentAdapter/);
assert.match(background, /createWebAgentRuntime/);
assert.match(background, /executeLegacyCommandThroughCore/);
assert.match(background, /normalizeLegacyChromeCommand/);
assert.match(background, /formatLegacyChromeResult/);
assert.match(background, /function isSafeContentScriptRetryCommand/);
assert.match(background, /function sendSafeCommandAfterNavigation/);
assert.match(background, /CONTENT_SCRIPT_NOT_READY_AFTER_NAVIGATION/);
for (const command of ['wait_for', 'get_page_info', 'get_page_image', 'query_html', 'query_js', 'page_code_search']) {
    assert.match(background, new RegExp(`['"]${command}['"]`), `缺少导航后安全重试命令: ${command}`);
}
assert.doesNotMatch(
    background.match(/function isSafeContentScriptRetryCommand[\s\S]*?\n}/)?.[0] || '',
    /send_keys|click|type|set_value/,
    '有副作用动作不得进入导航后自动重试白名单'
);
assert.match(background, /CDP_BACKEND_UNAVAILABLE/);
assert.match(background, /fallbackReason/);
assert.match(background, /unifiedPageGraph/);
assert.match(background, /groundedMarkdown/);
assert.match(background, /interactionTree/);
assert.match(background, /scrollContext/);
assert.match(background, /snapshotDiff/);
assert.match(background, /pageImages/);
assert.match(background, /pageImageCapture/);
assert.match(background, /executePageImageCommand/);
assert.match(background, /captureResolvedPageImage/);
assert.match(background, /command:\s*'page_get_image'/);
assert.match(background, /command === 'get_page_image' \|\| command === 'page_get_image'/);
assert.match(background, /OffscreenCanvas/);
assert.match(background, /PAGE_IMAGE_CAPTURED/);
assert.match(background, /data:image|blobToDataUrl/);
assert.match(background, /if\s*\(!runtimeIdentity\.managedRuntime\)/);
assert.match(background, /manualManagedSelection/);
assert.match(background, /normalizedMode === 'managed'/);
assert.match(background, /SET_CLIENT_MODE/);
assert.doesNotMatch(background, /managedPairingToken|manual_pairing/);
assert.match(background, /noteDocumentGeneration/);
assert.match(background, /updateDocumentState/);

assert.match(protocolCore, /const PROTOCOL_VERSION = 1/);
assert.match(protocolCore, /const CHROME_BRIDGE_PROTOCOL_VERSION = 3/);
assert.match(protocolCore, /debugger_send_command/);
assert.match(protocolCore, /const \[id, domain, risk, sideEffecting, retryable, sensitiveResult, requires\]/);
assert.match(protocolCore, /\n\s+risk,\r?\n\s+sideEffecting,/);
assert.match(protocolCore, /sideEffecting/);
assert.match(protocolCore, /retryable/);
assert.match(protocolCore, /sensitiveResult/);
assert.match(protocolCore, /function isRetryAllowed/);
assert.match(protocolCore, /runtime_execute_script/);
assert.match(protocolCore, /network_get_response_body/);
assert.match(protocolCore, /\['page_get_image',\s*'page',\s*Risk\.READ,\s*false,\s*true,\s*false,\s*\['page',\s*'screenshot'\]\]/);
assert.match(protocolCore, /get_page_image:\s*'page_get_image'/);

assert.match(adapterContract, /class WebAgentAdapter/);
assert.match(adapterContract, /sendDebuggerCommand/);
assert.match(adapterContract, /dispatchNativeInput/);
assert.match(adapterContract, /captureScreenshot/);
assert.match(adapterContract, /waitForNavigation/);

assert.match(runtimeCore, /function getKeyDescriptor/);
assert.match(runtimeCore, /windowsVirtualKeyCode:\s*13/);
assert.match(runtimeCore, /nativeVirtualKeyCode:\s*13/);
assert.match(runtimeCore, /function createKeyboardPlan/);
assert.match(runtimeCore, /function detectTargetTransition/);
assert.match(runtimeCore, /function buildResponseBodyResult/);
assert.match(runtimeCore, /maxBodyChars,\s*16384/);
assert.match(runtimeCore, /metadataOnly/);
assert.match(runtimeCore, /sha256Text/);
assert.match(runtimeCore, /debugger_send_command/);
assert.match(runtimeCore, /runtime_execute_script/);

assert.match(chromeAdapter, /Input\.dispatchMouseEvent/);
assert.match(chromeAdapter, /Input\.dispatchKeyEvent/);
assert.match(chromeAdapter, /Input\.insertText/);
assert.match(chromeAdapter, /type:\s*'char'/);
assert.match(chromeAdapter, /chrome\.debugger/);
assert.match(chromeAdapter, /chrome-tabs-capture/);
assert.match(coreIndex, /createChromeRuntime/);

assert.match(runtime, /runtimeInstanceId/);
assert.match(runtime, /lastCloseReason/);
assert.match(runtime, /previousPid/);
assert.match(runtime, /const expectedCloseReasons = new WeakMap\(\)/);
assert.match(runtime, /const spawnedProcess = spawn\(/);
assert.match(
    runtime,
    /if \(chromeProcess === spawnedProcess\) \{[\s\S]*?chromeProcess = null;/,
    '旧 Chrome 的 exit/error 回调只能清理自己，不得清空新一代进程引用'
);
assert.match(
    runtime,
    /expectedCloseReasons\.set\(proc, reason\)/,
    '主动关闭必须记录预期关闭原因'
);
assert.match(
    runtime,
    /if \(expectedReason\) \{[\s\S]*?console\.log\(message\);[\s\S]*?\} else \{[\s\S]*?console\.warn\(message\);/,
    '正常空闲/人工关闭不得作为 ERROR 输出'
);
assert.doesNotMatch(
    runtime,
    /console\.error\(`\[BrowserRuntimeManager\] launching managed Chrome/,
    '正常启动 managed Chrome 不得使用 ERROR 日志级别'
);

assert.match(managedSetup, /function buildOpenChromeToolRequest/);
assert.match(managedSetup, /function postHumanTool/);
assert.match(managedSetup, /path:\s*'\/v1\/human\/tool'/);
assert.match(managedSetup, /'Authorization':\s*`Bearer \$\{key\}`/);
assert.match(managedSetup, /'Content-Type':\s*'text\/plain;charset=UTF-8'/);
assert.match(managedSetup, /tool_name:「始」ChromeBridge「末」/);
assert.match(managedSetup, /command:「始」open_chrome「末」/);
assert.match(managedSetup, /interactiveSetup:「始」true「末」/);
assert.doesNotMatch(managedSetup, /browserRuntimeManager|ensureManagedBrowser|DevToolsActivePort|waitForManagedBrowserExit/);
assert.match(bridge, /const interactiveSetup = parseBoolean\(params\.interactiveSetup, false\)/);
assert.match(bridge, /idleTimeoutMs:\s*24 \* 60 \* 60 \* 1000/);
assert.match(bridge, /const launchedRuntime = browserRuntimeManager\.getManagedBrowserStatus\(\)/);
assert.match(
    bridge,
    /!runtimeAfterWait\.running[\s\S]*?runtimeAfterWait\.runtimeInstanceId === launchedRuntime\.runtimeInstanceId/,
    'open_chrome 必须识别等待期间由用户关闭的同一运行时实例'
);
assert.match(bridge, /managed_browser_closed_during_open/);
assert.match(
    bridge,
    /且浏览器仍在运行；准备重启 managed Chrome 后重试一次/,
    '只有浏览器仍在运行但扩展未可信连接时才允许重启重试'
);

assert.match(content, /VCPWebAgentPageRuntimeCore/);
assert.match(content, /createWebAgentPageRuntime/);
assert.match(content, /pageRuntime\.snapshot\(\)/);
assert.match(content, /pageRuntime\.execute\(/);
assert.match(content, /pageRuntime\.invalidateDocument/);
assert.match(content, /GET_GROUNDED_PAGE_INFO/);
assert.match(content, /EXECUTE_CORE_COMMAND/);
assert.match(content, /EXECUTE_COMMAND/);
assert.match(content, /get_page_image:\s*'page_get_image'/);
assert.doesNotMatch(content, /function validateEntry/);
assert.doesNotMatch(content, /function dispatchClick/);
assert.doesNotMatch(content, /function selectOption/);
assert.doesNotMatch(content, /function checkOcclusion/);

assert.match(pageCore, /SENSITIVE_FIELD_PATTERN/);
assert.match(pageCore, /redactHtmlWithMetadata/);
assert.match(pageCore, /captureElementActionState/);
assert.match(pageCore, /verifyInputAction/);
assert.match(pageCore, /verifyClickAction/);
assert.match(pageCore, /createElementSignature/);
assert.match(pageCore, /createLocatorHints/);

assert.match(pageRuntimeCore, /function buildHashes/);
assert.match(pageRuntimeCore, /function buildInteractionTree/);
assert.match(pageRuntimeCore, /function buildScrollContext/);
assert.match(pageRuntimeCore, /function buildDiff/);
assert.match(pageRuntimeCore, /format:\s*'grounded-markdown-v1'/);
assert.match(pageRuntimeCore, /contentBlockId/);
assert.match(pageRuntimeCore, /headingPath/);
assert.match(pageRuntimeCore, /agentRef/);
assert.match(pageRuntimeCore, /SCROLL_BOUNDARY_REACHED/);
assert.match(pageRuntimeCore, /REDACTION_ENABLED_NO_MATCH/);
assert.match(pageRuntimeCore, /ACTION_VERIFICATION_FAILED/);
assert.match(pageRuntimeCore, /ELEMENT_OCCLUDED/);
assert.match(pageRuntimeCore, /idempotentNoop/);
assert.match(pageRuntimeCore, /ELEMENT_HANDLE_NOT_REGISTERED/);
assert.match(pageRuntimeCore, /source:\s*'registry-exact'/);
assert.match(pageRuntimeCore, /recoveryUsed:\s*false/);
assert.match(pageRuntimeCore, /queryRootType/);
assert.match(pageRuntimeCore, /STRICT_IMAGE_ID_PATTERN/);
assert.match(pageRuntimeCore, /function scoreContentImage/);
assert.match(pageRuntimeCore, /function registerPageImage/);
assert.match(pageRuntimeCore, /function resolvePageImage/);
assert.match(pageRuntimeCore, /PAGE_IMAGE_RESOLVED/);
assert.match(pageRuntimeCore, /data-vcp-image-id/);

assert.match(popupHtml, /id="redactSensitiveDom"\s+checked/);
assert.match(popupHtml, /type="password"\s+id="vcpKey"/);
assert.doesNotMatch(popupHtml, /id="managedToken"/);
assert.match(popupHtml, /id="client-mode-error"/);
assert.match(popupHtml, /id="selectUserMode"/);
assert.match(popupHtml, /id="selectAgentMode"/);
assert.match(popupHtml, /id="selectManagedMode"/);
assert.doesNotMatch(popupHtml, /id="toggleClientMode"/);
assert.match(popup, /result\.redactSensitiveDom\s*!==\s*false/);
assert.match(popup, /selectClientMode\('user'\)/);
assert.match(popup, /selectClientMode\('agent'\)/);
assert.match(popup, /selectClientMode\('managed'\)/);
assert.doesNotMatch(popup, /currentClientKind === 'agent'\s*\?\s*'managed'/);
assert.doesNotMatch(popup, /managedPairingToken|managedTokenInput/);
assert.match(popup, /PRIVACY_SETTINGS_CHANGED/);
assert.match(popupHtml, /id="copyGroundedMarkdown"/);
assert.match(popupHtml, /复制当前页面 MD 操作图全文/);
assert.match(popup, /requestCurrentGroundedMarkdown/);
assert.match(popup, /GET_GROUNDED_PAGE_INFO/);
assert.match(popup, /writeTextToClipboard/);

assert.match(fixture, /type="password"/);
assert.match(fixture, /name="api_token"/);
assert.match(fixture, /type="checkbox"/);
assert.match(fixture, /aria-expanded="false"/);
assert.match(fixture, /bottom-marker/);
assert.match(fixture, /id="city"/);
assert.match(fixture, /id="appointment-date"/);
assert.match(fixture, /id="overlay"/);
assert.match(fixture, /id="hover-target"/);
assert.match(fixture, /id="disabled-button"/);
assert.match(fixture, /data-card/);
assert.match(fixture, /商品 Alpha/);
assert.match(fixture, /商品 Beta/);
assert.strictEqual((fixture.match(/class="buy-button"/g) || []).length, 2);

assert.match(bridge, /pageContentMarkdown/);
assert.match(bridge, /interactionTree/);
assert.match(bridge, /scrollContext/);
assert.match(bridge, /snapshotDiff/);
assert.match(bridge, /imageId/);
assert.match(bridge, /maxWidth/);
assert.match(bridge, /function getImageDataUrl/);
assert.match(bridge, /type:\s*'image_url'/);
assert.match(bridge, /url:\s*imageDataUrl/);
assert.match(bridge, /当前页面 Grounded Markdown/);
assert.match(bridge, /function controlsManagedRuntime/);
assert.match(bridge, /touchManagedRuntimeForCommand/);
assert.match(bridge, /function isTrustedManagedClient/);
assert.match(
    bridge,
    /entry\?\.clientKind === 'managed'[\s\S]*?entry\.managedTokenValid === true \|\| entry\.manualManagedSelection === true/,
    'managed 目标必须由 token 自动认证或 Popup 人工明确选择'
);
assert.doesNotMatch(
    bridge.match(/async function waitForManagedClient[\s\S]*?\n}/)?.[0] || '',
    /clientKind === 'agent'/,
    '远端 agent 不得满足本机 managed 启动等待条件'
);
assert.doesNotMatch(
    bridge.match(/function controlsManagedRuntime[\s\S]*?\n}/)?.[0] || '',
    /clientKind === 'agent'/,
    '远端 agent 不得控制或续租本机 managed 运行时'
);
assert.match(
    bridge.match(/function controlsManagedRuntime[\s\S]*?\n}/)?.[0] || '',
    /isTrustedManagedClient/,
    '本机运行时控制应统一接受自动或人工 Managed'
);
assert.match(bridge, /getRuntimeReplacementDetails/);
assert.match(bridge, /RUNTIME_RESTARTED/);
assert.match(bridge, /shouldUseTrustedKeyboard/);
assert.match(bridge, /command === 'send_keys'/);
assert.match(bridge, /\? 'cdp-input'/);
assert.doesNotMatch(
    bridge,
    /function handleClientMessage[\s\S]*?entry\.clientKind === 'managed'[\s\S]*?touchManagedBrowser\(\)[\s\S]*?if \(message\.type === 'clientHello'\)/,
    'heartbeat/pageInfo 等普通客户端消息不应刷新 managed idle timer'
);

const commandDescriptions = new Map(
    pluginManifest.capabilities.invocationCommands.map(item => [item.command, item.description])
);
for (const command of [
    'browser_status', 'type', 'click', 'scroll', 'get_page_info', 'get_page_image',
    'send_keys', 'set_value', 'select_option', 'hover', 'check', 'wait_for'
]) {
    assert(commandDescriptions.has(command), `缺少 manifest 指令说明: ${command}`);
}
assert.match(commandDescriptions.get('type'), /ACTION_VERIFICATION_FAILED/);
assert.match(commandDescriptions.get('scroll'), /SCROLL_BOUNDARY_REACHED/);
assert.match(commandDescriptions.get('get_page_image'), /image_url\.url=data:image/);
assert.match(commandDescriptions.get('get_page_image'), /IMG1/);

assert.match(commandDescriptions.get('hover'), /ELEMENT_OCCLUDED/);
assert.match(commandDescriptions.get('wait_for'), /dom_stable/);

const contentScripts = extensionManifest.content_scripts[0].js;
assert.deepStrictEqual(contentScripts, [
    'webcore/web-agent-protocol.js',
    'webcore/web-agent-page-core.js',
    'webcore/web-agent-page-runtime-core.js',
    'content_script.js'
]);
for (const injectedFile of contentScripts) {
    assert.match(
        background,
        new RegExp(`['"]${injectedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
        `手动补注入缺少 ${injectedFile}`
    );
}

console.log('ChromeBridge Web Agent Core 脚本级冒烟检查通过');
console.log(JSON.stringify({
    protocolVersion: 3,
    agentViewFormat: 'grounded-markdown-v1',
    pluginVersion: pluginManifest.version,
    defaultRedaction: true,
    responseBodyDefaultMaxChars: 16384,
    managedIdleTouch: 'command-dispatch-and-completion',
    managedSendKeysBackend: 'cdp-input',
    enterVerification: 'verified-or-dispatched-unconfirmed',
    enterObservationMs: 3000,
    navigationRetry: 'read-only-commands-only',
    fixture: path.relative(root, files.fixture),
    webAgentProtocolVersion: 1,
    pageRuntimeVersion: '0.3.0',
    coreCapabilityCount: 71,
    checkedJavaScriptFiles: checkedJavaScriptFiles.length
}, null, 2));
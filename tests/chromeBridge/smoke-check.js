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
    popup: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'popup.js'),
    popupHtml: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'popup.html'),
    pluginManifest: path.join(root, 'Plugin', 'ChromeBridge', 'plugin-manifest.json'),
    extensionManifest: path.join(root, 'Plugin', 'ChromeBridge', 'VCPChrome', 'manifest.json'),
    fixture: path.join(root, 'tests', 'chromeBridge', 'pages', 'basic-actions.html')
};

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

function checkJavaScriptSyntax(file) {
    new vm.Script(read(file), { filename: file });
}

for (const file of [files.bridge, files.runtime, files.background, files.content, files.popup]) {
    checkJavaScriptSyntax(file);
}

const pluginManifest = JSON.parse(read(files.pluginManifest));
const extensionManifest = JSON.parse(read(files.extensionManifest));
const bridge = read(files.bridge);
const runtime = read(files.runtime);
const background = read(files.background);
const content = read(files.content);
const popup = read(files.popup);
const popupHtml = read(files.popupHtml);
const fixture = read(files.fixture);

assert.strictEqual(pluginManifest.version, '2.3.0');
assert.strictEqual(extensionManifest.manifest_version, 3);

assert.match(background, /protocolVersion:\s*3/);
assert.match(background, /stableSnapshotHash/);
assert.match(background, /sensitiveDomRedaction/);
assert.match(background, /redactSensitiveDom\s*=\s*true/);
assert.match(background, /executeCdpAction/);
assert.match(background, /Input\.dispatchMouseEvent/);
assert.match(background, /Input\.dispatchKeyEvent/);
assert.match(background, /Input\.insertText/);
assert.match(background, /function getCdpKeyDescriptor/);
assert.match(background, /windowsVirtualKeyCode:\s*13/);
assert.match(background, /nativeVirtualKeyCode:\s*13/);
assert.match(background, /type:\s*'char'/);
assert.match(background, /function detectKeyboardPageTransition/);
assert.match(background, /function waitForKeyboardPageTransition/);
assert.match(background, /timeoutMs = 3000/);
assert.match(background, /observationTimedOut/);
assert.match(background, /enter-submit-page-transition/);
assert.match(background, /enter-dispatched-transition-unconfirmed/);
assert.match(background, /ACTION_DISPATCHED_UNCONFIRMED/);
assert.match(background, /观察窗内尚未确认页面迁移/);
assert.doesNotMatch(
    background,
    /verified\s*=\s*keyboardTransition\.observed\s*;/,
    'Enter 未观察到迁移时不得直接赋值 false 并包装成执行错误'
);
assert.match(
    background,
    /verified\s*=\s*keyboardTransition\.observed\s*\?\s*true\s*:\s*null/,
    'Enter 未确认态必须映射为 verified=null'
);
assert.match(background, /function isSafeContentScriptRetryCommand/);
assert.match(background, /function sendSafeCommandAfterNavigation/);
assert.match(background, /CONTENT_SCRIPT_NOT_READY_AFTER_NAVIGATION/);
for (const command of ['wait_for', 'get_page_info', 'query_html', 'query_js', 'page_code_search']) {
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
assert.match(background, /if\s*\(!runtimeIdentity\.managedRuntime\)/);
assert.match(background, /buildCdpResponseBodyResult/);
assert.match(background, /maxBodyChars,\s*16384/);
assert.match(background, /metadataOnly/);
assert.match(background, /sha256Text/);

assert.match(runtime, /runtimeInstanceId/);
assert.match(runtime, /lastCloseReason/);
assert.match(runtime, /previousPid/);

assert.match(content, /lastStableContentHash/);
assert.match(content, /lastStructureHash/);
assert.match(content, /buildStableSnapshotHashes/);
assert.match(content, /captureElementActionState/);
assert.match(content, /verifyInputAction/);
assert.match(content, /verifyClickAction/);
assert.match(content, /SCROLL_BOUNDARY_REACHED/);
assert.match(content, /SENSITIVE_FIELD_PATTERN/);
assert.match(content, /redactHtml/);
assert.match(content, /redactHtmlWithMetadata/);
assert.match(content, /REDACTION_ENABLED_NO_MATCH/);
assert.match(content, /redactedFieldCount/);
assert.match(content, /ACTION_VERIFICATION_FAILED/);
assert.match(content, /checkElementOcclusion/);
assert.match(content, /ELEMENT_OCCLUDED/);
assert.match(content, /sendKeysToElement/);
assert.match(content, /selectOptionOnElement/);
assert.match(content, /hoverElement/);
assert.match(content, /waitForCondition/);
assert.match(content, /idempotentNoop/);
assert.match(content, /function getOrCreateContentBlock/);
assert.match(content, /function buildInteractionTree/);
assert.match(content, /function buildScrollContext/);
assert.match(content, /function buildSnapshotDiff/);
assert.match(content, /function compileGroundedMarkdown/);
assert.match(content, /format:\s*'grounded-markdown-v1'/);
assert.match(content, /GET_GROUNDED_PAGE_INFO/);
assert.match(content, /contentBlockId/);
assert.match(content, /headingPath/);
assert.match(content, /agentRef/);
assert.match(content, /elementRegistry\.set\(agentRef/);
assert.match(content, /Agent 短引用已过期/);
assert.match(content, /source:\s*'agent-ref'/);

assert.match(popupHtml, /id="redactSensitiveDom"\s+checked/);
assert.match(popupHtml, /type="password"\s+id="vcpKey"/);
assert.match(popup, /result\.redactSensitiveDom\s*!==\s*false/);
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
assert.match(bridge, /当前页面 Grounded Markdown/);
assert.match(bridge, /function controlsManagedRuntime/);
assert.match(bridge, /touchManagedRuntimeForCommand/);
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
    'browser_status', 'type', 'click', 'scroll', 'get_page_info',
    'send_keys', 'set_value', 'select_option', 'hover', 'check', 'wait_for'
]) {
    assert(commandDescriptions.has(command), `缺少 manifest 指令说明: ${command}`);
}
assert.match(commandDescriptions.get('type'), /ACTION_VERIFICATION_FAILED/);
assert.match(commandDescriptions.get('scroll'), /SCROLL_BOUNDARY_REACHED/);

assert.match(commandDescriptions.get('hover'), /ELEMENT_OCCLUDED/);
assert.match(commandDescriptions.get('wait_for'), /dom_stable/);

console.log('ChromeBridge 操作增强脚本级冒烟检查通过');
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
    checkedJavaScriptFiles: 5
}, null, 2));
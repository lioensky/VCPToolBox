'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const files = {
    bridge: path.join(root, 'Plugin', 'ChromeBridge', 'ChromeBridge.js'),
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

for (const file of [files.bridge, files.background, files.content, files.popup]) {
    checkJavaScriptSyntax(file);
}

const pluginManifest = JSON.parse(read(files.pluginManifest));
const extensionManifest = JSON.parse(read(files.extensionManifest));
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
assert.match(background, /CDP_BACKEND_UNAVAILABLE/);
assert.match(background, /fallbackReason/);
assert.match(background, /unifiedPageGraph/);
assert.match(background, /groundedMarkdown/);
assert.match(background, /interactionTree/);
assert.match(background, /scrollContext/);
assert.match(background, /snapshotDiff/);

assert.match(content, /lastStableContentHash/);
assert.match(content, /lastStructureHash/);
assert.match(content, /buildStableSnapshotHashes/);
assert.match(content, /captureElementActionState/);
assert.match(content, /verifyInputAction/);
assert.match(content, /verifyClickAction/);
assert.match(content, /SCROLL_BOUNDARY_REACHED/);
assert.match(content, /SENSITIVE_FIELD_PATTERN/);
assert.match(content, /redactHtml/);
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

const bridge = read(files.bridge);
assert.match(bridge, /pageContentMarkdown/);
assert.match(bridge, /interactionTree/);
assert.match(bridge, /scrollContext/);
assert.match(bridge, /snapshotDiff/);
assert.match(bridge, /当前页面 Grounded Markdown/);

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
    fixture: path.relative(root, files.fixture),
    checkedJavaScriptFiles: 4
}, null, 2));
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');
const test = require('node:test');

const attachmentCollector = require('../modules/attachmentCollector.js');
const StreamHandler = require('../modules/handlers/streamHandler.js');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser.js');
const serverFileAttach = require('../Plugin/ServerFileAttach/ServerFileAttach.js');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-server-attach-'));
  const allowedRoot = path.join(root, 'allowed');
  const outsideRoot = path.join(root, 'outside');
  const cacheDir = path.join(root, 'cache');
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  const filePath = path.join(allowedRoot, 'report.txt');
  const outsidePath = path.join(outsideRoot, 'secret.txt');
  await fs.writeFile(filePath, 'hello attachment', 'utf8');
  await fs.writeFile(outsidePath, 'do not send', 'utf8');
  return { root, allowedRoot, cacheDir, filePath, outsidePath };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

test('ServerFileAttach registers a whitelisted file and serves it with auth', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  await serverFileAttach.initialize({
    ALLOWED_ATTACHMENT_ROOTS: fixture.allowedRoot,
    ATTACHMENT_CACHE_DIR: fixture.cacheDir,
    SERVER_ATTACHMENT_REQUIRE_AUTH: 'true',
    SERVER_ATTACHMENT_KEY: 'test-download-key',
    PROJECT_BASE_PATH: fixture.root
  });

  const result = await serverFileAttach.processToolCall({
    command: 'AttachFile',
    filePath: fixture.filePath,
    name: 'Readable Report.txt'
  });

  assert.equal(result.attachments.length, 1);
  const attachment = result.attachments[0];
  assert.equal(attachment.name, 'Readable Report.txt');
  assert.equal(attachment.type, 'text/plain; charset=utf-8');
  assert.equal(attachment.size, Buffer.byteLength('hello attachment'));
  assert.match(attachment.serverAttachmentId, /^att_/);
  assert.match(attachment.hash, /^sha256:/);
  assert.equal(fileURLToPath(attachment.src), fixture.filePath);
  assert.equal(attachment.downloadUrl, `/v1/attachments/${encodeURIComponent(attachment.serverAttachmentId)}`);

  const app = express();
  serverFileAttach.registerRoutes(app, {
    ALLOWED_ATTACHMENT_ROOTS: fixture.allowedRoot,
    ATTACHMENT_CACHE_DIR: fixture.cacheDir,
    SERVER_ATTACHMENT_REQUIRE_AUTH: 'true',
    SERVER_ATTACHMENT_KEY: 'test-download-key'
  }, fixture.root);
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const denied = await fetch(`${baseUrl}${attachment.downloadUrl}`);
  assert.equal(denied.status, 403);

  const downloaded = await fetch(`${baseUrl}${attachment.downloadUrl}`, {
    headers: { Authorization: 'Bearer test-download-key' }
  });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type'), /^text\/plain/);
  assert.equal(await downloaded.text(), 'hello attachment');
});

test('ServerFileAttach rejects paths outside allowed roots and changed sources', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  await serverFileAttach.initialize({
    ALLOWED_ATTACHMENT_ROOTS: fixture.allowedRoot,
    ATTACHMENT_CACHE_DIR: fixture.cacheDir,
    SERVER_ATTACHMENT_REQUIRE_AUTH: 'false',
    PROJECT_BASE_PATH: fixture.root
  });

  await assert.rejects(
    () => serverFileAttach.processToolCall({ command: 'AttachFile', filePath: fixture.outsidePath }),
    /outside allowed attachment roots/
  );

  const result = await serverFileAttach.processToolCall({
    command: 'AttachFile',
    filePath: fixture.filePath
  });
  const attachment = result.attachments[0];

  const app = express();
  serverFileAttach.registerRoutes(app, {
    ALLOWED_ATTACHMENT_ROOTS: fixture.allowedRoot,
    ATTACHMENT_CACHE_DIR: fixture.cacheDir,
    SERVER_ATTACHMENT_REQUIRE_AUTH: 'false'
  }, fixture.root);
  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  await fs.writeFile(fixture.filePath, 'tampered attachment', 'utf8');
  const response = await fetch(`${baseUrl}${attachment.downloadUrl}`);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /changed after registration/);
});

test('attachmentCollector normalizes attachment payloads for chat delivery', () => {
  const raw = {
    data: {
      vcp_attachments: [
        {
          serverAttachmentId: 'att_demo',
          name: 'demo.pdf',
          mimeType: 'application/pdf',
          size: '42',
          downloadUrl: '/v1/attachments/att_demo',
          sourceUrl: 'file:///D:/demo.pdf'
        }
      ]
    }
  };

  const attachments = attachmentCollector.collectAttachmentsFromRaw(raw);
  assert.deepEqual(attachments, [{
    serverAttachmentId: 'att_demo',
    name: 'demo.pdf',
    type: 'application/pdf',
    size: 42,
    src: 'file:///D:/demo.pdf',
    hash: undefined,
    downloadUrl: '/v1/attachments/att_demo',
    disposition: 'download',
    createdAt: undefined,
    expiresAt: undefined
  }]);

  const chunk = attachmentCollector.buildAttachmentChunk({
    model: 'test-model',
    attachments
  });
  assert.equal(chunk.object, 'vcp.attachment.chunk');
  assert.equal(chunk.vcp_attachments[0].serverAttachmentId, 'att_demo');
});

test('ServerFileAttach manifest exposes a parseable VCP tool call example', async () => {
  const manifestPath = path.join(__dirname, '..', 'Plugin', 'ServerFileAttach', 'plugin-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const description = manifest.capabilities.invocationCommands[0].description;
  const example = description.slice(description.indexOf('<<<[TOOL_REQUEST]>>>'));
  const parsed = ToolCallParser.parse(example);

  assert.equal(manifest.pluginType, 'hybridservice');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'ServerFileAttach');
  assert.equal(parsed[0].args.command, 'AttachFile');
  assert.equal(parsed[0].args.filePath, 'file/report.pdf');
});

test('stream handler emits vcp.attachment.chunk after a tool result with attachments', async () => {
  const toolRequest = [
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」ServerFileAttach「末」,',
    'command:「始」AttachFile「末」,',
    'filePath:「始」file/report.pdf「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const attachment = {
    serverAttachmentId: 'att_stream',
    name: 'stream.txt',
    type: 'text/plain',
    size: 12,
    src: 'file:///D:/VCP/VCPToolBox/file/stream.txt',
    hash: 'sha256:abc',
    downloadUrl: '/v1/attachments/att_stream',
    disposition: 'download'
  };

  const writes = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write(chunk, callback) {
      writes.push(String(chunk));
      if (typeof callback === 'function') callback();
      return true;
    },
    end() {
      this.writableEnded = true;
    }
  };

  function streamFromText(text) {
    return { ok: true, body: Readable.from([text]) };
  }

  const handler = new StreamHandler({
    apiUrl: 'http://upstream.test',
    apiKey: 'upstream-key',
    pluginManager: {},
    writeChatLog: null,
    handleDiaryFromAIResponse: async () => {},
    DEBUG_MODE: false,
    SHOW_VCP_OUTPUT: false,
    maxVCPLoopStream: 3,
    apiRetries: 0,
    apiRetryDelay: 0,
    RAGMemoRefresh: false,
    enableRoleDivider: false,
    enableRoleDividerInLoop: false,
    roleDividerIgnoreList: [],
    roleDividerSwitches: {},
    roleDividerScanSwitches: {},
    roleDividerRemoveDisabledTags: false,
    toolExecutor: {
      async executeAll() {
        return [{
          success: true,
          content: [{ type: 'text', text: 'Attachment ready.' }],
          raw: { attachments: [attachment] }
        }];
      }
    },
    ToolCallParser,
    abortController: new AbortController(),
    originalBody: {
      model: 'test-model',
      requestId: 'stream-attachment-test',
      messages: [{ role: 'user', content: 'send file' }]
    },
    clientIp: '127.0.0.1',
    _refreshRagBlocksIfNeeded: async messages => messages,
    fetchWithRetry: async () => streamFromText('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
  });

  await handler.handle(
    {},
    res,
    streamFromText(`data: ${JSON.stringify({ choices: [{ delta: { content: toolRequest } }] })}\n\n`)
  );

  const output = writes.join('');
  assert.match(output, /"object":"vcp\.attachment\.chunk"/);
  assert.match(output, /"serverAttachmentId":"att_stream"/);
  assert.match(output, /data: \[DONE\]/);
});

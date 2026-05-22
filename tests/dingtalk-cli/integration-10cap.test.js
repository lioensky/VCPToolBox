const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { DingTalkCLIRuntime } = require('../../Plugin/DingTalkCLI/lib/runtime');

const PRODUCTS = [
  'aitable',
  'calendar',
  'chat',
  'ding',
  'contact',
  'todo',
  'report',
  'attendance',
  'devdoc',
  'workbench'
];

function buildRuntime(tempDir, calls) {
  const executor = {
    async runCommand(args) {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true }),
        stderr: '',
        durationMs: 10
      };
    },
    async checkHealth() {
      return { ok: true, version: '1.0.8', requiredVersion: '1.0.8' };
    }
  };

  const schemaDiscoverer = {
    async getSchemaTool() {
      return {
        status: 'success',
        result: { schema: { required: [] } }
      };
    },
    async listSchema() {
      return {
        status: 'success',
        result: { source: 'cache', schema: { tools: [], products: {} }, degraded: false }
      };
    }
  };

  return new DingTalkCLIRuntime({
    config: {
      projectBasePath: tempDir,
      pluginBasePath: path.join(tempDir, 'Plugin', 'DingTalkCLI'),
      dwsBin: 'dws',
      dwsMinVersion: '1.0.8',
      authMode: 'auto',
      dwsClientId: '',
      dwsClientSecret: '',
      trustedDomains: [],
      grayStage: 'full_write',
      timeoutMs: 30000,
      schemaCacheTtlMs: 30000,
      maxArgBytes: 1024 * 32,
      batchLimit: 100,
      debug: false,
      auditLogPath: path.join(tempDir, 'audit.jsonl'),
      cachePath: path.join(tempDir, 'schema-cache.json'),
      workflowStateDir: path.join(tempDir, 'wf')
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    executor,
    schemaDiscoverer
  });
}

test('integration simulation should cover query and write paths for all 10 products', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dws-int-test-'));
  const calls = [];

  try {
    const runtime = buildRuntime(tempDir, calls);

    for (const product of PRODUCTS) {
      const query = await runtime.handleRequest({
        action: 'execute_tool',
        product,
        tool: 'list_items',
        args: { q: 'x' }
      });
      assert.equal(query.status, 'success');

      const writeDryRun = await runtime.handleRequest({
        action: 'execute_tool',
        product,
        tool: 'create_item',
        args: { title: 'x' },
        apply: false
      });
      assert.equal(writeDryRun.status, 'success');

      const writeApply = await runtime.handleRequest({
        action: 'execute_tool',
        product,
        tool: 'create_item',
        args: { title: 'x' },
        apply: true
      });
      assert.equal(writeApply.status, 'success');
    }

    assert.equal(calls.length, PRODUCTS.length * 3);

    for (let i = 0; i < calls.length; i += 3) {
      const queryArgs = calls[i];
      const dryRunArgs = calls[i + 1];
      const applyArgs = calls[i + 2];

      assert.equal(queryArgs.includes('--dry-run'), false);
      assert.equal(dryRunArgs.includes('--dry-run'), true);
      assert.equal(applyArgs.includes('--dry-run'), false);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

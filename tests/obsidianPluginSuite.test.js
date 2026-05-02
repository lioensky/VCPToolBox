const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const pluginRoot = path.join(__dirname, '..', 'Plugin');

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-obsidian-test-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'Daily'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Daily', 'today.md'),
    '# Today\n\nProject architecture note. [[Index]] #work\n',
    'utf8'
  );
  fs.writeFileSync(path.join(vault, 'Index.md'), '# Index\n\nBacklink target.\n', 'utf8');
  return { root, vault };
}

function runNodePlugin(pluginName, scriptName, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptName], {
      cwd: path.join(pluginRoot, pluginName),
      env: { ...process.env, ...env },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const firstLine = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
        resolve({ code, parsed: JSON.parse(firstLine), stdout, stderr });
      } catch (error) {
        reject(new Error(`Failed to parse ${pluginName} output: ${error.message}\n${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('Obsidian plugin suite direct workflow', async () => {
  const { root, vault } = makeVault();
  const stateDir = path.join(root, 'state');
  const auditLog = path.join(root, 'audit.jsonl');

  const core = require(path.join(pluginRoot, 'ObsidianCoreGateway', 'ObsidianCoreGateway.js'));
  await core.initialize({
    OBSIDIAN_VAULT_DIR: vault,
    OBSIDIAN_ALLOWED_VAULTS: vault,
    OBSIDIAN_BACKUP_BEFORE_WRITE: 'true'
  });

  let result = await core.processToolCall({ command: 'ReadNote', notePath: 'Daily/today.md' });
  assert.match(result.content[0].text, /Project architecture/);

  result = await core.processToolCall({
    command: 'AppendNote',
    notePath: 'Daily/today.md',
    content: 'Additional line.'
  });
  assert.strictEqual(result.details.command, 'AppendNote');

  result = await core.processToolCall({
    command: 'ReplaceInNote',
    notePath: 'Daily/today.md',
    searchText: 'Additional line.',
    replaceText: 'Flow updated.'
  });
  assert.strictEqual(result.details.replacements, 1);

  const prompt = require(path.join(pluginRoot, 'ObsidianPromptPreprocessor', 'ObsidianPromptPreprocessor.js'));
  const messages = await prompt.processMessages([{ role: 'user', content: 'hello' }], {
    OBSIDIAN_VAULT_DIR: vault,
    OBSIDIAN_ACTIVE_NOTE: 'Daily/today.md'
  });
  assert.match(messages[0].content, /<ObsidianContext>/);

  const human = require(path.join(pluginRoot, 'ObsidianHumanGateway', 'ObsidianHumanGateway.js'));
  result = await human.processToolCall({
    action: 'WriteNoteAtomic',
    target: 'Daily/today.md',
    riskLevel: 'high'
  });
  assert.strictEqual(result.details.status, 'pending');

  let stdio = await runNodePlugin(
    'ObsidianVaultMemory',
    'ObsidianVaultMemory.js',
    { command: 'SearchNotes', query: 'architecture' },
    { OBSIDIAN_VAULT_DIR: vault, OBSIDIAN_ALLOWED_VAULTS: vault }
  );
  assert.strictEqual(stdio.parsed.status, 'success');
  assert.strictEqual(stdio.parsed.result.details.results[0].notePath, 'Daily/today.md');

  stdio = await runNodePlugin(
    'ObsidianSafetyAudit',
    'ObsidianSafetyAudit.js',
    { command: 'AssessAction', action: 'WriteNoteAtomic', notePath: 'Daily/today.md' },
    { OBSIDIAN_AUDIT_LOG_PATH: auditLog }
  );
  assert.strictEqual(stdio.parsed.result.details.decision, 'approval_required');
  assert.ok(fs.existsSync(auditLog));

  stdio = await runNodePlugin(
    'ObsidianAsyncWorker',
    'ObsidianAsyncWorker.js',
    { command: 'GenerateVaultReport', taskId: 'obsidian-suite-test' },
    {
      OBSIDIAN_VAULT_DIR: vault,
      OBSIDIAN_ALLOWED_VAULTS: vault,
      OBSIDIAN_ASYNC_STATE_DIR: stateDir
    }
  );
  assert.strictEqual(stdio.parsed.status, 'success');
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'obsidian-suite-test.json'), 'utf8'));
  assert.strictEqual(state.status, 'completed');
});

test('ObsidianSessionSensor emits dynamic fold payload', { skip: process.platform !== 'win32' }, async () => {
  const { vault } = makeVault();

  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-File', path.join(pluginRoot, 'ObsidianSessionSensor', 'sensor.ps1')],
      {
        env: { ...process.env, OBSIDIAN_VAULT_DIR: vault, OBSIDIAN_SENSOR_LIMIT: '3' },
        windowsHide: true
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `sensor exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });

  const payload = JSON.parse(output);
  assert.strictEqual(payload.vcp_dynamic_fold, true);
  assert.strictEqual(payload.fold_name, 'ObsidianSession');
  assert.match(payload.fold_blocks[0].content, /Recent notes/);
});

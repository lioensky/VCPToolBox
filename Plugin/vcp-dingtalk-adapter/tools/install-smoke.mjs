import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function run(cmd, args = [], options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

async function tryImportSdk() {
  const candidates = [
    'dingtalk-stream',
    '@dingtalk-stream/sdk-nodejs',
  ];

  let lastError = null;

  for (const name of candidates) {
    try {
      const mod = await import(name);
      console.log('[STEP] SDK_IMPORT_OK =>', name);
      console.log('[STEP] EXPORT_KEYS =>', Object.keys(mod).slice(0, 20));
      return;
    } catch (error) {
      lastError = error;
      console.log('[WARN] import failed =>', name, error?.message || error);
    }
  }

  throw lastError || new Error('No DingTalk Stream SDK can be imported');
}

async function main() {
  process.chdir(projectRoot);
  console.log('[STEP] cwd =>', process.cwd());

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  console.log('[STEP] npm install');
  await run(npmCmd, ['install']);

  const files = [
    'src/index.js',
    'src/adapters/dingtalk/streamReceiver.js',
    'src/adapters/dingtalk/sender.js',
    'src/adapters/vcp/client.js',
    'src/core/normalizer.js',
    'src/core/pipeline.js',
  ];

  for (const file of files) {
    console.log('[STEP] node --check', file);
    await run(process.execPath, ['--check', file]);
  }

  console.log('[STEP] import stream sdk');
  await tryImportSdk();

  console.log('[DONE] install + smoke test ok');
}

main().catch((error) => {
  console.error('[FAIL]', error);
  process.exit(1);
});
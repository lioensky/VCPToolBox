const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function nowIso() {
  return new Date().toISOString();
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getConfig() {
  const primaryVault = String(process.env.OBSIDIAN_VAULT_DIR || '').trim();
  const configuredVaults = String(process.env.OBSIDIAN_ALLOWED_VAULTS || '')
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  const allowedVaults = [...configuredVaults];
  if (primaryVault) allowedVaults.unshift(primaryVault);

  return {
    primaryVault,
    allowedVaults: [...new Set(allowedVaults.map(item => path.resolve(item)))],
    stateDir: process.env.OBSIDIAN_ASYNC_STATE_DIR
      ? path.resolve(process.env.OBSIDIAN_ASYNC_STATE_DIR)
      : path.join(__dirname, 'state'),
    maxFileSize: parseInteger(process.env.OBSIDIAN_ASYNC_MAX_FILE_SIZE, 1024 * 1024),
    callbackBaseUrl: process.env.CALLBACK_BASE_URL || '',
    pluginName: process.env.PLUGIN_NAME_FOR_CALLBACK || 'ObsidianAsyncWorker'
  };
}

function ensureVaultConfig(config) {
  if (!config.primaryVault) {
    throw new Error('OBSIDIAN_VAULT_DIR is required.');
  }
}

function isInsideRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveVaultRoot(config) {
  ensureVaultConfig(config);
  const root = path.resolve(config.primaryVault);
  const allowed = config.allowedVaults.some(allowedRoot => isInsideRoot(root, allowedRoot));
  if (!allowed) {
    throw new Error(`Vault root is outside allowed Obsidian vaults: ${root}`);
  }
  return root;
}

async function walkMarkdownFiles(rootPath, config, output = []) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obsidian' || entry.name === '.trash') continue;
    const itemPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownFiles(itemPath, config, output);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const stats = await fsp.stat(itemPath);
    if (stats.size <= config.maxFileSize) {
      output.push({ path: itemPath, stats });
    }
  }
  return output;
}

function relativeNotePath(filePath, config) {
  return path.relative(path.resolve(config.primaryVault), filePath).replace(/\\/g, '/');
}

async function writeTaskState(config, taskId, state) {
  await fsp.mkdir(config.stateDir, { recursive: true });
  const statePath = path.join(config.stateDir, `${taskId}.json`);
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  return statePath;
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const client = url.startsWith('https:') ? https : http;
    const request = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function sendCallback(config, taskId, status, result) {
  if (!config.callbackBaseUrl) return;
  const base = config.callbackBaseUrl.replace(/\/$/, '');
  const callbackUrl = base.includes('/plugin-callback')
    ? `${base}/${config.pluginName}/${taskId}`
    : `${base}/plugin-callback/${config.pluginName}/${taskId}`;
  await postJson(callbackUrl, { requestId: taskId, status, result });
}

function extractTags(content) {
  const tags = new Set();
  const tagMatches = content.match(/#[\p{L}\p{N}_/-]+/gu) || [];
  for (const tag of tagMatches) tags.add(tag);
  return tags;
}

function extractWikiLinks(content) {
  const links = new Set();
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.add(match[1].trim());
  }
  return links;
}

async function generateVaultReport(config, taskId, taskName) {
  const root = resolveVaultRoot(config);
  const files = await walkMarkdownFiles(root, config);
  const tags = new Set();
  const links = new Set();
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.stats.size;
    const content = await fsp.readFile(file.path, 'utf8');
    for (const tag of extractTags(content)) tags.add(tag);
    for (const link of extractWikiLinks(content)) links.add(link);
  }

  const recentNotes = files
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .slice(0, 10)
    .map(file => ({
      notePath: relativeNotePath(file.path, config),
      size: file.stats.size,
      lastModified: file.stats.mtime.toISOString()
    }));

  return {
    taskId,
    taskName,
    status: 'completed',
    completedAt: nowIso(),
    summary: {
      noteCount: files.length,
      totalBytes,
      tagCount: tags.size,
      linkTargetCount: links.size
    },
    recentNotes,
    tags: Array.from(tags).sort().slice(0, 100),
    linkTargets: Array.from(links).sort().slice(0, 100)
  };
}

async function runTask(args, config, taskId) {
  const taskName = args.taskName || 'Obsidian vault report';
  const started = {
    taskId,
    taskName,
    status: 'running',
    startedAt: nowIso()
  };
  await writeTaskState(config, taskId, started);

  try {
    const result = await generateVaultReport(config, taskId, taskName);
    result.statePath = await writeTaskState(config, taskId, result);
    await sendCallback(config, taskId, 'success', result).catch(() => {});
  } catch (error) {
    const failed = {
      taskId,
      taskName,
      status: 'failed',
      completedAt: nowIso(),
      error: error.message
    };
    failed.statePath = await writeTaskState(config, taskId, failed);
    await sendCallback(config, taskId, 'error', failed).catch(() => {});
  }
}

function initialResponse(taskId, args, config) {
  const statePath = path.join(config.stateDir, `${taskId}.json`);
  return {
    status: 'success',
    result: {
      content: [
        {
          type: 'text',
          text: `Obsidian async task queued: ${taskId}\n\nTask: ${args.taskName || 'Obsidian vault report'}\nState: ${statePath}`
        }
      ],
      details: {
        taskId,
        status: 'queued',
        statePath,
        command: args.command || 'GenerateVaultReport'
      }
    }
  };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
  });

  process.stdin.on('end', async () => {
    try {
      const args = input.trim() ? JSON.parse(input.replace(/^\uFEFF+/, '')) : {};
      const command = args.command || 'GenerateVaultReport';
      if (command !== 'GenerateVaultReport') {
        throw new Error(`Unknown ObsidianAsyncWorker command: ${command}`);
      }

      const config = getConfig();
      const taskId = args.taskId || `obsidian-async-${crypto.randomUUID()}`;
      console.log(JSON.stringify(initialResponse(taskId, args, config)));
      setImmediate(() => {
        runTask(args, config, taskId).finally(() => {
          process.exit(0);
        });
      });
    } catch (error) {
      console.log(JSON.stringify({ status: 'error', error: error.message }));
      process.exit(1);
    }
  });
}

main();

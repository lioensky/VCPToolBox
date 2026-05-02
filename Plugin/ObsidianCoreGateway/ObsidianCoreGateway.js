const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

let injectedConfig = {};

function textContent(text, details = {}) {
  return {
    content: [{ type: 'text', text }],
    details
  };
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readConfigValue(key, defaultValue = '') {
  const value = injectedConfig[key] !== undefined ? injectedConfig[key] : process.env[key];
  return value === undefined || value === null ? defaultValue : value;
}

function getConfig() {
  const primaryVault = String(readConfigValue('OBSIDIAN_VAULT_DIR')).trim();
  const configuredVaults = String(readConfigValue('OBSIDIAN_ALLOWED_VAULTS'))
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  const allowedVaults = [...configuredVaults];
  if (primaryVault) allowedVaults.unshift(primaryVault);

  return {
    primaryVault,
    allowedVaults: [...new Set(allowedVaults.map(item => path.resolve(item)))],
    cliCommand: String(readConfigValue('OBSIDIAN_CLI_COMMAND')).trim(),
    cliOpenArgs: String(readConfigValue('OBSIDIAN_CLI_OPEN_ARGS', '{path}')).trim(),
    backupBeforeWrite: parseBoolean(readConfigValue('OBSIDIAN_BACKUP_BEFORE_WRITE'), false)
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

function resolveNotePath(notePath, config) {
  ensureVaultConfig(config);
  if (!notePath || typeof notePath !== 'string') {
    throw new Error('notePath is required.');
  }

  const rawPath = notePath.trim();
  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(config.primaryVault, rawPath);

  const allowed = config.allowedVaults.some(root => isInsideRoot(absolutePath, root));
  if (!allowed) {
    throw new Error(`Path is outside allowed Obsidian vaults: ${absolutePath}`);
  }

  if (path.extname(absolutePath).toLowerCase() !== '.md') {
    throw new Error('Only markdown note files (.md) are supported by the core gateway.');
  }

  return absolutePath;
}

async function readNote(args, config) {
  const filePath = resolveNotePath(args.notePath, config);
  const content = await fsp.readFile(filePath, 'utf8');
  const stats = await fsp.stat(filePath);
  return textContent(content, {
    command: 'ReadNote',
    path: filePath,
    size: stats.size,
    lastModified: stats.mtime.toISOString()
  });
}

async function ensureParentDirectory(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function backupIfNeeded(filePath, config) {
  if (!config.backupBeforeWrite || !fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak`;
  await fsp.copyFile(filePath, backupPath);
  return backupPath;
}

async function writeAtomic(filePath, content) {
  await ensureParentDirectory(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.vcp-tmp-${process.pid}-${Date.now()}`
  );
  await fsp.writeFile(tempPath, content, 'utf8');
  await fsp.rename(tempPath, filePath);
}

async function writeNoteAtomic(args, config) {
  const filePath = resolveNotePath(args.notePath, config);
  const createIfMissing = parseBoolean(args.createIfMissing, true);
  if (!createIfMissing && !fs.existsSync(filePath)) {
    throw new Error(`Note does not exist: ${filePath}`);
  }
  if (typeof args.content !== 'string') {
    throw new Error('content must be a string.');
  }

  const backupPath = await backupIfNeeded(filePath, config);
  await writeAtomic(filePath, args.content);
  const stats = await fsp.stat(filePath);
  return textContent(`Obsidian note written atomically: ${filePath}`, {
    command: 'WriteNoteAtomic',
    path: filePath,
    backupPath,
    size: stats.size,
    lastModified: stats.mtime.toISOString()
  });
}

async function appendNote(args, config) {
  const filePath = resolveNotePath(args.notePath, config);
  if (typeof args.content !== 'string') {
    throw new Error('content must be a string.');
  }

  let current = '';
  if (fs.existsSync(filePath)) {
    current = await fsp.readFile(filePath, 'utf8');
  }

  const separator = current && !current.endsWith('\n') ? '\n' : '';
  const nextContent = `${current}${separator}${args.content}`;
  const backupPath = await backupIfNeeded(filePath, config);
  await writeAtomic(filePath, nextContent);
  return textContent(`Content appended to Obsidian note: ${filePath}`, {
    command: 'AppendNote',
    path: filePath,
    backupPath
  });
}

async function replaceInNote(args, config) {
  const filePath = resolveNotePath(args.notePath, config);
  if (typeof args.searchText !== 'string' || args.searchText.length === 0) {
    throw new Error('searchText must be a non-empty string.');
  }
  if (typeof args.replaceText !== 'string') {
    throw new Error('replaceText must be a string.');
  }

  const current = await fsp.readFile(filePath, 'utf8');
  const matches = current.split(args.searchText).length - 1;
  const allowMultiple = parseBoolean(args.allowMultiple, false);
  if (matches === 0) {
    throw new Error('searchText was not found in the note.');
  }
  if (matches > 1 && !allowMultiple) {
    throw new Error(`searchText matched ${matches} times. Set allowMultiple=true to replace all matches.`);
  }

  const nextContent = current.split(args.searchText).join(args.replaceText);
  const backupPath = await backupIfNeeded(filePath, config);
  await writeAtomic(filePath, nextContent);
  return textContent(`Exact replacement applied to Obsidian note: ${filePath}`, {
    command: 'ReplaceInNote',
    path: filePath,
    replacements: matches,
    backupPath
  });
}

function quoteForShell(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function openNote(args, config) {
  const filePath = resolveNotePath(args.notePath, config);
  if (!config.cliCommand) {
    return textContent('OpenNote skipped because OBSIDIAN_CLI_COMMAND is not configured.', {
      command: 'OpenNote',
      path: filePath,
      skipped: true
    });
  }

  const renderedArgs = config.cliOpenArgs.replace('{path}', quoteForShell(filePath));
  const commandLine = `${config.cliCommand} ${renderedArgs}`.trim();

  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      shell: true,
      windowsHide: true,
      cwd: config.primaryVault
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Obsidian CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(textContent(`OpenNote command submitted for: ${filePath}`, {
        command: 'OpenNote',
        path: filePath,
        cliCommand: commandLine
      }));
    });
  });
}

async function processToolCall(args = {}) {
  const config = getConfig();
  const command = args.command || args.action || 'ReadNote';

  switch (command) {
    case 'ReadNote':
      return readNote(args, config);
    case 'WriteNoteAtomic':
      return writeNoteAtomic(args, config);
    case 'AppendNote':
      return appendNote(args, config);
    case 'ReplaceInNote':
      return replaceInNote(args, config);
    case 'OpenNote':
      return openNote(args, config);
    default:
      throw new Error(`Unknown ObsidianCoreGateway command: ${command}`);
  }
}

async function initialize(pluginConfig = {}) {
  injectedConfig = { ...pluginConfig };
}

function cleanup() {}

module.exports = { initialize, processToolCall, cleanup };

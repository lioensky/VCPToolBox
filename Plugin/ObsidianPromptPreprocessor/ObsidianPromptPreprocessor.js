const fs = require('fs').promises;
const path = require('path');

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getConfig(config = {}) {
  const primaryVault = String(config.OBSIDIAN_VAULT_DIR || process.env.OBSIDIAN_VAULT_DIR || '').trim();
  const configuredVaults = String(config.OBSIDIAN_ALLOWED_VAULTS || process.env.OBSIDIAN_ALLOWED_VAULTS || '')
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  const allowedVaults = [...configuredVaults];
  if (primaryVault) allowedVaults.unshift(primaryVault);

  return {
    primaryVault,
    allowedVaults: [...new Set(allowedVaults.map(item => path.resolve(item)))],
    activeNote: String(config.OBSIDIAN_ACTIVE_NOTE || process.env.OBSIDIAN_ACTIVE_NOTE || '').trim(),
    contextNotes: String(config.OBSIDIAN_CONTEXT_NOTES || process.env.OBSIDIAN_CONTEXT_NOTES || '')
      .split(';')
      .map(item => item.trim())
      .filter(Boolean),
    maxChars: parseInteger(config.OBSIDIAN_CONTEXT_MAX_CHARS || process.env.OBSIDIAN_CONTEXT_MAX_CHARS, 4000),
    enabled: parseBoolean(config.OBSIDIAN_PREPROCESSOR_ENABLED, true)
  };
}

function isInsideRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveNotePath(notePath, config) {
  if (!config.primaryVault) {
    throw new Error('OBSIDIAN_VAULT_DIR is required for Obsidian context injection.');
  }
  const absolutePath = path.isAbsolute(notePath)
    ? path.resolve(notePath)
    : path.resolve(config.primaryVault, notePath);

  const allowed = config.allowedVaults.some(root => isInsideRoot(absolutePath, root));
  if (!allowed) {
    throw new Error(`Context note is outside allowed Obsidian vaults: ${absolutePath}`);
  }
  if (path.extname(absolutePath).toLowerCase() !== '.md') {
    throw new Error(`Context note must be markdown: ${absolutePath}`);
  }
  return absolutePath;
}

function relativeNotePath(filePath, config) {
  return path.relative(path.resolve(config.primaryVault), filePath).replace(/\\/g, '/');
}

async function readContextNote(notePath, config, remainingChars) {
  const absolutePath = resolveNotePath(notePath, config);
  const content = await fs.readFile(absolutePath, 'utf8');
  const trimmed = content.length > remainingChars
    ? `${content.slice(0, Math.max(0, remainingChars - 32)).trimEnd()}\n...[truncated]`
    : content;

  return {
    notePath: relativeNotePath(absolutePath, config),
    content: trimmed
  };
}

function uniqueNotes(config) {
  const notes = [];
  if (config.activeNote) notes.push(config.activeNote);
  notes.push(...config.contextNotes);
  return [...new Set(notes)];
}

function appendSystemContext(messages, contextBlock) {
  const nextMessages = JSON.parse(JSON.stringify(messages));
  const systemIndex = nextMessages.findIndex(message => message.role === 'system' && typeof message.content === 'string');
  if (systemIndex >= 0) {
    nextMessages[systemIndex].content = `${nextMessages[systemIndex].content}\n\n${contextBlock}`;
  } else {
    nextMessages.unshift({ role: 'system', content: contextBlock });
  }
  return nextMessages;
}

async function buildContextBlock(config) {
  const notes = uniqueNotes(config);
  if (notes.length === 0) return '';

  const sections = [];
  let remainingChars = config.maxChars;
  for (const note of notes) {
    if (remainingChars <= 0) break;
    try {
      const item = await readContextNote(note, config, remainingChars);
      const section = `### ${item.notePath}\n\n${item.content}`;
      sections.push(section);
      remainingChars -= section.length;
    } catch (error) {
      const section = `### ${note}\n\n[Obsidian context unavailable: ${error.message}]`;
      sections.push(section);
      remainingChars -= section.length;
    }
  }

  if (sections.length === 0) return '';
  return [
    '<ObsidianContext>',
    'The following Obsidian notes are provided as read-only context. Do not assume permission to edit them unless a tool call is explicitly approved.',
    '',
    ...sections,
    '</ObsidianContext>'
  ].join('\n');
}

async function processMessages(messages, pluginConfig = {}) {
  if (!Array.isArray(messages)) return messages;
  const config = getConfig(pluginConfig);
  if (!config.enabled) return messages;

  const contextBlock = await buildContextBlock(config);
  if (!contextBlock) return messages;
  return appendSystemContext(messages, contextBlock);
}

module.exports = { processMessages };

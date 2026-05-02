const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

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
    searchLimit: parseInteger(process.env.OBSIDIAN_SEARCH_LIMIT, 10),
    maxFileSize: parseInteger(process.env.OBSIDIAN_MAX_FILE_SIZE, 1024 * 1024)
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

function resolveVaultPath(inputPath, config) {
  ensureVaultConfig(config);
  const rawPath = String(inputPath || '').trim();
  const absolutePath = rawPath
    ? (path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(config.primaryVault, rawPath))
    : path.resolve(config.primaryVault);

  const allowed = config.allowedVaults.some(root => isInsideRoot(absolutePath, root));
  if (!allowed) {
    throw new Error(`Path is outside allowed Obsidian vaults: ${absolutePath}`);
  }
  return absolutePath;
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

function makeSnippet(content, index, needleLength) {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + needleLength + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function scoreMatch(relativePath, content, query) {
  const lowerQuery = query.toLowerCase();
  const lowerPath = relativePath.toLowerCase();
  const lowerContent = content.toLowerCase();
  let score = 0;
  if (lowerPath.includes(lowerQuery)) score += 25;
  const firstIndex = lowerContent.indexOf(lowerQuery);
  if (firstIndex >= 0) score += 50;

  let count = 0;
  let cursor = firstIndex;
  while (cursor >= 0) {
    count += 1;
    cursor = lowerContent.indexOf(lowerQuery, cursor + lowerQuery.length);
  }
  score += Math.min(count * 5, 50);
  return { score, firstIndex, count };
}

function toMarkdownTable(results, title) {
  if (results.length === 0) {
    return `${title}\n\nNo matching notes found.`;
  }

  const rows = results.map(item => {
    const snippet = item.snippet ? item.snippet.replace(/\|/g, '\\|') : '';
    return `| ${item.rank} | ${item.notePath.replace(/\|/g, '\\|')} | ${item.score || ''} | ${snippet} |`;
  });

  return [
    title,
    '',
    '| # | Note | Score | Snippet |',
    '|---:|---|---:|---|',
    ...rows
  ].join('\n');
}

async function searchNotes(args, config) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required.');

  const maxResults = parseInteger(args.maxResults, config.searchLimit);
  const root = resolveVaultPath(args.searchPath || '', config);
  const files = await walkMarkdownFiles(root, config);
  const matches = [];

  for (const file of files) {
    const content = await fsp.readFile(file.path, 'utf8');
    const notePath = relativeNotePath(file.path, config);
    const match = scoreMatch(notePath, content, query);
    if (match.score <= 0) continue;
    matches.push({
      notePath,
      absolutePath: file.path,
      score: match.score,
      matchCount: match.count,
      snippet: makeSnippet(content, match.firstIndex >= 0 ? match.firstIndex : 0, query.length),
      lastModified: file.stats.mtime.toISOString()
    });
  }

  matches.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount || a.notePath.localeCompare(b.notePath));
  const results = matches.slice(0, maxResults).map((item, index) => ({ rank: index + 1, ...item }));
  return {
    content: [{ type: 'text', text: toMarkdownTable(results, `Obsidian search results for "${query}"`) }],
    details: { command: 'SearchNotes', query, totalMatches: matches.length, results }
  };
}

function backlinkCandidates(target) {
  const normalized = String(target || '').trim().replace(/\\/g, '/');
  const withoutExt = normalized.replace(/\.md$/i, '');
  const title = path.basename(withoutExt);
  return [...new Set([
    `[[${withoutExt}]]`,
    `[[${withoutExt}|`,
    `[[${title}]]`,
    `[[${title}|`,
    `](${normalized})`,
    `](${withoutExt}.md)`,
    `](${title}.md)`
  ])].filter(item => item.length > 4);
}

async function getBacklinks(args, config) {
  const target = String(args.target || '').trim();
  if (!target) throw new Error('target is required.');

  const maxResults = parseInteger(args.maxResults, config.searchLimit);
  const candidates = backlinkCandidates(target).map(item => item.toLowerCase());
  const files = await walkMarkdownFiles(resolveVaultPath('', config), config);
  const matches = [];

  for (const file of files) {
    const content = await fsp.readFile(file.path, 'utf8');
    const lowerContent = content.toLowerCase();
    const found = candidates.find(candidate => lowerContent.includes(candidate));
    if (!found) continue;
    const index = lowerContent.indexOf(found);
    matches.push({
      notePath: relativeNotePath(file.path, config),
      absolutePath: file.path,
      score: 100,
      snippet: makeSnippet(content, index, found.length),
      lastModified: file.stats.mtime.toISOString()
    });
  }

  matches.sort((a, b) => a.notePath.localeCompare(b.notePath));
  const results = matches.slice(0, maxResults).map((item, index) => ({ rank: index + 1, ...item }));
  return {
    content: [{ type: 'text', text: toMarkdownTable(results, `Obsidian backlinks for "${target}"`) }],
    details: { command: 'GetBacklinks', target, totalMatches: matches.length, results }
  };
}

async function listRecentNotes(args, config) {
  const maxResults = parseInteger(args.maxResults, config.searchLimit);
  const files = await walkMarkdownFiles(resolveVaultPath(args.searchPath || '', config), config);
  const results = files
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .slice(0, maxResults)
    .map((item, index) => ({
      rank: index + 1,
      notePath: relativeNotePath(item.path, config),
      absolutePath: item.path,
      size: item.stats.size,
      lastModified: item.stats.mtime.toISOString()
    }));

  const text = results.length === 0
    ? 'Recent Obsidian notes\n\nNo markdown notes found.'
    : [
        'Recent Obsidian notes',
        '',
        '| # | Note | Size | Modified |',
        '|---:|---|---:|---|',
        ...results.map(item => `| ${item.rank} | ${item.notePath.replace(/\|/g, '\\|')} | ${item.size} | ${item.lastModified} |`)
      ].join('\n');

  return {
    content: [{ type: 'text', text }],
    details: { command: 'ListRecentNotes', results }
  };
}

async function processRequest(args = {}) {
  const config = getConfig();
  const command = args.command || 'SearchNotes';

  switch (command) {
    case 'SearchNotes':
      return searchNotes(args, config);
    case 'GetBacklinks':
      return getBacklinks(args, config);
    case 'ListRecentNotes':
      return listRecentNotes(args, config);
    default:
      throw new Error(`Unknown ObsidianVaultMemory command: ${command}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  const lines = data.toString().trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const request = JSON.parse(line);
      const result = await processRequest(request);
      console.log(JSON.stringify({ status: 'success', result }));
    } catch (error) {
      console.log(JSON.stringify({ status: 'error', error: error.message }));
    }
  }
});

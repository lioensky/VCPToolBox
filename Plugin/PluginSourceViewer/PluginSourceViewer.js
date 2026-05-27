const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const MANIFEST_NAME = 'plugin-manifest.json';

const IGNORED_TREE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'target',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  '.env',
  'vendor',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'Debug',
  'Release'
]);

const BINARY_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.bin',
  '.wasm',
  '.pyd',
  '.class',
  '.jar',
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.gz',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.sqlite',
  '.db'
]);

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.json',
  '.jsonc',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env',
  '.html',
  '.css',
  '.scss',
  '.xml',
  '.sql'
]);

const RUNNER_COMMANDS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'py',
  'deno',
  'bun',
  'ruby',
  'perl',
  'bash',
  'sh',
  'zsh',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe'
]);

function normalizeToolName(input) {
  return String(input || '').trim();
}

function stripQuotes(value) {
  return String(value || '').replace(/^["']|["']$/g, '');
}

function splitCommand(commandLine) {
  const result = [];
  const regex = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = regex.exec(commandLine)) !== null) {
    result.push(match[1] ?? match[2] ?? match[0]);
  }
  return result;
}

function isLikelyOption(token) {
  return token.startsWith('-') || token.startsWith('/');
}

function commandLooksLikeFile(token) {
  const cleaned = stripQuotes(token);
  const ext = path.extname(cleaned).toLowerCase();
  return ext.length > 0 || cleaned.includes('/') || cleaned.includes('\\');
}

function resolveMainEntry(manifest) {
  const entryPoint = manifest.entryPoint || {};

  if (entryPoint.script) {
    return {
      source: 'entryPoint.script',
      command: entryPoint.script,
      relativePath: stripQuotes(entryPoint.script)
    };
  }

  if (!entryPoint.command) {
    return {
      source: 'entryPoint',
      command: '',
      relativePath: null
    };
  }

  const parts = splitCommand(entryPoint.command);
  if (parts.length === 0) {
    return {
      source: 'entryPoint.command',
      command: entryPoint.command,
      relativePath: null
    };
  }

  const first = stripQuotes(parts[0]);
  const firstBase = path.basename(first).toLowerCase();

  if (!RUNNER_COMMANDS.has(firstBase) && commandLooksLikeFile(first)) {
    return {
      source: 'entryPoint.command',
      command: entryPoint.command,
      relativePath: first
    };
  }

  for (let i = 1; i < parts.length; i++) {
    const token = stripQuotes(parts[i]);
    if (!token || isLikelyOption(token)) continue;
    if (commandLooksLikeFile(token)) {
      return {
        source: 'entryPoint.command',
        command: entryPoint.command,
        relativePath: token
      };
    }
  }

  return {
    source: 'entryPoint.command',
    command: entryPoint.command,
    relativePath: first
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function languageFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.lua': 'lua',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.ps1': 'powershell',
    '.bat': 'batch',
    '.cmd': 'batch',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.md': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.ini': 'ini',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.xml': 'xml',
    '.sql': 'sql'
  };
  return map[ext] || '';
}

async function discoverLocalPlugins() {
  const entries = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
  const plugins = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const basePath = path.join(PLUGIN_DIR, entry.name);
    const manifestPath = path.join(basePath, MANIFEST_NAME);

    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      if (!manifest.name) continue;

      plugins.push({
        folderName: entry.name,
        basePath,
        manifestPath,
        manifest,
        manifestRaw: raw
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        plugins.push({
          folderName: entry.name,
          basePath,
          manifestPath,
          manifest: null,
          manifestRaw: null,
          manifestError: error.message
        });
      }
    }
  }

  return plugins;
}

function findPluginByToolName(plugins, toolName) {
  const exact = plugins.find(item => item.manifest && item.manifest.name === toolName);
  if (exact) return exact;

  const lower = toolName.toLowerCase();
  return plugins.find(item => item.manifest && item.manifest.name.toLowerCase() === lower) || null;
}

async function buildTree(dirPath, options = {}) {
  const {
    rootPath = dirPath,
    prefix = '',
    depth = 0,
    maxDepth = 5,
    maxItems = 240,
    counter = { count: 0 }
  } = options;

  if (depth > maxDepth || counter.count >= maxItems) {
    return [];
  }

  let entries = await fs.readdir(dirPath, { withFileTypes: true });
  entries = entries
    .filter(entry => !IGNORED_TREE_DIRS.has(entry.name))
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    if (counter.count >= maxItems) {
      lines.push(`${prefix}└── ...（目录树已截断，超过 ${maxItems} 项）`);
      break;
    }

    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

    counter.count++;
    lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);

    if (entry.isDirectory()) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const childLines = await buildTree(fullPath, {
        rootPath,
        prefix: childPrefix,
        depth: depth + 1,
        maxDepth,
        maxItems,
        counter
      });
      lines.push(...childLines);
    }
  }

  return lines;
}

function isBinaryFile(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (!ext) return true;
  return false;
}

function insideDirectory(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readMainSource(mainPath) {
  const stats = await fs.stat(mainPath);
  if (stats.isDirectory()) {
    return {
      readable: false,
      reason: '入口指向目录，不是单个源码文件。'
    };
  }

  if (isBinaryFile(mainPath)) {
    return {
      readable: false,
      binary: true,
      reason: `入口文件是二进制/非文本文件（${formatBytes(stats.size)}），不直接返回源码。`
    };
  }

  if (!isTextFile(mainPath)) {
    return {
      readable: false,
      reason: `入口文件扩展名 ${path.extname(mainPath) || '(无扩展名)'} 不在文本源码白名单内。`
    };
  }

  const maxBytes = 1024 * 1024;
  if (stats.size > maxBytes) {
    return {
      readable: false,
      reason: `入口源码文件过大（${formatBytes(stats.size)}），超过 ${formatBytes(maxBytes)} 安全返回上限。`
    };
  }

  const content = await fs.readFile(mainPath, 'utf8');
  return {
    readable: true,
    size: stats.size,
    content
  };
}

async function viewPluginSource(targettool) {
  const normalizedTargetTool = normalizeToolName(targettool);
  if (!normalizedTargetTool) {
    return {
      status: 'error',
      error: '缺少必需参数 targettool。'
    };
  }

  const plugins = await discoverLocalPlugins();
  const found = findPluginByToolName(plugins, normalizedTargetTool);

  if (!found) {
    const localToolNames = plugins
      .filter(item => item.manifest && item.manifest.name)
      .map(item => item.manifest.name)
      .sort();

    return {
      status: 'success',
      result: {
        content: [
          {
            type: 'text',
            text: [
              `未在本地 Plugin 目录的启用 manifest 中找到工具：${normalizedTargetTool}`,
              '',
              '这通常表示：',
              '- 该工具是分布式插件，只在远端节点注册；或',
              '- 该工具不存在/已禁用/工具名拼写不一致。',
              '',
              `本地可见工具数量：${localToolNames.length}`,
              `本地工具名：${localToolNames.join(', ')}`
            ].join('\n')
          }
        ],
        details: {
          requestedTargetTool: normalizedTargetTool,
          found: false,
          possibleReason: 'distributed_or_missing',
          localToolNames
        }
      }
    };
  }

  const manifest = found.manifest;
  const entry = resolveMainEntry(manifest);
  const treeLines = await buildTree(found.basePath);
  const treeText = `${found.folderName}/\n${treeLines.map(line => `  ${line}`).join('\n')}`;

  let mainPath = null;
  let mainRelativePath = null;
  let sourceBlock = '';
  let sourceStatus = 'unknown';
  let sourceMessage = '';

  if (!entry.relativePath) {
    sourceStatus = 'missing_entry';
    sourceMessage = 'manifest 中没有可解析的 entryPoint.command 或 entryPoint.script。';
  } else {
    const resolved = path.resolve(found.basePath, entry.relativePath);
    if (!insideDirectory(resolved, found.basePath) && resolved !== found.basePath) {
      sourceStatus = 'unsafe_entry';
      sourceMessage = '入口路径解析到插件目录之外，出于安全原因不读取。';
      mainPath = resolved;
      mainRelativePath = path.relative(PLUGIN_DIR, resolved).replace(/\\/g, '/');
    } else if (!fsSync.existsSync(resolved)) {
      sourceStatus = 'entry_not_found';
      sourceMessage = `入口文件不存在：${entry.relativePath}`;
      mainPath = resolved;
      mainRelativePath = path.relative(found.basePath, resolved).replace(/\\/g, '/');
    } else {
      mainPath = resolved;
      mainRelativePath = path.relative(found.basePath, resolved).replace(/\\/g, '/');
      const source = await readMainSource(resolved);

      if (source.readable) {
        sourceStatus = 'source_returned';
        sourceMessage = `已返回主源码文件内容（${formatBytes(source.size)}）。`;
        const language = languageFromExtension(resolved);
        const fence = source.content.includes('```') ? '````' : '```';
        sourceBlock = `${fence}${language}\n${source.content}\n${fence}`;
      } else if (source.binary) {
        sourceStatus = 'binary_entry';
        sourceMessage = source.reason;
      } else {
        sourceStatus = 'source_not_returned';
        sourceMessage = source.reason;
      }
    }
  }

  const manifestFence = found.manifestRaw.includes('```') ? '````' : '```';

  const textParts = [
    `# 插件源码查询结果：${manifest.name}`,
    '',
    `- 显示名：${manifest.displayName || '(未设置)'}`,
    `- 插件类型：${manifest.pluginType || '(未设置)'}`,
    `- 通信协议：${manifest.communication?.protocol || '(未设置)'}`,
    `- manifest 路径：Plugin/${found.folderName}/${MANIFEST_NAME}`,
    `- 入口来源：${entry.source}`,
    `- 入口命令/脚本：${entry.command || '(未设置)'}`,
    `- 主入口文件：${mainRelativePath || '(未解析)'}`,
    `- 源码状态：${sourceMessage}`,
    '',
    '## 插件目录树（已忽略依赖/构建缓存目录）',
    '```text',
    treeText,
    '```',
    '',
    '## plugin-manifest.json',
    `${manifestFence}json`,
    found.manifestRaw.trim(),
    manifestFence,
    '',
    '## 主代码文件'
  ];

  if (sourceBlock) {
    textParts.push(sourceBlock);
  } else {
    textParts.push(sourceMessage);
  }

  return {
    status: 'success',
    result: {
      content: [
        {
          type: 'text',
          text: textParts.join('\n')
        }
      ],
      details: {
        requestedTargetTool: normalizedTargetTool,
        found: true,
        folderName: found.folderName,
        manifestPath: path.relative(process.cwd(), found.manifestPath).replace(/\\/g, '/'),
        pluginType: manifest.pluginType,
        communicationProtocol: manifest.communication?.protocol,
        entryPoint: manifest.entryPoint,
        resolvedEntry: {
          source: entry.source,
          command: entry.command,
          relativePath: entry.relativePath,
          mainRelativePath
        },
        sourceStatus
      }
    }
  };
}

async function processRequest(request) {
  const targettool = request.targettool;
  return await viewPluginSource(targettool);
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  inputBuffer += chunk;
});

process.stdin.on('end', async () => {
  try {
    const trimmed = inputBuffer.trim();
    const request = trimmed ? JSON.parse(trimmed) : {};
    const response = await processRequest(request);
    process.stdout.write(JSON.stringify(response));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'error',
      error: `PluginSourceViewer 请求处理失败：${error.message}`
    }));
  }
});
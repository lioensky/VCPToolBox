const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const MAP_FILE = path.join(__dirname, '..', 'toolbox_map.json');

function resolveTvsDir() {
  const configPath = process.env.TVSTXT_DIR_PATH;
  if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
    return path.join(__dirname, '..', 'TVStxt');
  }
  const normalizedPath = path.normalize(configPath.trim());
  return path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(__dirname, '..', normalizedPath);
}

const FOLD_REGEX = /^\[===vcp_fold:\s*([0-9.]+)(?:\s*::desc:\s*(.*?)\s*)?===\]\s*$/;

class ToolboxManager {
  constructor() {
    this.toolboxMap = new Map();
    this.contentCache = new Map(); // key: resolvedPath => { mtimeMs, foldObj }
    this.debugMode = false;
    this.tvsDir = resolveTvsDir();
    this.tvsWatcher = null;
  }

  setTvsDir(tvsDirPath) {
    if (!tvsDirPath || typeof tvsDirPath !== 'string') {
      throw new Error('[ToolboxManager] tvsDirPath must be a non-empty string');
    }
    this.tvsDir = path.isAbsolute(tvsDirPath) ? tvsDirPath : path.resolve(__dirname, '..', tvsDirPath);
  }

  async initialize(debugMode = false) {
    this.debugMode = debugMode;
    if (this.debugMode) {
      console.log('[ToolboxManager] Initializing...');
      console.log(`[ToolboxManager] TVS directory: ${this.tvsDir}`);
    }

    await this.loadMap();
    this.watchFiles();
  }

  async loadMap() {
    try {
      const mapContent = await fs.readFile(MAP_FILE, 'utf8');
      const mapJson = JSON.parse(mapContent);

      this.toolboxMap.clear();
      for (const alias in mapJson) {
        const normalized = this._normalizeMapItem(alias, mapJson[alias]);
        if (normalized) {
          this.toolboxMap.set(alias, normalized);
        }
      }

      this.contentCache.clear();
      if (this.debugMode) {
        console.log(`[ToolboxManager] Loaded ${this.toolboxMap.size} toolbox mappings from toolbox_map.json.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn('[ToolboxManager] toolbox_map.json not found. No toolbox placeholders will be loaded.');
      } else {
        console.error('[ToolboxManager] Error loading toolbox_map.json:', error.message);
      }
      this.toolboxMap.clear();
      this.contentCache.clear();
    }
  }

  watchFiles() {
    try {
      if (fsSync.existsSync(MAP_FILE)) {
        fsSync.watch(MAP_FILE, (eventType, filename) => {
          if (filename && (eventType === 'change' || eventType === 'rename')) {
            console.log(`[ToolboxManager] Detected change in ${filename}. Reloading toolbox map...`);
            this.loadMap();
          }
        });
      }

      this.tvsWatcher = chokidar.watch(this.tvsDir, {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/target/**',
          '**/image/**',
          '**/.*'
        ],
        persistent: true,
        ignoreInitial: true,
      });

      const clearByChangedPath = async (filePath) => {
        const resolvedPath = path.resolve(filePath);
        if (this.contentCache.has(resolvedPath)) {
          this.contentCache.delete(resolvedPath);
          if (this.debugMode) {
            console.log(`[ToolboxManager] Cleared cache for changed toolbox file: ${path.relative(this.tvsDir, resolvedPath)}`);
          }
        }
      };

      this.tvsWatcher.on('change', clearByChangedPath);
      this.tvsWatcher.on('unlink', clearByChangedPath);
      this.tvsWatcher.on('error', (error) => {
        console.error('[ToolboxManager] TVS watcher error:', error.message);
      });
    } catch (error) {
      console.error('[ToolboxManager] Failed to set up file watchers:', error.message);
    }
  }

  isToolbox(alias) {
    return this.toolboxMap.has(alias);
  }

  async getFoldObject(alias) {
    const item = this.toolboxMap.get(alias);
    if (!item) {
      return this._buildErrorFoldObject(`未找到 toolbox 别名 '${alias}'。`, alias);
    }

    const safeResolvedPath = this._resolveSafePath(item.file);
    if (!safeResolvedPath.ok) {
      return this._buildErrorFoldObject(safeResolvedPath.error, alias, item.description);
    }

    const fullPath = safeResolvedPath.path;

    try {
      const stat = await fs.stat(fullPath);
      const cached = this.contentCache.get(fullPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return {
          ...cached.foldObj,
          plugin_description: item.description || cached.foldObj.plugin_description || `Toolbox ${alias}`
        };
      }

      const content = await fs.readFile(fullPath, 'utf8');
      const fold_blocks = this._parseFoldBlocks(content);

      const foldObj = {
        vcp_dynamic_fold: true,
        dynamic_fold_strategy: 'toolbox_block_similarity',
        plugin_description: item.description || `Toolbox ${alias}`,
        fold_blocks
      };

      this.contentCache.set(fullPath, { mtimeMs: stat.mtimeMs, foldObj });
      return foldObj;
    } catch (error) {
      return this._buildErrorFoldObject(
        `无法读取 toolbox 文档 '${item.file}'：${error.message}`,
        alias,
        item.description
      );
    }
  }

  _normalizeMapItem(alias, rawValue) {
    if (typeof rawValue === 'string') {
      return {
        file: rawValue,
        description: ''
      };
    }

    if (rawValue && typeof rawValue === 'object' && typeof rawValue.file === 'string') {
      return {
        file: rawValue.file,
        description: typeof rawValue.description === 'string' && rawValue.description.trim()
          ? rawValue.description.trim()
          : ''
      };
    }

    console.warn(`[ToolboxManager] Invalid map entry for alias '${alias}', skipped.`);
    return null;
  }

  _resolveSafePath(relativeFile) {
    const baseDir = path.resolve(this.tvsDir);
    const resolved = path.resolve(baseDir, relativeFile);
    if (!resolved.startsWith(baseDir + path.sep)) {
      return { ok: false, error: `非法路径访问被拒绝: ${relativeFile}` };
    }
    return { ok: true, path: resolved };
  }

  _parseFoldBlocks(content) {
    const blocks = [];
    let currentThreshold = 0.0;
    let currentDescription = '';
    let currentContent = [];
    let hasOpenedFoldBlock = false;

    const lines = String(content || '').split('\n');
    for (const line of lines) {
      const match = line.match(FOLD_REGEX);
      if (match) {
        if (hasOpenedFoldBlock || currentContent.length > 0) {
          blocks.push({
            threshold: currentThreshold,
            description: currentDescription,
            content: currentContent.join('\n').trim()
          });
        }

        currentThreshold = parseFloat(match[1]);
        if (Number.isNaN(currentThreshold)) currentThreshold = 0.0;
        currentDescription = typeof match[2] === 'string' ? match[2].trim() : '';
        currentContent = [];
        hasOpenedFoldBlock = true;
      } else {
        currentContent.push(line);
      }
    }

    if (hasOpenedFoldBlock || currentContent.length > 0) {
      blocks.push({
        threshold: currentThreshold,
        description: currentDescription,
        content: currentContent.join('\n').trim()
      });
    }

    const validBlocks = blocks.filter(block => block && typeof block.content === 'string');
    if (validBlocks.length === 0) {
      return [{ threshold: 0.0, description: '', content: '配置文件中未找到有效内容。' }];
    }

    return validBlocks;
  }

  _buildErrorFoldObject(errorMessage, alias, description = '') {
    return {
      vcp_dynamic_fold: true,
      dynamic_fold_strategy: 'toolbox_block_similarity',
      plugin_description: description || `Toolbox ${alias}`,
      fold_blocks: [
        {
          threshold: 0.0,
          description: '',
          content: `[ToolboxManager] ${errorMessage}`
        }
      ]
    };
  }
}

module.exports = new ToolboxManager();

// modules/agentManager.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const MAP_FILE = path.join(__dirname, '..', 'agent_map.json');

class AgentManager {
    constructor(defaultAgentDir = null) {
        this.agentDir = defaultAgentDir;
        this.agentMap = new Map();
        this.promptCache = new Map();
        this.debugMode = false;
        this.agentFiles = []; // 存储所有可用的Agent文件
        this.folderStructure = {}; // 存储文件夹结构
    }

    /**
     * Initializes the AgentManager, loads the mapping file, and starts watching for changes.
     * @param {boolean} debugMode - Enable debug logging.
     */
    async initialize(debugMode = false) {
        this.debugMode = debugMode;
        console.log('[AgentManager] Initializing...');
        console.log(`[AgentManager] Agent directory: ${this.agentDir}`);
        
        await this.loadMap();
        await this.scanAgentFiles(); // 扫描Agent文件和文件夹结构
        this.watchFiles();
    }

    /**
     * Loads or reloads the agent alias-to-filename mapping from agent_map.json.
     */
    async loadMap() {
        try {
            const mapContent = await fs.readFile(MAP_FILE, 'utf8');
            const mapJson = JSON.parse(mapContent);
            
            this.agentMap.clear();
            for (const alias in mapJson) {
                this.agentMap.set(alias, mapJson[alias]);
            }

            if (this.debugMode) {
                console.log(`[AgentManager] Loaded ${this.agentMap.size} agent mappings from agent_map.json.`);
            }
            // When the map changes, the entire prompt cache becomes potentially invalid.
            this.promptCache.clear();
            console.log('[AgentManager] Agent map reloaded and prompt cache cleared.');

        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AgentManager] agent_map.json not found. No agents will be loaded.`);
            } else {
                console.error('[AgentManager] Error loading or parsing agent_map.json:', error);
            }
            // Clear map and cache on error to prevent using stale data.
            this.agentMap.clear();
            this.promptCache.clear();
        }
    }

    /**
     * Sets up watchers on the mapping file and the Agent directory for hot-reloading.
     */
    watchFiles() {
        try {
            // 检查文件是否存在，如果不存在则不监视
            if (fsSync.existsSync(MAP_FILE)) {
                fsSync.watch(MAP_FILE, (eventType, filename) => {
                    if (filename && (eventType === 'change' || eventType === 'rename')) {
                        console.log(`[AgentManager] Detected change in ${filename}. Reloading agent map...`);
                        this.loadMap();
                    }
                });
            } else {
                console.log(`[AgentManager] agent_map.json not found, not watching for changes.`);
            }

            const watcher = chokidar.watch(this.agentDir, {
                ignored: /(^|[\/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: true,
            });

            watcher.on('change', async (filePath) => {
                const filename = path.relative(this.agentDir, filePath);
                const normalizedFilename = filename.replace(/\\/g, '/');
                
                for (const [alias, file] of this.agentMap.entries()) {
                    // Normalize path separators for comparison
                    if (file.replace(/\\/g, '/') === normalizedFilename) {
                        if (this.promptCache.has(alias)) {
                            this.promptCache.delete(alias);
                            console.log(`[AgentManager] Prompt cache for '${alias}' (${filename}) cleared due to file change.`);
                        }
                        return;
                    }
                }
                
                // 如果文件变化，重新扫描文件列表
                await this.scanAgentFiles();
            });
            
            // 监听文件添加和删除
            watcher.on('add', async (filePath) => {
                console.log(`[AgentManager] New file detected: ${path.relative(this.agentDir, filePath)}`);
                await this.scanAgentFiles();
            });
            
            watcher.on('unlink', async (filePath) => {
                console.log(`[AgentManager] File deleted: ${path.relative(this.agentDir, filePath)}`);
                await this.scanAgentFiles();
            });
            
            watcher.on('error', (error) => {
                console.error('[AgentManager] File watcher error:', error.message);
            });
        } catch (error) {
            console.error(`[AgentManager] Failed to set up file watchers:`, error);
        }
    }

    /**
     * 递归扫描Agent目录，获取所有.txt和.md文件以及文件夹结构
     */
    async scanAgentFiles() {
        try {
            this.agentFiles = [];
            this.folderStructure = {};
            
            // 确保Agent目录存在
            await fs.mkdir(this.agentDir, { recursive: true });
            
            // 递归扫描目录
            await this.scanDirectory(this.agentDir, '');
            
            if (this.debugMode) {
                console.log(`[AgentManager] Found ${this.agentFiles.length} agent files.`);
                console.log(`[AgentManager] Folder structure:`, JSON.stringify(this.folderStructure, null, 2));
            }
        } catch (error) {
            console.error('[AgentManager] Error scanning agent files:', error);
        }
    }

    /**
     * 递归扫描目录，收集文件和构建文件夹结构
     * @param {string} dirPath - 要扫描的目录路径
     * @param {string} relativePath - 相对于Agent目录的路径
     */
    async scanDirectory(dirPath, relativePath) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
                
                // 处理符号链接
                if (entry.isSymbolicLink()) {
                    try {
                        // 获取符号链接指向的真实路径
                        const realPath = await fs.readlink(entryPath);
                        const fullPath = path.resolve(path.dirname(entryPath), realPath);
                        
                        // 检查真实路径是否是文件
                        const stats = await fs.stat(fullPath);
                        if (stats.isFile() && (entry.name.toLowerCase().endsWith('.txt') || entry.name.toLowerCase().endsWith('.md'))) {
                            // 添加到文件列表
                            this.agentFiles.push(entryRelativePath);
                            
                            // 添加到文件夹结构
                            this.addToFolderStructure(entryRelativePath, 'file', entryRelativePath);
                            
                            if (this.debugMode) {
                                console.log(`[AgentManager] Found symbolic link: ${entryRelativePath} -> ${realPath}`);
                            }
                        } else if (stats.isDirectory()) {
                            // 添加到文件夹结构
                            this.addToFolderStructure(entryRelativePath, 'folder');
                            
                            // 递归扫描子目录
                            await this.scanDirectory(fullPath, entryRelativePath);
                        }
                    } catch (linkError) {
                        console.error(`[AgentManager] Error processing symbolic link ${entryPath}:`, linkError);
                    }
                } else if (entry.isDirectory()) {
                    // 添加到文件夹结构
                    this.addToFolderStructure(entryRelativePath, 'folder');
                    
                    // 递归扫描子目录
                    await this.scanDirectory(entryPath, entryRelativePath);
                } else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.txt') || entry.name.toLowerCase().endsWith('.md'))) {
                    // 添加到文件列表
                    this.agentFiles.push(entryRelativePath);
                    
                    // 添加到文件夹结构
                    this.addToFolderStructure(entryRelativePath, 'file', entryRelativePath);
                }
            }
        } catch (error) {
            console.error(`[AgentManager] Error scanning directory ${dirPath}:`, error);
        }
    }

    /**
     * 添加文件或文件夹到结构中
     * @param {string} relativePath - 相对路径
     * @param {string} type - 类型 ('folder' 或 'file')
     * @param {string} filePath - 文件完整路径（仅当type为file时使用）
     */
    addToFolderStructure(relativePath, type, filePath = null) {
        const parts = relativePath.split(path.sep);
        let current = this.folderStructure;
        
        // 遍历路径的每个部分
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            
            if (!current[part]) {
                if (isLastPart && type === 'file') {
                    // 如果是文件，添加文件信息
                    current[part] = {
                        type: 'file',
                        path: filePath
                    };
                } else {
                    // 如果是文件夹或路径中间部分，创建文件夹对象
                    current[part] = {
                        type: 'folder',
                        children: {}
                    };
                }
            }
            
            // 移动到下一级
            if (current[part] && current[part].type === 'folder') {
                current = current[part].children;
            }
        }
    }

    /**
     * 获取所有Agent文件和文件夹结构
     * @returns {Object} 包含文件列表和文件夹结构的对象
     */
    getAllAgentFiles() {
        return {
            files: this.agentFiles,
            folderStructure: this.folderStructure
        };
    }

    /**
     * Retrieves the prompt for a given agent alias, using cache if available.
     * @param {string} alias - The agent alias (e.g., "XiaoKe").
     * @returns {Promise<string>} The agent's prompt content.
     */
    async getAgentPrompt(alias) {
        if (this.promptCache.has(alias)) {
            return this.promptCache.get(alias);
        }

        const filename = this.agentMap.get(alias);
        if (!filename) {
            if (this.debugMode) {
                console.warn(`[AgentManager] Agent alias '${alias}' not found in map.`);
            }
            return `{{agent:${alias}}}`; // Return original placeholder if not found
        }

        try {
            // 处理路径分隔符，确保跨平台兼容性
            const normalizedFilename = filename.replace(/\//g, path.sep);
            let filePath = path.join(this.agentDir, normalizedFilename);
            
            // 检查是否是符号链接，如果是则解析真实路径
            try {
                const stats = await fs.lstat(filePath);
                if (stats.isSymbolicLink()) {
                    const realPath = await fs.readlink(filePath);
                    filePath = path.resolve(path.dirname(filePath), realPath);
                    
                    if (this.debugMode) {
                        console.log(`[AgentManager] Following symbolic link for '${alias}': ${normalizedFilename} -> ${realPath}`);
                    }
                }
            } catch (linkError) {
                // 如果不是符号链接或无法读取，继续使用原路径
                if (this.debugMode) {
                    console.log(`[AgentManager] Not a symbolic link or cannot read link info for '${alias}': ${linkError.message}`);
                }
            }
            
            const prompt = await fs.readFile(filePath, 'utf8');
            this.promptCache.set(alias, prompt);
            return prompt;
        } catch (error) {
            console.error(`[AgentManager] Error reading agent file for '${alias}' (${filename}):`, error.message);
            return `[AgentManager: Error loading prompt for '${alias}'. File not found or unreadable.]`;
        }
    }

    /**
     * Checks if a given alias is a registered agent.
     * @param {string} alias - The agent alias to check.
     * @returns {boolean} True if the alias exists in the map.
     */
    isAgent(alias) {
        return this.agentMap.has(alias);
    }
    
    /**
     * Sets the Agent directory path. Must be called before initialize.
     * @param {string} agentDirPath - The path to the Agent directory.
     */
    setAgentDir(agentDirPath) {
        if (!agentDirPath || typeof agentDirPath !== 'string') {
            throw new Error('[AgentManager] agentDirPath must be a non-empty string');
        }
        this.agentDir = agentDirPath;
    }
}

const agentManager = new AgentManager(path.join(__dirname, '..', 'Agent'));
module.exports = agentManager;
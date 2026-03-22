const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const manifestFileName = 'plugin-manifest.json';
const blockedManifestExtension = '.block';
const execFileAsync = promisify(execFile);

function sanitizeFolderName(name) {
    return String(name || 'plugin')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\.+$/g, '')
        .trim() || 'plugin';
}

function quotePowerShell(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function extractZipArchive(zipPath, destinationPath) {
    if (process.platform === 'win32') {
        const command = `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(destinationPath)} -Force`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command]);
        return;
    }

    await execFileAsync('unzip', ['-o', zipPath, '-d', destinationPath]);
}

async function findManifestFiles(rootPath) {
    const results = [];
    const stack = [rootPath];

    while (stack.length > 0) {
        const currentPath = stack.pop();
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') {
                continue;
            }

            const absPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                stack.push(absPath);
            } else if (entry.isFile() && entry.name === manifestFileName) {
                results.push(absPath);
            }
        }
    }

    return results;
}

async function discoverPluginFromExtractedArchive(extractRoot) {
    const manifestFiles = await findManifestFiles(extractRoot);
    if (manifestFiles.length === 0) {
        throw new Error('Zip 中未找到 plugin-manifest.json。');
    }
    if (manifestFiles.length > 1) {
        throw new Error('Zip 中检测到多个 plugin-manifest.json，第一版安装器暂不支持多插件包。');
    }

    const manifestPath = manifestFiles[0];
    const pluginRoot = path.dirname(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) {
        throw new Error('plugin-manifest.json 缺少必要字段：name / pluginType / entryPoint。');
    }

    return { manifest, manifestPath, pluginRoot };
}

async function findPluginFolderByName(pluginDir, pluginName) {
    const pluginFolders = await fs.readdir(pluginDir, { withFileTypes: true });

    for (const folder of pluginFolders) {
        if (!folder.isDirectory() || folder.name === '.trash') continue;

        const pluginPath = path.join(pluginDir, folder.name);
        const manifestPath = path.join(pluginPath, manifestFileName);
        const blockedManifestPath = manifestPath + blockedManifestExtension;

        for (const candidate of [manifestPath, blockedManifestPath]) {
            try {
                const manifestContent = await fs.readFile(candidate, 'utf-8');
                const manifest = JSON.parse(manifestContent);
                if (manifest.name === pluginName) {
                    return { pluginPath, manifest, manifestPath, blockedManifestPath, folderName: folder.name };
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.warn(`[AdminPanelRoutes] Failed to inspect plugin folder ${folder.name}:`, error.message);
                }
            }
        }
    }

    return null;
}

async function readPluginManifestFromFolder(pluginPath) {
    const manifestPath = path.join(pluginPath, manifestFileName);
    const blockedManifestPath = manifestPath + blockedManifestExtension;

    for (const candidatePath of [manifestPath, blockedManifestPath]) {
        try {
            const manifestContent = await fs.readFile(candidatePath, 'utf-8');
            return {
                manifest: JSON.parse(manifestContent),
                manifestPath: candidatePath,
                isBlocked: candidatePath.endsWith(blockedManifestExtension),
            };
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    return null;
}

function parseTrashFolderName(folderName) {
    const match = String(folderName || '').match(/^(\d+)__(.+)$/);
    if (!match) {
        return {
            removedAt: null,
            originalFolderName: folderName,
        };
    }

    const removedAt = Number.parseInt(match[1], 10);
    return {
        removedAt: Number.isFinite(removedAt) ? removedAt : null,
        originalFolderName: match[2] || folderName,
    };
}

function resolvePathInside(baseDir, childName) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedPath = path.resolve(baseDir, childName);

    if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${path.sep}`)) {
        throw new Error('Invalid path.');
    }

    return resolvedPath;
}

async function listTrashedPlugins(pluginDir) {
    const trashRoot = path.join(pluginDir, '.trash');
    if (!(await pathExists(trashRoot))) {
        return [];
    }

    const trashFolders = await fs.readdir(trashRoot, { withFileTypes: true });
    const results = [];

    for (const folder of trashFolders) {
        if (!folder.isDirectory()) continue;

        const trashedPath = path.join(trashRoot, folder.name);
        try {
            const manifestInfo = await readPluginManifestFromFolder(trashedPath);
            if (!manifestInfo?.manifest?.name) {
                continue;
            }

            const { removedAt, originalFolderName } = parseTrashFolderName(folder.name);
            results.push({
                trashedFolderName: folder.name,
                originalFolderName,
                removedAt,
                pluginName: manifestInfo.manifest.name,
                displayName: manifestInfo.manifest.displayName || manifestInfo.manifest.name,
                version: manifestInfo.manifest.version || '',
                pluginType: manifestInfo.manifest.pluginType || '',
                isBlocked: manifestInfo.isBlocked,
            });
        } catch (error) {
            console.warn(`[AdminPanelRoutes] Failed to inspect trashed plugin ${folder.name}:`, error.message);
        }
    }

    return results.sort((a, b) => (b.removedAt || 0) - (a.removedAt || 0));
}

async function detectInstallRequirements(pluginRoot) {
    const checks = [
        { fileName: 'package.json', type: 'npm', message: '检测到 package.json，需要时请手动执行 npm install。' },
        { fileName: 'requirements.txt', type: 'pip', message: '检测到 requirements.txt，需要时请手动执行 pip install -r requirements.txt。' },
        { fileName: 'pyproject.toml', type: 'python', message: '检测到 pyproject.toml，请确认该插件需要的 Python 依赖已安装。' },
    ];
    const dependencyHints = [];

    for (const check of checks) {
        if (await pathExists(path.join(pluginRoot, check.fileName))) {
            dependencyHints.push({
                type: check.type,
                file: check.fileName,
                message: check.message,
            });
        }
    }

    return dependencyHints;
}

async function buildInstallWarningsLegacy(pluginRoot) {
    const warnings = [];
    const packageJsonPath = path.join(pluginRoot, 'package.json');
    const requirementsPath = path.join(pluginRoot, 'requirements.txt');

    return Promise.all([
        pathExists(packageJsonPath),
        pathExists(requirementsPath),
    ]).then(([hasPackageJson, hasRequirements]) => {
        if (hasPackageJson) {
            warnings.push('检测到 package.json。第一版不会自动执行 npm install，如有需要请手动安装插件依赖。');
        }
        if (hasRequirements) {
            warnings.push('检测到 requirements.txt。第一版不会自动执行 pip install，如有需要请手动安装 Python 依赖。');
        }
        return warnings;
    });
}

async function buildInstallWarnings(pluginRoot) {
    const dependencyHints = await detectInstallRequirements(pluginRoot);
    return {
        warnings: dependencyHints.map((hint) => hint.message),
        dependencyHints,
    };
}

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, DEBUG_MODE } = options;
    const PREPROCESSOR_ORDER_FILE = path.join(__dirname, '..', '..', 'preprocessor_order.json');
    const PLUGIN_DIR = path.join(__dirname, '..', '..', 'Plugin');

    // GET plugin list
    router.get('/plugins', async (req, res) => {
        try {
            const pluginDataMap = new Map();

            const loadedPlugins = Array.from(pluginManager.plugins.values());
            for (const p of loadedPlugins) {
                let configEnvContent = null;
                if (!p.isDistributed && p.basePath) {
                    try {
                        const pluginConfigPath = path.join(p.basePath, 'config.env');
                        configEnvContent = await fs.readFile(pluginConfigPath, 'utf-8');
                    } catch (envError) {
                        if (envError.code !== 'ENOENT') {
                            console.warn(`[AdminPanelRoutes] Error reading config.env for ${p.name}:`, envError);
                        }
                    }
                }
                pluginDataMap.set(p.name, {
                    name: p.name,
                    manifest: p,
                    enabled: true,
                    configEnvContent: configEnvContent,
                    isDistributed: p.isDistributed || false,
                    serverId: p.serverId || null
                });
            }

            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    const blockedManifestPath = manifestPath + blockedManifestExtension;

                    try {
                        const manifestContent = await fs.readFile(blockedManifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);

                        if (!pluginDataMap.has(manifest.name)) {
                            let configEnvContent = null;
                            try {
                                const pluginConfigPath = path.join(pluginPath, 'config.env');
                                configEnvContent = await fs.readFile(pluginConfigPath, 'utf-8');
                            } catch (envError) {
                                if (envError.code !== 'ENOENT') {
                                    console.warn(`[AdminPanelRoutes] Error reading config.env for disabled plugin ${manifest.name}:`, envError);
                                }
                            }
                            manifest.basePath = pluginPath;
                            pluginDataMap.set(manifest.name, {
                                name: manifest.name,
                                manifest: manifest,
                                enabled: false,
                                configEnvContent: configEnvContent,
                                isDistributed: false,
                                serverId: null
                            });
                        }
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            console.warn(`[AdminPanelRoutes] Error processing potential disabled plugin in ${folder.name}:`, error);
                        }
                    }
                }
            }

            const pluginDataList = Array.from(pluginDataMap.values());
            res.json(pluginDataList);
        } catch (error) {
            console.error('[AdminPanelRoutes] Error listing plugins:', error);
            res.status(500).json({ error: 'Failed to list plugins', details: error.message });
        }
    });

    router.post('/plugins/install-local-zip', async (req, res) => {
        const zipPath = req.body?.zipPath;

        if (typeof zipPath !== 'string' || !zipPath.trim()) {
            return res.status(400).json({ error: 'Invalid request body. Expected { zipPath: string }.' });
        }

        const normalizedZipPath = path.resolve(zipPath.trim());
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcptoolbox-plugin-install-'));

        try {
            const stats = await fs.stat(normalizedZipPath);
            if (!stats.isFile()) {
                return res.status(400).json({ error: '指定的 zipPath 不是文件。' });
            }
            if (path.extname(normalizedZipPath).toLowerCase() !== '.zip') {
                return res.status(400).json({ error: '第一版安装器目前只支持 .zip 文件。' });
            }

            await extractZipArchive(normalizedZipPath, tempRoot);
            const { manifest, pluginRoot } = await discoverPluginFromExtractedArchive(tempRoot);
            const existingPlugin = await findPluginFolderByName(PLUGIN_DIR, manifest.name);
            if (existingPlugin) {
                return res.status(409).json({ error: `插件 ${manifest.name} 已存在，请先卸载旧版本。` });
            }

            const destinationFolderName = sanitizeFolderName(
                pluginRoot === tempRoot ? manifest.name : path.basename(pluginRoot)
            );
            const destinationPath = path.join(PLUGIN_DIR, destinationFolderName);

            if (await pathExists(destinationPath)) {
                return res.status(409).json({ error: `目标目录 ${destinationFolderName} 已存在，请先清理后再安装。` });
            }

            await fs.cp(pluginRoot, destinationPath, { recursive: true, force: false });

            const { warnings, dependencyHints } = await buildInstallWarnings(destinationPath);
            await pluginManager.loadPlugins();

            return res.json({
                message: `插件 ${manifest.name} 已安装并完成热加载。`,
                pluginName: manifest.name,
                installedPath: destinationPath,
                warnings,
                dependencyHints,
            });
        } catch (error) {
            console.error('[AdminPanelRoutes] Error installing plugin from local zip:', error);
            return res.status(500).json({ error: `安装插件失败: ${error.message}` });
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
        }
    });

    // Toggle plugin status
    router.post('/plugins/:pluginName/toggle', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { enable } = req.body;

        if (typeof enable !== 'boolean') {
            return res.status(400).json({ error: 'Invalid request body. Expected { enable: boolean }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetPluginPath = null;
            let foundManifest = null;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let manifestContent = null;

                    try {
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try {
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                            } catch (blockedErr) { continue; }
                        } else { continue; }
                    }

                    try {
                        const manifest = JSON.parse(manifestContent);
                        if (manifest.name === pluginName) {
                            targetPluginPath = potentialPluginPath;
                            foundManifest = manifest;
                            break;
                        }
                    } catch (parseErr) { continue; }
                }
            }

            if (!targetPluginPath || !foundManifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' not found.` });
            }

            const manifestPathToUse = path.join(targetPluginPath, manifestFileName);
            const blockedManifestPathToUse = manifestPathToUse + blockedManifestExtension;

            if (enable) {
                try {
                    await fs.rename(blockedManifestPathToUse, manifestPathToUse);
                    await pluginManager.loadPlugins();
                    res.json({ message: `插件 ${pluginName} 已启用。` });
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        try {
                            await fs.access(manifestPathToUse);
                            res.json({ message: `插件 ${pluginName} 已经是启用状态。` });
                        } catch (accessError) {
                            res.status(500).json({ error: `无法启用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                        }
                    } else {
                        console.error(`[AdminPanelRoutes] Error enabling plugin ${pluginName}:`, error);
                        res.status(500).json({ error: `启用插件 ${pluginName} 时出错`, details: error.message });
                    }
                }
            } else {
                try {
                    await fs.rename(manifestPathToUse, blockedManifestPathToUse);
                    await pluginManager.loadPlugins();
                    res.json({ message: `插件 ${pluginName} 已禁用。` });
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        try {
                            await fs.access(blockedManifestPathToUse);
                            res.json({ message: `插件 ${pluginName} 已经是禁用状态。` });
                        } catch (accessError) {
                            res.status(500).json({ error: `无法禁用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                        }
                    } else {
                        console.error(`[AdminPanelRoutes] Error disabling plugin ${pluginName}:`, error);
                        res.status(500).json({ error: `禁用插件 ${pluginName} 时出错`, details: error.message });
                    }
                }
            }
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error toggling plugin ${pluginName}:`, error);
            res.status(500).json({ error: `处理插件 ${pluginName} 状态切换时出错`, details: error.message });
        }
    });

    router.post('/plugins/:pluginName/uninstall', async (req, res) => {
        const pluginName = req.params.pluginName;

        try {
            const pluginInfo = await findPluginFolderByName(PLUGIN_DIR, pluginName);
            if (!pluginInfo) {
                return res.status(404).json({ error: `Plugin '${pluginName}' not found.` });
            }

            const trashRoot = path.join(PLUGIN_DIR, '.trash');
            await fs.mkdir(trashRoot, { recursive: true });

            const trashedFolderName = `${Date.now()}__${sanitizeFolderName(pluginInfo.folderName)}`;
            const trashedPath = path.join(trashRoot, trashedFolderName);

            await fs.rename(pluginInfo.pluginPath, trashedPath);
            await pluginManager.loadPlugins();

            return res.json({
                message: `插件 ${pluginName} 已卸载，原目录已移动到 Plugin/.trash。`,
                trashedPath,
            });
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error uninstalling plugin ${pluginName}:`, error);
            return res.status(500).json({ error: `卸载插件 ${pluginName} 时出错`, details: error.message });
        }
    });

    router.get('/plugins/trash', async (req, res) => {
        try {
            const trashedPlugins = await listTrashedPlugins(PLUGIN_DIR);
            return res.json(trashedPlugins);
        } catch (error) {
            console.error('[AdminPanelRoutes] Error listing trashed plugins:', error);
            return res.status(500).json({ error: `Failed to list trashed plugins: ${error.message}` });
        }
    });

    router.post('/plugins/trash/:trashedFolderName/restore', async (req, res) => {
        const trashedFolderName = path.basename(req.params.trashedFolderName || '');
        const trashRoot = path.join(PLUGIN_DIR, '.trash');

        if (!trashedFolderName) {
            return res.status(400).json({ error: 'Invalid trashed plugin folder name.' });
        }

        try {
            const trashedPath = resolvePathInside(trashRoot, trashedFolderName);
            const manifestInfo = await readPluginManifestFromFolder(trashedPath);
            if (!manifestInfo?.manifest?.name) {
                return res.status(404).json({ error: 'Trashed plugin manifest not found.' });
            }

            const existingPlugin = await findPluginFolderByName(PLUGIN_DIR, manifestInfo.manifest.name);
            if (existingPlugin) {
                return res.status(409).json({ error: `插件 ${manifestInfo.manifest.name} 已存在，请先卸载或重命名现有插件。` });
            }

            const { originalFolderName } = parseTrashFolderName(trashedFolderName);
            const restoredFolderName = sanitizeFolderName(originalFolderName || manifestInfo.manifest.name);
            const restoredPath = resolvePathInside(PLUGIN_DIR, restoredFolderName);

            if (await pathExists(restoredPath)) {
                return res.status(409).json({ error: `目标目录 ${restoredFolderName} 已存在，请先处理后再恢复。` });
            }

            await fs.rename(trashedPath, restoredPath);
            await pluginManager.loadPlugins();

            return res.json({
                message: `插件 ${manifestInfo.manifest.name} 已从回收站恢复。`,
                pluginName: manifestInfo.manifest.name,
                restoredPath,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Trashed plugin folder not found.' });
            }

            console.error(`[AdminPanelRoutes] Error restoring trashed plugin ${trashedFolderName}:`, error);
            return res.status(500).json({ error: `恢复插件失败: ${error.message}` });
        }
    });

    // Update plugin description
    router.post('/plugins/:pluginName/description', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { description } = req.body;
        if (typeof description !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { description: string }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetManifestPath = null;
            let manifest = null;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let currentPath = null;
                    let manifestContent = null;

                    try {
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                        currentPath = potentialManifestPath;
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try {
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                                currentPath = potentialBlockedPath;
                            } catch (blockedErr) { continue; }
                        } else { continue; }
                    }

                    try {
                        const parsedManifest = JSON.parse(manifestContent);
                        if (parsedManifest.name === pluginName) {
                            targetManifestPath = currentPath;
                            manifest = parsedManifest;
                            break;
                        }
                    } catch (parseErr) { continue; }
                }
            }

            if (!targetManifestPath || !manifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' or its manifest file not found.` });
            }

            manifest.description = description;
            await fs.writeFile(targetManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await pluginManager.loadPlugins();
            res.json({ message: `插件 ${pluginName} 的描述已更新并重新加载。` });
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error updating description for plugin ${pluginName}:`, error);
            res.status(500).json({ error: `更新插件 ${pluginName} 描述时出错`, details: error.message });
        }
    });

    // Save plugin config
    router.post('/plugins/:pluginName/config', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content format. String expected.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetPluginPath = null;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(potentialPluginPath, manifestFileName);
                    const blockedManifestPath = manifestPath + blockedManifestExtension;
                    let manifestContent = null;
                    try {
                        manifestContent = await fs.readFile(manifestPath, 'utf-8');
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try { manifestContent = await fs.readFile(blockedManifestPath, 'utf-8'); }
                            catch (blockedErr) { continue; }
                        } else { continue; }
                    }
                    try {
                        const manifest = JSON.parse(manifestContent);
                        if (manifest.name === pluginName) {
                            targetPluginPath = potentialPluginPath;
                            break;
                        }
                    } catch (parseErr) { continue; }
                }
            }

            if (!targetPluginPath) {
                return res.status(404).json({ error: `Plugin folder for '${pluginName}' not found.` });
            }

            const configPath = path.join(targetPluginPath, 'config.env');
            await fs.writeFile(configPath, content, 'utf-8');
            await pluginManager.loadPlugins();
            res.json({ message: `插件 ${pluginName} 的配置已保存并已重新加载。` });
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error writing config.env for plugin ${pluginName}:`, error);
            res.status(500).json({ error: `保存插件 ${pluginName} 配置时出错`, details: error.message });
        }
    });

    // Update command description
    router.post('/plugins/:pluginName/commands/:commandIdentifier/description', async (req, res) => {
        const { pluginName, commandIdentifier } = req.params;
        const { description } = req.body;
        if (typeof description !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { description: string }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetManifestPath = null;
            let manifest = null;
            let pluginFound = false;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let currentPath = null;
                    let manifestContent = null;

                    try {
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                        currentPath = potentialManifestPath;
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try {
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                                currentPath = potentialBlockedPath;
                            } catch (blockedErr) { continue; }
                        } else { continue; }
                    }

                    try {
                        const parsedManifest = JSON.parse(manifestContent);
                        if (parsedManifest.name === pluginName) {
                            targetManifestPath = currentPath;
                            manifest = parsedManifest;
                            pluginFound = true;
                            break;
                        }
                    } catch (parseErr) {
                        console.warn(`[AdminPanelRoutes] Error parsing manifest for ${folder.name}: ${parseErr.message}`);
                        continue;
                    }
                }
            }

            if (!pluginFound || !manifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' or its manifest file not found.` });
            }

            let commandUpdated = false;
            if (manifest.capabilities && manifest.capabilities.invocationCommands && Array.isArray(manifest.capabilities.invocationCommands)) {
                const commandIndex = manifest.capabilities.invocationCommands.findIndex(cmd => cmd.commandIdentifier === commandIdentifier || cmd.command === commandIdentifier);
                if (commandIndex !== -1) {
                    manifest.capabilities.invocationCommands[commandIndex].description = description;
                    commandUpdated = true;
                }
            }

            if (!commandUpdated) {
                return res.status(404).json({ error: `Command '${commandIdentifier}' not found in plugin '${pluginName}'.` });
            }

            await fs.writeFile(targetManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await pluginManager.loadPlugins();
            res.json({ message: `指令 '${commandIdentifier}' 在插件 '${pluginName}' 中的描述已更新并重新加载。` });
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error updating command description for plugin ${pluginName}, command ${commandIdentifier}:`, error);
            res.status(500).json({ error: `更新指令描述时出错`, details: error.message });
        }
    });

    // --- Preprocessor Order Management API ---
    router.get('/preprocessors/order', (req, res) => {
        try {
            const order = pluginManager.getPreprocessorOrder();
            res.json({ status: 'success', order });
        } catch (error) {
            console.error('[AdminAPI] Error getting preprocessor order:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get preprocessor order.' });
        }
    });

    router.post('/preprocessors/order', async (req, res) => {
        const { order } = req.body;
        if (!Array.isArray(order)) {
            return res.status(400).json({ status: 'error', message: 'Invalid request: "order" must be an array.' });
        }

        try {
            await fs.writeFile(PREPROCESSOR_ORDER_FILE, JSON.stringify(order, null, 2), 'utf-8');
            if (DEBUG_MODE) console.log('[AdminAPI] Saved new preprocessor order to file.');

            const newOrder = await pluginManager.hotReloadPluginsAndOrder();
            res.json({ status: 'success', message: 'Order saved and hot-reloaded successfully.', newOrder });
        } catch (error) {
            console.error('[AdminAPI] Error saving or hot-reloading preprocessor order:', error);
            res.status(500).json({ status: 'error', message: 'Failed to save or hot-reload preprocessor order.' });
        }
    });

    return router;
};

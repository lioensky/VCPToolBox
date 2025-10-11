const fs = require('fs').promises;
const path = require('path');
const ignore = require('ignore');
// Load environment variables from .env file in the same directory
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function _generateDirectoryTree(directoryPath, rootPath, ig, prefix = '', currentDepth = 0, maxDepth = Infinity) {
    if (currentDepth >= maxDepth) {
        return '';
    }

    let tree = '';
    try {
        const items = await fs.readdir(directoryPath);
        const visibleItems = [];

        for (const item of items) {
            const itemPath = path.join(directoryPath, item);
            let stats;
            try {
                stats = await fs.stat(itemPath);
            } catch (e) {
                continue;
            }

            const relativePath = path.relative(rootPath, itemPath).replace(/\\/g, '/');
            
            let isIgnored = false;
            if (stats.isDirectory()) {
                isIgnored = ig.ignores(relativePath + '/') || ig.ignores(relativePath);
            }
            else {
                isIgnored = ig.ignores(relativePath);
            }

            if (!isIgnored) {
                visibleItems.push({ name: item, path: itemPath, isDirectory: stats.isDirectory() });
            }
        }

        for (let i = 0; i < visibleItems.length; i++) {
            const item = visibleItems[i];
            const isLast = i === visibleItems.length - 1;
            const connector = isLast ? '└─' : '├─';

            tree += `${prefix}${connector} ${item.name}\n`;

            if (item.isDirectory) {
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                tree += await _generateDirectoryTree(item.path, rootPath, ig, newPrefix, currentDepth + 1, maxDepth);
            }
        }
    } catch (e) {
        return `\n[Error reading directory '${directoryPath}': ${e.message}]`;
    }
    return tree;
}

async function getTree(targetPath, maxDepth = Infinity) {
    const ig = ignore();
    const ignoreFilePath = path.join(targetPath, '.workspaceignore');
    try {
        const ignoreFileContent = await fs.readFile(ignoreFilePath, 'utf8');
        ig.add(ignoreFileContent);
    } catch (e) {
        // Ignore if file doesn't exist
    }
    return await _generateDirectoryTree(targetPath, targetPath, ig, '', 0, maxDepth);
}

async function processMessages(messages, config) {
    const debugMode = process.env.WORKSPACE_INJECTOR_DEBUG === 'true';

    if (debugMode) {
        console.log('\n--- [WorkspaceInjector DEBUG] ---');
        console.log('Starting processMessages...');
    }

    const workspaceAliasesString = config.WORKSPACE_ALIASES || '{}';
    let workspaceAliases;
    try {
        workspaceAliases = JSON.parse(workspaceAliasesString);
    } catch (e) {
        if (debugMode) console.error('[WorkspaceInjector DEBUG] Invalid JSON in WORKSPACE_ALIASES config from main config.env', e.message);
        return messages;
    }

    const workspaceRegex = /{{Workspace::(.*?)(?:::(\d+))?}}/gs;
    
    const newMessages = JSON.parse(JSON.stringify(messages));

    for (const msg of newMessages) {
        if (msg.role === 'system' && typeof msg.content === 'string') {
            if (!msg.content.includes('{{Workspace::')) continue;

            if (debugMode) {
                console.log('[WorkspaceInjector DEBUG] Found system message to process:', msg.content);
            }

            let tempContent = msg.content;
            const matches = Array.from(tempContent.matchAll(workspaceRegex));

            if (matches.length > 0) {
                for (const match of matches) {
                    const fullPlaceholder = match[0];
                    const content = match[1].trim();
                    const depthStr = match[2];
                    const maxDepth = depthStr ? parseInt(depthStr, 10) : Infinity;

                    if (debugMode) console.log(`[WorkspaceInjector DEBUG] Found placeholder: ${fullPlaceholder}, content: '${content}', depth: ${maxDepth}`);

                    let targetPath = null;
                    let isDirectPath = false;

                    // New logic for alias/subpath combination
                    if (content.includes('/')) {
                        const parts = content.split('/');
                        const alias = parts[0];
                        const subpath = parts.slice(1).join('/');
                        if (workspaceAliases[alias]) {
                            targetPath = path.join(workspaceAliases[alias], subpath);
                            if (debugMode) console.log(`[WorkspaceInjector DEBUG] Resolved alias/subpath '${content}' to '${targetPath}'`);
                        }
                    }

                    // Fallback to existing logic
                    if (!targetPath) {
                        try {
                            const stats = await fs.stat(content);
                            if (stats.isDirectory()) {
                                targetPath = content;
                                isDirectPath = true;
                                if (debugMode) console.log(`[WorkspaceInjector DEBUG] Content '${content}' is a direct path.`);
                            }
                        } catch (e) { /* Not a direct path */ }

                        if (!targetPath && workspaceAliases[content]) {
                            targetPath = workspaceAliases[content];
                            if (debugMode) console.log(`[WorkspaceInjector DEBUG] Found alias '${content}' mapping to '${targetPath}'`);
                        }
                    }

                    let replacement = `[Error: Workspace alias or path '${content}' is invalid or not found.]`;

                    if (targetPath) {
                        const tree = await getTree(targetPath, maxDepth);
                        if (tree.includes('[Error reading directory')) {
                            replacement = tree;
                        } else {
                            const displayName = isDirectPath ? targetPath : `${content} (${targetPath})`;
                            replacement = `\n[Workspace: ${displayName}]\n${tree}`;
                        }
                        if (debugMode) console.log(`[WorkspaceInjector DEBUG] Replacement content generated for '${content}'.`);
                    } else {
                        if (debugMode) console.log(`[WorkspaceInjector DEBUG] Could not resolve a valid path for '${content}'.`);
                    }
                    
                    tempContent = tempContent.replace(fullPlaceholder, replacement);
                }
                msg.content = tempContent;
            }
        }
    }
    
    if (debugMode) {
        console.log('[WorkspaceInjector DEBUG] Finished processMessages.');
        console.log('--- [END WorkspaceInjector DEBUG] ---\n');
    }

    return newMessages;
}

module.exports = {
    processMessages
};

// modules/ipc/notesHandlers.js

const { ipcMain, BrowserWindow, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs-extra');

let notesWindow = null;
let openChildWindows = []; // To keep track of open windows for broadcasting
let APP_DATA_ROOT_IN_PROJECT;
let NOTES_DIR;
let SETTINGS_FILE;
let NETWORK_NOTES_CACHE_FILE;
let networkNotesTreeCache = null; // In-memory cache

// Helper to check if a file path is on the network notes drive
async function isNetworkNote(filePath) {
    try {
        if (await fs.pathExists(SETTINGS_FILE)) {
            const settings = await fs.readJson(SETTINGS_FILE);
            // Support both new array and legacy string format
            const networkPaths = Array.isArray(settings.networkNotesPaths)
                ? settings.networkNotesPaths
                : (settings.networkNotesPath ? [settings.networkNotesPath] : []);

            if (networkPaths.length > 0) {
                for (const p of networkPaths) {
                    if (p && filePath.startsWith(p)) {
                        return true;
                    }
                }
            }
        }
    } catch (e) { console.error("Error checking for network note:", e); }
    return false;
}

// 辅助函数：生成唯一路径，避免文件覆盖
async function generateUniquePath(basePath) {
    const dir = path.dirname(basePath);
    const ext = path.extname(basePath);
    const nameWithoutExt = path.basename(basePath, ext);
    
    let counter = 1;
    let newPath = basePath;
    
    while (await fs.pathExists(newPath)) {
        newPath = path.join(dir, `${nameWithoutExt} (${counter})${ext}`);
        counter++;
    }
    
    return newPath;
}

// Helper function to recursively read the directory structure
async function readDirectoryStructure(dirPath) {
    const items = [];
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    const orderFilePath = path.join(dirPath, '.folder-order.json');
    let orderedIds = [];

    try {
        if (await fs.pathExists(orderFilePath)) {
            const orderData = await fs.readJson(orderFilePath);
            orderedIds = orderData.order || [];
        }
    } catch (e) {
        console.error(`Error reading order file ${orderFilePath}:`, e);
    }

    for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.name.startsWith('.') || file.name.endsWith('.json')) continue; // Skip order and hidden files

        if (file.isDirectory()) {
            items.push({
                id: `folder-${Buffer.from(fullPath).toString('hex')}`,
                type: 'folder',
                name: file.name,
                path: fullPath,
                children: await readDirectoryStructure(fullPath)
            });
        } else if (file.isFile() && (file.name.endsWith('.txt') || file.name.endsWith('.md'))) {
            try {
                const content = await fs.readFile(fullPath, 'utf8');
                const lines = content.split('\n');
                const id = `note-${Buffer.from(fullPath).toString('hex')}`;

                let title, username, timestamp, noteContent;

                // Always use the filename (without extension) as the default title.
                title = path.basename(file.name, path.extname(file.name));

                // Check if the first line is a valid header that should be stripped.
                const header = lines[0];
                const parts = header ? header.split('-') : [];
                const potentialTimestamp = parts.length > 0 ? parseInt(parts[parts.length - 1], 10) : NaN;

                // A header is valid if it has >= 3 parts & the last part is a number (our timestamp).
                if (parts.length >= 3 && !isNaN(potentialTimestamp) && potentialTimestamp > 0) {
                    // It's a valid header. Use its metadata and strip it from the content.
                    username = parts[parts.length - 2]; // Second to last part is username
                    timestamp = potentialTimestamp;
                    noteContent = lines.slice(1).join('\n');
                    
                    // Use the title from the header, but fall back to filename if header title is empty.
                    const headerTitle = parts.slice(0, -2).join('-');
                    title = headerTitle || path.basename(file.name, path.extname(file.name));
                } else {
                    // It's not a valid header. Use the full content and file mtime.
                    noteContent = content;
                    username = 'unknown';
                    timestamp = (await fs.stat(fullPath)).mtime.getTime();
                }

                items.push({
                    id,
                    type: 'note',
                    title,
                    username,
                    timestamp,
                    content: noteContent,
                    fileName: file.name,
                    path: fullPath
                });
            } catch (readError) {
                console.error(`Error reading note file ${file.name}:`, readError);
            }
        }
    }

    // Sort items based on the .folder-order.json file, with fallbacks
    items.sort((a, b) => {
        const indexA = orderedIds.indexOf(a.id);
        const indexB = orderedIds.indexOf(b.id);

        if (indexA !== -1 && indexB !== -1) {
            return indexA - indexB; // Both are in the order file
        }
        if (indexA !== -1) return -1; // Only A is in the order file, so it comes first
        if (indexB !== -1) return 1;  // Only B is in the order file, so it comes first

        // Fallback for items not in the order file: folders first, then by name
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        const nameA = a.name || a.title;
        const nameB = b.name || b.title;
        return nameA.localeCompare(nameB);
    });

    return items;
}

// Centralized function to scan network notes, update cache, and notify renderer
async function scanAndCacheNetworkNotes() {
    return new Promise(async (resolve, reject) => {
        try {
            if (await fs.pathExists(SETTINGS_FILE)) {
                const settings = await fs.readJson(SETTINGS_FILE);
                const networkPaths = Array.isArray(settings.networkNotesPaths)
                    ? settings.networkNotesPaths
                    : (settings.networkNotesPath ? [settings.networkNotesPath] : []);

                if (networkPaths.length === 0) {
                    networkNotesTreeCache = [];
                    await fs.remove(NETWORK_NOTES_CACHE_FILE);
                    if (notesWindow && !notesWindow.isDestroyed()) {
                        notesWindow.webContents.send('network-notes-scanned', []);
                    }
                    resolve([]); // Resolve with empty array
                    return;
                }

                const allNetworkTrees = [];
                for (const networkPath of networkPaths) {
                    if (networkPath && (await fs.pathExists(networkPath))) {
                        console.log(`[scanAndCacheNetworkNotes] Starting async scan of: ${networkPath}`);
                        const networkNotes = await readDirectoryStructure(networkPath);
                        const rootName = path.basename(networkPath) || networkPath;
                        const networkTree = {
                            id: `folder-network-root-${Buffer.from(networkPath).toString('hex')}`,
                            type: 'folder',
                            name: `☁️ ${rootName}`,
                            path: networkPath,
                            children: networkNotes,
                            isNetwork: true,
                            isRoot: true
                        };
                        allNetworkTrees.push(networkTree);
                    } else {
                        console.warn(`[scanAndCacheNetworkNotes] Network path not found or is invalid: ${networkPath}`);
                    }
                }

                networkNotesTreeCache = allNetworkTrees;
                if (allNetworkTrees.length > 0) {
                    await fs.writeJson(NETWORK_NOTES_CACHE_FILE, allNetworkTrees);
                } else {
                    await fs.remove(NETWORK_NOTES_CACHE_FILE);
                }

                if (notesWindow && !notesWindow.isDestroyed()) {
                    notesWindow.webContents.send('network-notes-scanned', allNetworkTrees);
                }
                resolve(allNetworkTrees); // Resolve promise with the result
            } else {
                resolve([]); // Resolve if no settings file exists
            }
        } catch (e) {
            console.error('Error during async network notes scan:', e);
            if (notesWindow && !notesWindow.isDestroyed()) {
                notesWindow.webContents.send('network-notes-scan-error', { error: e.message });
            }
            reject(e); // Reject promise on error
        }
    });
}

// --- Singleton Notes Window Creation Function ---
function createOrFocusNotesWindow() {
    if (notesWindow && !notesWindow.isDestroyed()) {
        console.log('[Main Process] Notes window already exists. Focusing it.');
        notesWindow.focus();
        return notesWindow;
    }

    console.log('[Main Process] Creating new notes window instance.');
    notesWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        title: '我的笔记',
        frame: false, // 移除原生窗口框架
        titleBarStyle: 'hidden', // 隐藏标题栏
        modal: false,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'), // Corrected path
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        },
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'), // Corrected path
        show: false
    });

    const notesUrl = `file://${path.join(__dirname, '..', '..', 'Notemodules', 'notes.html')}`; // Corrected path
    notesWindow.loadURL(notesUrl);
    
    openChildWindows.push(notesWindow); // Add to the broadcast list
    notesWindow.setMenu(null);

    notesWindow.once('ready-to-show', () => {
        notesWindow.show();
    });

    notesWindow.on('closed', () => {
        console.log('[Main Process] Notes window has been closed.');
        openChildWindows = openChildWindows.filter(win => win !== notesWindow); // Remove from broadcast list
        notesWindow = null; // Clear the reference
    });
    
    return notesWindow;
}

function initialize(options) {
    openChildWindows = options.openChildWindows;
    APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    NOTES_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
    SETTINGS_FILE = options.SETTINGS_FILE;
    NETWORK_NOTES_CACHE_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'network-notes-cache.json');

    fs.ensureDirSync(NOTES_DIR); // Ensure the Notes directory exists

    // --- Start of New/Updated Notes IPC Handlers ---

    // IPC handler to read only the LOCAL note tree structure for fast initial load
    ipcMain.handle('read-notes-tree', async () => {
        try {
            return await readDirectoryStructure(NOTES_DIR);
        } catch (error) {
            console.error('读取本地笔记结构失败:', error);
            return { error: error.message };
        }
    });

    // IPC handler to trigger the ASYNCHRONOUS scanning of network notes
    ipcMain.on('scan-network-notes', () => {
        scanAndCacheNetworkNotes();
    });

    // IPC handler to get the cached network notes tree for faster startup
    ipcMain.handle('get-cached-network-notes', async () => {
        // Now returns an array of trees or an empty array
        return await fs.pathExists(NETWORK_NOTES_CACHE_FILE) ? await fs.readJson(NETWORK_NOTES_CACHE_FILE) : [];
    });

    // IPC handler to write a note file
    ipcMain.handle('write-txt-note', async (event, noteData) => {
        try {
            const { title, username, timestamp, content, oldFilePath, directoryPath, ext } = noteData;
            
            let filePath;
            let isNewNote = false;

            if (oldFilePath && await fs.pathExists(oldFilePath)) {
                // This is an existing note. Use its path. DO NOT RENAME.
                filePath = oldFilePath;
            } else {
                // This is a new note. Create a new path.
                isNewNote = true;
                const targetDir = directoryPath || NOTES_DIR;
                await fs.ensureDir(targetDir);
                const extension = ext || '.md'; // Use provided ext, or default to .md
                const newFileName = `${title}${extension}`;
                filePath = path.join(targetDir, newFileName);

                if (await fs.pathExists(filePath)) {
                    throw new Error(`A note named '${title}' already exists.`);
                }
            }

            const fileContent = `${title}-${username}-${timestamp}\n${content}`;
            await fs.writeFile(filePath, fileContent, 'utf8');
            console.log(`Note content saved to: ${filePath}`);

            // If it's a network note, trigger a background rescan
            if (await isNetworkNote(filePath)) {
                console.log(`Network note saved: ${filePath}. Triggering background rescan.`);
                setImmediate(scanAndCacheNetworkNotes);
            }
            
            const newId = `note-${Buffer.from(filePath).toString('hex')}`;
            return {
                success: true,
                filePath: filePath,
                fileName: path.basename(filePath),
                id: newId,
                isNewNote: isNewNote // Let the frontend know if it was a creation
            };
        } catch (error) {
            console.error('[Main Process - write-txt-note] Failed to save note:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to delete a file or a folder
    ipcMain.handle('delete-item', async (event, itemPath) => {
        try {
            if (await fs.pathExists(itemPath)) {
                const isNetwork = await isNetworkNote(itemPath);

                if (isNetwork) {
                    // For network paths, use direct deletion as trashItem can be unreliable.
                    await fs.remove(itemPath);
                    console.log(`Item permanently deleted (network): ${itemPath}`);
                } else {
                    // For local paths, move to trash.
                    await shell.trashItem(itemPath);
                    console.log(`Item moved to trash (local): ${itemPath}`);
                }

                if (isNetwork) {
                    console.log(`Network item deleted: ${itemPath}. Triggering background rescan.`);
                    setImmediate(scanAndCacheNetworkNotes);
                }
                
                // Let the renderer know if it should wait for a network scan or reload local immediately.
                return { success: true, networkRescanTriggered: isNetwork };
            }
            return { success: false, error: 'Item not found.' };
        } catch (error) {
            console.error('Failed to delete item:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to create a new folder
    ipcMain.handle('create-note-folder', async (event, { parentPath, folderName }) => {
        try {
            const newFolderPath = path.join(parentPath, folderName);
            if (await fs.pathExists(newFolderPath)) {
                return { success: false, error: 'A folder with the same name already exists.' };
            }
            await fs.ensureDir(newFolderPath);
            console.log(`Folder created: ${newFolderPath}`);

            // If it's a network folder, trigger a background rescan
            if (await isNetworkNote(newFolderPath)) {
                console.log(`Network folder created: ${newFolderPath}. Triggering background rescan.`);
                setImmediate(scanAndCacheNetworkNotes);
            }

            const newId = `folder-${Buffer.from(newFolderPath).toString('hex')}`;
            return { success: true, path: newFolderPath, id: newId };
        } catch (error) {
            console.error('Failed to create folder:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to rename a file or folder
    ipcMain.handle('rename-item', async (event, { oldPath, newName, newContentBody, ext }) => {
        try {
            const parentDir = path.dirname(oldPath);
            const stat = await fs.stat(oldPath);
            const isDirectory = stat.isDirectory();
            
            const sanitizedNewName = newName.replace(/[\\/:*?"<>|]/g, '');
            if (!sanitizedNewName) {
                return { success: false, error: 'Invalid name provided.' };
            }

            const newPath = isDirectory
                ? path.join(parentDir, sanitizedNewName)
                : path.join(parentDir, sanitizedNewName + (ext || path.extname(oldPath)));

            if (oldPath === newPath) {
                // If only content is changing, not the name, we should still proceed.
                if (newContentBody === undefined) {
                    return { success: true, newPath, id: `${isDirectory ? 'folder' : 'note'}-${Buffer.from(oldPath).toString('hex')}` };
                }
            }

            if (oldPath !== newPath && await fs.pathExists(newPath)) {
                return { success: false, error: 'A file or folder with the same name already exists.' };
            }

            if (isDirectory) {
                // For directories, rename the folder AND update the parent's order file.
                await fs.rename(oldPath, newPath);
                
                const orderFilePath = path.join(parentDir, '.folder-order.json');
                if (await fs.pathExists(orderFilePath)) {
                    try {
                        const orderData = await fs.readJson(orderFilePath);
                        const oldId = `folder-${Buffer.from(oldPath).toString('hex')}`;
                        const newId = `folder-${Buffer.from(newPath).toString('hex')}`;
                        const itemIndex = orderData.order.indexOf(oldId);
                        if (itemIndex !== -1) {
                            orderData.order[itemIndex] = newId;
                            await fs.writeJson(orderFilePath, orderData, { spaces: 2 });
                        }
                    } catch (e) {
                        console.error(`Failed to update order file during folder rename: ${orderFilePath}`, e);
                        // Don't block the rename operation if order update fails
                    }
                }
            } else {
                // For notes, we need to update the content AND potentially the filename.
                const content = await fs.readFile(oldPath, 'utf8');
                const lines = content.split('\n');
                let newFileContent = content; // Default to old content if header is malformed

                if (lines.length > 0) {
                    const header = lines[0];
                    const oldContentBody = lines.slice(1).join('\n');
                    const contentBody = newContentBody !== undefined ? newContentBody : oldContentBody;
                    
                    const parts = header.split('-');
                    if (parts.length >= 3) {
                        const timestampStr = parts.pop();
                        const username = parts.pop();
                        // The original title is parts.join('-'), but we don't need it.
                        
                        const newHeader = `${sanitizedNewName}-${username}-${timestampStr}`;
                        newFileContent = `${newHeader}\n${contentBody}`;
                    }
                }
                
                // If the path is the same, just overwrite. If different, write new and remove old.
                await fs.writeFile(newPath, newFileContent, 'utf8');
                if (oldPath !== newPath) {
                    await fs.remove(oldPath);
                }

                // Update order file for notes as well
                const orderFilePath = path.join(parentDir, '.folder-order.json');
                if (await fs.pathExists(orderFilePath)) {
                    try {
                        const orderData = await fs.readJson(orderFilePath);
                        const oldId = `note-${Buffer.from(oldPath).toString('hex')}`;
                        const newId = `note-${Buffer.from(newPath).toString('hex')}`;
                        const itemIndex = orderData.order.indexOf(oldId);
                        if (itemIndex !== -1) {
                            orderData.order[itemIndex] = newId;
                            await fs.writeJson(orderFilePath, orderData, { spaces: 2 });
                        }
                    } catch (e) {
                        console.error(`Failed to update order file during note rename: ${orderFilePath}`, e);
                    }
                }
            }

            console.log(`Renamed/Updated successfully: from ${oldPath} to ${newPath}`);

            // If it's a network item, trigger a background rescan
            if (await isNetworkNote(newPath)) {
                console.log(`Network item renamed/moved: ${newPath}. Triggering background rescan.`);
                setImmediate(scanAndCacheNetworkNotes);
            }
            
            const type = isDirectory ? 'folder' : 'note';
            const newId = `${type}-${Buffer.from(newPath).toString('hex')}`;
            return { success: true, newPath, newId };
        } catch (error) {
            console.error('Rename failed:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to move files/folders (Refactored for clarity and single source of truth)
    ipcMain.handle('notes:move-items', async (event, { sourcePaths, target }) => {
        const { destPath, targetId, position } = target;

        const moveTransaction = {
            items: [],
            renamedItems: [],
            rollback: async () => {
                console.log('Rolling back move transaction...');
                for (const item of moveTransaction.items.reverse()) {
                    if (item.moved && await fs.pathExists(item.newPath)) {
                        try {
                            await fs.move(item.newPath, item.oldPath, { overwrite: false }); // Rollback without overwriting
                            console.log(`Rolled back: ${item.newPath} -> ${item.oldPath}`);
                        } catch (rollbackError) {
                            console.error(`Failed to rollback ${item.newPath} to ${item.oldPath}:`, rollbackError);
                        }
                    }
                }
            }
        };

        try {
            // --- Step 1: Validate and prepare all move operations ---
            for (const oldPath of sourcePaths) {
                const itemName = path.basename(oldPath);
                let newPath = path.join(destPath, itemName);

                if (newPath.startsWith(oldPath + path.sep)) {
                    throw new Error('Invalid move: Cannot move a folder into itself.');
                }
                
                let wasRenamed = false;
                if (oldPath.toLowerCase() !== newPath.toLowerCase() && await fs.pathExists(newPath)) {
                    const uniquePath = await generateUniquePath(newPath);
                    moveTransaction.renamedItems.push({ oldPath: oldPath, newPath: uniquePath });
                    newPath = uniquePath;
                    wasRenamed = true;
                }
                
                moveTransaction.items.push({ oldPath, newPath, moved: false, wasRenamed });
            }

            // --- Step 2: Execute all move operations ---
            for (const item of moveTransaction.items) {
                if (item.oldPath.toLowerCase() !== item.newPath.toLowerCase()) {
                    try {
                        await fs.move(item.oldPath, item.newPath, { overwrite: false }); // Use overwrite: false
                        item.moved = true;
                    } catch (error) {
                        await moveTransaction.rollback(); // Rollback on failure
                        throw new Error(`Failed to move ${item.oldPath} to ${item.newPath}: ${error.message}`);
                    }
                }
            }

            // --- Step 3: Update order files ---
            const sourceDir = path.dirname(sourcePaths[0]);
            const itemStats = await Promise.all(moveTransaction.items.map(item => fs.stat(item.newPath)));
            
            const movedItems = moveTransaction.items.map((item, index) => {
                const type = itemStats[index].isDirectory() ? 'folder' : 'note';
                return {
                    oldId: `${type}-${Buffer.from(item.oldPath).toString('hex')}`,
                    newId: `${type}-${Buffer.from(item.newPath).toString('hex')}`,
                    id: `${type}-${Buffer.from(item.newPath).toString('hex')}`
                };
            });

            const movedIdsSet = new Set(movedItems.map(i => i.id));
            const movedOldIdsSet = new Set(movedItems.map(i => i.oldId));
            const newIdsArray = movedItems.map(i => i.id);

            if (sourceDir !== destPath) {
                const sourceOrderPath = path.join(sourceDir, '.folder-order.json');
                if (await fs.pathExists(sourceOrderPath)) {
                    try {
                        const sourceOrder = await fs.readJson(sourceOrderPath);
                        sourceOrder.order = sourceOrder.order.filter(id => !movedOldIdsSet.has(id));
                        if(sourceOrder.order.length > 0) await fs.writeJson(sourceOrderPath, sourceOrder, { spaces: 2 });
                        else await fs.remove(sourceOrderPath);
                    } catch(e) { console.error(`Could not process source order file ${sourceOrderPath}:`, e); }
                }
            }
            
            const destOrderPath = path.join(destPath, '.folder-order.json');
            let destOrderIds = [];
            if (await fs.pathExists(destOrderPath)) {
                try { destOrderIds = (await fs.readJson(destOrderPath)).order || []; } catch(e) { console.error(`Could not read dest order file ${destOrderPath}:`, e); }
            }

            let finalOrder = destOrderIds.filter(id => !movedIdsSet.has(id));
            if (targetId && position !== 'inside') {
                const targetIndex = finalOrder.indexOf(targetId);
                if (targetIndex !== -1) {
                    finalOrder.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, ...newIdsArray);
                } else {
                    finalOrder.push(...newIdsArray);
                }
            } else {
                finalOrder.unshift(...newIdsArray);
            }
            await fs.writeJson(destOrderPath, { order: finalOrder }, { spaces: 2 });


            // --- Step 4: Sync network notes if necessary ---
            const isMovingToNetwork = await isNetworkNote(destPath);
            const isMovingFromNetwork = await isNetworkNote(sourcePaths[0]);
            if (isMovingToNetwork || isMovingFromNetwork) {
                console.log(`Network items moved. Waiting for synchronous rescan.`);
                await scanAndCacheNetworkNotes(); // Synchronously wait for the scan to complete
            }

// 在移动操作成功后
            console.log(`Successfully moved ${moveTransaction.items.length} items`);
            if (moveTransaction.renamedItems.length > 0) {
            console.log(`Auto-renamed ${moveTransaction.renamedItems.length} items to avoid conflicts`);
            }
            
            return { success: true, movedItems: moveTransaction.items, renamedItems: moveTransaction.renamedItems };

        } catch (error) {
            console.error('Move operation failed:', error);
            // Rollback is already handled in the catch block inside the loop.
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('copy-note-content', async (event, filePath) => {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n').slice(1).join('\n'); // Get content without header
            clipboard.writeText(lines);
            return { success: true };
        } catch (error) {
            console.error('Failed to copy note content:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to get the root directory for notes
    ipcMain.handle('get-notes-root-dir', () => {
        return NOTES_DIR;
    });

    ipcMain.handle('open-notes-window', () => {
        createOrFocusNotesWindow();
    });

    ipcMain.handle('open-notes-with-content', async (event, data) => {
        const targetWindow = createOrFocusNotesWindow();
        const wc = targetWindow.webContents;

        // If the window is already loaded (not new), send the data immediately.
        if (!wc.isLoading()) {
            console.log(`[Main Process] Notes window already loaded. Sending shared content immediately.`);
            wc.send('shared-note-data', data);
            return;
        }

        // If the window is new and loading, wait for our custom 'ready' signal.
        console.log(`[Main Process] Notes window is new. Waiting for 'notes-window-ready' signal...`);
        ipcMain.once('notes-window-ready', (e) => {
            // Ensure the signal came from the window we just created.
            if (e.sender === wc) {
                console.log(`[Main Process] Received 'notes-window-ready' signal. Sending shared content.`);
                wc.send('shared-note-data', data);
            }
        });
    });

    // IPC handler for searching notes
    ipcMain.handle('search-notes', async (event, query) => {
        if (!query) {
            return [];
        }
        const lowerCaseQuery = query.toLowerCase();
        const results = [];
        const NOTES_MODULE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Notemodules');

        async function searchInDirectory(directory) {
            try {
                const files = await fs.readdir(directory, { withFileTypes: true });
                for (const file of files) {
                    const fullPath = path.join(directory, file.name);
                    if (file.isDirectory()) {
                        await searchInDirectory(fullPath);
                    } else if (file.isFile() && (file.name.endsWith('.md') || file.name.endsWith('.txt'))) {
                        if (file.name.toLowerCase().includes(lowerCaseQuery)) {
                            results.push({
                                name: file.name,
                                path: fullPath,
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`Error searching for notes in directory ${directory}:`, error);
            }
        }

        await searchInDirectory(NOTES_MODULE_DIR);
        return results;
    });
}

module.exports = { 
    initialize,
    createOrFocusNotesWindow: () => createOrFocusNotesWindow(),
    getNotesWindow: () => notesWindow
};
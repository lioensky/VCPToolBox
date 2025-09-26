// modules/ipc/themeHandlers.js

const { ipcMain, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const sharp = require('sharp');

let themesWindow = null;
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let WALLPAPER_THUMBNAIL_CACHE_DIR;
let PROJECT_ROOT;

function createThemesWindow() {
    if (themesWindow && !themesWindow.isDestroyed()) {
        themesWindow.focus();
        return;
    }
    themesWindow = new BrowserWindow({
        width: 850,
        height: 700,
        title: '主题选择',
        modal: false,
        frame: false, // 移除原生窗口框架
        titleBarStyle: 'hidden', // 隐藏标题栏
        webPreferences: {
            preload: path.join(PROJECT_ROOT, 'preload.js'),
            contextIsolation: true,
        },
        icon: path.join(PROJECT_ROOT, 'assets', 'icon.png'),
        show: false,
    });

    themesWindow.loadFile(path.join(PROJECT_ROOT, 'Themesmodules/themes.html'));
    themesWindow.setMenu(null);
    openChildWindows.push(themesWindow);
    
    themesWindow.once('ready-to-show', () => {
        themesWindow.show();
    });

    themesWindow.on('closed', () => {
        openChildWindows = openChildWindows.filter(win => win !== themesWindow);
        themesWindow = null;
    });
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    PROJECT_ROOT = options.projectRoot;
    WALLPAPER_THUMBNAIL_CACHE_DIR = path.join(options.APP_DATA_ROOT_IN_PROJECT, 'WallpaperThumbnailCache');

    ipcMain.on('open-themes-window', () => {
        createThemesWindow();
    });

    // Listen for theme changes and notify all relevant windows
    nativeTheme.on('updated', () => {
        const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        broadcastThemeUpdate(theme);
    });

    // Allow renderer processes to get the current theme
    ipcMain.handle('get-current-theme', () => {
        return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    });

    ipcMain.handle('get-themes', async () => {
        const themesDir = path.join(PROJECT_ROOT, 'styles', 'themes');
        const files = await fs.readdir(themesDir);
        const themePromises = files
            .filter(file => file.startsWith('themes') && file.endsWith('.css'))
            .map(async (file) => {
                const filePath = path.join(themesDir, file);
                const content = await fs.readFile(filePath, 'utf-8');
                
                const nameMatch = content.match(/\* Theme Name: (.*)/);
                const name = nameMatch ? nameMatch[1].trim() : path.basename(file, '.css').replace('themes', '');

                const extractVariables = (scopeRegex) => {
                    const scopeMatch = content.match(scopeRegex);
                    if (!scopeMatch || !scopeMatch[1]) return {};
                    
                    const variables = {};
                    const varRegex = /(--[\w-]+)\s*:\s*(.*?);/g;
                    let match;
                    while ((match = varRegex.exec(scopeMatch[1])) !== null) {
                        variables[match[1]] = match[2].trim();
                    }
                    return variables;
                };

                const rootScopeRegex = /:root\s*\{([\s\S]*?)\}/;
                const lightThemeScopeRegex = /body\.light-theme\s*\{([\s\S]*?)\}/;

                const darkVariables = extractVariables(rootScopeRegex);
                const lightVariables = extractVariables(lightThemeScopeRegex);

                return {
                    fileName: file,
                    name: name,
                    variables: {
                        dark: darkVariables,
                        light: lightVariables
                    }
                };
            });
        return Promise.all(themePromises);
    });

    ipcMain.on('apply-theme', async (event, themeFileName) => {
        try {
            const sourcePath = path.join(PROJECT_ROOT, 'styles', 'themes', themeFileName);
            const targetPath = path.join(PROJECT_ROOT, 'styles', 'themes.css');
            const themeContent = await fs.readFile(sourcePath, 'utf-8');
            await fs.writeFile(targetPath, themeContent, 'utf-8');
            
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.reload();
            }
            if (themesWindow && !themesWindow.isDestroyed()) {
                themesWindow.reload();
            }
        } catch (error) {
            console.error('Failed to apply theme:', error);
        }
    });

    ipcMain.handle('get-wallpaper-thumbnail', async (event, rawPath) => {
        const THUMBNAIL_WIDTH = 400;

        if (!rawPath || typeof rawPath !== 'string' || rawPath === 'none') {
            throw new Error('Invalid path provided for thumbnail generation.');
        }

        const match = rawPath.match(/url\(['"]?(.*?)['"]?\)/);
        const cleanedPath = match ? match[1] : rawPath;

        const absolutePath = path.resolve(PROJECT_ROOT, 'Themesmodules', cleanedPath);

        const hash = crypto.createHash('md5').update(absolutePath).digest('hex');
        const thumbnailFilename = `${hash}.jpeg`;
        const cachedThumbnailPath = path.join(WALLPAPER_THUMBNAIL_CACHE_DIR, thumbnailFilename);

        try {
            if (await fs.pathExists(cachedThumbnailPath)) {
                return cachedThumbnailPath;
            }
        } catch (e) {
            console.error(`Error checking for existing thumbnail: ${cachedThumbnailPath}`, e);
        }

        try {
            if (!(await fs.pathExists(absolutePath))) {
                throw new Error(`Original wallpaper file not found at: ${absolutePath}`);
            }
        } catch (e) {
            console.error(e.message);
            throw e;
        }

        try {
            await sharp(absolutePath)
                .resize(THUMBNAIL_WIDTH)
                .jpeg({ quality: 80 })
                .toFile(cachedThumbnailPath);

            console.log(`Generated thumbnail for ${absolutePath} at ${cachedThumbnailPath}`);
            return cachedThumbnailPath;
        } catch (error) {
            console.error(`Sharp failed to generate thumbnail for ${absolutePath}:`, error);
            throw error;
        }
    });
}

// Function to broadcast theme updates to all windows
function broadcastThemeUpdate(theme) {
    console.log(`[ThemeHandlers] Theme updated to: ${theme}. Notifying windows.`);
    const windows = [mainWindow, ...openChildWindows];
    windows.forEach(win => {
        if (win && !win.isDestroyed()) {
            // Also include assistant windows, dice window etc if they are managed separately
            // For now, this covers main and any direct children in openChildWindows
            win.webContents.send('theme-updated', theme);
        }
    });
}

module.exports = {
    initialize,
    broadcastThemeUpdate
};
// modules/ipc/windowHandlers.js
const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');

/**
 * Initializes window control IPC handlers.
 * @param {BrowserWindow} mainWindow The main window instance.
 * @param {BrowserWindow[]} openChildWindows - A reference to the array holding all open child windows.
 */
function initialize(mainWindow, openChildWindows) {
    // --- Window Control IPC Handlers ---
    ipcMain.on('minimize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.minimize();
        }
    });

    ipcMain.on('maximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        }
    });

    ipcMain.on('unmaximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.unmaximize();
        }
    });

    ipcMain.on('close-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            // If it's the main window, quit the app. Otherwise, just close the child window.
            if (win === mainWindow) {
                app.quit();
            } else {
                win.close();
            }
        }
    });

    ipcMain.on('toggle-notifications-sidebar', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('do-toggle-notifications-sidebar');
        }
    });

    ipcMain.on('open-dev-tools', () => {
        console.log('[Main Process] Received open-dev-tools event.'); 
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
            console.log('[Main Process] Attempting to open detached dev tools.'); 
        } else {
            console.error('[Main Process] Cannot open dev tools: mainWindow or webContents is not available or destroyed.'); 
            if (!mainWindow) console.error('[Main Process] mainWindow is null or undefined.');
            else if (!mainWindow.webContents) console.error('[Main Process] mainWindow.webContents is null or undefined.');
            else if (mainWindow.webContents.isDestroyed()) console.error('[Main Process] mainWindow.webContents is destroyed.');
        }
    });

    ipcMain.on('open-image-viewer', (event, { src, title, theme }) => {
        const imageViewerWindow = new BrowserWindow({
            width: 1000,
            height: 800,
            minWidth: 600,
            minHeight: 500,
            title: title || '图片预览',
            modal: false,
            frame: false, // 移除原生窗口框架
            titleBarStyle: 'hidden', // 隐藏标题栏
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'), // Correct path from this file's location
                contextIsolation: true,
                nodeIntegration: false,
            },
            icon: path.join(__dirname, '../../assets/icon.png'), // Correct path from this file's location
            show: false,
        });

        imageViewerWindow.setMenu(null);

        const url = `file://${path.join(__dirname, '../../modules/image-viewer.html')}?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title)}&theme=${encodeURIComponent(theme || 'dark')}`;
        imageViewerWindow.loadURL(url);
 
         imageViewerWindow.once('ready-to-show', () => {
            imageViewerWindow.show();
        });

        // Add to the list of open windows to receive theme updates
        openChildWindows.push(imageViewerWindow);

        imageViewerWindow.on('closed', () => {
            // Remove from the list when closed
            const index = openChildWindows.indexOf(imageViewerWindow);
            if (index > -1) {
                openChildWindows.splice(index, 1);
            }
        });
    });
}

module.exports = {
    initialize
};
// modules/ipc/diceHandlers.js

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const express = require('express');

let diceWindow = null;
let diceServer = null;

// --- Dice Server and Window Creation ---
function startDiceServer(projectRoot) {
    return new Promise((resolve, reject) => {
        if (diceServer && diceServer.listening) {
            console.log('Dice server is already running on port 6677.');
            return resolve();
        }

        const app = express();
        const port = 6677;

        // Serve static files from the project root
        app.use('/', express.static(path.join(projectRoot, 'Dicemodules')));
        app.use('/node_modules', express.static(path.join(projectRoot, 'node_modules')));
        app.use('/styles', express.static(path.join(projectRoot, 'styles')));
        app.use('/assets', express.static(path.join(projectRoot, 'assets')));

        diceServer = app.listen(port, () => {
            console.log(`Dice server started on http://localhost:${port}`);
            resolve();
        }).on('error', (err) => {
            console.error('Failed to start dice server:', err);
            reject(err);
        });
    });
}

async function createOrFocusDiceWindow(projectRoot) {
    try {
        await startDiceServer(projectRoot); // Ensure the server is running
    } catch (error) {
        console.error("Cannot create dice window because server failed to start.", error);
        dialog.showErrorBox("骰子服务启动失败", "无法启动后台Web服务器，请检查端口6677是否被占用。");
        return; // Stop if server fails
    }

    if (diceWindow && !diceWindow.isDestroyed()) {
        console.log('[Dice] Dice window already exists. Focusing it.');
        diceWindow.focus();
        return;
    }

    console.log('[Dice] Creating new dice window instance.');
    diceWindow = new BrowserWindow({
        width: 400,
        height: 600,
        minWidth: 300,
        minHeight: 400,
        title: '超级骰子',
        modal: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        },
        icon: path.join(projectRoot, 'assets', 'icon.png'),
        show: false
    });

    // Load the dice page from our local web server
    diceWindow.loadURL('http://localhost:6677/dice.html');
    
    diceWindow.setMenu(null);

    diceWindow.once('ready-to-show', () => {
        diceWindow.show();
    });

    diceWindow.on('closed', () => {
        diceWindow = null;
    });

    diceWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error(`[Dice] Dice window failed to load: ${errorDescription} (code: ${errorCode})`);
    });
}

// --- Dice Control Handler ---
async function handleDiceControl(args) {
    const { notation, themecolor } = args;
    console.log(`[DiceControl] Received command: roll, Notation: ${notation}, ThemeColor: ${themecolor}`);

    const options = {};
    if (themecolor) {
        options.themeColor = themecolor;
    }

    try {
        // We need projectRoot to create the window if it doesn't exist.
        // This assumes initialize has been called.
        const projectRoot = path.join(__dirname, '..', '..');
        await createOrFocusDiceWindow(projectRoot);

        if (diceWindow && !diceWindow.isDestroyed()) {
            await new Promise(resolve => {
                ipcMain.once('dice-module-ready', (event) => {
                    if (event.sender === diceWindow.webContents) resolve();
                });
                // A simple check to see if it's already loaded
                if (diceWindow.webContents.getURL().startsWith('http')) resolve();
            });

            diceWindow.webContents.send('roll-dice', notation, options);

            return new Promise((resolve) => {
                ipcMain.once('dice-roll-complete', (event, results) => {
                    if (event.sender === diceWindow.webContents) {
                        let readableResult = '';
                        try {
                            const totalValue = results.reduce((sum, group) => sum + group.value, 0);
                            const parts = results.map(group => {
                                const rollValues = group.rolls.map(r => r.value);
                                let resultString = `[${rollValues.join(', ')}]`;
                                if (group.modifier > 0) resultString += ` + ${group.modifier}`;
                                else if (group.modifier < 0) resultString += ` - ${Math.abs(group.modifier)}`;
                                return resultString;
                            });
                            readableResult = `AI为你投掷了 ${notation}，结果为: ${parts.join(' + ')}，总计 ${totalValue}。`;
                        } catch (e) {
                            console.error("Failed to parse dice results:", e);
                            readableResult = `投掷完成，但无法解析结果: ${JSON.stringify(results)}`;
                        }
                        
                        console.log(`[DiceControl] Formatted result: ${readableResult}`);
                        resolve({ status: 'success', message: readableResult, data: readableResult });
                    }
                });
            });
        } else {
            throw new Error("Dice window could not be created or focused.");
        }

    } catch (error) {
        const errorMsg = `处理骰子指令失败: ${error.message}`;
        console.error(`[DiceControl] ${errorMsg}`, error);
        return { status: 'error', message: errorMsg };
    }
}

function initialize(options) {
    const projectRoot = options.projectRoot;

    ipcMain.handle('open-dice-window', async () => {
        try {
            await createOrFocusDiceWindow(projectRoot);
        } catch (error) {
            console.error("[Dice] Failed to open or focus dice window from IPC:", error);
        }
    });
}

function stopDiceServer() {
    if (diceServer) {
        console.log('[Dice] Stopping dice server...');
        diceServer.close();
        diceServer = null;
    }
}

module.exports = {
    initialize,
    handleDiceControl,
    stopDiceServer,
    getDiceWindow: () => diceWindow
};
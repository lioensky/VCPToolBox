const { ipcMain } = require('electron');
const SovitsTTS = require('../SovitsTTS');

let sovitsTTSInstance = null;
let internalMainWindow = null; // 用于在 handler 内部可靠地访问 mainWindow

function initialize(mainWindow) {
    if (!mainWindow) {
        console.error("SovitsTTS needs the main window to initialize."); // Translated for clarity
        return;
    }
    internalMainWindow = mainWindow; // Save reference to mainWindow
    sovitsTTSInstance = new SovitsTTS(); // No longer pass mainWindow

    ipcMain.handle('sovits-get-models', async (event, forceRefresh) => {
        if (!sovitsTTSInstance) return null;
        return await sovitsTTSInstance.getModels(forceRefresh);
    });

    ipcMain.on('sovits-speak', (event, options) => {
        if (!sovitsTTSInstance) return;
        // The speak method now expects a single options object.
        sovitsTTSInstance.stop(); // Ensure any previous speech is stopped.
        // Pass the event sender to the speak method to reply to the correct window
        sovitsTTSInstance.speak(options, event.sender);
    });

    ipcMain.on('sovits-stop', () => {
        // 首先，让 SovitsTTS 实例清理其内部状态（如队列）
        if (sovitsTTSInstance) {
            sovitsTTSInstance.stop();
        }
        
        // 关键修复：直接从 IPC handler 发送停止事件到渲染器，
        // 确保无论 SovitsTTS 实例的状态如何，停止命令都能被发送。
        if (internalMainWindow && !internalMainWindow.isDestroyed()) {
            console.log("[IPC Handler] Directly sending 'stop-tts-audio' to renderer.");
            internalMainWindow.webContents.send('stop-tts-audio');
        } else {
            console.error("[IPC Handler] Cannot send 'stop-tts-audio', mainWindow reference is invalid.");
        }
    });


    console.log('SovitsTTS IPC handlers initialisés.');
}

module.exports = {
    initialize
};
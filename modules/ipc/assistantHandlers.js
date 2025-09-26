// modules/ipc/assistantHandlers.js

const { ipcMain, BrowserWindow, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const { getAgentConfigById } = require('./agentHandlers'); // Assuming agentHandlers is where this now lives
const notesHandlers = require('./notesHandlers');

let SelectionHook = null;
try {
    if (process.platform === 'win32') {
        SelectionHook = require('selection-hook');
        console.log('selection-hook loaded successfully in assistantHandlers.');
    } else {
        console.log('selection-hook is only available on Windows, text selection feature will be disabled.');
    }
} catch (error) {
    console.error('Failed to load selection-hook in assistantHandlers:', error);
}

let assistantWindow = null;
let assistantBarWindow = null;
let lastProcessedSelection = '';
let selectionListenerActive = false;
let selectionHookInstance = null;
let mouseListener = null;
let hideBarTimeout = null;
let SETTINGS_FILE;

function processSelectedText(selectionData) {
    const selectedText = selectionData.text;
    if (!selectedText || selectedText.trim() === '') {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
        lastProcessedSelection = '';
        return;
    }

    if (selectedText === lastProcessedSelection && assistantBarWindow && assistantBarWindow.isVisible()) {
        return;
    }
    lastProcessedSelection = selectedText;
    console.log('[Assistant] New text captured:', selectedText);

    if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
        console.error('[Assistant] Assistant bar window is not available.');
        return;
    }

    let refPoint;
    if (selectionData.mousePosEnd && (selectionData.mousePosEnd.x > 0 || selectionData.mousePosEnd.y > 0)) {
        refPoint = { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y + 15 };
    } else if (selectionData.endBottom && (selectionData.endBottom.x > 0 || selectionData.endBottom.y > 0)) {
        refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 15 };
    } else {
        const cursorPos = screen.getCursorScreenPoint();
        refPoint = { x: cursorPos.x, y: cursorPos.y + 15 };
    }
    
    const dipPoint = screen.screenToDipPoint(refPoint);
    const barWidth = 330;
    const finalX = Math.round(dipPoint.x - (barWidth / 2));
    const finalY = Math.round(dipPoint.y);

    setImmediate(() => {
        assistantBarWindow.setPosition(finalX, finalY);
        assistantBarWindow.showInactive();
        startGlobalMouseListener();

        (async () => {
            try {
                const settings = await fs.readJson(SETTINGS_FILE);
                if (settings.assistantEnabled && settings.assistantAgent) {
                    const agentConfig = await getAgentConfigById(settings.assistantAgent);
                    assistantBarWindow.webContents.send('assistant-bar-data', {
                        agentAvatarUrl: agentConfig.avatarUrl,
                        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                    });
                }
            } catch (error) {
                console.error('[Assistant] Error sending data to assistant bar:', error);
            }
        })();
    });
}

function startGlobalMouseListener() {
    if (mouseListener) return;
    mouseListener = new GlobalKeyboardListener();
    mouseListener.addListener((e, down) => {
        if (e.state === 'DOWN') {
            if (hideBarTimeout) clearTimeout(hideBarTimeout);
            hideBarTimeout = setTimeout(() => {
                hideAssistantBarAndStopListener();
            }, 150);
        }
    });
}

function hideAssistantBarAndStopListener() {
    if (hideBarTimeout) {
        clearTimeout(hideBarTimeout);
        hideBarTimeout = null;
    }
    if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
        assistantBarWindow.hide();
    }
    if (mouseListener) {
        mouseListener.kill();
        mouseListener = null;
    }
}

function startSelectionListener() {
    if (selectionListenerActive || !SelectionHook) {
        return;
    }
    try {
        selectionHookInstance = new SelectionHook();
        selectionHookInstance.on('text-selection', processSelectedText);
        selectionHookInstance.on('error', (error) => console.error('Error in SelectionHook:', error));
        if (selectionHookInstance.start({ debug: false })) {
            selectionListenerActive = true;
            console.log('[Assistant] selection-hook listener started.');
        } else {
            console.error('[Assistant] Failed to start selection-hook listener.');
            selectionHookInstance = null;
        }
    } catch (e) {
        console.error('[Assistant] Failed to instantiate or start selection-hook listener:', e);
        selectionHookInstance = null;
    }
}

function stopSelectionListener() {
    if (!selectionListenerActive || !selectionHookInstance) {
        return;
    }
    try {
        selectionHookInstance.stop();
        console.log('[Assistant] selection-hook listener stopped.');
    } catch (e) {
        console.error('[Assistant] Failed to stop selection-hook listener:', e);
    } finally {
        selectionHookInstance = null;
        selectionListenerActive = false;
    }
}

function createAssistantBarWindow() {
    assistantBarWindow = new BrowserWindow({
        width: 410,
        height: 40,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'),
            contextIsolation: true,
        }
    });
    assistantBarWindow.loadFile(path.join(__dirname, '..', '..', 'Assistantmodules/assistant-bar.html'));
    assistantBarWindow.on('blur', () => {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
    });
    assistantBarWindow.on('closed', () => {
        assistantBarWindow = null;
    });
    return assistantBarWindow;
}

function createAssistantWindow(data) {
    if (assistantWindow && !assistantWindow.isDestroyed()) {
        assistantWindow.focus();
        assistantWindow.webContents.send('assistant-data', data);
        return;
    }
    assistantWindow = new BrowserWindow({
        width: 450,
        height: 600,
        minWidth: 350,
        minHeight: 400,
        title: '划词助手',
        modal: false,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        show: false,
        resizable: true,
        alwaysOnTop: false,
    });
    assistantWindow.loadFile(path.join(__dirname, '..', '..', 'Assistantmodules/assistant.html'));
    assistantWindow.once('ready-to-show', () => {
        assistantWindow.show();
        assistantWindow.webContents.send('assistant-data', data);
    });
    assistantWindow.on('closed', () => {
        assistantWindow = null;
    });
}

function initialize(options) {
    SETTINGS_FILE = options.SETTINGS_FILE;

    createAssistantBarWindow();

    ipcMain.handle('get-assistant-bar-initial-data', async () => {
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await getAgentConfigById(settings.assistantAgent);
                return {
                    agentAvatarUrl: agentConfig.avatarUrl,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                };
            }
        } catch (error) {
            console.error('[Assistant] Error getting initial data for assistant bar:', error);
            return { error: error.message };
        }
        return {
            agentAvatarUrl: null,
            theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
        };
    });

    ipcMain.on('toggle-selection-listener', (event, enable) => {
        if (enable) {
            startSelectionListener();
        } else {
            stopSelectionListener();
        }
    });

    ipcMain.handle('get-selection-listener-status', () => {
        return selectionListenerActive;
    });

    ipcMain.on('assistant-action', async (event, action) => {
        if (hideBarTimeout) {
            clearTimeout(hideBarTimeout);
            hideBarTimeout = null;
        }
        hideAssistantBarAndStopListener();
        
        if (action === 'note') {
            try {
                const noteTitle = `来自划词笔记：${lastProcessedSelection.substring(0, 20)}...`;
                const noteContent = lastProcessedSelection;
                const data = {
                    title: noteTitle,
                    content: noteContent,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                };
                // Use the imported handler
                const targetWindow = notesHandlers.createOrFocusNotesWindow();
                const wc = targetWindow.webContents;
                if (!wc.isLoading()) {
                    wc.send('shared-note-data', data);
                } else {
                    ipcMain.once('notes-window-ready', (e) => {
                        if (e.sender === wc) {
                            wc.send('shared-note-data', data);
                        }
                    });
                }
            } catch (error) {
                console.error('[Assistant] Error creating note from assistant action:', error);
            }
            return;
        }
        
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            createAssistantWindow({
                selectedText: lastProcessedSelection,
                action: action,
                agentId: settings.assistantAgent,
            });
        } catch (error) {
            console.error('[Assistant] Error creating assistant window from action:', error);
        }
    });
}

module.exports = {
    initialize,
    startSelectionListener,
    stopSelectionListener,
    getSelectionListenerStatus: () => selectionListenerActive,
    getAssistantWindows: () => ({ assistantWindow, assistantBarWindow }),
    hideAssistantBarAndStopListener,
    stopMouseListener: () => {
        if (mouseListener) {
            try {
                mouseListener.kill();
                console.log('[Assistant] Global mouse listener killed.');
            } catch (e) {
                console.error('[Assistant] Error killing mouse listener on quit:', e);
            } finally {
                mouseListener = null;
            }
        }
    }
};
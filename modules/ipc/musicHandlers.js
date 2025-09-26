// modules/ipc/musicHandlers.js

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { Worker } = require('worker_threads');
const lyricFetcher = require('../lyricFetcher'); // Import the new lyric fetcher
const AUDIO_ENGINE_URL = 'http://127.0.0.1:5555';
let fetch;

let musicWindow = null;
let currentSongInfo = null; // 保持这个变量，用于可能的UI状态同步
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let MUSIC_PLAYLIST_FILE;
let MUSIC_COVER_CACHE_DIR;
let LYRIC_DIR;
let startAudioEngine; // To hold the function from main.js
let stopAudioEngine; // To hold the function from main.js
let audioEngineReadyPromise = null; // Promise to track engine readiness

// --- Singleton Music Window Creation Function ---
function createOrFocusMusicWindow() {
    return new Promise(async (resolve, reject) => {
        try {
            // Always wait for the engine to be ready before creating/focusing the window.
            // Thanks to pre-warming in main.js, this should be very fast.
            if (typeof startAudioEngine === 'function') {
                await startAudioEngine();
            } else {
                throw new Error("startAudioEngine function not provided.");
            }
        } catch (error) {
            console.error('[Music] Failed to ensure audio engine is ready:', error);
            dialog.showErrorBox('音乐引擎错误', '无法启动或连接后端音频引擎，请检查日志或重启应用。');
            reject(error);
            return;
        }

        if (musicWindow && !musicWindow.isDestroyed()) {
            console.log('[Music] Music window already exists. Focusing it.');
            musicWindow.focus();
            resolve(musicWindow);
            return;
        }

        console.log('[Music] Creating new music window instance.');
        musicWindow = new BrowserWindow({
            width: 900,
            height: 700,
            minWidth: 400,
            minHeight: 600,
            title: '音乐播放器',
            frame: false, // 移除原生窗口框架
            titleBarStyle: 'hidden', // 隐藏标题栏
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
            show: false
        });

        musicWindow.loadFile(path.join(__dirname, '..', '..', 'Musicmodules', 'music.html'));
        
        openChildWindows.push(musicWindow);
        musicWindow.setMenu(null);

        musicWindow.once('ready-to-show', () => {
            musicWindow.show();
        });

        // Wait for the renderer to signal that it's ready
        ipcMain.once('music-renderer-ready', (event) => {
            if (event.sender === musicWindow.webContents) {
                console.log('[Music] Received "music-renderer-ready" signal. Resolving promise.');
                resolve(musicWindow);
            }
        });

        musicWindow.on('closed', () => {
            console.log('[Music] Music window closed. Stopping playback.');
            // We don't stop the engine when the music window closes anymore,
            // as it's managed by the main app lifecycle now (pre-warmed).
            // We just stop the playback.
            audioEngineApi('/stop').catch(err => console.error("[Music] Failed to send stop command on close:", err));

            openChildWindows = openChildWindows.filter(win => win !== musicWindow);
            musicWindow = null;
        });

        musicWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[Music] Music window failed to load: ${errorDescription} (code: ${errorCode})`);
            reject(new Error(`Music window failed to load: ${errorDescription}`));
        });
    });
}

// --- Audio Engine API Helper ---
async function audioEngineApi(endpoint, method = 'POST', body = null) {
    // The check for engine readiness is now handled in createOrFocusMusicWindow,
    // so we can remove the promise check from here, simplifying this function.
    try {
        if (!fetch) throw new Error('node-fetch module is not available yet.');

        const url = `${AUDIO_ENGINE_URL}${endpoint}`;
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        
        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Audio engine request failed with status ${response.status}: ${errorText}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error(`[Music] Error calling Audio Engine API endpoint '${endpoint}':`, error.message);
        if (musicWindow && !musicWindow.isDestroyed()) {
            musicWindow.webContents.send('audio-engine-error', { message: error.message });
        }
        return { status: 'error', message: error.message };
    }
}


// --- Music Control Handler (Legacy, for distributed server) ---
// 这个函数现在将指令转发到新的IPC通道，或者直接调用API
async function handleMusicControl(args) {
    const { command, target } = args;
    console.log(`[MusicControl] Received command: ${command}, Target: ${target}`);

    // 确保音乐窗口存在
    await createOrFocusMusicWindow();

    switch (command.toLowerCase()) {
        case 'play':
            // 如果有目标，需要先从播放列表找到文件路径
            if (target) {
                const playlist = await fs.readJson(MUSIC_PLAYLIST_FILE).catch(() => []);
                const track = playlist.find(t =>
                    (t.title || '').toLowerCase().includes(target.toLowerCase()) ||
                    (t.artist || '').toLowerCase().includes(target.toLowerCase())
                );
                if (track) {
                    // Load the track in the engine
                    await audioEngineApi('/load', 'POST', { path: track.path });
                    
                    // Tell the UI to update with the new track information
                    if (musicWindow && !musicWindow.isDestroyed()) {
                        musicWindow.webContents.send('music-set-track', track);
                    }

                    // Play the track
                    return audioEngineApi('/play', 'POST');
                } else {
                    return { status: 'error', message: `Track '${target}' not found.` };
                }
            } else {
                return audioEngineApi('/play', 'POST');
            }
        case 'pause':
            return audioEngineApi('/pause', 'POST');
        case 'stop':
            return audioEngineApi('/stop', 'POST');
        // 'next' and 'prev' are handled by the renderer for now
        default:
            return { status: 'error', message: `Unknown command: ${command}` };
    }
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    startAudioEngine = options.startAudioEngine; // Receive the start function
    stopAudioEngine = options.stopAudioEngine; // Receive the stop function
    const APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
    MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');
    LYRIC_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'lyric');

    const registerIpcHandlers = () => {
        ipcMain.on('open-music-window', async () => {
            try {
                await createOrFocusMusicWindow();
            } catch (error) {
                console.error("[Music] Failed to open or focus music window from IPC:", error);
            }
        });

        ipcMain.handle('music-load', (event, filePath) => {
            return audioEngineApi('/load', 'POST', { path: filePath });
        });

        ipcMain.handle('music-play', () => {
            return audioEngineApi('/play', 'POST');
        });

        ipcMain.handle('music-pause', () => {
            return audioEngineApi('/pause', 'POST');
        });

        ipcMain.handle('music-seek', (event, positionSeconds) => {
            return audioEngineApi('/seek', 'POST', { position: positionSeconds });
        });
        
        ipcMain.handle('music-get-state', async () => {
            return await audioEngineApi('/state', 'GET');
        });

        ipcMain.handle('music-set-volume', (event, volume) => {
            return audioEngineApi('/volume', 'POST', { volume });
        });

        // --- New handlers for WASAPI and device selection ---
        ipcMain.handle('music-get-devices', async () => {
            return await audioEngineApi('/devices', 'GET');
        });

        ipcMain.handle('music-configure-output', (event, { device_id, exclusive }) => {
            return audioEngineApi('/configure_output', 'POST', { device_id, exclusive });
        });

        // --- New handler for EQ ---
        ipcMain.handle('music-set-eq', (event, { bands, enabled }) => {
           return audioEngineApi('/set_eq', 'POST', { bands, enabled });
        });

        // --- New handler for Upsampling ---
        ipcMain.handle('music-configure-upsampling', (event, { target_samplerate }) => {
            return audioEngineApi('/configure_upsampling', 'POST', { target_samplerate });
        });
 
         ipcMain.on('open-music-folder', async (event) => {
            const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return;
            }

            const folderPath = result.filePaths[0];
            const supportedFormats = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);
            const fileList = [];

            async function collectFilePaths(dir) {
                try {
                    const files = await fs.readdir(dir, { withFileTypes: true });
                    for (const file of files) {
                        const fullPath = path.join(dir, file.name);
                        if (file.isDirectory()) {
                            await collectFilePaths(fullPath);
                        } else if (supportedFormats.has(path.extname(file.name).toLowerCase())) {
                            fileList.push(fullPath);
                        }
                    }
                } catch (err) {
                    console.error(`Error collecting file paths in ${dir}:`, err);
                }
            }

            try {
                await collectFilePaths(folderPath);
                event.sender.send('scan-started', { total: fileList.length });

                await fs.ensureDir(MUSIC_COVER_CACHE_DIR);

                const worker = new Worker(path.join(__dirname, '..', '..', 'modules', 'musicScannerWorker.js'), {
                    workerData: {
                        coverCachePath: MUSIC_COVER_CACHE_DIR
                    }
                });
                const finalPlaylist = [];
                let processedCount = 0;

                worker.on('message', (result) => {
                    if (result.status === 'success') {
                        finalPlaylist.push(result.data);
                    } else {
                        console.error(result.error);
                    }
                    
                    processedCount++;
                    event.sender.send('scan-progress');

                    if (processedCount === fileList.length) {
                        event.sender.send('scan-finished', finalPlaylist);
                        worker.terminate();
                    }
                });

                worker.on('error', (error) => {
                    console.error('Worker thread error:', error);
                    event.sender.send('scan-finished', finalPlaylist);
                    worker.terminate();
                });

                worker.on('exit', (code) => {
                    if (code !== 0) {
                        console.error(`Worker stopped with exit code ${code}`);
                    }
                });

                fileList.forEach(filePath => worker.postMessage(filePath));

            } catch (err) {
                console.error("Error during music scan setup:", err);
                event.sender.send('scan-finished', []);
            }
        });

        ipcMain.handle('get-music-playlist', async () => {
            try {
                if (await fs.pathExists(MUSIC_PLAYLIST_FILE)) {
                    return await fs.readJson(MUSIC_PLAYLIST_FILE);
                }
                return [];
            } catch (error) {
                console.error('Error reading music playlist:', error);
                return [];
            }
        });

        ipcMain.on('save-music-playlist', async (event, playlist) => {
            try {
                await fs.writeJson(MUSIC_PLAYLIST_FILE, playlist, { spaces: 2 });
            } catch (error) {
                console.error('Error saving music playlist:', error);
            }
        });

        ipcMain.on('share-file-to-main', (event, filePath) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                console.log(`[Music] Forwarding shared file to renderer: ${filePath}`);
                mainWindow.webContents.send('add-file-to-input', filePath);
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        });

        ipcMain.handle('music-get-lyrics', async (event, { artist, title }) => {
            if (!title) return null;

            // A simple sanitizer to remove characters that are invalid in file paths.
            const sanitize = (str) => str.replace(/[\\/:"*?<>|]/g, '_');
            const sanitizedTitle = sanitize(title);
            
            const possiblePaths = [];
            if (artist) {
                const sanitizedArtist = sanitize(artist);
                possiblePaths.push(path.join(LYRIC_DIR, `${sanitizedArtist} - ${sanitizedTitle}.lrc`));
            }
            possiblePaths.push(path.join(LYRIC_DIR, `${sanitizedTitle}.lrc`));

            for (const lrcPath of possiblePaths) {
                try {
                    if (await fs.pathExists(lrcPath)) {
                        const content = await fs.readFile(lrcPath, 'utf-8');
                        return content;
                    }
                } catch (error) {
                    console.error(`[Music] Error reading lyric file ${lrcPath}:`, error);
                }
            }

            return null;
        });

        ipcMain.handle('music-fetch-lyrics', async (event, { artist, title }) => {
            if (!title) return null;
            console.log(`[Music] IPC: Received request to fetch lyrics for "${title}" by "${artist}"`);
            try {
                // Ensure the lyric directory exists before fetching
                await fs.ensureDir(LYRIC_DIR);
                const lrcContent = await lyricFetcher.fetchAndSaveLyrics(artist, title, LYRIC_DIR);
                return lrcContent;
            } catch (error) {
                console.error(`[Music] Error fetching lyrics via IPC for "${title}":`, error);
                return null;
            }
        });
    };

    // 使用动态导入，并在成功后注册所有IPC处理器
    import('node-fetch').then(module => {
        fetch = module.default;
        console.log('[Music] node-fetch loaded successfully.');
        registerIpcHandlers();
    }).catch(err => {
        console.error('[Music] Failed to load node-fetch:', err);
    });
}

module.exports = {
    initialize,
    handleMusicControl,
    getMusicState: () => ({ musicWindow, currentSongInfo })
};
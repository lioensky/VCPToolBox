// modules/ipc/fileDialogHandlers.js
const { ipcMain, dialog, shell, clipboard, net, nativeImage, BrowserWindow, Menu, app } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');

/**
 * Initializes file and dialog related IPC handlers.
 * @param {BrowserWindow} mainWindow The main window instance.
 * @param {object} context - An object containing necessary context.
 * @param {function} context.getSelectionListenerStatus - Function to get the current status of the selection listener.
 * @param {function} context.stopSelectionListener - Function to stop the selection listener.
 * @param {function} context.startSelectionListener - Function to start the selection listener.
 * @param {Array<BrowserWindow>} context.openChildWindows - Array of open child windows.
 */
function initialize(mainWindow, context) {
    let { openChildWindows } = context;

    ipcMain.handle('select-avatar', async () => {
        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) {
            context.stopSelectionListener();
            console.log('[Main] Temporarily stopped selection listener for avatar dialog.');
        }

        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择头像文件',
            properties: ['openFile'],
            filters: [
                { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif'] }
            ]
        });

        if (listenerWasActive) {
            context.startSelectionListener();
            console.log('[Main] Restarted selection listener after avatar dialog.');
        }

        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('read-image-from-clipboard-main', async () => {
        console.log('[Main Process] Received request to read image from clipboard.');
        try {
            const nativeImg = clipboard.readImage();
            if (nativeImg && !nativeImg.isEmpty()) {
                console.log('[Main Process] NativeImage is not empty.');
                const buffer = nativeImg.toPNG();
                if (buffer && buffer.length > 0) {
                    console.log('[Main Process] Conversion to PNG successful.');
                    return { success: true, data: buffer.toString('base64'), extension: 'png' };
                } else {
                    console.warn('[Main Process] Conversion to PNG resulted in empty buffer.');
                    return { success: false, error: 'Conversion to PNG resulted in empty buffer.' };
                }
            } else if (nativeImg && nativeImg.isEmpty()) {
                console.warn('[Main Process] NativeImage is empty. No image on clipboard or unsupported format.');
                return { success: false, error: 'No image on clipboard or unsupported format.' };
            } else {
                console.warn('[Main Process] clipboard.readImage() returned null or undefined.');
                return { success: false, error: 'Failed to read image from clipboard (readImage returned null/undefined).' };
            }
        } catch (error) {
            console.error('[Main Process] Error reading image from clipboard:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('read-text-from-clipboard-main', async () => {
        console.log('[Main Process] Received request to read text from clipboard.');
        try {
            const text = clipboard.readText();
            return { success: true, text: text };
        } catch (error) {
            console.error('[Main Process] Error reading text from clipboard:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-file-as-base64', async (event, filePath) => {
        try {
            console.log(`[Main - get-file-as-base64] ===== REQUEST START ===== Received raw filePath: "${filePath}"`);
            if (!filePath || typeof filePath !== 'string') {
                console.error('[Main - get-file-as-base64] Invalid file path received:', filePath);
                return { success: false, error: 'Invalid file path provided.' };
            }
    
            const cleanPath = filePath.startsWith('file://') ? decodeURIComponent(filePath.substring(7)) : decodeURIComponent(filePath);
            console.log(`[Main - get-file-as-base64] Cleaned path: "${cleanPath}"`);
    
            if (!await fs.pathExists(cleanPath)) {
                console.error(`[Main - get-file-as-base64] File not found at path: ${cleanPath}`);
                return { success: false, error: `File not found at path: ${cleanPath}` };
            }
    
            let originalFileBuffer = await fs.readFile(cleanPath);
            const fileExtension = path.extname(cleanPath).toLowerCase();
            const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.svg'].includes(fileExtension);
    
            if (isImage) {
                const MAX_DIMENSION = 800;
                const JPEG_QUALITY = 70;
    
                // Special handling for GIFs
                if (fileExtension === '.gif') {
                    console.log('[Main Sharp] GIF detected. Starting frame extraction.');
                    try {
                        const image = sharp(originalFileBuffer, { animated: true });
                        const metadata = await image.metadata();
                        const frameDelays = metadata.delay || [];
                        const totalFrames = metadata.pages || 1;
                        
                        console.log(`[Main Sharp] GIF Info: ${totalFrames} frames, delays available: ${frameDelays.length > 0}`);
    
                        const frameBase64s = [];
                        let accumulatedDelay = 0;
                        const targetInterval = 500; // 0.5 seconds in ms
    
                        for (let i = 0; i < totalFrames; i++) {
                            if (i === 0 || accumulatedDelay >= targetInterval) {
                                console.log(`[Main Sharp] Extracting frame ${i} (Accumulated delay: ${accumulatedDelay}ms)`);
                                
                                const frameBuffer = await sharp(originalFileBuffer, { page: i })
                                    .resize({
                                        width: MAX_DIMENSION,
                                        height: MAX_DIMENSION,
                                        fit: sharp.fit.inside,
                                        withoutEnlargement: true
                                    })
                                    .jpeg({ quality: JPEG_QUALITY })
                                    .toBuffer();
                                
                                frameBase64s.push(frameBuffer.toString('base64'));
                                accumulatedDelay = 0; // Reset delay
                            }
                            
                            if (frameDelays[i] !== undefined) {
                                accumulatedDelay += (frameDelays[i] > 0 ? frameDelays[i] : 100);
                            } else if (totalFrames > 1) {
                                accumulatedDelay += 100; // Default delay
                            }
                        }
                        
                        if (frameBase64s.length === 0 && totalFrames > 0) {
                             const frameBuffer = await sharp(originalFileBuffer, { page: 0 })
                                .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: sharp.fit.inside, withoutEnlargement: true })
                                .jpeg({ quality: JPEG_QUALITY })
                                .toBuffer();
                            frameBase64s.push(frameBuffer.toString('base64'));
                        }
    
                        console.log(`[Main Sharp] Extracted ${frameBase64s.length} frames from GIF.`);
                        console.log(`[Main - get-file-as-base64] ===== REQUEST END (SUCCESS - GIF) =====`);
                        return { success: true, base64Frames: frameBase64s, isGif: true };
    
                    } catch (sharpError) {
                        console.error(`[Main Sharp] Error processing animated GIF: ${sharpError.message}. Falling back to single frame.`, sharpError);
                        const fallbackBuffer = await sharp(originalFileBuffer)
                            .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: sharp.fit.inside, withoutEnlargement: true })
                            .jpeg({ quality: JPEG_QUALITY }).toBuffer();
                        return { success: true, base64Frames: [fallbackBuffer.toString('base64')], isGif: false };
                    }
                } else { // For other images (PNG, JPG, etc.)
                    try {
                        const processedBuffer = await sharp(originalFileBuffer)
                            .resize({
                                width: MAX_DIMENSION,
                                height: MAX_DIMENSION,
                                fit: sharp.fit.inside,
                                withoutEnlargement: true
                            })
                            .jpeg({ quality: JPEG_QUALITY })
                            .toBuffer();
                        
                        console.log(`[Main Sharp] Processed static image. Final buffer length: ${processedBuffer.length} bytes`);
                        return { success: true, base64Frames: [processedBuffer.toString('base64')], isGif: false };
    
                    } catch (sharpError) {
                        console.error(`[Main Sharp] Error processing static image: ${sharpError.message}. Using original buffer.`, sharpError);
                        return { success: true, base64Frames: [originalFileBuffer.toString('base64')], isGif: false };
                    }
                }
            } else { // Non-image file
                console.log(`[Main - get-file-as-base64] Non-image file. Buffer length: ${originalFileBuffer.length}`);
                const base64String = originalFileBuffer.toString('base64');
                // This path is not expected to be hit for VCP messages, but we return a compatible format for robustness.
                return { success: true, base64Frames: [base64String], isGif: false };
            }
    
        } catch (error) {
            console.error(`[Main - get-file-as-base64] Outer catch: Error processing path "${filePath}":`, error.message, error.stack);
            console.log(`[Main - get-file-as-base64] ===== REQUEST END (ERROR) =====`);
            return { success: false, error: `获取/处理文件Base64失败: ${error.message}` };
        }
    });

    ipcMain.on('open-external-link', (event, url) => {
        if (url && (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('file:'))) {
            shell.openExternal(url).catch(err => {
                console.error('Failed to open external link:', err);
            });
        } else {
            console.warn(`[Main Process] Received request to open non-standard link externally, ignoring: ${url}`);
        }
    });

    ipcMain.on('show-image-context-menu', (event, imageUrl) => {
        console.log(`[Main Process] Received show-image-context-menu for URL: ${imageUrl}`);
        const template = [
            {
                label: '复制图片',
                click: async () => {
                    console.log(`[Main Process] Context menu: "复制图片" clicked for ${imageUrl}`);
                    if (!imageUrl || (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:') && !imageUrl.startsWith('file:'))) {
                        console.error('[Main Process] Invalid image URL for copying:', imageUrl);
                        dialog.showErrorBox('复制错误', '无效的图片URL。');
                        return;
                    }

                    try {
                        if (imageUrl.startsWith('file:')) {
                            const filePath = decodeURIComponent(imageUrl.substring(7));
                            const image = nativeImage.createFromPath(filePath);
                            if (!image.isEmpty()) {
                                clipboard.writeImage(image);
                                console.log('[Main Process] Local image copied to clipboard successfully.');
                            } else {
                                 console.error('[Main Process] Failed to create native image from local file path or image is empty.');
                                 dialog.showErrorBox('复制失败', '无法从本地文件创建图片对象。');
                            }
                        } else { // http or https
                            const request = net.request(imageUrl);
                            let chunks = [];
                            request.on('response', (response) => {
                                response.on('data', (chunk) => chunks.push(chunk));
                                response.on('end', () => {
                                    if (response.statusCode === 200) {
                                        const buffer = Buffer.concat(chunks);
                                        const image = nativeImage.createFromBuffer(buffer);
                                        if (!image.isEmpty()) {
                                            clipboard.writeImage(image);
                                            console.log('[Main Process] Image copied to clipboard successfully.');
                                        } else {
                                            dialog.showErrorBox('复制失败', '无法从URL创建图片对象。');
                                        }
                                    } else {
                                        dialog.showErrorBox('复制失败', `下载图片失败，服务器状态: ${response.statusCode}`);
                                    }
                                });
                                response.on('error', (error) => dialog.showErrorBox('复制失败', `下载图片响应错误: ${error.message}`));
                            });
                            request.on('error', (error) => dialog.showErrorBox('复制失败', `请求图片失败: ${error.message}`));
                            request.end();
                        }
                    } catch (e) {
                        dialog.showErrorBox('复制失败', `复制过程中发生意外错误: ${e.message}`);
                    }
                }
            },
            { type: 'separator' },
            {
                label: '在新标签页中打开图片',
                click: () => {
                    shell.openExternal(imageUrl);
                }
            }
        ];
        const menu = Menu.buildFromTemplate(template);
        if (mainWindow) {
            menu.popup({ window: mainWindow });
        }
    });

    ipcMain.on('open-image-in-new-window', async (event, imageUrl, imageTitle) => {
        const imageViewerWindow = new BrowserWindow({
            width: 800, height: 600, minWidth: 400, minHeight: 300,
            title: imageTitle || '图片预览',
            parent: mainWindow, modal: false, show: false,
            backgroundColor: '#28282c', // Default to dark, will be updated by JS
            icon: path.join(__dirname, '..', 'assets', 'icon.png'),
            webPreferences: {
                preload: path.join(app.getAppPath(), 'preload.js'),
                contextIsolation: true, nodeIntegration: false, devTools: true
            }
        });

        const viewerUrl = `file://${path.join(__dirname, '..', 'image-viewer.html')}?src=${encodeURIComponent(imageUrl)}&title=${encodeURIComponent(imageTitle || '图片预览')}`;
        imageViewerWindow.loadURL(viewerUrl);
        openChildWindows.push(imageViewerWindow);
        
        imageViewerWindow.setMenu(null);

        imageViewerWindow.once('ready-to-show', () => imageViewerWindow.show());

        imageViewerWindow.on('closed', () => {
            context.openChildWindows = openChildWindows.filter(win => win !== imageViewerWindow);
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
        });
    });

    ipcMain.handle('display-text-content-in-viewer', async (event, textContent, windowTitle, theme) => {
        const textViewerWindow = new BrowserWindow({
            width: 800, height: 700, minWidth: 500, minHeight: 400,
            title: decodeURIComponent(windowTitle) || '阅读模式',
            modal: false, show: false,
            frame: false, // 移除原生窗口框架
            titleBarStyle: 'hidden', // 隐藏标题栏
            minimizable: true, // 确保窗口可以最小化到任务栏
            icon: path.join(__dirname, '..', 'assets', 'icon.png'),
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true, nodeIntegration: false, devTools: true
            }
        });

        const base64Text = Buffer.from(textContent).toString('base64');
        const viewerUrl = `file://${path.join(__dirname, '..', 'text-viewer.html')}?text=${encodeURIComponent(base64Text)}&title=${encodeURIComponent(windowTitle || '阅读模式')}&encoding=base64&theme=${encodeURIComponent(theme || 'dark')}`;
        
        textViewerWindow.loadURL(viewerUrl).catch(err => console.error(`[Main Process] textViewerWindow FAILED to initiate URL loading`, err));
        
        openChildWindows.push(textViewerWindow);
        
        textViewerWindow.setMenu(null);

        textViewerWindow.once('ready-to-show', () => textViewerWindow.show());

        textViewerWindow.on('closed', () => {
            context.openChildWindows = openChildWindows.filter(win => win !== textViewerWindow);
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
        });
    });
}

module.exports = {
    initialize
};
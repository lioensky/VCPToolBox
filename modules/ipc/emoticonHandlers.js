// modules/ipc/emoticonHandlers.js

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');

let emoticonLibrary = [];
let settingsFilePath;
let generatedListsPath;
let emoticonLibraryPath;

function initialize(paths) {
    settingsFilePath = paths.SETTINGS_FILE;
    generatedListsPath = path.join(paths.APP_DATA_ROOT_IN_PROJECT, 'generated_lists');
    emoticonLibraryPath = path.join(generatedListsPath, 'emoticon_library.json');
}

async function generateEmoticonLibrary() {
    console.log('[EmoticonFixer] Starting to generate emoticon library...');
    try {
        // 1. Get Server URL from settings.json
        const settings = await fs.readJson(settingsFilePath);
        const vcpServerUrl = settings.vcpServerUrl;
        if (!vcpServerUrl) {
            console.error('[EmoticonFixer] VCP Server URL not found in settings.');
            return;
        }
        const urlObject = new URL(vcpServerUrl);
        const baseUrl = `${urlObject.protocol}//${urlObject.host}`;

        // 2. Get password from config.env
        const configEnvPath = path.join(generatedListsPath, 'config.env');
        const configContent = await fs.readFile(configEnvPath, 'utf-8');
        const passwordMatch = configContent.match(/file_key=(.*)/);
        if (!passwordMatch || !passwordMatch[1]) {
            console.error('[EmoticonFixer] Could not find file_key in config.env');
            return;
        }
        const password = passwordMatch[1].trim();

        // 3. Scan for emoticon list files
        const files = await fs.readdir(generatedListsPath);
        const txtFiles = files.filter(file => file.endsWith('表情包.txt'));

        const library = [];

        for (const txtFile of txtFiles) {
            const category = path.basename(txtFile, '.txt'); // e.g., "通用表情包"
            const filePath = path.join(generatedListsPath, txtFile);
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const filenames = fileContent.split('|').filter(name => name.trim() !== '');

            for (const filename of filenames) {
                // 4. Construct the full URL
                const encodedFilename = encodeURIComponent(filename);
                const encodedCategory = encodeURIComponent(category);
                const fullUrl = `${baseUrl}/pw=${password}/images/${encodedCategory}/${encodedFilename}`;
                
                library.push({
                    url: fullUrl,
                    category: category,
                    filename: filename,
                    // Add a "search key" for easier fuzzy matching later
                    searchKey: `${category.toLowerCase()}/${filename.toLowerCase()}`
                });
            }
        }

        // 5. Save the library to a JSON file
        await fs.writeJson(emoticonLibraryPath, library, { spaces: 2 });
        emoticonLibrary = library;
        console.log(`[EmoticonFixer] Successfully generated emoticon library with ${library.length} items.`);

    } catch (error) {
        console.error('[EmoticonFixer] Failed to generate emoticon library:', error);
        emoticonLibrary = []; // Reset on error
    }
}

function setupEmoticonHandlers() {
    // Generate the library on startup (async, won't block)
    generateEmoticonLibrary();

    // IPC handler for renderer to get the library
    ipcMain.handle('get-emoticon-library', async () => {
        // If the library is empty (e.g., on first load or after an error), try to read it from the file.
        if (emoticonLibrary.length === 0 && await fs.pathExists(emoticonLibraryPath)) {
            try {
                emoticonLibrary = await fs.readJson(emoticonLibraryPath);
            } catch (error) {
                console.error('[EmoticonFixer] Failed to read emoticon library from file:', error);
                return [];
            }
        }
        return emoticonLibrary;
    });

    // IPC handler to regenerate the library on demand
    ipcMain.on('regenerate-emoticon-library', () => {
        generateEmoticonLibrary();
    });
}

module.exports = {
    initialize,
    setupEmoticonHandlers,
    // Expose for potential direct use, though IPC is preferred
    getEmoticonLibrary: () => emoticonLibrary 
};
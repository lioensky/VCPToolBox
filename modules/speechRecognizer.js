const puppeteer = require('puppeteer');
const path = require('path');

let browser = null;
let page = null;
let isProcessing = false; // State lock to prevent race conditions
let textCallback = null; // Store the callback function globally within the module

// --- Private Functions ---

async function initializeBrowser() {
    if (browser) return; // Already initialized

    console.log('[SpeechRecognizer] Initializing Puppeteer browser...');
    const executablePath = puppeteer.executablePath();
    browser = await puppeteer.launch({
        executablePath: executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-fake-ui-for-media-stream',
            '--disable-gpu', // Often helps in headless environments
        ],
    });

    page = await browser.newPage();
    
    // Grant microphone permissions permanently for the session
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(`file://${path.join(__dirname, '..')}`, ['microphone']);

    // Expose the callback function once
    await page.exposeFunction('sendTextToElectron', (text) => {
        if (textCallback && typeof textCallback === 'function') {
            textCallback(text);
        }
    });
    console.log('[SpeechRecognizer] "sendTextToElectron" function exposed.');

    const recognizerPath = `file://${path.join(__dirname, '..', 'Voicechatmodules', 'recognizer.html')}`;
    console.log(`[SpeechRecognizer] Loading recognizer page: ${recognizerPath}`);
    await page.goto(recognizerPath);
    
    console.log('[SpeechRecognizer] Browser and page initialized.');
}


// --- Public API ---

async function start(callback) {
    if (isProcessing) {
        console.log('[SpeechRecognizer] Already processing a request.');
        return;
    }
    isProcessing = true;
    
    try {
        // Store the callback
        if (callback) {
            textCallback = callback;
        }

        // Initialize browser if it's not already running
        await initializeBrowser();

        // Start recognition on the page
        if (page) {
            await page.evaluate(() => window.startRecognition());
            console.log('[SpeechRecognizer] Recognition started on page.');
        } else {
            throw new Error("Page is not available.");
        }

    } catch (error) {
        console.error('[SpeechRecognizer] Failed to start recognition:', error);
        await shutdown(); // If start fails catastrophically, shut down everything.
    } finally {
        isProcessing = false;
    }
}

async function stop() {
    if (isProcessing || !page) {
        console.log('[SpeechRecognizer] Not running or already processing.');
        return;
    }
    isProcessing = true;

    console.log('[SpeechRecognizer] Stopping recognition on page...');
    try {
        if (page && !page.isClosed()) {
            await page.evaluate(() => window.stopRecognition());
            console.log('[SpeechRecognizer] Recognition stopped on page.');
        }
    } catch (error) {
        console.error('[SpeechRecognizer] Error stopping recognition on page:', error);
    } finally {
        isProcessing = false;
    }
}

async function shutdown() {
    console.log('[SpeechRecognizer] Shutting down Puppeteer browser...');
    if (browser) {
        try {
            await browser.close();
        } catch (error) {
            console.error('[SpeechRecognizer] Error closing browser:', error);
        }
    }
    browser = null;
    page = null;
    textCallback = null;
    isProcessing = false;
    console.log('[SpeechRecognizer] Puppeteer shut down.');
}

module.exports = {
    start,
    stop,
    shutdown // Expose the new shutdown function
};
// modules/interruptHandler.js

let electronAPI;

/**
 * Initializes the interrupt handler with the Electron API.
 * @param {object} api - The Electron API object from preload.
 */
function initialize(api) {
    electronAPI = api;
}

/**
 * Sends an interrupt request to the main process for a given message ID.
 * @param {string} messageId - The ID of the message/request to interrupt.
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
async function interrupt(messageId) {
    if (!electronAPI || typeof electronAPI.interruptVcpRequest !== 'function') {
        const errorMsg = 'Interrupt handler is not initialized or interruptVcpRequest is not available on electronAPI.';
        console.error(errorMsg);
        return { success: false, error: errorMsg };
    }
    if (!messageId) {
        console.error('No messageId provided for interruption.');
        return { success: false, error: 'No messageId provided.' };
    }

    console.log(`[InterruptHandler] Requesting interruption for messageId: ${messageId}`);
    try {
        const result = await electronAPI.interruptVcpRequest({ messageId });
        if (result.success) {
            console.log(`[InterruptHandler] Successfully sent interrupt for ${messageId}.`);
        } else {
            console.error(`[InterruptHandler] Failed to send interrupt for ${messageId}:`, result.error);
        }
        return result;
    } catch (error) {
        console.error(`[InterruptHandler] Error calling interruptVcpRequest IPC for ${messageId}:`, error);
        return { success: false, error: error.message };
    }
}

export { initialize, interrupt };
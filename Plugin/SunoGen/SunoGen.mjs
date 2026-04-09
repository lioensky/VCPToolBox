#!/usr/bin/env node
import axios from "axios";
import dotenv from "dotenv";
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import {
    buildSunoApiRequest,
    extractTaskId,
    extractTrackFromRecordInfo,
    getTaskStatusInfo
} from './sunoApiAdapter.mjs';

// Helper to get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the same directory as this script
dotenv.config({ path: path.join(__dirname, 'config.env') });

// --- Suno API Configuration ---
const SUNO_API_KEY = process.env.SunoKey;
if (!SUNO_API_KEY) {
    // Output error as JSON to stdout and exit, as per VCP spec
    console.log(JSON.stringify({ status: "error", error: "SunoKey environment variable is required. Set it in Plugin/SunoGen/config.env" }));
    process.exit(1);
}

const SUNO_API_CONFIG = {
    // Read from process.env.SunoApiBaseUrl, fallback to a default if not set
    BASE_URL: process.env.SunoApiBaseUrl || 'https://api.sunoapi.org',
    ENDPOINTS: {
        GENERATE: '/api/v1/generate',
        EXTEND: '/api/v1/generate/extend',
        FETCH_TASK: '/api/v1/generate/record-info'
    },
    CALLBACK_URL: process.env.SunoCallbackUrl,
    POLLING_INTERVAL_MS: parseInt(process.env.SunoPollingIntervalMs || "5000", 10), // 5 seconds default
    MAX_POLLING_ATTEMPTS: parseInt(process.env.SunoMaxPollingAttempts || "60", 10), // 5 minutes max polling (5s * 60 = 300s) default
};

// --- Input Validation (Simplified from types.js or inline) ---
function isValidSunoMusicRequestArgs(args) {
    if (!args || typeof args !== 'object') return false;

    const hasGptDescription = typeof args.gpt_description_prompt === 'string' && args.gpt_description_prompt.trim() !== '';
    const hasCustomParams = (typeof args.prompt === 'string' && args.prompt.trim() !== '') &&
                            (typeof args.tags === 'string' && args.tags.trim() !== '') &&
                            (typeof args.title === 'string' && args.title.trim() !== '');
    
    const hasContinuationParams = typeof args.task_id === 'string' && args.task_id.trim() !== '' &&
                                  typeof args.continue_at === 'number' &&
                                  typeof args.continue_clip_id === 'string' && args.continue_clip_id.trim() !== '';

    if (hasContinuationParams) { // If continuation, other modes are not primary
        return true; 
    }
    if (hasGptDescription) { // If gpt_description, custom params are optional but okay
        return true;
    }
    if (hasCustomParams) { // If no gpt_description and no continuation, custom params are required
        return true;
    }
    return false; // Neither valid mode's required params are met
}


// --- File Persistence ---
async function downloadAudio(url, title, taskId) {
    try {
        // Define the target directory relative to the project root
        const musicDir = path.resolve(__dirname, '..', '..', 'file', 'music');

        // Ensure the directory exists
        await fsp.mkdir(musicDir, { recursive: true });

        // Sanitize title to create a valid filename. Fallback to task_id if title is missing.
        const safeTitle = (title || `suno_song_${taskId}`).replace(/[^a-z0-9\u4e00-\u9fa5\-_.]/gi, '_').replace(/ /g, '_');
        const filename = `${safeTitle}.mp3`;
        const filepath = path.join(musicDir, filename);

        // Download the file using axios
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'arraybuffer'
        });

        // Save the file
        await fsp.writeFile(filepath, response.data);

        // Return the absolute path of the saved file
        return filepath;
    } catch (error) {
        // Log error to stderr so it can be captured by the calling process without polluting stdout JSON
        console.error(`[SunoGen] Failed to download audio file for task ${taskId}: ${error.message}`);
        return null; // Indicate failure gracefully
    }
}


// --- Suno API Interaction Logic ---
const sunoApiAxiosInstance = axios.create({
    baseURL: SUNO_API_CONFIG.BASE_URL,
    headers: {
        'Authorization': `Bearer ${SUNO_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

async function handleGenerateMusicSunoApiCall(args) {
    if (!isValidSunoMusicRequestArgs(args)) {
        throw new Error("Input parameters are invalid. Please check the requirements for 'prompt', 'tags', 'title' (for custom mode) OR 'gpt_description_prompt' (for inspiration mode) OR 'task_id', 'continue_at', 'continue_clip_id' (for continuation mode).");
    }

    try {
        const request = buildSunoApiRequest(args, SUNO_API_CONFIG.CALLBACK_URL);
        const submitResponse = await sunoApiAxiosInstance.post(request.endpoint, request.payload);
        const taskId = extractTaskId(submitResponse.data);

        // 2. Poll for task status
        let attempts = 0;
        while (attempts < SUNO_API_CONFIG.MAX_POLLING_ATTEMPTS) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, SUNO_API_CONFIG.POLLING_INTERVAL_MS));

            const fetchResponse = await sunoApiAxiosInstance.get(SUNO_API_CONFIG.ENDPOINTS.FETCH_TASK, {
                params: { taskId }
            });
            const statusInfo = getTaskStatusInfo(fetchResponse.data);
            const track = extractTrackFromRecordInfo(fetchResponse.data);

            if (statusInfo.taskId && statusInfo.taskId !== taskId) {
                if (attempts >= Math.floor(SUNO_API_CONFIG.MAX_POLLING_ATTEMPTS / 2)) {
                    throw new Error(`Polling for task ${taskId}: Mismatched taskId in response (${statusInfo.taskId}). Aborting.`);
                }
                continue;
            }

            if (statusInfo.status === "SUCCESS" || ((statusInfo.status === "FIRST_SUCCESS" || statusInfo.status === "TEXT_SUCCESS") && track?.audioUrl)) {
                if (track?.audioUrl) {
                    // Delegate the download to a separate process so it can continue after this process exits.
                    const downloaderPath = path.join(__dirname, 'Downloader.mjs');
                    const child = spawn('node', [downloaderPath, track.audioUrl, track.title || '', taskId], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    child.unref();

                    // Immediately build and return the message for the user, without waiting for the download.
                    let messageForUser = `Song generated! You can listen to it here: ${track.audioUrl || 'N/A'}`;
                    
                    if (track.title) messageForUser += `\nTitle: ${track.title || 'N/A'}`;
                    
                    if (track.tags) {
                        let tagsDisplay = track.tags;
                        if (Array.isArray(tagsDisplay)) {
                            tagsDisplay = tagsDisplay.join(', ');
                        } else if (typeof tagsDisplay !== 'string') {
                            tagsDisplay = String(tagsDisplay);
                        }
                        messageForUser += `\nStyle: ${tagsDisplay}`;
                    }
                    
                    if (track.imageUrl) messageForUser += `\nImage: ${track.imageUrl || 'N/A'}`;
                    
                    messageForUser += `\nFile is being downloaded in the background.`;

                    // Directly return the fully formatted messageForUser string
                    return messageForUser;
                } else if (statusInfo.status === "SUCCESS") {
                    throw new Error(`Suno Task ${taskId} is SUCCESS but no audio URL was found.`);
                }
            } else if (statusInfo.status && statusInfo.status !== 'PENDING' && statusInfo.status !== 'TEXT_SUCCESS' && statusInfo.status !== 'FIRST_SUCCESS') {
                throw new Error(`Suno Task ${taskId} failed: ${statusInfo.errorMessage || statusInfo.status}`);
            }
        }
        throw new Error(`Suno Task ${taskId} timed out after ${attempts} polling attempts.`);

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const apiError = error.response?.data;
            const status = error.response?.status;
            const message = apiError?.message || apiError?.error?.message || (typeof apiError === 'string' ? apiError : error.message);
            throw new Error(`Suno API error (Status ${status}): ${message}`);
        }
        throw error; // Re-throw other errors (e.g., our custom errors)
    }
}

// --- Main Execution Logic ---
async function main() {
    let inputJsonString = '';
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputJsonString += chunk;
    }

    try {
        if (!inputJsonString) {
            throw new Error("No input received from stdin.");
        }
        const args = JSON.parse(inputJsonString);

        // Assuming the command will always be "generate_song" as per manifest
        // No need to check args.command if manifest only has one command for this script
        
        const sunoResultString = await handleGenerateMusicSunoApiCall(args); // This now returns the string directly

        const output = {
            status: "success",
            result: sunoResultString // The result field is now the string itself
            // messageForAI field is removed as it's not used by Plugin.js/server.js for the final output to AI
        };
        console.log(JSON.stringify(output));
        process.exit(0);

    } catch (error) {
        const errorOutput = {
            status: "error",
            error: error instanceof Error ? error.message : String(error)
        };
        console.log(JSON.stringify(errorOutput));
        process.exit(1);
    }
}

main();

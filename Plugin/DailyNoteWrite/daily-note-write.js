const fs = require('fs').promises;
const path = require('path');

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'); // Fallback

// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DailyNoteWrite][Debug] ${message}`, ...args); // Log debug to stderr
    }
}

// --- Output Function (to stdout) ---
function sendOutput(data) {
    try {
        const jsonString = JSON.stringify(data);
        process.stdout.write(jsonString);
        debugLog('Sent output to stdout:', jsonString);
    } catch (e) {
        // Fallback for stringification errors
        console.error("[DailyNoteWrite] Error stringifying output:", e);
        process.stdout.write(JSON.stringify({ status: "error", message: "Internal error: Failed to stringify output." }));
    }
}

// --- Core Diary Writing Logic ---
async function writeDiary(maidName, dateString, contentText) {
    debugLog(`Processing diary write for Maid: ${maidName}, Date: ${dateString}`);
    if (!maidName || !dateString || !contentText) {
        throw new Error('Invalid input: Missing Maid, Date, or Content.');
    }

    // Trim maidName to prevent folder/file name issues with whitespace, especially on Windows.
    const trimmedMaidName = maidName.trim();

    let folderName = trimmedMaidName;
    let actualMaidName = trimmedMaidName;
    // Use regex to find [tag]name format
    const tagMatch = trimmedMaidName.match(/^\[(.*?)\](.*)$/);

    if (tagMatch) {
        folderName = tagMatch[1].trim(); // Use the captured tag as folder name
        actualMaidName = tagMatch[2].trim(); // Use the captured name as actual maid name
        debugLog(`Tagged note detected. Tag: ${folderName}, Actual Maid: ${actualMaidName}`);
    } else {
        // In the non-tag case, folderName and actualMaidName are already the trimmedMaidName
        debugLog(`No tag detected. Folder: ${folderName}, Actual Maid: ${actualMaidName}`);
    }

    const datePart = dateString.replace(/[.\\\/\s-]/g, '-').replace(/-+/g, '-');
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timeStringForFile = `${hours}_${minutes}_${seconds}`;

    const dirPath = path.join(dailyNoteRootPath, folderName);
    const baseFileNameWithoutExt = `${datePart}-${timeStringForFile}`;
    const fileExtension = '.txt';
    const finalFileName = `${baseFileNameWithoutExt}${fileExtension}`;
    const filePath = path.join(dirPath, finalFileName);

    debugLog(`Target file path: ${filePath}`);

    await fs.mkdir(dirPath, { recursive: true });
    const fileContent = `[${datePart}] - ${actualMaidName}\n${contentText}`;
    await fs.writeFile(filePath, fileContent);
    debugLog(`Successfully wrote file (length: ${fileContent.length})`);
    return filePath; // Return the path on success
}

// --- Main Execution ---
async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
            inputData += chunk;
        }
    });

    process.stdin.on('end', async () => {
        debugLog('Received stdin data:', inputData);
        try {
            if (!inputData) {
                throw new Error("No input data received via stdin.");
            }
            const diaryData = JSON.parse(inputData);
            const { maidName, dateString, contentText } = diaryData;

            const savedFilePath = await writeDiary(maidName, dateString, contentText);
            sendOutput({ status: "success", message: `Diary saved to ${savedFilePath}` });

        } catch (error) {
            console.error("[DailyNoteWrite] Error processing request:", error.message);
            sendOutput({ status: "error", message: error.message || "An unknown error occurred." });
            process.exitCode = 1; // Indicate failure
        }
    });

     process.stdin.on('error', (err) => {
         console.error("[DailyNoteWrite] Stdin error:", err);
         sendOutput({ status: "error", message: "Error reading input." });
         process.exitCode = 1; // Indicate failure
     });
}

main();

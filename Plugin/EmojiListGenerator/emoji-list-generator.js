const fs = require('fs').promises;
const path = require('path');

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const projectBasePath = process.env.PROJECT_BASE_PATH;

// --- Paths ---
// Source directory for images (relative to project root)
const sourceImageBaseDir = projectBasePath ? path.join(projectBasePath, 'image') : null;
// Output directory for generated .txt lists (within this plugin's directory)
const outputDirForLists = path.join(__dirname, 'generated_lists');

// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[EmojiListGenerator][Debug] ${message}`, ...args);
    }
}

function compareText(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base'
    });
}

async function writeFileIfChanged(filePath, nextContent) {
    try {
        const currentContent = await fs.readFile(filePath, 'utf-8');
        if (currentContent === nextContent) {
            return false;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    await fs.writeFile(filePath, nextContent, 'utf-8');
    return true;
}

// --- Main Logic ---
async function generateEmojiLists() {
    if (!sourceImageBaseDir) {
        console.error("[EmojiListGenerator] Error: PROJECT_BASE_PATH environment variable not set. Cannot locate image directory.");
        process.stdout.write(JSON.stringify({ status: "error", message: "PROJECT_BASE_PATH not set." }));
        return;
    }
    debugLog(`Source image directory: ${sourceImageBaseDir}`);
    debugLog(`Output directory for lists: ${outputDirForLists}`);

    try {
        // Ensure the output directory exists
        await fs.mkdir(outputDirForLists, { recursive: true });
        debugLog(`Ensured output directory exists: ${outputDirForLists}`);

        const entries = await fs.readdir(sourceImageBaseDir, { withFileTypes: true });
        const emojiDirs = entries
            .filter(entry => entry.isDirectory() && entry.name.endsWith('表情包'))
            .sort((left, right) => compareText(left.name, right.name));

        if (emojiDirs.length === 0) {
            console.warn(`[EmojiListGenerator] No directories ending with '表情包' found in ${sourceImageBaseDir}`);
            process.stdout.write(JSON.stringify({ status: "success", message: "No emoji pack directories found.", generated_files: 0 }));
            return;
        }

        let generatedCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        for (const dirEntry of emojiDirs) {
            const emojiPackName = dirEntry.name; // e.g., "通用表情包"
            const emojiPackPath = path.join(sourceImageBaseDir, emojiPackName);
            const outputFilePath = path.join(outputDirForLists, `${emojiPackName}.txt`);

            try {
                const files = await fs.readdir(emojiPackPath);
                const imageFiles = files
                    .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file))
                    .sort(compareText);
                const listContent = imageFiles.join('|');

                const didWrite = await writeFileIfChanged(outputFilePath, listContent);
                if (didWrite) {
                    updatedCount++;
                    debugLog(`Updated list for ${emojiPackName} at ${outputFilePath} with ${imageFiles.length} images.`);
                } else {
                    unchangedCount++;
                    debugLog(`Skipped unchanged list for ${emojiPackName} at ${outputFilePath}.`);
                }
                generatedCount++;
            } catch (error) {
                console.error(`[EmojiListGenerator] Error processing emoji pack ${emojiPackName}:`, error.message);
                // Continue to next pack if one fails
            }
        }
        const successMsg = `Processed ${generatedCount} emoji list files in ${outputDirForLists}; updated ${updatedCount}, unchanged ${unchangedCount}.`;
        console.log(`[EmojiListGenerator] ${successMsg}`);
        process.stdout.write(JSON.stringify({
            status: "success",
            message: successMsg,
            generated_files: generatedCount,
            updated_files: updatedCount,
            unchanged_files: unchangedCount
        }));

    } catch (error) {
        if (error.code === 'ENOENT' && error.path === sourceImageBaseDir) {
             console.error(`[EmojiListGenerator] Error: Source image directory not found at ${sourceImageBaseDir}`);
             process.stdout.write(JSON.stringify({ status: "error", message: `Source image directory not found: ${sourceImageBaseDir}` }));
        } else {
            console.error("[EmojiListGenerator] Error generating emoji lists:", error.message);
            process.stdout.write(JSON.stringify({ status: "error", message: error.message || "An unknown error occurred during list generation." }));
        }
    }
}

// --- Execution ---
(async () => {
    try {
        await generateEmojiLists();
    } catch (e) {
        // Catch any unhandled errors from generateEmojiLists itself, though it should handle its own.
        console.error("[EmojiListGenerator] Fatal error during execution:", e);
        process.stdout.write(JSON.stringify({ status: "fatal", message: e.message || "A fatal unknown error occurred." }));
        process.exitCode = 1;
    }
})();
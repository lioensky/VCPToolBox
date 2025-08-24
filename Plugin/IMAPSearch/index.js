const fs = require('fs').promises;
const path = require('path');

// --- I/O Helpers ---

/**
 * Asynchronously reads all data from stdin.
 * @returns {Promise<string>} The data from stdin.
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

/**
 * Writes a JSON object to stdout as a single line.
 * @param {object} data The object to write.
 */
function writeStdout(data) {
  try {
    process.stdout.write(JSON.stringify(data) + '\n');
  } catch (e) {
    // Fallback for rare serialization errors
    const errorMsg = `{"status":"error","code":"INTERNAL_ERROR","error":"Failed to serialize response: ${e.message}"}`;
    process.stdout.write(errorMsg + '\n');
  }
}

// --- Core Search Logic ---

/**
 * Recursively finds all .md files in a directory, excluding 'vcp_index.md'.
 * @param {string} dirPath The directory to search.
 * @returns {Promise<string[]>} A list of full paths to .md files.
 */
async function findMdFiles(dirPath) {
    let mdFiles = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                mdFiles = mdFiles.concat(await findMdFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'vcp_index.md') {
                mdFiles.push(fullPath);
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            // If the directory doesn't exist, return an empty array, which is not an error.
            return [];
        }
        // For other errors (e.g., permissions), re-throw.
        throw { code: "FILE_SYSTEM_ERROR", message: `Error reading directory ${dirPath}: ${error.message}` };
    }
    return mdFiles;
}

/**
 * Safely counts occurrences of a substring in a string (case-insensitive).
 * @param {string} content The string to search within.
 * @param {string} query The substring to count.
 * @returns {number} The number of occurrences.
 */
function countOccurrences(content, query) {
    if (!query) return 0;
    // Using split is a safe way to count occurrences without complex regex
    return content.toLowerCase().split(query.toLowerCase()).length - 1;
}

/**
 * Searches through all .md files for a given query.
 * @param {string} query The search query.
 * @param {number} limit The maximum number of results to return.
 * @param {number} offset The starting offset for pagination.
 * @returns {Promise<{results: object[], totalMatches: number}>} Search results and total count.
 */
async function searchFiles(query, limit, offset) {
    // Default to ../IMAPIndex/mail_store, allow override by env var
    const mailIndexDir = process.env.MAIL_INDEX_DIR || path.resolve(__dirname, '../IMAPIndex/mail_store');
    
    const allMdFiles = await findMdFiles(mailIndexDir);
    if (allMdFiles.length === 0) {
        return { results: [], totalMatches: 0 };
    }

    const searchHits = [];
    for (const filePath of allMdFiles) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const matchCount = countOccurrences(content, query);

            if (matchCount > 0) {
                searchHits.push({
                    path: filePath,
                    score: matchCount,
                    content: content,
                });
            }
        } catch (error) {
            // Log error for the specific file but continue processing others
            process.stderr.write(`Warning: Could not process file ${filePath}: ${error.message}\n`);
        }
    }

    // Sort by score (match count) descending
    searchHits.sort((a, b) => b.score - a.score);

    const totalMatches = searchHits.length;
    const paginatedResults = searchHits.slice(offset, offset + limit);

    return { results: paginatedResults, totalMatches };
}


// --- Main Execution ---

/**
 * Main function to handle plugin execution.
 */
async function main() {
    try {
        const input = await readStdin();
        if (!input) {
            throw { code: "INVALID_INPUT", message: "No input received from stdin." };
        }
        const args = JSON.parse(input);

        // Parameter compatibility and validation
        const query = args.query || args.q || args.text;
        if (!query) {
            throw { code: "INVALID_PARAMS", message: "Missing required parameter: query (or q, text)." };
        }

        const limit = parseInt(args.limit || args.size || process.env.SEARCH_RESULT_LIMIT || 5, 10);
        const offset = parseInt(args.nextCursor || 0, 10);

        if (isNaN(limit) || isNaN(offset) || limit <= 0 || offset < 0) {
            throw { code: "INVALID_PARAMS", message: "Invalid 'limit' or 'nextCursor'. Must be non-negative integers." };
        }

        const { results, totalMatches } = await searchFiles(query, limit, offset);

        const nextOffset = offset + results.length;
        const nextCursor = nextOffset < totalMatches ? nextOffset : null;

        writeStdout({
            status: "success",
            result: {
                content: results.map(hit => ({
                    type: "text",
                    text: hit.content, // Return the full markdown content as requested
                })),
                nextCursor: nextCursor,
            },
        });

    } catch (e) {
        // Ensure error is a plain object for consistent JSON serialization
        const errorCode = e.code || "PLUGIN_ERROR";
        const errorMessage = e.message || "An unexpected error occurred.";
        writeStdout({
            status: "error",
            code: errorCode,
            error: errorMessage,
        });
        process.exit(1);
    }
}

main();
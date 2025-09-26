// modules/renderer/emoticonUrlFixer.js

let emoticonLibrary = [];
let isInitialized = false;
let electronAPI;

// A simple string similarity function (Jaro-Winkler might be better, but this is simple)
function getSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) {
        return 1.0;
    }
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();

    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) {
            costs[s2.length] = lastValue;
        }
    }
    return costs[s2.length];
}


function extractEmoticonInfo(url) {
    let filename = null;
    let packageName = null;

    if (!url) return { filename, packageName };

    try {
        // Use URL to handle file:// or http:// protocols
        const decodedPath = decodeURIComponent(new URL(url).pathname);
        // Split path and remove empty segments (e.g., leading slash)
        const parts = decodedPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            filename = parts[parts.length - 1];
        }
        if (parts.length > 1) {
            packageName = parts[parts.length - 2];
        }
    } catch (e) {
        // Fallback for strings that are not full URLs or malformed
        try {
            const decodedUrl = decodeURIComponent(url);
            const parts = decodedUrl.split('/').filter(Boolean);
            if (parts.length > 0) {
                filename = parts[parts.length - 1];
            }
            if (parts.length > 1) {
                packageName = parts[parts.length - 2];
            }
        } catch (e2) {
            // If decoding fails, use the raw url string
            const parts = url.split('/').filter(Boolean);
            if (parts.length > 0) {
                filename = parts[parts.length - 1];
            }
            if (parts.length > 1) {
                packageName = parts[parts.length - 2];
            }
        }
    }
    
    return { filename, packageName };
}


async function initialize(api) {
    if (isInitialized) return;
    electronAPI = api;
    try {
        console.log('[EmoticonFixer] Initializing and fetching library...');
        const library = await electronAPI.getEmoticonLibrary();
        if (library && library.length > 0) {
            emoticonLibrary = library;
            isInitialized = true;
            console.log(`[EmoticonFixer] Library loaded with ${emoticonLibrary.length} items.`);
        } else {
            console.warn('[EmoticonFixer] Fetched library is empty.');
        }
    } catch (error) {
        console.error('[EmoticonFixer] Failed to initialize:', error);
    }
}

function fixEmoticonUrl(originalSrc) {
    if (!isInitialized || emoticonLibrary.length === 0) {
        return originalSrc; // Not ready, pass through
    }

    // 1. Quick check: if the URL is already perfect, return it.
    try {
        const decodedOriginalSrc = decodeURIComponent(originalSrc);
        if (emoticonLibrary.some(item => decodeURIComponent(item.url) === decodedOriginalSrc)) {
            return originalSrc; // It's a perfect match, don't touch it.
        }
    } catch (e) {
        console.warn(`[EmoticonFixer] Could not decode originalSrc for perfect match check: ${originalSrc}`, e);
    }

    // 2. Check if it's likely an emoticon URL by looking for "表情包"
    try {
        if (!decodeURIComponent(originalSrc).includes('表情包')) {
            return originalSrc;
        }
    } catch (e) {
        return originalSrc; // Malformed URI
    }

    // 3. Extract info and find the best match based on package and filename.
    const searchInfo = extractEmoticonInfo(originalSrc);

    if (!searchInfo.filename) {
        console.log(`[EmoticonFixer] Could not extract filename from "${originalSrc}". Passing through.`);
        return originalSrc;
    }

    let bestMatch = null;
    let highestScore = -1;

    for (const item of emoticonLibrary) {
        const itemPackageInfo = extractEmoticonInfo(item.url);
        
        let packageScore = 0.5;
        if (searchInfo.packageName && itemPackageInfo.packageName) {
            packageScore = getSimilarity(searchInfo.packageName, itemPackageInfo.packageName);
        } else if (!searchInfo.packageName && !itemPackageInfo.packageName) {
            packageScore = 1.0; // Both have no package, that's a perfect "package match"
        } else {
            packageScore = 0.0; // One has a package name, the other doesn't.
        }

        const filenameScore = getSimilarity(searchInfo.filename, item.filename);

        // Weighted score: 70% for package name, 30% for filename.
        const score = (0.7 * packageScore) + (0.3 * filenameScore);

        if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
        }
    }

    // 4. If a reasonably good match is found, return the fixed URL.
    if (bestMatch && highestScore > 0.6) {
        console.log(`[EmoticonFixer] Fixed URL. Original: "${originalSrc}", Best Match: "${bestMatch.url}" (Score: ${highestScore.toFixed(2)})`);
        return bestMatch.url;
    }

    // 5. If no good match was found, return the original URL.
    console.log(`[EmoticonFixer] No suitable fix found for "${originalSrc}". Highest score: ${highestScore.toFixed(2)}. Passing through.`);
    return originalSrc;
}

export { initialize, fixEmoticonUrl };
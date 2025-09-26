// modules/musicScannerWorker.js
const { parentPort, workerData } = require('worker_threads');
const musicMetadata = require('music-metadata');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

if (!parentPort) {
    throw new Error('This script must be run as a worker thread.');
}

const { coverCachePath } = workerData;

parentPort.on('message', async (filePath) => {
    try {
        // Set a timeout for the parsing operation
        const parsePromise = musicMetadata.parseFile(filePath, { duration: true });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Parsing timed out')), 30000) // 30-second timeout
        );

        const metadata = await Promise.race([parsePromise, timeoutPromise]);
        
        // Find the best album art
        let picture = null;
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            // Prefer the 'Cover (front)' picture
            picture = metadata.common.picture.find(p => p.type === 'Cover (front)');
            // If no front cover is found, fall back to the first picture
            if (!picture) {
                picture = metadata.common.picture[0];
            }
        }
        
        let coverPath = null;

        if (picture) {
            // Create a unique filename for the cover art to avoid collisions
            const hash = crypto.createHash('md5').update(picture.data).digest('hex');
            const extension = (picture.format || 'image/jpeg').split('/')[1] || 'jpg';
            const coverFilename = `${hash}.${extension}`;
            const fullCoverPath = path.join(coverCachePath, coverFilename);

            // Write the cover image to the cache directory
            await fs.writeFile(fullCoverPath, picture.data);
            coverPath = fullCoverPath; // Store the path to the cached image
        }
        
        parentPort.postMessage({
            status: 'success',
            data: {
                path: filePath,
                title: metadata.common.title || path.basename(filePath),
                artist: metadata.common.artist,
                album: metadata.common.album,
                albumArt: coverPath, // Now this is a file path, not raw data
                bitrate: metadata.format.bitrate
            }
        });
    } catch (error) {
        // If any error occurs (including timeout), report it back
        parentPort.postMessage({
            status: 'error',
            error: `Failed to parse ${path.basename(filePath)}: ${error.message}`,
            path: filePath
        });
    }
});
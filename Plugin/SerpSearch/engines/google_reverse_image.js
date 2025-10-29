const { getJson } = require("serpapi");
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');

// Helper function to download an image and convert to base64
function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
            }
        };
        const request = client.get(url, options, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image from ${url}, status code: ${response.statusCode}`));
            }
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(`data:${response.headers['content-type']};base64,${buffer.toString('base64')}`);
            });
        });
        request.on('error', (err) => reject(err));
    });
}


// Main search function for Google Reverse Image Search
async function search(parameters, apiKey) {
    let imageUrl = parameters.image_url || parameters.url;
    let urlWasGenerated = false; // Flag to indicate if we created a temporary public URL

    // Pre-processing: Check for local/intranet IP URLs and convert them to a public proxy URL.
    if (imageUrl && imageUrl.startsWith('http://')) {
        try {
            const urlObject = new URL(imageUrl);
            // Regex to check if the hostname is an IP address (IPv4 or IPv6)
            const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^\[([0-9a-fA-F:]+)\]$/;
            if (ipRegex.test(urlObject.hostname) || urlObject.hostname === 'localhost') {
                const varHttpsUrl = process.env.VarHttpsUrl;
                const fileKey = process.env.File_Key;

                if (!varHttpsUrl || !fileKey) {
                    throw new Error("Server configuration 'VarHttpsUrl' or 'File_Key' is missing for proxying local URL.");
                }
                
                // The server should have a route like /proxy/ that takes the encoded original URL
                const encodedOriginalUrl = encodeURIComponent(imageUrl);
                imageUrl = `${varHttpsUrl}/pw=${fileKey}/proxy/${encodedOriginalUrl}`;
                console.log(`[SerpSearch] Converted local IP URL to public proxy URL: ${imageUrl}`);
            }
        } catch (e) {
            // If URL parsing fails, it's not a standard URL, let it pass through.
            console.warn(`[SerpSearch] Could not parse potential local URL: ${imageUrl}. Error: ${e.message}`);
        }
    }

    // 1. Handle base64 data passed back after Hyper-Stack-Trace (Highest Priority)
    if (parameters.image_base64) {
        try {
            const base64Data = parameters.image_base64;
            const matches = base64Data.match(/^data:(image\/(\w+));base64,(.+)$/);
            if (!matches) {
                throw new Error("Invalid base64 image format.");
            }

            const imageType = matches[2];
            const pureBase64 = matches[3];
            const imageBuffer = Buffer.from(pureBase64, 'base64');

            // FIX: Use the project's base path to construct the correct public image directory path.
            const tempDir = path.join(process.env.PROJECT_BASE_PATH, 'image', 'serptemp');
            await fs.mkdir(tempDir, { recursive: true });

            const tempFilename = `${uuidv4()}.${imageType}`;
            const tempFilePath = path.join(tempDir, tempFilename);
            await fs.writeFile(tempFilePath, imageBuffer);

            const varHttpsUrl = process.env.VarHttpsUrl;
            const fileKey = process.env.File_Key;

            if (!varHttpsUrl || !fileKey) {
                throw new Error("Server configuration 'VarHttpsUrl' or 'File_Key' is missing.");
            }

            imageUrl = `${varHttpsUrl}/pw=${fileKey}/images/serptemp/${tempFilename}`;
            urlWasGenerated = true;

        } catch (e) {
            // Propagate error from base64 processing
            throw new Error(`Failed to process base64 image: ${e.message}`);
        }
    }
    // 2. Handle file:// URLs if no base64 was provided
    else if (imageUrl && imageUrl.startsWith('file://')) {
        const { fileURLToPath } = require('url');
        const filePath = fileURLToPath(imageUrl);
        try {
            // Check if the file exists locally on the server
            await fs.access(filePath);

            // If it exists, copy it to serptemp and create a public URL
            const fileBuffer = await fs.readFile(filePath);
            const fileExtension = path.extname(filePath).slice(1) || 'png';

            // FIX: Use the project's base path to construct the correct public image directory path.
            const tempDir = path.join(process.env.PROJECT_BASE_PATH, 'image', 'serptemp');
            await fs.mkdir(tempDir, { recursive: true });

            const tempFilename = `${uuidv4()}.${fileExtension}`;
            const tempFilePath = path.join(tempDir, tempFilename);
            await fs.writeFile(tempFilePath, fileBuffer);

            const varHttpsUrl = process.env.VarHttpsUrl;
            const fileKey = process.env.File_Key;

            if (!varHttpsUrl || !fileKey) {
                throw new Error("Server configuration 'VarHttpsUrl' or 'File_Key' is missing.");
            }

            imageUrl = `${varHttpsUrl}/pw=${fileKey}/images/serptemp/${tempFilename}`;
            urlWasGenerated = true;

        } catch (e) {
            if (e.code === 'ENOENT') {
                // If the file does not exist locally, it's a distributed file; trigger Hyper-Stack-Trace.
                const structuredError = new Error(`Local file not found, requesting remote fetch for ${imageUrl}.`);
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = imageUrl;
                throw structuredError;
            }
            // Re-throw other file access errors (e.g., permissions)
            throw new Error(`Error accessing local file: ${e.message}`);
        }
    }

    // After all processing, ensure we have a valid image URL.
    if (!imageUrl) {
        throw new Error("The 'image_url' parameter is required for Google Reverse Image Search.");
    }

    // If we just created the file, wait a moment for the web server to make it available.
    // This can prevent race conditions where the search API tries to fetch the URL before it's ready.
    if (urlWasGenerated) {
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 second delay
    }

    // 3. Encode URL to handle special characters
    try {
        const urlObject = new URL(imageUrl);
        imageUrl = urlObject.href;
    } catch (e) {
        // If new URL() fails, it might be a URL with unencoded special characters.
        // We can try to encode it component by component.
        const { protocol, host, pathname, search, hash } = require('url').parse(imageUrl);
        const encodedPathname = pathname.split('/').map(encodeURIComponent).join('/');
        imageUrl = `${protocol}//${host}${encodedPathname}${search || ''}${hash || ''}`;
    }


    const searchParams = {
        engine: "google_reverse_image",
        image_url: imageUrl,
        api_key: apiKey
    };

    try {
        const data = await getJson(searchParams);

        // 4. Process and format top 5 image results into a structured multimodal output
        const imageResults = data.image_results?.slice(0, 5) || [];
        const content = [];

        // First, build a single, comprehensive text block with all information.
        let summaryText = `Successfully performed reverse image search. Found ${data.search_information?.total_results || 'many'} results. Here are the top matches:\n\n`;
        const imageFetchPromises = [];

        for (const res of imageResults) {
            summaryText += `[${res.position}] ${res.title}\nSource: ${res.source}\nLink: ${res.link}\n\n`;
            if (res.thumbnail) {
                // Collect all image fetch promises to run them in parallel.
                imageFetchPromises.push(
                    fetchImageAsBase64(res.thumbnail)
                        .catch(e => {
                            console.error(`[SerpSearch] Failed to fetch thumbnail for '${res.title}': ${e.message}`);
                            // Return an error object to handle it later.
                            return { error: true, url: res.thumbnail, title: res.title };
                        })
                );
            }
        }

        // Add the consolidated text block as the first element.
        content.push({
            type: 'text',
            text: summaryText.trim()
        });

        // Await all image fetches to complete.
        const fetchedImages = await Promise.all(imageFetchPromises);

        // Now, add all fetched images and error messages to the content array.
        fetchedImages.forEach(result => {
            if (result && !result.error) {
                content.push({
                    type: 'image_url',
                    image_url: { url: result }
                });
            } else if (result && result.error) {
                // If an image failed to load, add a text note.
                content.push({
                    type: 'text',
                    text: `(Could not load image for "[${result.title}]": ${result.url})`
                });
            }
        });

        // Finally, include the raw JSON data for debugging purposes.
        content.push({
            type: 'text',
            text: `\n\n--- Raw Search Results (for debugging) ---\n${JSON.stringify(data.image_results, null, 2)}`
        });

        // Return the original success format expected by the parent SerpSearch plugin
        return {
            success: true,
            data: {
                content: content,
                raw_serp_data: data // Keep the original data if needed elsewhere
            }
        };

    } catch (error) {
        // Propagate SerpApi search errors
        throw new Error(`SerpApi search failed: ${error.message}`);
    }
}

// This file is a module (an "engine"), so it should only export its functions.
// The main execution logic resides in the parent plugin that calls this engine.
module.exports = { search };
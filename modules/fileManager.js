// modules/fileManager.js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // 引入 crypto 模块
const pdf = require('pdf-parse'); // For PDF text extraction
const mammoth = require('mammoth'); // For DOCX text extraction
// const { exec } = require('child_process'); // For potential future use with textract or other CLI tools

// Base directory for all user-specific data, including attachments.
// This will be initialized by main.js
let USER_DATA_ROOT;
let AGENT_DATA_ROOT; // Might be needed if agent config influences storage
let ATTACHMENTS_DIR; // 新增：中心化附件存储目录

function initializeFileManager(userDataPath, agentDataPath) {
    USER_DATA_ROOT = userDataPath;
    AGENT_DATA_ROOT = agentDataPath;
    ATTACHMENTS_DIR = path.join(USER_DATA_ROOT, 'attachments'); // 定义中心化目录
    fs.ensureDirSync(ATTACHMENTS_DIR); // 确保目录存在
    console.log(`[FileManager] Initialized with USER_DATA_ROOT: ${USER_DATA_ROOT}`);
    console.log(`[FileManager] Central attachments directory ensured at: ${ATTACHMENTS_DIR}`);
}

/**
 * Stores a file (from a source path or buffer) into a centralized, content-addressed storage.
 * It calculates the file's SHA256 hash to ensure uniqueness and avoids storing duplicates.
 * Returns an object with details about the stored file, including its internal path and hash.
 */
async function storeFile(sourcePathOrBuffer, originalName, agentId, topicId, fileTypeHint = 'application/octet-stream') {
    if (!USER_DATA_ROOT || !ATTACHMENTS_DIR) {
        console.error('[FileManager] USER_DATA_ROOT or ATTACHMENTS_DIR not initialized.');
        throw new Error('File manager not properly initialized.');
    }
    
    // agentId and topicId are kept for logging/context but no longer determine the storage path.
    console.log(`[FileManager] storeFile called for original: "${originalName}", context: agent=${agentId}, topic=${topicId}`);

    // 1. Get file buffer
    let fileBuffer;
    if (typeof sourcePathOrBuffer === 'string') {
        fileBuffer = await fs.readFile(sourcePathOrBuffer);
    } else if (Buffer.isBuffer(sourcePathOrBuffer)) {
        fileBuffer = sourcePathOrBuffer;
    } else {
        throw new Error('Invalid file source. Must be a path string or a Buffer.');
    }

    // 2. Calculate hash
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const fileExtension = path.extname(originalName);
    const internalFileName = `${hash}${fileExtension}`;
    const internalFilePath = path.join(ATTACHMENTS_DIR, internalFileName);

    // 3. Store file if it doesn't exist
    if (!await fs.pathExists(internalFilePath)) {
        console.log(`[FileManager] Storing new unique file: ${internalFileName}`);
        await fs.writeFile(internalFilePath, fileBuffer);
    } else {
        console.log(`[FileManager] File already exists, reusing: ${internalFileName}`);
    }

    const fileSize = fileBuffer.length;

    // 4. Determine MIME type (logic remains the same)
    let mimeType = fileTypeHint;
    if (!mimeType || mimeType === 'application/octet-stream') {
        const ext = path.extname(originalName).toLowerCase();
        switch (ext) {
            case '.txt': mimeType = 'text/plain'; break;
            case '.json': mimeType = 'application/json'; break;
            case '.xml': mimeType = 'application/xml'; break;
            case '.csv': mimeType = 'text/csv'; break;
            case '.html': mimeType = 'text/html'; break;
            case '.css': mimeType = 'text/css'; break;
            case '.js': case '.mjs': mimeType = 'application/javascript'; break;
            case '.pdf': mimeType = 'application/pdf'; break;
            case '.doc': mimeType = 'application/msword'; break;
            case '.docx': mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; break;
            case '.xls': mimeType = 'application/vnd.ms-excel'; break;
            case '.xlsx': mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; break;
            case '.ppt': mimeType = 'application/vnd.ms-powerpoint'; break;
            case '.pptx': mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; break;
            case '.jpg': case '.jpeg': mimeType = 'image/jpeg'; break;
            case '.png': mimeType = 'image/png'; break;
            case '.gif': mimeType = 'image/gif'; break;
            case '.svg': mimeType = 'image/svg+xml'; break;
            case '.mp3': mimeType = 'audio/mpeg'; break;
            case '.wav': mimeType = 'audio/wav'; break;
            case '.ogg': mimeType = 'audio/ogg'; break;
            case '.flac': mimeType = 'audio/flac'; break;
            case '.aac': mimeType = 'audio/aac'; break;
            case '.aiff': mimeType = 'audio/aiff'; break;
            case '.mp4': mimeType = 'video/mp4'; break;
            case '.webm': mimeType = 'video/webm'; break;
            case '.bat': case '.sh': case '.py': case '.java': case '.c': case '.cpp': case '.h': case '.hpp': case '.cs': case '.go': case '.rb': case '.php': case '.swift': case '.kt': case '.kts': case '.ts': case '.tsx': case '.jsx': case '.vue': case '.yml': case '.yaml': case '.toml': case '.ini': case '.log': case '.sql': case '.jsonc': case '.rs': case '.dart': case '.lua': case '.r': case '.pl': case '.ex': case '.exs': case '.zig': case '.hs': case '.scala': case '.groovy': case '.d': case '.nim': case '.cr':
                mimeType = 'text/plain';
                break;
            default:
                mimeType = fileTypeHint || 'application/octet-stream';
        }
    }

    // 强制修正MP3的MIME类型，因为浏览器或系统有时会错误地报告为 audio/mpeg
    if (path.extname(originalName).toLowerCase() === '.mp3') {
        mimeType = 'audio/mpeg';
    }

    // 5. Construct the structured data object to return
    const attachmentData = {
        id: `attachment_${hash}`,
        name: originalName,
        internalFileName: internalFileName,
        internalPath: `file://${internalFilePath}`,
        type: mimeType,
        size: fileSize,
        hash: hash,
        createdAt: Date.now(),
        extractedText: null,
        imageFrames: null, // 新增：用于存储PDF转换后的图片
    };

    // 6. Attempt to extract text content or convert to images
    try {
        const textContentResult = await getTextContent(internalFilePath, attachmentData.type);
        if (textContentResult && textContentResult.text) {
            attachmentData.extractedText = textContentResult.text;
            console.log(`[FileManager] Successfully extracted text for ${attachmentData.name}, length: ${textContentResult.text.length}`);
        } else if (textContentResult && textContentResult.imageFrames) {
            attachmentData.imageFrames = textContentResult.imageFrames;
            attachmentData.extractedText = `[VChat Auto-summary: This is a scanned PDF named "${attachmentData.name}". The content is displayed as images.]`;
            console.log(`[FileManager] PDF ${attachmentData.name} was converted to ${textContentResult.imageFrames.length} images.`);
        } else {
            console.log(`[FileManager] No text content extracted or supported for ${attachmentData.name} (type: ${attachmentData.type}).`);
        }
    } catch (error) {
        console.error(`[FileManager] Error during content extraction for ${attachmentData.name}:`, error);
    }

    console.log('[FileManager] File processed:', attachmentData);
    return attachmentData;
}

// Placeholder for future functions
async function getFileAsBase64(internalPath) {
    try {
        if (!internalPath || !internalPath.startsWith('file://')) {
            throw new Error('无效的内部路径格式。必须是 file:// URL。');
        }
        
        // 直接根据用户反馈和日志进行路径清理
        // 'file:///H:/...' -> 'H:/...'
        let cleanPath = decodeURIComponent(internalPath.replace(/^file:\/\//, ''));
        if (process.platform === 'win32' && cleanPath.startsWith('/')) {
            cleanPath = cleanPath.substring(1);
        }

        console.log(`[Main - get-file-as-base64] Received raw filePath: "${internalPath}"`);
        console.log(`[Main - get-file-as-base64] Cleaned path: "${cleanPath}"`);

        if (!await fs.pathExists(cleanPath)) {
            console.error(`[Main - get-file-as-base64] File not found at path: ${cleanPath}`);
            throw new Error(`文件未找到: ${cleanPath}`);
        }
        const fileBuffer = await fs.readFile(cleanPath);
        const base64Data = fileBuffer.toString('base64');
        
        return {
            success: true,
            base64Frames: [base64Data]
        };
    } catch (error) {
        console.error(`[FileManager] getFileAsBase64 函数出错，路径: ${internalPath}:`, error);
        return { success: false, error: error.message, base64Frames: [] };
    }
}

const poppler = require('pdf-poppler');

async function getTextContent(internalFilePath, fileType) {
    let effectiveFileType = fileType;
    const cleanPath = internalFilePath.startsWith('file://') ? internalFilePath.substring(7) : internalFilePath;

    // Infer type from extension if needed
    if ((!effectiveFileType || effectiveFileType === 'application/octet-stream')) {
        const ext = path.extname(cleanPath).toLowerCase();
        switch (ext) {
            case '.txt': case '.md': case '.json': case '.xml': case '.csv': case '.html':
            case '.css': case '.js': case '.mjs': case '.bat': case '.sh': case '.py':
            case '.java': case '.c': case '.cpp': case '.h': case '.hpp': case '.cs':
            case '.go': case '.rb': case '.php': case '.swift': case '.kt': case '.ts':
            case '.tsx': case '.jsx': case '.vue': case '.yml': case '.yaml': case '.toml':
            case '.ini': case '.log': case '.sql': case '.jsonc': case '.rs': case '.dart': case '.lua': case '.r': case '.pl': case '.ex': case '.exs': case '.zig': case '.hs': case '.scala': case '.groovy': case '.d': case '.nim': case '.cr':
                effectiveFileType = 'text/plain';
                break;
            case '.pdf':
                effectiveFileType = 'application/pdf';
                break;
            case '.docx':
                effectiveFileType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                break;
        }
    }

    // Process based on effective file type
    if (effectiveFileType && effectiveFileType.startsWith('text/')) {
        try {
            const text = await fs.readFile(cleanPath, 'utf-8');
            return { text };
        } catch (error) {
            console.error(`[FileManager] Error reading text content for ${cleanPath}:`, error);
            return { text: null };
        }
    } else if (effectiveFileType === 'application/pdf') {
        try {
            const dataBuffer = await fs.readFile(cleanPath);
            const data = await pdf(dataBuffer);
            // To determine if a PDF is scanned, we check not just the length of the extracted text,
            // but also the number of alphabetic characters. This helps filter out OCR noise or PDFs
            // that contain only symbols or formatting characters.
            const text = data.text || '';
            const trimmedText = text.trim();
            const letterCount = (trimmedText.match(/[a-zA-Z]/g) || []).length;

            // A document is considered text-based if it has a decent amount of trimmed text
            // AND a minimum number of alphabetic characters.
            if (trimmedText.length > 20 && letterCount > 10) {
                console.log(`[FileManager] Successfully extracted text from PDF ${cleanPath}, length: ${trimmedText.length}, letterCount: ${letterCount}`);
                return { text: text };
            } else {
                // If text is very short or lacks letters, treat as scanned PDF
                const textLength = trimmedText.length;
                console.log(`[FileManager] PDF ${cleanPath} has little or no extractable text (length: ${textLength}, letterCount: ${letterCount}). Attempting image conversion.`);
                try {
                    const imageFrames = await _convertPdfToImages(cleanPath);
                    return { imageFrames };
                } catch (conversionError) {
                    console.error(`[FileManager] Failed to convert PDF to images: ${conversionError.message}`);
                    // Return the minimal text if conversion fails, better than nothing.
                    return { text: text || null, imageFrames: null };
                }
            }
        } catch (pdfParseError) {
            // This catches errors from the initial pdf-parse call itself
            console.warn(`[FileManager] Failed to parse PDF text, treating as scanned: ${pdfParseError.message}`);
            try {
                const imageFrames = await _convertPdfToImages(cleanPath);
                return { imageFrames };
            } catch (conversionError) {
                console.error(`[FileManager] Failed to convert PDF to images after parsing failed: ${conversionError.message}`);
                return { text: null, imageFrames: null };
            }
        }
    } else if (effectiveFileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        try {
            const dataBuffer = await fs.readFile(cleanPath);
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            return { text: result.value };
        } catch (error) {
            console.error(`[FileManager] Error parsing DOCX content for ${cleanPath}:`, error);
            return { text: null };
        }
    }

    console.log(`[FileManager] getTextContent: File type '${effectiveFileType}' is not supported for text extraction.`);
    return { text: null };
}

/**
 * Converts each page of a PDF file into a JPEG image.
 * @param {string} pdfPath - The file system path to the PDF file.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of Base64 encoded JPEG strings.
 */
async function _convertPdfToImages(pdfPath) {
    console.log(`[FileManager] Starting PDF to image conversion with Poppler for: ${pdfPath}`);
    const imageFrames = [];
    const tempDir = path.join(os.tmpdir(), `pdf-images-${crypto.randomBytes(16).toString('hex')}`);
    await fs.ensureDir(tempDir);

    try {
        let opts = {
            format: 'jpeg',
            out_dir: tempDir,
            out_prefix: path.basename(pdfPath, path.extname(pdfPath)),
            page: null // Convert all pages
        };

        await poppler.convert(pdfPath, opts);

        const files = await fs.readdir(tempDir);
        // Sort files numerically if they follow a standard pattern like 'file-1.jpg', 'file-2.jpg'
        files.sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0], 10);
            const numB = parseInt(b.match(/\d+/)[0], 10);
            return numA - numB;
        });

        for (const file of files) {
            if (file.endsWith('.jpg') || file.endsWith('.jpeg')) {
                const imagePath = path.join(tempDir, file);
                const imageBuffer = await fs.readFile(imagePath);
                imageFrames.push(imageBuffer.toString('base64'));
                console.log(`[FileManager] Converted and encoded page: ${file}`);
            }
        }
        console.log(`[FileManager] Finished converting ${imageFrames.length} pages to images.`);
    } catch (error) {
        console.error(`[FileManager] Poppler PDF to image conversion failed:`, error);
        // Re-throw the error to be caught by the calling function in getTextContent
        throw new Error(`Poppler conversion failed: ${error.message}`);
    } finally {
        // Clean up the temporary directory
        await fs.remove(tempDir);
        console.log(`[FileManager] Cleaned up temporary directory: ${tempDir}`);
    }

    return imageFrames;
}


module.exports = {
    initializeFileManager,
    storeFile,
    getFileAsBase64, // Exposing for now, might be internalized later
    getTextContent,   // Exposing for now
};
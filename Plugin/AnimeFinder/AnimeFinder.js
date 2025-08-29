const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { fileURLToPath } = require('url');
const mime = require('mime-types'); // 引入 mime-types 库

const TEMP_IMAGE_DIR = path.join(__dirname, '..', '..', 'image', 'AnimeFinder');
const TRACE_MOE_API = 'https://api.trace.moe/search?cutBorders&anilistInfo';

// --- Helper Functions ---

/**
 * 确保临时图片目录存在
 */
async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });
    } catch (error) {
        // 忽略目录已存在的错误
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

/**
 * 从 URL 下载文件并保存到本地
 * @param {string} urlString - 要下载的URL
 * @returns {Promise<string>} - 保存的文件路径
 */
function downloadFile(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const protocol = url.protocol === 'https:' ? https : http;
        const fileName = path.basename(url.pathname) || `temp_${Date.now()}`;
        const filePath = path.join(TEMP_IMAGE_DIR, fileName);

        const request = protocol.get(urlString, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`下载文件失败，状态码: ${response.statusCode}`));
                return;
            }
            const fileStream = require('fs').createWriteStream(filePath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(() => resolve(filePath));
            });
        });

        request.on('error', (err) => {
            fs.unlink(filePath).catch(() => {});
            reject(err);
        });
    });
}

/**
 * 格式化 trace.moe 的成功结果
 * @param {object} data - API返回的JSON数据
 * @returns {string} - 格式化后的文本结果
 */
function formatSuccessResult(data) {
    if (!data.result || data.result.length === 0) {
        return "未能找到任何匹配的动漫。";
    }

    let resultText = `### 🔍 以图找番结果\n\n找到了 ${data.result.length} 个可能的匹配项，以下为最相似的前3个：\n\n---\n`;

    data.result.slice(0, 3).forEach((match, index) => {
        const { anilist, similarity, filename, episode, from, to } = match;
        const title = anilist.title.romaji || anilist.title.native || anilist.title.english || "未知标题";

        resultText += `**匹配项 ${index + 1}**\n`;
        resultText += `- **动漫标题:** ${title}\n`;
        if (anilist.synonyms && anilist.synonyms.length > 0) {
            resultText += `- **其他名称:** ${anilist.synonyms.join(', ')}\n`;
        }
        resultText += `- **相似度:** **${(similarity * 100).toFixed(2)}%**\n`;
        if (episode) {
            resultText += `- **集数:** ${episode}\n`;
        }
        if (from && to) {
            const formatTime = (seconds) => new Date(seconds * 1000).toISOString().substr(11, 8);
            resultText += `- **出现时间:** ${formatTime(from)} - ${formatTime(to)}\n`;
        }
        resultText += `- **来源文件名:** ${filename}\n\n---\n`;
    });

    resultText += `*结果由 trace.moe 提供*`;

    return resultText;
}


/**
 * 主处理函数
 * @param {object} args - 输入参数
 */
async function processRequest(args) {
    // 鲁棒性设计：兼容不同的大小写和下划线格式
    const imageUrl = args.imageUrl || args.image_url || args.ImageUrl;
    const imageBase64 = args.imageBase64 || args.image_base64;
    // 从主服务接收mimeType（超栈追踪重试时）
    const mimeType = args.mimeType;

    if (!imageUrl && !imageBase64) {
        throw new Error("必须提供 imageUrl 或 imageBase64 参数。");
    }

    let searchResult;

    // 优先处理Base64（来自超栈追踪的重试）
    if (imageBase64) {
        await ensureTempDir();

        let pureBase64 = imageBase64;
        // 检查并处理 Data URI 格式
        const dataUriMatch = imageBase64.match(/^data:image\/\w+;base64,(.*)$/);
        if (dataUriMatch) {
            pureBase64 = dataUriMatch[1];
        }

        const imageBuffer = Buffer.from(pureBase64, 'base64');
        
        // 从MIME类型推断文件扩展名，默认为.png
        const extension = mime.extension(mimeType) || 'png';
        const tempFileName = `temp_${Date.now()}.${extension}`;
        const tempFilePath = path.join(TEMP_IMAGE_DIR, tempFileName);

        try {
            // 将解码后的buffer写入临时文件
            await fs.writeFile(tempFilePath, imageBuffer);
            
            // 现在，流程与处理其他本地文件完全一致
            const fileBufferForUpload = await fs.readFile(tempFilePath);
            const contentType = mime.lookup(tempFilePath) || 'application/octet-stream';

            const response = await fetch(TRACE_MOE_API, {
                method: 'POST',
                body: fileBufferForUpload,
                headers: { 'Content-Type': contentType },
            });
            searchResult = await response.json();

        } finally {
            // 恢复清理机制
            await fs.unlink(tempFilePath).catch(err => console.error(`清理临时文件失败: ${err.message}`));
        }

    } else if (imageUrl.startsWith('https://')) {
        const searchUrl = `${TRACE_MOE_API}&url=${encodeURIComponent(imageUrl)}`;
        const response = await fetch(searchUrl);
        searchResult = await response.json();

    } else if (imageUrl.startsWith('http://')) {
        await ensureTempDir();
        const filePath = await downloadFile(imageUrl);
        const fileBuffer = await fs.readFile(filePath);
        const contentType = mime.lookup(filePath) || 'application/octet-stream';

        const response = await fetch(TRACE_MOE_API, {
            method: 'POST',
            body: fileBuffer,
            headers: { 'Content-Type': contentType },
        });
        searchResult = await response.json();
        await fs.unlink(filePath); // 清理临时文件

    } else if (imageUrl.startsWith('file://')) {
        const filePath = fileURLToPath(imageUrl);
        try {
            const fileBuffer = await fs.readFile(filePath);
            const contentType = mime.lookup(filePath) || 'application/octet-stream';
            const response = await fetch(TRACE_MOE_API, {
                method: 'POST',
                body: fileBuffer,
                headers: { 'Content-Type': contentType },
            });
            searchResult = await response.json();
        } catch (e) {
            if (e.code === 'ENOENT') {
                // 实现超栈追踪的关键：抛出特定错误
                const structuredError = new Error("本地文件未找到，需要远程获取。");
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = imageUrl;
                throw structuredError;
            } else {
                throw new Error(`读取本地文件时发生错误: ${e.message}`);
            }
        }
    } else {
        throw new Error(`不支持的URL协议: ${imageUrl}`);
    }

    if (searchResult.error) {
        throw new Error(`API 返回错误: ${searchResult.error}`);
    }

    return formatSuccessResult(searchResult);
}

// --- Main Execution Logic ---

async function main() {
    try {
        let input = '';
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', async () => {
            try {
                const args = JSON.parse(input);
                const resultText = await processRequest(args);
                console.log(JSON.stringify({ status: "success", result: resultText }));
                process.exit(0);
            } catch (e) {
                // 捕获超栈追踪错误
                if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
                    console.log(JSON.stringify({
                        status: "error",
                        code: e.code,
                        error: e.message,
                        fileUrl: e.fileUrl
                    }));
                } else {
                    console.log(JSON.stringify({ status: "error", error: e.message }));
                }
                process.exit(1);
            }
        });
    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: e.message }));
        process.exit(1);
    }
}

main();
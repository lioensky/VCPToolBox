#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yauzl from 'yauzl';
import { promisify } from 'util';

// --- Configuration (from environment variables set by Plugin.js) ---
const NOVELAI_API_KEY = process.env.NOVELAI_API_KEY; // NovelAI API Key
const debugMode = (process.env.DebugMode || "false").toLowerCase() === "true"; // Debug mode
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;
const VAR_HTTPS_URL = process.env.VarHttpsUrl;

// Debug logging function - outputs to stderr for VCP compatibility
function FORCE_LOG(...args) {
    console.error(...args); // 强制日志输出到 stderr
}

// NovelAI API specific configurations
const NOVELAI_API_CONFIG = {
    BASE_URL: 'https://image.novelai.net',
    IMAGE_GENERATION_ENDPOINT: '/ai/generate-image',
    DEFAULT_PARAMS: {
        model: "nai-diffusion-4-5-full", // NAI Diffusion V4.5 Full 模型
        parameters: {
            // V4 API 基础参数 (width和height由用户指定)
            steps: 23,
            scale: 5,
            sampler: "k_euler_ancestral",
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: true,
            
            // V4 新增参数
            params_version: 3,
            noise_schedule: "karras",
            prefer_brownian: true,
            add_original_image: false,
            autoSmea: false,
            cfg_rescale: 0,
            controlnet_strength: 1,
            deliberate_euler_ancestral_bug: false,
            dynamic_thresholding: false,
            legacy: false,
            legacy_uc: false,
            legacy_v3_extend: false,
            normalize_reference_strength_multiple: true,
            skip_cfg_above_sigma: null,
            use_coords: false
        },
        
        // V4 专用负面提示词格式
        negative_prompt_base: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
    }
};

// Helper to validate input arguments
function isValidNovelAIGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (typeof args.resolution !== 'string') return false;
    const parts = args.resolution.split('x');
    if (parts.length !== 2) return false;
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    if (isNaN(width) || isNaN(height)) return false;
    return true;
}

// 解压ZIP文件并提取图片
async function extractImagesFromZip(zipBuffer) {
    return new Promise((resolve, reject) => {
        const images = [];
        
        yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                reject(new Error(`NovelAI Plugin Error: Failed to read ZIP buffer: ${err.message}`));
                return;
            }

            zipfile.readEntry();
            
            zipfile.on("entry", (entry) => {
                if (/\/$/.test(entry.fileName)) {
                    // Directory entry, skip
                    zipfile.readEntry();
                } else {
                    // File entry
                    if (entry.fileName.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(new Error(`NovelAI Plugin Error: Failed to read entry: ${err.message}`));
                                return;
                            }

                            const chunks = [];
                            readStream.on('data', (chunk) => {
                                chunks.push(chunk);
                            });

                            readStream.on('end', () => {
                                const imageBuffer = Buffer.concat(chunks);
                                const fileExtension = path.extname(entry.fileName).substring(1) || 'png';
                                images.push({
                                    name: entry.fileName,
                                    buffer: imageBuffer,
                                    extension: fileExtension
                                });
                                zipfile.readEntry();
                            });

                            readStream.on('error', (err) => {
                                reject(new Error(`NovelAI Plugin Error: Failed to read stream: ${err.message}`));
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                }
            });

            zipfile.on("end", () => {
                if (images.length === 0) {
                    reject(new Error("NovelAI Plugin Error: No valid images found in ZIP response"));
                } else {
                    resolve(images);
                }
            });

            zipfile.on("error", (err) => {
                reject(new Error(`NovelAI Plugin Error: ZIP processing error: ${err.message}`));
            });
        });
    });
}

async function generateImageAndSave(args) {
    if (debugMode) {
        FORCE_LOG('[NovelAIGen] Starting image generation with parameters:', {
            prompt: args.prompt?.substring(0, 100) + (args.prompt?.length > 100 ? '...' : ''),
            model: NOVELAI_API_CONFIG.DEFAULT_PARAMS.model,
            config: 'Using official recommended default settings'
        });
    }

    // Check for essential environment variables
    if (!NOVELAI_API_KEY) {
        const errorMsg = "NovelAI API密钥未配置。请在环境变量中设置NOVELAI_API_KEY。";
        if (debugMode) FORCE_LOG('[NovelAIGen] Error:', errorMsg);
        throw new Error("NovelAI Plugin Error: NOVELAI_API_KEY environment variable is required.");
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error("NovelAI Plugin Error: PROJECT_BASE_PATH environment variable is required for saving images.");
    }
    if (!SERVER_PORT) {
        throw new Error("NovelAI Plugin Error: SERVER_PORT environment variable is required for constructing image URL.");
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error("NovelAI Plugin Error: IMAGESERVER_IMAGE_KEY environment variable is required for constructing image URL.");
    }
    if (!VAR_HTTP_URL) {
        throw new Error("NovelAI Plugin Error: VarHttpUrl environment variable is required for constructing image URL.");
    }

    if (!isValidNovelAIGenArgs(args)) {
        throw new Error(`NovelAI Plugin Error: Invalid arguments received: ${JSON.stringify(args)}. Required: prompt (string), resolution (string).`);
    }

    // 解析分辨率
    const parts = args.resolution.split('x');
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);

    // 构建请求payload - 根据NovelAI V4 API格式
    const payload = {
        action: "generate",  // 必需字段！根据官方API文档
        model: NOVELAI_API_CONFIG.DEFAULT_PARAMS.model,
        input: args.prompt,  // 保留旧格式的input字段
        
        parameters: {
            ...NOVELAI_API_CONFIG.DEFAULT_PARAMS.parameters,
            
            // 使用用户指定的分辨率
            width: width,
            height: height,
            
            // V4专用提示词结构（在parameters内部）
            v4_prompt: {
                caption: {
                    base_caption: args.prompt,
                    char_captions: []
                },
                use_coords: false,
                use_order: true
            },
            
            // V4专用负面提示词结构（在parameters内部）
            v4_negative_prompt: {
                caption: {
                    base_caption: NOVELAI_API_CONFIG.DEFAULT_PARAMS.negative_prompt_base,
                    char_captions: []
                },
                legacy_uc: false
            },
            
            // 保留旧格式的negative_prompt字段
            negative_prompt: NOVELAI_API_CONFIG.DEFAULT_PARAMS.negative_prompt_base,
            
            // 动态生成随机种子
            seed: Math.floor(Math.random() * 4294967295),
            characterPrompts: [],
            inpaintImg2ImgStrength: 1
        }
    };

    if (debugMode) FORCE_LOG('[NovelAIGen] Sending payload to NovelAI API:', JSON.stringify(payload, null, 2));

    const headers = {
        'Authorization': `Bearer ${NOVELAI_API_KEY}`,
        'Content-Type': 'application/json'
    };

    const novelaiAxiosInstance = axios.create({
        baseURL: NOVELAI_API_CONFIG.BASE_URL,
        headers: headers,
        timeout: 180000, // 3分钟超时
        responseType: 'arraybuffer' // 重要：设置为arraybuffer以接收二进制数据
    });

    const response = await novelaiAxiosInstance.post(
        NOVELAI_API_CONFIG.IMAGE_GENERATION_ENDPOINT,
        payload
    );

    if (debugMode) FORCE_LOG(`[NovelAIGen] Received response from NovelAI API, content-type: ${response.headers['content-type']}`);

    // 检查响应是否为ZIP格式
    const contentType = response.headers['content-type'] || '';
    const isZipResponse = contentType.includes('application/zip') || 
                         contentType.includes('application/octet-stream') ||
                         contentType.includes('binary/octet-stream') ||
                         contentType.includes('octet-stream');
    
    if (!isZipResponse) {
        // 如果不是ZIP，可能是错误响应，尝试解析为JSON
        try {
            const errorText = Buffer.from(response.data).toString('utf8');
            const errorJson = JSON.parse(errorText);
            throw new Error(`NovelAI Plugin Error: API returned error: ${JSON.stringify(errorJson)}`);
        } catch (parseError) {
            throw new Error(`NovelAI Plugin Error: Unexpected response format. Expected ZIP file but got: ${contentType}`);
        }
    }

    // 解压ZIP并提取图片
    const zipBuffer = Buffer.from(response.data);
    const extractedImages = await extractImagesFromZip(zipBuffer);

    if (debugMode) FORCE_LOG(`[NovelAIGen] Extracted ${extractedImages.length} images from ZIP`);

    // 保存图片并生成URL
    const novelaiImageDir = path.join(PROJECT_BASE_PATH, 'image', 'novelaigen');
    await fs.mkdir(novelaiImageDir, { recursive: true });

    const savedImages = [];
    
    for (let i = 0; i < extractedImages.length; i++) {
        const image = extractedImages[i];
        const generatedFileName = `${uuidv4()}.${image.extension}`;
        const localImageServerPath = path.join(novelaiImageDir, generatedFileName);
        
        await fs.writeFile(localImageServerPath, image.buffer);
        if (debugMode) FORCE_LOG(`[NovelAIGen] Image ${i + 1} saved to: ${localImageServerPath}`);

        const relativeServerPathForUrl = path.join('novelaigen', generatedFileName).replace(/\\\\/g, '/');
        // 优先使用HTTPS公网URL，如果没有配置则回退到HTTP本地URL
        const baseUrl = VAR_HTTPS_URL ? VAR_HTTPS_URL : `${VAR_HTTP_URL}:${SERVER_PORT}`;
        const accessibleImageUrl = `${baseUrl}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        savedImages.push({
            filename: generatedFileName,
            url: accessibleImageUrl,
            localPath: localImageServerPath
        });
    }

    // 生成结果消息
    const altText = args.prompt ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "") : "NovelAI生成的图片";
    
    let successMessage = `NovelAI 图片生成成功！共生成 ${savedImages.length} 张图片\n\n`;
    
    successMessage += `生成参数：\n`;
    successMessage += `- 模型: ${payload.model}\n`;
    successMessage += `- 尺寸: ${payload.parameters.width}x${payload.parameters.height}\n`;
    successMessage += `- 采样器: ${payload.parameters.sampler}\n`;
    successMessage += `- 步数: ${payload.parameters.steps}\n`;
    successMessage += `- 引导系数: ${payload.parameters.scale}\n\n`;
    
    successMessage += `详细信息：\n`;
    
    savedImages.forEach((image, index) => {
        successMessage += `图片 ${index + 1}:\n`;
        successMessage += `- 图片URL: ${image.url}\n`;
        successMessage += `- 服务器路径: image/novelaigen/${image.filename}\n`;
        successMessage += `- 文件名: ${image.filename}\n\n`;
    });
    
    successMessage += `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n`;
    
    savedImages.forEach((image, index) => {
        successMessage += `<img src="${image.url}" alt="${altText} ${index + 1}" width="300">\n`;
    });

    return successMessage;
}

async function main() {
    if (debugMode) FORCE_LOG('[NovelAIGen] Plugin started, debug mode enabled');
    
    let inputChunks = [];
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');
    let parsedArgs;

    try {
        if (!inputData.trim()) {
            const errorMsg = "NovelAI Plugin Error: No input data received from stdin.";
            if (debugMode) FORCE_LOG('[NovelAIGen] Error:', errorMsg);
            console.log(JSON.stringify({ status: "error", error: errorMsg }));
            process.exit(1);
            return;
        }
        
        if (debugMode) FORCE_LOG('[NovelAIGen] Received input data:', inputData.substring(0, 200) + (inputData.length > 200 ? '...' : ''));
        
        parsedArgs = JSON.parse(inputData);
        const formattedResultString = await generateImageAndSave(parsedArgs);
        console.log(JSON.stringify({ status: "success", result: formattedResultString }));
    } catch (e) {
        let detailedError = e.message || "Unknown error in NovelAI plugin";
        
        if (debugMode) {
            FORCE_LOG('[NovelAIGen] Error caught in main:', e.toString());
            if (e.stack) {
                FORCE_LOG('[NovelAIGen] Error stack:', e.stack);
            }
        }
        
        if (e.response && e.response.data) {
            // 如果API返回了特定的错误消息，包含它
            try {
                const errorText = Buffer.from(e.response.data).toString('utf8');
                detailedError += ` - API Response: ${errorText}`;
                if (debugMode) FORCE_LOG('[NovelAIGen] API Error Response:', errorText);
            } catch (parseError) {
                detailedError += ` - API Response: [Binary data, cannot parse]`;
                if (debugMode) FORCE_LOG('[NovelAIGen] API returned binary data, cannot parse as text');
            }
        }
        
        const finalErrorMessage = detailedError.startsWith("NovelAI Plugin Error:") ? detailedError : `NovelAI Plugin Error: ${detailedError}`;
        if (debugMode) FORCE_LOG('[NovelAIGen] Final error message:', finalErrorMessage);
        
        console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        process.exit(1);
    }
}

main(); 
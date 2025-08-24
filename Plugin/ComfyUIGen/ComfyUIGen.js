#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- Configuration Loading System ---
// Priority: comfyui-settings.json > environment variables > defaults
const SETTINGS_FILE = path.resolve(__dirname, 'comfyui-settings.json');

// Load configuration with priority system
async function loadConfiguration() {
    let config = {
        // Default values
        COMFYUI_BASE_URL: 'http://localhost:8188',
        COMFYUI_API_KEY: '',
        DEBUG_MODE: false,
        workflow: 'text2img_basic'
    };
    
    // Load from comfyui-settings.json if exists (highest priority for user settings)
    try {
        if (await fs.access(SETTINGS_FILE).then(() => true).catch(() => false)) {
            const settingsContent = await fs.readFile(SETTINGS_FILE, 'utf8');
            const userSettings = JSON.parse(settingsContent);
            
            // Map user settings to configuration
            if (userSettings.serverUrl) config.COMFYUI_BASE_URL = userSettings.serverUrl;
            if (userSettings.apiKey) config.COMFYUI_API_KEY = userSettings.apiKey;
            if (userSettings.workflow) config.workflow = userSettings.workflow;
            
            // Store all user settings for parameter processing
            config.userSettings = userSettings;
            
            debugLog('Loaded user settings from comfyui-settings.json:', userSettings);
        }
    } catch (error) {
        debugLog('Warning: Failed to load comfyui-settings.json:', error.message);
    }
    
    // Override with environment variables if set (for system-level configuration)
    config.COMFYUI_BASE_URL = process.env.COMFYUI_BASE_URL || config.COMFYUI_BASE_URL;
    config.COMFYUI_API_KEY = process.env.COMFYUI_API_KEY || config.COMFYUI_API_KEY;
    config.DEBUG_MODE = (process.env.DEBUG_MODE || config.DEBUG_MODE || 'false').toLowerCase() === 'true';
    
    // Required system environment variables
    config.PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
    config.SERVER_PORT = process.env.SERVER_PORT;
    config.IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
    config.VAR_HTTP_URL = process.env.VarHttpUrl;
    
    return config;
}

// 调试日志函数
function debugLog(...args) {
    // Will be set after configuration is loaded
    if (global.DEBUG_MODE) {
        console.error('[ComfyUIGen Debug]', ...args);
    }
}

// Helper to validate input arguments
function isValidComfyUIGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    return true;
}

// 加载工作流模板
async function loadWorkflowTemplate(templateName = 'text2img_basic') {
    try {
        const workflowPath = path.join(__dirname, 'workflows', `${templateName}.json`);
        const workflowData = await fs.readFile(workflowPath, 'utf-8');
        return JSON.parse(workflowData);
    } catch (error) {
        debugLog(`Failed to load workflow template ${templateName}:`, error.message);
        throw new Error(`Workflow template '${templateName}' not found. Please ensure the template exists in the workflows directory.`);
    }
}


const { randomBytes } = require('crypto');

// 生成合法随机种子（0..2^32-1）使用加密学安全源，避免 Math.random 偏差
function generateRandomSeed() {
   return randomBytes(4).readUInt32BE(0); // 0..4294967295
}

// 解析与规范化种子：当 seedCandidate === -1 或非法时 => 运行时随机；其余进行范围裁剪
function resolveSeed(seedCandidate) {
   let s = Number(seedCandidate);
   if (!Number.isFinite(s) || !Number.isInteger(s) || s === -1) {
       s = generateRandomSeed();
   }
   // 裁剪到 0..0xFFFFFFFF
   if (s < 0) s = 0;
   if (s > 0xFFFFFFFF) s = 0xFFFFFFFF;
   return s;
}

// 纯粹的数据替换 - 直接替换占位符为具体值（含种子自动处理）
function fillWorkflowParameters(workflow, args, config) {
    const settings = config.userSettings || {};
    const userPrompt = args.prompt || '';
    
    // 构建LoRA字符串
    const lorasString = buildLoRAsString(settings.loras || []);
    
    // 构建完整的正面提示词
    const positivePromptParts = [
        userPrompt,
        lorasString,
        settings.qualityTags
    ].filter(part => part && String(part).trim());
    const positivePrompt = positivePromptParts.join(', ');
    
    // 先解析种子：当配置默认种子为 -1 或非法时，运行时自动改为随机合法值（不透传 -1）
    const resolvedSeed = resolveSeed(settings.defaultSeed);

    // 构建负面提示词
    const negativePromptParts = [
        settings.negativePrompt,
        args.negative_prompt
    ].filter(part => part && String(part).trim());
    const negativePrompt = negativePromptParts.join(', ');
    
    // 构建替换映射
    const replacements = {
        // 基础参数 - 优先使用args传入的值
        '{{MODEL}}': settings.defaultModel || 'sd_xl_base_1.0.safetensors',
        '{{WIDTH}}': args.width || settings.defaultWidth || 1024,
        '{{HEIGHT}}': args.height || settings.defaultHeight || 1024,
        '{{STEPS}}': settings.defaultSteps || 30,
        '{{CFG}}': settings.defaultCfg || 7.5,
        '{{SAMPLER}}': settings.defaultSampler || 'dpmpp_2m',
        '{{SCHEDULER}}': settings.defaultScheduler || 'normal',
        '{{SEED}}': resolvedSeed, // 使用运行时解析后的合法种子
        '{{DENOISE}}': settings.defaultDenoise || 1.0,
        '{{BATCH_SIZE}}': settings.defaultBatchSize || 1,
        
        // 提示词相关
        '{{POSITIVE_PROMPT}}': positivePrompt,
        '{{NEGATIVE_PROMPT}}': negativePrompt,
        '{{USER_PROMPT}}': userPrompt || '',
        '{{PROMPT_INPUT}}': userPrompt || '', // 独立提示词输入
        
        // 组件字符串
        '{{LORAS}}': lorasString,
        '{{QUALITY_TAGS}}': settings.qualityTags || '',

        // FaceDetailer 默认值
        '{{FD_SAM_THRESHOLD}}': settings.faceDetailerSamThreshold || 0.93,
        '{{FD_DROP_SIZE}}': settings.faceDetailerDropSize || 10,
        '{{FD_SAM_BBOX_EXPANSION}}': settings.faceDetailerSamBboxExpansion || 0,
        '{{FD_NOISE_MASK}}': settings.faceDetailerNoiseMask === false ? 'false' : 'true',
        '{{FD_GUIDE_SIZE_FOR}}': settings.faceDetailerGuideSizeFor === false ? 'false' : 'true',
        '{{FD_WILDCARD}}': settings.faceDetailerWildcard || '',
        '{{FD_CYCLE}}': settings.faceDetailerCycle || 1,
        '{{FD_SAM_MASK_HINT_THRESHOLD}}': settings.faceDetailerSamMaskHintThreshold || 0.7,
        '{{FD_FORCE_INPAINT}}': settings.faceDetailerForceInpaint === false ? 'false' : 'true',
        '{{FD_SAM_MASK_HINT_USE_NEGATIVE}}': settings.faceDetailerSamMaskHintUseNegative || 'False',
        '{{FD_MAX_SIZE}}': settings.faceDetailerMaxSize || 1024,
        '{{FD_SAM_DILATION}}': settings.faceDetailerSamDilation || 0,
        '{{FD_SAM_DETECTION_HINT}}': settings.faceDetailerSamDetectionHint || 'center-1',
        '{{FD_GUIDE_SIZE}}': settings.faceDetailerGuideSize || 512
    };
    
    // 安全的JSON替换 - 先解析为对象，然后递归替换
    function replaceInObject(obj, replacements) {
        if (typeof obj === 'string') {
            // 对字符串值进行占位符替换
            let result = obj;
            for (const [placeholder, value] of Object.entries(replacements)) {
                if (result.includes(placeholder)) {
                    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), String(value));
                }
            }
            return result;
        } else if (Array.isArray(obj)) {
            return obj.map(item => replaceInObject(item, replacements));
        } else if (obj !== null && typeof obj === 'object') {
            const newObj = {};
            for (const [key, value] of Object.entries(obj)) {
                newObj[key] = replaceInObject(value, replacements);
            }
            return newObj;
        }
        return obj;
    }
    
    // 在 DEBUG 模式下输出最终使用的种子，便于回溯
    debugLog('Resolved seed used for this request:', replacements['{{SEED}}']);
    
    // 使用安全的对象替换方法
    return replaceInObject(workflow, replacements);
}

// 构建LoRA字符串
function buildLoRAsString(loras) {
    if (!Array.isArray(loras)) return '';
    
    return loras
        .filter(lora => lora.enabled && lora.name)
        .map(lora => {
            const strength = lora.strength || 1.0;
            const clipStrength = lora.clipStrength || lora.strength || 1.0;
            return `<lora:${lora.name}:${strength}:${clipStrength}>`;
        })
        .join(', ');
}

// 提交工作流到ComfyUI队列
async function queuePrompt(workflow, config) {
    const comfyuiAxios = axios.create({
        baseURL: config.COMFYUI_BASE_URL,
        headers: config.COMFYUI_API_KEY ? { 'Authorization': `Bearer ${config.COMFYUI_API_KEY}` } : {},
        timeout: 30000
    });
    
    const promptData = {
        prompt: workflow,
        client_id: uuidv4()
    };
    
    debugLog('Submitting prompt to ComfyUI:', JSON.stringify(promptData, null, 2));
    
    const response = await comfyuiAxios.post('/prompt', promptData);
    return {
        prompt_id: response.data.prompt_id,
        client_id: promptData.client_id
    };
}

// 检查队列状态
async function checkQueueStatus(promptId, config) {
    const comfyuiAxios = axios.create({
        baseURL: config.COMFYUI_BASE_URL,
        timeout: 10000
    });
    
    const response = await comfyuiAxios.get(`/history/${promptId}`);
    return response.data[promptId] || null;
}

// 等待生成完成
async function waitForCompletion(promptId, config, maxAttempts = 60, interval = 3000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        debugLog(`Checking queue status, attempt ${attempt + 1}/${maxAttempts}`);
        
        const history = await checkQueueStatus(promptId, config);
        if (history && history.status && history.status.completed) {
            debugLog('Generation completed!');
            return history;
        }
        
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error('Generation timeout - please check ComfyUI status');
}

// 下载生成的图片
async function downloadGeneratedImages(history, config) {
    const images = [];
    
    if (history.outputs) {
        for (const nodeId in history.outputs) {
            const output = history.outputs[nodeId];
            if (output.images) {
                for (const imageInfo of output.images) {
                    const imageUrl = `${config.COMFYUI_BASE_URL}/view?filename=${imageInfo.filename}&subfolder=${imageInfo.subfolder || ''}&type=${imageInfo.type || 'output'}`;
                    debugLog('Downloading image from:', imageUrl);
                    
                    const response = await axios({
                        method: 'get',
                        url: imageUrl,
                        responseType: 'arraybuffer',
                        timeout: 60000
                    });
                    
                    images.push({
                        data: response.data,
                        filename: imageInfo.filename,
                        originalPath: imageUrl
                    });
                }
            }
        }
    }
    
    return images;
}

// 保存图片到本地
async function saveImagesToLocal(images, config) {
    if (!config.PROJECT_BASE_PATH) {
        throw new Error('PROJECT_BASE_PATH environment variable is required for saving images.');
    }
    
    const comfyuiImageDir = path.join(config.PROJECT_BASE_PATH, 'image', 'comfyuigen');
    await fs.mkdir(comfyuiImageDir, { recursive: true });
    
    const savedImages = [];
    
    for (const image of images) {
        const fileExtension = path.extname(image.filename) || '.png';
        const generatedFileName = `${uuidv4()}${fileExtension}`;
        const localImagePath = path.join(comfyuiImageDir, generatedFileName);
        
        await fs.writeFile(localImagePath, image.data);
        debugLog('Image saved to:', localImagePath);
        
        // 构建访问URL
        const relativeServerPathForUrl = path.join('comfyuigen', generatedFileName).replace(/\\/g, '/');
        const accessibleImageUrl = `${config.VAR_HTTP_URL}:${config.SERVER_PORT}/pw=${config.IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        savedImages.push({
            filename: generatedFileName,
            url: accessibleImageUrl,
            localPath: localImagePath,
            originalFilename: image.filename
        });
    }
    
    return savedImages;
}

// 主要生成函数
async function generateImageAndSave(args) {
    // 加载配置
    const config = await loadConfiguration();
    
    // 设置全局DEBUG模式
    global.DEBUG_MODE = config.DEBUG_MODE;
    
    debugLog('Starting image generation with config:', config);
    debugLog('Input arguments:', args);
    debugLog('Environment variables check:');
    debugLog('- PROJECT_BASE_PATH:', config.PROJECT_BASE_PATH);
    debugLog('- SERVER_PORT:', config.SERVER_PORT);
    debugLog('- IMAGESERVER_IMAGE_KEY:', config.IMAGESERVER_IMAGE_KEY);
    debugLog('- VAR_HTTP_URL:', config.VAR_HTTP_URL);
    
    // 环境变量检查 - 修正变量名
    if (!config.PROJECT_BASE_PATH) {
        throw new Error("ComfyUI Plugin Error: PROJECT_BASE_PATH environment variable is required.");
    }
    if (!config.SERVER_PORT || !config.IMAGESERVER_IMAGE_KEY || !config.VAR_HTTP_URL) {
        const missing = [];
        if (!config.SERVER_PORT) missing.push('SERVER_PORT');
        if (!config.IMAGESERVER_IMAGE_KEY) missing.push('IMAGESERVER_IMAGE_KEY');
        if (!config.VAR_HTTP_URL) missing.push('VAR_HTTP_URL');
        throw new Error(`ComfyUI Plugin Error: Missing environment variables: ${missing.join(', ')}. Available env vars: ${Object.keys(process.env).filter(k => k.includes('HTTP') || k.includes('PORT') || k.includes('IMAGE')).join(', ')}`);
    }

    if (!isValidComfyUIGenArgs(args)) {
        throw new Error(`ComfyUI Plugin Error: Invalid arguments. Required: prompt (string). Received: ${JSON.stringify(args)}`);
    }

    debugLog('Starting image generation with args:', args);

    // 通用回退序列
    const userPrompt = args.prompt || '';
    const tryWorkflows = [];

    // 首选：调用参数 > 配置
    const primaryWorkflowName = (args.workflow || config.workflow || 'text2img_basic');
    tryWorkflows.push(primaryWorkflowName);

    // 回退：text2img_basic（基础稳定模板）
    if (!tryWorkflows.includes('text2img_basic')) {
        tryWorkflows.push('text2img_basic');
    }

    let lastError = null;
    let savedImages = null;
    let usedWorkflow = null;

    for (const wfName of tryWorkflows) {
        try {
            debugLog(`Attempting workflow: ${wfName}`);
            const wfTemplate = await loadWorkflowTemplate(wfName);
            
            // 兼容旧格式（直接是工作流）和新格式（包含元数据和 workflow 键）
            const workflowObject = wfTemplate.workflow || wfTemplate;

            const updated = fillWorkflowParameters(workflowObject, args, config);
            const queueResult = await queuePrompt(updated, config);
            debugLog('Queued with prompt_id:', queueResult.prompt_id);

            const history = await waitForCompletion(queueResult.prompt_id, config);
            const images = await downloadGeneratedImages(history, config);
            if (images.length === 0) {
                throw new Error('No images were generated');
            }
            savedImages = await saveImagesToLocal(images, config);
            usedWorkflow = wfName;
            debugLog(`Workflow ${wfName} succeeded with ${savedImages.length} images`);
            break; // 成功，退出回退序列
        } catch (e) {
            lastError = e;
            debugLog(`Workflow ${wfName} failed:`, e && (e.message || e.toString()));
            // 继续下一回退候选
        }
    }

    if (!savedImages) {
        // 所有回退均失败
        throw new Error(`All workflow attempts failed. Primary: ${primaryWorkflowName}. Last error: ${lastError && lastError.message ? lastError.message : String(lastError)}`);
    }
    
    // 7. 构建返回结果 - 分离“日志文本”和“Agent HTML”
    const altText = args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "");
    
    // A) 日志文本（供 VCPTookBox 记录与调试）
    let logs = `ComfyUI 图片生成成功！共生成 ${savedImages.length} 张图片\n\n`;
    logs += `详细信息：\n`;
    savedImages.forEach((image, index) => {
        logs += `图片 ${index + 1}:\n`;
        logs += `- 图片URL: ${image.url}\n`;
        logs += `- 服务器路径: image/comfyuigen/${image.filename}\n`;
        logs += `- 文件名: ${image.filename}\n\n`;
    });
    
    // B) Agent 展示的 HTML 片段（直接用于渲染）
    let agentHtml = `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n`;
    savedImages.forEach((image, index) => {
        agentHtml += `<img src="${image.url}" alt="${altText} ${index + 1}" width="300">\n`;
    });

    // 返回一个统一字符串（向后兼容），供 main() 分离；同时为未来改造保留结构化返回的可能
    const combined = `${logs}${agentHtml}`;
    return combined;
}

// 主函数
async function main() {
    debugLog('ComfyUI Plugin started');
    
    let inputChunks = [];
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');
    
    try {
        if (!inputData.trim()) {
            throw new Error("ComfyUI Plugin Error: No input data received from stdin.");
        }
        
        debugLog('Received input:', inputData.substring(0, 200) + (inputData.length > 200 ? '...' : ''));
        
        const parsedArgs = JSON.parse(inputData);
        const result = await generateImageAndSave(parsedArgs);
        
        // 回退到通用输出协议：status + result（与 NovelAIGen 对齐）
        console.log(JSON.stringify({ status: "success", result: result }));
    } catch (error) {
        debugLog('Error:', error);
        
        let errorMessage = error.message || "Unknown error in ComfyUI plugin";
        if (!errorMessage.startsWith("ComfyUI Plugin Error:")) {
            errorMessage = `ComfyUI Plugin Error: ${errorMessage}`;
        }
        
        console.log(JSON.stringify({ status: "error", error: errorMessage }));
        process.exit(1);
    }
}

main();
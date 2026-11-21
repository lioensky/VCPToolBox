#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { fileURLToPath } = require('url');
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
        COMFYUI_MAX_WAIT_MINUTES: 30,
        COMFYUI_MISSING_QUEUE_TOLERANCE: 5,
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
            if (userSettings.maxWaitMinutes !== undefined) {
                config.COMFYUI_MAX_WAIT_MINUTES = resolveNumericArg(userSettings.maxWaitMinutes, config.COMFYUI_MAX_WAIT_MINUTES);
            }
            
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
    if (process.env.COMFYUI_MAX_WAIT_MINUTES !== undefined && process.env.COMFYUI_MAX_WAIT_MINUTES !== '') {
        config.COMFYUI_MAX_WAIT_MINUTES = resolveNumericArg(process.env.COMFYUI_MAX_WAIT_MINUTES, config.COMFYUI_MAX_WAIT_MINUTES);
    }
    if (process.env.COMFYUI_MISSING_QUEUE_TOLERANCE !== undefined && process.env.COMFYUI_MISSING_QUEUE_TOLERANCE !== '') {
        config.COMFYUI_MISSING_QUEUE_TOLERANCE = Math.max(1, Math.floor(resolveNumericArg(process.env.COMFYUI_MISSING_QUEUE_TOLERANCE, 5)));
    }
    
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
function isValidComfyUIGenArgs(args, requiresPrompt = true) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (requiresPrompt && (typeof args.prompt !== 'string' || !args.prompt.trim())) return false;
    if (!requiresPrompt && args.prompt !== undefined && typeof args.prompt !== 'string') return false;
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

// 将调用参数转换为有限数值；未传或非法时回退到配置值
function resolveNumericArg(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

// 纯粹的数据替换 - 直接替换占位符为具体值（含种子自动处理）
function fillWorkflowParameters(workflow, args, config) {
    const settings = config.userSettings || {};
    const userPrompt = args.prompt || '';

    // 含缩放占位符的模板使用各自默认倍率；拒绝非法输入。
    let resizeScale;
    if (JSON.stringify(workflow).includes('{{RESIZE_SCALE}}')) {
        const candidate = args.resize_scale ?? settings.defaultResizeScale ?? 2;
        resizeScale = Number(candidate);
        if ((typeof candidate !== 'number' && typeof candidate !== 'string') ||
            String(candidate).trim() === '' || !Number.isFinite(resizeScale) || resizeScale <= 0) {
            throw new Error('resize_scale must be a finite number greater than 0.');
        }
    }
    
    const facePrompt = args.face_prompt ?? settings.facePrompt ?? '';
    if (JSON.stringify(workflow).includes('{{FACE_PROMPT}}') && typeof facePrompt !== 'string') {
        throw new Error('face_prompt must be a string.');
    }
    
    // 构建LoRA字符串
    const lorasString = buildLoRAsString(settings.loras || []);
    
    // 构建完整的正面提示词
    const positivePromptParts = [
        userPrompt,
        lorasString,
        settings.qualityTags
    ].filter(part => part && String(part).trim());
    const positivePrompt = positivePromptParts.join(', ');
    
    // 调用参数优先；seed=-1 或非法时在运行时生成随机合法种子
    const resolvedSeed = resolveSeed(args.seed ?? settings.defaultSeed);

    // 构建负面提示词
    const negativePromptParts = [
        settings.negativePrompt,
        args.negative_prompt
    ].filter(part => part && String(part).trim());
    const negativePrompt = negativePromptParts.join(', ');
    
    // 构建替换映射
    const replacements = {
        // 基础参数 - 调用参数优先于用户配置
        '{{IMAGE}}': args.image || '',
        '{{IMAGE_2}}': args.image_2 || '',
        '{{RESOLUTION}}': resolveNumericArg(args.resolution, settings.defaultResolution ?? 0),
        '{{RESIZE_SCALE}}': resizeScale,
        '{{MODEL}}': args.model || settings.defaultModel || 'sd_xl_base_1.0.safetensors',
        '{{WIDTH}}': resolveNumericArg(args.width, settings.defaultWidth || 1024),
        '{{HEIGHT}}': resolveNumericArg(args.height, settings.defaultHeight || 1024),
        '{{STEPS}}': resolveNumericArg(args.steps, settings.defaultSteps || 30),
        '{{CFG}}': resolveNumericArg(args.cfg, settings.defaultCfg || 7.5),
        '{{SAMPLER}}': args.sampler || settings.defaultSampler || 'dpmpp_2m',
        '{{SCHEDULER}}': args.scheduler || settings.defaultScheduler || 'normal',
        '{{SEED}}': resolvedSeed,
        '{{DENOISE}}': resolveNumericArg(args.denoise, settings.defaultDenoise ?? 1.0),
        '{{BATCH_SIZE}}': resolveNumericArg(args.batch_size, settings.defaultBatchSize || 1),
        
        // 提示词相关
        '{{POSITIVE_PROMPT}}': positivePrompt,
        '{{NEGATIVE_PROMPT}}': negativePrompt,
        '{{USER_PROMPT}}': userPrompt || '',
        '{{PROMPT_INPUT}}': userPrompt || '', // 独立提示词输入
        '{{LORA_PROMPT}}': args.lora_prompt || '',
        '{{FACE_PROMPT}}': facePrompt,
        
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
    
    // 安全的JSON替换 - 精确匹配时保留数值/布尔类型，嵌入字符串时再转为文本
    function replaceInObject(obj, replacements) {
        if (typeof obj === 'string') {
            if (Object.prototype.hasOwnProperty.call(replacements, obj)) {
                return replacements[obj];
            }

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

// 根据单次调用配置节点式 LoRA。lora_name 显式留空时绕过并移除所有 LoraLoader。
function configureWorkflowLora(workflow, args) {
    if (!Object.prototype.hasOwnProperty.call(args, 'lora_name')) return workflow;

    const loraName = typeof args.lora_name === 'string' ? args.lora_name.trim() : '';
    const loraNodes = Object.entries(workflow)
        .filter(([, node]) => node && node.class_type === 'LoraLoader');

    for (const [nodeId, node] of loraNodes) {
        if (loraName) {
            node.inputs.lora_name = loraName;
            node.inputs.strength_model = resolveNumericArg(args.lora_strength, node.inputs.strength_model ?? 1);
            node.inputs.strength_clip = resolveNumericArg(args.lora_clip_strength, node.inputs.strength_clip ?? node.inputs.strength_model ?? 1);
            continue;
        }

        const modelSource = node.inputs.model;
        const clipSource = node.inputs.clip;

        for (const otherNode of Object.values(workflow)) {
            if (!otherNode || !otherNode.inputs) continue;
            for (const [inputName, inputValue] of Object.entries(otherNode.inputs)) {
                if (!Array.isArray(inputValue) || String(inputValue[0]) !== String(nodeId)) continue;
                if (inputValue[1] === 0 && modelSource) otherNode.inputs[inputName] = modelSource;
                if (inputValue[1] === 1 && clipSource) otherNode.inputs[inputName] = clipSource;
            }
        }

        delete workflow[nodeId];
    }

    return workflow;
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

// URL 在插件宿主下载；允许庄园内网图床。每张最多 20 MiB。
async function prepareWorkflowImages(args, requiredInputs, config) {
    const prepared = { ...args };
    const limit = 20 * 1024 * 1024;
    for (const inputName of requiredInputs) {
        const value = args[inputName];
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Workflow requires '${inputName}' (HTTP/file image URL or ComfyUI uploaded filename).`);
        }
        const source = value.trim();
        if (!/^(?:https?:\/\/|file:\/\/)/i.test(source)) {
            if (/^(?:[A-Za-z]+:|\/|\\)/.test(source) || source.split(/[\\/]/).includes('..')) {
                throw new Error(`'${inputName}' must be an HTTP/file image URL or ComfyUI uploaded filename.`);
            }
            prepared[inputName] = source;
            continue;
        }
        let bytes;
        if (/^file:\/\//i.test(source)) {
            // PluginManager 已完成跨节点追踪；这里只读宿主可用的文件，不再次追踪。
            const url = new URL(source);
            if (url.hostname && url.hostname !== 'localhost') {
                throw new Error(`'${inputName}' file URL must reference a local file, not a network share.`);
            }
            const localPath = fileURLToPath(url);
            let handle;
            try {
                handle = await fs.open(localPath, 'r');
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > limit) {
                    throw new Error('Expected a regular image file at most 20 MiB.');
                }
                // 最多读取 limit+1，避免 stat 后文件增长导致无界内存分配。
                const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
                let offset = 0;
                while (offset < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
                    if (!bytesRead) break;
                    offset += bytesRead;
                }
                bytes = buffer.subarray(0, offset);
            } catch (error) {
                throw new Error(`Cannot read '${inputName}' file URL on plugin host; verify VCP file tracing completed: ${error.message}`);
            } finally {
                if (handle) await handle.close();
            }
        } else {
            const response = await axios.get(source, {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength: limit,
                maxBodyLength: limit,
                maxRedirects: 3
            });
            bytes = Buffer.from(response.data);
        }
        // 验证签名而非信任服务器 Content-Type，拒绝 HTML / SVG 等非位图内容。
        let extension;
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
        else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = 'jpg';
        else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) extension = 'gif';
        else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
        if (!extension || bytes.length > limit) {
            throw new Error(`'${inputName}' must be PNG, JPEG, GIF or WebP, at most 20 MiB.`);
        }
        const form = new FormData();
        const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
        form.append('image', new Blob([bytes], { type: mime }), `vcp-${uuidv4()}.${extension}`);
        form.append('type', 'input');
        form.append('overwrite', 'false');
        const upload = await axios.post(
            `${config.COMFYUI_BASE_URL.replace(/\/$/, '')}/upload/image`,
            form,
            {
                headers: config.COMFYUI_API_KEY ? { Authorization: `Bearer ${config.COMFYUI_API_KEY}` } : {},
                timeout: 30000,
                maxBodyLength: limit + 65536
            }
        );
        const result = upload.data;
        if (!result || typeof result.name !== 'string' || !result.name) {
            throw new Error(`ComfyUI upload failed for '${inputName}': missing filename.`);
        }
        prepared[inputName] = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
    }
    return prepared;
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

// 检查历史完成状态
async function checkQueueStatus(promptId, config) {
    const comfyuiAxios = axios.create({
        baseURL: config.COMFYUI_BASE_URL,
        headers: config.COMFYUI_API_KEY ? { 'Authorization': `Bearer ${config.COMFYUI_API_KEY}` } : {},
        timeout: 10000
    });
    
    const response = await comfyuiAxios.get(`/history/${promptId}`);
    return (response.data && response.data[promptId]) ? response.data[promptId] : null;
}

// 检查 ComfyUI 实时运行队列 (/queue)，判断 promptId 是否仍在 running 或 pending 中推进
async function checkActiveQueue(promptId, config) {
    const comfyuiAxios = axios.create({
        baseURL: config.COMFYUI_BASE_URL,
        headers: config.COMFYUI_API_KEY ? { 'Authorization': `Bearer ${config.COMFYUI_API_KEY}` } : {},
        timeout: 10000
    });

    const response = await comfyuiAxios.get('/queue');
    const data = response.data || {};
    const runningList = Array.isArray(data.queue_running) ? data.queue_running : [];
    const pendingList = Array.isArray(data.queue_pending) ? data.queue_pending : [];

    const matchesPromptId = (item) => {
        if (!item) return false;
        if (Array.isArray(item)) return item[1] === promptId || item.includes(promptId);
        if (typeof item === 'object') return item.prompt_id === promptId || item.id === promptId;
        return item === promptId;
    };

    const inRunning = runningList.some(matchesPromptId);
    const inPending = pendingList.some(matchesPromptId);

    return {
        inRunning,
        inPending,
        isActive: inRunning || inPending,
        runningCount: runningList.length,
        pendingCount: pendingList.length
    };
}

// 从 ComfyUI history.status 中提取节点执行错误详情
function extractHistoryError(history) {
    if (!history || !history.status) return null;
    const status = history.status;
    const isError = status.status_str === 'error' ||
        (Array.isArray(status.messages) && status.messages.some(m => Array.isArray(m) && (m[0] === 'execution_error' || m[0] === 'execution_interrupted')));
    if (!isError) return null;

    if (Array.isArray(status.messages)) {
        for (const msg of status.messages) {
            if (!Array.isArray(msg)) continue;
            const [eventType, payload] = msg;
            if (eventType === 'execution_error' && payload && typeof payload === 'object') {
                const nodeInfo = payload.node_type ? `${payload.node_type} (node ${payload.node_id ?? '?'})` : `node ${payload.node_id ?? '?'}`;
                const errMsg = payload.exception_message || payload.message || 'Unknown execution error';
                return `ComfyUI execution error in ${nodeInfo}: ${String(errMsg).trim()}`;
            }
            if (eventType === 'execution_interrupted') {
                return 'ComfyUI execution was interrupted or cancelled.';
            }
        }
    }
    return `ComfyUI execution failed with status '${status.status_str || 'error'}'`;
}

// 等待生成完成：跟随 ComfyUI 绘图进程 (/queue running/pending) 活性判断，支持可配兜底上限（默认 30 分钟，<=0 表示只要进程活跃便无限等待）
async function waitForCompletion(promptId, config = {}, options = {}) {
    const interval = Math.max(50, resolveNumericArg(options.interval, 3000));
    const maxWaitMinutes = resolveNumericArg(
        options.maxWaitMinutes ?? config.COMFYUI_MAX_WAIT_MINUTES,
        30
    );
    const maxWaitMs = maxWaitMinutes > 0
        ? maxWaitMinutes * 60 * 1000
        : (typeof options.maxAttempts === 'number' && options.maxAttempts > 0 ? options.maxAttempts * interval : Infinity);
    const missingQueueTolerance = Math.max(
        1,
        Math.floor(resolveNumericArg(options.missingQueueTolerance ?? config.COMFYUI_MISSING_QUEUE_TOLERANCE, 5))
    );

    const checkHistoryFn = options.checkHistoryFn || checkQueueStatus;
    const checkActiveQueueFn = options.checkActiveQueueFn || checkActiveQueue;

    const startTime = Date.now();
    let attempt = 0;
    let consecutiveMissingCount = 0;

    while (true) {
        attempt++;
        const elapsedMs = Date.now() - startTime;
        debugLog(`Checking ComfyUI status, attempt ${attempt} (elapsed ${(elapsedMs / 1000).toFixed(1)}s)`);

        let history = null;
        try {
            history = await checkHistoryFn(promptId, config);
        } catch (err) {
            debugLog(`Warning: checkHistoryFn transient error on attempt ${attempt}:`, err.message);
        }

        if (history) {
            const historyError = extractHistoryError(history);
            if (historyError) {
                throw new Error(historyError);
            }
            if (history.status && history.status.completed) {
                debugLog('Generation completed!');
                return history;
            }
            if (history.outputs && Object.keys(history.outputs).length > 0 && (!history.status || history.status.completed !== false)) {
                debugLog('Generation outputs ready!');
                return history;
            }
        }

        // 查询 ComfyUI /queue 进程活性
        let queueState = null;
        try {
            queueState = await checkActiveQueueFn(promptId, config);
        } catch (err) {
            debugLog(`Warning: checkActiveQueueFn transient error on attempt ${attempt}:`, err.message);
        }

        if (queueState) {
            if (queueState.isActive) {
                consecutiveMissingCount = 0;
                debugLog(`Prompt ${promptId} is actively ${queueState.inRunning ? 'RUNNING' : 'PENDING'} in ComfyUI queue.`);
            } else {
                // 再次复核一次 history，防止刚完成从 queue 移除的竞态窗口
                const raceHistory = await checkHistoryFn(promptId, config).catch(() => null);
                if (raceHistory) {
                    const raceError = extractHistoryError(raceHistory);
                    if (raceError) throw new Error(raceError);
                    if ((raceHistory.status && raceHistory.status.completed) || (raceHistory.outputs && Object.keys(raceHistory.outputs).length > 0)) {
                        return raceHistory;
                    }
                }
                consecutiveMissingCount++;
                debugLog(`Prompt ${promptId} not found in /queue or /history (${consecutiveMissingCount}/${missingQueueTolerance}).`);
                if (consecutiveMissingCount >= missingQueueTolerance) {
                    throw new Error(`ComfyUI task ${promptId} disappeared from both queue and history (possibly cancelled or server restarted).`);
                }
            }
        }

        if (Date.now() - startTime >= maxWaitMs) {
            const limitDesc = Number.isFinite(maxWaitMs) ? `${(maxWaitMs / 60000).toFixed(1)} minutes` : `${attempt} attempts`;
            throw new Error(`Generation timeout after ${limitDesc} - please check ComfyUI status or increase COMFYUI_MAX_WAIT_MINUTES`);
        }

        await new Promise(resolve => setTimeout(resolve, interval));
    }
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
    // 解析 showbase64 参数，默认为 false
    const showBase64 = args.showbase64 === 'true' || args.showbase64 === true;

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

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('ComfyUI Plugin Error: Invalid arguments. Expected an object.');
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
    let strictWorkflow = false;

    for (const wfName of tryWorkflows) {
        try {
            debugLog(`Attempting workflow: ${wfName}`);
            const wfTemplate = await loadWorkflowTemplate(wfName);
            
            // 兼容旧格式（直接是工作流）和新格式（包含元数据和 workflow 键）
            const workflowObject = wfTemplate.workflow || wfTemplate;
            strictWorkflow = wfTemplate.requiresPrompt === false ||
                (Array.isArray(wfTemplate.requiredInputs) && wfTemplate.requiredInputs.length > 0);
            if (!isValidComfyUIGenArgs(args, wfTemplate.requiresPrompt !== false)) {
                throw new Error('ComfyUI Plugin Error: Invalid arguments. Required: prompt (string), except for workflows with requiresPrompt=false.');
            }
            const preparedArgs = await prepareWorkflowImages(args, wfTemplate.requiredInputs || [], config);
            const workflowConfig = {
                ...config,
                userSettings: { ...config.userSettings, ...wfTemplate.defaults }
            };
            const updated = configureWorkflowLora(
                fillWorkflowParameters(workflowObject, preparedArgs, workflowConfig),
                preparedArgs
            );
            const queueResult = await queuePrompt(updated, config);
            debugLog('Queued with prompt_id:', queueResult.prompt_id);

            const waitOptions = {};
            if (args.timeout_minutes !== undefined) {
                waitOptions.maxWaitMinutes = resolveNumericArg(args.timeout_minutes, config.COMFYUI_MAX_WAIT_MINUTES);
            }
            const history = await waitForCompletion(queueResult.prompt_id, config, waitOptions);
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
            // [芙铃诊断补丁 2026-09-06 / 2026-10-15] 捕获ComfyUI 400响应体原文，终结“替身演员顶包”黑箱
            let respBody = '';
            try {
                if (e && e.response && e.response.data) {
                    respBody = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
                }
            } catch (_) {}
            const diagnosticMsg = (e && e.message ? e.message : String(e)) + (respBody ? ' | ComfyUI-400-body: ' + respBody.substring(0, 2048) : '');
            e.diagnosticMessage = diagnosticMsg;
            if (respBody) {
                e.message = diagnosticMsg;
            }
            if (strictWorkflow) throw e;
            debugLog(`Workflow ${wfName} failed:`, diagnosticMsg);
            // 继续下一回退候选
        }
    }

    if (!savedImages) {
        // 所有回退均失败
        throw new Error(`All workflow attempts failed. Primary: ${primaryWorkflowName}. Last error: ${lastError && (lastError.diagnosticMessage || lastError.message) ? (lastError.diagnosticMessage || lastError.message) : String(lastError)}`);
    }
    
    // 7. 构建返回结果 - 结构化格式
    const altPrompt = args.prompt || usedWorkflow || 'ComfyUI';
    const altText = altPrompt.substring(0, 80) + (altPrompt.length > 80 ? "..." : "");
    
    let textContent = `ComfyUI 图片生成成功！共生成 ${savedImages.length} 张图片\n\n`;
    textContent += `详细信息：\n`;
    savedImages.forEach((image, index) => {
        textContent += `图片 ${index + 1}:\n`;
        textContent += `- 图片URL: ${image.url}\n`;
        textContent += `- 服务器路径: image/comfyuigen/${image.filename}\n`;
        textContent += `- 文件名: ${image.filename}\n\n`;
    });
    textContent += `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n`;
    savedImages.forEach((image, index) => {
        textContent += `<img src="${image.url}" alt="${altText} ${index + 1}" width="300">\n`;
    });

    const content = [
        {
            type: 'text',
            text: textContent
        }
    ];

    // 只有当 showbase64 为 true 时才添加 base64 图片数据
    if (showBase64) {
        for (const image of savedImages) {
            const imageData = await fs.readFile(image.localPath);
            const base64Image = imageData.toString('base64');
            const ext = path.extname(image.filename).replace('.', '') || 'png';
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                }
            });
        }
    }

    return {
        content: content,
        details: {
            workflow: usedWorkflow,
            prompt: args.prompt || '',
            imageCount: savedImages.length,
            images: savedImages.map(img => ({
                serverPath: `image/comfyuigen/${img.filename}`,
                fileName: img.filename,
                imageUrl: img.url
            })),
            showBase64: showBase64
        }
    };
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

if (require.main === module) {
    main();
}

module.exports = {
    isValidComfyUIGenArgs,
    fillWorkflowParameters,
    configureWorkflowLora,
    resolveSeed,
    resolveNumericArg,
    prepareWorkflowImages,
    checkQueueStatus,
    checkActiveQueue,
    extractHistoryError,
    waitForCompletion
};
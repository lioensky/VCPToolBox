const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

const SOVITS_API_BASE_URL = "http://127.0.0.1:8000";
// 修正路径问题，确保缓存和模型列表都在项目内的AppData目录
const PROJECT_ROOT = path.join(__dirname, '..'); // 更可靠的方式获取项目根目录
const APP_DATA_ROOT_IN_PROJECT = path.join(PROJECT_ROOT, 'AppData');
const MODELS_CACHE_PATH = path.join(APP_DATA_ROOT_IN_PROJECT, 'sovits_models.json');
const TTS_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'tts_cache');

class SovitsTTS {
    constructor() {
        this.isSpeaking = false;
        this.speechQueue = [];
        this.currentSpeechItemId = null; // 用于跟踪当前朗读的气泡ID
        this.sessionId = 0; // 新增：会话ID，用于作废过时的播放事件
        this.initCacheDir();
    }

    async initCacheDir() {
        try {
            await fs.mkdir(TTS_CACHE_DIR, { recursive: true });
        } catch (error) {
            console.error("无法创建TTS缓存目录:", error);
        }
    }

    /**
     * 获取模型列表，优先从缓存读取
     * @param {boolean} forceRefresh 是否强制刷新缓存
     * @returns {Promise<Object>} 模型列表
     */
    async getModels(forceRefresh = false) {
        if (!forceRefresh) {
            try {
                const cachedModels = await fs.readFile(MODELS_CACHE_PATH, 'utf-8');
                console.log('从缓存加载Sovits模型列表。');
                return JSON.parse(cachedModels);
            } catch (error) {
                console.log('Sovits模型缓存不存在或读取失败，将从API获取。');
            }
        }

        try {
            console.log(`正在从 ${SOVITS_API_BASE_URL}/models 获取模型列表...`);
            const response = await axios.post(`${SOVITS_API_BASE_URL}/models`, { version: "v2ProPlus" });

            if (response.data && response.data.msg === "获取成功" && response.data.models) {
                await fs.writeFile(MODELS_CACHE_PATH, JSON.stringify(response.data.models, null, 2));
                console.log('Sovits模型列表已获取并缓存。');
                return response.data.models;
            } else {
                console.error("获取Sovits模型列表失败: ", response.data);
                return null;
            }
        } catch (error) {
            console.error("请求Sovits模型列表API时出错: ", error.message);
            try {
                const cachedModels = await fs.readFile(MODELS_CACHE_PATH, 'utf-8');
                return JSON.parse(cachedModels);
            } catch (e) {
                return null;
            }
        }
    }

    /**
     * 将文本转换为语音并返回音频数据
     * @param {string} text 要转换的文本
     * @param {string} voice 使用的模型名称
     * @param {number} speed 语速
     * @returns {Promise<Buffer|null>} 音频数据的Buffer
     */
    async textToSpeech(text, voice, speed) {
        const cacheKey = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const cacheFilePath = path.join(TTS_CACHE_DIR, `${cacheKey}.mp3`);
        console.log(`[TTS] 尝试缓存路径: ${cacheFilePath}`);

        // 1. 检查缓存
        try {
            const cachedAudio = await fs.readFile(cacheFilePath);
            console.log(`[TTS] 成功从缓存加载音频: ${cacheKey}`);
            return cachedAudio;
        } catch (error) {
            console.log(`[TTS] 缓存未命中或读取失败: ${error.message}`);
        }

        // 2. 如果没有缓存，请求API
        // 根据模型名称动态确定语言
        let promptLang = "中文";
        if (voice.includes('日语')) {
            promptLang = "日语";
        }
        // 可以在这里添加更多语言的判断，例如 '英语', '韩语' 等

        const payload = {
            model: "tts-v2ProPlus",
            input: text,
            voice: voice,
            response_format: "mp3",
            speed: speed,
            other_params: {
                text_lang: promptLang === "日语" ? "日语" : "中英混合", // 动态设置 text_lang
                prompt_lang: promptLang, // 动态设置语言
                emotion: "默认",
                text_split_method: "按标点符号切",
            }
        };

        try {
            console.log('[TTS] 发送API请求:', JSON.stringify(payload));
            const response = await axios.post(`${SOVITS_API_BASE_URL}/v1/audio/speech`, payload, {
                responseType: 'arraybuffer'
            });
            console.log(`[TTS]收到API响应: 状态 ${response.status}, 类型 ${response.headers['content-type']}`);

            if (response.headers['content-type'] === 'audio/mpeg') {
                const audioBuffer = Buffer.from(response.data);
                // 3. 保存到缓存
                try {
                    await fs.writeFile(cacheFilePath, audioBuffer);
                    console.log(`[TTS] 音频已成功缓存: ${cacheKey}`);
                } catch (cacheError) {
                    console.error("[TTS] 保存音频缓存失败:", cacheError);
                }
                return audioBuffer;
            } else {
                console.error("[TTS] API没有返回正确的音频文件类型。");
                return null;
            }
        } catch (error) {
            console.error("[TTS] 请求语音合成API时出错: ", error.message);
            return null;
        }
    }

    /**
     * 将长文本分割成更小的块以进行流式TTS。
     * 策略：
     * 1. 将第一段分割为“第一句”和“段落的其余部分”。
     * 2. 如果第一句以感叹号结尾且后面还有内容，则会尝试将下一句也合并进来，以避免过短的语气词片段。
     * 3. 后续段落保持原样。
     * 这样做可以尽快发送第一个音频块，以减少可感知的延迟。
     * @param {string} text 要分割的原始文本。
     * @returns {string[]} 文本块的数组。
     */
    splitText(text) {
        const trimmedText = text.trim();
        if (!trimmedText) {
            return [];
        }

        // 1. 找到第一个换行符的位置，以此划分第一段和其余段落
        const firstNewlineIndex = trimmedText.indexOf('\n');
        const firstParagraph = (firstNewlineIndex === -1) ? trimmedText : trimmedText.substring(0, firstNewlineIndex);
        const otherParagraphs = (firstNewlineIndex === -1) ? '' : trimmedText.substring(firstNewlineIndex + 1);

        const chunks = [];

        // 2. 处理第一段：分离出第一句
        // 正则表达式：匹配直到第一个中/英文句号、问号或感叹号。非贪婪匹配。
        const sentenceEndRegex = /.+?[。！？.!?]/;
        const match = firstParagraph.match(sentenceEndRegex);

        if (match) {
            let firstChunk = match[0];
            let restOfFirstParagraph = firstParagraph.substring(firstChunk.length).trim();

            // 新增逻辑：如果第一句以感叹号结尾，并且后面还有内容，则尝试合并下一句
            if (/[!！]$/.test(firstChunk) && restOfFirstParagraph) {
                const nextSentenceMatch = restOfFirstParagraph.match(sentenceEndRegex);
                if (nextSentenceMatch) {
                    const nextSentence = nextSentenceMatch[0];
                    firstChunk += nextSentence; // 合并
                    restOfFirstParagraph = restOfFirstParagraph.substring(nextSentence.length).trim();
                }
            }

            chunks.push(firstChunk);

            if (restOfFirstParagraph) {
                chunks.push(restOfFirstParagraph);
            }
        } else {
            // 如果第一段没有标点，则将整个第一段作为一个块
            if (firstParagraph.trim()) {
                chunks.push(firstParagraph.trim());
            }
        }

        // 3. 处理其余段落
        if (otherParagraphs.trim()) {
            const restChunks = otherParagraphs.split('\n').filter(line => line.trim() !== '');
            chunks.push(...restChunks);
        }

        return chunks.filter(c => c.length > 0);
    }

    /**
     * 新的双语文本切片算法
     * @param {string} text 原始文本
     * @param {string} primaryRegexStr 主语言正则
     * @param {string} secondaryRegexStr 副语言正则
     * @returns {Array<{text: string, lang: 'primary' | 'secondary'}>}
     */
    _segmentTextForBilingualTTS(text, primaryRegexStr, secondaryRegexStr) {
        // Case 1: No secondary model/regex provided. Use primary regex or treat whole text as primary.
        if (!secondaryRegexStr) {
            const regex = primaryRegexStr ? new RegExp(primaryRegexStr, 'g') : null;
            if (regex) {
                const matches = text.match(regex);
                return matches ? [{ text: matches.join('\n'), lang: 'primary' }] : [];
            }
            return [{ text, lang: 'primary' }];
        }

        // Case 2: Secondary regex provided. Segment text into primary and secondary parts.
        try {
            const secondaryRegex = new RegExp(secondaryRegexStr, 'g');
            const segments = [];
            let lastIndex = 0;
            let match;

            while ((match = secondaryRegex.exec(text)) !== null) {
                // Part before the match is primary language
                if (match.index > lastIndex) {
                    segments.push({ text: text.substring(lastIndex, match.index), lang: 'primary' });
                }
                // The matched part (group 1 if exists, otherwise full match) is secondary
                segments.push({ text: match[1] || match[0], lang: 'secondary' });
                lastIndex = match.index + match[0].length;
            }

            // Part after the last match is primary language
            if (lastIndex < text.length) {
                segments.push({ text: text.substring(lastIndex), lang: 'primary' });
            }
            
            // If a primary regex is also provided, filter the primary segments further
            if (primaryRegexStr) {
                const primaryRegex = new RegExp(primaryRegexStr, 'g');
                return segments.map(seg => {
                    if (seg.lang === 'primary') {
                        const matches = seg.text.match(primaryRegex);
                        seg.text = matches ? matches.join('\n') : '';
                    }
                    return seg;
                }).filter(seg => seg.text.trim() !== '');
            }

            return segments.filter(seg => seg.text.trim() !== '');

        } catch (e) {
            console.error(`[TTS Bilingual] Invalid regex provided. Error: ${e.message}`);
            // Fallback to treating the whole text as primary
            return [{ text, lang: 'primary' }];
        }
    }

    /**
     * 开始双语朗读任务
     * @param {object} options 包含所有朗读参数
     */
    speak(options, sender) { // Add sender parameter
        const {
            text,
            voice, // Primary voice
            speed,
            msgId,
            ttsRegex, // Primary regex
            voiceSecondary,
            ttsRegexSecondary
        } = options;

        // 如果没有选择任何主语言模型，则不执行任何操作
        if (!voice) {
            console.log("[TTS] No primary voice model selected. Aborting speak.");
            return;
        }

        const segments = this._segmentTextForBilingualTTS(text, ttsRegex, ttsRegexSecondary);

        if (segments.length === 0) {
            console.log("[TTS] Text is empty after segmentation. Nothing to speak.");
            return;
        }

        const tasks = segments.map(seg => {
            const taskVoice = seg.lang === 'secondary' && voiceSecondary ? voiceSecondary : voice;
            // 将每个片段再按换行符分割，以保持原有的分段逻辑
            return this.splitText(seg.text).map(chunk => ({
                text: chunk,
                voice: taskVoice,
                speed,
                msgId,
                sender // Pass sender to each task
            }));
        }).flat(); // Flatten the array of arrays

        this.speechQueue.push(...tasks);
        
        this.processQueue();
    }

    /**
     * 处理语音队列
     */
    async processQueue() {
        if (this.isSpeaking) return; // 防止重入
        this.isSpeaking = true;
        
        const loopSessionId = this.sessionId; // 捕获当前循环的会话ID

        while (this.speechQueue.length > 0) {
            // 在每次循环开始时检查会话ID是否已改变
            if (this.sessionId !== loopSessionId) {
                console.log(`[TTS] Session ID changed (${loopSessionId} -> ${this.sessionId}). Stopping current processing loop.`);
                break;
            }

            const currentTask = this.speechQueue.shift();
            this.currentSpeechItemId = currentTask.msgId;

            const audioBuffer = await this.textToSpeech(currentTask.text, currentTask.voice, currentTask.speed);

            // 在异步操作后，再次检查会话ID
            if (this.sessionId !== loopSessionId) {
                console.log(`[TTS] Session ID changed during TTS synthesis. Discarding audio.`);
                break;
            }

            if (audioBuffer) {
                const audioBase64 = audioBuffer.toString('base64');
                // 发送音频数据、msgId 和会话ID
                if (currentTask.sender && !currentTask.sender.isDestroyed()) {
                    currentTask.sender.send('play-tts-audio', {
                        audioData: audioBase64,
                        msgId: currentTask.msgId,
                        sessionId: loopSessionId
                    });
                } else {
                    console.error(`[TTS] 无法发送音频，因为发送方窗口已被销毁。`);
                }
            } else {
                console.error(`合成失败: "${currentTask.text.substring(0, 20)}..."`);
            }
        }

        // 队列处理完毕或被中断
        this.isSpeaking = false;
        // 只有当会话未被更新时，才清除 currentSpeechItemId
        if (this.sessionId === loopSessionId) {
            this.currentSpeechItemId = null;
        }
        console.log(`TTS processing loop for session ${loopSessionId} finished.`);
    }

    /**
     * 停止当前所有朗读
     */
    stop() {
        this.speechQueue = [];
        this.isSpeaking = false;
        this.sessionId++; // 关键：使当前所有操作和事件失效
        console.log(`[TTS] Stop called. New session ID: ${this.sessionId}`);
        // 停止事件的发送逻辑已移至 ipc/sovitsHandlers.js，以确保可靠性。
        // 这里只负责清理内部状态。
        this.currentSpeechItemId = null;
        // console.log('TTS朗读已停止。'); // 日志由上方的 sessionId 变化日志替代
    }
}

module.exports = SovitsTTS;
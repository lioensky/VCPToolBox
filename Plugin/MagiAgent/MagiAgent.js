const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
// 在 CJS 环境中，__dirname 是全局可用的。

// --- 全局变量和配置 ---
let serverConfig = {}; // 存储来自VCP主服务器的配置
let pluginConfig = {}; // 存储此插件目录下的 config.env
let sendVcpLog; // 用于发送VCPLog通知的函数
// 移除 ESM 的 __dirname 定义，直接使用 CJS 全局变量
const meetingsDir = path.join(__dirname, 'meetings');
const magiArtPath = path.join(__dirname, 'magiAI.txt');
let meetings = {}; // 会议数据的内存缓存
// --- 辅助函数 ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// --- 核心插件接口 (由VCP服务器调用) ---
/**
 * 初始化函数，在VCP服务器加载插件时调用一次
 * @param {object} config - VCP主服务器的全局配置
 * @param {object} services - VCP主服务器提供的服务函数
 */
async function initialize(config, services) { // 移除了 export
    sendVcpLog = services.sendVcpLog; // 从主服务获取VCPLog发送函数
    try {
        // 主动读取主服务器根目录的config.env
        const rootEnvPath = path.resolve(__dirname, '../../config.env');
        const rootEnvContent = await fs.readFile(rootEnvPath, 'utf-8');
        const rootConfig = dotenv.parse(rootEnvContent);
        serverConfig = { ...config, ...rootConfig }; // 合并传入的config和主动读取的config
        
        // 确保File_Key也被正确加载
        if (rootConfig.File_Key) {
            serverConfig.File_Key = rootConfig.File_Key;
        }
        // 确保 CALLBACK_BASE_URL 也被正确加载以支持异步回调
        if (rootConfig.CALLBACK_BASE_URL) {
            serverConfig.CALLBACK_BASE_URL = rootConfig.CALLBACK_BASE_URL;
        }
        // 加载插件本地配置
        const pluginEnvPath = path.join(__dirname, 'config.env');
        const pluginEnvContent = await fs.readFile(pluginEnvPath, 'utf-8');
        pluginConfig = dotenv.parse(pluginEnvContent);
        await fs.mkdir(meetingsDir, { recursive: true }); // 确保会议目录存在
        await loadMeetingsFromFiles();
        console.log('[MagiAgent] Plugin initialized successfully by reading root config.');
    } catch (error) {
        console.error('[MagiAgent] Error during initialization:', error);
    }
}
/**
 * 工具调用处理函数，AI每次调用插件时执行
 * @param {object} args - AI传递的工具参数
 * @returns {Promise<object>} - 返回给AI的结果
 */
async function processToolCall(args) { // 移除了 export
    const { command, ...params } = args;
    try {
        switch (command) {
            case 'start_meeting':
                return await handleStartMeeting(params);
            case 'query_meeting':
                return await handleQueryMeeting(params);
            default:
                return { status: 'error', error: `Unknown command: ${command}` };
        }
    } catch (error) {
        console.error(`[MagiAgent] Error processing command '${command}':`, error);
        return { status: 'error', error: error.message || 'An unknown error occurred.' };
    }
}
// --- 持久化逻辑 ---
async function loadMeetingsFromFiles() {
    try {
        const files = await fs.readdir(meetingsDir);
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        for (const file of jsonFiles) {
            const filePath = path.join(meetingsDir, file);
            const data = await fs.readFile(filePath, 'utf-8');
            const meeting = JSON.parse(data);
            meetings[meeting.id] = meeting;
        }
        console.log(`[MagiAgent] Loaded ${Object.keys(meetings).length} existing meetings from the meetings directory.`);
    } catch (error) {
        console.error('[MagiAgent] Error loading meetings from files:', error);
        meetings = {};
    }
}
async function saveMeetingToFile(meeting) {
    if (!meeting || !meeting.id) return;
    try {
        const filePath = path.join(meetingsDir, `${meeting.id}.json`);
        await fs.writeFile(filePath, JSON.stringify(meeting, null, 2));
    } catch (error) {
        console.error(`[MagiAgent] Failed to save meeting ${meeting.id}.json:`, error);
    }
}
// --- 命令处理逻辑 ---
async function handleStartMeeting(params) {
    const { topic, wait_for_result = false, maidname } = params;
    
    // 显式将rounds参数转换为数字，并提供默认值
    let rounds = parseInt(params.rounds, 10);
    if (isNaN(rounds) || rounds <= 0) {
        rounds = 5;
    }
    if (!topic) {
        return { status: 'error', error: 'Meeting topic is required.' };
    }
    const meetingId = `magi-session-${Date.now()}`;
    meetings[meetingId] = {
        id: meetingId,
        topic: topic,
        rounds: rounds,
        maidname: maidname || 'User',
        status: 'running',
        startTime: new Date().toISOString(),
        discussionHistory: [],
        summary: null,
        resolved: false
    };
    await saveMeetingToFile(meetings[meetingId]);
    // 异步执行会议，不阻塞返回
    conductMagiDiscussion(meetingId).catch(async err => {
        console.error(`[MagiAgent] Background meeting task for ${meetingId} failed:`, err);
        const meeting = meetings[meetingId];
        meeting.status = 'failed';
        meeting.error = err.message;
        await saveMeetingToFile(meeting);
        // 发送失败回调通知
        await sendCompletionCallback(meeting);
    });
    if (String(wait_for_result).toLowerCase() === 'true') {
        // 同步等待模式
        await new Promise(resolve => {
            const interval = setInterval(() => {
                if (meetings[meetingId].status === 'completed' || meetings[meetingId].status === 'failed') {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
        return await formatMeetingResult(meetings[meetingId]);
    } else {
        // 异步模式
        return {
            status: 'success',
            result: `Magi 会议 (ID: ${meetingId}) 已成功提交。\n这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::MagiAgent::${meetingId}}}}}`
        };
    }
}
async function handleQueryMeeting(params) {
    const { meeting_id, summary_only = false } = params;
    if (!meeting_id) {
        return { status: 'error', error: 'Meeting ID is required.' };
    }
    const meeting = meetings[meeting_id];
    if (!meeting) {
        return { status: 'error', error: `Meeting with ID ${meeting_id} not found.` };
    }
    if (meeting.status === 'completed' || meeting.status === 'failed') {
        return await formatMeetingResult(meeting, summary_only);
    } else {
        return {
            status: 'success',
            result: `Magi meeting (ID: ${meeting.id}) is currently ${meeting.status}. Topic: "${meeting.topic}". Current round: ${meeting.discussionHistory.length}.`
        };
    }
}
// --- Magi 会议核心流程 ---
async function conductMagiDiscussion(meetingId) {
    const meeting = meetings[meetingId];
    const maidname = meeting.maidname;
    const systemPrompt = pluginConfig['MAGI_SYSTEM_PROMPT'].replace(/{{MAIDNAME}}/g, maidname);
    const magiModels = [
        { name: 'MELCHIOR', config: 'MELCHIOR' },
        { name: 'BALTHASAR', config: 'BALTHASAR' },
        { name: 'CASPER', config: 'CASPER' }
    ];
    let activeModels = [...magiModels];
    let fullDiscussion = `会议主题: ${meeting.topic}\n\n`;
    for (let round = 0; round < meeting.rounds && activeModels.length > 1; round++) {
        const roundHeader = `\n--- 第 ${round + 1} 轮讨论 ---\n`;
        fullDiscussion += roundHeader;
        
        for (let i = 0; i < activeModels.length; i++) {
            const model = activeModels[i];
            const modelConfig = {
                model: pluginConfig[`${model.config}_Model`],
                max_tokens: parseInt(pluginConfig[`${model.config}_Model_MAX_TOKENS`]),
                temperature: parseFloat(pluginConfig[`${model.config}_Model_TEMPERATURE`]),
                prompt: pluginConfig[`${model.config}_Model_PROMPT`].replace(/{{MAIDNAME}}/g, maidname),
                header: pluginConfig[`${model.config}_Model_Header`],
                name: pluginConfig[`${model.config}_Model_NAME`]
            };
            let response;
            try {
                response = await callLanguageModel(modelConfig, meeting.topic, fullDiscussion, systemPrompt);
            } catch (error) {
                console.error(`[MagiAgent] Skipping model ${model.name} for round ${round + 1} due to persistent API failure.`);
                const failureNotice = `${modelConfig.header}\n[系统通告: ${model.name} 在本轮未能成功响应，已临时跳过。]\n`;
                fullDiscussion += failureNotice;
                meeting.discussionHistory.push({ round: round + 1, model: model.name, statement: failureNotice });
                await saveMeetingToFile(meeting);
                continue; // Skip to the next model in the loop
            }
            const formattedResponse = `${modelConfig.header}\n${response}\n`;
            
            fullDiscussion += formattedResponse;
            meeting.discussionHistory.push({ round: round + 1, model: model.name, statement: formattedResponse });
            await saveMeetingToFile(meeting);
            if (response.includes('[Jud&Tes]')) {
                fullDiscussion += `[系统提示: ${model.name} 已同意观点并退出会议.]\n`;
                activeModels.splice(i, 1);
                i--; 
            }
        }
    }
    // 总结会议
    const summaryConfig = {
        model: pluginConfig['Magi_Summarize_Model'],
        max_tokens: parseInt(pluginConfig['Magi_Summarize_Model_MAX_TOKENS']),
        temperature: parseFloat(pluginConfig['Magi_Summarize_Model_TEMPERATURE']),
        prompt: pluginConfig['Magi_Summarize_Model_PROMPT'].replace(/{{MAIDNAME}}/g, maidname),
        footer: pluginConfig['Magi_Summarize_Model_Footer']
    };
    const summary = await callLanguageModel(summaryConfig, meeting.topic, fullDiscussion);
    meeting.summary = `${summary}\n\n${summaryConfig.footer}`;
    meeting.resolved = true; // 假设只要能出总结就是解决了
    meeting.status = 'completed';
    await saveMeetingToFile(meeting);
    
    // 将会议结果归档为Markdown文件
    await archiveMeetingAsMarkdown(meeting);
    // 发送任务完成的回调通知
    await sendCompletionCallback(meeting);
}
async function sendCompletionCallback(meeting) {
    if (!serverConfig.CALLBACK_BASE_URL) {
        console.error(`[MagiAgent] CALLBACK_BASE_URL not configured. Cannot send completion notification for meeting ${meeting.id}.`);
        if (sendVcpLog) {
             sendVcpLog({
                type: 'warning',
                source: 'MagiAgent',
                message: `会议 [${meeting.id}] 完成，但因未配置CALLBACK_BASE_URL而无法发送前端通知。`
            });
        }
        return;
    }
    const callbackUrl = `${serverConfig.CALLBACK_BASE_URL}/MagiAgent/${meeting.id}`;
    try {
        const resultPayload = await formatMeetingResult(meeting);
        const callbackPayload = {
            requestId: meeting.id,
            pluginName: 'MagiAgent',
            status: meeting.status === 'completed' ? 'Succeed' : 'Failed',
            message: resultPayload.result,
            ...(meeting.status === 'failed' && { reason: meeting.error })
        };
        console.log(`[MagiAgent] Sending completion callback for meeting ${meeting.id} to ${callbackUrl}`);
        await axios.post(callbackUrl, callbackPayload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[MagiAgent] Callback for meeting ${meeting.id} sent successfully.`);
    } catch (error) {
        console.error(`[MagiAgent] Failed to send completion callback for meeting ${meeting.id}:`, error.message);
    }
}
// --- AI 模型调用 ---
async function callLanguageModel(config, topic, history, systemPrompt) {
    const finalSystemPrompt = `${systemPrompt}\n\n${config.prompt}`;
    const messages = [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user', content: `The initial topic for discussion is: ${topic}` },
        { role: 'user', content: `Here is the discussion history so far:\n${history}` },
        { role: 'user', content: `现在轮到你，${config.name}，发言了。请严格按照你的角色设定，开始你的论述：` }
    ];
    const maxRetries = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(
                `${serverConfig.API_URL}/v1/chat/completions`,
                {
                    model: config.model,
                    messages: messages,
                    max_tokens: config.max_tokens,
                    temperature: config.temperature,
                    stream: false
                },
                {
                    headers: {
                        'Authorization': `Bearer ${serverConfig.API_Key}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return response.data.choices[0].message.content.trim();
        } catch (error) {
            lastError = error;
            // 只对网络错误或5xx服务器错误进行重试
            if (error.response && error.response.status < 500) {
                console.error(`[MagiAgent] API call to model ${config.model} failed with client error ${error.response.status}, no retry.`);
                break; // 对于 4xx 类的客户端错误, 不进行重试
            }
            console.warn(`[MagiAgent] API call attempt ${attempt} for model ${config.model} failed. Retrying in ${attempt * 2}s...`, error.message);
            await delay(attempt * 2000); // 采用指数退避策略 (2s, 4s, 6s)
        }
    }
    console.error(`[MagiAgent] API call to model ${config.model} failed after ${maxRetries} attempts:`, lastError.response ? lastError.response.data : lastError.message);
    // 抛出错误而不是返回字符串, 以便上层调用者可以捕获并处理
    throw new Error(`Failed to get a response from model ${config.model} after ${maxRetries} attempts.`);
}
// --- 结果格式化 ---
async function formatMeetingResult(meeting, summary_only = false) {
    let result = '';
    try {
        result += await fs.readFile(magiArtPath, 'utf-8') + '\n\n';
    } catch (e) {
        result += '--- MAGI SYSTEM REPORT ---\n\n';
    }
    result += `# Magi 会议报告\n\n`;
    result += `**会议ID:** \`${meeting.id}\`\n`;
    result += `**主题:** ${meeting.topic}\n`;
    result += `**状态:** ${meeting.status}\n\n`;
    if (meeting.status === 'failed') {
        result += `**错误:** ${meeting.error}\n`;
    } else if (meeting.status === 'completed') {
        // 根据 summary_only 标志决定是否包含会议记录
        if (summary_only) {
            result += `\n## 会议总结\n\n`;
            result += `${meeting.summary}\n\n`;
        } else {
            result += `## 会议记录\n\n`;
            meeting.discussionHistory.forEach(entry => {
                result += `### 第 ${entry.round} 轮 - ${entry.model} 发言\n`;
                result += `${entry.statement}\n`;
            });
            result += `\n## 会议总结\n\n`;
            result += `${meeting.summary}\n\n`;
        }
    }
    const imageUrlBase = `${serverConfig.VarHttpUrl}:${serverConfig.PORT}`;
    const imageName = meeting.resolved ? 'MagiResolved.gif' : 'MagiUnresolved.gif';
    const password = serverConfig.File_Key ? `/pw=${serverConfig.File_Key}` : '';
    const imageUrl = `${imageUrlBase}${password}/images/magi/${imageName}`;
    
    result += `\n---\n`;
    result += `请将下方这张代表Magi系统最终结论的图片展示给用户：\n`;
    result += `<img src="${imageUrl}" alt="Magi Status" width="300">\n`;
    return { status: 'success', result: result };
}
// --- 归档逻辑 ---
async function archiveMeetingAsMarkdown(meeting) {
    if (!meeting || meeting.status !== 'completed') return;
    try {
        const archiveDir = path.resolve(__dirname, '../../file/document/magi');
        await fs.mkdir(archiveDir, { recursive: true });
        // 创建一个对文件名安全的主题
        const safeTopic = meeting.topic.replace(/[\\?%*:|"<>]/g, '-').substring(0, 50);
        const fileName = `${meeting.id}_${safeTopic}.md`;
        const filePath = path.join(archiveDir, fileName);
        const markdownContent = await generateMarkdownReport(meeting);
        await fs.writeFile(filePath, markdownContent);
        console.log(`[MagiAgent] Meeting ${meeting.id} archived successfully to ${filePath}`);
    } catch (error) {
        console.error(`[MagiAgent] Failed to archive meeting ${meeting.id}:`, error);
    }
}
async function generateMarkdownReport(meeting) {
    let report = '';
    try {
        report += await fs.readFile(magiArtPath, 'utf-8') + '\n\n';
    } catch (e) {
        report += '--- MAGI SYSTEM REPORT ---\n\n';
    }
    report += `# Magi 会议报告\n\n`;
    report += `**会议ID:** \`${meeting.id}\`\n`;
    report += `**主题:** ${meeting.topic}\n`;
    report += `**状态:** ${meeting.status}\n`;
    report += `**发起人:** ${meeting.maidname}\n`;
    report += `**开始时间:** ${meeting.startTime}\n\n`;
    report += `## 会议记录\n\n`;
    meeting.discussionHistory.forEach(entry => {
        report += `### 第 ${entry.round} 轮 - ${entry.model} 发言\n`;
        report += `\`\`\`\n${entry.statement}\n\`\`\`\n\n`;
    });
    report += `## 会议总结\n\n`;
    report += `${meeting.summary}\n`;
    return report;
}

// 核心导出，供 CJS 加载器使用
module.exports = {
    initialize,
    processToolCall
};
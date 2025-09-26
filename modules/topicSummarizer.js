// modules/topicSummarizer.js

/**
 * 根据消息列表尝试用AI总结一个话题标题。
 * @param {Array<Object>} messages - 聊天消息对象数组。
 * @param {string} agentName - 当前Agent的名称，可用于提示。
 * @returns {Promise<string|null>} 返回总结的标题，如果无法总结则返回null。
 */
async function summarizeTopicFromMessages(messages, agentName) {
    if (!messages || messages.length < 4) { // 至少需要两轮对话 (user, assistant, user, assistant)
        return null;
    }

    // --- Load settings dynamically ---
    let settings;
    try {
        settings = await window.electronAPI.loadSettings();
        if (!settings || !settings.vcpServerUrl || !settings.vcpApiKey) {
            console.error('[TopicSummarizer] VCP settings are missing or invalid.');
            return null; // Can't proceed without settings
        }
    } catch (error) {
        console.error('[TopicSummarizer] Failed to load settings:', error);
        return null;
    }
    // --------------------------------

    // 提取最近的几条消息内容用于总结
    // 例如，提取最近4条消息
    const recentMessagesContent = messages.slice(-4).map(msg => {
        // 确保从消息内容中提取文本，即使它是对象 { text: '...' }
        const contentText = typeof msg.content === 'string' ? msg.content : (msg.content?.text || '');
        return `${msg.role === 'user' ? (settings.userName || '用户') : agentName}: ${contentText}`;
    }).join('\n');

    console.log('[TopicSummarizer] 准备总结的内容:', recentMessagesContent);

    // --- AI summarization logic ---
    const summaryPrompt = `[待总结聊天记录: ${recentMessagesContent}]\n请根据以上对话内容，仅返回一个简洁的话题标题。要求：1. 标题长度控制在10个汉字以内。2. 标题本身不能包含任何标点符号、数字编号或任何非标题文字。3. 直接给出标题文字，不要添加任何解释或前缀。`;
    let vcpSummaryResponse = null;
    try {
        const response = await fetch(settings.vcpServerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.vcpApiKey}`
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: summaryPrompt }],
                model: settings.topicSummaryModel || 'gemini-2.5-flash', // Use configured model or fallback
                temperature: 0.3,
                max_tokens: 30000
            })
        });

        if (response.ok) {
            vcpSummaryResponse = await response.json();
        } else {
            const errorText = await response.text();
            console.error('[TopicSummarizer] AI summary request failed:', response.status, errorText);
        }
    } catch (error) {
        console.error('[TopicSummarizer] Network error during AI summary:', error);
    }
    if (vcpSummaryResponse && vcpSummaryResponse.choices && vcpSummaryResponse.choices.length > 0) {
        let rawTitle = vcpSummaryResponse.choices[0].message.content.trim();
        
        // 尝试提取第一行作为标题，以应对AI可能返回多行的情况
        rawTitle = rawTitle.split('\n')[0].trim();

        // 移除所有标点符号、数字编号和常见的前缀/后缀
        // 保留汉字、字母、数字（如果需要数字的话，但提示词要求不要数字编号，这里可以更严格）
        // 这里我们先移除所有非字母和非汉字的字符，除了空格（稍后处理）
        let cleanedTitle = rawTitle.replace(/[^\u4e00-\u9fa5a-zA-Z\s]/g, '');
        
        // 进一步移除特定模式，如 "1. " 或 "标题："
        cleanedTitle = cleanedTitle.replace(/^\s*\d+\s*[\.\uff0e\s]\s*/, ''); // 移除 "1. ", "1 . " 等
        cleanedTitle = cleanedTitle.replace(/^(标题|总结|Topic)[:：\s]*/i, ''); // 移除 "标题：" 等

        // 移除所有空格
        cleanedTitle = cleanedTitle.replace(/\s+/g, '');

        // 截断到12个字符
        if (cleanedTitle.length > 12) {
            cleanedTitle = cleanedTitle.substring(0, 12);
        }
        
        console.log('[TopicSummarizer] AI 原始返回:', rawTitle);
        console.log('[TopicSummarizer] 清理并截断后的标题:', cleanedTitle);

        if (cleanedTitle) { // 确保清理后仍有内容
            return cleanedTitle;
        }
    }
    // ---------------------------------------------

    // 如果AI总结失败，回退到临时逻辑或返回null
    console.warn('[TopicSummarizer] AI 总结失败，尝试临时逻辑。');
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content;
    if (lastUserMessage) {
        const tempTitle = `关于 "${lastUserMessage.substring(0, 15)}${lastUserMessage.length > 15 ? '...' : ''}" (备用)`;
        console.log('[TopicSummarizer] 临时生成的标题 (备用):', tempTitle);
        return tempTitle;
    }

    return null;
}

// 如果是在Node.js环境中直接运行此文件进行测试，可以取消下面的注释


window.summarizeTopicFromMessages = summarizeTopicFromMessages;
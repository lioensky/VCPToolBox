// reidentify_image.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // 确保已安装 node-fetch: npm install node-fetch
const crypto = require('crypto'); // 尽管主要用于查找，但保持一致性

// 加载环境变量
dotenv.config({ path: 'config.env' });

const imageCacheFilePath = path.join(__dirname, 'imagebase64.json');
const apiKey = process.env.API_Key;
const apiUrl = process.env.API_URL;
const imageModelName = process.env.ImageModel;
const imagePromptText = process.env.ImagePrompt;
const imageModelOutputMaxTokens = parseInt(process.env.ImageModelOutput, 10) || 1024; // 新增
const imageModelThinkingBudget = parseInt(process.env.ImageModelThinkingBudget, 10); // 新增
// const imageModelContentMax = parseInt(process.env.ImageModelContent, 10); // 新增, 暂不直接使用

async function reidentifyAndUpdateCache(targetId) {
    if (!targetId) {
        console.error('错误：请输入要重新识别的图片缓存条目的 ID。');
        console.log('用法: node reidentify_image.js <ID>');
        return;
    }

    console.log(`开始为 ID: ${targetId} 重新识别图片...`);

    // 1. 加载配置和缓存
    if (!apiKey || !apiUrl || !imageModelName || !imagePromptText) {
        console.error('错误：必要的 API 配置 (API_Key, API_URL, ImageModel, ImagePrompt) 未在 config.env 中设置。');
        return;
    }

    let imageBase64Cache;
    try {
        const data = await fs.readFile(imageCacheFilePath, 'utf-8');
        imageBase64Cache = JSON.parse(data);
    } catch (error) {
        console.error(`错误：读取图片缓存文件 ${imageCacheFilePath} 失败:`, error);
        return;
    }

    // 2. 查找 Base64 数据
    let foundBase64Data = null;
    let originalMimeType = 'data:image/jpeg;'; // 默认值，实际应从 base64 字符串中提取

    for (const base64Key in imageBase64Cache) {
        const entry = imageBase64Cache[base64Key];
        if (typeof entry === 'object' && entry.id === targetId) {
            foundBase64Data = base64Key; // base64Key 是不带前缀的纯 base64
            // 尝试从原始的键（如果它包含前缀）或通过一个标准模式来确定MIME类型
            // 这个脚本假设 base64Key 是纯的，所以我们需要一种方式获取MIME
            // 为了简化，我们这里假设一个常见的MIME类型，或提示用户改进
            // 在实际应用中，可能需要在缓存中也存储MIME类型，或者base64Key本身就包含它
            console.log(`找到 ID ${targetId} 对应的 Base64 数据。将使用默认MIME类型。`);
            break;
        }
    }

    if (!foundBase64Data) {
        console.error(`错误：在缓存中未找到 ID 为 "${targetId}" 的条目。`);
        return;
    }

    // 3. 重新识别图片 (类似 server.js 中的逻辑)
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;
    let newDescription = null;

    console.log(`对 Base64 (ID: ${targetId}) 进行重新识别...`);

    while (attempt < maxRetries) {
        attempt++;
        console.log(`尝试 #${attempt}...`);
        try {
            const payload = {
                model: imageModelName,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: imagePromptText },
                            // 注意：这里需要完整的带前缀的 base64 URL
                            // 假设缓存的 key 是纯 base64，我们需要添加前缀
                            // 实际项目中，缓存的 key 可能就是带前缀的，或者MIME类型被单独存储
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${foundBase64Data}` } } // 示例使用jpeg
                        ]
                    }
                ],
                max_tokens: imageModelOutputMaxTokens, // 使用配置的值
            };

            // 添加 thinking_config 如果 ImageModelThinkingBudget 有效
            if (imageModelThinkingBudget && !isNaN(imageModelThinkingBudget) && imageModelThinkingBudget > 0) {
                payload.extra_body = { // 确保是 extra_body
                    thinking_config: {
                        thinking_budget: imageModelThinkingBudget
                    }
                };
                console.log(`[Reidentify] 使用 Thinking Budget: ${imageModelThinkingBudget}`);
            }

            const fetchResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(payload),
            });

            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                throw new Error(`API 调用失败 (尝试 ${attempt}): ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
            }

            const result = await fetchResponse.json();
            const descriptionContent = result.choices?.[0]?.message?.content?.trim();

            if (descriptionContent && descriptionContent.length >= 50) {
                newDescription = descriptionContent;
                console.log(`图片 (ID: ${targetId}) 重新识别成功 (尝试 #${attempt})。长度: ${newDescription.length}`);
                break; // 成功，跳出重试循环
            } else if (descriptionContent) {
                lastError = new Error(`描述过短 (长度: ${descriptionContent.length}, 少于50字符) (尝试 ${attempt})。`);
                console.warn(lastError.message);
            } else {
                lastError = new Error(`转译结果中未找到描述 (尝试 ${attempt})。`);
                console.warn(lastError.message);
            }
        } catch (error) {
            lastError = error;
            console.error(`重新识别时出错 (尝试 #${attempt}):`, error.message);
        }

        if (attempt < maxRetries) {
            console.log(`将在500ms后重试...`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    if (!newDescription) {
        console.error(`图片 (ID: ${targetId}) 在 ${maxRetries} 次尝试后重新识别失败。最后错误: ${lastError ? lastError.message : '未知错误'}`);
        return;
    }

    // 清理描述中的潜在非法JSON字符
    const cleanedNewDescription = newDescription.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (newDescription.length !== cleanedNewDescription.length) {
        console.warn(`[Reidentify] 清理了新描述中的特殊字符。原长度: ${newDescription.length}, 清理后长度: ${cleanedNewDescription.length}. ID: ${targetId}`);
    }

    // 4. 更新缓存
    try {
        const entryToUpdate = imageBase64Cache[foundBase64Data];
        if (typeof entryToUpdate === 'object') {
            entryToUpdate.description = cleanedNewDescription; // 使用清理后的描述
            entryToUpdate.timestamp = new Date().toISOString();
            // ID 保持不变
            await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
            console.log(`缓存中 ID ${targetId} 的条目已成功更新描述和时间戳。`);
            console.log("新描述:", newDescription);
        } else {
            // 如果找到的是旧格式的字符串，理论上不应该通过ID找到，除非ID就是base64本身
            console.error(`错误: 找到的缓存条目 ID ${targetId} (Base64: ${foundBase64Data.substring(0,30)}...) 不是预期的对象格式。无法更新。`);
        }
    } catch (error) {
        console.error(`错误：写入更新后的图片缓存文件 ${imageCacheFilePath} 失败:`, error);
    }
}

// 从命令行参数获取 ID
const targetIdFromArgs = process.argv[2];
reidentifyAndUpdateCache(targetIdFromArgs);
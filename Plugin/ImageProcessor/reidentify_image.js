// reidentify_image.js
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto'); // 尽管主要用于查找，但保持一致性

// 加载环境变量
// 先加载主目录的 config.env，然后加载插件目录的 config.env
// 插件目录的配置会覆盖主目录的同名配置
dotenv.config({ path: path.join(__dirname, '..', '..', 'config.env') }); // 加载主目录的 config.env
dotenv.config({ path: path.join(__dirname, 'config.env') }); // 加载插件目录的 config.env

const imageCacheFilePath = path.join(__dirname, 'image_cache.json'); // 确保文件名正确
const apiKey = process.env.API_Key;
const apiUrl = process.env.API_URL;
const imageModelName = process.env.ImageModel;
const imagePromptText = process.env.ImagePrompt;
const imageModelOutputMaxTokens = parseInt(process.env.ImageModelOutputMaxTokens, 10) || 1024;
const imageModelThinkingBudget = parseInt(process.env.ImageModelThinkingBudget, 10);

/**
* 根据 Base64 Key 重新识别图片并更新缓存。
* @param {string} base64Key - 要重新识别的图片缓存条目的 Base64 Key (纯 Base64 字符串)。
* @returns {Promise<{newDescription: string, newTimestamp: string}>} 包含新描述和时间戳的对象。
* @throws {Error} 如果重新识别或更新缓存失败。
*/
async function reidentifyImageByBase64Key(base64Key) {
   if (!base64Key) {
       throw new Error('错误：请输入要重新识别的图片缓存条目的 Base64 Key。');
   }

   console.log(`[Reidentify] 开始为 Base64 Key (部分): ${base64Key.substring(0, 30)}... 重新识别图片...`);

   // 1. 检查配置
   if (!apiKey || !apiUrl || !imageModelName || !imagePromptText) {
       throw new Error('错误：必要的 API 配置 (API_Key, API_URL, ImageModel, ImagePrompt) 未在 config.env 中设置。');
   }

   // 2. 加载缓存
   let imageBase64Cache;
   try {
       const data = await fs.readFile(imageCacheFilePath, 'utf-8');
       imageBase64Cache = JSON.parse(data);
   } catch (error) {
       // 如果文件不存在，则认为缓存为空
       if (error.code === 'ENOENT') {
            imageBase64Cache = {};
            console.warn(`[Reidentify] 图片缓存文件 ${imageCacheFilePath} 未找到，初始化为空缓存。`);
       } else {
           console.error(`[Reidentify] 错误：读取图片缓存文件 ${imageCacheFilePath} 失败:`, error);
           throw new Error(`读取图片缓存文件失败: ${error.message}`);
       }
   }

   // 3. 查找 Base64 数据条目
   const entryToUpdate = imageBase64Cache[base64Key];

   if (!entryToUpdate || typeof entryToUpdate !== 'object') {
       throw new Error(`错误：在缓存中未找到 Base64 Key (部分): ${base64Key.substring(0, 30)}... 对应的有效条目。`);
   }

   // 4. 重新识别图片
   const maxRetries = 3;
   let attempt = 0;
   let lastError = null;
   let newDescription = null;

   console.log(`[Reidentify] 对 Base64 Key (部分): ${base64Key.substring(0, 30)}... 进行重新识别...`);

   // 尝试猜测 MIME 类型，或者假设一个默认值
   // 更好的方法是在缓存中存储 MIME 类型
   let mimeType = 'image/png'; // 默认值
    if (base64Key.startsWith('/9j/')) mimeType = 'image/jpeg';
    else if (base64Key.startsWith('iVBOR')) mimeType = 'image/png';
    else if (base64Key.startsWith('R0lGOD')) mimeType = 'image/gif';
    else if (base64Key.startsWith('UklGR')) mimeType = 'image/webp';


  while (attempt < maxRetries) {
      attempt++;
      console.log(`[Reidentify] 尝试 #${attempt}...`);
      try {
          // 动态导入 node-fetch
          const fetch = (await import('node-fetch')).default;

          const payload = {
              model: imageModelName,
              messages: [
                  {
                      role: "user",
                      content: [
                          { type: "text", text: imagePromptText },
                          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Key}` } }
                      ]
                  }
              ],
              max_tokens: imageModelOutputMaxTokens,
          };

          if (imageModelThinkingBudget && !isNaN(imageModelThinkingBudget) && imageModelThinkingBudget > 0) {
              payload.extra_body = {
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

           if (descriptionContent && descriptionContent.length >= 50) { // 要求描述至少50字符
               newDescription = descriptionContent;
               console.log(`[Reidentify] 图片 (Base64 Key 部分: ${base64Key.substring(0, 30)}...) 重新识别成功 (尝试 #${attempt})。长度: ${newDescription.length}`);
               break; // 成功，跳出重试循环
           } else if (descriptionContent) {
               lastError = new Error(`描述过短 (长度: ${descriptionContent.length}, 少于50字符) (尝试 ${attempt})。`);
               console.warn(`[Reidentify] ${lastError.message}`);
           } else {
               lastError = new Error(`转译结果中未找到描述 (尝试 ${attempt})。`);
               console.warn(`[Reidentify] ${lastError.message}`);
           }
       } catch (error) {
           lastError = error;
           console.error(`[Reidentify] 重新识别时出错 (尝试 #${attempt}):`, error.message);
       }

       if (attempt < maxRetries) {
           console.log(`[Reidentify] 将在500ms后重试...`);
           await new Promise(resolve => setTimeout(resolve, 500));
       }
   }

   if (!newDescription) {
       const finalErrorMsg = `图片 (Base64 Key 部分: ${base64Key.substring(0, 30)}...) 在 ${maxRetries} 次尝试后重新识别失败。最后错误: ${lastError ? lastError.message : '未知错误'}`;
       console.error(`[Reidentify] ${finalErrorMsg}`);
       throw new Error(finalErrorMsg);
   }

   // 清理描述中的潜在非法JSON字符
   const cleanedNewDescription = newDescription.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
   if (newDescription.length !== cleanedNewDescription.length) {
       console.warn(`[Reidentify] 清理了新描述中的特殊字符。原长度: ${newDescription.length}, 清理后长度: ${cleanedNewDescription.length}. Base64 Key 部分: ${base64Key.substring(0, 30)}...`);
   }

   // 5. 更新缓存
   try {
       entryToUpdate.description = cleanedNewDescription; // 使用清理后的描述
       entryToUpdate.timestamp = new Date().toISOString(); // 更新时间戳

       await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
       console.log(`[Reidentify] 缓存中 Base64 Key (部分): ${base64Key.substring(0, 30)}... 的条目已成功更新描述和时间戳。`);
       console.log("[Reidentify] 新描述:", cleanedNewDescription);

       return { newDescription: cleanedNewDescription, newTimestamp: entryToUpdate.timestamp };

   } catch (error) {
       console.error(`[Reidentify] 错误：写入更新后的图片缓存文件 ${imageCacheFilePath} 失败:`, error);
       throw new Error(`写入更新后的图片缓存文件失败: ${error.message}`);
   }
}

// 导出函数供其他模块调用
module.exports = {
   reidentifyImageByBase64Key
};

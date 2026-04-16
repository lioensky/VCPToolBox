const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    
    // 路径指向 EmojiListGenerator 插件生成的列表目录
    const EMOJI_LISTS_DIR = path.join(__dirname, '..', '..', 'Plugin', 'EmojiListGenerator', 'generated_lists');

    /**
     * GET /emojis/list
     * 返回所有表情包类别及其包含的文件名列表
     */
    router.get('/emojis/list', async (req, res) => {
        try {
            // 确保目录存在
            await fs.mkdir(EMOJI_LISTS_DIR, { recursive: true });
            
            const files = await fs.readdir(EMOJI_LISTS_DIR);
            const result = {};

            for (const file of files) {
                if (file.toLowerCase().endsWith('.txt')) {
                    const categoryName = path.basename(file, '.txt');
                    const filePath = path.join(EMOJI_LISTS_DIR, file);
                    
                    try {
                        const content = await fs.readFile(filePath, 'utf-8');
                        // 过滤掉空字符串（处理末尾分隔符或空文件）
                        const emojiNames = content.split('|').filter(name => name.trim().length > 0);
                        result[categoryName] = emojiNames;
                    } catch (readError) {
                        console.error(`[EmojisRoute] Failed to read emoji list file ${file}:`, readError);
                        // 如果读取失败，跳过该分类或标记为错误
                    }
                }
            }

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            console.error('[EmojisRoute] Error scanning emoji lists:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to list emojis',
                details: error.message
            });
        }
    });

    /**
     * POST /emojis/list
     * 别名，方便某些场景下的 POST 调用，功能相同
     */
    router.post('/emojis/list', async (req, res) => {
        // 重用 GET 逻辑
        req.url = '/emojis/list';
        router.handle(req, res);
    });

    return router;
};

// purge_old_cache.js
const fs = require('fs').promises;
const path = require('path');

const imageCacheFilePath = path.join(__dirname, 'imagebase64.json');
const MAX_AGE_DAYS = 90; // 定义最大缓存天数，例如 90 天 (约3个月)

async function purgeOldCacheEntries() {
    console.log(`开始清理 ${MAX_AGE_DAYS} 天前的旧图片缓存条目...`);

    let imageBase64Cache;
    try {
        const data = await fs.readFile(imageCacheFilePath, 'utf-8');
        imageBase64Cache = JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`缓存文件 ${imageCacheFilePath} 不存在，无需清理。`);
            return;
        }
        console.error(`错误：读取图片缓存文件 ${imageCacheFilePath} 失败:`, error);
        return;
    }

    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setDate(now.getDate() - MAX_AGE_DAYS); // 计算截止日期

    console.log(`当前的截止日期为: ${cutoffDate.toISOString()}`);

    let purgedCount = 0;
    const newCache = {};

    for (const base64Key in imageBase64Cache) {
        const entry = imageBase64Cache[base64Key];
        // 确保条目是新格式的对象并且有时间戳
        if (typeof entry === 'object' && entry.timestamp) {
            const entryDate = new Date(entry.timestamp);
            if (entryDate < cutoffDate) {
                console.log(`删除条目 ID: ${entry.id} (时间戳: ${entry.timestamp}, Base64头: ${base64Key.substring(0,30)}...), 因为它早于 ${cutoffDate.toISOString()}`);
                purgedCount++;
            } else {
                newCache[base64Key] = entry; // 保留未过期的条目
            }
        } else {
            // 如果是旧格式（纯字符串）或者没有时间戳，可以选择保留或删除
            // 这里选择保留，因为无法判断其年龄
            console.log(`保留条目 (Base64头: ${base64Key.substring(0,30)}...), 因为其格式无法判断日期或为旧格式。`);
            newCache[base64Key] = entry;
        }
    }

    if (purgedCount > 0) {
        try {
            await fs.writeFile(imageCacheFilePath, JSON.stringify(newCache, null, 2));
            console.log(`成功清理并保存缓存文件。共删除了 ${purgedCount} 条旧的缓存条目。`);
        } catch (error) {
            console.error(`错误：写入更新后的图片缓存文件 ${imageCacheFilePath} 失败:`, error);
        }
    } else {
        console.log('没有找到需要清理的旧缓存条目。');
    }
}

purgeOldCacheEntries();
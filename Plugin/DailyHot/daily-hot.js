// 保存原始 stdout.write 引用，用于最终输出 JSON
const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
// 劫持 stdout，屏蔽下游路由模块的所有日志输出（它们的日志库直接写 stdout）
process.stdout.write = () => true;
// 同时屏蔽 console.log（双保险）
console.log = () => { };
console.error = () => { };

const path = require('path');
const fs = require('fs').promises;

const CACHE_FILE_PATH = path.join(__dirname, 'dailyhot_cache.md');
const INTERNAL_TIMEOUT_MS = 30000;

async function fetchSource(source) {
    let routeHandler;
    try {
        const routePath = path.join(__dirname, 'dist', 'routes', `${source}.js`);
        routeHandler = require(routePath);
    } catch (e) {
        console.error(`[DailyHot] 加载 '${source}' 模块失败: ${e.message}`);
        return { source, error: `模块加载失败: ${e.message}` };
    }

    if (typeof routeHandler.handleRoute !== 'function') {
        return { source, error: `模块未导出 'handleRoute' 函数` };
    }

    try {
        // 传递一个空对象而不是 null，以避免在下游模块中出现 'reading req of null' 的错误
        const resultData = await routeHandler.handleRoute({}, true);
        if (!resultData || !Array.isArray(resultData.data)) {
            return { source, error: `返回的数据格式不正确` };
        }
        const title = resultData.title || source.charAt(0).toUpperCase() + source.slice(1);
        const type = resultData.type || '热榜';
        const defaultCategory = `${title} - ${type}`;
        return resultData.data.map(item => ({
            // 如果条目自带分类，则使用自带的，否则使用默认分类
            category: item.category || defaultCategory,
            title: item.title,
            url: item.url
        }));
    } catch (e) {
        console.error(`[DailyHot] 处理 '${source}' 数据时发生错误: ${e.message}`);
        return { source, error: `处理数据时发生错误: ${e.message}` };
    }
}

async function fetchAndProcessData() {
    let allSources = [];
    try {
        const routesDir = path.join(__dirname, 'dist', 'routes');
        const files = await fs.readdir(routesDir);
        allSources = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'));
    } catch (e) {
        console.error(`[DailyHot] 无法读取数据源目录: ${e.message}`);
        return { success: false, data: null, rawResults: [], error: e };
    }

    if (allSources.length === 0) {
        console.error('[DailyHot] 在 dist/routes 目录中没有找到任何数据源。');
        return { success: false, data: null, rawResults: [], error: new Error('No sources found') };
    }

    const allResults = [];
    const promises = allSources.map(source => fetchSource(source));
    const results = await Promise.allSettled(promises);

    results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            allResults.push(...result.value);
        } else if (result.status === 'fulfilled' && result.value.error) {
            console.error(`[DailyHot] 获取源失败: ${result.value.source} - ${result.value.error}`);
        } else if (result.status === 'rejected') {
            console.error(`[DailyHot] Promise for a source was rejected:`, result.reason);
        }
    });

    if (allResults.length > 0) {
        let markdownOutput = "# 每日热榜综合\n\n";
        const groupedByCategory = allResults.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
        }, {});

        for (const category in groupedByCategory) {
            markdownOutput += `## ${category}\n\n`;
            groupedByCategory[category].forEach((item, index) => {
                markdownOutput += `${index + 1}. [${item.title}](${item.url})\n`;
            });
            markdownOutput += `\n`;
        }

        try {
            await fs.writeFile(CACHE_FILE_PATH, markdownOutput, 'utf-8');
            console.error(`[DailyHot] 成功更新缓存文件: ${CACHE_FILE_PATH}`);
        } catch (e) {
            console.error(`[DailyHot] 写入缓存文件失败: ${e.message}`);
        }
        return { success: true, data: markdownOutput, rawResults: allResults, error: null };
    } else {
        return { success: false, data: null, rawResults: [], error: new Error('Failed to fetch data from any source') };
    }
}

/**
 * 从原始数据构建 vcp_dynamic_fold 输出
 */
function buildFoldFromResults(allResults) {
    const cachePath = path.resolve(CACHE_FILE_PATH);
    const pathNote = `完整热榜数据文件: ${cachePath}`;

    const grouped = allResults.reduce((acc, item) => {
        if (!acc[item.category]) acc[item.category] = [];
        acc[item.category].push(item);
        return acc;
    }, {});

    const categories = Object.keys(grouped);

    // 高相关: 每个源 Top 3 标题，不显示源名称
    const highLines = [];
    for (const cat of categories) {
        grouped[cat].slice(0, 3).forEach(item => {
            highLines.push(`- ${item.title}`);
        });
    }

    // 中相关: 每个源 Top 1 标题，不显示源名称
    const medLines = [];
    for (const cat of categories) {
        medLines.push(`- ${grouped[cat][0].title}`);
    }

    return {
        vcp_dynamic_fold: true,
        plugin_description: "每日热榜新闻聚合插件，汇集科技、社会、游戏、财经等多源实时热点新闻与热搜话题",
        fold_blocks: [
            {
                threshold: 0.5,
                content: `${pathNote}\n\n各源热点Top3:\n${highLines.join('\n')}`
            },
            {
                threshold: 0.35,
                content: `${pathNote}\n\n各源头条:\n${medLines.join('\n')}`
            },
            {
                threshold: 0.0,
                content: `当前已缓存 ${categories.length} 个新闻源的热榜数据。${pathNote}`
            }
        ]
    };
}

/**
 * 从缓存 Markdown 解析并构建 vcp_dynamic_fold 输出（降级兜底）
 */
function buildFoldFromCache(cacheContent) {
    const cachePath = path.resolve(CACHE_FILE_PATH);
    const pathNote = `完整热榜数据文件: ${cachePath}`;

    const lines = cacheContent.split('\n');
    const headlines = [];
    let categoryCount = 0;

    for (const line of lines) {
        const headlineMatch = line.match(/^\d+\.\s+\[(.+?)\]\(.*?\)$/);
        if (headlineMatch) {
            headlines.push(headlineMatch[1]);
        }
        if (line.match(/^## /)) {
            categoryCount++;
        }
    }

    // 从缓存中取前30条做高相关，前10条做中相关
    const highLines = headlines.slice(0, 30).map(h => `- ${h}`);
    const medLines = headlines.slice(0, 10).map(h => `- ${h}`);

    return {
        vcp_dynamic_fold: true,
        plugin_description: "每日热榜新闻聚合插件，汇集科技、社会、游戏、财经等多源实时热点新闻与热搜话题",
        fold_blocks: [
            {
                threshold: 0.5,
                content: `${pathNote}\n\n热点摘要(缓存):\n${highLines.join('\n')}`
            },
            {
                threshold: 0.35,
                content: `${pathNote}\n\n头条摘要(缓存):\n${medLines.join('\n')}`
            },
            {
                threshold: 0.0,
                content: `当前已缓存 ${categoryCount} 个新闻源的热榜数据(来自缓存)。${pathNote}`
            }
        ]
    };
}

async function readCacheOnError() {
    try {
        const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
        console.error(`[DailyHot] 成功从缓存文件 ${CACHE_FILE_PATH} 提供数据。`);
        return cachedData;
    } catch (e) {
        console.error(`[DailyHot] 读取缓存文件失败: ${e.message}`);
        return null;
    }
}

(async () => {
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Internal script timeout')), INTERNAL_TIMEOUT_MS)
    );

    let foldOutput;
    try {
        const result = await Promise.race([
            fetchAndProcessData(),
            timeoutPromise
        ]);

        if (result.success && result.rawResults.length > 0) {
            foldOutput = buildFoldFromResults(result.rawResults);
        } else {
            console.error(`[DailyHot] Fetch and process failed: ${result.error.message}. Falling back to cache.`);
            const cached = await readCacheOnError();
            if (cached) {
                foldOutput = buildFoldFromCache(cached);
            }
        }
    } catch (e) {
        console.error(`[DailyHot] Operation timed out or failed critically: ${e.message}. Falling back to cache.`);
        const cached = await readCacheOnError();
        if (cached) {
            foldOutput = buildFoldFromCache(cached);
        }
    }

    // 最终兜底：连缓存都没有
    if (!foldOutput) {
        const cachePath = path.resolve(CACHE_FILE_PATH);
        foldOutput = {
            vcp_dynamic_fold: true,
            plugin_description: "每日热榜新闻聚合插件，汇集科技、社会、游戏、财经等多源实时热点新闻与热搜话题",
            fold_blocks: [
                { threshold: 0.5, content: "获取热榜数据失败，且本地无可用缓存。" },
                { threshold: 0.35, content: "获取热榜数据失败，且本地无可用缓存。" },
                { threshold: 0.0, content: "热榜数据暂不可用。" }
            ]
        };
    }

    const output = JSON.stringify(foldOutput, null, 2);
    _originalStdoutWrite(output, 'utf-8', () => {
        process.exit(0);
    });
})();
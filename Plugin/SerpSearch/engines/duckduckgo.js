const { getJson } = require("serpapi");

// DuckDuckGo 搜索引擎模块
async function search(parameters, apiKey) {
    const { q, query, text, kl } = parameters;
    const searchQuery = q || query || text;

    if (!searchQuery) {
        return { success: false, error: "Missing search query parameter. Please use 'q', 'query', or 'text'." };
    }

    const searchParams = {
        engine: "duckduckgo",
        q: searchQuery,
        api_key: apiKey
    };

    // 添加可选的语言/区域参数
    if (kl) {
        searchParams.kl = kl;
    }

    return new Promise((resolve) => {
        getJson(searchParams, (json) => {
            if (json.error) {
                resolve({ success: false, error: `SerpApi Error: ${json.error}` });
            } else {
                // 提取和格式化搜索结果
                const organicResults = json.organic_results.map(r => `Title: ${r.title}\nLink: ${r.link}\nSnippet: ${r.snippet}`).join('\n\n');
                const formattedResult = `--- Organic Results ---\n${organicResults}`;
                resolve({ success: true, data: formattedResult });
            }
        });
    });
}

module.exports = {
    search
};
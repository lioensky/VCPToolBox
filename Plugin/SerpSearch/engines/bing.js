const { getJson } = require("serpapi");

// Bing 搜索引擎模块
async function search(parameters, apiKey) {
    const { q, query, text, cc, location } = parameters;
    const searchQuery = q || query || text;

    if (!searchQuery) {
        return { success: false, error: "Missing search query parameter. Please use 'q', 'query', or 'text'." };
    }

    const searchParams = {
        engine: "bing",
        q: searchQuery,
        api_key: apiKey
    };

    // 添加可选的位置参数
    const countryCode = cc || location;
    if (countryCode) {
        searchParams.cc = countryCode;
    }

    return new Promise((resolve) => {
        getJson(searchParams, (json) => {
            if (json.error) {
                resolve({ success: false, error: `SerpApi Error: ${json.error}` });
            } else {
                // 提取和格式化搜索结果
                const answerBox = json.answer_box ? `Answer Box: ${JSON.stringify(json.answer_box)}\n` : '';
                const organicResults = json.organic_results.map(r => `Title: ${r.title}\nLink: ${r.link}\nSnippet: ${r.snippet}`).join('\n\n');
                const formattedResult = `${answerBox}--- Organic Results ---\n${organicResults}`;
                resolve({ success: true, data: formattedResult });
            }
        });
    });
}

module.exports = {
    search
};
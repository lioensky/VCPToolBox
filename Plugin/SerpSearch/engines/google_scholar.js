const { getJson } = require("serpapi");

// Google Scholar 搜索引擎模块
async function search(parameters, apiKey) {
    const { q, query, text, cites, as_ylo, as_yhi, scisbd, cluster, hl, lr } = parameters;
    const searchQuery = q || query || text;

    if (!searchQuery && !cites && !cluster) {
        return { success: false, error: "Missing search query parameter. Please use 'q', 'cites', or 'cluster'." };
    }

    const searchParams = {
        engine: "google_scholar",
        api_key: apiKey
    };

    // 添加搜索参数
    if (searchQuery) searchParams.q = searchQuery;
    if (cites) searchParams.cites = cites;
    if (cluster) searchParams.cluster = cluster;
    if (as_ylo) searchParams.as_ylo = as_ylo;
    if (as_yhi) searchParams.as_yhi = as_yhi;
    if (scisbd) searchParams.scisbd = scisbd;
    if (hl) searchParams.hl = hl;
    if (lr) searchParams.lr = lr;

    return new Promise((resolve) => {
        getJson(searchParams, (json) => {
            if (json.error) {
                resolve({ success: false, error: `SerpApi Error: ${json.error}` });
            } else if (json.organic_results) {
                 // 格式化学术搜索结果
                const organicResults = json.organic_results.map(r => {
                    let result = `Title: ${r.title}\nLink: ${r.link}\n`;
                    if (r.publication_info && r.publication_info.summary) {
                        result += `Authors: ${r.publication_info.summary}\n`;
                    }
                    if (r.snippet) {
                        result += `Snippet: ${r.snippet}\n`;
                    }
                    if (r.resources) {
                        const resources = r.resources.map(res => `[${res.title}](${res.link})`).join(' ');
                        result += `Resources: ${resources}\n`;
                    }
                     if (r.cited_by && r.cited_by.total) {
                        result += `Cited By: ${r.cited_by.total} articles\n`;
                    }
                    return result;
                }).join('\n\n');

                const formattedResult = `--- Scholar Results ---\n${organicResults}`;
                resolve({ success: true, data: formattedResult });
            }
            else {
                 resolve({ success: false, error: "No organic results found in the response." });
            }
        });
    });
}

module.exports = {
    search
};
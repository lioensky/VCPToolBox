"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const cheerio_1 = require("cheerio");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "hackernews",
        title: "Hacker News",
        type: "Popular",
        description: "News about hacking and startups",
        link: "https://news.ycombinator.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const baseUrl = "https://news.ycombinator.com";
    const result = await (0, getData_js_1.get)({
        url: baseUrl,
        noCache,
        headers: {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
    });
    try {
        const $ = (0, cheerio_1.load)(result.data);
        const stories = [];
        $(".athing").each((_, el) => {
            const item = $(el);
            const id = item.attr("id") || "";
            const title = item.find(".titleline a").first().text().trim();
            const url = item.find(".titleline a").first().attr("href");
            // 获取分数并转换为数字
            const scoreText = $(`#score_${id}`).text().match(/\d+/)?.[0];
            const hot = scoreText ? parseInt(scoreText, 10) : undefined;
            if (id && title) {
                stories.push({
                    id,
                    title,
                    hot,
                    timestamp: undefined,
                    url: url || `${baseUrl}/item?id=${id}`,
                    mobileUrl: url || `${baseUrl}/item?id=${id}`,
                });
            }
        });
        return {
            ...result,
            data: stories,
        };
    }
    catch (error) {
        throw new Error(`Failed to parse HackerNews HTML: ${error}`);
    }
};

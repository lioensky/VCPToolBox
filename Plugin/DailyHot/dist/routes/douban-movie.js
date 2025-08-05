"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const cheerio_1 = require("cheerio");
const getData_js_1 = require("../utils/getData.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "douban-movie",
        title: "豆瓣电影",
        type: "新片榜",
        link: "https://movie.douban.com/chart",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
// 数据处理
const getNumbers = (text) => {
    if (!text)
        return 0;
    const regex = /\d+/;
    const match = text.match(regex);
    if (match) {
        return Number(match[0]);
    }
    else {
        return 0;
    }
};
const getList = async (noCache) => {
    const url = `https://movie.douban.com/chart/`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
        },
    });
    const $ = (0, cheerio_1.load)(result.data);
    const listDom = $(".article tr.item");
    const listData = listDom.toArray().map((item) => {
        const dom = $(item);
        const url = dom.find("a").attr("href") || undefined;
        const scoreDom = dom.find(".rating_nums");
        const score = scoreDom.length > 0 ? scoreDom.text() : "0.0";
        return {
            id: getNumbers(url),
            title: `【${score}】${dom.find("a").attr("title")}`,
            cover: dom.find("img").attr("src"),
            desc: dom.find("p.pl").text(),
            timestamp: undefined,
            hot: getNumbers(dom.find("span.pl").text()),
            url: url || `https://movie.douban.com/subject/${getNumbers(url)}/`,
            mobileUrl: `https://m.douban.com/movie/subject/${getNumbers(url)}/`,
        };
    });
    return {
        ...result,
        data: listData,
    };
};

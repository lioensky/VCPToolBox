"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const cheerio_1 = require("cheerio");
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "douban-group",
        title: "豆瓣讨论",
        type: "讨论精选",
        link: "https://www.douban.com/group/explore",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
// 数据处理
const getNumbers = (text) => {
    if (!text)
        return 100000000;
    const regex = /\d+/;
    const match = text.match(regex);
    if (match) {
        return Number(match[0]);
    }
    else {
        return 100000000;
    }
};
const getList = async (noCache) => {
    const url = `https://www.douban.com/group/explore`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const $ = (0, cheerio_1.load)(result.data);
    const listDom = $(".article .channel-item");
    const listData = listDom.toArray().map((item) => {
        const dom = $(item);
        const url = dom.find("h3 a").attr("href") || undefined;
        return {
            id: getNumbers(url),
            title: dom.find("h3 a").text().trim(),
            cover: dom.find(".pic-wrap img").attr("src"),
            desc: dom.find(".block p").text().trim(),
            timestamp: (0, getTime_js_1.getTime)(dom.find("span.pubtime").text().trim()),
            hot: 0,
            url: url || `https://www.douban.com/group/topic/${getNumbers(url)}`,
            mobileUrl: `https://m.douban.com/group/topic/${getNumbers(url)}/`,
        };
    });
    return {
        ...result,
        data: listData,
    };
};

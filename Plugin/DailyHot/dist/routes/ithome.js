"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const cheerio_1 = require("cheerio");
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "ithome",
        title: "IT之家",
        type: "热榜",
        description: "爱科技，爱这里 - 前沿科技新闻网站",
        link: "https://m.ithome.com/rankm/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
// 链接处理
const replaceLink = (url, getId = false) => {
    const match = url.match(/[html|live]\/(\d+)\.htm/);
    // 是否匹配成功
    if (match && match[1]) {
        return getId
            ? match[1]
            : `https://www.ithome.com/0/${match[1].slice(0, 3)}/${match[1].slice(3)}.htm`;
    }
    // 返回原始 URL
    return url;
};
const getList = async (noCache) => {
    const url = `https://m.ithome.com/rankm/`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const $ = (0, cheerio_1.load)(result.data);
    const listDom = $(".rank-box .placeholder");
    const listData = listDom.toArray().map((item) => {
        const dom = $(item);
        const href = dom.find("a").attr("href");
        return {
            id: href ? Number(replaceLink(href, true)) : 100000,
            title: dom.find(".plc-title").text().trim(),
            cover: dom.find("img").attr("data-original"),
            timestamp: (0, getTime_js_1.getTime)(dom.find("span.post-time").text().trim()),
            hot: Number(dom.find(".review-num").text().replace(/\D/g, "")),
            url: href ? replaceLink(href) : "",
            mobileUrl: href ? replaceLink(href) : "",
        };
    });
    return {
        ...result,
        data: listData,
    };
};

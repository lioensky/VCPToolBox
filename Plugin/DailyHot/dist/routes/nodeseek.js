"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const parseRSS_js_1 = require("../utils/parseRSS.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "nodeseek",
        title: "NodeSeek",
        type: "最新",
        params: {
            type: {
                name: "分类",
                type: {
                    all: "所有",
                },
            },
        },
        link: "https://www.nodeseek.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://rss.nodeseek.com/`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = await (0, parseRSS_js_1.parseRSS)(result.data);
    return {
        ...result,
        data: list.map((v, i) => ({
            id: v.guid || i,
            title: v.title || "",
            desc: v.content?.trim() || "",
            author: v.author,
            timestamp: (0, getTime_js_1.getTime)(v.pubDate || 0),
            hot: undefined,
            url: v.link || "",
            mobileUrl: v.link || "",
        })),
    };
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "netease-news",
        title: "网易新闻",
        type: "热点榜",
        link: "https://m.163.com/hot",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://m.163.com/fe/api/hot/news/flow`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.list;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.docid,
            title: v.title,
            cover: v.imgsrc,
            author: v.source,
            hot: undefined,
            timestamp: (0, getTime_js_1.getTime)(v.ptime),
            url: `https://www.163.com/dy/article/${v.docid}.html`,
            mobileUrl: `https://m.163.com/dy/article/${v.docid}.html`,
        })),
    };
};

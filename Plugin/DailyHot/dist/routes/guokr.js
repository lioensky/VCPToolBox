"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "guokr",
        title: "果壳",
        type: "热门文章",
        description: "科技有意思",
        link: "https://www.guokr.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://www.guokr.com/beta/proxy/science_api/articles?limit=30`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        },
    });
    const list = result.data;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.title,
            desc: v.summary,
            cover: v.small_image,
            author: v.author?.nickname,
            hot: undefined,
            timestamp: (0, getTime_js_1.getTime)(v.date_modified),
            url: `https://www.guokr.com/article/${v.id}`,
            mobileUrl: `https://m.guokr.com/article/${v.id}`,
        })),
    };
};

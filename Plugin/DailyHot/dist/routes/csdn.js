"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "csdn",
        title: "CSDN",
        type: "排行榜",
        description: "专业开发者社区",
        link: "https://www.csdn.net/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = "https://blog.csdn.net/phoenix/web/blog/hot-rank?page=0&pageSize=30";
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.productId,
            title: v.articleTitle,
            cover: v.picList?.[0] || undefined,
            desc: undefined,
            author: v.nickName,
            timestamp: (0, getTime_js_1.getTime)(v.period),
            hot: Number(v.hotRankScore),
            url: v.articleDetailUrl,
            mobileUrl: v.articleDetailUrl,
        })),
    };
};

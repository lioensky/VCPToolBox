"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const coolapk_js_1 = require("../utils/getToken/coolapk.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "coolapk",
        title: "酷安",
        type: "热榜",
        link: "https://www.coolapk.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://api.coolapk.com/v6/page/dataList?url=/feed/statList?cacheExpires=300&statType=day&sortField=detailnum&title=今日热门&title=今日热门&subTitle=&page=1`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: (0, coolapk_js_1.genHeaders)(),
    });
    const list = result.data.data;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.message,
            cover: v.tpic,
            author: v.username,
            desc: v.ttitle,
            timestamp: undefined,
            hot: undefined,
            url: v.shareUrl,
            mobileUrl: v.shareUrl,
        })),
    };
};

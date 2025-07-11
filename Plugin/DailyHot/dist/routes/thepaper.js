"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "thepaper",
        title: "澎湃新闻",
        type: "热榜",
        link: "https://www.thepaper.cn/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.hotNews;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.contId,
            title: v.name,
            cover: v.pic,
            hot: Number(v.praiseTimes),
            timestamp: (0, getTime_js_1.getTime)(v.pubTimeLong),
            url: `https://www.thepaper.cn/newsDetail_forward_${v.contId}`,
            mobileUrl: `https://m.thepaper.cn/newsDetail_forward_${v.contId}`,
        })),
    };
};

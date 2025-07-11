"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "qq-news",
        title: "腾讯新闻",
        type: "热点榜",
        link: "https://news.qq.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://r.inews.qq.com/gw/event/hot_ranking_list?page_size=50`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.idlist[0].newslist.slice(1);
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.title,
            desc: v.abstract,
            cover: v.miniProShareImage,
            author: v.source,
            hot: v.hotEvent.hotScore,
            timestamp: (0, getTime_js_1.getTime)(v.timestamp),
            url: `https://new.qq.com/rain/a/${v.id}`,
            mobileUrl: `https://view.inews.qq.com/k/${v.id}`,
        })),
    };
};

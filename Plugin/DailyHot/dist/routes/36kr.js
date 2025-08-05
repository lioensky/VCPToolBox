"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const typeMap = {
    hot: "人气榜",
    video: "视频榜",
    comment: "热议榜",
    collect: "收藏榜",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "hot";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "36kr",
        title: "36氪",
        type: typeMap[type],
        params: {
            type: {
                name: "热榜分类",
                type: typeMap,
            },
        },
        link: "https://m.36kr.com/hot-list-m",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://gateway.36kr.com/api/mis/nav/home/nav/rank/${type}`;
    const result = await (0, getData_js_1.post)({
        url,
        noCache,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
        body: {
            partner_id: "wap",
            param: {
                siteId: 1,
                platformId: 2,
            },
            timestamp: new Date().getTime(),
        },
    });
    const listType = {
        hot: "hotRankList",
        video: "videoList",
        comment: "remarkList",
        collect: "collectList",
    };
    const list = result.data.data[listType[type || "hot"]];
    return {
        ...result,
        data: list.map((v) => {
            const item = v.templateMaterial;
            return {
                id: v.itemId,
                title: item.widgetTitle,
                cover: item.widgetImage,
                author: item.authorName,
                timestamp: (0, getTime_js_1.getTime)(v.publishTime),
                hot: item.statCollect || undefined,
                url: `https://www.36kr.com/p/${v.itemId}`,
                mobileUrl: `https://m.36kr.com/p/${v.itemId}`,
            };
        }),
    };
};

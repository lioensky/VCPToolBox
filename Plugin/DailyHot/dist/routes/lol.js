"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "lol",
        title: "英雄联盟",
        type: "更新公告",
        link: "https://lol.qq.com/gicp/news/423/2/1334/1.html",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = "https://apps.game.qq.com/cmc/zmMcnTargetContentList?r0=json&page=1&num=30&target=24&source=web_pc";
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.result;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.iDocID,
            title: v.sTitle,
            cover: `https:${v.sIMG}`,
            author: v.sAuthor,
            hot: Number(v.iTotalPlay),
            timestamp: (0, getTime_js_1.getTime)(v.sCreated),
            url: `https://lol.qq.com/news/detail.shtml?docid=${encodeURIComponent(v.iDocID)}`,
            mobileUrl: `https://lol.qq.com/news/detail.shtml?docid=${encodeURIComponent(v.iDocID)}`,
        })),
    };
};

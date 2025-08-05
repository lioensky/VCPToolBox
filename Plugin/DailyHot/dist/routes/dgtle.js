"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "dgtle",
        title: "数字尾巴",
        type: "热门文章",
        description: "致力于分享美好数字生活体验，囊括你闻所未闻的最丰富数码资讯，触所未触最抢鲜产品评测，随时随地感受尾巴们各式数字生活精彩图文、摄影感悟、旅行游记、爱物分享。",
        link: "https://www.dgtle.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://opser.api.dgtle.com/v2/news/index`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data?.items;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.title || v.content,
            desc: v.content,
            cover: v.cover,
            author: v.from,
            hot: v.membernum,
            timestamp: (0, getTime_js_1.getTime)(v.created_at),
            url: `https://www.dgtle.com/news-${v.id}-${v.type}.html`,
            mobileUrl: `https://m.dgtle.com/news-details/${v.id}`,
        })),
    };
};

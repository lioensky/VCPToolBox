"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "zhihu-daily",
        title: "知乎日报",
        type: "推荐榜",
        description: "每天三次，每次七分钟",
        link: "https://daily.zhihu.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://daily.zhihu.com/api/4/news/latest`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            Referer: "https://daily.zhihu.com/api/4/news/latest",
            Host: "daily.zhihu.com",
        },
    });
    const list = result.data.stories.filter((el) => el.type === 0);
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.title,
            cover: v.images?.[0] ?? undefined,
            author: v.hint,
            hot: undefined,
            timestamp: undefined,
            url: v.url,
            mobileUrl: v.url,
        })),
    };
};

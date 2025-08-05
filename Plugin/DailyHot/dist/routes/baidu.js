"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const typeMap = {
    realtime: "热搜",
    novel: "小说",
    movie: "电影",
    teleplay: "电视剧",
    car: "汽车",
    game: "游戏",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "realtime";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "baidu",
        title: "百度",
        type: typeMap[type],
        params: {
            type: {
                name: "热搜类别",
                type: typeMap,
            },
        },
        link: "https://top.baidu.com/board",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://top.baidu.com/board?tab=${type}`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/605.1.15",
        },
    });
    // 正则查找
    const pattern = /<!--s-data:(.*?)-->/s;
    const matchResult = result.data.match(pattern);
    const jsonObject = JSON.parse(matchResult[1]).cards[0].content;
    return {
        ...result,
        data: jsonObject.map((v) => ({
            id: v.index,
            title: v.word,
            desc: v.desc,
            cover: v.img,
            author: v.show?.length ? v.show : "",
            timestamp: 0,
            hot: Number(v.hotScore || 0),
            url: `https://www.baidu.com/s?wd=${encodeURIComponent(v.query)}`,
            mobileUrl: v.rawUrl,
        })),
    };
};

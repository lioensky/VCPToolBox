"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getNum_js_1 = require("../utils/getNum.js");
const getData_js_1 = require("../utils/getData.js");
const typeMap = {
    all: "新浪热榜",
    hotcmnt: "热议榜",
    minivideo: "视频热榜",
    ent: "娱乐热榜",
    ai: "AI热榜",
    auto: "汽车热榜",
    mother: "育儿热榜",
    fashion: "时尚热榜",
    travel: "旅游热榜",
    esg: "ESG热榜",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "all";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "sina",
        title: "新浪网",
        type: typeMap[type],
        description: "热榜太多，一个就够",
        params: {
            type: {
                name: "榜单分类",
                type: typeMap,
            },
        },
        link: "https://sinanews.sina.cn/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://newsapp.sina.cn/api/hotlist?newsId=HB-1-snhs%2Ftop_news_list-${type}`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.hotList;
    return {
        ...result,
        data: list.map((v) => {
            const base = v.base;
            const info = v.info;
            return {
                id: base.base.uniqueId,
                title: info.title,
                desc: undefined,
                author: undefined,
                timestamp: undefined,
                hot: (0, getNum_js_1.parseChineseNumber)(info.hotValue),
                url: base.base.url,
                mobileUrl: base.base.url,
            };
        }),
    };
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "weibo",
        title: "微博",
        type: "热搜榜",
        description: "实时热点，每分钟更新一次",
        link: "https://s.weibo.com/top/summary/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://weibo.com/ajax/side/hotSearch`;
    const result = await (0, getData_js_1.get)({ url, noCache, ttl: 60 });
    const list = result.data.data.realtime;
    return {
        ...result,
        data: list.map((v) => {
            const key = v.word_scheme ? v.word_scheme : `#${v.word}`;
            return {
                id: v.mid,
                title: v.word,
                desc: v.note || key,
                author: v.flag_desc,
                timestamp: (0, getTime_js_1.getTime)(v.onboard_time),
                hot: v.num,
                url: `https://s.weibo.com/weibo?q=${encodeURIComponent(key)}&t=31&band_rank=1&Refer=top`,
                mobileUrl: `https://s.weibo.com/weibo?q=${encodeURIComponent(key)}&t=31&band_rank=1&Refer=top`,
            };
        }),
    };
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const typeMap = {
    "-1": "综合",
    "155": "番剧",
    "1": "动画",
    "60": "娱乐",
    "201": "生活",
    "58": "音乐",
    "123": "舞蹈·偶像",
    "59": "游戏",
    "70": "科技",
    "68": "影视",
    "69": "体育",
    "125": "鱼塘",
};
const rangeMap = {
    DAY: "今日",
    THREE_DAYS: "三日",
    WEEK: "本周",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "-1";
    const range = c.req.query("range") || "DAY";
    const listData = await getList({ type, range }, noCache);
    const routeData = {
        name: "acfun",
        title: "AcFun",
        type: `排行榜 · ${typeMap[type]}`,
        description: "AcFun是一家弹幕视频网站，致力于为每一个人带来欢乐。",
        params: {
            type: {
                name: "频道",
                type: typeMap,
            },
            range: {
                name: "时间",
                type: rangeMap,
            },
        },
        link: "https://www.acfun.cn/rank/list/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type, range } = options;
    const url = `https://www.acfun.cn/rest/pc-direct/rank/channel?channelId=${type === "-1" ? "" : type}&rankLimit=30&rankPeriod=${range}`;
    const result = await (0, getData_js_1.get)({
        url,
        headers: {
            Referer: `https://www.acfun.cn/rank/list/?cid=-1&pcid=${type}&range=${range}`,
        },
        noCache,
    });
    const list = result.data.rankList;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.dougaId,
            title: v.contentTitle,
            desc: v.contentDesc,
            cover: v.coverUrl,
            author: v.userName,
            timestamp: (0, getTime_js_1.getTime)(v.contributeTime),
            hot: v.likeCount,
            url: `https://www.acfun.cn/v/ac${v.dougaId}`,
            mobileUrl: `https://m.acfun.cn/v/?ac=${v.dougaId}`,
        })),
    };
};

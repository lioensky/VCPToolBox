"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
// 游戏分类
const gameMap = {
    "1": "崩坏3",
    "2": "原神",
    "3": "崩坏学园2",
    "4": "未定事件簿",
    "5": "大别野",
    "6": "崩坏：星穹铁道",
    "7": "暂无",
    "8": "绝区零",
};
// 榜单分类
const typeMap = {
    "1": "公告",
    "2": "活动",
    "3": "资讯",
};
const handleRoute = async (c, noCache) => {
    const game = c.req.query("game") || "1";
    const type = c.req.query("type") || "1";
    const listData = await getList({ game, type }, noCache);
    const routeData = {
        name: "miyoushe",
        title: `米游社 · ${gameMap[game]}`,
        type: `最新${typeMap[type]}`,
        params: {
            game: {
                name: "游戏分类",
                type: gameMap,
            },
            type: {
                name: "榜单分类",
                type: typeMap,
            },
        },
        link: "https://www.miyoushe.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { game, type } = options;
    const url = `https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?client_type=4&gids=${game}&last_id=&page_size=30&type=${type}`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.list;
    return {
        ...result,
        data: list.map((v) => {
            const data = v.post;
            return {
                id: data.post_id,
                title: data.subject,
                desc: data.content,
                cover: data.cover || data?.images?.[0],
                author: v.user?.nickname || undefined,
                timestamp: (0, getTime_js_1.getTime)(data.created_at),
                hot: data.view_status || 0,
                url: `https://www.miyoushe.com/ys/article/${data.post_id}`,
                mobileUrl: `https://m.miyoushe.com/ys/#/article/${data.post_id}`,
            };
        }),
    };
};

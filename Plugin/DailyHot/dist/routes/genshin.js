"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "1";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "genshin",
        title: "原神",
        type: "最新动态",
        params: {
            type: {
                name: "榜单分类",
                type: {
                    1: "公告",
                    2: "活动",
                    3: "资讯",
                },
            },
        },
        link: "https://www.miyoushe.com/ys/home/28",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?client_type=4&gids=2&last_id=&page_size=20&type=${type}`;
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
                hot: data.view_status,
                url: `https://www.miyoushe.com/ys/article/${data.post_id}`,
                mobileUrl: `https://m.miyoushe.com/ys/#/article/${data.post_id}`,
            };
        }),
    };
};

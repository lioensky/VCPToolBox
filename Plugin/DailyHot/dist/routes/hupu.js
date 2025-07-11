"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "1";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "hupu",
        title: "虎扑",
        type: "步行街热帖",
        params: {
            type: {
                name: "榜单分类",
                type: {
                    1: "主干道",
                    6: "恋爱区",
                    11: "校园区",
                    12: "历史区",
                    612: "摄影区",
                },
            },
        },
        link: "https://bbs.hupu.com/all-gambia",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://m.hupu.com/api/v2/bbs/topicThreads?topicId=${type}&page=1`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.topicThreads;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.tid,
            title: v.title,
            author: v.username,
            hot: v.replies,
            timestamp: undefined,
            url: `https://bbs.hupu.com/${v.tid}.html`,
            mobileUrl: v.url,
        })),
    };
};

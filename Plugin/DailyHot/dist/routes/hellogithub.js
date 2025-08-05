"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (c, noCache) => {
    const sort = c.req.query("sort") || "featured";
    const listData = await getList({ sort }, noCache);
    const routeData = {
        name: "hellogithub",
        title: "HelloGitHub",
        type: "热门仓库",
        description: "分享 GitHub 上有趣、入门级的开源项目",
        params: {
            sort: {
                name: "排行榜分区",
                type: {
                    featured: "精选",
                    all: "全部",
                },
            },
        },
        link: "https://hellogithub.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { sort } = options;
    const url = `https://abroad.hellogithub.com/v1/?sort_by=${sort}&tid=&page=1`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.item_id,
            title: v.title,
            desc: v.summary,
            author: v.author,
            timestamp: (0, getTime_js_1.getTime)(v.updated_at),
            hot: v.clicks_total,
            url: `https://hellogithub.com/repository/${v.item_id}`,
            mobileUrl: `https://hellogithub.com/repository/${v.item_id}`,
        })),
    };
};

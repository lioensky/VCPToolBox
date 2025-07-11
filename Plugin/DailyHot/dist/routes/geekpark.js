"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "geekpark",
        title: "极客公园",
        type: "热门文章",
        description: "极客公园聚焦互联网领域，跟踪新鲜的科技新闻动态，关注极具创新精神的科技产品。",
        link: "https://www.geekpark.net/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://mainssl.geekpark.net/api/v2`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data?.homepage_posts;
    return {
        ...result,
        data: list.map((v) => {
            const post = v.post;
            return {
                id: post.id,
                title: post.title,
                desc: post.abstract,
                cover: post.cover_url,
                author: post?.authors?.[0]?.nickname,
                hot: post.views,
                timestamp: (0, getTime_js_1.getTime)(post.published_timestamp),
                url: `https://www.geekpark.net/news/${post.id}`,
                mobileUrl: `https://www.geekpark.net/news/${post.id}`,
            };
        }),
    };
};

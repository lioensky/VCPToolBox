"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "newsmth",
        title: "水木社区",
        type: "热门话题",
        description: "水木社区是一个源于清华的高知社群。",
        link: "https://www.newsmth.net/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://wap.newsmth.net/wap/api/hot/global`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data?.data?.topics;
    return {
        ...result,
        data: list.map((v) => {
            const post = v.article;
            const url = `https://wap.newsmth.net/article/${post.topicId}?title=${v.board?.title}&from=home`;
            return {
                id: v.firstArticleId,
                title: post.subject,
                desc: post.body,
                cover: undefined,
                author: post?.account?.name,
                hot: undefined,
                timestamp: (0, getTime_js_1.getTime)(post.postTime),
                url,
                mobileUrl: url,
            };
        }),
    };
};

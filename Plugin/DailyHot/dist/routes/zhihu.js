"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const config_js_1 = require("../config.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "zhihu",
        title: "知乎",
        type: "热榜",
        link: "https://www.zhihu.com/hot",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        ...(config_js_1.config.ZHIHU_COOKIE && {
            headers: {
                Cookie: config_js_1.config.ZHIHU_COOKIE
            }
        })
    });
    const list = result.data.data;
    return {
        ...result,
        data: list.map((v) => {
            const data = v.target;
            const questionId = data.url.split("/").pop();
            return {
                id: data.id,
                title: data.title,
                desc: data.excerpt,
                cover: v.children[0].thumbnail,
                timestamp: (0, getTime_js_1.getTime)(data.created),
                hot: parseFloat(v.detail_text.split(" ")[0]) * 10000,
                url: `https://www.zhihu.com/question/${questionId}`,
                mobileUrl: `https://www.zhihu.com/question/${questionId}`,
            };
        }),
    };
};

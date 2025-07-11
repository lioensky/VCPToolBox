"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "ifanr",
        title: "爱范儿",
        type: "快讯",
        description: "15秒了解全球新鲜事",
        link: "https://www.ifanr.com/digest/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = "https://sso.ifanr.com/api/v5/wp/buzz/?limit=20&offset=0";
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.objects;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.post_title,
            desc: v.post_content,
            timestamp: (0, getTime_js_1.getTime)(v.created_at),
            hot: v.like_count || v.comment_count,
            url: v.buzz_original_url || `https://www.ifanr.com/${v.post_id}`,
            mobileUrl: v.buzz_original_url || `https://www.ifanr.com/digest/${v.post_id}`,
        })),
    };
};

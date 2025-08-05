"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const _51cto_js_1 = require("../utils/getToken/51cto.js");
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "51cto",
        title: "51CTO",
        type: "推荐榜",
        link: "https://www.51cto.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://api-media.51cto.com/index/index/recommend`;
    const params = {
        page: 1,
        page_size: 50,
        limit_time: 0,
        name_en: "",
    };
    const timestamp = Date.now();
    const token = (await (0, _51cto_js_1.getToken)());
    const result = await (0, getData_js_1.get)({
        url,
        params: {
            ...params,
            timestamp,
            token,
            sign: (0, _51cto_js_1.sign)("index/index/recommend", params, timestamp, token),
        },
        noCache,
    });
    const list = result.data.data.data.list;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.source_id,
            title: v.title,
            cover: v.cover,
            desc: v.abstract,
            timestamp: (0, getTime_js_1.getTime)(v.pubdate),
            hot: undefined,
            url: v.url,
            mobileUrl: v.url,
        })),
    };
};

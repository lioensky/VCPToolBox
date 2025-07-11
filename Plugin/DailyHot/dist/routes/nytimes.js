"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const parseRSS_js_1 = require("../utils/parseRSS.js");
const areaMap = {
    china: "中文网",
    global: "全球版",
};
const handleRoute = async (c, noCache) => {
    const area = c.req.query("type") || "china";
    const listData = await getList({ area }, noCache);
    const routeData = {
        name: "nytimes",
        title: "纽约时报",
        type: areaMap[area],
        params: {
            area: {
                name: "地区分类",
                type: areaMap,
            },
        },
        link: "https://www.nytimes.com/",
        total: listData?.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { area } = options;
    const url = area === "china"
        ? "https://cn.nytimes.com/rss/"
        : "https://rss.nytimes.com/services/xml/rss/nyt/World.xml";
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            userAgent: "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        },
    });
    const list = await (0, parseRSS_js_1.parseRSS)(result.data);
    return {
        ...result,
        data: list.map((v, i) => ({
            id: v.guid || i,
            title: v.title || "",
            desc: v.content?.trim() || "",
            author: v.author,
            timestamp: (0, getTime_js_1.getTime)(v.pubDate || 0),
            hot: undefined,
            url: v.link || "",
            mobileUrl: v.link || "",
        })),
    };
};

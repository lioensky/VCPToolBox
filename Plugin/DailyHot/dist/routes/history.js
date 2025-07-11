"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const cheerio_1 = require("cheerio");
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (c, noCache) => {
    // 获取日期
    const day = c.req.query("day") || (0, getTime_js_1.getCurrentDateTime)(true).day;
    const month = c.req.query("month") || (0, getTime_js_1.getCurrentDateTime)(true).month;
    const listData = await getList({ month, day }, noCache);
    const routeData = {
        name: "history",
        title: "历史上的今天",
        type: `${month}-${day}`,
        params: {
            month: "月份",
            day: "日期",
        },
        link: "https://baike.baidu.com/calendar",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { month, day } = options;
    const monthStr = month?.toString().padStart(2, "0");
    const dayStr = day?.toString().padStart(2, "0");
    const url = `https://baike.baidu.com/cms/home/eventsOnHistory/${monthStr}.json`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        params: {
            _: new Date().getTime(),
        },
    });
    const list = monthStr ? result.data[monthStr][monthStr + dayStr] : [];
    return {
        ...result,
        data: list.map((v, index) => ({
            id: index,
            title: (0, cheerio_1.load)(v.title).text().trim(),
            cover: v.cover ? v.pic_share : undefined,
            desc: (0, cheerio_1.load)(v.desc).text().trim(),
            year: v.year,
            timestamp: undefined,
            hot: undefined,
            url: v.link,
            mobileUrl: v.link,
        })),
    };
};

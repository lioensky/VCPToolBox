"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "linuxdo",
        title: "Linux.do",
        type: "热门文章",
        description: "Linux 技术社区热搜",
        link: "https://linux.do/hot",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = "https://linux.do/top/weekly.json";
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "Accept": "application/json",
        }
    });
    const topics = result.data.topic_list.topics;
    const list = topics.map((topic) => {
        return {
            id: topic.id,
            title: topic.title,
            desc: topic.excerpt,
            author: topic.last_poster_username,
            timestamp: (0, getTime_js_1.getTime)(topic.created_at),
            url: `https://linux.do/t/${topic.id}`,
            mobileUrl: `https://linux.do/t/${topic.id}`,
            hot: topic.views || topic.like_count
        };
    });
    return {
        ...result,
        data: list
    };
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "tieba",
        title: "百度贴吧",
        type: "热议榜",
        description: "全球领先的中文社区",
        link: "https://tieba.baidu.com/hottopic/browse/topicList",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://tieba.baidu.com/hottopic/browse/topicList`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.bang_topic.topic_list;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.topic_id,
            title: v.topic_name,
            desc: v.topic_desc,
            cover: v.topic_pic,
            hot: v.discuss_num,
            timestamp: (0, getTime_js_1.getTime)(v.create_time),
            url: v.topic_url,
            mobileUrl: v.topic_url,
        })),
    };
};

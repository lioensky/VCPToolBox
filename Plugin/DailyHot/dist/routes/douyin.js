"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "douyin",
        title: "抖音",
        type: "热榜",
        description: "实时上升热点",
        link: "https://www.douyin.com",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
// 获取抖音临时 Cookis
const getDyCookies = async () => {
    try {
        const cookisUrl = "https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383";
        const { data } = await (0, getData_js_1.get)({ url: cookisUrl, originaInfo: true });
        const pattern = /passport_csrf_token=(.*); Path/s;
        const matchResult = data.headers["set-cookie"][0].match(pattern);
        const cookieData = matchResult[1];
        return cookieData;
    }
    catch (error) {
        console.error("获取抖音 Cookie 出错" + error);
        return undefined;
    }
};
const getList = async (noCache) => {
    const url = "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1";
    const cookie = await getDyCookies();
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            Cookie: `passport_csrf_token=${cookie}`,
        },
    });
    const list = result.data.data.word_list;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.sentence_id,
            title: v.word,
            timestamp: (0, getTime_js_1.getTime)(v.event_time),
            hot: v.hot_value,
            url: `https://www.douyin.com/hot/${v.sentence_id}`,
            mobileUrl: `https://www.douyin.com/hot/${v.sentence_id}`,
        })),
    };
};

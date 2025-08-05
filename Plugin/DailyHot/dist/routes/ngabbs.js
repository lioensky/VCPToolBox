"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "ngabbs",
        title: "NGA",
        type: "论坛热帖",
        description: "精英玩家俱乐部",
        link: "https://ngabbs.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://ngabbs.com/nuke.php?__lib=load_topic&__act=load_topic_reply_ladder2&opt=1&all=1`;
    const result = await (0, getData_js_1.post)({
        url,
        noCache,
        headers: {
            Accept: "*/*",
            Host: "ngabbs.com",
            Referer: "https://ngabbs.com/",
            Connection: "keep-alive",
            "Content-Length": "11",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "zh-Hans-CN;q=1",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Apifox/1.0.0 (https://apifox.com)",
            "X-User-Agent": "NGA_skull/7.3.1(iPhone13,2;iOS 17.2.1)",
        },
        body: {
            __output: "14",
        },
    });
    const list = result.data.result[0];
    return {
        ...result,
        data: list.map((v) => ({
            id: v.tid,
            title: v.subject,
            author: v.author,
            hot: v.replies,
            timestamp: (0, getTime_js_1.getTime)(v.postdate),
            url: `https://bbs.nga.cn${v.tpcurl}`,
            mobileUrl: `https://bbs.nga.cn${v.tpcurl}`,
        })),
    };
};

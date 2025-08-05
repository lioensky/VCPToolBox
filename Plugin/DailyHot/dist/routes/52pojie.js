"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const parseRSS_js_1 = require("../utils/parseRSS.js");
const iconv_lite_1 = __importDefault(require("iconv-lite"));
const typeMap = {
    digest: "最新精华",
    hot: "最新热门",
    new: "最新回复",
    newthread: "最新发表",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "digest";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "52pojie",
        title: "吾爱破解",
        type: typeMap[type],
        params: {
            type: {
                name: "榜单分类",
                type: typeMap,
            },
        },
        link: "https://www.52pojie.cn/",
        total: listData?.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { type } = options;
    const url = `https://www.52pojie.cn/forum.php?mod=guide&view=${type}&rss=1`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        responseType: "arraybuffer",
        headers: {
            userAgent: "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        },
    });
    // 转码
    const utf8Data = iconv_lite_1.default.decode(result.data, "gbk");
    const list = await (0, parseRSS_js_1.parseRSS)(utf8Data);
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

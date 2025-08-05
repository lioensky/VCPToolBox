"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const weread_js_1 = __importDefault(require("../utils/getToken/weread.js"));
const getTime_js_1 = require("../utils/getTime.js");
const typeMap = {
    rising: "飙升榜",
    hot_search: "热搜榜",
    newbook: "新书榜",
    general_novel_rising: "小说榜",
    all: "总榜",
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "rising";
    const listData = await getList(noCache, type);
    const routeData = {
        name: "weread",
        title: "微信读书",
        type: `${typeMap[type]}`,
        params: {
            type: {
                name: "排行榜分区",
                type: typeMap,
            },
        },
        link: "https://weread.qq.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache, type = 'rising') => {
    const url = `https://weread.qq.com/web/bookListInCategory/${type}?rank=1`;
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.67",
        },
    });
    const list = result.data.books;
    return {
        ...result,
        data: list.map((v) => {
            const data = v.bookInfo;
            return {
                id: data.bookId,
                title: data.title,
                author: data.author,
                desc: data.intro,
                cover: data.cover.replace("s_", "t9_"),
                timestamp: (0, getTime_js_1.getTime)(data.publishTime),
                hot: v.readingCount,
                url: `https://weread.qq.com/web/bookDetail/${(0, weread_js_1.default)(data.bookId)}`,
                mobileUrl: `https://weread.qq.com/web/bookDetail/${(0, weread_js_1.default)(data.bookId)}`,
            };
        }),
    };
};

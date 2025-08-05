"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getNum_js_1 = require("../utils/getNum.js");
const user_agents_1 = __importDefault(require("user-agents"));
const handleRoute = async (_, noCache) => {
    const listData = await getList(noCache);
    const routeData = {
        name: "kuaishou",
        title: "快手",
        type: "热榜",
        description: "快手，拥抱每一种生活",
        link: "https://www.kuaishou.com/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (noCache) => {
    const url = `https://www.kuaishou.com/?isHome=1`;
    const userAgent = new user_agents_1.default({
        deviceCategory: "desktop",
    });
    const result = await (0, getData_js_1.get)({
        url,
        noCache,
        headers: {
            "User-Agent": userAgent.toString(),
        },
    });
    const listData = [];
    // 获取主要内容
    const pattern = /window.__APOLLO_STATE__=(.*);\(function\(\)/s;
    const matchResult = result.data?.match(pattern);
    const jsonObject = JSON.parse(matchResult[1])["defaultClient"];
    // 获取所有分类
    const allItems = jsonObject['$ROOT_QUERY.visionHotRank({"page":"home"})']["items"];
    // 获取全部热榜
    allItems?.forEach((item) => {
        // 基础数据
        const hotItem = jsonObject[item.id];
        const id = hotItem.photoIds?.json?.[0];
        listData.push({
            id: hotItem.id,
            title: hotItem.name,
            cover: decodeURIComponent(hotItem.poster),
            hot: (0, getNum_js_1.parseChineseNumber)(hotItem.hotValue),
            timestamp: undefined,
            url: `https://www.kuaishou.com/short-video/${id}`,
            mobileUrl: `https://www.kuaishou.com/short-video/${id}`,
        });
    });
    return {
        ...result,
        data: listData,
    };
};

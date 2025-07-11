"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getTime_js_1 = require("../utils/getTime.js");
const getData_js_1 = require("../utils/getData.js");
// 榜单类别
const listType = {
    "1": {
        name: "总排行",
        www: "news",
        params: "www_www_all_suda_suda",
    },
    "2": {
        name: "视频排行",
        www: "news",
        params: "video_news_all_by_vv",
    },
    "3": {
        name: "图片排行",
        www: "news",
        params: "total_slide_suda",
    },
    "4": {
        name: "国内新闻",
        www: "news",
        params: "news_china_suda",
    },
    "5": {
        name: "国际新闻",
        www: "news",
        params: "news_world_suda",
    },
    "6": {
        name: "社会新闻",
        www: "news",
        params: "news_society_suda",
    },
    "7": {
        name: "体育新闻",
        www: "sports",
        params: "sports_suda",
    },
    "8": {
        name: "财经新闻",
        www: "finance",
        params: "finance_0_suda",
    },
    "9": {
        name: "娱乐新闻",
        www: "ent",
        params: "ent_suda",
    },
    "10": {
        name: "科技新闻",
        www: "tech",
        params: "tech_news_suda",
    },
    "11": {
        name: "军事新闻",
        www: "news",
        params: "news_mil_suda",
    },
};
const handleRoute = async (c, noCache) => {
    const type = c.req.query("type") || "1";
    const listData = await getList({ type }, noCache);
    const routeData = {
        name: "sina-news",
        title: "新浪新闻",
        type: listType[type].name,
        params: {
            type: {
                name: "榜单分类",
                type: Object.fromEntries(Object.entries(listType).map(([key, value]) => [key, value.name])),
            },
        },
        link: "https://sinanews.sina.cn/",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
// JSONP 处理
const parseData = (data) => {
    // 移除前后多余空白
    if (!data)
        throw new Error("Input data is empty or invalid");
    // 提取 JSON 字符串部分
    const prefix = "var data = ";
    if (!data.startsWith(prefix))
        throw new Error("Input data does not start with the expected prefix");
    let jsonString = data.slice(prefix.length).trim();
    // 确保字符串以 ';' 结尾并移除它
    if (jsonString.endsWith(";")) {
        jsonString = jsonString.slice(0, -1).trim();
    }
    else {
        throw new Error("Input data does not end with a semicolon");
    }
    // 格式是否正确
    if (jsonString.startsWith("{") && jsonString.endsWith("}")) {
        // 解析为 JSON 对象
        try {
            const jsonData = JSON.parse(jsonString);
            return jsonData;
        }
        catch (error) {
            throw new Error("Failed to parse JSON: " + error);
        }
    }
    else {
        throw new Error("Invalid JSON format");
    }
};
const getList = async (options, noCache) => {
    const { type } = options;
    // 必要数据
    const { params, www } = listType[type];
    const { year, month, day } = (0, getTime_js_1.getCurrentDateTime)(true);
    const url = `https://top.${www}.sina.com.cn/ws/GetTopDataList.php?top_type=day&top_cat=${params}&top_time=${year + month + day}&top_show_num=50`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = parseData(result.data).data;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.id,
            title: v.title,
            author: v.media || undefined,
            hot: parseFloat(v.top_num.replace(/,/g, "")),
            timestamp: (0, getTime_js_1.getTime)(v.create_date + " " + v.create_time),
            url: v.url,
            mobileUrl: v.url,
        })),
    };
};

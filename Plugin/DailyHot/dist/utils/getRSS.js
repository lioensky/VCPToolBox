"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const feed_1 = require("feed");
const logger_js_1 = __importDefault(require("./logger.js"));
// 生成 RSS
const getRSS = (data) => {
    try {
        // 基本信息
        const feed = new feed_1.Feed({
            title: data.title,
            description: data.title + data.type + (data?.description ? " - " + data?.description : ""),
            id: data.name,
            link: data.link,
            language: "zh",
            generator: "DailyHotApi",
            copyright: "Copyright © 2020-present imsyy",
            updated: new Date(data.updateTime),
        });
        // 获取数据
        const listData = data.data;
        listData.forEach((item) => {
            feed.addItem({
                id: item.id?.toString(),
                title: item.title,
                date: new Date(data.updateTime),
                link: item.url || "获取失败",
                description: item?.desc,
                author: [
                    {
                        name: item.author,
                    },
                ],
                extensions: [
                    {
                        name: "media:content",
                        objects: {
                            _attributes: {
                                "xmlns:media": "http://search.yahoo.com/mrss/",
                                url: item.cover,
                            },
                            "media:thumbnail": {
                                _attributes: {
                                    url: item.cover,
                                },
                            },
                            "media:description": item.desc ? {
                                _cdata: item.desc
                            } : "",
                        }
                    }
                ]
            });
        });
        const rssData = feed.rss2();
        return rssData;
    }
    catch (error) {
        logger_js_1.default.error("❌ [ERROR] getRSS failed");
        throw error;
    }
};
exports.default = getRSS;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRSS = exports.extractRss = void 0;
const rss_parser_1 = __importDefault(require("rss-parser"));
const logger_js_1 = __importDefault(require("./logger.js"));
/**
 * 提取 RSS 内容
 * @param content HTML 内容
 * @returns RSS 内容
 */
const extractRss = (content) => {
    // 匹配 <rss> 标签及内容
    const rssRegex = /(<rss[\s\S]*?<\/rss>)/i;
    const matches = content.match(rssRegex);
    return matches ? matches[0] : null;
};
exports.extractRss = extractRss;
/**
 * 解析 RSS 内容
 * @param rssContent RSS 内容
 * @returns 解析后的 RSS 内容
 */
const parseRSS = async (rssContent) => {
    const parser = new rss_parser_1.default();
    // 是否为网址
    const isUrl = (url) => {
        try {
            new URL(url);
            return true;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        }
        catch (error) {
            return false;
        }
    };
    try {
        const feed = isUrl(rssContent)
            ? await parser.parseURL(rssContent)
            : await parser.parseString(rssContent);
        const items = feed.items.map((item) => ({
            title: item.title, // 文章标题
            link: item.link, // 文章链接
            pubDate: item.pubDate, // 发布日期
            author: item.creator ?? item.author, // 作者
            content: item.content, // 内容
            contentSnippet: item.contentSnippet, // 内容摘要
            guid: item.guid, // 全局唯一标识符
            categories: item.categories, // 分类
        }));
        // 返回解析数据
        return items;
    }
    catch (error) {
        logger_js_1.default.error("❌ [RSS] An error occurred while parsing RSS content");
        throw error;
    }
};
exports.parseRSS = parseRSS;

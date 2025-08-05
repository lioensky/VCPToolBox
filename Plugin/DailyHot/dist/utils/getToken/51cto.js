"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sign = exports.getToken = void 0;
const cache_js_1 = require("../cache.js");
const getData_js_1 = require("../getData.js");
const md5_1 = __importDefault(require("md5"));
const getToken = async () => {
    const cachedData = await (0, cache_js_1.getCache)("51cto-token");
    if (cachedData?.data)
        return cachedData.data;
    const result = await (0, getData_js_1.get)({
        url: "https://api-media.51cto.com/api/token-get",
    });
    const token = result.data.data.data.token;
    await (0, cache_js_1.setCache)("51cto-token", { data: token, updateTime: new Date().toISOString() });
    return token;
};
exports.getToken = getToken;
const sign = (requestPath, payload = {}, timestamp, token) => {
    payload.timestamp = timestamp;
    payload.token = token;
    const sortedParams = Object.keys(payload).sort();
    return (0, md5_1.default)((0, md5_1.default)(requestPath) + (0, md5_1.default)(sortedParams + (0, md5_1.default)(token) + timestamp));
};
exports.sign = sign;

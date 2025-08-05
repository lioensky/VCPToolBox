"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_js_1 = require("../config.js");
const winston_1 = require("winston");
const path_1 = __importDefault(require("path"));
const chalk_1 = __importDefault(require("chalk"));
let pathOption = [];
// 日志输出目录
if (config_js_1.config.USE_LOG_FILE) {
    try {
        pathOption = [
            new winston_1.transports.File({
                filename: path_1.default.resolve("logs/error.log"),
                level: "error",
                maxsize: 1024 * 1024,
                maxFiles: 1,
            }),
            new winston_1.transports.File({
                filename: path_1.default.resolve("logs/logger.log"),
                maxsize: 1024 * 1024,
                maxFiles: 1,
            }),
        ];
    }
    catch (error) {
        console.error("Failed to initialize log files. Logging to a file will be skipped.", error);
        pathOption = [];
    }
}
// 定义不同日志级别的彩色块
const levelColors = {
    error: chalk_1.default.bgRed(" ERROR "),
    warn: chalk_1.default.bgYellow(" WARN "),
    info: chalk_1.default.bgBlue(" INFO "),
    debug: chalk_1.default.bgGreen(" DEBUG "),
    default: chalk_1.default.bgWhite(" LOG "),
};
// 自定义控制台日志输出格式
const consoleFormat = winston_1.format.printf(({ level, message, timestamp, stack }) => {
    // 获取原始日志级别
    const originalLevel = Object.keys(levelColors).find((lvl) => level.includes(lvl)) || "default";
    const colorLevel = levelColors[originalLevel] || levelColors.default;
    let logMessage = `${colorLevel} [${timestamp}] ${message}`;
    if (stack) {
        logMessage += `\n${stack}`;
    }
    return logMessage;
});
// logger
const logger = (0, winston_1.createLogger)({
    // 最低的日志级别
    level: "info",
    // 定义日志的格式
    format: winston_1.format.combine(winston_1.format.timestamp({
        format: "YYYY-MM-DD HH:mm:ss",
    }), winston_1.format.errors({ stack: true }), winston_1.format.splat(), winston_1.format.json()),
    transports: pathOption,
});
// 控制台输出
if (process.env.NODE_ENV !== "production") {
    try {
        logger.add(new winston_1.transports.Console({
            format: winston_1.format.combine(winston_1.format.colorize(), consoleFormat),
        }));
    }
    catch (error) {
        console.error("Failed to add console transport. Console logging will be skipped.", error);
    }
}
exports.default = logger;

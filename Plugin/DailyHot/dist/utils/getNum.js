"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseChineseNumber = void 0;
const parseChineseNumber = (chineseNumber) => {
    // 单位对照表
    const units = {
        亿: 1e8,
        万: 1e4,
        千: 1e3,
        百: 1e2,
    };
    // 遍历单位对照表
    for (const unit in units) {
        if (chineseNumber.includes(unit)) {
            // 转换为数字
            const numberPart = parseFloat(chineseNumber.replace(unit, ""));
            return numberPart * units[unit];
        }
    }
    return parseFloat(chineseNumber);
};
exports.parseChineseNumber = parseChineseNumber;

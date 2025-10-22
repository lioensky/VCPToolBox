const fs = require('fs').promises;
const path = require('path');

/**
 * 从括号序列中解码出真实的验证码
 * @param {string} bracketSequence - 括号序列字符串
 * @returns {string} 解码后的6位数验证码
 */
function decodeFromBrackets(bracketSequence) {
    // 定义括号类型映射表（左右括号映射到同一个索引位置）
    const bracketTypeMap = {
        '[': 0, ']': 0,     // 第1位数字
        '{': 1, '}': 1,     // 第2位数字
        '<': 2, '>': 2,     // 第3位数字
        '（': 3, '）': 3,   // 第4位数字（全角括号）
        '《': 4, '》': 4,   // 第5位数字
        '【': 5, '】': 5    // 第6位数字
    };
    
    // 统计每种括号类型的数量（初始化为6个0）
    const counts = [0, 0, 0, 0, 0, 0];
    
    // 遍历括号序列，统计每种类型的数量
    for (const char of bracketSequence) {
        const typeIndex = bracketTypeMap[char];
        if (typeIndex !== undefined) {
            counts[typeIndex]++;
        }
    }
    
    // 将统计结果拼接成6位数字符串
    return counts.join('');
}

/**
 * 从 code.bin 文件中读取并解码验证码
 * @param {string} filePath - code.bin 文件路径（可选）
 * @returns {Promise<string>} 解码后的验证码
 */
async function getAuthCode(filePath = null) {
    try {
        const codePath = filePath || path.join(__dirname, 'code.bin');
        
        // 读取base64编码的内容
        const base64Encoded = await fs.readFile(codePath, 'utf-8');
        
        // base64解码得到原始括号序列
        const bracketSequence = Buffer.from(base64Encoded.trim(), 'base64').toString('utf-8');
        
        // 解码括号序列得到验证码
        const authCode = decodeFromBrackets(bracketSequence);
        
        return authCode;
        
    } catch (error) {
        console.error('读取或解码认证码失败:', error);
        return '';
    }
}

module.exports = {
    decodeFromBrackets,
    getAuthCode
};
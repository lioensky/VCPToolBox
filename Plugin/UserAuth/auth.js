const fs = require('fs').promises;
const path = require('path');

// 生成一个真实的、随机的6位验证码
function generateRealAuthCode() {
    const realCode = Math.floor(100000 + Math.random() * 900000);
    return String(realCode);
}

// 将验证码编码为括号序列
function encodeToBrackets(realCode) {
    // 定义6种括号类型，按顺序对应验证码的每一位数字
    const bracketTypes = [
        ['[', ']'],   // 第1位数字对应方括号
        ['{', '}'],   // 第2位数字对应花括号
        ['<', '>'],   // 第3位数字对应尖括号
        ['（', '）'], // 第4位数字对应全角小括号
        ['《', '》'], // 第5位数字对应书名号
        ['【', '】']  // 第6位数字对应全角方括号
    ];
    
    // 获取当前月份（1-12），计算右括号出现的概率
    const currentMonth = new Date().getMonth() + 1;
    const closeProbability = currentMonth / 12;
    
    let allBrackets = [];
    
    // 为验证码的每一位数字生成对应数量的括号
    for (let i = 0; i < realCode.length; i++) {
        const digit = parseInt(realCode[i], 10); // 0-9
        const [openBracket, closeBracket] = bracketTypes[i];
        
        // 生成 digit 个该类型的括号
        for (let j = 0; j < digit; j++) {
            // 根据月份概率决定是左括号还是右括号
            if (Math.random() < closeProbability) {
                allBrackets.push(closeBracket); // 右括号
            } else {
                allBrackets.push(openBracket);  // 左括号
            }
        }
    }
    
    // 随机打乱所有括号的顺序（Fisher-Yates洗牌算法）
    for (let i = allBrackets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allBrackets[i], allBrackets[j]] = [allBrackets[j], allBrackets[i]];
    }
    
    return allBrackets.join('');
}

async function main() {
    try {
        const realCode = generateRealAuthCode();
        const bracketSequence = encodeToBrackets(realCode);
        
        // 将括号序列转换为base64编码
        const base64Encoded = Buffer.from(bracketSequence, 'utf-8').toString('base64');
        
        // 保存到 code.bin 文件
        const filePath = path.join(__dirname, 'code.bin');
        await fs.writeFile(filePath, base64Encoded, 'utf-8');
        
        console.log('认证码已生成并保存到 code.bin');
        // console.log('真实验证码:', realCode); // 调试用，生产环境应删除
        
    } catch (error) {
        console.error('生成认证码失败:', error);
        process.exit(1);
    }
}

main();
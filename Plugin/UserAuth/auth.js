const fs = require('fs').promises;
const path = require('path');

// 生成一个真实的、随机的6位验证码
function generateRealAuthCode() {
    const realCode = Math.floor(100000 + Math.random() * 900000);
    return String(realCode);
}

// 对真实验证码进行简单的、可逆的“加密”
function encryptCode(realCode) {
    // 这是一个“密钥”，用于变换。
    const secretKey = '314159'; 
    let encryptedCode = '';
    for (let i = 0; i < realCode.length; i++) {
        const realDigit = parseInt(realCode[i], 10);
        const keyDigit = parseInt(secretKey[i], 10);
        const encryptedDigit = (realDigit + keyDigit) % 10;
        encryptedCode += encryptedDigit;
    }
    return encryptedCode;
}

async function main() {
    try {
        const realCode = generateRealAuthCode();
        const encryptedCode = encryptCode(realCode);

        // 将“加密”后的验证码保存到文件，并打印到控制台
        const filePath = path.join(__dirname, 'auth_code.txt');
        await fs.writeFile(filePath, encryptedCode, 'utf-8');
        
        // 打印加密后的代码，供静态占位符系统使用
        console.log(encryptedCode);

    } catch (error) {
        console.error('生成认证码失败:', error);
        process.exit(1); // 以错误码退出，表示失败
    }
}

main();
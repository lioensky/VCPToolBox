/**
 * XHS 签名脚本 - 通过 stdin 接收参数，stdout 返回签名结果
 * 调用方式: node sign_server.js
 * stdin: {"url": "/api/...", "data": {...}, "a1": "...", "web_session": "..."}
 * stdout: {"x-s": "...", "x-t": "...", "x-s-common": ""}
 */
const crypto = require('crypto');

function md5(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function b64encode(str) {
    return Buffer.from(str).toString('base64');
}

function getXs(url, data, a1, webSession) {
    const t = Date.now();
    const xt = t.toString();

    // 构造签名原文
    const dataStr = data ? JSON.stringify(data) : '';
    const payload = url + dataStr + xt + (a1 || '');

    // 生成 x-s（简化版，基于 md5+base64）
    const xs = b64encode(md5(payload));

    // x-s-common 基础结构（包含设备指纹基本字段）
    const commonObj = {
        s0: 5,
        s1: '',
        x0: '1',
        x1: '3.6.8',
        x2: 'Windows',
        x3: 'xhs-pc-web',
        x4: '4.27.2',
        x5: a1 || '',
        x6: t,
        x7: xs,
        x8: '',
        x9: md5('3.6.8' + t + xs),
        x10: 1
    };
    const xsCommon = b64encode(JSON.stringify(commonObj));

    return {
        'x-s': xs,
        'x-t': xt,
        'x-s-common': xsCommon
    };
}

// 读取 stdin
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', () => {
    try {
        const params = JSON.parse(inputData);
        const result = getXs(
            params.url || '',
            params.data || null,
            params.a1 || '',
            params.web_session || ''
        );
        process.stdout.write(JSON.stringify(result) + '\n');
    } catch (e) {
        process.stdout.write(JSON.stringify({'error': e.message}) + '\n');
    }
});
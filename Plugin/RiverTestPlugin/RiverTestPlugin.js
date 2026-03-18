const fs = require('fs');
const path = require('path');

// 从 STDIN 读取参数
let argsString = '';
try {
    // 某些环境 fs.readFileSync(0) 可能表现异常，尝试使用更稳妥的同步读取逻辑
    argsString = fs.readFileSync(process.stdin.fd, 'utf-8');
} catch (e) {
    // 处理读取失败
}

let args = {};
if (argsString) {
    try {
        args = JSON.parse(argsString);
    } catch (e) {
        // 解析失败
    }
}

const riverContext = args.river_context;
let report = "RiverTestPlugin executed. ";

if (riverContext && Array.isArray(riverContext)) {
    report += `Received river_context with ${riverContext.length} messages. `;
    
    // 创建 river 文件夹（如果不存在）
    const riverDir = path.join(__dirname, 'river');
    if (!fs.existsSync(riverDir)) {
        try {
            fs.mkdirSync(riverDir, { recursive: true });
        } catch (e) {
            report += `Failed to create directory: ${e.message}. `;
        }
    }
    
    // 持久化到文件，使用时间戳命名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `context-${timestamp}.json`;
    const filePath = path.join(riverDir, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(riverContext, null, 2), 'utf8');
        report += `Context persisted to ${fileName}. `;
    } catch (err) {
        report += `Failed to persist context: ${err.message}. `;
    }
} else {
    report += "No river_context received or it is not an array. ";
    // 如果没有收到上下文，记录一下收到的所有参数以便调试
    report += `Received args keys: ${Object.keys(args).join(', ')}. `;
}

const result = {
    status: 'success',
    result: JSON.stringify({
        content: [{ type: 'text', text: report }],
        details: {
            river_context_received: !!riverContext,
            messages_count: (riverContext && Array.isArray(riverContext)) ? riverContext.length : 0,
            received_keys: Object.keys(args)
        }
    })
};

// PluginManager 期待标准输出是一个 JSON 字符串
console.log(JSON.stringify(result));

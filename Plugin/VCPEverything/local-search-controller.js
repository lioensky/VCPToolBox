const http = require('http'); // 核心变更：使用Node.js内置的http模块
const fs = require('fs');
const path = require('path');

// 仅加载插件自身的.env配置
require('dotenv').config({ path: path.join(__dirname, '.env') });

// --- 配置 ---
// 新增：Everything HTTP服务器的端口配置
const EVERYTHING_PORT = parseInt(process.env.EVERYTHING_PORT || '8025');
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// --- 工具函数 ---
function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        const timestamp = new Date().toISOString();
        console.error(`[DEBUG ${timestamp}] ${message}`);
        if (data) {
            console.error(JSON.stringify(data, null, 2));
        }
    }
}

// --- 核心功能 ---
/**
 * 通过Everything的HTTP服务器执行搜索。
 * [最终版] 这是最稳定、最可靠的官方推荐方式。
 * @param {string} query - 搜索查询字符串。
 * @param {number} maxResults - 返回的最大结果数量。
 * @returns {Promise<object>} - 返回一个包含搜索结果的完整对象。
 */
function searchWithEverythingHTTP(query, maxResults = 100) {
    return new Promise((resolve, reject) => {
        // 构建请求URL：
        // ?s=...       - 设置搜索词
        // &json=1      - 关键！让服务器返回JSON格式的数据
        // &path_column=1 - 请求包含完整路径列
        // &n=...       - 设置最大结果数
        const encodedQuery = encodeURIComponent(query);
        const requestPath = `/?s=${encodedQuery}&json=1&path_column=1&n=${maxResults}`;
        
        const options = {
            hostname: '127.0.0.1', // 只在本地访问
            port: EVERYTHING_PORT,
            path: requestPath,
            method: 'GET'
        };

        debugLog('Making HTTP request to Everything server', options);

        const req = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Everything HTTP server responded with status code: ${res.statusCode}`));
            }

            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                rawData += chunk;
            });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(rawData);
                    debugLog('Successfully received and parsed JSON response from Everything');
                    resolve(parsedData); // 直接返回解析后的JSON对象
                } catch (e) {
                    reject(new Error(`Failed to parse JSON response from Everything: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => {
            debugLog('HTTP request to Everything failed', { error: e.message });
            if (e.code === 'ECONNREFUSED') {
                reject(new Error(`Connection to Everything HTTP server refused on port ${EVERYTHING_PORT}. Please ensure Everything is running and the HTTP server is enabled in Tools -> Options.`));
            } else {
                reject(new Error(`HTTP request error: ${e.message}`));
            }
        });

        req.end();
    });
}

/**
 * 主处理函数 - 插件的“大脑”
 * @param {object} request - VCP框架传递过来的、已经解析好的JSON对象
 */
async function processRequest(request) {
    const { query, maxResults } = request;

    if (!query) {
        return {
            status: 'error',
            error: 'Missing required parameter: query',
        };
    }

    try {
        // 直接使用AI给出的原始查询，无需任何特殊处理
        const everythingResponse = await searchWithEverythingHTTP(query, maxResults);
        
        // 从返回的JSON中提取我们需要的路径列表
        const filePaths = everythingResponse.results.map(item => path.join(item.path, item.name));

        return {
            status: 'success',
            result: {
                searchQuery: query,
                resultCount: everythingResponse.totalResults, // 使用服务器返回的总结果数
                results: filePaths, // 将干净的文件路径列表返回给AI
            },
        };
    } catch (error) {
        return {
            status: 'error',
            error: error.message,
        };
    }
}


// --- stdio 通信 ---
let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', async () => {
    if (!inputBuffer.trim()) {
        console.log(JSON.stringify({ status: 'error', error: 'No input received.' }));
        return;
    }
    debugLog('Received raw input from VCP', inputBuffer);
    try {
        const request = JSON.parse(inputBuffer);
        const response = await processRequest(request);
        console.log(JSON.stringify(response));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: `Invalid JSON input: ${error.message}` }));
    }
});

debugLog('VCPEverything (HTTP Mode) plugin started and ready.');

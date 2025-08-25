const readline = require('readline');
const fs = require('fs');
const path = require('path');

// 随机获取一个API密钥
function getRandomApiKey() {
    const apiKeys = process.env.SerpApi;
    if (!apiKeys) {
        throw new Error("SerpApi environment variable not found. Please check your config.env file.");
    }
    const keyArray = apiKeys.split(',').map(key => key.trim()).filter(key => key);
    if (keyArray.length === 0) {
        throw new Error("No SerpApi keys found in the environment variable.");
    }
    const randomIndex = Math.floor(Math.random() * keyArray.length);
    return keyArray[randomIndex];
}

// 主处理函数
async function processRequest(request) {
    const { command, ...parameters } = request;
    const engineName = command.replace('_search', ''); // e.g., "bing_search" -> "bing", "google_scholar_search" -> "google_scholar"

    // 动态加载并执行相应的搜索引擎模块
    const enginePath = path.join(__dirname, 'engines', `${engineName}.js`);
    
    if (fs.existsSync(enginePath)) {
        try {
            const engineModule = require(enginePath);
            const apiKey = getRandomApiKey();
            return await engineModule.search(parameters, apiKey);
        } catch (error) {
            return { success: false, error: `Error executing engine module '${engineName}': ${error.message}` };
        }
    } else {
         return { success: false, error: `Unknown search engine: ${engineName}` };
    }
}

// 从 stdin 读取输入
function readInput() {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });

        let input = '';
        rl.on('line', (line) => {
            input += line;
        });

        rl.on('close', () => {
            // Handle empty input
            if (!input) {
                // Resolving with an empty object or a specific signal
                // so the main function can handle it gracefully.
                resolve({});
                return;
            }
            try {
                const parsedInput = JSON.parse(input);
                resolve(parsedInput);
            } catch (error) {
                reject(new Error(`Failed to parse stdin JSON: ${input}`));
            }
        });
    });
}

// 主函数
async function main() {
    try {
        const request = await readInput();
        // check if request is empty
        if (Object.keys(request).length === 0) {
            console.log(JSON.stringify({ status: "error", error: "No input received from stdin." }));
            process.exit(1);
            return;
        }

        const result = await processRequest(request);

        if (result.success) {
            console.log(JSON.stringify({ status: "success", result: result.data }));
        } else {
            console.log(JSON.stringify({ status: "error", error: result.error }));
        }
        process.exit(0);

    } catch (error) {
        console.log(JSON.stringify({ status: "error", error: error.message }));
        process.exit(1);
    }
}

main();
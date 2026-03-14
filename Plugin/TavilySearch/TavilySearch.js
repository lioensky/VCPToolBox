#!/usr/bin/env node
const { tavily } = require('@tavily/core'); // Using the official Node.js client
const stdin = require('process').stdin;

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        let output = {};

        try {
            if (!inputData.trim()) {
                throw new Error("No input data received from stdin.");
            }

            const data = JSON.parse(inputData);

            const query = data.query;
            const topic = data.topic || 'general'; // Default to 'general'
            const searchDepth = data.search_depth || 'basic'; // Default to 'basic'
            let maxResults = data.max_results || 10; // Default to 10
            const includeRawContent = data.include_raw_content;
            const country = data.country?.trim().toLowerCase(); // 新增国家来源参数
            const startDate = data.start_date;
            const endDate = data.end_date;
            const time_range = data.time_range;

            if (!query) {
                throw new Error("Missing required argument: query");
            }

            // Validate max_results
            try {
                maxResults = parseInt(maxResults, 10);
                if (isNaN(maxResults) || maxResults < 5 || maxResults > 100) {
                    maxResults = 10; // Default to 10 if invalid or out of range
                }
            } catch (e) {
                maxResults = 10; // Default if parsing fails
            }

            let apiKey = process.env.TavilyKey; // Use the correct environment variable name
            if (!apiKey) {
                throw new Error("TavilyKey environment variable not set.");
            }

            // Check if the key is a comma-separated list
            if (apiKey.includes(',')) {
                const keys = apiKey.split(',').map(key => key.trim()).filter(key => key);
                if (keys.length > 0) {
                    // Select a random key from the array
                    apiKey = keys[Math.floor(Math.random() * keys.length)];
                } else {
                    throw new Error("TavilyKey environment variable is empty or contains only commas.");
                }
            }

            const tvly = tavily({ apiKey });

            const searchOptions = {
                search_depth: searchDepth,
                topic: topic,
                max_results: maxResults,
                include_answer: false, // Usually just want results for AI processing
                include_images: true,
                include_image_descriptions: true,
            };

            if (includeRawContent === "text" || includeRawContent === "markdown") {
                searchOptions.include_raw_content = includeRawContent;
            }

            if (country) {
                // https://docs.tavily.com/documentation/api-reference/endpoint/search#body-country
                // 确保只传递非空字符串
                const validCountry = [
                    'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia', 'austria',
                    'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin',
                    'bhutan', 'bolivia', 'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria', 'burkina faso',
                    'burundi', 'cambodia', 'cameroon', 'canada', 'cape verde', 'central african republic', 'chad', 'chile',
                    'china', 'colombia', 'comoros', 'congo', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czech republic',
                    'denmark', 'djibouti', 'dominican republic', 'ecuador', 'egypt', 'el salvador', 'equatorial guinea', 'eritrea',
                    'estonia', 'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia', 'germany', 'ghana', 'greece',
                    'guatemala', 'guinea', 'haiti', 'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq',
                    'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya', 'kuwait', 'kyrgyzstan',
                    'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania', 'luxembourg', 'madagascar',
                    'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco',
                    'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands', 'new zealand',
                    'nicaragua', 'niger', 'nigeria', 'north korea', 'north macedonia', 'norway', 'oman', 'pakistan', 'panama',
                    'papua new guinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia',
                    'rwanda', 'saudi arabia', 'senegal', 'serbia', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa',
                    'south korea', 'south sudan', 'spain', 'sri lanka', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan',
                    'tajikistan', 'tanzania', 'thailand', 'togo', 'trinidad and tobago', 'tunisia', 'turkey', 'turkmenistan',
                    'uganda', 'ukraine', 'united arab emirates', 'united kingdom', 'united states', 'uruguay', 'uzbekistan',
                    'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe'
                ];
                if (validCountry.includes(country)) {
                    searchOptions.country = country;
                }
            }

            // 检查日期参数，确保它们存在且非空，以避免潜在的 API 错误
            // 根据错误日志，当 start_date 或 end_date 存在时，Tavily API 不允许同时设置 time_range 参数。
            // @tavily/core 库可能存在默认设置 time_range 的行为，因此在这里显式地将其设为 null 来避免冲突。
            // 优先处理 start_date 和 end_date。如果它们存在，则忽略 time_range 参数以避免冲突。
            if (startDate || endDate) {
                if (startDate && startDate.trim()) {
                    searchOptions.start_date = startDate.trim();
                }
                if (endDate && endDate.trim()) {
                    searchOptions.end_date = endDate.trim();
                }
                searchOptions.time_range = null; // 显式覆盖任何默认或传入的 time_range 值
            } else if (time_range) {
                // 仅在没有日期范围时才使用 time_range 参数
                const validTimeRanges = ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'];
                if (validTimeRanges.includes(time_range)) {
                    searchOptions.time_range = time_range;
                }
            }

            const response = await tvly.search(query, searchOptions);

            // 将 Tavily 搜索结果转换为 Markdown 格式
            let markdownResult = '';
            if (response.answer) {
                markdownResult += `### 直接回答\n${response.answer}\n\n`;
            }

            if (response.results && response.results.length > 0) {
                markdownResult += `### 搜索结果\n`;
                response.results.forEach((item, index) => {
                    markdownResult += `${index + 1}. **[${item.title}](${item.url})**\n`;
                    if (item.content) {
                        markdownResult += `   ${item.content}\n\n`;
                    }
                });
            } else {
                markdownResult += `未找到相关搜索结果。\n`;
            }

            output = { status: "success", result: markdownResult };

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = "Invalid JSON input.";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "An unknown error occurred.";
            }
            output = { status: "error", error: `Tavily Search Error: ${errorMessage}` };
        }

        // Output JSON to stdout
        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

main().catch(error => {
    // Catch any unhandled promise rejections from main
    process.stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error: ${error.message || error}` }));
    process.exit(1); // Indicate failure
});
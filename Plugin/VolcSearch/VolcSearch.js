#!/usr/bin/env node
const https = require('https');
const stdin = require('process').stdin;

const API_ENDPOINT = 'open.feedcoopapi.com';
const API_PATH = '/search_api/web_search';
const STAGGER_INTERVAL_MS = 1000; // 并发搜索时每个子查询的启动间隔(ms)，用于控制 QPS
const MAX_CONCURRENCY = 5; // 最大并发请求数（VolcEngine 默认 QPS 5，留有余量避免限流）

/**
 * 简单信号量（Semaphore），用于控制最大并发数
 * acquire() 获取一个许可，release() 释放一个许可
 * 当并发数达到上限时，acquire() 会自动等待
 */
class Semaphore {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        if (this.queue.length > 0) {
            this.queue.shift()();
        } else {
            this.current--;
        }
    }
}

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
            let searchType = data.search_type || 'web';
            let count = data.count || 10;
            const needSummary = data.need_summary;
            const contentFormat = data.content_format || 'text';
            const snippetsOnly = data.snippets_only !== false; // default true
            const timeRange = data.time_range;
            const sites = data.sites;
            const blockHosts = data.block_hosts;
            const industry = data.industry;
            const queryRewrite = data.query_rewrite;
            const needUrl = data.need_url;
            const authInfoLevel = data.auth_info_level;

            if (!query) {
                throw new Error("Missing required argument: query");
            }

            // Validate count
            try {
                count = parseInt(count, 10);
                if (isNaN(count) || count < 1 || count > 50) {
                    count = 10;
                }
            } catch (e) {
                count = 10;
            }

            let apiKey = process.env.VolcAccessKey;
            if (!apiKey) {
                throw new Error("VolcAccessKey environment variable not set.");
            }

            // Support comma-separated keys for load balancing
            if (apiKey.includes(',')) {
                const keys = apiKey.split(',').map(key => key.trim()).filter(key => key);
                if (keys.length > 0) {
                    apiKey = keys[Math.floor(Math.random() * keys.length)];
                } else {
                    throw new Error("VolcAccessKey environment variable is empty or contains only commas.");
                }
            }

            // Validate search_type
            const validSearchTypes = ['web', 'web_summary'];
            if (!validSearchTypes.includes(searchType)) {
                searchType = 'web';
            }

            // Build request body per Volc Engine API spec
            // 搜索逻辑已封装到 executeSingleSearch(subQuery) 中

            /**
             * 执行单次搜索并返回 Markdown 结果
             */
            async function executeSingleSearch(subQuery) {
                const body = {
                    Query: subQuery,
                    SearchType: searchType,
                    Count: count
                };

                // NeedSummary: automatically true for web_summary, otherwise optional
                if (searchType === 'web_summary') {
                    body.NeedSummary = true;
                } else if (needSummary === true || needSummary === 'true') {
                    body.NeedSummary = true;
                }

                // Optional: ContentFormats
                if (contentFormat === 'markdown' || contentFormat === 'text') {
                    body.ContentFormats = contentFormat;
                }

                // Optional: Filter
                const filter = {};
                let hasFilter = false;

                if (!snippetsOnly) {
                    filter.NeedContent = true;
                    hasFilter = true;
                }
                if (sites) {
                    filter.Sites = sites;
                    hasFilter = true;
                }
                if (blockHosts) {
                    filter.BlockHosts = blockHosts;
                    hasFilter = true;
                }
                if (needUrl === true || needUrl === 'true') {
                    filter.NeedUrl = true;
                    hasFilter = true;
                }
                if (authInfoLevel !== undefined && authInfoLevel !== null) {
                    const level = parseInt(authInfoLevel, 10);
                    if (level === 0 || level === 1) {
                        filter.AuthInfoLevel = level;
                        hasFilter = true;
                    }
                }
                if (hasFilter) {
                    body.Filter = filter;
                }

                // Optional: TimeRange
                if (timeRange) {
                    const validTimeRanges = ['OneDay', 'OneWeek', 'OneMonth', 'OneYear'];
                    const dateRangePattern = /^\d{4}-\d{2}-\d{2}\.\d{4}-\d{2}-\d{2}$/;
                    if (validTimeRanges.includes(timeRange) || dateRangePattern.test(timeRange)) {
                        body.TimeRange = timeRange;
                    }
                }

                // Optional: Industry
                if (industry) {
                    const validIndustries = ['finance', 'game'];
                    if (validIndustries.includes(industry)) {
                        body.Industry = industry;
                    }
                }

                // Optional: QueryControl.QueryRewrite
                if (queryRewrite === true || queryRewrite === 'true') {
                    body.QueryControl = { QueryRewrite: true };
                }

                // Send request to Volc Engine API
                const response = await sendApiRequest(apiKey, body);

                // Parse response - handles both single JSON and SSE streaming format
                let resultData;
                try {
                    resultData = JSON.parse(response);
                } catch (e) {
                    // Try SSE/streaming format: multiple JSON objects separated by newlines
                    const lines = response.split('\n')
                        .map(line => line.replace(/^data:\s*/, '').trim())
                        .filter(line => line && line !== '[DONE]' && line.startsWith('{'));

                    if (lines.length === 0) {
                        throw new Error(`Failed to parse API response: ${e.message}`);
                    }

                    let aggregatedResponse = null;
                    for (const line of lines) {
                        try {
                            const frameData = JSON.parse(line);
                            if (!frameData.Result) continue;

                            if (!aggregatedResponse) {
                                aggregatedResponse = frameData;
                            } else {
                                // Accumulate Choices delta content from streaming frames
                                const frameResult = frameData.Result;
                                if (frameResult.Choices && frameResult.Choices.length > 0) {
                                    const streamChoice = frameResult.Choices[0];
                                    if (streamChoice.Delta && streamChoice.Delta.Content) {
                                        if (!aggregatedResponse.Result.Choices) {
                                            aggregatedResponse.Result.Choices = [{
                                                Message: { content: '' },
                                                FinishReason: '',
                                                Index: 0
                                            }];
                                        }
                                        const aggChoice = aggregatedResponse.Result.Choices[0];
                                        if (aggChoice.Message) {
                                            aggChoice.Message.content = (aggChoice.Message.content || '') + streamChoice.Delta.Content;
                                        }
                                    }
                                    // Capture FinishReason from final frame
                                    if (streamChoice.FinishReason) {
                                        if (!aggregatedResponse.Result.Choices[0]) {
                                            aggregatedResponse.Result.Choices[0] = {};
                                        }
                                        aggregatedResponse.Result.Choices[0].FinishReason = streamChoice.FinishReason;
                                    }
                                }
                                // Capture Usage from final frame
                                if (frameResult.Usage) {
                                    aggregatedResponse.Result.Usage = frameResult.Usage;
                                }
                            }
                        } catch (parseError) {
                            // Skip malformed frames
                        }
                    }

                    if (aggregatedResponse) {
                        resultData = aggregatedResponse;
                    } else {
                        throw new Error('Failed to parse API response: streaming format not recognized');
                    }
                }

                // Check for API-level errors
                const responseMeta = resultData.ResponseMetadata;
                if (responseMeta && responseMeta.Error) {
                    const apiError = responseMeta.Error;
                    throw new Error(`Volc Engine API Error [${apiError.Code}]: ${apiError.Message}`);
                }

                const apiResult = resultData.Result;
                if (!apiResult) {
                    throw new Error("API response missing Result field.");
                }

                // Convert results to Markdown
                let md = '';

                // For web_summary mode, extract LLM summary from Choices
                if (searchType === 'web_summary' && apiResult.Choices && apiResult.Choices.length > 0) {
                    const choice = apiResult.Choices[0];
                    let summaryText = '';

                    // Non-streaming mode: Message.content (or already aggregated from streaming)
                    if (choice.Message && choice.Message.content) {
                        summaryText = choice.Message.content;
                    }
                    // Fallback: raw Delta.content (if streaming aggregation didn't run)
                    if (!summaryText && choice.Delta && choice.Delta.Content) {
                        summaryText = choice.Delta.Content;
                    }

                    if (summaryText) {
                        md += `### 搜索总结\n${summaryText}\n\n---\n\n`;
                    }
                }

                if (apiResult.WebResults && apiResult.WebResults.length > 0) {
                    md += `### 搜索结果 (共 ${apiResult.ResultCount || apiResult.WebResults.length} 条)\n\n`;
                    apiResult.WebResults.forEach((item, index) => {
                        const title = item.Title || '无标题';
                        const url = item.Url || '';
                        const snippet = item.Snippet || '';
                        const summary = item.Summary || '';
                        const content = item.Content || '';
                        const publishTime = item.PublishTime || '';
                        const siteName = item.SiteName || '';
                        const authInfo = item.AuthInfoDes || '';

                        md += `${index + 1}. **[${title}](${url})**\n`;

                        if (siteName) {
                            md += `   - **来源**: ${siteName}`;
                            if (publishTime && publishTime !== '1970-01-01T08:00:00+08:00') {
                                const date = new Date(publishTime);
                                if (!isNaN(date.getTime())) {
                                    md += ` | **时间**: ${date.toLocaleDateString('zh-CN')}`;
                                }
                            }
                            if (authInfo) {
                                md += ` | **权威度**: ${authInfo}`;
                            }
                            md += '\n';
                        }

                        // Prefer Summary over Snippet if needSummary is enabled
                        if (needSummary && summary) {
                            md += `   ${summary}\n\n`;
                        } else if (snippet) {
                            md += `   ${snippet}\n\n`;
                        }

                        // Include full content if snippets_only is false
                        if (!snippetsOnly && content) {
                            const trimmedContent = content.length > 2000 ? content.substring(0, 2000) + '...' : content;
                            md += `   > ${trimmedContent.replace(/\n/g, '\n   > ')}\n\n`;
                        }
                    });
                } else {
                    md += '未找到相关搜索结果。\n';
                }

                return md;
            }

            // 检测是否包含 || 分隔的多个查询
            const subQueries = query.split('||').map(q => q.trim()).filter(q => q.length > 0);

            if (subQueries.length === 0) {
                throw new Error("No valid search query after splitting by '||'");
            }

            if (subQueries.length > 1) {
                // 多个子查询 => 并发搜索，双重保护：
                // 1) STAGGER_INTERVAL_MS 控制启动间隔，平滑 QPS
                // 2) Semaphore 控制最大并发数，防止突发限流
                // 设置 STAGGER_INTERVAL_MS = 0 可关闭启动间隔
                const sem = new Semaphore(MAX_CONCURRENCY);
                const searchPromises = subQueries.map(async (subQuery, index) => {
                    if (STAGGER_INTERVAL_MS > 0) {
                        await new Promise(resolve => setTimeout(resolve, index * STAGGER_INTERVAL_MS));
                    }
                    await sem.acquire();
                    try {
                        const result = await executeSingleSearch(subQuery);
                        return { subQuery, result };
                    } finally {
                        sem.release();
                    }
                });

                const settledResults = await Promise.allSettled(searchPromises);

                let markdownResult = '';
                const failedResults = [];
                let hasAnySuccess = false;

                settledResults.forEach((settled, index) => {
                    if (settled.status === 'fulfilled') {
                        hasAnySuccess = true;
                        markdownResult += `## 🔍 查询: ${settled.value.subQuery}\n\n`;
                        markdownResult += settled.value.result;
                        markdownResult += '\n\n---\n\n';
                    } else {
                        failedResults.push({ subQuery: subQueries[index], error: settled.reason?.message || '未知错误' });
                    }
                });

                // 补充失败查询信息
                if (failedResults.length > 0) {
                    markdownResult += `## ⚠️ 以下查询失败\n\n`;
                    for (const fail of failedResults) {
                        markdownResult += `### 查询: ${fail.subQuery}\n`;
                        markdownResult += `错误: ${fail.error}\n\n`;
                    }
                }

                if (!hasAnySuccess && failedResults.length > 0) {
                    throw new Error(`All searches failed. First error: ${failedResults[0].error}`);
                }

                output = { status: "success", result: markdownResult };

            } else {
                // 单个查询 => 原有流程
                const singleResult = await executeSingleSearch(query);
                output = { status: "success", result: singleResult };
            }

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = "Invalid JSON input.";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "An unknown error occurred.";
            }
            output = { status: "error", error: `VolcSearch Error: ${errorMessage}` };
        }

        // Output JSON to stdout
        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

function sendApiRequest(apiKey, requestBody) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(requestBody);

        const options = {
            hostname: API_ENDPOINT,
            path: API_PATH,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 25000
        };

        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(responseData);
                } else {
                    let errorMsg = `HTTP ${res.statusCode}`;
                    try {
                        const errData = JSON.parse(responseData);
                        if (errData.ResponseMetadata?.Error?.Message) {
                            errorMsg += `: ${errData.ResponseMetadata.Error.Message}`;
                        }
                    } catch (e) {
                        // Use status code only if response is not valid JSON
                        if (responseData.trim()) {
                            errorMsg += `: ${responseData.substring(0, 200)}`;
                        }
                    }
                    reject(new Error(errorMsg));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Network error: ${e.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out.'));
        });

        req.write(body);
        req.end();
    });
}

main().catch(error => {
    process.stdout.write(JSON.stringify({
        status: "error",
        error: `Unhandled Plugin Error: ${error.message || error}`
    }));
    process.exit(1);
});

const fetch = require('node-fetch');
const config = require('./config'); // 引入配置文件

class VCPClient {
    constructor(serverUrl, apiKey) {
        if (!serverUrl) {
            throw new Error('VCP Server URL is required.');
        }
        this.serverUrl = serverUrl;
        this.apiKey = apiKey;
        this.apiUrl = `${this.serverUrl}${config.VCP_API_ENDPOINT}`; // 使用配置
    }

    /**
     * 向主 VCP 服务器发送请求，可以用于获取 LLM 响应或执行工具。
     * @param {Array<object>} messages - VCP 格式的消息数组。
     * @param {string} model - 要使用的模型名称。
     * @param {boolean} stream - 是否使用流式响应。
     * @returns {Promise<object|string>} - 返回非流式响应的 JSON 对象或流式响应的文本。
     */
    async sendRequest(messages, model = 'default', stream = false) {
        const body = {
            model,
            messages,
            stream,
        };

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[VCPClient] Error from VCP Server: ${response.status} ${errorText}`);
                throw new Error(`VCP Server returned an error: ${response.status}`);
            }

            if (stream) {
                 console.warn("[VCPClient] Stream mode is not fully implemented in this example.");
                 return response.text();
            }

            const jsonResponse = await response.json();
            
            if (jsonResponse.choices && jsonResponse.choices && jsonResponse.choices.message) {
                return jsonResponse.choices.message.content;
            }

            return jsonResponse;

        } catch (error) {
            console.error('[VCPClient] Failed to send request to VCP Server:', error);
            throw error;
        }
    }
}

module.exports = VCPClient;
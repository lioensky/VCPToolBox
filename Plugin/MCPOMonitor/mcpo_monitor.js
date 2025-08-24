// Plugin/MCPOMonitor/mcpo_monitor.js
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const dotenv = require('dotenv');

// 加载主配置和插件特定配置
dotenv.config({ path: path.resolve(__dirname, '../../config.env') });
dotenv.config({ path: path.join(__dirname, 'config.env') });

// 缓存文件路径
const CACHE_FILE_PATH = path.join(__dirname, 'mcpo_status_cache.txt');
const JSON_CACHE_FILE_PATH = path.join(__dirname, 'mcpo_status_cache.json');

class MCPOMonitor {
    constructor() {
        this.config = this._loadConfig();
        this.headers = {
            'Authorization': `Bearer ${this.config.MCPO_API_KEY}`,
            'Content-Type': 'application/json',
            'User-Agent': 'VCP-MCPOMonitor/1.0.0'
        };
        
        this.debugMode = (process.env.DebugMode || "false").toLowerCase() === "true";
        this.quickCheck = false; // 快速检查模式标志
    }

    async _quickServerCheck() {
        try {
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(`${this.config.MCPO_HOST}/openapi.json`, {
                timeout: 3000, // 3秒快速检查
                headers: this.headers
            });
            return response.ok;
        } catch (error) {
            this._log('warn', 'Quick server check failed', { error: error.message });
            return false;
        }
    }

    _loadConfig() {
        // 首先尝试加载MCPO插件的配置，实现端口共享
        const dotenv = require('dotenv');
        
        // 加载主配置和当前插件配置
        dotenv.config({ path: path.resolve(__dirname, '../../config.env') });
        dotenv.config({ path: path.join(__dirname, 'config.env') });
        
        // 尝试加载MCPO插件的配置
        const mcpoConfigPath = path.join(__dirname, '../MCPO/config.env');
        if (require('fs').existsSync(mcpoConfigPath)) {
            dotenv.config({ path: mcpoConfigPath });
        }
        
        // 获取端口配置（优先级：MCPOMonitor具体配置 > MCPO插件配置 > 默认值）
        const mcpoPort = process.env.MCPO_PORT || '8000';
        const mcpoHost = process.env.MCPO_HOST;
        
        // 如果指定了完整的HOST URL，解析并更新端口；否则根据端口构造
        let finalMcpoHost;
        let actualPort = parseInt(mcpoPort, 10);
        
        if (mcpoHost && mcpoHost.startsWith('http')) {
            try {
                const url = new URL(mcpoHost);
                // 如果环境变量MCPO_PORT被单独设置，优先使用它
                if (process.env.MCPO_PORT && process.env.MCPO_PORT !== '8000') {
                    actualPort = parseInt(process.env.MCPO_PORT, 10);
                    finalMcpoHost = `${url.protocol}//${url.hostname}:${actualPort}`;
                } else {
                    // 使用URL中的端口
                    actualPort = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
                    finalMcpoHost = mcpoHost;
                }
            } catch (e) {
                // URL解析失败，使用默认构造
                finalMcpoHost = `http://0.0.0.0:${actualPort}`;
            }
        } else {
            finalMcpoHost = `http://0.0.0.0:${actualPort}`;
        }
        
        return {
            MCPO_HOST: finalMcpoHost,
            MCPO_PORT: actualPort, // 使用实际解析的端口
            MCPO_API_KEY: process.env.MCPO_API_KEY || 'vcp-mcpo-secret',
            ENABLE_CACHE: (process.env.ENABLE_CACHE || 'true').toLowerCase() === 'true',
            CACHE_TTL_MINUTES: parseInt(process.env.CACHE_TTL_MINUTES || '2', 10),
            INCLUDE_DETAILED_PARAMS: (process.env.INCLUDE_DETAILED_PARAMS || 'true').toLowerCase() === 'true',
            HEALTH_CHECK_TIMEOUT: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000', 10),
            REFRESH_INTERVAL_CRON: process.env.REFRESH_INTERVAL_CRON || '*/10 * * * * *'
        };
    }

    // 获取动态的刷新间隔配置
    static getRefreshIntervalCron() {
        // 加载配置文件
        const dotenv = require('dotenv');
        dotenv.config({ path: path.resolve(__dirname, '../../config.env') });
        dotenv.config({ path: path.join(__dirname, 'config.env') });
        
        return process.env.REFRESH_INTERVAL_CRON || '*/10 * * * * *';
    }

    _log(level, message, data = null) {
        if (this.debugMode) {
            const timestamp = new Date().toISOString();
            const prefix = `[${timestamp}] [MCPOMonitor] [${level.toUpperCase()}]`;
            if (data) {
                console.error(`${prefix} ${message}`, JSON.stringify(data, null, 2));
            } else {
                console.error(`${prefix} ${message}`);
            }
        }
    }

    async _makeRequest(endpoint, options = {}) {
        const { default: fetch } = await import('node-fetch');
        const url = `${this.config.MCPO_HOST}${endpoint}`;
        const requestOptions = {
            timeout: this.config.HEALTH_CHECK_TIMEOUT,
            headers: this.headers,
            ...options
        };

        this._log('debug', `Making request to: ${url}`, requestOptions);

        try {
            const response = await fetch(url, requestOptions);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this._log('debug', `Response received from ${endpoint}`, data);
            return { success: true, data, status: response.status };

        } catch (error) {
            this._log('error', `Request failed for ${endpoint}`, { error: error.message });
            return { success: false, error: error.message };
        }
    }

    async _checkServerHealth() {
        this._log('info', 'Checking MCPO server health...');
        
        const healthChecks = [
            { name: 'OpenAPI文档', endpoint: '/openapi.json', expectJson: true },
            { name: 'Swagger UI', endpoint: '/docs', expectJson: false }
        ];

        const results = {
            serverRunning: false,
            serverVersion: null,
            healthChecks: {},
            availableServices: [],
            lastChecked: new Date().toISOString()
        };

        // 主健康检查
        try {
            const healthResult = await this._makeRequest('/openapi.json');
            if (healthResult.success) {
                results.serverRunning = true;
                results.serverVersion = healthResult.data.info?.version || '未知';
                
                // 解析可用服务
                const description = healthResult.data.info?.description || '';
                const servicePattern = /\[([^\]]+)\]\(\/([^/\)]+)\/docs\)/g;
                let match;
                while ((match = servicePattern.exec(description)) !== null) {
                    results.availableServices.push({
                        name: match[1],
                        path: match[2],
                        docsUrl: `/${match[2]}/docs`,
                        status: '检测中...'
                    });
                }
                
                this._log('info', `Server health check passed. Found ${results.availableServices.length} services`);
            }
        } catch (error) {
            this._log('error', 'Server health check failed', { error: error.message });
        }

        // 检查各个端点
        for (const check of healthChecks) {
            try {
                if (check.expectJson) {
                    // 对于JSON端点，使用现有的_makeRequest方法
                    const result = await this._makeRequest(check.endpoint);
                    results.healthChecks[check.name] = {
                        status: result.success ? '🟢 正常' : '🔴 异常',
                        details: result.success ? 'OK' : result.error
                    };
                } else {
                    // 对于HTML端点，只检查HTTP状态码
                    const { default: fetch } = await import('node-fetch');
                    const response = await fetch(`${this.config.MCPO_HOST}${check.endpoint}`, {
                        timeout: this.config.HEALTH_CHECK_TIMEOUT,
                        headers: { 'Authorization': `Bearer ${this.config.MCPO_API_KEY}` }
                    });
                    
                    results.healthChecks[check.name] = {
                        status: response.ok ? '🟢 正常' : '🔴 异常',
                        details: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}: ${response.statusText}`
                    };
                }
            } catch (error) {
                results.healthChecks[check.name] = {
                    status: '🔴 异常',
                    details: error.message
                };
            }
        }

        // 检查各个服务的状态
        for (const service of results.availableServices) {
            try {
                const serviceResult = await this._makeRequest(`/${service.path}/openapi.json`);
                service.status = serviceResult.success ? '🟢 正常' : '🔴 异常';
                service.version = serviceResult.success ? serviceResult.data.info?.version : null;
            } catch (error) {
                service.status = '🔴 异常';
                service.error = error.message;
            }
        }

        return results;
    }

    async _getToolDetails() {
        this._log('info', 'Fetching tool details from all services...');
        
        const tools = {};
        const servicesInfo = {};

        try {
            // 获取主OpenAPI规范
            const mainResult = await this._makeRequest('/openapi.json');
            if (!mainResult.success) {
                throw new Error(`无法获取主OpenAPI规范: ${mainResult.error}`);
            }

            const description = mainResult.data.info?.description || '';
            const servicePattern = /\[([^\]]+)\]\(\/([^/\)]+)\/docs\)/g;
            const services = [];
            let match;
            
            while ((match = servicePattern.exec(description)) !== null) {
                services.push({
                    name: match[1],
                    path: match[2]
                });
            }

            this._log('info', `Found ${services.length} services to analyze`);

            // 分析每个服务
            for (const service of services) {
                try {
                    const serviceResult = await this._makeRequest(`/${service.path}/openapi.json`);
                    if (!serviceResult.success) {
                        this._log('warn', `Failed to fetch service ${service.name}`, { error: serviceResult.error });
                        continue;
                    }

                    const serviceSpec = serviceResult.data;
                    servicesInfo[service.name] = {
                        name: service.name,
                        path: service.path,
                        version: serviceSpec.info?.version || '未知',
                        description: serviceSpec.info?.description || '',
                        toolCount: 0,
                        tools: []
                    };

                    const paths = serviceSpec.paths || {};
                    
                    for (const [pathKey, pathValue] of Object.entries(paths)) {
                        if (pathValue.post) {
                            const toolName = pathKey.replace('/', '');
                            const fullToolName = `${service.path}_${toolName}`;
                            
                            const toolInfo = {
                                name: fullToolName,
                                originalName: toolName,
                                service: service.name,
                                servicePath: service.path,
                                summary: pathValue.post.summary || toolName,
                                description: pathValue.post.description || '无描述',
                                endpoint: `/${service.path}${pathKey}`,
                                parameters: this._extractParameters(pathValue.post, serviceSpec),
                                example: this._generateCallExample(fullToolName, pathValue.post, serviceSpec)
                            };

                            tools[fullToolName] = toolInfo;
                            servicesInfo[service.name].tools.push(toolInfo);
                            servicesInfo[service.name].toolCount++;
                        }
                    }

                    this._log('info', `Service ${service.name} analyzed: ${servicesInfo[service.name].toolCount} tools found`);

                } catch (error) {
                    this._log('error', `Error analyzing service ${service.name}`, { error: error.message });
                    servicesInfo[service.name] = {
                        name: service.name,
                        path: service.path,
                        error: error.message,
                        toolCount: 0,
                        tools: []
                    };
                }
            }

        } catch (error) {
            this._log('error', 'Failed to get tool details', { error: error.message });
            return { success: false, error: error.message };
        }

        return {
            success: true,
            tools,
            servicesInfo,
            totalTools: Object.keys(tools).length,
            totalServices: Object.keys(servicesInfo).length
        };
    }

    _extractParameters(postInfo, serviceSpec) {
        const parameters = {};
        
        try {
            const requestBody = postInfo.requestBody;
            if (!requestBody || !requestBody.content) {
                return parameters;
            }

            const jsonContent = requestBody.content['application/json'];
            if (!jsonContent || !jsonContent.schema) {
                return parameters;
            }

            let schema = jsonContent.schema;
            
            // 处理 $ref 引用
            if (schema.$ref) {
                const refPath = schema.$ref;
                schema = this._resolveSchemaRef(refPath, serviceSpec);
            }

            if (schema && schema.properties) {
                const required = schema.required || [];
                
                for (const [paramName, paramInfo] of Object.entries(schema.properties)) {
                    parameters[paramName] = {
                        type: paramInfo.type || 'string',
                        description: paramInfo.description || '',
                        required: required.includes(paramName),
                        title: paramInfo.title || paramName,
                        default: paramInfo.default,
                        example: paramInfo.example
                    };
                }
            }
        } catch (error) {
            this._log('warn', 'Error extracting parameters', { error: error.message });
        }

        return parameters;
    }

    _resolveSchemaRef(refPath, serviceSpec) {
        try {
            if (refPath.startsWith('#/components/schemas/')) {
                const schemaName = refPath.split('/').pop();
                return serviceSpec.components?.schemas?.[schemaName] || null;
            }
        } catch (error) {
            this._log('warn', 'Error resolving schema reference', { refPath, error: error.message });
        }
        return null;
    }

    _generateCallExample(toolName, postInfo, serviceSpec) {
        try {
            const exampleParams = {};
            const parameters = this._extractParameters(postInfo, serviceSpec);
            
            for (const [paramName, paramInfo] of Object.entries(parameters)) {
                if (paramInfo.example !== undefined) {
                    exampleParams[paramName] = paramInfo.example;
                } else if (paramInfo.required) {
                    // 生成基于类型的示例值
                    switch (paramInfo.type) {
                        case 'string':
                            if (paramName.toLowerCase().includes('timezone')) {
                                exampleParams[paramName] = 'Asia/Shanghai';
                            } else if (paramName.toLowerCase().includes('time')) {
                                exampleParams[paramName] = '14:30';
                            } else {
                                exampleParams[paramName] = `示例${paramName}值`;
                            }
                            break;
                        case 'integer':
                        case 'number':
                            exampleParams[paramName] = 42;
                            break;
                        case 'boolean':
                            exampleParams[paramName] = true;
                            break;
                        default:
                            exampleParams[paramName] = `示例值`;
                    }
                }
            }

            const argumentsStr = Object.keys(exampleParams).length > 0 
                ? JSON.stringify(exampleParams, null, 2) 
                : '{}';

            return `<<<[TOOL_REQUEST]>>>
tool_name:「始」MCPO「末」,
action:「始」call_tool「末」,
tool_name_param:「始」${toolName}「末」,
arguments:「始」${argumentsStr}「末」
<<<[END_TOOL_REQUEST]>>>`;

        } catch (error) {
            this._log('warn', 'Error generating call example', { error: error.message });
            return `<<<[TOOL_REQUEST]>>>
tool_name:「始」MCPO「末」,
action:「始」call_tool「末」,
tool_name_param:「始」${toolName}「末」,
arguments:「始」{}「末」
<<<[END_TOOL_REQUEST]>>>`;
        }
    }

    _formatStatusReport(healthData, toolData) {
        let report = "";

        // 标题和概览
        report += "# 🔧 MCPO 服务状态监控报告（实时检测）\n\n";
        
        // 服务器状态概览
        report += "## 📊 服务器状态概览\n\n";
        const statusIcon = healthData.serverRunning ? "🟢" : "🔴";
        const statusText = healthData.serverRunning ? "正常运行" : "连接失败";
        report += `**服务器状态**: ${statusIcon} ${statusText}\n`;
        
        if (healthData.serverRunning) {
            report += `**服务器版本**: ${healthData.serverVersion}\n`;
            report += `**可用服务数**: ${healthData.availableServices.length}\n`;
            if (toolData.success) {
                report += `**总工具数量**: ${toolData.totalTools}\n`;
            }
        }
        
        report += `**检测模式**: 🔄 实时检测 (${this.config.REFRESH_INTERVAL_CRON})\n`;
        report += `**最后检查**: ${new Date(healthData.lastChecked).toLocaleString('zh-CN')}\n\n`;

        // 健康检查详情
        if (Object.keys(healthData.healthChecks).length > 0) {
            report += "## 🏥 健康检查详情\n\n";
            for (const [checkName, checkResult] of Object.entries(healthData.healthChecks)) {
                report += `**${checkName}**: ${checkResult.status}\n`;
                if (checkResult.details !== 'OK') {
                    report += `  - 详情: ${checkResult.details}\n`;
                }
            }
            report += "\n";
        }

        // 可用服务详情
        if (healthData.availableServices.length > 0) {
            report += "## 🌐 可用服务详情\n\n";
            for (const service of healthData.availableServices) {
                report += `### ${service.name}\n`;
                report += `- **状态**: ${service.status}\n`;
                report += `- **路径**: \`/${service.path}\`\n`;
                if (service.version) {
                    report += `- **版本**: ${service.version}\n`;
                }
                report += `- **文档**: \`${service.docsUrl}\`\n`;
                if (service.error) {
                    report += `- **错误**: ${service.error}\n`;
                }
                report += "\n";
            }
        }

        // 工具详情（按服务分组）
        if (toolData.success && toolData.servicesInfo) {
            report += "## 🛠️ 可用工具详情\n\n";
            
            for (const [serviceName, serviceInfo] of Object.entries(toolData.servicesInfo)) {
                if (serviceInfo.toolCount > 0) {
                    report += `### ${serviceName} 服务工具 (${serviceInfo.toolCount}个)\n\n`;
                    
                    if (serviceInfo.description) {
                        report += `**服务描述**: ${serviceInfo.description}\n\n`;
                    }
                    
                    for (const tool of serviceInfo.tools) {
                        report += `#### ${tool.originalName}\n`;
                        report += `- **完整名称**: \`${tool.name}\`\n`;
                        report += `- **功能**: ${tool.summary}\n`;
                        
                        if (tool.description && tool.description !== tool.summary) {
                            report += `- **详细描述**: ${tool.description}\n`;
                        }
                        
                        // 参数信息
                        if (this.config.INCLUDE_DETAILED_PARAMS && Object.keys(tool.parameters).length > 0) {
                            report += `- **参数**:\n`;
                            for (const [paramName, paramInfo] of Object.entries(tool.parameters)) {
                                const requiredLabel = paramInfo.required ? " (必需)" : " (可选)";
                                report += `  - \`${paramName}\`${requiredLabel}: ${paramInfo.description || '无描述'}\n`;
                                if (paramInfo.type !== 'string') {
                                    report += `    - 类型: ${paramInfo.type}\n`;
                                }
                                if (paramInfo.default !== undefined) {
                                    report += `    - 默认值: ${paramInfo.default}\n`;
                                }
                            }
                        }
                        
                        // 调用示例
                        report += `- **调用示例**:\n\`\`\`\n${tool.example}\n\`\`\`\n\n`;
                    }
                }
            }
            
            // 通用调用格式说明
            report += "## 📋 通用调用格式\n\n";
            report += "所有 MCPO 工具都通过以下格式调用:\n\n";
            report += "```\n";
            report += "<<<[TOOL_REQUEST]>>>\n";
            report += "tool_name:「始」MCPO「末」,\n";
            report += "action:「始」call_tool「末」,\n";
            report += "tool_name_param:「始」服务名_工具名「末」,\n";
            report += "arguments:「始」{\"参数名\": \"参数值\"}「末」\n";
            report += "<<<[END_TOOL_REQUEST]>>>\n";
            report += "```\n\n";
            
            report += "**其他可用操作**:\n";
            report += "- `list_tools`: 列出所有工具\n";
            report += "- `get_tool_info`: 获取指定工具信息\n";
            report += "- `health_check`: 检查服务健康状态\n";
            report += "- `manage_server`: 管理服务器 (start/stop/restart/status)\n\n";
        }

        // 错误信息
        if (!toolData.success) {
            report += "## ❌ 工具信息获取失败\n\n";
            report += `错误信息: ${toolData.error}\n\n`;
        }

        return report.trim();
    }

    async _readCache() {
        if (!this.config.ENABLE_CACHE) {
            return null;
        }

        try {
            const cacheExists = await fs.access(CACHE_FILE_PATH).then(() => true).catch(() => false);
            if (!cacheExists) {
                return null;
            }

            const stats = await fs.stat(CACHE_FILE_PATH);
            const ageMinutes = (Date.now() - stats.mtime.getTime()) / (1000 * 60);
            
            if (ageMinutes > this.config.CACHE_TTL_MINUTES) {
                this._log('info', `Cache expired (${ageMinutes.toFixed(1)} minutes old)`);
                return null;
            }

            const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
            
            // 验证缓存数据
            if (!cachedData || cachedData.startsWith('[Error') || cachedData.includes('连接失败')) {
                this._log('info', 'Cache contains error data, ignoring');
                return null;
            }

            this._log('info', `Using cached data (${ageMinutes.toFixed(1)} minutes old)`);
            return cachedData.trim();
            
        } catch (error) {
            this._log('warn', 'Error reading cache', { error: error.message });
            return null;
        }
    }

    async _writeCache(data, jsonData = null) {
        if (!this.config.ENABLE_CACHE) {
            return;
        }

        try {
            // 写入格式化文本缓存
            await fs.writeFile(CACHE_FILE_PATH, data, 'utf-8');
            
            // 写入JSON缓存
            if (jsonData) {
                await fs.writeFile(JSON_CACHE_FILE_PATH, JSON.stringify(jsonData, null, 2), 'utf-8');
            }
            
            this._log('info', 'Cache updated successfully');
            
        } catch (error) {
            this._log('error', 'Error writing cache', { error: error.message });
        }
    }

    _generateOfflineReport() {
        const timestamp = new Date().toLocaleString('zh-CN');
        return `# 🔴 MCPO 服务状态监控报告

## ⚠️ 服务器状态概览

**服务器状态**: 🔴 连接失败
**最后检查**: ${timestamp}
**服务器地址**: ${this.config.MCPO_HOST}

## 🚑 故障排除建议

1. 检查 MCPO 服务器是否正在运行
2. 验证网络连接是否正常
3. 检查 API 密钥是否正确
4. 查看 MCPO 服务器日志获取更多信息

## 🔧 快速检查命令

\`\`\`bash
# 检查 MCPO 服务器是否运行
curl ${this.config.MCPO_HOST}/docs

# 检查 MCPO 服务器状态
curl ${this.config.MCPO_HOST}/openapi.json
\`\`\`

> **注意**: 此报告在 MCPO 服务器不可用时生成。如果有缓存数据可用，将优先返回缓存内容。`;
    }

    async generateStatusReport() {
        this._log('info', 'Starting real-time MCPO status monitoring...');

        try {
            // 强制进行实时检测，每次都获取最新状态
            this._log('info', 'Performing real-time status check (ignoring cache)...');
            
            // 并行执行健康检查和工具详情获取
            const [healthData, toolData] = await Promise.all([
                this._checkServerHealth(),
                this._getToolDetails()
            ]);

            // 生成实时报告
            const report = this._formatStatusReport(healthData, toolData);

            // 准备JSON数据用于缓存
            const jsonData = {
                timestamp: new Date().toISOString(),
                health: healthData,
                tools: toolData,
                config: {
                    host: this.config.MCPO_HOST,
                    cacheEnabled: this.config.ENABLE_CACHE,
                    cacheTTL: this.config.CACHE_TTL_MINUTES,
                    refreshInterval: this.config.REFRESH_INTERVAL_CRON
                },
                isRealTime: true,
                checkInterval: `实时检测 (${this.config.REFRESH_INTERVAL_CRON})`,
                lastUpdate: new Date().toLocaleString('zh-CN')
            };

            // 总是更新缓存，确保本地信息实时性
            await this._writeCache(report, jsonData);

            this._log('info', `Real-time status monitoring completed successfully at ${new Date().toLocaleString('zh-CN')}`);
            return report;

        } catch (error) {
            this._log('error', 'Real-time status monitoring failed', { error: error.message });
            
            // 生成错误报告（包含实时检测失败信息）
            const errorReport = `# ❗ MCPO 服务状态监控报告

## 🚫 实时监控失败

**错误信息**: ${error.message}
**检测时间**: ${new Date().toLocaleString('zh-CN')}
**服务器地址**: ${this.config.MCPO_HOST}
**检测模式**: 每10秒实时检测

## 🔍 故障状态

**连接状态**: 🔴 无法连接到MCPO服务器
**检测间隔**: 每10秒自动重试
**缓存状态**: 实时检测模式（不依赖缓存）

## 🛠️ 故障排除建议

1. **检查服务器状态**:
   \`\`\`bash
   curl ${this.config.MCPO_HOST}/docs
   curl ${this.config.MCPO_HOST}/openapi.json
   \`\`\`

2. **验证配置**:
   - 检查 config.env 中的 MCPO_HOST: ${this.config.MCPO_HOST}
   - 检查 MCPO_API_KEY 是否正确
   - 确认防火墙设置允许访问

3. **检查MCPO服务**:
   - 确认 MCPO 服务器正在运行
   - 查看 MCPO 服务器日志
   - 验证网络连接

> **注意**: 监控将每10秒自动进行实时重试检测。`;

            // 缓存错误报告（包含时间戳确保信息更新）
            await this._writeCache(errorReport);
            return errorReport;
        }
    }
}

async function main() {
    try {
        const monitor = new MCPOMonitor();
        
        // 输出当前配置信息（仅在调试模式下）
        if (monitor.debugMode) {
            console.error(`[MCPOMonitor] 配置的刷新间隔: ${monitor.config.REFRESH_INTERVAL_CRON}`);
            console.error(`[MCPOMonitor] MCPO服务器: ${monitor.config.MCPO_HOST} (端口: ${monitor.config.MCPO_PORT})`);
            console.error(`[MCPOMonitor] 缓存启用: ${monitor.config.ENABLE_CACHE}`);
        }
        
        const report = await monitor.generateStatusReport();
        
        // 输出到stdout供Plugin.js使用
        process.stdout.write(report);
        process.exit(0);
        
    } catch (error) {
        console.error(`[MCPOMonitor] Fatal error: ${error.message}`);
        
        const errorOutput = `[MCPO监控插件执行失败: ${error.message}]`;
        process.stdout.write(errorOutput);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = MCPOMonitor;
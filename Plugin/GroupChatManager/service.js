// service.js - Independent server for GroupChatManager (Refactored for Decoupling & Centralized Config)
const express = require('express');
const http = require('http');
const cors = require('cors');
const config = require('./config'); // 引入新的配置文件
const GroupChatServer = require('./GroupChatServer');
const VCPClient = require('./VCPClient');
const DatabaseManager = require('./DatabaseManager');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. 初始化核心服务
const vcpClient = new VCPClient(config.VCP_SERVER_URL, config.VCP_SERVER_KEY);
const dbManager = new DatabaseManager();
const groupChatServer = new GroupChatServer(vcpClient, dbManager);

// 2. 启动服务
async function start() {
    try {
        await dbManager.init();
        await groupChatServer.initialize();

        // 3. 将 GroupChatServer 作为一个 WebSocket 模块附加到 http server
        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            if (url.pathname.startsWith(config.WS_PATH_PREFIX)) {
                groupChatServer.handleUpgrade(request, socket, head);
            } else {
                socket.destroy();
            }
        });

        // 4. 注册 HTTP API 路由
        const router = express.Router();
        
        // 包装异步路由以进行集中的错误处理
        const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

        router.post('/', asyncHandler(async (req, res) => {
            const { group_name, members, roles, goal, mode } = req.body;
            const result = await groupChatServer.create_group({ group_name, members, roles, goal, mode });
            res.status(result.success ? 201 : 400).json(result);
        }));

        router.get('/', asyncHandler(async (req, res) => {
            const groups = await groupChatServer.get_all_groups();
            res.status(200).json({ success: true, groups });
        }));

        router.get('/agents', asyncHandler(async (req, res) => {
            const messages = [{ role: 'user', content: config.GET_AGENT_LIST_COMMAND }];
            const agentListString = await vcpClient.sendRequest(messages, config.AGENT_LIST_PROVIDER_MODEL); 
            const agentList = JSON.parse(agentListString);
            res.status(200).json({ success: true, agents: agentList });
        }));

        router.get('/:groupId/state', asyncHandler(async (req, res) => {
            const { groupId } = req.params;
            const result = await groupChatServer.get_group_state({ group_id: groupId });
            res.status(result.success ? 200 : 404).json(result);
        }));

        router.post('/:groupId/start_session', asyncHandler(async (req, res) => {
            const { groupId } = req.params;
            const result = await groupChatServer.start_group_session({ group_id: groupId });
            res.status(result.success ? 200 : 400).json(result);
        }));

        app.use(config.API_BASE_PATH, router);
        console.log(`[GroupChat Service] HTTP API routes registered under ${config.API_BASE_PATH}.`);

        // 5. 注册全局错误处理中间件
        app.use((err, req, res, next) => {
            console.error('[GroupChat Service] Unhandled API Error:', err);
            res.status(500).json({ success: false, error: `服务器内部错误: ${err.message}` });
        });

        server.listen(config.PORT, () => {
            console.log(`[GroupChat Service] Decoupled server is running on http://localhost:${config.PORT}`);
            if (process.send) {
                process.send('ready');
            }
        });

    } catch (error) {
        console.error('[GroupChat Service] Critical initialization error:', error);
        process.exit(1);
    }
}

start();

process.on('SIGTERM', async () => {
    console.log('[GroupChat Service] Received SIGTERM. Shutting down gracefully...');
    groupChatServer.close();
    await dbManager.close(); // 优雅地关闭数据库连接
    server.close(() => {
        console.log('[GroupChat Service] Server has been terminated.');
        process.exit(0);
    });
});
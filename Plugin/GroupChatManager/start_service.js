// start_service.js - Process manager for the independent GroupChat service
const { fork } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');
const config = require('./config'); // 引入配置文件

// 加载主服务的环境变量，以便传递给子服务
dotenv.config({ path: path.join(__dirname, '..', '..', 'config.env') });

let serviceProcess = null;

/**
 * VCP Service Plugin Entry Point (Decoupled Version)
 * This function is called by the PluginManager when the main server starts.
 * Its job is to launch and manage the independent GroupChat service process.
 * 
 * @param {object} vcp_app - The main VCP application object (not used in this version).
 */
function startService(vcp_app) {
    console.log('[GroupChatManager Plugin] Starting independent service...');

    const servicePath = path.join(__dirname, 'service.js');
    
    // 定义要传递给子进程的环境变量
    const env = {
        ...process.env, // 继承主进程的环境变量
        GROUP_CHAT_PORT: config.PORT, // 使用配置
        VCP_SERVER_URL: `http://localhost:${process.env.PORT || 6005}`,
        VCP_SERVER_KEY: process.env.Key || ''
    };

    serviceProcess = fork(servicePath, [], { env, silent: false });

    serviceProcess.on('message', (msg) => {
        if (msg === 'ready') {
            console.log(`[GroupChatManager Plugin] Independent service has reported it is ready and listening on port ${config.PORT}.`);
        }
    });

    serviceProcess.on('exit', (code, signal) => {
        if (signal) {
            console.log(`[GroupChatManager Plugin] Service process was killed with signal: ${signal}`);
        } else if (code !== 0) {
            console.error(`[GroupChatManager Plugin] Service process exited with error code: ${code}. Restarting...`);
            // 可以添加重启逻辑
            startService(vcp_app);
        } else {
            console.log('[GroupChatManager Plugin] Service process exited gracefully.');
        }
        serviceProcess = null;
    });

    serviceProcess.on('error', (err) => {
        console.error('[GroupChatManager Plugin] Failed to start service process:', err);
    });

    // 返回一个包含停止句柄的对象，以便主服务器可以管理它
    return {
        stop: () => {
            if (serviceProcess) {
                console.log('[GroupChatManager Plugin] Stopping independent service...');
                serviceProcess.kill('SIGTERM');
            }
        }
    };
}

module.exports = startService;
// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 首次迁移或事实变化时，统一 AGS 几何任务使用临时单位向量快照，完成后释放。
// 局部残差与全局 EPA 在单事务发布；事实和配置不变时命中缓存，不推进派生版本。
// 这里不设置 PM2 的 max_memory_restart，避免首轮几何计算的短时 RSS 峰值
// 触发反复重启。旧 pair 缓存及 PCA/SVD 预计算已经退休。
// 如需在生产环境重新启用内存保护，可手动添加 max_memory_restart，例如 "4096M"。
//
// ⚠️ 解释器说明（务必阅读）：
// pm2 对 .js 应用的默认 exec_interpreter 是字面量 "node"（见 pm2/lib/Common.js 的
// interpreter.json 映射），实际由启动时的 PATH 解析。一旦 PATH 命中了不同大版本的
// Node（例如 nvm 的 v22.22.1），better-sqlite3 等原生模块就会因 NODE_MODULE_VERSION
// 不匹配而 ERR_DLOPEN_FAILED，server.js 启动即 exit 1，被 pm2 反复拉起形成崩溃循环。
// 因此这里把解释器显式钉死为便携运行时 runtimes\node\node.exe，不再依赖 PATH。

const path = require('path');
const fs = require('fs');

// 优先使用仓库自带的便携 Node；找不到时退回当前进程的 node，避免 pm2 因解释器不存在而完全起不来。
// 允许用 VCP_NODE_INTERPRETER 覆盖（例如便携运行时场景）。
const RUNTIME_NODE = path.resolve(__dirname, '..', 'runtimes', 'node', 'node.exe');
const NODE_INTERPRETER = process.env.VCP_NODE_INTERPRETER
  || (fs.existsSync(RUNTIME_NODE) ? RUNTIME_NODE : process.execPath);

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
      interpreter: NODE_INTERPRETER,
      watch: false,
      // 不设置 max_memory_restart：允许主服务按系统可用内存自然增长。
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'vcp-admin',
      script: 'adminServer.js',
      interpreter: NODE_INTERPRETER,
      watch: false,
      // 不设置 max_memory_restart：避免管理面板被 PM2 因短时 RSS 波动重启。
      kill_timeout: 5000,
      // 等待主服务初始化后再启动管理面板
      wait_ready: false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
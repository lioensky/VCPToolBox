// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 冷启动时 KnowledgeBaseManager 会把全部 tag 向量载入内存，
// 并执行 pairwise 相似度预计算 + EPA 加权 PCA/SVD，峰值内存与 tag 数量成正比。
// 这里不设置 PM2 的 max_memory_restart，避免大知识库冷启动峰值内存触发 PM2 RSS 超限重启，
// 导致 tag_pair_similarity 表仍为空并反复进入“全量阻塞重算 → 被杀 → 重启”的死循环。
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
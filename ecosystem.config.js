// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 冷启动时 KnowledgeBaseManager 会把全部 tag 向量载入内存，
// 并执行 pairwise 相似度预计算 + EPA 加权 PCA/SVD，峰值内存与 tag 数量成正比。
// 经验值：3072 维向量下，每万个 tag 约占用 ~120MB，再叠加 V8 堆与计算缓存。
//   - 1~2 万 tag：默认 1500M 足够
//   - 10 万+ tag：冷启动峰值可达 3~4GB，1500M 会被 PM2 在算到一半时按 RSS 超限 kill，
//     重启后 tag_pair_similarity 表仍为空，再次触发全量阻塞重算 → 无限杀进程死循环。
// 可通过环境变量 VCP_MAIN_MAX_MEMORY 覆盖（例如大库设为 "4096M"）。
const MAIN_MAX_MEMORY = process.env.VCP_MAIN_MAX_MEMORY || '4096M';

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
      watch: false,
      max_memory_restart: MAIN_MAX_MEMORY,
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'vcp-admin',
      script: 'adminServer.js',
      watch: false,
      max_memory_restart: '512M',
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
// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 冷启动时 KnowledgeBaseManager 会把全部 tag 向量载入内存，
// 并执行 pairwise 相似度预计算 + EPA 加权 PCA/SVD，峰值内存与 tag 数量成正比。
// 这里不设置 PM2 的 max_memory_restart，避免大知识库冷启动峰值内存触发 PM2 RSS 超限重启，
// 导致 tag_pair_similarity 表仍为空并反复进入“全量阻塞重算 → 被杀 → 重启”的死循环。
// 如需在生产环境重新启用内存保护，可手动添加 max_memory_restart，例如 "4096M"。

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
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
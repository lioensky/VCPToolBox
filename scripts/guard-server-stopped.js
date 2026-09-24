// guard-server-stopped.js
// 运行态守卫：禁止在 VCP 服务运行时执行向量库重建/重置脚本。
// 背景：docs/ISSUE_VCP_SIGBUS_sqlite_shm.md —— 服务运行时 unlink -wal/-shm，
//       主进程 WAL 读页( walFindFrame )将触发 SIGBUS core-dump（9/15 已三次实锤）。
// 用法: const { assertServerStopped } = require('./guard-server-stopped');
//       assertServerStopped({ hint: 'xxx' });
const { execSync } = require('child_process');

function isServerRunning() {
  try {
    // 1) systemd 服务状态
    const out = execSync('systemctl is-active vcptoolbox 2>/dev/null || echo inactive', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (out === 'active') return true;
  } catch (e) {
    /* systemctl 不可用时忽略，走进程探针兜底 */
  }
  try {
    // 2) 进程兜底（systemd 状态异常或非 systemd 启动时）
    const out = execSync('pgrep -f "node server.js" || true', { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return true;
  } catch (e) {
    /* ignore */
  }
  return false;
}

function assertServerStopped({ hint = '' } = {}) {
  if (isServerRunning()) {
    console.error('❌ [Guard] VCP 服务正在运行，已拒绝执行本脚本。');
    console.error('❌ [Guard] 服务运行时触碰 knowledge_base.sqlite 的 -wal/-shm 会使主进程');
    console.error('❌ [Guard] 读页 SIGBUS 崩溃（issue: ISSUE_VCP_SIGBUS_sqlite_shm.md）。');
    console.error('❌ [Guard] 请先执行: systemctl stop vcptoolbox，再重试。');
    if (hint) console.error(`❌ [Guard] 附加说明: ${hint}`);
    process.exit(1);
  }
  console.log('🛡️ [Guard] 服务未运行，守卫放行。');
}

module.exports = { assertServerStopped, isServerRunning };
/**
 * ReadingState 持久化管理 (v0.4)
 * 
 * 管理 reading_state.json 的读写，支持：
 * - 中断恢复
 * - 多轮阅读
 * - 跨会话接力
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');

/**
 * 创建空的 ReadingState
 */
function createEmptyState(docId, goal, mode) {
  return {
    docId,
    goal: goal || '',
    mode: mode || 'auto',
    currentPhase: 'survey',
    round: 1,
    rollingContext: '',
    readLog: [],
    chunkSummaries: [],
    auditReport: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * 获取 reading_state.json 路径
 */
function getStatePath(docId) {
  return path.join(WORKSPACE_ROOT, docId, 'reading_notes', 'reading_state.json');
}

/**
 * 加载 ReadingState（不存在则返回 null）
 */
async function loadState(docId) {
  const statePath = getStatePath(docId);
  if (!fsSync.existsSync(statePath)) return null;
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 保存 ReadingState
 */
async function saveState(docId, state) {
  const statePath = getStatePath(docId);
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 加载或创建 ReadingState
 */
async function loadOrCreateState(docId, goal, mode) {
  const existing = await loadState(docId);
  if (existing) {
    // 如果 goal 不同，创建新的 round
    if (goal && existing.goal !== goal) {
      existing.round = (existing.round || 1) + 1;
      existing.goal = goal;
      existing.currentPhase = 'survey';
      existing.auditReport = null;
      process.stderr.write(`[PaperReader][State] new round ${existing.round} with different goal\n`);
    }
    return existing;
  }
  return createEmptyState(docId, goal, mode);
}

/**
 * 记录一个 chunk 的阅读结果
 */
function addChunkRead(state, { chunkIndex, section, readMode, nodeId }) {
  state.readLog.push({
    chunkIndex,
    section: section || 'unknown',
    readMode,
    nodeId: nodeId || null,
    readAt: new Date().toISOString(),
    round: state.round
  });
}

/**
 * 添加 chunk 摘要
 */
function addChunkSummary(state, summary) {
  // 去重：同 chunkIndex 只保留最新
  state.chunkSummaries = state.chunkSummaries.filter(
    s => s.chunkIndex !== summary.chunkIndex
  );
  state.chunkSummaries.push(summary);
}

/**
 * 更新阶段
 */
function setPhase(state, phase) {
  state.currentPhase = phase;
}

/**
 * 获取已读 chunk 索引集合（指定 round 或全部）
 */
function getReadChunkIndices(state, round) {
  const log = round
    ? state.readLog.filter(r => r.round === round)
    : state.readLog;
  return new Set(log.map(r => r.chunkIndex));
}

module.exports = {
  createEmptyState,
  loadState,
  saveState,
  loadOrCreateState,
  addChunkRead,
  addChunkSummary,
  setPhase,
  getReadChunkIndices
};

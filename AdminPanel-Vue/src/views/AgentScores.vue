<template>
  <section class="config-section active-section">
    <p class="description">在这里查看 Agent 的积分情况。</p>
    <div class="agent-scores-container card">
      <div class="scores-header">
        <button @click="refreshScores" class="btn-secondary">
          <span class="material-symbols-outlined">refresh</span> 刷新数据
        </button>
        <span v-if="statusMessage" :class="['status-message', statusType]">
          {{ statusMessage }}
        </span>
      </div>
      <div class="table-container">
        <table class="modern-table" id="agent-scores-table">
          <thead>
            <tr>
              <th>排名</th>
              <th>执行者 (Agent)</th>
              <th>总积分</th>
              <th>最近动态</th>
              <th>获取时间</th>
            </tr>
          </thead>
          <tbody id="agent-scores-body">
            <tr v-if="isLoading">
              <td colspan="5" class="table-center-cell">
                正在加载积分数据…
              </td>
            </tr>
            <tr v-else-if="paginatedScores.length === 0">
              <td colspan="5" class="table-center-cell table-empty-state">
                <span class="material-symbols-outlined table-empty-icon">leaderboard</span>
                暂无积分数据
              </td>
            </tr>
            <tr v-for="(score, index) in paginatedScores" v-else :key="score.agent">
              <td>{{ (currentPage - 1) * 10 + index + 1 }}</td>
              <td>{{ score.agent }}</td>
              <td>{{ score.totalScore }}</td>
              <td>{{ score.recentActivity }}</td>
              <td>{{ score.lastUpdated }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="totalPages > 1" class="pagination-controls">
          <button class="btn-secondary btn-sm" :disabled="!hasPrev" @click="prevPage">
            <span class="material-symbols-outlined">chevron_left</span>
            上一页
          </button>
          <span class="pagination-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
          <button class="btn-secondary btn-sm" :disabled="!hasNext" @click="nextPage">
            下一页
            <span class="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { agentApi } from '@/api'
import { showMessage } from '@/utils'
import { usePagination } from '@/composables/usePagination'

interface AgentScore {
  agent: string
  totalScore: number
  recentActivity: string
  lastUpdated: string
}

const scores = ref<AgentScore[]>([])
const isLoading = ref(false)
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')

const {
  items: paginatedScores,
  currentPage,
  totalPages,
  hasNext,
  hasPrev,
  nextPage,
  prevPage,
  reset: resetPagination,
} = usePagination(scores, { pageSize: 10 })

async function loadScores() {
  isLoading.value = true

  try {
    const data = await agentApi.getAgentScores()
    scores.value = data
      .map(({ baseName, name, totalPoints, history }) => {
        const lastEntry = history.length > 0 ? history[history.length - 1] : null

        return {
          agent: name || baseName,
          totalScore: totalPoints || 0,
          recentActivity: lastEntry
            ? `+${lastEntry.pointsDelta ?? 0} (${lastEntry.reason || '未知原因'})`
            : '无动态',
          lastUpdated: lastEntry?.time
            ? new Date(lastEntry.time).toLocaleString('zh-CN')
            : '无记录',
        }
      })
      .sort((a, b) => b.totalScore - a.totalScore)

    resetPagination()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载积分数据失败：${errorMessage}`, 'error')
  } finally {
    isLoading.value = false
  }
}

async function refreshScores() {
  statusMessage.value = '正在刷新数据…'
  statusType.value = 'info'

  await loadScores()

  statusMessage.value = '数据已刷新'
  statusType.value = 'success'
  showMessage('数据已刷新', 'success')
}

onMounted(() => {
  void loadScores()
})
</script>

<style scoped>
.agent-scores-container {
  padding: var(--space-5);
}

.scores-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-4);
}

.table-center-cell {
  text-align: center;
  padding: var(--space-7) var(--space-4);
  color: var(--secondary-text);
}

.table-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}

.table-empty-icon {
  font-size: var(--font-size-icon-empty);
  opacity: 0.3;
  color: var(--highlight-text);
}

.table-container {
  overflow-x: auto;
}

.pagination-controls {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-5);
  padding: var(--space-4) 0;
}

.pagination-info {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  padding: 0 12px;
}

.modern-table {
  width: 100%;
  border-collapse: collapse;
}

.modern-table th,
.modern-table td {
  padding: var(--space-3) var(--space-4);
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.modern-table th {
  background: var(--tertiary-bg);
  font-weight: 600;
  color: var(--primary-text);
}

.modern-table tr:hover {
  background: var(--accent-bg);
}

@media (max-width: 480px) {
  .scores-header {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .pagination-controls {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .pagination-info {
    padding: 0;
    text-align: center;
  }
}
</style>

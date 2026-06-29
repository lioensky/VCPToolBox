<template>
  <section class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">
          {{ statusMessage }}
        </UiBadge>
        <UiButton variant="outline" size="lg" :loading="isLoading" @click="refreshScores">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新数据
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="agent-scores-shell">
      <header class="scores-heading">
        <div>
          <h2>Agent 积分排行</h2>
          <p>查看各 Agent 的累计积分、最近动态和更新时间。</p>
        </div>
      </header>

      <UiToolbar density="compact" class="scores-toolbar">
        <div class="scores-summary">
          <UiBadge variant="outline">
            共 {{ scores.length }} 个 Agent
          </UiBadge>
        </div>
      </UiToolbar>

      <UiTableFrame density="compact">
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
              <UiEmptyState title="正在加载积分数据…" description="请稍候，积分排行即将更新。">
                <template #icon>
                  <span class="material-symbols-outlined spinning">sync</span>
                </template>
              </UiEmptyState>
            </td>
          </tr>
          <tr v-else-if="paginatedScores.length === 0">
            <td colspan="5" class="table-center-cell">
              <UiEmptyState title="暂无积分数据" description="当 Agent 产生积分记录后，会在这里展示排行。">
                <template #icon>
                  <span class="material-symbols-outlined">leaderboard</span>
                </template>
              </UiEmptyState>
            </td>
          </tr>
          <tr v-for="(score, index) in paginatedScores" v-else :key="score.agent">
            <td>
              <UiBadge variant="outline">
                #{{ (currentPage - 1) * 10 + index + 1 }}
              </UiBadge>
            </td>
            <td>
              <span class="agent-name">{{ score.agent }}</span>
            </td>
            <td>
              <strong class="score-value">{{ score.totalScore }}</strong>
            </td>
            <td>{{ score.recentActivity }}</td>
            <td>{{ score.lastUpdated }}</td>
          </tr>
        </tbody>
      </UiTableFrame>

      <div v-if="totalPages > 1" class="pagination-controls">
        <UiButton variant="outline" size="sm" :disabled="!hasPrev" @click="prevPage">
          <template #leading>
            <span class="material-symbols-outlined">chevron_left</span>
          </template>
          上一页
        </UiButton>
        <span class="pagination-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
        <UiButton variant="outline" size="sm" :disabled="!hasNext" @click="nextPage">
          下一页
          <template #trailing>
            <span class="material-symbols-outlined">chevron_right</span>
          </template>
        </UiButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { agentApi } from '@/api'
import { showMessage } from '@/utils'
import { usePagination } from '@/composables/usePagination'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiTableFrame from '@/components/ui/UiTableFrame.vue'
import UiToolbar from '@/components/ui/UiToolbar.vue'

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

const statusBadgeVariant = computed(() => {
  if (statusType.value === 'success') return 'success'
  if (statusType.value === 'error') return 'danger'
  return 'info'
})

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
.agent-scores-shell {
  display: grid;
  gap: var(--space-3);
}

.scores-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.scores-heading h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 650;
  line-height: 1.4;
}

.scores-heading p {
  margin: var(--space-1) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.5;
}

.scores-toolbar {
  min-height: 32px;
}

.scores-summary {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.table-center-cell {
  padding: 0;
  color: var(--secondary-text);
  text-align: center;
}

.agent-name {
  color: var(--primary-text);
  font-weight: 600;
}

.score-value {
  font-family: "Consolas", "Monaco", "Courier New", monospace;
  font-variant-numeric: tabular-nums;
}

.pagination-controls {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.pagination-info {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  padding: 0 var(--space-2);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 480px) {
  .pagination-controls {
    flex-direction: column;
    align-items: stretch;
  }

  .pagination-info {
    padding: 0;
    text-align: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>

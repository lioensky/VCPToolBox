<template>
  <section class="config-section active-section tool-call-records-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge :variant="config.enabled ? 'success' : 'outline'">
          {{ config.enabled ? '记录已启用' : '记录未启用' }}
        </UiBadge>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">{{ statusMessage }}</UiBadge>
        <UiButton type="button" :disabled="loading" :loading="loading" @click="reloadAll">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton type="button" :disabled="savingConfig" :loading="savingConfig" @click="saveConfig">
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="records-intro">
      <h2>插件调用记录管理</h2>
      <p>查看、检索和清理 VCP 工具调用生命周期记录，并管理记录策略。</p>
    </header>

    <section class="records-summary" aria-label="插件调用记录摘要">
      <span class="summary-item">
        <strong>{{ storeStatus.enabled ? '已启用' : '未启用' }}</strong>
        <small>记录状态</small>
      </span>
      <span class="summary-item">
        <strong>{{ recordsTotal }}</strong>
        <small>当前查询结果</small>
      </span>
      <span class="summary-item">
        <strong>{{ storeStatus.retentionDays }} 天</strong>
        <small>保留周期</small>
      </span>
      <span class="summary-item">
        <strong>{{ storeStatus.watcherActive ? '正常' : '未运行' }}</strong>
        <small>配置监听</small>
      </span>
    </section>

    <section class="records-grid records-grid--top">
      <UiSettingsCard
        class="records-surface"
        title="运行状态"
        description="展示工具调用记录存储、配置和自动清理状态。"
        variant="subtle"
      >
        <dl class="status-list">
          <div>
            <dt>初始化</dt>
            <dd>{{ storeStatus.initialized ? '已完成' : '未初始化' }}</dd>
          </div>
          <div>
            <dt>自动清理</dt>
            <dd>{{ storeStatus.autoCleanupEnabled ? '已启用' : '未启用' }}</dd>
          </div>
          <div>
            <dt>清理周期</dt>
            <dd>{{ storeStatus.cleanupIntervalMinutes }} 分钟</dd>
          </div>
          <div>
            <dt>配置路径</dt>
            <dd class="path-value" :title="storeStatus.configPath">{{ storeStatus.configPath || '-' }}</dd>
          </div>
          <div>
            <dt>数据库路径</dt>
            <dd class="path-value" :title="storeStatus.dbPath">{{ storeStatus.dbPath || '-' }}</dd>
          </div>
          <div v-if="storeStatus.lastLoadError">
            <dt>加载错误</dt>
            <dd class="danger-text">{{ storeStatus.lastLoadError }}</dd>
          </div>
        </dl>
      </UiSettingsCard>

      <UiSettingsCard
        class="records-surface"
        title="记录配置"
        description="保存后后端会热更新配置，无需重启服务。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="2" gap="sm">
          <UiSettingsSwitchRow
            v-model="config.enabled"
            label="启用插件调用记录"
            description="关闭时不再写入新的工具调用记录。"
            data-settings-span="full"
          />
          <UiSettingsSwitchRow
            v-model="config.autoCleanupEnabled"
            label="启用自动清理"
            description="按保留天数周期性删除过期记录。"
            data-settings-span="full"
          />
          <UiSettingsSwitchRow
            v-model="config.captureMultimodal"
            label="保存多模态内容"
            description="关闭后会脱敏 data:image/* 等内容。"
            data-settings-span="full"
          />
          <UiSettingsSwitchRow
            v-model="config.summarizeLargePayloadsInList"
            label="列表截断大字段"
            description="列表查询仅展示预览，详情查询仍显示完整内容。"
            data-settings-span="full"
          />
          <UiField label="保留天数" for-id="records-retention-days">
            <UiInput id="records-retention-days" v-model.number="config.retentionDays" type="number" min="0" />
          </UiField>
          <UiField label="清理周期（分钟）" for-id="records-cleanup-interval">
            <UiInput id="records-cleanup-interval" v-model.number="config.cleanupIntervalMinutes" type="number" min="1" />
          </UiField>
          <UiField label="最大查询条数" for-id="records-max-limit">
            <UiInput id="records-max-limit" v-model.number="config.maxQueryLimit" type="number" min="1" />
          </UiField>
          <UiField label="默认查询条数" for-id="records-default-limit">
            <UiInput id="records-default-limit" v-model.number="config.defaultQueryLimit" type="number" min="1" />
          </UiField>
          <UiField label="列表预览字符数" for-id="records-preview-chars">
            <UiInput id="records-preview-chars" v-model.number="config.listPayloadPreviewChars" type="number" min="100" />
          </UiField>
          <UiField
            label="排除工具"
            description="每行一个工具名，例如 ToolCallRecordQuery。"
            for-id="records-exclude-tools"
            data-settings-span="full"
          >
            <UiTextarea
              id="records-exclude-tools"
              v-model="excludeToolsText"
              class="mono-textarea"
              rows="4"
              placeholder="ToolCallRecordQuery"
            />
          </UiField>
        </UiSettingsForm>
      </UiSettingsCard>
    </section>

    <UiSettingsCard
      class="records-surface"
      title="查询与筛选"
      description="按记录 ID、工具名、调用者、时间范围和关键词检索插件调用记录。"
      variant="subtle"
    >
      <form class="filters-grid" @submit.prevent="queryFirstPage">
        <UiField label="记录 ID" for-id="record-filter-id">
          <UiInput id="record-filter-id" v-model="filters.id" placeholder="tcr-..." />
        </UiField>
        <UiField label="工具名" for-id="record-filter-tool">
          <UiInput id="record-filter-tool" v-model="filters.toolName" placeholder="UrlFetch" />
        </UiField>
        <UiField label="调用者署名" for-id="record-filter-caller">
          <UiInput id="record-filter-caller" v-model="filters.callerSignature" placeholder="Nova" />
        </UiField>
        <UiField label="调用者类型" for-id="record-filter-caller-type">
          <UiSelect id="record-filter-caller-type" v-model="filters.callerType">
            <option value="">全部</option>
            <option value="maid">maid</option>
            <option value="valet">valet</option>
          </UiSelect>
        </UiField>
        <UiField label="状态" for-id="record-filter-status">
          <UiSelect id="record-filter-status" v-model="filters.status">
            <option value="">全部</option>
            <option value="running">running</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </UiSelect>
        </UiField>
        <UiField label="成功状态" for-id="record-filter-success">
          <UiSelect id="record-filter-success" v-model="filters.success">
            <option value="">全部</option>
            <option value="true">成功</option>
            <option value="false">失败</option>
          </UiSelect>
        </UiField>
        <UiField label="起始时间" for-id="record-filter-from">
          <UiInput id="record-filter-from" v-model="filters.from" type="datetime-local" />
        </UiField>
        <UiField label="结束时间" for-id="record-filter-to">
          <UiInput id="record-filter-to" v-model="filters.to" type="datetime-local" />
        </UiField>
        <UiField label="全文搜索" for-id="record-filter-search" data-filter-span="wide">
          <UiInput id="record-filter-search" v-model="filters.search" placeholder="关键词 / IP / 节点 / 内容片段" />
        </UiField>
        <UiField label="每页条数" for-id="record-filter-limit">
          <UiInput id="record-filter-limit" v-model.number="filters.limit" type="number" min="1" />
        </UiField>
        <UiField label="排序" for-id="record-filter-order">
          <UiSelect id="record-filter-order" v-model="filters.order">
            <option value="desc">最新优先</option>
            <option value="asc">最旧优先</option>
          </UiSelect>
        </UiField>
        <UiSettingsSwitchRow
          v-model="filters.detail"
          label="列表返回完整详情"
          description="开启后列表也会包含调用参数和返回内容，可能较慢。"
          data-filter-span="wide"
        />
        <div class="filters-actions">
          <UiButton type="submit" :disabled="querying" :loading="querying">
            <template #leading>
              <span class="material-symbols-outlined">search</span>
            </template>
            查询
          </UiButton>
          <UiButton type="button" variant="secondary" :disabled="querying" @click="resetFilters">
            <template #leading>
              <span class="material-symbols-outlined">restart_alt</span>
            </template>
            重置
          </UiButton>
        </div>
      </form>
    </UiSettingsCard>

    <UiSettingsCard
      class="records-surface"
      title="记录列表"
      :description="`共 ${recordsTotal} 条，当前第 ${currentPage} 页。`"
      variant="subtle"
    >
      <template v-if="records.length > 0">
        <UiTableFrame density="compact">
          <thead>
            <tr>
              <th>记录 ID</th>
              <th>工具名</th>
              <th>调用者</th>
              <th>开始时间</th>
              <th>耗时</th>
              <th>状态</th>
              <th>成功</th>
              <th>多模态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in records" :key="record.id">
              <td class="record-id-cell" :title="record.id">{{ record.id }}</td>
              <td>{{ record.toolName || '-' }}</td>
              <td>
                <span>{{ record.callerSignature || '-' }}</span>
                <small v-if="record.callerType" class="muted-inline">({{ record.callerType }})</small>
              </td>
              <td>{{ formatDateTime(record.startedAt) }}</td>
              <td>{{ formatDuration(record.durationMs) }}</td>
              <td>
                <UiBadge :variant="getStatusVariant(record.status)">{{ record.status }}</UiBadge>
              </td>
              <td>
                <UiBadge :variant="record.success ? 'success' : 'danger'">
                  {{ record.success ? '成功' : '失败' }}
                </UiBadge>
              </td>
              <td>{{ record.hasMultimodal ? '是' : '否' }}</td>
              <td>
                <UiButton type="button" size="sm" variant="secondary" @click="openDetail(record)">
                  详情
                </UiButton>
              </td>
            </tr>
          </tbody>
        </UiTableFrame>
        <UiToolbar class="pagination-bar" density="compact">
          <span class="muted-text">offset {{ queryOffset }} / limit {{ filters.limit }}</span>
          <template #actions>
            <UiButton type="button" size="sm" variant="secondary" :disabled="querying || queryOffset <= 0" @click="previousPage">
              上一页
            </UiButton>
            <UiButton type="button" size="sm" variant="secondary" :disabled="querying || !hasNextPage" @click="nextPage">
              下一页
            </UiButton>
          </template>
        </UiToolbar>
      </template>
      <UiEmptyState v-else title="暂无记录" description="调整筛选条件后重新查询，或确认后端记录功能已启用。">
        <template #icon>
          <span class="material-symbols-outlined">manage_search</span>
        </template>
      </UiEmptyState>
    </UiSettingsCard>

    <UiSettingsCard
      class="records-surface danger-card"
      title="危险操作"
      description="清理操作会直接删除数据库中的插件调用记录，请谨慎执行。"
      variant="subtle"
    >
      <UiToolbar>
        <span class="danger-text">清理过期记录按当前 retentionDays 执行；清空全部需要二次确认。</span>
        <template #actions>
          <UiButton type="button" variant="secondary" :disabled="dangerBusy" :loading="dangerBusy" @click="cleanupExpired">
            清理过期记录
          </UiButton>
          <UiButton type="button" variant="danger" :disabled="dangerBusy" :loading="dangerBusy" @click="clearAllRecords">
            清空全部记录
          </UiButton>
        </template>
      </UiToolbar>
    </UiSettingsCard>

    <BaseModal v-model="detailModalOpen" aria-label="插件调用记录详情">
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs">
          <article v-bind="panelAttrs" :ref="panelRef" class="detail-modal" @click.stop>
            <header class="detail-modal__header">
              <div>
                <h3>记录详情</h3>
                <p>{{ selectedRecord?.id }}</p>
              </div>
              <UiButton type="button" size="sm" variant="secondary" @click="detailModalOpen = false">关闭</UiButton>
            </header>
            <div v-if="selectedRecord" class="detail-modal__body">
              <dl class="detail-meta">
                <div>
                  <dt>工具名</dt>
                  <dd>{{ selectedRecord.toolName || '-' }}</dd>
                </div>
                <div>
                  <dt>调用者</dt>
                  <dd>{{ selectedRecord.callerSignature || '-' }} / {{ selectedRecord.callerType || '-' }}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{{ selectedRecord.requestIp || '-' }} / {{ selectedRecord.sourceNode || '-' }}</dd>
                </div>
                <div>
                  <dt>时间</dt>
                  <dd>{{ formatDateTime(selectedRecord.startedAt) }} → {{ formatDateTime(selectedRecord.finishedAt) }}</dd>
                </div>
              </dl>
              <section v-if="selectedRecord.errorText" class="detail-block">
                <h4>错误文本</h4>
                <pre>{{ selectedRecord.errorText }}</pre>
              </section>
              <section class="detail-block">
                <h4>调用参数</h4>
                <pre>{{ stringifyJson(selectedRecord.callContent) }}</pre>
              </section>
              <section class="detail-block">
                <h4>返回内容</h4>
                <pre>{{ stringifyJson(selectedRecord.returnContent) }}</pre>
              </section>
            </div>
          </article>
        </div>
      </template>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { toolCallRecordsApi } from '@/api/toolCallRecords'
import type {
  ToolCallRecord,
  ToolCallRecordsConfig,
  ToolCallRecordsStoreStatus,
} from '@/api/toolCallRecords'
import BaseModal from '@/components/ui/BaseModal.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsSwitchRow from '@/components/ui/UiSettingsSwitchRow.vue'
import UiTableFrame from '@/components/ui/UiTableFrame.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import UiToolbar from '@/components/ui/UiToolbar.vue'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'

function createDefaultConfig(): ToolCallRecordsConfig {
  return {
    enabled: false,
    retentionDays: 30,
    autoCleanupEnabled: true,
    cleanupIntervalMinutes: 1440,
    maxQueryLimit: 100,
    defaultQueryLimit: 20,
    captureMultimodal: true,
    summarizeLargePayloadsInList: true,
    listPayloadPreviewChars: 1200,
    excludeTools: ['ToolCallRecordQuery'],
  }
}

function createDefaultStatus(): ToolCallRecordsStoreStatus {
  return {
    initialized: false,
    enabled: false,
    configPath: '',
    dbPath: '',
    watcherActive: false,
    autoCleanupEnabled: false,
    retentionDays: 0,
    cleanupIntervalMinutes: 0,
    lastLoadError: null,
  }
}

function createDefaultFilters() {
  return {
    id: '',
    toolName: '',
    callerSignature: '',
    callerType: '',
    status: '',
    success: '',
    from: '',
    to: '',
    search: '',
    limit: 20,
    order: 'desc' as const,
    detail: false,
  }
}

const loading = ref(false)
const querying = ref(false)
const savingConfig = ref(false)
const dangerBusy = ref(false)
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')
const storeStatus = ref<ToolCallRecordsStoreStatus>(createDefaultStatus())
const config = reactive<ToolCallRecordsConfig>(createDefaultConfig())
const excludeToolsText = ref('ToolCallRecordQuery')
const filters = reactive(createDefaultFilters())
const records = ref<ToolCallRecord[]>([])
const recordsTotal = ref(0)
const queryOffset = ref(0)
const detailModalOpen = ref(false)
const selectedRecord = ref<ToolCallRecord | null>(null)

const statusBadgeVariant = computed(() => {
  if (statusType.value === 'success') return 'success'
  if (statusType.value === 'error') return 'danger'
  return 'info'
})

const currentPage = computed(() => Math.floor(queryOffset.value / Math.max(1, filters.limit)) + 1)

const hasNextPage = computed(() => queryOffset.value + filters.limit < recordsTotal.value)

function assignConfig(nextConfig: ToolCallRecordsConfig): void {
  Object.assign(config, createDefaultConfig(), nextConfig)
  excludeToolsText.value = Array.isArray(config.excludeTools) ? config.excludeTools.join('\n') : ''
}

function normalizeDateTimeLocal(value: string): string | undefined {
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toISOString()
}

function buildConfigPayload(): ToolCallRecordsConfig {
  return {
    ...config,
    excludeTools: excludeToolsText.value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  }
}

function buildQuery(offset: number) {
  return {
    ...filters,
    from: normalizeDateTimeLocal(filters.from),
    to: normalizeDateTimeLocal(filters.to),
    offset,
  }
}

function setStatus(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = message
  statusType.value = type
}

async function loadStatus(): Promise<void> {
  storeStatus.value = await toolCallRecordsApi.getStatus({
    showLoader: false,
    loadingKey: 'tool-call-records.status.load',
  })
}

async function loadConfig(): Promise<void> {
  const nextConfig = await toolCallRecordsApi.getConfig({
    showLoader: false,
    loadingKey: 'tool-call-records.config.load',
  })
  assignConfig(nextConfig)
  filters.limit = nextConfig.defaultQueryLimit || filters.limit
}

async function queryRecords(offset = queryOffset.value): Promise<void> {
  querying.value = true
  try {
    const result = await toolCallRecordsApi.queryRecords(buildQuery(offset), {
      showLoader: false,
      loadingKey: 'tool-call-records.records.query',
    })
    records.value = result.records || []
    recordsTotal.value = result.total || 0
    queryOffset.value = result.offset || offset
    filters.limit = result.limit || filters.limit
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`查询插件调用记录失败：${errorMessage}`, 'error')
  } finally {
    querying.value = false
  }
}

async function reloadAll(): Promise<void> {
  loading.value = true
  try {
    await Promise.all([loadStatus(), loadConfig()])
    await queryRecords(0)
    setStatus('已刷新', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    setStatus(`刷新失败：${errorMessage}`, 'error')
    showMessage(`刷新失败：${errorMessage}`, 'error')
  } finally {
    loading.value = false
  }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  try {
    const result = await toolCallRecordsApi.saveConfig(buildConfigPayload(), {
      loadingKey: 'tool-call-records.config.save',
    })
    assignConfig(result.config)
    await loadStatus()
    setStatus(result.message || '配置已保存', 'success')
    showMessage(result.message || '插件调用记录配置已保存。', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    setStatus(`保存失败：${errorMessage}`, 'error')
    showMessage(`保存失败：${errorMessage}`, 'error')
  } finally {
    savingConfig.value = false
  }
}

function queryFirstPage(): void {
  void queryRecords(0)
}

function resetFilters(): void {
  Object.assign(filters, createDefaultFilters())
  filters.limit = config.defaultQueryLimit || 20
  void queryRecords(0)
}

function previousPage(): void {
  const nextOffset = Math.max(0, queryOffset.value - filters.limit)
  void queryRecords(nextOffset)
}

function nextPage(): void {
  if (!hasNextPage.value) {
    return
  }
  void queryRecords(queryOffset.value + filters.limit)
}

async function openDetail(record: ToolCallRecord): Promise<void> {
  selectedRecord.value = record
  detailModalOpen.value = true

  try {
    selectedRecord.value = await toolCallRecordsApi.getRecord(record.id, {
      showLoader: false,
      loadingKey: 'tool-call-records.record.detail',
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载记录详情失败：${errorMessage}`, 'error')
  }
}

async function cleanupExpired(): Promise<void> {
  dangerBusy.value = true
  try {
    const result = await toolCallRecordsApi.cleanupExpired({
      loadingKey: 'tool-call-records.cleanup-expired',
    })
    showMessage(result.message, 'success')
    setStatus(result.message, 'success')
    await queryRecords(0)
    await loadStatus()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`清理失败：${errorMessage}`, 'error')
  } finally {
    dangerBusy.value = false
  }
}

async function clearAllRecords(): Promise<void> {
  const confirmed = await askConfirm({
    message: '确定要清空全部插件调用记录吗？该操作不可撤销。',
    danger: true,
    confirmText: '清空全部',
  })

  if (!confirmed) {
    return
  }

  dangerBusy.value = true
  try {
    const result = await toolCallRecordsApi.clearAll({
      loadingKey: 'tool-call-records.clear-all',
    })
    showMessage(result.message, 'success')
    setStatus(result.message, 'success')
    await queryRecords(0)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`清空失败：${errorMessage}`, 'error')
  } finally {
    dangerBusy.value = false
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${value} ms`
}

function getStatusVariant(status: string) {
  if (status === 'success') return 'success'
  if (status === 'failure') return 'danger'
  if (status === 'running') return 'info'
  return 'outline'
}

function stringifyJson(value: unknown): string {
  if (value === undefined || value === null) {
    return '-'
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

onMounted(() => {
  void reloadAll()
})
</script>

<style scoped>
.tool-call-records-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.records-intro {
  display: grid;
  gap: var(--space-1);
}

.records-intro h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.records-intro p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.records-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.summary-item {
  display: grid;
  gap: 2px;
  min-height: 52px;
  justify-content: start;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.summary-item strong {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
  line-height: 1.15;
}

.summary-item small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.records-grid {
  display: grid;
  gap: var(--space-4);
}

.records-grid--top {
  grid-template-columns: minmax(280px, 0.72fr) minmax(0, 1fr);
}

.records-surface {
  --records-surface-border: color-mix(in srgb, var(--border-color) 94%, transparent);
  --records-card-surface: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.records-surface,
:deep(.ui-card.records-surface) {
  border-color: var(--records-surface-border);
  background: var(--records-card-surface);
}

.records-surface :deep(.ui-card__header),
:deep(.ui-card.records-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--records-surface-border);
}

.records-surface :deep(.ui-input),
.records-surface :deep(.ui-select),
.records-surface :deep(.ui-textarea) {
  border-color: color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-md);
}

.status-list,
.detail-meta {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}

.status-list div,
.detail-meta div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
}

.status-list dt,
.detail-meta dt {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.status-list dd,
.detail-meta dd {
  min-width: 0;
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  overflow-wrap: anywhere;
}

.path-value {
  font-family: 'Consolas', 'Monaco', monospace;
}

.danger-text {
  color: var(--danger-color);
}

.muted-text,
.muted-inline {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.mono-textarea {
  font-family: 'Consolas', 'Monaco', monospace;
  line-height: 1.55;
}

.filters-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: var(--space-3);
}

.filters-grid [data-filter-span='wide'] {
  grid-column: span 2;
}

.filters-actions {
  display: flex;
  align-items: end;
  gap: var(--space-2);
}

.record-id-cell {
  max-width: 260px;
  overflow: hidden;
  font-family: 'Consolas', 'Monaco', monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pagination-bar {
  margin-top: var(--space-3);
}

.danger-card {
  border-color: color-mix(in srgb, var(--danger-color) 36%, var(--border-color));
}

.detail-modal {
  display: flex;
  flex-direction: column;
  width: min(960px, calc(100vw - 32px));
  max-height: min(82vh, 760px);
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  color: var(--primary-text);
  box-shadow: var(--overlay-panel-shadow);
}

.detail-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.detail-modal__header h3 {
  margin: 0;
  font-size: 1rem;
}

.detail-modal__header p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-caption);
  overflow-wrap: anywhere;
}

.detail-modal__body {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  overflow: auto;
}

.detail-block {
  display: grid;
  gap: var(--space-2);
}

.detail-block h4 {
  margin: 0;
  font-size: var(--font-size-body);
}

.detail-block pre {
  max-height: 300px;
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 58%, transparent);
  color: var(--primary-text);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-helper);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 1100px) {
  .records-grid--top,
  .filters-grid {
    grid-template-columns: 1fr 1fr;
  }

  .filters-grid [data-filter-span='wide'] {
    grid-column: 1 / -1;
  }
}

@media (max-width: 720px) {
  .records-summary,
  .records-grid--top,
  .filters-grid {
    grid-template-columns: 1fr;
  }

  .filters-grid [data-filter-span='wide'] {
    grid-column: auto;
  }

  .status-list div,
  .detail-meta div {
    grid-template-columns: 1fr;
  }

  .filters-actions {
    align-items: stretch;
  }
}
</style>
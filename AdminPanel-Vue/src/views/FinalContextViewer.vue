<template>
  <section class="config-section active-section">
    <div class="context-viewer">
      <header class="context-header">
        <div class="context-title">
          <span class="material-symbols-outlined">schema</span>
          <div>
            <h2>最终上下文处理</h2>
            <p>展示最后一次发给上游模型前的最终请求体，不包含 AI 最终输出。</p>
          </div>
        </div>

        <div class="context-actions">
          <button type="button" class="btn-secondary" @click="openOneRingConfigModal" :disabled="isOneRingConfigLoading">
            <span class="material-symbols-outlined" :class="{ spinning: isOneRingConfigLoading }">settings</span>
            ORing配置
          </button>
          <button type="button" class="btn-secondary" @click="loadSnapshot" :disabled="isLoading">
            <span class="material-symbols-outlined" :class="{ spinning: isLoading }">sync</span>
            刷新
          </button>
          <button type="button" class="btn-secondary" @click="copyVisibleText" :disabled="!snapshot">
            <span class="material-symbols-outlined">content_copy</span>
            复制可见文本
          </button>
        </div>
      </header>

      <div class="context-toolbar">
        <input
          v-model="searchText"
          type="search"
          class="context-search"
          placeholder="🔍 搜索角色、块编号、文本内容、附件类型…"
          @keydown.enter.prevent="jumpToNextMatch"
        />

        <div class="search-actions">
          <button type="button" class="btn-secondary" @click="jumpToPreviousMatch" :disabled="matchedBlocks.length === 0">
            <span class="material-symbols-outlined">keyboard_arrow_up</span>
            上一个
          </button>
          <button type="button" class="btn-secondary" @click="jumpToNextMatch" :disabled="matchedBlocks.length === 0">
            <span class="material-symbols-outlined">keyboard_arrow_down</span>
            下一个
          </button>
          <span class="match-status">
            匹配 {{ matchedBlocks.length }} / 总块 {{ blocks.length }}
          </span>
        </div>
      </div>

      <div v-if="!snapshot && !isLoading" class="empty-state">
        <span class="material-symbols-outlined">inbox</span>
        <strong>暂无最终上下文快照</strong>
        <p>{{ emptyMessage }}</p>
      </div>

      <template v-else-if="snapshot">
        <section class="summary-card">
          <div class="summary-item">
            <span>捕获时间</span>
            <strong>{{ snapshot.capturedAt }}</strong>
          </div>
          <div class="summary-item">
            <span>模型</span>
            <strong>{{ snapshot.summary.model || '-' }}</strong>
          </div>
          <div class="summary-item">
            <span>消息块</span>
            <strong>{{ snapshot.summary.messageCount }}</strong>
          </div>
          <div class="summary-item">
            <span>总 Token</span>
            <strong>{{ formatNumber(snapshot.summary.totalTokenCount) }}</strong>
          </div>
          <div class="summary-item">
            <span>文本 Token</span>
            <strong>{{ formatNumber(snapshot.summary.totalTextTokenCount) }}</strong>
          </div>
          <div class="summary-item">
            <span>附件估算 Token</span>
            <strong>{{ formatNumber(snapshot.summary.totalAttachmentTokenCount) }}</strong>
          </div>
          <div class="summary-item">
            <span>总字符</span>
            <strong>{{ formatNumber(snapshot.summary.totalTextLength) }}</strong>
          </div>
          <div class="summary-item">
            <span>Token 算法</span>
            <strong>{{ snapshot.summary.tokenMethod || '-' }}</strong>
          </div>
          <div class="summary-item">
            <span>Stream</span>
            <strong>{{ snapshot.summary.stream ? 'true' : 'false' }}</strong>
          </div>
          <div class="summary-item wide">
            <span>角色统计</span>
            <strong>{{ roleCountsText }}</strong>
          </div>
        </section>

        <nav class="jump-index" aria-label="上下文块跳转索引">
          <button
            v-for="block in blocks"
            :key="`jump-${block.index}`"
            type="button"
            class="jump-chip"
            :class="[roleClass(block.role), userBlockJumpClass(block), { matched: isBlockMatched(block.index), active: activeBlockIndex === block.index }]"
            @click="scrollToBlock(block.index)"
          >
            #{{ block.index }} {{ jumpBlockLabel(block) }}
          </button>
        </nav>

        <main class="block-list">
          <article
            v-for="block in filteredBlocks"
            :key="block.index"
            :ref="(el) => setBlockRef(block.index, el)"
            class="context-block"
            :class="[roleClass(block.role), { active: activeBlockIndex === block.index }]"
          >
            <header class="block-header">
              <div class="block-identity">
                <span class="block-index">#{{ block.index }}</span>
                <span class="block-role">{{ normalizeRoleLabel(block.role) }}</span>
                <span v-if="getUserBlockBadge(block)" class="block-badge" :class="getUserBlockBadge(block)?.className">
                  {{ getUserBlockBadge(block)?.label }}
                </span>
                <span class="block-type">{{ block.contentType }}</span>
              </div>
              <div class="block-meta">
                <span>{{ formatNumber(block.textLength) }} 字符</span>
                <span>{{ formatNumber(block.tokenCount) }} tokens</span>
                <span>文本 {{ formatNumber(block.textTokenCount) }}</span>
                <span v-if="block.attachmentTokenCount">附件估算 {{ formatNumber(block.attachmentTokenCount) }}</span>
                <span>{{ block.tokenMethod || snapshot.summary.tokenMethod || 'unknown' }}</span>
                <span v-if="block.attachments.length > 0">
                  附件 {{ block.attachments.length }} 个：{{ attachmentCountsText(block) }}
                </span>
              </div>
            </header>

            <div v-if="block.attachments.length > 0" class="attachment-panel">
              <span class="material-symbols-outlined">attachment</span>
              <span>{{ attachmentDescription(block) }}</span>
            </div>

            <pre class="block-content">{{ block.text || '(空文本块)' }}</pre>
          </article>
        </main>
      </template>
    </div>

    <div v-if="showOneRingConfigModal" class="modal-backdrop" @click.self="closeOneRingConfigModal">
      <section class="onering-modal" role="dialog" aria-modal="true" aria-labelledby="onering-config-title">
        <header class="modal-header">
          <div>
            <h3 id="onering-config-title">OneRing 热配置</h3>
            <p>保存后会写入 Plugin/OneRing/OneRingConfig.json，运行中的 OneRing 会通过 chokidar 自动热加载。</p>
          </div>
          <button type="button" class="icon-button" aria-label="关闭" @click="closeOneRingConfigModal">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <div class="modal-body">
          <label class="config-toggle-row">
            <input v-model="oneRingConfigDraft.enabled" type="checkbox" />
            <span>
              <strong>启用 OneRing</strong>
              <small>false 时插件直接透传 messages。</small>
            </span>
          </label>

          <label class="config-field">
            <span>来源标记输出位置</span>
            <select v-model="oneRingConfigDraft.tailTagPlacement">
              <option value="inline">inline：追加到原 user/assistant 块内部</option>
              <option value="system_user_block">system_user_block：拆成独立 user 伪系统提示块</option>
            </select>
          </label>

          <label class="config-field">
            <span>最大补充后上下文 block 数</span>
            <input v-model.number="oneRingConfigDraft.maxContextBlocks" type="number" min="1" step="1" />
          </label>

          <label class="config-toggle-row">
            <input v-model="oneRingConfigDraft.timeInsert" type="checkbox" />
            <span>
              <strong>允许时间线内插入</strong>
              <small>true 时按 OneRing 时间戳合并补入消息；false 时不做时间线内插入。</small>
            </span>
          </label>
        </div>

        <footer class="modal-actions">
          <button type="button" class="btn-secondary" @click="closeOneRingConfigModal" :disabled="isOneRingConfigSaving">
            取消
          </button>
          <button type="button" class="btn-primary" @click="saveOneRingConfig" :disabled="isOneRingConfigSaving">
            <span v-if="isOneRingConfigSaving" class="material-symbols-outlined spinning">sync</span>
            保存
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, type ComponentPublicInstance } from 'vue'
import { systemApi } from '@/api'
import type { FinalContextBlockSummary, FinalContextSnapshot, OneRingConfig } from '@/types/api.system'
import { copyToClipboard, showMessage } from '@/utils'

const snapshot = ref<FinalContextSnapshot | null>(null)
const emptyMessage = ref('尚未捕获任何最终上下文。请先发起一次聊天请求。')
const isLoading = ref(false)
const searchText = ref('')
const activeBlockIndex = ref<number | null>(null)
const blockRefs = new Map<number, Element>()

const defaultOneRingConfig: OneRingConfig = {
  enabled: true,
  tailTagPlacement: 'inline',
  maxContextBlocks: 10,
  timeInsert: true,
}

const showOneRingConfigModal = ref(false)
const isOneRingConfigLoading = ref(false)
const isOneRingConfigSaving = ref(false)
const oneRingConfigDraft = ref<OneRingConfig>({ ...defaultOneRingConfig })

const blocks = computed(() => snapshot.value?.summary.blocks ?? [])

const roleCountsText = computed(() => {
  const counts = snapshot.value?.summary.roleCounts ?? {}
  return Object.entries(counts)
    .map(([role, count]) => `${normalizeRoleLabel(role)}: ${count}`)
    .join(' / ') || '-'
})

const normalizedSearch = computed(() => searchText.value.trim().toLowerCase())

const matchedBlocks = computed(() => {
  const keyword = normalizedSearch.value
  if (!keyword) return blocks.value

  return blocks.value.filter((block) => blockToSearchText(block).includes(keyword))
})

const filteredBlocks = computed(() => matchedBlocks.value)

async function loadSnapshot() {
  isLoading.value = true
  try {
    const response = await systemApi.getFinalContext(
      {},
      {
        showLoader: false,
        suppressErrorMessage: true,
      }
    )

    if (!response.available || !response.snapshot) {
      snapshot.value = null
      emptyMessage.value = response.message || '尚未捕获任何最终上下文。'
      return
    }

    snapshot.value = response.snapshot
    activeBlockIndex.value = response.snapshot.summary.blocks[0]?.index ?? null
    await nextTick()
    if (activeBlockIndex.value !== null) {
      scrollToBlock(activeBlockIndex.value, false)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emptyMessage.value = `加载最终上下文失败：${message}`
    showMessage(emptyMessage.value, 'error')
  } finally {
    isLoading.value = false
  }
}

function normalizeRoleLabel(role: string): string {
  const map: Record<string, string> = {
    system: 'SYSTEM 块',
    user: 'USER 块',
    assistant: 'AI 块',
    tool: 'TOOL 块',
  }
  return map[role] || `${role.toUpperCase()} 块`
}

function roleClass(role: string): string {
  return `role-${String(role || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
}

function getUserBlockBadge(block: FinalContextBlockSummary): { label: string; className: string } | null {
  if (block.role !== 'user') return null
  const text = String(block.text || '').trimStart()
  if (text.startsWith('[系统提示')) {
    return { label: '伪系统块', className: 'badge-pseudo-system' }
  }
  if (text.startsWith('[系统通知')) {
    return { label: '携带通知栏', className: 'badge-system-notice' }
  }
  return null
}

function jumpBlockLabel(block: FinalContextBlockSummary): string {
  const badge = getUserBlockBadge(block)
  if (badge) return badge.label
  return normalizeRoleLabel(block.role)
}

function userBlockJumpClass(block: FinalContextBlockSummary): string | null {
  const badge = getUserBlockBadge(block)
  return badge ? `jump-${badge.className}` : null
}

function attachmentCountsText(block: FinalContextBlockSummary): string {
  const counts = block.attachmentCounts || {}
  const entries = Object.entries(counts)
  if (entries.length === 0) {
    return block.attachments.map((item) => item.mediaType || item.type).join(', ')
  }
  return entries.map(([type, count]) => `${type} × ${count}`).join(', ')
}

function attachmentDescription(block: FinalContextBlockSummary): string {
  const countText = attachmentCountsText(block)
  const tokenText = block.attachmentTokenCount
    ? `，估算 ${formatNumber(block.attachmentTokenCount)} tokens`
    : ''
  return `本块包含多模态/非文本附件 ${block.attachments.length} 个：${countText}${tokenText}`
}

function formatNumber(value: number | undefined): string {
  return Number(value || 0).toLocaleString('zh-CN')
}

function blockToSearchText(block: FinalContextBlockSummary): string {
  return [
    String(block.index),
    block.role,
    normalizeRoleLabel(block.role),
    block.contentType,
    String(block.tokenCount || 0),
    String(block.textTokenCount || 0),
    String(block.attachmentTokenCount || 0),
    block.tokenMethod || '',
    block.text,
    attachmentCountsText(block),
  ].join('\n').toLowerCase()
}

function isBlockMatched(index: number): boolean {
  return matchedBlocks.value.some((block) => block.index === index)
}

function setBlockRef(index: number, el: Element | ComponentPublicInstance | null) {
  if (el instanceof Element) {
    blockRefs.set(index, el)
    return
  }

  blockRefs.delete(index)
}

function scrollToBlock(index: number, smooth = true) {
  activeBlockIndex.value = index
  const el = blockRefs.get(index)
  if (!el) return

  el.scrollIntoView({
    behavior: smooth ? 'smooth' : 'auto',
    block: 'center',
  })
}

function jumpToNextMatch() {
  jumpMatch(1)
}

function jumpToPreviousMatch() {
  jumpMatch(-1)
}

function jumpMatch(direction: 1 | -1) {
  const matches = matchedBlocks.value
  if (matches.length === 0) return

  const currentIndex = activeBlockIndex.value
  const currentMatchPosition = matches.findIndex((block) => block.index === currentIndex)
  const nextPosition =
    currentMatchPosition === -1
      ? 0
      : (currentMatchPosition + direction + matches.length) % matches.length

  scrollToBlock(matches[nextPosition].index)
}

async function openOneRingConfigModal() {
  showOneRingConfigModal.value = true
  isOneRingConfigLoading.value = true
  try {
    const response = await systemApi.getOneRingConfig(
      {},
      {
        showLoader: false,
        suppressErrorMessage: true,
      }
    )
    oneRingConfigDraft.value = {
      enabled: response.config.enabled,
      tailTagPlacement: response.config.tailTagPlacement,
      maxContextBlocks: response.config.maxContextBlocks,
      timeInsert: response.config.timeInsert,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`加载 OneRing 配置失败：${message}`, 'error')
  } finally {
    isOneRingConfigLoading.value = false
  }
}

function closeOneRingConfigModal() {
  if (isOneRingConfigSaving.value) return
  showOneRingConfigModal.value = false
}

async function saveOneRingConfig() {
  const normalizedConfig: OneRingConfig = {
    enabled: Boolean(oneRingConfigDraft.value.enabled),
    tailTagPlacement: oneRingConfigDraft.value.tailTagPlacement === 'system_user_block' ? 'system_user_block' : 'inline',
    maxContextBlocks: Math.max(1, Math.floor(Number(oneRingConfigDraft.value.maxContextBlocks) || defaultOneRingConfig.maxContextBlocks)),
    timeInsert: Boolean(oneRingConfigDraft.value.timeInsert),
  }

  isOneRingConfigSaving.value = true
  try {
    const response = await systemApi.saveOneRingConfig(normalizedConfig, {}, { showLoader: false })
    oneRingConfigDraft.value = { ...response.config }
    showOneRingConfigModal.value = false
    showMessage(response.message || 'OneRing 配置已保存', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`保存 OneRing 配置失败：${message}`, 'error')
  } finally {
    isOneRingConfigSaving.value = false
  }
}

async function copyVisibleText() {
  const text = filteredBlocks.value.map(formatBlockAsText).join('\n\n')
  const success = await copyToClipboard(text)
  showMessage(success ? '最终上下文可见文本已复制' : '复制失败，请手动选择文本复制', success ? 'success' : 'error')
}

function formatBlockAsText(block: FinalContextBlockSummary): string {
  const attachmentLine = block.attachments.length > 0
    ? `附件：${attachmentDescription(block)}\n`
    : ''

  return [
    `===== #${block.index} ${normalizeRoleLabel(block.role)} (${block.contentType}) =====`,
    `字符数：${formatNumber(block.textLength)}`,
    `Token：${formatNumber(block.tokenCount)} = 文本 ${formatNumber(block.textTokenCount)} + 附件估算 ${formatNumber(block.attachmentTokenCount)} (${block.tokenMethod || snapshot.value?.summary.tokenMethod || 'unknown'})`,
    attachmentLine,
    block.text || '(空文本块)',
  ].filter(Boolean).join('\n')
}

onMounted(() => {
  void loadSnapshot()
})
</script>

<style scoped>
.context-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: calc(var(--app-viewport-height, 100vh) - 140px);
}

.context-header,
.context-toolbar,
.summary-card,
.jump-index,
.context-block,
.empty-state {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
}

.context-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: 16px;
}

.context-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.context-title .material-symbols-outlined {
  font-size: 32px !important;
  color: var(--highlight-text);
}

.context-title h2 {
  margin: 0;
  font-size: var(--font-size-title);
}

.context-title p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.context-actions,
.search-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.context-toolbar {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: 12px 16px;
}

.context-search {
  flex: 1;
  min-width: 260px;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--primary-text);
}

.match-status {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.summary-card {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: var(--space-3);
  padding: 14px 16px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.summary-item.wide {
  grid-column: 1 / -1;
}

.summary-item span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.summary-item strong {
  color: var(--primary-text);
  word-break: break-all;
}

.jump-index {
  display: flex;
  gap: 8px;
  padding: 12px;
  overflow-x: auto;
}

.jump-chip {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  color: var(--primary-text);
  cursor: pointer;
}

.jump-chip.matched {
  border-color: var(--highlight-text);
}

.jump-chip.jump-badge-pseudo-system {
  border-color: var(--info-text);
  background: color-mix(in srgb, var(--info-bg) 70%, var(--tertiary-bg));
  color: var(--info-text);
}

.jump-chip.jump-badge-system-notice {
  border-color: var(--warning-text);
  background: color-mix(in srgb, var(--warning-bg) 70%, var(--tertiary-bg));
  color: var(--warning-text);
}

.jump-chip.active {
  background: var(--button-bg);
  color: var(--on-accent-text);
}

.block-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
}

.context-block {
  overflow: hidden;
}

.context-block.active {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.block-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--tertiary-bg);
}

.block-identity,
.block-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.block-index {
  color: var(--secondary-text);
  font-family: Consolas, Monaco, monospace;
}

.block-role {
  font-weight: 700;
}

.block-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-helper);
  font-weight: 700;
  border: 1px solid transparent;
}

.badge-pseudo-system {
  color: var(--info-text);
  background: var(--info-bg);
  border-color: var(--info-text);
}

.badge-system-notice {
  color: var(--warning-text);
  background: var(--warning-bg);
  border-color: var(--warning-text);
}

.block-type,
.block-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.attachment-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  color: var(--warning-text);
  background: var(--warning-bg);
  border-bottom: 1px solid var(--border-color);
}

.block-content {
  margin: 0;
  padding: 16px;
  max-height: 520px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.55;
  color: var(--primary-text);
  background: var(--primary-bg);
}

.role-system .block-role {
  color: var(--info-text);
}

.role-user .block-role {
  color: var(--success-text);
}

.role-assistant .block-role {
  color: var(--highlight-text);
}

.role-tool .block-role {
  color: var(--warning-text);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.5);
}

.onering-modal {
  width: min(620px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  box-shadow: var(--shadow-lg);
}

.modal-header,
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
}

.modal-header p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--tertiary-bg);
  color: var(--primary-text);
  cursor: pointer;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 16px;
}

.config-field,
.config-toggle-row {
  display: flex;
  gap: var(--space-2);
}

.config-field {
  flex-direction: column;
}

.config-field span,
.config-toggle-row strong {
  color: var(--primary-text);
}

.config-field input,
.config-field select {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
}

.config-toggle-row {
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.config-toggle-row input {
  margin-top: 3px;
}

.config-toggle-row span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-toggle-row small {
  color: var(--secondary-text);
}

.modal-actions {
  justify-content: flex-end;
  border-top: 1px solid var(--border-color);
  border-bottom: 0;
}

.empty-state {
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex-direction: column;
  color: var(--secondary-text);
}

.empty-state .material-symbols-outlined {
  font-size: 48px !important;
  opacity: 0.7;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .context-header,
  .context-toolbar,
  .block-header {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-card {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }
}

@media (max-width: 560px) {
  .summary-card {
    grid-template-columns: 1fr;
  }

  .context-search {
    min-width: 0;
  }
}
</style>
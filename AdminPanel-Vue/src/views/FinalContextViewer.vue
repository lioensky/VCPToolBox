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
          <label v-if="snapshotList.length > 0" class="snapshot-selector">
            <span class="material-symbols-outlined">history</span>
            <select :value="selectedSnapshotId" @change="onSnapshotSelectChange">
              <option
                v-for="item in snapshotList"
                :key="item.id"
                :value="item.id"
              >
                #{{ item.id }} · {{ formatSnapshotLabel(item) }}
              </option>
            </select>
            <small>{{ snapshotList.length }} / {{ maxSnapshots }} 缓存</small>
          </label>
          <button type="button" class="btn-secondary" @click="openOneRingConfigModal" :disabled="isOneRingConfigLoading">
            <span class="material-symbols-outlined" :class="{ spinning: isOneRingConfigLoading }">settings</span>
            ORing配置
          </button>
          <button type="button" class="btn-secondary" @click="refreshList" :disabled="isLoading">
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
          <div class="summary-item wide">
            <span>OneRing 来源</span>
            <strong>{{ oneRingSourcesSummary }}</strong>
          </div>
        </section>

        <section v-if="oneRingSourceStats.length > 0" class="onering-source-panel" aria-label="OneRing 分布式来源总览">
          <div class="onering-source-title">
            <span class="material-symbols-outlined">hub</span>
            <div>
              <strong>OneRing 分布式上下文来源</strong>
              <small>仅渲染已检测到的来源标记；无标记块保持原样，避免误判。</small>
            </div>
          </div>
          <div class="onering-source-list">
            <button
              v-for="source in oneRingSourceStats"
              :key="source.key"
              type="button"
              class="onering-source-chip"
              @click="scrollToBlock(source.firstBlockIndex)"
            >
              <span class="source-frontend">{{ source.frontendSource }}</span>
              <span class="source-count">{{ source.count }} 块</span>
              <span class="source-senders">{{ source.senders.join(' / ') }}</span>
            </button>
          </div>
        </section>

        <nav class="jump-index" :class="{ 'jump-index-dense': useDenseJumpIndex }" aria-label="上下文块跳转索引">
          <button
            v-for="block in visibleBlocks"
            :key="`jump-${block.index}`"
            type="button"
            class="jump-chip"
            :title="jumpChipTitle(block)"
            :class="[roleClass(displayRole(block)), userBlockJumpClass(block), oneRingJumpClass(block), { matched: isBlockMatched(block.index), active: activeBlockIndex === block.index }]"
            @click="scrollToBlock(block.index)"
          >
            <span class="jump-main">
              <span class="jump-index-number">#{{ block.index }}</span>
              <span class="jump-speaker">{{ jumpSpeakerLabel(block) }}</span>
            </span>
            <span class="jump-source-line">
              {{ jumpSourceLabel(block) }}
            </span>
          </button>
        </nav>

        <main class="block-list">
          <article
            v-for="block in filteredBlocks"
            :key="block.index"
            :ref="(el) => setBlockRef(block.index, el)"
            class="context-block"
            :class="[roleClass(displayRole(block)), oneRingBlockClass(block), { active: activeBlockIndex === block.index }]"
          >
            <header class="block-header">
              <div class="block-identity">
                <span class="block-index">#{{ block.index }}</span>
                <span class="block-role">{{ normalizeRoleLabel(displayRole(block)) }}</span>
                <span v-if="getUserBlockBadge(block)" class="block-badge" :class="getUserBlockBadge(block)?.className">
                  {{ getUserBlockBadge(block)?.label }}
                </span>
                <span v-if="getDisplayOneRingMeta(block)" class="block-badge badge-onering-source">
                  {{ getDisplayOneRingMeta(block)?.isDetachedUserMarker ? '分离User标记' : 'OneRing来源' }}
                </span>
                <span class="block-type">{{ block.contentType }}</span>
              </div>
              <div class="block-header-right">
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
                <button
                  v-if="displayRole(block) === 'assistant'"
                  type="button"
                  class="moonlight-run-button"
                  title="以本 AI 块为 query，运行池月1号上下文分布验证"
                  aria-label="池月1号算法验证"
                  @click="runMoonlightForBlock(block)"
                >
                  <span class="material-symbols-outlined">monitoring</span>
                  池月1号
                </button>
                <button
                  type="button"
                  class="block-copy-button"
                  title="复制本块"
                  aria-label="复制本块"
                  @click="copySingleBlock(block)"
                >
                  <span class="material-symbols-outlined">content_copy</span>
                </button>
              </div>
            </header>

            <div v-if="block.attachments.length > 0" class="attachment-panel">
              <span class="material-symbols-outlined">attachment</span>
              <span>{{ attachmentDescription(block) }}</span>
            </div>

            <div v-if="getDisplayOneRingMeta(block)" class="onering-meta-panel">
              <span class="material-symbols-outlined">travel_explore</span>
              <div class="onering-meta-content">
                <strong>{{ oneRingMetaTitle(block) }}</strong>
                <div class="onering-meta-grid">
                  <span v-if="getDisplayOneRingMeta(block)?.senderName">发送者：{{ getDisplayOneRingMeta(block)?.senderName }}</span>
                  <span v-if="getDisplayOneRingMeta(block)?.timestamp">时间：{{ getDisplayOneRingMeta(block)?.timestamp }}</span>
                  <span v-if="getDisplayOneRingMeta(block)?.frontendSource">前端：{{ getDisplayOneRingMeta(block)?.frontendSource }}</span>
                  <span v-if="getDisplayOneRingMeta(block)?.isDetachedUserMarker">来源来自后续分离 user 标记</span>
                  <span v-if="getDisplayOneRingMeta(block)?.isNewConversationStart">新对话起点</span>
                </div>
              </div>
            </div>

            <pre class="block-content">{{ block.text || '(空文本块)' }}</pre>
          </article>
        </main>
      </template>
    </div>

    <div v-if="showMoonlightModal && moonlightReport" class="modal-backdrop" @click.self="closeMoonlightModal">
      <section class="moonlight-modal" role="dialog" aria-modal="true" aria-labelledby="moonlight-report-title">
        <header class="modal-header moonlight-modal-header">
          <div class="moonlight-title">
            <span class="material-symbols-outlined">monitoring</span>
            <div>
              <h3 id="moonlight-report-title">池月1号算法验证：#{{ moonlightReport.selectedBlockIndex }}</h3>
              <p>基于选中 AI 块之前的上下文，统计词项证据分布与 system 提示词材料关联；此处为外部可观测代理，不等同模型内部注意力。</p>
            </div>
          </div>
          <div class="moonlight-modal-actions">
            <button type="button" class="btn-secondary" @click="copyMoonlightReportJson">
              复制 JSON
            </button>
            <button type="button" class="btn-secondary" @click="copyMoonlightReportMarkdown">
              复制 MD
            </button>
            <button type="button" class="icon-button" aria-label="关闭" @click="closeMoonlightModal">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
        </header>

        <div class="moonlight-modal-body">
          <section class="moonlight-metrics">
            <div class="moonlight-metric">
              <span>上下文注意力代理</span>
              <strong>{{ formatPercent(moonlightReport.metrics.contextAttentionProxy) }}</strong>
            </div>
            <div class="moonlight-metric">
              <span>System遵循代理</span>
              <strong>{{ formatPercent(moonlightReport.metrics.systemAdherenceProxy) }}</strong>
            </div>
            <div class="moonlight-metric warning">
              <span>自激回声风险</span>
              <strong>{{ formatPercent(moonlightReport.metrics.selfEchoRisk) }}</strong>
            </div>
            <div class="moonlight-metric warning">
              <span>空洞总结风险</span>
              <strong>{{ formatPercent(moonlightReport.metrics.hollowSummaryRisk) }}</strong>
            </div>
            <div class="moonlight-metric">
              <span>覆盖率</span>
              <strong>{{ formatPercent(moonlightReport.metrics.coverage) }}</strong>
            </div>
            <div class="moonlight-metric">
              <span>最大空洞</span>
              <strong>{{ moonlightReport.metrics.gapMax }} 块</strong>
            </div>
            <div class="moonlight-metric">
              <span>外部证据占比</span>
              <strong>{{ formatPercent(moonlightReport.metrics.externalSupportRatio) }}</strong>
            </div>
            <div class="moonlight-metric">
              <span>System占比</span>
              <strong>{{ formatPercent(moonlightReport.metrics.systemSupportRatio) }}</strong>
            </div>
          </section>

          <div class="moonlight-labels">
            <span v-for="label in moonlightReport.labels" :key="label" class="moonlight-label">
              {{ label }}
            </span>
          </div>

          <section class="moonlight-config">
            <label>
              <span>移除最高频词</span>
              <input v-model.number="moonlightOptions.topStopwordCount" type="number" min="0" max="200" step="1" />
            </label>
            <label>
              <span>最小词长</span>
              <input v-model.number="moonlightOptions.minTermLength" type="number" min="1" max="8" step="1" />
            </label>
            <label>
              <input v-model="moonlightOptions.useCharBigrams" type="checkbox" />
              <span>中文2-gram</span>
            </label>
            <label>
              <input v-model="moonlightOptions.useCharTrigrams" type="checkbox" />
              <span>中文3-gram</span>
            </label>
            <button type="button" class="btn-secondary" @click="rerunMoonlightWithCurrentOptions">
              应用配置重算
            </button>
          </section>

          <section class="moonlight-spectrum" aria-label="线性证据密度图">
            <div class="moonlight-section-title">
              <strong>线性证据密度图</strong>
              <small>将此前上下文按净化后文本长度压成一条线性轴；宽度代表文本占比，亮度代表加权命中强度。</small>
            </div>
            <div class="moonlight-linear-map" role="img" aria-label="池月线性证据密度图">
              <button
                v-for="segment in moonlightReport.linearSegments"
                :key="`moonlight-linear-${segment.blockIndex}`"
                type="button"
                class="moonlight-linear-segment"
                :class="roleClass(segment.displayRole)"
                :title="moonlightLinearSegmentTitle(segment)"
                :style="{
                  '--segment-width': `${segment.widthRatio * 100}%`,
                  '--segment-alpha': String(0.16 + segment.normalizedWeightedScore * 0.78)
                }"
                @click="jumpFromMoonlightModal(segment.blockIndex)"
              >
                <span class="moonlight-linear-heat"></span>
              </button>
            </div>
            <div v-if="moonlightReport.curvePoints.length > 0" class="moonlight-curve-card" role="img" aria-label="池月线性注意力代理曲线图">
              <svg class="moonlight-curve-svg" viewBox="0 0 1000 220" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="moonlightCurveFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="currentColor" stop-opacity="0.26" />
                    <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
                  </linearGradient>
                </defs>
                <line x1="0" y1="190" x2="1000" y2="190" class="moonlight-curve-axis" />
                <line x1="0" y1="30" x2="1000" y2="30" class="moonlight-curve-guide strong" />
                <line x1="0" y1="110" x2="1000" y2="110" class="moonlight-curve-guide" />
                <line x1="0" y1="150" x2="1000" y2="150" class="moonlight-curve-guide" />
                <path class="moonlight-curve-fill" :d="moonlightCurveFillPath" />
                <path class="moonlight-curve-line" :d="moonlightCurveLinePath" />
              </svg>
              <button
                v-for="point in moonlightReport.curvePoints"
                :key="`moonlight-curve-${point.blockIndex}`"
                type="button"
                class="moonlight-curve-point"
                :class="[roleClass(point.displayRole), { peak: point.isPeak, valley: point.isValley }]"
                :title="moonlightCurvePointTitle(point)"
                :style="{
                  '--point-x': `${point.x * 100}%`,
                  '--point-y': `${(1 - point.y) * 100}%`,
                  '--point-size': `${point.isPeak ? 14 : point.isValley ? 11 : 8}px`
                }"
                @click="jumpFromMoonlightModal(point.blockIndex)"
              >
                <span class="moonlight-curve-point-label">#{{ point.blockIndex }}</span>
              </button>
            </div>
            <div class="moonlight-linear-legend">
              <span><i class="legend-system"></i>SYSTEM</span>
              <span><i class="legend-user"></i>USER</span>
              <span><i class="legend-assistant"></i>AI历史</span>
              <span><i class="legend-tool"></i>TOOL</span>
              <span><i class="legend-peak"></i>波峰</span>
              <span><i class="legend-valley"></i>波谷</span>
            </div>
          </section>

          <section class="moonlight-spectrum" aria-label="全上下文证据分布光谱">
            <div class="moonlight-section-title">
              <strong>全上下文块级光谱</strong>
              <small>柱高为加权 BM25；颜色继承块角色。点击柱可跳转到对应上下文块并关闭模态窗。</small>
            </div>
            <div class="moonlight-bars">
              <button
                v-for="score in moonlightReport.scores"
                :key="`moonlight-score-${score.blockIndex}`"
                type="button"
                class="moonlight-bar"
                :class="roleClass(score.displayRole)"
                :title="moonlightScoreTitle(score)"
                :style="{ '--bar-height': `${Math.max(4, Math.round(score.normalizedWeightedScore * 100))}%` }"
                @click="jumpFromMoonlightModal(score.blockIndex)"
              >
                <span class="moonlight-bar-fill"></span>
                <span class="moonlight-bar-label">#{{ score.blockIndex }}</span>
              </button>
            </div>
          </section>

          <section class="moonlight-spectrum" aria-label="System 提示词材料关联光谱">
            <div class="moonlight-section-title">
              <strong>System 提示词关联</strong>
              <small>只展示 system 块命中，用于验证 AI 输出与系统提示词材料/术语的可观测关联。</small>
            </div>
            <div v-if="moonlightReport.systemScores.length > 0" class="moonlight-bars compact">
              <button
                v-for="score in moonlightReport.systemScores"
                :key="`moonlight-system-${score.blockIndex}`"
                type="button"
                class="moonlight-bar role-system"
                :title="moonlightScoreTitle(score)"
                :style="{ '--bar-height': `${Math.max(4, Math.round(score.normalizedWeightedScore * 100))}%` }"
                @click="jumpFromMoonlightModal(score.blockIndex)"
              >
                <span class="moonlight-bar-fill"></span>
                <span class="moonlight-bar-label">#{{ score.blockIndex }}</span>
              </button>
            </div>
            <p v-else class="moonlight-empty-line">此前上下文中没有可索引的 system 块。</p>
          </section>

          <section class="moonlight-term-grid">
            <div>
              <strong>保留高贡献词</strong>
              <span v-for="term in moonlightReport.query.topQueryTerms.slice(0, 24)" :key="`top-${term.term}`" class="term-chip">
                {{ term.term }} · idf {{ term.idf.toFixed(2) }}
              </span>
            </div>
            <div>
              <strong>被移除高频词</strong>
              <span v-for="term in moonlightReport.query.removedHighFrequencyTerms.slice(0, 24)" :key="`removed-${term.term}`" class="term-chip muted">
                {{ term.term }} · {{ term.corpusFrequency }}
              </span>
            </div>
            <div>
              <strong>数字/版本/标识符</strong>
              <span v-for="term in moonlightSpecialTerms" :key="`special-${term.term}`" class="term-chip info">
                {{ term.term }} · df {{ term.documentFrequency }}
              </span>
            </div>
            <div>
              <strong>零命中具体词</strong>
              <span v-for="term in moonlightReport.query.zeroHitTerms.slice(0, 24)" :key="`zero-${term.term}`" class="term-chip danger">
                {{ term.term }}
              </span>
            </div>
          </section>
        </div>
      </section>
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
import { computed, nextTick, onMounted, reactive, ref, type ComponentPublicInstance } from 'vue'
import { systemApi } from '@/api'
import type { FinalContextBlockSummary, FinalContextListItem, FinalContextSnapshot, OneRingConfig } from '@/types/api.system'
import { copyToClipboard, showMessage } from '@/utils'
import {
  getDefaultMoonlightOptions,
  runMoonlightAnalysis,
  type MoonlightBlockScore,
  type MoonlightCurvePoint,
  type MoonlightLinearSegment,
  type MoonlightReport,
  type MoonlightTermStat,
} from '@/utils/moonlight'

const snapshot = ref<FinalContextSnapshot | null>(null)
const emptyMessage = ref('尚未捕获任何最终上下文。请先发起一次聊天请求。')
const isLoading = ref(false)
const searchText = ref('')
const activeBlockIndex = ref<number | null>(null)
const blockRefs = new Map<number, Element>()
const snapshotList = ref<FinalContextListItem[]>([])
const selectedSnapshotId = ref<number | null>(null)
const maxSnapshots = ref(5)

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
const moonlightOptions = reactive(getDefaultMoonlightOptions())
const moonlightReport = ref<MoonlightReport | null>(null)
const showMoonlightModal = ref(false)
const moonlightSelectedBlock = ref<FinalContextBlockSummary | null>(null)

const blocks = computed(() => snapshot.value?.summary.blocks ?? [])
const visibleBlocks = computed(() => blocks.value.filter((block) => !isDetachedAssistantOneRingMarker(block)))
const useDenseJumpIndex = computed(() => visibleBlocks.value.length > 10)

interface OneRingBlockMeta {
  senderName?: string
  timestamp?: string
  frontendSource?: string
  isNewConversationStart?: boolean
  isAssistantSystemUserBlock?: boolean
  isDetachedUserMarker?: boolean
}

interface OneRingSourceStat {
  key: string
  frontendSource: string
  count: number
  firstBlockIndex: number
  senders: string[]
}

const oneRingMetaCache = new WeakMap<FinalContextBlockSummary, OneRingBlockMeta | null>()

const roleCountsText = computed(() => {
  const counts = snapshot.value?.summary.roleCounts ?? {}
  return Object.entries(counts)
    .map(([role, count]) => `${normalizeRoleLabel(role)}: ${count}`)
    .join(' / ') || '-'
})

const oneRingSourceStats = computed<OneRingSourceStat[]>(() => {
  const stats = new Map<string, OneRingSourceStat & { senderSet: Set<string> }>()
  for (const block of visibleBlocks.value) {
    const meta = getDisplayOneRingMeta(block)
    if (!meta?.frontendSource) continue

    const key = meta.frontendSource.toLowerCase()
    const existing = stats.get(key)
    if (existing) {
      existing.count += 1
      if (meta.senderName) existing.senderSet.add(meta.senderName)
      continue
    }

    stats.set(key, {
      key,
      frontendSource: meta.frontendSource,
      count: 1,
      firstBlockIndex: block.index,
      senders: [],
      senderSet: new Set(meta.senderName ? [meta.senderName] : []),
    })
  }

  return [...stats.values()]
    .map((item) => ({
      key: item.key,
      frontendSource: item.frontendSource,
      count: item.count,
      firstBlockIndex: item.firstBlockIndex,
      senders: [...item.senderSet].slice(0, 4),
    }))
    .sort((a, b) => b.count - a.count || a.firstBlockIndex - b.firstBlockIndex)
})

const oneRingSourcesSummary = computed(() => {
  if (oneRingSourceStats.value.length === 0) return '未检测到 OneRing 来源标记'
  return oneRingSourceStats.value
    .map((source) => `${source.frontendSource}: ${source.count}`)
    .join(' / ')
})

const moonlightCurveLinePath = computed(() => {
  const points = moonlightReport.value?.curvePoints ?? []
  return buildMoonlightCurvePath(points)
})

const moonlightCurveFillPath = computed(() => {
  const points = moonlightReport.value?.curvePoints ?? []
  const linePath = buildMoonlightCurvePath(points)
  if (!linePath || points.length === 0) return ''
  const first = curvePointToSvg(points[0])
  const last = curvePointToSvg(points[points.length - 1])
  return `${linePath} L ${last.x.toFixed(2)} 190 L ${first.x.toFixed(2)} 190 Z`
})

const moonlightSpecialTerms = computed<MoonlightTermStat[]>(() => {
  if (!moonlightReport.value) return []
  const seen = new Set<string>()
  return [
    ...moonlightReport.value.query.numericTerms,
    ...moonlightReport.value.query.identifierTerms,
  ].filter((term) => {
    if (seen.has(term.term)) return false
    seen.add(term.term)
    return true
  }).slice(0, 20)
})

const normalizedSearch = computed(() => searchText.value.trim().toLowerCase())

const matchedBlocks = computed(() => {
  const keyword = normalizedSearch.value
  if (!keyword) return visibleBlocks.value

  return visibleBlocks.value.filter((block) => blockToSearchText(block).includes(keyword))
})

const filteredBlocks = computed(() => matchedBlocks.value)

function formatSnapshotLabel(item: FinalContextListItem): string {
  const captured = item.capturedAt || ''
  const time = captured ? captured.replace('T', ' ').replace(/\.\d+Z?$/, '') : '-'
  const model = item.summary?.model || 'unknown'
  const tokens = formatNumber(item.summary?.totalTokenCount || 0)
  return `${time} · ${model} · ${tokens} tokens`
}

async function loadSnapshot(targetId?: number | null) {
  isLoading.value = true
  try {
    const idArg = (targetId === null || targetId === undefined) ? undefined : targetId
    const response = await systemApi.getFinalContext(
      {},
      {
        showLoader: false,
        suppressErrorMessage: true,
      },
      idArg
    )

    if (Array.isArray(response.list)) {
      snapshotList.value = response.list
    }
    if (typeof response.maxSnapshots === 'number' && response.maxSnapshots > 0) {
      maxSnapshots.value = response.maxSnapshots
    }

    if (!response.available || !response.snapshot) {
      snapshot.value = null
      selectedSnapshotId.value = null
      emptyMessage.value = response.message || '尚未捕获任何最终上下文。'
      return
    }

    snapshot.value = response.snapshot
    selectedSnapshotId.value = response.snapshot.id ?? null
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

function runMoonlightForBlock(block: FinalContextBlockSummary) {
  if (displayRole(block) !== 'assistant') {
    showMessage('池月1号第一期仅支持选择 AI/Assistant 块作为验证对象', 'error')
    return
  }

  try {
    moonlightSelectedBlock.value = block
    moonlightReport.value = runMoonlightAnalysis(
      blocks.value,
      block,
      { ...moonlightOptions },
      displayRole
    )
    showMoonlightModal.value = true
    activeBlockIndex.value = block.index
    showMessage(`池月1号已完成 #${block.index} 的上下文分布验证`, 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`池月1号验证失败：${message}`, 'error')
  }
}

function closeMoonlightModal() {
  showMoonlightModal.value = false
}

function rerunMoonlightWithCurrentOptions() {
  if (!moonlightSelectedBlock.value) return
  runMoonlightForBlock(moonlightSelectedBlock.value)
}

function jumpFromMoonlightModal(index: number) {
  closeMoonlightModal()
  void nextTick(() => scrollToBlock(index))
}

async function copyMoonlightReportJson() {
  if (!moonlightReport.value) return
  const success = await copyToClipboard(JSON.stringify(moonlightReport.value, null, 2))
  showMessage(success ? '池月报告 JSON 已复制' : '复制 JSON 失败', success ? 'success' : 'error')
}

async function copyMoonlightReportMarkdown() {
  if (!moonlightReport.value) return
  const success = await copyToClipboard(formatMoonlightReportAsMarkdown(moonlightReport.value))
  showMessage(success ? '池月报告 Markdown 已复制' : '复制 Markdown 失败', success ? 'success' : 'error')
}

function formatMoonlightReportAsMarkdown(report: MoonlightReport): string {
  const topScores = report.scores
    .filter((score) => score.rawScore > 0)
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, 12)

  return [
    `# 池月1号算法验证报告 #${report.selectedBlockIndex}`,
    '',
    '> 说明：本报告为基于可观测上下文文本的词项证据分布统计，不等同模型内部真实注意力。',
    '',
    '## 核心指标',
    '',
    `- 上下文注意力代理：${formatPercent(report.metrics.contextAttentionProxy)}`,
    `- System遵循代理：${formatPercent(report.metrics.systemAdherenceProxy)}`,
    `- 自激回声风险：${formatPercent(report.metrics.selfEchoRisk)}`,
    `- 空洞总结风险：${formatPercent(report.metrics.hollowSummaryRisk)}`,
    `- 覆盖率：${formatPercent(report.metrics.coverage)}`,
    `- 最大空洞：${report.metrics.gapMax} 块`,
    `- 外部证据占比：${formatPercent(report.metrics.externalSupportRatio)}`,
    `- System占比：${formatPercent(report.metrics.systemSupportRatio)}`,
    '',
    '## 诊断标签',
    '',
    ...report.labels.map((label) => `- ${label}`),
    '',
    '## Query 统计',
    '',
    `- 原始长度：${report.query.rawLength}`,
    `- 净化后长度：${report.query.sanitizedLength}`,
    `- 原始词项数：${report.query.rawTermCount}`,
    `- 保留词项数：${report.query.retainedTermCount}`,
    `- 唯一保留词项数：${report.query.uniqueRetainedTermCount}`,
    '',
    '## Top 命中块',
    '',
    '| Block | Role | Raw | Weighted | 命中词 |',
    '|---:|---|---:|---:|---|',
    ...topScores.map((score) => `| #${score.blockIndex} | ${score.displayRole} | ${score.rawScore.toFixed(2)} | ${score.weightedScore.toFixed(2)} | ${score.matchedTerms.slice(0, 8).map((term) => term.term).join(' / ')} |`),
    '',
    '## 保留高贡献词',
    '',
    report.query.topQueryTerms.slice(0, 32).map((term) => `\`${term.term}\`(${term.idf.toFixed(2)})`).join(' '),
    '',
    '## 被移除高频词',
    '',
    report.query.removedHighFrequencyTerms.slice(0, 32).map((term) => `\`${term.term}\`(${term.corpusFrequency})`).join(' '),
    '',
    '## 零命中具体词',
    '',
    report.query.zeroHitTerms.slice(0, 32).map((term) => `\`${term.term}\``).join(' '),
  ].join('\n')
}

function formatPercent(value: number | undefined): string {
  return `${Math.round(Number(value || 0) * 100)}%`
}

function moonlightLinearSegmentTitle(segment: MoonlightLinearSegment): string {
  return `#${segment.blockIndex} ${normalizeRoleLabel(segment.displayRole)}｜文本占比 ${(segment.widthRatio * 100).toFixed(2)}%｜weighted ${segment.weightedScore.toFixed(2)}｜命中 ${segment.matchedTermCount}｜${segment.textPreview || '空预览'}`
}

function moonlightCurvePointTitle(point: MoonlightCurvePoint): string {
  const shape = point.isPeak ? '｜波峰' : point.isValley ? '｜波谷' : ''
  return `#${point.blockIndex} ${normalizeRoleLabel(point.displayRole)}${shape}｜线性位置 ${(point.x * 100).toFixed(2)}%｜强度 ${Math.round(point.y * 100)}%｜weighted ${point.weightedScore.toFixed(2)}｜命中 ${point.matchedTermCount}｜${point.textPreview || '空预览'}`
}

function buildMoonlightCurvePath(points: MoonlightCurvePoint[]): string {
  if (points.length === 0) return ''

  const svgPoints = points.map(curvePointToSvg)
  const firstPoint = svgPoints[0]
  const lastPoint = svgPoints[svgPoints.length - 1]
  const anchoredPoints = [
    { x: 0, y: firstPoint.y },
    ...svgPoints,
    { x: 1000, y: lastPoint.y },
  ]

  if (anchoredPoints.length === 1) {
    const point = anchoredPoints[0]
    return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  }

  const commands = [`M ${anchoredPoints[0].x.toFixed(2)} ${anchoredPoints[0].y.toFixed(2)}`]

  for (let index = 1; index < anchoredPoints.length; index += 1) {
    const previous = anchoredPoints[index - 1]
    const current = anchoredPoints[index]
    const controlX = (previous.x + current.x) / 2
    commands.push(`C ${controlX.toFixed(2)} ${previous.y.toFixed(2)}, ${controlX.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`)
  }

  return commands.join(' ')
}

function curvePointToSvg(point: MoonlightCurvePoint): { x: number; y: number } {
  return {
    x: point.x * 1000,
    y: 190 - (point.y * 160),
  }
}

function moonlightScoreTitle(score: MoonlightBlockScore): string {
  const terms = score.matchedTerms.slice(0, 8).map((term) => term.term).join(' / ') || '无命中词'
  return `#${score.blockIndex} ${normalizeRoleLabel(score.displayRole)}｜raw ${score.rawScore.toFixed(2)}｜weighted ${score.weightedScore.toFixed(2)}｜命中 ${score.matchedTermCount}｜${terms}`
}

async function refreshList() {
  // 刷新优先取列表，但展示当前选中的快照（若仍存在）；否则取最新一条
  try {
    const listResponse = await systemApi.listFinalContexts({}, { showLoader: false, suppressErrorMessage: true })
    snapshotList.value = listResponse.list || []
    if (typeof listResponse.maxSnapshots === 'number' && listResponse.maxSnapshots > 0) {
      maxSnapshots.value = listResponse.maxSnapshots
    }
    const stillExists = selectedSnapshotId.value !== null
      && snapshotList.value.some(item => item.id === selectedSnapshotId.value)
    await loadSnapshot(stillExists ? selectedSnapshotId.value : null)
  } catch (error) {
    // 列表查询失败时回退到 loadSnapshot 默认行为
    await loadSnapshot()
  }
}

function onSnapshotSelectChange(event: Event) {
  const target = event.target as HTMLSelectElement | null
  if (!target) return
  const numericId = Number(target.value)
  if (!Number.isFinite(numericId)) return
  selectedSnapshotId.value = numericId
  void loadSnapshot(numericId)
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

function isToolSummaryUserBlock(block: FinalContextBlockSummary): boolean {
  if (block.role !== 'user') return false

  const text = String(block.text || '')
  return text.includes('[本轮工具调用摘要:]') && text.includes('[本轮工具调用摘要结束]')
}

function displayRole(block: FinalContextBlockSummary): string {
  return isToolSummaryUserBlock(block) ? 'tool' : block.role
}

function roleClass(role: string): string {
  return `role-${String(role || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
}

function jumpChipTitle(block: FinalContextBlockSummary): string {
  const meta = getDisplayOneRingMeta(block)
  const sourceText = meta?.frontendSource ? `｜${meta.frontendSource}` : ''
  const senderText = meta?.senderName ? `｜${meta.senderName}` : ''
  return `#${block.index} ${normalizeRoleLabel(displayRole(block))}${senderText}${sourceText}｜${formatNumber(block.tokenCount)} tokens`
}

function getUserBlockBadge(block: FinalContextBlockSummary): { label: string; className: string } | null {
  if (displayRole(block) !== 'user') return null
  const text = String(block.text || '').trimStart()
  const oneRingMeta = getOneRingMeta(block)
  if (oneRingMeta?.isAssistantSystemUserBlock) {
    return { label: 'AI来源提示', className: 'badge-ai-source-notice' }
  }
  if (text.startsWith('[系统提示')) {
    return { label: '伪系统块', className: 'badge-pseudo-system' }
  }
  if (text.startsWith('[系统通知')) {
    return { label: '携带通知栏', className: 'badge-system-notice' }
  }
  return null
}

function jumpSpeakerLabel(block: FinalContextBlockSummary): string {
  const roleLabel = normalizeRoleLabel(displayRole(block)).replace(' 块', '')
  const oneRingMeta = getDisplayOneRingMeta(block)
  if (oneRingMeta?.senderName) return `${roleLabel}/${oneRingMeta.senderName}`

  const badge = getUserBlockBadge(block)
  if (badge) return `${roleLabel}/${badge.label}`

  return roleLabel
}

function jumpSourceLabel(block: FinalContextBlockSummary): string {
  const oneRingMeta = getDisplayOneRingMeta(block)
  if (oneRingMeta?.frontendSource) return oneRingMeta.frontendSource

  const badge = getUserBlockBadge(block)
  if (badge) return '系统标记'

  return '直接上下文'
}

function userBlockJumpClass(block: FinalContextBlockSummary): string | null {
  const badge = getUserBlockBadge(block)
  return badge ? `jump-${badge.className}` : null
}

function getOneRingMeta(block: FinalContextBlockSummary): OneRingBlockMeta | null {
  if (oneRingMetaCache.has(block)) return oneRingMetaCache.get(block) ?? null

  const text = String(block.text || '')
  const systemUserBlockMeta = extractAssistantSystemUserBlockMeta(text)
  if (systemUserBlockMeta) {
    oneRingMetaCache.set(block, systemUserBlockMeta)
    return systemUserBlockMeta
  }

  const inlineMeta = extractInlineOneRingMeta(text)
  if (inlineMeta) {
    oneRingMetaCache.set(block, inlineMeta)
    return inlineMeta
  }

  oneRingMetaCache.set(block, null)
  return null
}

function extractInlineOneRingMeta(text: string): OneRingBlockMeta | null {
  const regex = /\[OneRing通知:([\s\S]*?)于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)发送于([^\]；]*?)(；这是一个新对话的起点)?\]/g
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    last = match
  }

  if (!last) return null
  return {
    senderName: last[1]?.trim(),
    timestamp: last[2]?.trim(),
    frontendSource: last[3]?.trim(),
    isNewConversationStart: Boolean(last[4]),
  }
}

function extractAssistantSystemUserBlockMeta(text: string): OneRingBlockMeta | null {
  const match = /^\s*\[系统提示:\]\[OneRing通知:上一条消息由([\s\S]*?)于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)发送于([^\]]*?)\]\s*$/.exec(text)
  if (!match) return null

  return {
    senderName: match[1]?.trim(),
    timestamp: match[2]?.trim(),
    frontendSource: match[3]?.trim(),
    isAssistantSystemUserBlock: true,
  }
}

function oneRingBlockClass(block: FinalContextBlockSummary): string | null {
  const meta = getDisplayOneRingMeta(block)
  if (!meta) return null
  return meta.isDetachedUserMarker ? 'has-onering-ai-source' : 'has-onering-source'
}

function oneRingJumpClass(block: FinalContextBlockSummary): string | null {
  const meta = getDisplayOneRingMeta(block)
  if (!meta) return null
  return meta.isDetachedUserMarker ? 'jump-has-onering-ai-source' : 'jump-has-onering-source'
}

function getDisplayOneRingMeta(block: FinalContextBlockSummary): OneRingBlockMeta | null {
  const ownMeta = getOneRingMeta(block)
  if (ownMeta && !ownMeta.isAssistantSystemUserBlock) return ownMeta

  if (block.role !== 'assistant') return ownMeta
  const nextBlock = getNextBlock(block)
  const nextMeta = nextBlock ? getOneRingMeta(nextBlock) : null
  if (nextMeta?.isAssistantSystemUserBlock) {
    return {
      ...nextMeta,
      isDetachedUserMarker: true,
    }
  }

  return ownMeta
}

function getNextBlock(block: FinalContextBlockSummary): FinalContextBlockSummary | null {
  const index = blocks.value.findIndex((item) => item === block || item.index === block.index)
  return index >= 0 ? blocks.value[index + 1] || null : null
}

function isDetachedAssistantOneRingMarker(block: FinalContextBlockSummary): boolean {
  const meta = getOneRingMeta(block)
  if (!meta?.isAssistantSystemUserBlock) return false

  const index = blocks.value.findIndex((item) => item === block || item.index === block.index)
  const previousBlock = index > 0 ? blocks.value[index - 1] : null
  return previousBlock?.role === 'assistant'
}

function oneRingMetaTitle(block: FinalContextBlockSummary): string {
  const meta = getDisplayOneRingMeta(block)
  if (!meta) return ''
  return meta.isDetachedUserMarker
    ? 'OneRing：AI 来源（分离 user 标记）'
    : 'OneRing：当前消息来源'
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
    displayRole(block),
    normalizeRoleLabel(displayRole(block)),
    block.contentType,
    String(block.tokenCount || 0),
    String(block.textTokenCount || 0),
    String(block.attachmentTokenCount || 0),
    block.tokenMethod || '',
    block.text,
    attachmentCountsText(block),
    getDisplayOneRingMeta(block)?.senderName || '',
    getDisplayOneRingMeta(block)?.timestamp || '',
    getDisplayOneRingMeta(block)?.frontendSource || '',
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

async function copySingleBlock(block: FinalContextBlockSummary) {
  const success = await copyToClipboard(formatBlockAsText(block))
  showMessage(success ? `#${block.index} 已复制` : `#${block.index} 复制失败`, success ? 'success' : 'error')
}

function formatBlockAsText(block: FinalContextBlockSummary): string {
  const attachmentLine = block.attachments.length > 0
    ? `附件：${attachmentDescription(block)}\n`
    : ''

  const oneRingMeta = getDisplayOneRingMeta(block)
  const oneRingLine = oneRingMeta
    ? `OneRing来源：${oneRingMeta.senderName || '-'} / ${oneRingMeta.timestamp || '-'} / ${oneRingMeta.frontendSource || '-'}${oneRingMeta.isDetachedUserMarker ? ' / 分离user标记' : ''}\n`
    : ''

  return [
    `===== #${block.index} ${normalizeRoleLabel(displayRole(block))} (${block.contentType}) =====`,
    `字符数：${formatNumber(block.textLength)}`,
    `Token：${formatNumber(block.tokenCount)} = 文本 ${formatNumber(block.textTokenCount)} + 附件估算 ${formatNumber(block.attachmentTokenCount)} (${block.tokenMethod || snapshot.value?.summary.tokenMethod || 'unknown'})`,
    attachmentLine,
    oneRingLine,
    block.text || '(空文本块)',
  ].filter(Boolean).join('\n')
}

onMounted(() => {
  void loadSnapshot()
})
</script>

<style scoped>
.snapshot-selector {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--tertiary-bg);
  color: var(--primary-text);
}

.snapshot-selector .material-symbols-outlined {
  font-size: 18px !important;
  color: var(--highlight-text);
}

.snapshot-selector select {
  padding: 4px 6px;
  border: none;
  background: transparent;
  color: var(--primary-text);
  font: inherit;
  outline: none;
  max-width: 320px;
}

/* 修复深色模式下原生下拉项默认白底问题 */
.snapshot-selector select option {
  background: var(--secondary-bg);
  color: var(--primary-text);
}

.snapshot-selector small {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  white-space: nowrap;
}

.context-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: calc(var(--app-viewport-height, 100vh) - 140px);
}

.context-header,
.context-toolbar,
.summary-card,
.onering-source-panel,
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

.moonlight-modal {
  position: relative;
  z-index: 10001;
  width: min(1180px, calc(100vw - 24px));
  max-height: calc(var(--app-viewport-height, 100vh) - 96px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  box-shadow: var(--shadow-lg);
}

.moonlight-modal-header {
  flex: 0 0 auto;
}

.moonlight-title {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.moonlight-title .material-symbols-outlined {
  margin-top: 2px;
  color: var(--highlight-text);
}

.moonlight-modal-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.moonlight-modal-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 14px 16px 18px;
  overflow: auto;
}

.moonlight-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 55%, var(--border-color));
  border-radius: var(--radius-lg);
  background: linear-gradient(135deg, color-mix(in srgb, var(--highlight-bg) 18%, var(--secondary-bg)), var(--secondary-bg));
}

.moonlight-header,
.moonlight-header > div,
.moonlight-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.moonlight-header > div {
  justify-content: flex-start;
  align-items: flex-start;
}

.moonlight-header .material-symbols-outlined {
  color: var(--highlight-text);
}

.moonlight-header strong,
.moonlight-section-title strong,
.moonlight-term-grid strong {
  color: var(--primary-text);
}

.moonlight-header small,
.moonlight-section-title small,
.moonlight-empty-line {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.moonlight-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
}

.moonlight-metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.moonlight-metric span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.moonlight-metric strong {
  color: var(--highlight-text);
  font-size: 1.15em;
}

.moonlight-metric.warning strong {
  color: var(--warning-text);
}

.moonlight-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.moonlight-label,
.term-chip {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 45%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-bg) 35%, var(--tertiary-bg));
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
  word-break: break-all;
}

.moonlight-config {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.moonlight-config label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.moonlight-config input[type="number"] {
  width: 72px;
  padding: 5px 7px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
}

.moonlight-spectrum {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.moonlight-linear-map {
  display: flex;
  width: 100%;
  min-height: 34px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--tertiary-bg);
}

.moonlight-linear-segment {
  --segment-width: 1%;
  --segment-alpha: 0.2;
  position: relative;
  flex: 0 0 max(var(--segment-width), 3px);
  min-width: 3px;
  height: 34px;
  padding: 0;
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--border-color) 75%, transparent);
  background: color-mix(in srgb, var(--secondary-text) 16%, var(--primary-bg));
  cursor: pointer;
  overflow: hidden;
}

.moonlight-linear-segment.role-system {
  background: color-mix(in srgb, var(--info-text) 22%, var(--primary-bg));
}

.moonlight-linear-segment.role-user {
  background: color-mix(in srgb, var(--success-text) 22%, var(--primary-bg));
}

.moonlight-linear-segment.role-assistant {
  background: color-mix(in srgb, var(--highlight-text) 18%, var(--primary-bg));
}

.moonlight-linear-segment.role-tool {
  background: color-mix(in srgb, var(--warning-text) 24%, var(--primary-bg));
}

.moonlight-linear-heat {
  position: absolute;
  inset: 0;
  background: var(--highlight-text);
  opacity: var(--segment-alpha);
}

.moonlight-linear-segment.role-system .moonlight-linear-heat {
  background: var(--info-text);
}

.moonlight-linear-segment.role-user .moonlight-linear-heat {
  background: var(--success-text);
}

.moonlight-linear-segment.role-assistant .moonlight-linear-heat {
  background: var(--highlight-text);
}

.moonlight-linear-segment.role-tool .moonlight-linear-heat {
  background: var(--warning-text);
}

.moonlight-linear-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.moonlight-linear-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.moonlight-linear-legend i {
  width: 12px;
  height: 8px;
  border-radius: var(--radius-sm);
  display: inline-block;
}

.legend-system {
  background: var(--info-text);
}

.legend-user {
  background: var(--success-text);
}

.legend-assistant {
  background: var(--highlight-text);
}

.legend-tool {
  background: var(--warning-text);
}

.legend-peak {
  background: var(--danger-text, #ff5c7a);
}

.legend-valley {
  background: var(--secondary-text);
}

.moonlight-curve-card {
  position: relative;
  height: 220px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--highlight-bg) 14%, transparent), transparent),
    var(--tertiary-bg);
  color: var(--highlight-text);
}

.moonlight-curve-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.moonlight-curve-axis,
.moonlight-curve-guide {
  stroke: color-mix(in srgb, var(--secondary-text) 28%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.moonlight-curve-guide {
  stroke-dasharray: 6 8;
}

.moonlight-curve-guide.strong {
  stroke: color-mix(in srgb, var(--highlight-text) 42%, transparent);
}

.moonlight-curve-fill {
  fill: url(#moonlightCurveFill);
  color: var(--highlight-text);
  pointer-events: none;
}

.moonlight-curve-line {
  fill: none;
  stroke: var(--highlight-text);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--highlight-text) 45%, transparent));
  pointer-events: none;
}

.moonlight-curve-point {
  --point-x: 0%;
  --point-y: 100%;
  --point-size: 8px;
  position: absolute;
  left: var(--point-x);
  top: calc(30px + (var(--point-y) * 1.6));
  width: var(--point-size);
  height: var(--point-size);
  padding: 0;
  border: 2px solid var(--primary-bg);
  border-radius: var(--radius-full);
  background: var(--highlight-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--highlight-text) 60%, transparent), 0 0 10px color-mix(in srgb, var(--highlight-text) 38%, transparent);
  cursor: pointer;
  transform: translate(-50%, -50%);
}

.moonlight-curve-point.role-system {
  background: var(--info-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--info-text) 60%, transparent), 0 0 10px color-mix(in srgb, var(--info-text) 38%, transparent);
}

.moonlight-curve-point.role-user {
  background: var(--success-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--success-text) 60%, transparent), 0 0 10px color-mix(in srgb, var(--success-text) 38%, transparent);
}

.moonlight-curve-point.role-assistant {
  background: var(--highlight-text);
}

.moonlight-curve-point.role-tool {
  background: var(--warning-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--warning-text) 60%, transparent), 0 0 10px color-mix(in srgb, var(--warning-text) 38%, transparent);
}

.moonlight-curve-point.peak {
  border-color: var(--danger-text, #ff5c7a);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-text, #ff5c7a) 72%, transparent), 0 0 14px color-mix(in srgb, var(--danger-text, #ff5c7a) 55%, transparent);
}

.moonlight-curve-point.valley {
  opacity: 0.78;
  border-color: var(--secondary-text);
}

.moonlight-curve-point-label {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 5px);
  transform: translateX(-50%);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-bg) 86%, transparent);
  color: var(--primary-text);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
}

.moonlight-curve-point:hover .moonlight-curve-point-label,
.moonlight-curve-point.peak .moonlight-curve-point-label,
.moonlight-curve-point.valley .moonlight-curve-point-label {
  opacity: 1;
}

.moonlight-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  min-height: 130px;
  overflow-x: auto;
  padding: 8px 4px 2px;
}

.moonlight-bars.compact {
  min-height: 92px;
}

.moonlight-bar {
  --bar-height: 4%;
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 28px;
  min-width: 28px;
  height: 112px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--tertiary-bg);
  cursor: pointer;
  overflow: hidden;
}

.moonlight-bars.compact .moonlight-bar {
  height: 76px;
}

.moonlight-bar-fill {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: var(--bar-height);
  background: var(--highlight-text);
  opacity: 0.78;
}

.moonlight-bar.role-system .moonlight-bar-fill {
  background: var(--info-text);
}

.moonlight-bar.role-user .moonlight-bar-fill {
  background: var(--success-text);
}

.moonlight-bar.role-assistant .moonlight-bar-fill {
  background: var(--highlight-text);
}

.moonlight-bar.role-tool .moonlight-bar-fill {
  background: var(--warning-text);
}

.moonlight-bar-label {
  position: relative;
  z-index: 1;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  color: var(--primary-text);
  font-size: 10px;
  line-height: 1;
  text-shadow: 0 1px 2px var(--primary-bg);
}

.moonlight-term-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(160px, 1fr));
  gap: var(--space-3);
}

.moonlight-term-grid > div {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  align-content: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.moonlight-term-grid > div strong {
  flex: 0 0 100%;
}

.term-chip.muted {
  color: var(--secondary-text);
  border-color: var(--border-color);
  background: var(--tertiary-bg);
}

.term-chip.info {
  color: var(--info-text);
  border-color: var(--info-text);
  background: var(--info-bg);
}

.term-chip.danger {
  color: var(--warning-text);
  border-color: var(--warning-text);
  background: var(--warning-bg);
}

.moonlight-run-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 55%, var(--border-color));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-bg) 35%, var(--secondary-bg));
  color: var(--highlight-text);
  cursor: pointer;
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.moonlight-run-button .material-symbols-outlined {
  font-size: 17px !important;
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

.onering-source-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 14px 16px;
  border-color: color-mix(in srgb, var(--highlight-text) 50%, var(--border-color));
  background: linear-gradient(135deg, color-mix(in srgb, var(--highlight-bg) 16%, var(--secondary-bg)), var(--secondary-bg));
}

.onering-source-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.onering-source-title .material-symbols-outlined {
  color: var(--highlight-text);
}

.onering-source-title div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.onering-source-title small {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.onering-source-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.onering-source-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 60%, var(--border-color));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-bg) 40%, var(--tertiary-bg));
  color: var(--primary-text);
  cursor: pointer;
}

.source-frontend {
  font-weight: 800;
  color: var(--highlight-text);
}

.source-count,
.source-senders {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.jump-index {
  --jump-chip-width: 148px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--jump-chip-width), var(--jump-chip-width)));
  justify-content: start;
  gap: 8px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
}

.jump-index-dense {
  --jump-chip-width: 148px;
  gap: 8px;
}

.jump-index-dense .jump-chip {
  height: 58px;
}

.jump-chip {
  box-sizing: border-box;
  width: var(--jump-chip-width);
  height: 58px;
  min-width: 0;
  display: grid;
  grid-template-rows: 20px 18px;
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  gap: 3px;
  padding: 7px 9px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  color: var(--primary-text);
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
}

.jump-main,
.jump-source-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jump-main {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-weight: 800;
  line-height: 20px;
}

.jump-index-number {
  flex: 0 0 auto;
  font-family: Consolas, Monaco, monospace;
  font-variant-numeric: tabular-nums;
}

.jump-speaker {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jump-source-line {
  color: var(--secondary-text);
  font-size: 0.84em;
  line-height: 18px;
}

.jump-chip.jump-has-onering-source,
.jump-chip.jump-has-onering-ai-source {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-bg) 60%, var(--tertiary-bg));
}

.jump-chip.jump-has-onering-ai-source {
  border-style: dashed;
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
.block-meta,
.block-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.block-header-right {
  justify-content: flex-end;
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

.badge-ai-source-notice,
.badge-onering-source {
  color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-bg) 70%, var(--tertiary-bg));
  border-color: var(--highlight-text);
}

.block-type,
.block-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.block-copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--secondary-bg);
  color: var(--secondary-text);
  cursor: pointer;
}

.block-copy-button:hover {
  border-color: var(--highlight-text);
  color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-bg) 35%, var(--secondary-bg));
}

.block-copy-button .material-symbols-outlined {
  font-size: 18px !important;
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

.onering-meta-panel {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 16px;
  color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-bg) 44%, var(--primary-bg));
  border-bottom: 1px solid color-mix(in srgb, var(--highlight-text) 45%, var(--border-color));
}

.onering-meta-panel .material-symbols-outlined {
  margin-top: 1px;
}

.onering-meta-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.onering-meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.has-onering-source,
.has-onering-ai-source {
  border-color: color-mix(in srgb, var(--highlight-text) 65%, var(--border-color));
}

.has-onering-ai-source {
  border-style: dashed;
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
  z-index: 10000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: 72px 12px 12px;
  background: rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.onering-modal {
  position: relative;
  z-index: 10001;
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

  .moonlight-metrics,
  .moonlight-term-grid,
  .summary-card {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .jump-index {
    --jump-chip-width: 140px;
  }

}

@media (max-width: 560px) {
  .modal-backdrop {
    padding: 64px 8px 8px;
  }

  .moonlight-modal {
    width: calc(100vw - 16px);
    max-height: calc(var(--app-viewport-height, 100vh) - 80px);
  }

  .moonlight-modal-body {
    padding: 10px;
  }

  .moonlight-term-grid,
  .moonlight-metrics,
  .summary-card {
    grid-template-columns: 1fr;
  }

  .context-search {
    min-width: 0;
  }

  .jump-index {
    --jump-chip-width: 100%;
    grid-template-columns: 1fr;
    overflow-x: visible;
  }

  .jump-chip {
    width: 100%;
  }

}
</style>
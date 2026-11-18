<template>
  <section class="plugin-store">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          variant="outline"
          size="lg"
          :disabled="isLoading"
          @click="refreshAll"
        >
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          <span>{{ isLoading ? '刷新中…' : '刷新列表' }}</span>
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiCard class="store-hero">
      <div class="hero-copy">
        <span class="eyebrow hero-eyebrow">Plugin Marketplace</span>
        <h2>插件商店与安装中心</h2>
        <p>
          浏览、搜索并一键安装来自多个源的插件，支持自定义 Registry、GitHub 仓库与本地手动上传，安装过程可实时查看日志。
        </p>
      </div>

      <div class="hero-stats">
        <article class="stat-chip">
          <span class="stat-label">可用插件</span>
          <strong>{{ storeSummary.total }}</strong>
        </article>
        <article class="stat-chip installed">
          <span class="stat-label">已安装</span>
          <strong>{{ storeSummary.installed }}</strong>
        </article>
        <article class="stat-chip">
          <span class="stat-label">源状态（成功 / 配置）</span>
          <strong>{{ storeSummary.loadedSources }} / {{ storeSummary.sources }}</strong>
        </article>
        <article class="stat-chip" :class="{ 'has-issue': storeSummary.failedSources > 0 }">
          <span class="stat-label">加载异常源</span>
          <strong>{{ storeSummary.failedSources }}</strong>
        </article>
      </div>
    </UiCard>

    <section class="store-toolbar" aria-label="插件商店视图与筛选">
      <div class="view-mode-switch" role="tablist" aria-label="插件商店视图切换">
        <UiButton
          v-for="tab in tabs"
          :key="tab.id"
          :id="`plugin-store-tab-${tab.id}`"
          type="button"
          size="sm"
          role="tab"
          :variant="activeTab === tab.id ? 'primary' : 'outline'"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`plugin-store-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
        >
          <template #leading><span class="material-symbols-outlined">{{ tab.icon }}</span></template>
          <span>{{ tab.label }}</span>
        </UiButton>
      </div>

      <div class="controls-main-row">
        <label class="search-field" v-if="activeTab === 'market'">
          <span class="material-symbols-outlined">search</span>
          <UiInput
            ref="marketSearchInputRef"
            v-model="keyword"
            type="search"
            size="sm"
            placeholder="搜索插件名、描述或作者…"
            aria-label="搜索插件"
          />
        </label>
        <div v-else class="controls-intro">
          <span class="material-symbols-outlined">info</span>
          <span>{{ tabIntro }}</span>
        </div>
      </div>

      <div v-if="activeTab === 'market'" class="filter-row" aria-label="按源筛选">
        <UiButton
          type="button"
          size="xs"
          :variant="filterSourceId === '' ? 'primary' : 'outline'"
          :aria-pressed="filterSourceId === ''"
          @click="selectSource('')"
        >
          全部源
          <span class="pill-count">{{ storePlugins.length }}</span>
        </UiButton>
        <UiButton
          v-for="s in visibleSourceFilters"
          :key="s.id"
          type="button"
          size="xs"
          :variant="filterSourceId === s.id ? 'primary' : 'outline'"
          :aria-pressed="filterSourceId === s.id"
          @click="selectSource(s.id)"
        >
          {{ s.name }}
          <span class="pill-count">{{ sourcePluginCount(s.id) }}</span>
        </UiButton>

        <details
          v-if="overflowSourceFilters.length > 0"
          class="source-overflow"
          :open="sourceOverflowOpen"
          @toggle="handleSourceOverflowToggle"
        >
          <summary class="source-overflow-trigger">
            更多源
            <span class="pill-count">{{ overflowSourceFilters.length }}</span>
          </summary>
          <div class="source-overflow-menu" role="menu" aria-label="更多源筛选">
            <UiButton
              v-for="s in overflowSourceFilters"
              :key="s.id"
              type="button"
              size="xs"
              :variant="filterSourceId === s.id ? 'primary' : 'ghost'"
              :aria-pressed="filterSourceId === s.id"
              @click="selectSource(s.id)"
            >
              {{ s.name }}
              <span class="pill-count">{{ sourcePluginCount(s.id) }}</span>
            </UiButton>
          </div>
        </details>
      </div>
    </section>

    <!-- =========================================================== Market -->
    <section
      v-show="activeTab === 'market'"
      id="plugin-store-panel-market"
      class="tab-pane"
      role="tabpanel"
      aria-labelledby="plugin-store-tab-market"
    >
      <UiCard v-if="sourceErrors.length" class="source-errors" size="sm" variant="subtle">
        <div class="card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">error</span>
            <span>部分源加载失败</span>
          </h3>
          <span class="header-count">成功 {{ storeSummary.loadedSources }} / 配置 {{ storeSummary.sources }}</span>
        </div>
        <ul>
          <li v-for="err in sourceErrors" :key="err.sourceId">
            <strong>{{ sourceName(err.sourceId) }}</strong>：{{ err.error }}
          </li>
        </ul>
      </UiCard>

      <UiCard v-if="isLoading" class="empty-state" variant="subtle">
        <span class="material-symbols-outlined">progress_activity</span>
        <h3>正在加载插件列表</h3>
        <p>正从全部已配置源中获取最新数据…</p>
      </UiCard>

      <UiCard
        v-else-if="sources.length === 0"
        class="empty-state"
        variant="subtle"
      >
        <span class="material-symbols-outlined">dns</span>
        <h3>尚未配置任何源</h3>
        <p>请先切换到「源管理」添加一个 Registry 或 GitHub 仓库，然后回到市场浏览。</p>
        <UiButton variant="primary" @click="activeTab = 'sources'">
          <template #leading>
            <span class="material-symbols-outlined">add_link</span>
          </template>
          <span>去添加源</span>
        </UiButton>
      </UiCard>

      <UiCard
        v-else-if="filteredPlugins.length === 0"
        class="empty-state"
        variant="subtle"
      >
        <span class="material-symbols-outlined">search_off</span>
        <h3>暂无匹配的插件</h3>
        <p>请检查源配置、调整筛选条件，或切换到「手动安装」选项卡。</p>
      </UiCard>

      <section v-else class="results-header">
        <div>
          <h3>插件列表</h3>
          <p>
            共展示 {{ filteredPlugins.length }} 个插件，来自 {{ activeSourceCount }} 个已加载源（全局 {{ storeSummary.loadedSources }} / {{ storeSummary.sources }}）
            <template v-if="showCategoryGrouping">，已按 {{ groupedPlugins.length }} 个分类分组</template>
          </p>
        </div>
      </section>

      <section v-if="!isLoading && filteredPlugins.length > 0" class="plugin-grouped-view">
        <article
          v-for="group in groupedPlugins"
          :key="group.key"
          class="plugin-type-group"
        >
          <div class="type-group-header">
            <h3>
              <span class="material-symbols-outlined">folder</span>
              {{ group.label }}
              <span class="type-count">{{ group.plugins.length }}</span>
            </h3>

            <UiButton
              type="button"
              class="group-collapse-toggle"
              variant="outline"
              size="sm"
              :aria-expanded="!isCategoryGroupCollapsed(group.key)"
              :aria-controls="getCategoryGroupContentId(group.key)"
              @click="toggleCategoryGroupCollapsed(group.key)"
            >
              <span>{{ isCategoryGroupCollapsed(group.key) ? '展开' : '折叠' }}</span>
              <template #trailing>
                <span class="material-symbols-outlined group-collapse-icon" :class="{ 'is-collapsed': isCategoryGroupCollapsed(group.key) }">expand_more</span>
              </template>
            </UiButton>
          </div>

          <transition name="group-collapse">
            <div
              v-show="!isCategoryGroupCollapsed(group.key)"
              :id="getCategoryGroupContentId(group.key)"
              class="type-group-content"
            >
              <div class="plugin-grid">
                <article
                  v-for="plugin in group.plugins"
                  :key="`${plugin.sourceId}-${plugin.name}`"
                  class="plugin-card"
                >
                  <div class="plugin-card-top">
                    <div class="plugin-identity">
                      <div class="plugin-icon-shell">
                        <span class="material-symbols-outlined">{{ plugin.icon || 'extension' }}</span>
                      </div>

                      <div class="plugin-heading">
                        <div class="plugin-title-row">
                          <h3>{{ plugin.displayName || plugin.name }}</h3>
                          <UiBadge :variant="pluginStatusVariant(plugin)">
                            {{ pluginStatusText(plugin) }}
                          </UiBadge>
                        </div>
                        <p class="plugin-original-name">{{ plugin.name }}</p>
                      </div>
                    </div>

                    <div class="plugin-card-side">
                      <UiBadge v-if="plugin.version" variant="outline" class="plugin-version-badge">
                        市场 {{ formatVersion(plugin.version) }}
                      </UiBadge>
                      <UiBadge v-if="plugin.installedVersion" variant="success" class="plugin-version-badge plugin-version-local">
                        本地 {{ formatVersion(plugin.installedVersion) }}
                      </UiBadge>
                      <UiBadge v-if="isPluginUpdateAvailable(plugin)" variant="warning" class="plugin-version-badge plugin-version-update">
                        有新版本
                      </UiBadge>
                    </div>
                  </div>

                  <div class="plugin-card-main">
                    <p class="plugin-description" :title="plugin.description || '该插件暂未提供描述信息。'">
                      {{ plugin.description || '该插件暂未提供描述信息。' }}
                    </p>

                    <div class="plugin-status-pills">
                      <UiBadge v-if="plugin.sourceName" variant="secondary">
                        <template #leading>
                          <span class="material-symbols-outlined">lan</span>
                        </template>
                        {{ plugin.sourceName }}
                      </UiBadge>
                      <UiBadge v-if="plugin.author" variant="outline">
                        <template #leading>
                          <span class="material-symbols-outlined">person</span>
                        </template>
                        {{ plugin.author }}
                      </UiBadge>
                    </div>

                    <div class="plugin-actions">
                      <template v-if="plugin.installed">
                        <UiButton
                          v-if="isPluginUpdateAvailable(plugin)"
                          variant="primary"
                          size="sm"
                          :disabled="isOperationBusy"
                          @click="updateFromCard(plugin)"
                        >
                          <template #leading>
                            <span class="material-symbols-outlined">system_update</span>
                          </template>
                          <span>{{ isPluginInstalling(plugin) ? '更新中…' : `更新到 ${formatVersion(plugin.version)}` }}</span>
                        </UiButton>
                        <UiButton
                          variant="outline"
                          size="sm"
                          :disabled="isOperationBusy"
                          @click="reinstallFromCard(plugin)"
                        >
                          <template #leading>
                            <span class="material-symbols-outlined">replay</span>
                          </template>
                          <span>{{ isPluginInstalling(plugin) ? '重装中…' : '覆盖重装' }}</span>
                        </UiButton>
                        <UiButton
                          variant="danger"
                          size="sm"
                          :disabled="isOperationBusy"
                          @click="uninstallFromCard(plugin)"
                        >
                          <template #leading>
                            <span class="material-symbols-outlined">{{ isPluginUninstalling(plugin) ? 'hourglass_top' : 'delete' }}</span>
                          </template>
                          <span>{{ isPluginUninstalling(plugin) ? '卸载中…' : '卸载' }}</span>
                        </UiButton>
                      </template>
                      <UiButton
                        v-else
                        variant="primary"
                        size="sm"
                        :disabled="isOperationBusy"
                        @click="installFromCard(plugin)"
                      >
                        <template #leading>
                          <span class="material-symbols-outlined">download</span>
                        </template>
                        <span>{{ isPluginInstalling(plugin) ? '安装中…' : '安装插件' }}</span>
                      </UiButton>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </transition>
        </article>
      </section>
    </section>

    <!-- =========================================================== Sources -->
    <section
      v-show="activeTab === 'sources'"
      id="plugin-store-panel-sources"
      class="tab-pane sources-pane"
      role="tabpanel"
      aria-labelledby="plugin-store-tab-sources"
    >
      <article class="card store-section-card">
        <div class="card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">add_link</span>
            <span>添加自定义源</span>
          </h3>
        </div>

        <form class="source-form" @submit.prevent="submitSource">
          <UiField label="名称">
            <UiInput v-model="newSource.name" type="text" placeholder="例：MyRegistry" required />
          </UiField>
          <UiField label="类型">
            <UiSelect v-model="newSource.type">
              <option value="registry">Registry (JSON 列表)</option>
              <option value="github">GitHub 仓库</option>
            </UiSelect>
          </UiField>
          <UiField label="URL" class="source-form-wide">
            <UiInput
              v-model="newSource.url"
              type="url"
              :placeholder="newSource.type === 'github' ? 'https://github.com/owner/repo' : 'https://example.com/plugins.json'"
              required
            />
          </UiField>
          <div class="form-actions">
            <UiButton type="submit" variant="primary" :disabled="sourceSaving">
              <template #leading>
                <span class="material-symbols-outlined">add</span>
              </template>
              <span>{{ sourceSaving ? '添加中…' : '添加源' }}</span>
            </UiButton>
          </div>
        </form>
      </article>

      <article class="card store-section-card">
        <div class="card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">lan</span>
            <span>已配置源</span>
          </h3>
          <span class="header-count">{{ sources.length }} 个源</span>
        </div>

        <div class="table-container" v-if="sources.length > 0">
          <table class="source-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>URL</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in sources" :key="s.id">
                <td>
                  <div class="source-name-cell">
                    <span>{{ s.name }}</span>
                    <UiBadge v-if="s.builtin" variant="secondary">内置</UiBadge>
                  </div>
                </td>
                <td>
                  <UiBadge variant="outline">{{ s.type }}</UiBadge>
                </td>
                <td class="url-cell"><code>{{ s.url }}</code></td>
                <td class="col-actions">
                  <UiButton
                    variant="danger"
                    size="sm"
                    :disabled="s.builtin"
                    @click="removeSource(s)"
                  >
                    <template #leading>
                      <span class="material-symbols-outlined">delete</span>
                    </template>
                    <span>删除</span>
                  </UiButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="empty-state">
          <span class="material-symbols-outlined">dns</span>
          <h3>尚未配置任何源</h3>
          <p>使用上方表单添加一个自定义 Registry 或 GitHub 仓库。</p>
        </div>
      </article>
    </section>

    <!-- =========================================================== Manual -->
    <section
      v-show="activeTab === 'manual'"
      id="plugin-store-panel-manual"
      class="tab-pane manual-pane"
      role="tabpanel"
      aria-labelledby="plugin-store-tab-manual"
    >
      <article class="card store-section-card">
        <div class="card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">upload_file</span>
            <span>上传本地插件</span>
          </h3>
        </div>

        <p class="hint">
          支持 <code>{{ supportedArchiveHint }}</code> 压缩包或整个插件文件夹。安装时会自动检测 <code>package.json</code> 并执行 <code>npm install</code>。
        </p>

        <div
          class="drop-zone"
          :class="{ dragging: isDragging }"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
          @click="zipInput?.click()"
        >
          <span class="material-symbols-outlined drop-icon">cloud_upload</span>
          <p>拖拽 <strong>{{ supportedArchiveHint }}</strong> 到此处，或点击选择文件</p>
        </div>

        <div class="upload-buttons">
          <input ref="zipInput" type="file" :accept="supportedArchiveAccept" class="hidden-input" @change="onArchiveSelected" />
          <input ref="folderInput" type="file" class="hidden-input" webkitdirectory directory multiple @change="onFolderSelected" />
          <UiButton variant="outline" size="sm" @click="zipInput?.click()" :disabled="isOperationBusy">
            <template #leading>
              <span class="material-symbols-outlined">archive</span>
            </template>
            <span>选择压缩包</span>
          </UiButton>
          <UiButton variant="outline" size="sm" @click="folderInput?.click()" :disabled="isOperationBusy">
            <template #leading>
              <span class="material-symbols-outlined">folder</span>
            </template>
            <span>选择文件夹</span>
          </UiButton>
        </div>
      </article>

      <article class="card store-section-card">
        <div class="card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">cloud_download</span>
            <span>从 GitHub 安装</span>
          </h3>
        </div>

        <p class="hint">
          粘贴 GitHub 仓库地址，例如 <code>https://github.com/owner/repo</code> 或 <code>https://github.com/owner/repo/tree/main/path</code>。
        </p>

        <div class="github-row">
          <label class="search-field">
            <span class="material-symbols-outlined">link</span>
            <UiInput v-model="githubUrl" type="url" placeholder="https://github.com/owner/repo" />
          </label>
          <UiButton
            variant="primary"
            size="sm"
            :disabled="!githubUrl || isOperationBusy"
            @click="installFromGithub"
          >
            <template #leading>
              <span class="material-symbols-outlined">download</span>
            </template>
            <span>{{ isInstalling ? '安装中…' : '安装' }}</span>
          </UiButton>
        </div>
      </article>
    </section>

    <!-- =========================================================== Log panel -->
    <transition name="log-slide">
      <article v-if="logOpen" class="card install-log-panel">
        <div class="log-header">
          <span class="material-symbols-outlined">terminal</span>
          <strong>安装日志</strong>
          <UiBadge :variant="logStatusVariant">{{ installStatusLabel }}</UiBadge>
          <UiButton
            v-if="canForceRetry"
            variant="primary"
            size="sm"
            :disabled="isOperationBusy"
            @click="retryWithForce"
          >
            <template #leading>
              <span class="material-symbols-outlined">replay</span>
            </template>
            <span>强制覆盖重装</span>
          </UiButton>
          <UiButton variant="outline" size="sm" @click="clearLog">
            <template #leading>
              <span class="material-symbols-outlined">close</span>
            </template>
            <span>关闭</span>
          </UiButton>
        </div>
        <p v-if="showUploadRetryHint" class="log-hint">
          已存在同名插件。若要覆盖，请重新选择压缩包或文件夹后再次安装（上传数据不可自动重放）。
        </p>
        <pre ref="logBox" class="log-body">{{ logText }}</pre>
      </article>
    </transition>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  pluginStoreApi,
  type PluginSource,
  type PluginStoreItem,
} from '@/api'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiCard from '@/components/ui/UiCard.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { useAppStore } from '@/stores/app'
import { showMessage } from '@/utils'
import { askConfirm } from '@/platform/feedback/feedbackBus'

const tabs = [
  { id: 'market', label: '插件市场', icon: 'storefront' },
  { id: 'sources', label: '源管理', icon: 'lan' },
  { id: 'manual', label: '手动安装', icon: 'upload_file' },
] as const
type TabId = typeof tabs[number]['id']

const activeTab = ref<TabId>('market')
const appStore = useAppStore()

const isLoading = ref(false)
const storePlugins = ref<PluginStoreItem[]>([])
const sources = ref<PluginSource[]>([])
const sourceErrors = ref<Array<{ sourceId: string; error: string }>>([])

const keyword = ref('')
const debouncedKeyword = ref('')
const KEYWORD_DEBOUNCE_MS = 200
let keywordTimer: ReturnType<typeof setTimeout> | null = null
watch(keyword, (v) => {
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => {
    debouncedKeyword.value = v
  }, KEYWORD_DEBOUNCE_MS)
})

const filterSourceId = ref('')
const marketSearchInputRef = ref<InstanceType<typeof UiInput> | null>(null)
const sourceOverflowOpen = ref(false)
const MAX_VISIBLE_SOURCE_FILTERS = 5

type PluginGroup = {
  key: string
  label: string
  plugins: PluginStoreItem[]
}

const CATEGORY_ORDER = [
  'data-provider',
  'service',
  'agent-collab',
  'image-generation',
  'media-generation',
  'information-retrieval',
  'browser',
  'system-integration',
  'social',
  'utility',
  'data-source',
  'tool',
  'other',
] as const

const CATEGORY_LABELS: Record<string, string> = {
  all: '全部插件',
  'data-provider': '数据提供',
  service: '服务与驻留',
  'agent-collab': 'AI 协作',
  'image-generation': '图像生成',
  'media-generation': '媒体生成',
  'information-retrieval': '信息检索',
  browser: '浏览器与网页',
  'system-integration': '系统集成',
  social: '社交与论坛',
  utility: '工具能力',
  'data-source': '数据源',
  tool: '通用插件',
  other: '其他',
}

const SUPPORTED_ARCHIVE_EXTS = ['.zip', '.tar', '.tar.gz', '.tgz'] as const
const supportedArchiveAccept = SUPPORTED_ARCHIVE_EXTS.join(',')
const supportedArchiveHint = SUPPORTED_ARCHIVE_EXTS.join(' / ')

const collapsedCategoryGroups = ref<Record<string, boolean>>({})

function isSupportedArchiveFile(fileName: string) {
  const lower = fileName.toLowerCase()
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  )
}

const newSource = ref<{ name: string; url: string; type: 'registry' | 'github' }>({
  name: '',
  url: '',
  type: 'github',
})
const sourceSaving = ref(false)

const githubUrl = ref('')
const zipInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

// Install state: installingKey tracks which action is in flight so we can
// show per-plugin progress instead of locking the whole UI.
type InstallPayload =
  | { kind: 'card'; sourceId?: string; pluginName?: string; downloadUrl?: string; force?: boolean; key: string }
  | { kind: 'github'; githubUrl: string; key: string }
  | { kind: 'upload'; key: string }

type InstallStatus = 'idle' | 'running' | 'success' | 'error' | 'conflict'
const ALLOWED_FINAL_STATUSES: readonly InstallStatus[] = ['success', 'error', 'conflict']

const installingKey = ref<string | null>(null)
const isInstalling = computed(() => installingKey.value !== null)
const uninstallingKey = ref<string | null>(null)
const isUninstalling = computed(() => uninstallingKey.value !== null)
const isOperationBusy = computed(() => isInstalling.value || isUninstalling.value)
const installStatus = ref<InstallStatus>('idle')
const lastInstall = ref<InstallPayload | null>(null)
const logText = ref('')
const logOpen = ref(false)
const logBox = ref<HTMLPreElement | null>(null)
let unsubscribe: (() => void) | null = null

const installStatusLabel = computed(() => {
  switch (installStatus.value) {
    case 'running': return '进行中'
    case 'success': return '成功'
    case 'error': return '失败'
    case 'conflict': return '已存在'
    default: return ''
  }
})

const logStatusVariant = computed<"secondary" | "success" | "danger" | "warning">(() => {
  switch (installStatus.value) {
    case 'running': return 'secondary'
    case 'success': return 'success'
    case 'error': return 'danger'
    case 'conflict': return 'warning'
    default: return 'secondary'
  }
})

const canForceRetry = computed(() =>
  installStatus.value === 'conflict'
  && lastInstall.value !== null
  && lastInstall.value.kind !== 'upload'
)

const showUploadRetryHint = computed(() =>
  installStatus.value === 'conflict'
  && lastInstall.value?.kind === 'upload'
)

const tabIntro = computed(() => {
  switch (activeTab.value) {
    case 'sources': return '在此管理插件来源，可添加自定义 Registry 或 GitHub 仓库。'
    case 'manual': return '本地上传压缩包（.zip/.tar/.tar.gz/.tgz）或文件夹，或直接通过 GitHub 链接安装。'
    default: return ''
  }
})

const filteredPlugins = computed(() => {
  const kw = debouncedKeyword.value.trim().toLowerCase()
  return storePlugins.value.filter(p => {
    if (filterSourceId.value && p.sourceId !== filterSourceId.value) return false
    if (!kw) return true
    return (
      p.name.toLowerCase().includes(kw) ||
      (p.displayName || '').toLowerCase().includes(kw) ||
      (p.description || '').toLowerCase().includes(kw) ||
      (p.author || '').toLowerCase().includes(kw)
    )
  })
})

const showCategoryGrouping = computed(() => {
  return filteredPlugins.value.some(plugin => {
    return typeof plugin.category === 'string' && plugin.category.trim().length > 0
  })
})

function normalizeCategoryKey(raw: string | undefined) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  return normalized || 'other'
}

function pluginSortName(plugin: PluginStoreItem) {
  return (plugin.displayName || plugin.name || '').toLowerCase()
}

const zhCollator = new Intl.Collator('zh-CN', { sensitivity: 'base' })

const groupedPlugins = computed<PluginGroup[]>(() => {
  const groups = new Map<string, PluginStoreItem[]>()

  for (const plugin of filteredPlugins.value) {
    const key = showCategoryGrouping.value
      ? normalizeCategoryKey(plugin.category)
      : 'all'
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(plugin)
    } else {
      groups.set(key, [plugin])
    }
  }

  const order = new Map<string, number>(CATEGORY_ORDER.map((key, index) => [key, index]))

  return Array.from(groups.entries())
    .map(([key, plugins]) => ({
      key,
      label: CATEGORY_LABELS[key] || key,
      plugins: [...plugins].sort((a, b) => zhCollator.compare(pluginSortName(a), pluginSortName(b))),
    }))
    .sort((a, b) => {
      const ai = order.get(a.key) ?? Number.MAX_SAFE_INTEGER
      const bi = order.get(b.key) ?? Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
      return zhCollator.compare(a.label, b.label)
    })
})

function isCategoryGroupCollapsed(key: string) {
  return collapsedCategoryGroups.value[key] ?? false
}

function toggleCategoryGroupCollapsed(key: string) {
  collapsedCategoryGroups.value = {
    ...collapsedCategoryGroups.value,
    [key]: !isCategoryGroupCollapsed(key),
  }
}

function getCategoryGroupContentId(key: string) {
  return `plugin-store-group-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

const failedSourceIds = computed(() => {
  const ids = new Set<string>()
  for (const err of sourceErrors.value) {
    if (err.sourceId) ids.add(err.sourceId)
  }
  return ids
})

const storeSummary = computed(() => {
  const sourceCount = sources.value.length
  const failedSources = failedSourceIds.value.size
  const loadedSources = Math.max(sourceCount - failedSources, 0)
  return {
    total: storePlugins.value.length,
    installed: storePlugins.value.filter(p => p.installed).length,
    sources: sourceCount,
    loadedSources,
    failedSources,
    errors: sourceErrors.value.length,
  }
})

const activeSourceCount = computed(() => {
  const ids = new Set(filteredPlugins.value.map(p => p.sourceId))
  return ids.size
})

function sourceName(id: string) {
  return sources.value.find(s => s.id === id)?.name || id
}

function sourcePluginCount(id: string) {
  return storePlugins.value.filter(p => p.sourceId === id).length
}

const visibleSourceFilters = computed(() => {
  const allSources = sources.value
  if (allSources.length <= MAX_VISIBLE_SOURCE_FILTERS) {
    return allSources
  }

  const base = allSources.slice(0, MAX_VISIBLE_SOURCE_FILTERS)
  const selectedId = filterSourceId.value
  if (!selectedId || base.some((source) => source.id === selectedId)) {
    return base
  }

  const selected = allSources.find((source) => source.id === selectedId)
  if (!selected) {
    return base
  }

  return [...base.slice(0, MAX_VISIBLE_SOURCE_FILTERS - 1), selected]
})

const overflowSourceFilters = computed(() => {
  const visibleIds = new Set(visibleSourceFilters.value.map((source) => source.id))
  return sources.value.filter((source) => !visibleIds.has(source.id))
})

function selectSource(sourceId: string) {
  filterSourceId.value = sourceId
  sourceOverflowOpen.value = false
}

function handleSourceOverflowToggle(event: Event) {
  const details = event.currentTarget
  if (!(details instanceof HTMLDetailsElement)) {
    return
  }
  sourceOverflowOpen.value = details.open
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function handlePageHotkeys(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey) {
    return
  }

  if (!event.ctrlKey && !event.metaKey && event.key === '/' && !isEditableTarget(event.target)) {
    if (activeTab.value !== 'market') return
    event.preventDefault()
    marketSearchInputRef.value?.focus()
    marketSearchInputRef.value?.select()
    return
  }

  if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r' && !isEditableTarget(event.target)) {
    event.preventDefault()
    void refreshAll()
  }
}

function pluginKey(plugin: PluginStoreItem) {
  return `card:${plugin.sourceId || ''}:${plugin.name}`
}

function formatVersion(v?: string) {
  if (!v) return ''
  const trimmed = v.trim()
  if (!trimmed) return ''
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`
}

function parseComparableVersion(version: string | undefined) {
  const raw = String(version || '').trim()
  if (!raw) return null
  const normalized = raw.replace(/^v/i, '')
  const matched = normalized.match(/^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?$/)
  if (!matched) return null

  const core = matched[1].split('.').map(part => Number(part))
  if (core.some(n => Number.isNaN(n))) return null

  const prerelease = matched[2]
    ? matched[2].split('.').map(token => (/^\d+$/.test(token) ? Number(token) : token.toLowerCase()))
    : null

  return { core, prerelease }
}

function compareComparableVersion(a: string | undefined, b: string | undefined): number | null {
  const va = parseComparableVersion(a)
  const vb = parseComparableVersion(b)
  if (!va || !vb) return null

  const maxLen = Math.max(va.core.length, vb.core.length)
  for (let i = 0; i < maxLen; i++) {
    const ai = va.core[i] ?? 0
    const bi = vb.core[i] ?? 0
    if (ai > bi) return 1
    if (ai < bi) return -1
  }

  const pa = va.prerelease
  const pb = vb.prerelease
  if (!pa && !pb) return 0
  if (!pa) return 1
  if (!pb) return -1

  const preLen = Math.max(pa.length, pb.length)
  for (let i = 0; i < preLen; i++) {
    const ai = pa[i]
    const bi = pb[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    if (ai === bi) continue

    const aiNum = typeof ai === 'number'
    const biNum = typeof bi === 'number'
    if (aiNum && biNum) return ai > bi ? 1 : -1
    if (aiNum) return -1
    if (biNum) return 1
    return ai > bi ? 1 : -1
  }

  return 0
}

function pluginVersionCompare(plugin: PluginStoreItem): number | null {
  return compareComparableVersion(plugin.version, plugin.installedVersion)
}

function isPluginUpdateAvailable(plugin: PluginStoreItem) {
  if (!plugin.installed) return false
  if (plugin.updateAvailable === true) return true
  const compared = pluginVersionCompare(plugin)
  return compared !== null && compared > 0
}

function pluginStatusVariant(plugin: PluginStoreItem): "secondary" | "success" | "warning" {
  if (!plugin.installed) return 'secondary'
  if (isPluginUpdateAvailable(plugin)) return 'warning'
  return 'success'
}

function pluginStatusText(plugin: PluginStoreItem) {
  if (!plugin.installed) return '可安装'
  if (isPluginUpdateAvailable(plugin)) return '可更新'
  const compared = pluginVersionCompare(plugin)
  if (compared === 0) return '已最新'
  if (compared !== null && compared < 0) return '本地较新'
  return '已安装'
}

function isPluginInstalling(plugin: PluginStoreItem) {
  return installingKey.value === pluginKey(plugin)
}

function isPluginUninstalling(plugin: PluginStoreItem) {
  return uninstallingKey.value === pluginKey(plugin)
}

async function refreshStore(syncPluginManager = true) {
  isLoading.value = true
  let syncError: unknown = null
  try {
    const [resp] = await Promise.all([
      pluginStoreApi.getStorePlugins(),
      syncPluginManager
        ? appStore.refreshPlugins().catch((err) => {
          syncError = err
          return []
        })
        : Promise.resolve([]),
    ])
    storePlugins.value = resp.plugins || []
    sources.value = resp.sources || []
    sourceErrors.value = resp.errors || []
    if (syncError) {
      showMessage(`市场已刷新，但插件管理状态同步失败：${errMsg(syncError)}`, 'warning')
    }
  } catch (err) {
    showMessage(`加载插件商店失败：${errMsg(err)}`, 'error')
  } finally {
    isLoading.value = false
  }
}

async function refreshAll() {
  await refreshStore(true)
}

async function submitSource() {
  if (!newSource.value.name || !newSource.value.url) return
  sourceSaving.value = true
  try {
    await pluginStoreApi.addSource({ ...newSource.value })
    showMessage('源添加成功', 'success')
    newSource.value = { name: '', url: '', type: 'github' }
    await refreshStore(false)
  } catch (err) {
    showMessage(`添加失败：${errMsg(err)}`, 'error')
  } finally {
    sourceSaving.value = false
  }
}

async function removeSource(s: PluginSource) {
  if (s.builtin) return
  const confirmed = await askConfirm({
    title: '删除源',
    message: `确认删除源「${s.name}」吗？`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  })
  if (!confirmed) return
  try {
    await pluginStoreApi.deleteSource(s.id)
    showMessage('已删除', 'success')
    await refreshStore(false)
  } catch (err) {
    showMessage(`删除失败：${errMsg(err)}`, 'error')
  }
}

async function installFromCard(plugin: PluginStoreItem, force = false) {
  const payload: InstallPayload = {
    kind: 'card',
    sourceId: plugin.sourceId,
    pluginName: plugin.name,
    downloadUrl: plugin.downloadUrl,
    force,
    key: pluginKey(plugin),
  }
  lastInstall.value = payload
  await startInstall(
    () => pluginStoreApi.install({
      sourceId: payload.sourceId,
      pluginName: payload.pluginName,
      downloadUrl: payload.downloadUrl,
      force: payload.force,
    }),
    payload.key,
  )
}

async function updateFromCard(plugin: PluginStoreItem) {
  await installFromCard(plugin, true)
}

async function reinstallFromCard(plugin: PluginStoreItem) {
  const confirmed = await askConfirm({
    title: '覆盖重装插件',
    message: `将覆盖当前已安装版本「${plugin.displayName || plugin.name}」，是否继续？`,
    confirmText: '覆盖安装',
    cancelText: '取消',
    danger: true,
  })
  if (!confirmed) return
  await installFromCard(plugin, true)
}

async function uninstallFromCard(plugin: PluginStoreItem) {
  if (!plugin.installed) return
  const displayName = plugin.displayName || plugin.name
  const confirmed = await askConfirm({
    title: '卸载插件',
    message: `确认卸载插件「${displayName}」吗？卸载后可在商店重新安装。`,
    confirmText: '卸载',
    cancelText: '取消',
    danger: true,
  })
  if (!confirmed) return

  const key = pluginKey(plugin)
  uninstallingKey.value = key
  try {
    const resp = await pluginStoreApi.uninstallPlugin(plugin.name)
    showMessage(resp.message || `插件 ${displayName} 已卸载`, 'success')
    await refreshStore(true)
  } catch (err) {
    showMessage(`卸载失败：${errMsg(err)}`, 'error')
  } finally {
    if (uninstallingKey.value === key) {
      uninstallingKey.value = null
    }
  }
}

async function installFromGithub() {
  const url = githubUrl.value.trim()
  if (!url) return
  const payload: InstallPayload = { kind: 'github', githubUrl: url, key: `github:${url}` }
  lastInstall.value = payload
  await startInstall(() => pluginStoreApi.install({ githubUrl: url }), payload.key)
}

async function retryWithForce() {
  const last = lastInstall.value
  if (!last) return
  if (last.kind === 'upload') {
    showMessage('文件上传无法自动覆盖，请重新选择文件后再安装。', 'warning')
    return
  }
  if (last.kind === 'card') {
    await startInstall(
      () => pluginStoreApi.install({
        sourceId: last.sourceId,
        pluginName: last.pluginName,
        downloadUrl: last.downloadUrl,
        force: true,
      }),
      last.key,
    )
  } else {
    await startInstall(
      () => pluginStoreApi.install({ githubUrl: last.githubUrl, force: true }),
      last.key,
    )
  }
}

function onArchiveSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) uploadFiles([file], [file.name])
}

function onFolderSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  const relPaths = files.map(f => (f as unknown as { webkitRelativePath?: string }).webkitRelativePath || f.name)
  uploadFiles(files, relPaths)
}

function onDrop(ev: DragEvent) {
  isDragging.value = false
  const files = Array.from(ev.dataTransfer?.files || [])
  if (!files.length) return
  if (files.length === 1 && isSupportedArchiveFile(files[0].name)) {
    uploadFiles(files, [files[0].name])
  } else {
    showMessage(`请拖拽单个压缩包（${supportedArchiveHint}），若要上传文件夹请使用按钮`, 'warning')
  }
}

async function uploadFiles(files: File[], relPaths: string[]) {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  fd.append('relPaths', JSON.stringify(relPaths))
  const key = `upload:${Date.now()}`
  lastInstall.value = { kind: 'upload', key }
  await startInstall(() => pluginStoreApi.uploadPlugin(fd), key)
}

async function startInstall(
  fn: () => Promise<{ taskId: string; message?: string }>,
  key: string,
) {
  if (installingKey.value || isUninstalling.value) {
    showMessage('当前有插件操作进行中，请稍候。', 'warning')
    return
  }
  installingKey.value = key
  installStatus.value = 'running'
  logText.value = ''
  logOpen.value = true
  try {
    const resp = await fn()
    subscribeLog(resp.taskId)
  } catch (err) {
    installStatus.value = 'error'
    installingKey.value = null
    showMessage(`启动安装失败：${errMsg(err)}`, 'error')
  }
}

function normalizeFinalStatus(raw: unknown): InstallStatus {
  const v = String(raw || '')
  return (ALLOWED_FINAL_STATUSES as readonly string[]).includes(v)
    ? (v as InstallStatus)
    : 'error'
}

function subscribeLog(taskId: string) {
  unsubscribe?.()
  unsubscribe = pluginStoreApi.streamInstallLog(taskId, {
    onLog: (line) => {
      logText.value += line.endsWith('\n') ? line : `${line}\n`
      scrollLogBottom()
    },
    onEnd: (payload) => {
      installStatus.value = normalizeFinalStatus(payload.status)
      installingKey.value = null
      if (installStatus.value === 'success') {
        showMessage(payload.message || '插件安装完成', 'success')
        void refreshAll()
      } else {
        showMessage(payload.message || '安装未完成', 'error')
      }
    },
    onError: () => {
      if (installStatus.value === 'running') {
        installStatus.value = 'error'
        installingKey.value = null
      }
    },
  })
}

function scrollLogBottom() {
  void nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}

function clearLog() {
  logOpen.value = false
  logText.value = ''
  installStatus.value = 'idle'
  unsubscribe?.()
  unsubscribe = null
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// Clearing URL on type change avoids carrying a registry URL into github mode.
watch(() => newSource.value.type, () => {
  newSource.value.url = ''
})

watch(activeTab, () => {
  sourceOverflowOpen.value = false
})

onMounted(() => {
  void refreshAll()
  document.addEventListener('keydown', handlePageHotkeys)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  if (keywordTimer) clearTimeout(keywordTimer)
  document.removeEventListener('keydown', handlePageHotkeys)
})
</script>

<style scoped>
.plugin-store {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ========== Hero ========== */
.store-hero {
  padding: var(--space-4);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
}

.store-hero :deep(.ui-card__content) {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  gap: var(--space-3);
  align-items: stretch;
}

.hero-copy h2 {
  margin: 0 0 var(--space-1);
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.hero-copy p {
  margin: 0;
  max-width: 56ch;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.hero-eyebrow {
  display: inline-flex;
  margin-bottom: var(--space-1);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.stat-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 54px;
  justify-content: center;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.stat-chip strong {
  font-size: var(--font-size-emphasis);
  line-height: 1.1;
}

.stat-chip.installed strong {
  color: var(--success-color, var(--success-text));
}

.stat-chip.has-issue strong {
  color: var(--danger-color, var(--danger-text));
}

.stat-label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

/* ========== Controls ========== */
.store-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  position: sticky;
  top: 0;
  z-index: 17;
  padding: var(--space-2) 0 var(--space-1);
  background: color-mix(in srgb, var(--primary-bg) 82%, transparent);
  backdrop-filter: blur(10px);
}

.controls-main-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  flex: 1 1 260px;
  min-width: 220px;
}

.controls-intro {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.controls-intro .material-symbols-outlined {
  color: var(--highlight-text);
}

.search-field {
  flex: 1;
  min-width: 240px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.search-field .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 18px !important;
}

.search-field :deep(.ui-input) {
  min-width: 0;
}

.view-mode-switch {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  position: relative;
}

.source-overflow {
  position: relative;
}

.source-overflow > summary {
  list-style: none;
}

.source-overflow > summary::-webkit-details-marker {
  display: none;
}

.source-overflow-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  background: transparent;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.source-overflow-trigger:hover {
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
  color: var(--primary-text);
}

.source-overflow[open] .source-overflow-trigger {
  border-style: solid;
  border-color: color-mix(in srgb, var(--button-bg) 28%, var(--border-color));
  color: var(--primary-text);
}

.source-overflow-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 92%, transparent);
  box-shadow: var(--shadow-lg);
  z-index: 5;
}

.source-overflow-menu :deep(.ui-button) {
  width: 100%;
  justify-content: space-between;
}

.pill-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  margin-left: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--button-bg) 16%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  line-height: 1;
}

/* ========== Results header ========== */
.results-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  padding-top: var(--space-1);
}

.results-header h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  line-height: 1.35;
}

.results-header p {
  color: var(--secondary-text);
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-helper);
}

.tab-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ========== Plugin grid (market) ========== */
.plugin-grouped-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.plugin-type-group {
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
  overflow: hidden;
}

.type-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 42px;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--primary-text) 2.2%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.type-group-header h3 {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-helper);
  font-weight: 700;
  margin: 0;
}

.type-group-header .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 16px;
}

.type-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1;
}

.group-collapse-toggle {
  flex: 0 0 auto;
}

.group-collapse-icon {
  font-size: var(--font-size-title);
  line-height: 1;
  transition: transform var(--transition-fast);
}

.group-collapse-icon.is-collapsed {
  transform: rotate(-90deg);
}

.type-group-content {
  padding: 10px;
}

.group-collapse-enter-active,
.group-collapse-leave-active {
  overflow: hidden;
  transition:
    max-height 0.28s ease,
    opacity 0.24s ease,
    transform 0.24s ease,
    padding-top 0.24s ease,
    padding-bottom 0.24s ease;
}

.group-collapse-enter-from,
.group-collapse-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-6px);
  padding-top: 0;
  padding-bottom: 0;
}

.group-collapse-enter-to,
.group-collapse-leave-from {
  max-height: 2600px;
  opacity: 1;
  transform: translateY(0);
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-3);
}

.plugin-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  border-radius: var(--radius-md);
  padding: 10px;
  background: color-mix(in srgb, var(--primary-text) 0.7%, transparent);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.plugin-card:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 24%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 3.5%, transparent);
}

.plugin-card-top {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.plugin-identity {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
}

.plugin-icon-shell {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--highlight-text) 8%, transparent);
  color: var(--highlight-text);
  flex-shrink: 0;
}

.plugin-icon-shell .material-symbols-outlined {
  font-size: 18px;
}

.plugin-heading {
  flex: 1;
  min-width: 0;
}

.plugin-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  align-items: center;
}

.plugin-title-row h3 {
  font-size: var(--font-size-body);
  line-height: 1.3;
  overflow-wrap: anywhere;
  margin: 0;
}

.plugin-original-name {
  margin-top: 2px;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  overflow-wrap: anywhere;
}

.plugin-card-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-xs);
  flex-shrink: 0;
}

.plugin-version-badge {
  white-space: nowrap;
}

.plugin-status-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: var(--space-2);
}

.plugin-card-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.plugin-description {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.5;
  min-height: calc(1.5em * 2);
  max-height: calc(1.5em * 3);
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  margin-bottom: var(--space-2);
}

.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: auto;
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
}

/* ========== Source errors ========== */
.source-errors {
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  background: var(--warning-bg);
}

.source-errors ul {
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--secondary-text);
}

.source-errors li + li {
  margin-top: 4px;
}

/* ========== Sources pane ========== */
.sources-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.store-section-card {
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.header-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.source-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.source-form-wide {
  grid-column: 1 / -1;
}

.form-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}

.source-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-body);
}

.source-table th,
.source-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.source-table tbody tr:last-child td {
  border-bottom: none;
}

.source-table tbody tr {
  transition: background-color var(--transition-fast);
}

.source-table tbody tr:hover {
  background: color-mix(in srgb, var(--highlight-text) 3.5%, transparent);
}

.source-table th {
  color: var(--secondary-text);
  font-weight: 600;
  text-transform: uppercase;
  font-size: var(--font-size-caption);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.source-name-cell {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--primary-text);
  font-weight: 600;
}

.url-cell code {
  font-family: var(--font-mono, Consolas, monospace);
  word-break: break-all;
  color: var(--secondary-text);
}

.col-actions {
  width: 120px;
  text-align: right;
}

/* ========== Manual pane ========== */
.manual-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.hint {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  margin: 0 0 var(--space-3);
  line-height: 1.6;
}

.hint code {
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 0.9em;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px dashed color-mix(in srgb, var(--border-color) 92%, transparent);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  text-align: center;
  color: var(--secondary-text);
  cursor: pointer;
  background: transparent;
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    color 0.2s ease;
}

.drop-zone:hover,
.drop-zone.dragging {
  border-color: color-mix(in srgb, var(--button-bg) 50%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
  color: var(--primary-text);
}

.drop-icon {
  font-size: 32px !important;
  color: var(--highlight-text);
}

.drop-zone p {
  margin: 0;
}

.upload-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.hidden-input {
  display: none;
}

.github-row {
  display: flex;
  gap: var(--space-2);
  align-items: stretch;
}

.github-row .search-field {
  flex: 1;
}

/* ========== Install log ========== */
.install-log-panel {
  position: sticky;
  bottom: var(--space-4);
  padding: 0;
  overflow: hidden;
  z-index: 5;
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
  background: color-mix(in srgb, var(--primary-bg) 94%, transparent);
}

.log-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 12px 16px;
  background: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.log-header .material-symbols-outlined {
  color: var(--highlight-text);
}

.log-header strong {
  margin-right: auto;
  color: var(--primary-text);
}

.log-hint {
  margin: 0;
  padding: 10px 16px;
  background: var(--warning-bg);
  color: var(--warning-text);
  border-bottom: 1px solid var(--warning-border);
  font-size: var(--font-size-helper);
  line-height: 1.5;
}

.log-body {
  max-height: 280px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--primary-text);
}

.log-slide-enter-active,
.log-slide-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.25s ease;
}

.log-slide-enter-from,
.log-slide-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

/* ========== Responsive ========== */
@media (max-width: 1024px) {
  .store-hero :deep(.ui-card__content) {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .controls-main-row {
    flex-direction: column;
    align-items: stretch;
  }

  .view-mode-switch {
    width: 100%;
  }

  .view-mode-switch :deep(.ui-button) {
    flex: 1;
    justify-content: center;
  }

  .source-form {
    grid-template-columns: 1fr;
  }

  .github-row {
    flex-direction: column;
  }

  .plugin-grid {
    grid-template-columns: 1fr;
  }

  .plugin-card-top {
    flex-direction: column;
  }

  .plugin-card-side {
    align-self: flex-start;
    align-items: flex-start;
    flex-direction: row;
  }

  .col-actions {
    width: auto;
  }
}

@media (max-width: 480px) {
  .hero-copy h2 {
    font-size: 1rem;
  }

  .hero-stats {
    grid-template-columns: 1fr 1fr;
  }

  .plugin-card {
    padding: var(--space-3);
  }

  .plugin-actions {
    flex-direction: column;
  }

  .plugin-actions :deep(.ui-button) {
    width: 100%;
    justify-content: center;
  }

  .upload-buttons :deep(.ui-button) {
    flex: 1;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .source-overflow-trigger,
  .group-collapse-icon,
  .plugin-card {
    transition: none;
  }
}
</style>

<template>
  <section class="config-section active-section toolbox-manager-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <p class="toolbox-page-summary">
          维护 toolbox_map.json，并编辑 TVStxt 下映射文件内容。
        </p>
        <UiBadge
          :variant="mapDirty ? 'warning' : 'success'"
          :title="mapDirty ? '映射未保存' : '映射已同步'"
          :aria-label="mapDirty ? '映射未保存' : '映射已同步'"
        >
          {{ mapDirty ? '映射未保存' : '映射已同步' }}
        </UiBadge>
        <UiButton
          @click="refreshAll"
          variant="outline"
          size="lg"
          title="刷新 Toolbox 数据"
        >
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton
          @click="openCreateDialog"
          variant="outline"
          size="lg"
          title="新建 Toolbox 映射"
        >
          <template #leading>
            <span class="material-symbols-outlined">add</span>
          </template>
          新建
        </UiButton>
        <UiButton
          @click="saveToolboxMap"
          :disabled="mapSaving || !mapDirty"
          variant="primary"
          size="lg"
          title="保存映射表"
        >
          <template #leading>
            <span class="material-symbols-outlined" :class="{ spinning: mapSaving }">
              {{ mapSaving ? 'sync' : 'save' }}
            </span>
          </template>
          {{ mapSaving ? '保存中…' : mapDirty ? '保存映射' : '已保存' }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="toolbox-manager-shell">
      <aside class="toolbox-map-pane" aria-label="Toolbox 映射表">
        <div class="toolbox-search">
          <span class="material-symbols-outlined search-icon">search</span>
          <UiInput
            v-model="searchQuery"
            type="text"
            placeholder="搜索别名、文件名或描述…"
            class="search-input"
          />
          <UiIconButton v-if="searchQuery" @click="searchQuery = ''" class="search-clear" label="清除搜索" title="清除">
            <span class="material-symbols-outlined">close</span>
          </UiIconButton>
        </div>

        <div class="toolbox-map-list">
          <article
            v-for="entry in filteredToolboxMap"
            :key="entry.localId"
            class="toolbox-map-entry"
            :class="{ 'is-active': editingFile === entry.file }"
          >
            <div class="toolbox-entry-header">
              <div class="toolbox-entry-identity">
                <span class="material-symbols-outlined">inventory_2</span>
                <div class="toolbox-entry-title-group">
                  <span class="toolbox-entry-title">{{ entry.alias || '未命名 Toolbox' }}</span>
                  <span class="toolbox-entry-file">{{ entry.file || '未绑定文件' }}</span>
                </div>
              </div>
              <UiBadge
                :variant="isValidAlias(entry.alias.trim()) && isValidToolboxFileName(entry.file.trim()) ? 'success' : 'warning'"
              >
                {{ isValidAlias(entry.alias.trim()) && isValidToolboxFileName(entry.file.trim()) ? '可用' : '待完善' }}
              </UiBadge>
              <div class="toolbox-entry-actions">
                <UiIconButton
                  @click="selectToolboxEntry(entry)"
                  label="编辑 Toolbox 文件"
                  title="编辑"
                  :disabled="!entry.file.trim() || !isValidToolboxFileName(entry.file.trim())"
                >
                  <span class="material-symbols-outlined">edit</span>
                </UiIconButton>
                <UiIconButton
                  @click="removeToolboxEntry(entry.localId)"
                  variant="danger"
                  label="删除 Toolbox 映射"
                  title="删除"
                >
                  <span class="material-symbols-outlined">delete</span>
                </UiIconButton>
              </div>
            </div>

            <div class="toolbox-entry-fields">
              <div class="toolbox-entry-row">
                <label>别名</label>
              <div class="input-validated">
                <UiInput
                  type="text"
                  v-model="entry.alias"
                  placeholder="例如：MyToolBox（仅英文、数字、下划线）"
                  :invalid="Boolean(entry.alias.trim()) && !isValidAlias(entry.alias.trim())"
                />
                <span v-if="entry.alias.trim() && !isValidAlias(entry.alias.trim())" class="validation-hint">
                  仅允许英文字母、数字和下划线
                </span>
              </div>
            </div>
            <div class="toolbox-entry-row">
              <label>文件</label>
              <div class="input-validated">
                <UiSelect
                  :model-value="entry.file.trim()"
                  class="toolbox-file-picker"
                  :invalid="Boolean(entry.file.trim()) && !isValidToolboxFileName(entry.file.trim())"
                  :disabled="tvsFiles.length === 0"
                  aria-label="选择已有 Toolbox 文件"
                  @change="handleToolboxFilePickerChange(entry, $event)"
                >
                  <option value="">选择已有文件…</option>
                  <optgroup
                    v-if="getToolboxFilePickerGroups(entry).matched.length > 0"
                    label="名称匹配（置顶）"
                  >
                    <option
                      v-for="file in getToolboxFilePickerGroups(entry).matched"
                      :key="`matched-${entry.localId}-${file}`"
                      :value="file"
                    >
                      {{ file }}
                    </option>
                  </optgroup>
                  <optgroup
                    v-if="getToolboxFilePickerGroups(entry).others.length > 0"
                    label="──────── 其他文件 ────────"
                  >
                    <option
                      v-for="file in getToolboxFilePickerGroups(entry).others"
                      :key="`other-${entry.localId}-${file}`"
                      :value="file"
                    >
                      {{ file }}
                    </option>
                  </optgroup>
                </UiSelect>
                <span v-if="entry.file.trim() && !isValidToolboxFileName(entry.file.trim())" class="validation-hint">
                  文件名须以 .txt 或 .md 结尾，不可含非法字符
                </span>
              </div>
            </div>
            <div class="toolbox-entry-row toolbox-entry-row--description">
              <label>描述</label>
              <UiTextarea
                v-model="entry.description"
                placeholder="工具描述…"
                maxlength="200"
                rows="3"
                size="sm"
                resize="none"
              />
            </div>
            </div>
          </article>

          <div v-if="filteredToolboxMap.length === 0 && toolboxMap.length > 0" class="empty-state">
            <span class="material-symbols-outlined">search_off</span>
            <p>没有匹配"{{ searchQuery }}"的条目</p>
          </div>

          <div v-if="toolboxMap.length === 0" class="empty-state">
            <span class="material-symbols-outlined">inventory_2</span>
            <p>暂无 Toolbox 映射</p>
            <UiButton @click="openCreateDialog" variant="primary">新建第一个 Toolbox</UiButton>
          </div>
        </div>
      </aside>

      <main class="toolbox-file-pane" aria-label="Toolbox 文件内容">
        <header class="toolbox-file-pane-header">
          <div class="toolbox-file-title">
            <span class="toolbox-pane-label">Toolbox 文件内容</span>
            <span class="toolbox-file-name">
              <span class="material-symbols-outlined">description</span>
              {{ editingFile || '未选择文件' }}
            </span>
          </div>
          <div v-if="editingFile" class="toolbox-file-actions">
            <div class="editor-mode-toggle">
              <UiButton :class="['mode-btn', { active: editorMode === 'visual' }]" variant="ghost" size="sm" @click="switchEditorMode('visual')" title="可视化 Fold 块编辑">
                <span class="material-symbols-outlined">view_agenda</span> 可视化
              </UiButton>
              <UiButton :class="['mode-btn', { active: editorMode === 'raw' }]" variant="ghost" size="sm" @click="switchEditorMode('raw')" title="原始文本编辑">
                <span class="material-symbols-outlined">code</span> 原始
              </UiButton>
            </div>
            <UiButton
              @click="saveToolboxFile"
              :disabled="!fileDirty || fileSaving"
              variant="primary"
              size="sm"
            >
              <template #leading>
                <span class="material-symbols-outlined">save</span>
              </template>
              {{ fileSaving ? '保存中…' : '保存文件' }}
            </UiButton>
            <UiButton
              @click="deleteCurrentFile"
              variant="danger"
              size="sm"
              title="删除当前 Toolbox 文件"
            >
              <template #leading>
                <span class="material-symbols-outlined">delete_forever</span>
              </template>
              删除文件
            </UiButton>
            <UiButton
              v-if="editorMode === 'visual'"
              @click="addFoldBlockAtEnd"
              variant="outline"
              size="sm"
              title="新增 Block"
            >
              <template #leading>
                <span class="material-symbols-outlined">add</span>
              </template>
              新增 Block
            </UiButton>
          </div>
        </header>

        <div class="toolbox-file-workspace">
          <div class="toolbox-file-editor">
          <!-- Visual mode (default) -->
          <template v-if="editorMode === 'visual' && editingFile">
            <div class="threshold-simulator">
              <label class="threshold-label">
                <span class="material-symbols-outlined">tune</span>
                模拟阈值：<strong>{{ simulatedThreshold.toFixed(2) }}</strong>
              </label>
              <input
                type="range"
                v-model.number="simulatedThreshold"
                min="0" max="1" step="0.05"
                class="threshold-slider"
                :style="rangeProgressStyle(simulatedThreshold)"
              >
              <span class="threshold-hint">
                {{ visibleBlockCount }}/{{ foldBlocks.length }} 块可见
              </span>
            </div>

            <div class="fold-blocks-visual">
              <template v-for="(block, i) in foldBlocks" :key="i">
                <article class="fold-block-card" :class="{ 'block-hidden': block.threshold > simulatedThreshold }">
                  <div class="fold-block-topline">
                    <div class="fold-block-header">
                      <span class="block-index">Block {{ i + 1 }}</span>
                      <UiBadge class="block-threshold-badge" :variant="thresholdVariant(block.threshold)">
                        {{ block.threshold.toFixed(2) }}
                      </UiBadge>
                      <UiBadge v-if="block.threshold > simulatedThreshold" variant="danger" class="block-folded-badge">折叠中</UiBadge>
                    </div>
                    <div class="fold-block-field">
                      <label>阈值:</label>
                      <input type="range" v-model.number="block.threshold" min="0" max="1" step="0.05" class="block-threshold-slider" :style="rangeProgressStyle(block.threshold)">
                      <UiInput type="number" v-model.number="block.threshold" min="0" max="1" step="0.05" class="block-threshold-input" size="sm" />
                    </div>
                    <div class="fold-block-field">
                      <label>语义:</label>
                      <UiInput type="text" v-model="block.description" placeholder="用于按块独立语义匹配（为空则按工具箱整体描述匹配）" class="block-desc-input" />
                    </div>
                    <UiIconButton
                      @click="removeFoldBlock(i)"
                      label="删除此块"
                      class="fold-block-delete"
                      :disabled="foldBlocks.length <= 1"
                      title="删除此块"
                    >
                      <span class="material-symbols-outlined">close</span>
                    </UiIconButton>
                  </div>
                  <UiTextarea
                    v-model="block.content"
                    class="fold-block-content"
                    rows="6"
                    spellcheck="false"
                    placeholder="输入此块的内容…"
                  />
                </article>
                <div class="block-divider">
                  <UiIconButton @click="addFoldBlockAfter(i)" class="add-block-button" label="在此处插入新块" title="在此处插入新块">
                    <span class="material-symbols-outlined">add_circle</span>
                  </UiIconButton>
                </div>
              </template>
            </div>
          </template>

          <!-- Raw mode -->
          <template v-if="editorMode === 'raw'">
            <UiTextarea
              v-model="fileContent"
              spellcheck="false"
              rows="20"
              placeholder="从左侧选择一个 Toolbox 以编辑其关联文件…"
              class="file-content-editor"
            />
          </template>

          <!-- No file selected placeholder -->
          <div v-if="!editingFile" class="editor-placeholder">
            <span class="material-symbols-outlined">edit_note</span>
            <p>从左侧选择一个 Toolbox 并点击"编辑"</p>
          </div>

        </div>
        </div>
      </main>
    </div>

    <!-- File autocomplete datalist -->
    <datalist id="tvs-files-datalist">
      <option v-for="f in tvsFiles" :key="f" :value="f" />
    </datalist>

    <!-- Unified create dialog -->
    <BaseModal
      v-model="showCreateDialog"
      aria-label="新建 Toolbox"
    >
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="dialog-overlay">
          <div :ref="panelRef" v-bind="panelAttrs" class="dialog-card card">
      <h4>新建 Toolbox</h4>
      <div class="toolbox-entry-row">
        <label>别名 (Alias):</label>
        <div class="input-validated">
          <UiInput
            ref="createAliasRef"
            v-model="newAlias"
            placeholder="例如：VCPMyToolBox"
            :invalid="Boolean(newAlias.trim()) && !isValidAlias(newAlias.trim())"
            @keydown.esc="showCreateDialog = false"
          />
          <span v-if="newAlias.trim() && !isValidAlias(newAlias.trim())" class="validation-hint">
            仅允许英文字母、数字和下划线
          </span>
        </div>
      </div>
      <div class="toolbox-entry-row">
        <label>文件名:</label>
        <div class="input-validated">
          <UiInput
            v-model="newFile"
            placeholder="例如：MyTool.txt（无后缀自动加 .txt）"
            list="tvs-files-datalist"
            @keydown.esc="showCreateDialog = false"
          />
          <span v-if="newFile.trim() && !isValidFileName(newFile.trim())" class="validation-hint">
            文件名包含非法字符
          </span>
          <span v-else-if="newFileExists" class="file-hint exists">
            <span class="material-symbols-outlined">link</span> 文件已存在，将直接关联
          </span>
          <span v-else-if="newFile.trim() && isValidFileName(newFile.trim())" class="file-hint create">
            <span class="material-symbols-outlined">add_circle_outline</span> 文件不存在，将自动创建
          </span>
        </div>
      </div>
      <div class="toolbox-entry-row">
        <label>描述:</label>
        <UiInput
          v-model="newDesc"
          placeholder="工具箱描述…"
          maxlength="200"
          @keydown.esc="showCreateDialog = false"
        />
      </div>
      <div class="dialog-actions">
        <UiButton @click="showCreateDialog = false" variant="outline" size="sm">取消</UiButton>
        <UiButton
          @click="confirmCreateToolbox"
          variant="primary"
          size="sm"
          :disabled="!canCreate"
        >
          创建
        </UiButton>
      </div>
          </div>
        </div>
      </template>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { toolboxApi } from '@/api'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'
import BaseModal from '@/components/ui/BaseModal.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'

/* ── Types ── */
interface ToolboxEntry {
  localId: string
  alias: string
  file: string
  description: string
}

interface FoldBlock {
  threshold: number
  description: string
  content: string
}

/* ── Constants ── */
const ALIAS_REGEX = /^[A-Za-z0-9_]+$/
const FOLD_REGEX = /^\[===vcp_fold:\s*([0-9.]+)(?:\s*::desc:\s*(.*?)\s*)?===\]\s*$/

/* ── State: Map ── */
const toolboxMap = ref<ToolboxEntry[]>([])
const searchQuery = ref('')
const mapSaving = ref(false)
const initialMapSnapshot = ref('[]')

/* ── State: Files ── */
const tvsFiles = ref<string[]>([])
const editingFile = ref('')
const fileContent = ref('')
const originalFileContent = ref('')
const originalFoldSerialized = ref('')
const fileSaving = ref(false)
const fileContentCache = new Map<string, string>()

/* ── State: Editor ── */
const editorMode = ref<'raw' | 'visual'>('visual')
const foldBlocks = ref<FoldBlock[]>([])
const simulatedThreshold = ref(1.0)
/* ── State: Create Dialog ── */
const showCreateDialog = ref(false)
const newAlias = ref('')
const newFile = ref('')
const newDesc = ref('')
const createAliasRef = ref<InstanceType<typeof UiInput> | null>(null)

/* ── Computed ── */
const fileDirty = computed(() => {
  if (!editingFile.value) return false
  if (editorMode.value === 'visual') {
    // 与 originalFoldSerialized 对比，避免 parseFoldBlocks + serializeFoldBlocks
    // 不是严格恒等带来的假「未保存」提示（初次加载时尤其常见）
    return serializeFoldBlocks(foldBlocks.value) !== originalFoldSerialized.value
  }
  return fileContent.value !== originalFileContent.value
})

function serializeToolboxMap(entries: ToolboxEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      alias: entry.alias.trim(),
      file: entry.file.trim(),
      description: entry.description.trim(),
    }))
  )
}

const mapDirty = computed(() => serializeToolboxMap(toolboxMap.value) !== initialMapSnapshot.value)
const hasPendingChanges = computed(() => mapDirty.value || fileDirty.value)

const filteredToolboxMap = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return toolboxMap.value
  return toolboxMap.value.filter(e =>
    e.alias.toLowerCase().includes(q) ||
    e.file.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q)
  )
})

const visibleBlockCount = computed(() =>
  foldBlocks.value.filter(b => b.threshold <= simulatedThreshold.value).length
)

const newFileExists = computed(() => {
  let name = newFile.value.trim()
  if (!name) return false
  if (!isValidToolboxFileName(name)) name = `${name}.txt`
  return tvsFiles.value.includes(name)
})

const canCreate = computed(() => {
  const alias = newAlias.value.trim()
  const file = newFile.value.trim()
  return alias && isValidAlias(alias) && file && isValidFileName(file)
})

/* ── Helpers ── */
function generateLocalId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tb-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function createToolboxEntry(data: Partial<Omit<ToolboxEntry, 'localId'>> = {}): ToolboxEntry {
  return { localId: generateLocalId(), alias: data.alias ?? '', file: data.file ?? '', description: data.description ?? '' }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isValidAlias(alias: string): boolean {
  return ALIAS_REGEX.test(alias)
}

function isValidFileName(name: string): boolean {
  if (!name) return false
  return !/[\\/:*?"<>|]/.test(name) && !name.includes('..')
}

function isValidToolboxFileName(name: string): boolean {
  if (!isValidFileName(name)) return false
  const lower = name.toLowerCase()
  return lower.endsWith('.txt') || lower.endsWith('.md')
}

function getToolboxFilePickerGroups(entry: ToolboxEntry): {
  matched: string[]
  others: string[]
} {
  const normalizedAlias = entry.alias.trim().toLowerCase()
  const matched: string[] = []
  const others: string[] = []

  tvsFiles.value.forEach((file) => {
    const comparableFile = file.toLowerCase()
    if (normalizedAlias && comparableFile.includes(normalizedAlias)) {
      matched.push(file)
      return
    }

    others.push(file)
  })

  return { matched, others }
}

function handleToolboxFilePickerChange(entry: ToolboxEntry, event: Event): void {
  const selectedFile = (event.target as HTMLSelectElement).value
  if (!selectedFile) return

  entry.file = selectedFile
}

/* ── Fold Block Parsing & Serialization ── */
function parseFoldBlocks(content: string): FoldBlock[] {
  const blocks: FoldBlock[] = []
  let threshold = 0.0
  let desc = ''
  let lines: string[] = []
  let opened = false

  for (const line of String(content || '').split('\n')) {
    const m = line.match(FOLD_REGEX)
    if (m) {
      if (opened || lines.length > 0) {
        blocks.push({ threshold, description: desc, content: lines.join('\n').trim() })
      }
      threshold = parseFloat(m[1])
      if (Number.isNaN(threshold)) threshold = 0.0
      desc = typeof m[2] === 'string' ? m[2].trim() : ''
      lines = []
      opened = true
    } else {
      lines.push(line)
    }
  }

  if (opened || lines.length > 0) {
    blocks.push({ threshold, description: desc, content: lines.join('\n').trim() })
  }

  return blocks.length > 0 ? blocks : [{ threshold: 0.0, description: '', content: '' }]
}

function serializeFoldBlocks(blocks: FoldBlock[]): string {
  return blocks.map((b, i) => {
    const needsMarker = i > 0 || b.threshold > 0 || b.description
    if (!needsMarker) return b.content
    const descPart = b.description ? `::desc:${b.description}` : ''
    const marker = `[===vcp_fold:${b.threshold}${descPart}===]`
    return b.content ? `${marker}\n\n${b.content}` : marker
  }).join('\n\n')
}

function thresholdVariant(t: number): 'success' | 'warning' | 'danger' {
  if (t <= 0.3) return 'success'
  if (t <= 0.6) return 'warning'
  return 'danger'
}

function rangeProgressStyle(value: number) {
  const progress = Math.max(0, Math.min(100, value * 100))
  return { '--range-progress': `${progress}%` }
}

/* ── Data Loading ── */
async function loadToolboxMap() {
  try {
    const data = await toolboxApi.getToolboxMap({ showLoader: false, loadingKey: 'toolbox.map.load' })
    toolboxMap.value = Object.entries(data || {}).map(([alias, value]) =>
      createToolboxEntry({ alias, file: value?.file || '', description: value?.description || '' })
    )
    initialMapSnapshot.value = serializeToolboxMap(toolboxMap.value)
  } catch (error) {
    console.error('Failed to load toolbox map:', error)
    toolboxMap.value = []
    initialMapSnapshot.value = serializeToolboxMap(toolboxMap.value)
  }
}

async function loadTvsFiles() {
  try {
    const result = await toolboxApi.listToolboxFiles({ showLoader: false, loadingKey: 'toolbox.files.list' })
    tvsFiles.value = result.files || []
  } catch {
    tvsFiles.value = []
  }
}

async function refreshAll() {
  if (hasPendingChanges.value) {
    const shouldContinue = await askConfirm({
      message: '存在未保存改动，刷新会覆盖当前编辑内容，是否继续？',
      danger: true,
      confirmText: '继续刷新',
    })
    if (!shouldContinue) {
      return
    }
  }

  fileContentCache.clear()
  await Promise.all([loadToolboxMap(), loadTvsFiles()])
  if (editingFile.value) {
    try {
      const content = await toolboxApi.getToolboxFile(editingFile.value, { showLoader: false, loadingKey: 'toolbox.file.load' })
      fileContent.value = content
      originalFileContent.value = content
      fileContentCache.set(editingFile.value, content)
      foldBlocks.value = parseFoldBlocks(content)
      originalFoldSerialized.value = serializeFoldBlocks(foldBlocks.value)
    } catch { /* file may have been deleted */ }
  }
  showMessage('已刷新', 'success')
}

/* ── File Editor ── */
async function openFileInEditor(fileName: string, isNewlyCreated = false) {
  editingFile.value = fileName

  if (isNewlyCreated) {
    fileContent.value = ''
    originalFileContent.value = ''
    fileContentCache.set(fileName, '')
  } else {
    try {
      const content = fileContentCache.has(fileName)
        ? fileContentCache.get(fileName)!
        : await toolboxApi.getToolboxFile(fileName, { showLoader: false, loadingKey: 'toolbox.file.load' })
      fileContent.value = content
      originalFileContent.value = content
      fileContentCache.set(fileName, content)
    } catch {
      fileContent.value = ''
      originalFileContent.value = ''
    }
  }

  foldBlocks.value = parseFoldBlocks(fileContent.value)
  originalFoldSerialized.value = serializeFoldBlocks(foldBlocks.value)
}

async function selectToolboxEntry(entry: ToolboxEntry) {
  const fileName = entry.file.trim()
  if (!fileName) return
  if (fileDirty.value && !(await askConfirm('当前文件有未保存的修改，确定放弃并切换吗？'))) return
  await openFileInEditor(fileName)
}

async function saveToolboxFile() {
  if (!editingFile.value || fileSaving.value) return
  if (editorMode.value === 'visual') fileContent.value = serializeFoldBlocks(foldBlocks.value)

  fileSaving.value = true
  try {
    await toolboxApi.saveToolboxFile(editingFile.value, fileContent.value, { loadingKey: 'toolbox.file.save' })
    originalFileContent.value = fileContent.value
    originalFoldSerialized.value = editorMode.value === 'visual'
      ? fileContent.value
      : serializeFoldBlocks(parseFoldBlocks(fileContent.value))
    fileContentCache.set(editingFile.value, fileContent.value)
    showMessage('文件已保存！', 'success')
  } catch (error) {
    showMessage(`保存失败：${getErrorMessage(error)}`, 'error')
  } finally {
    fileSaving.value = false
  }
}

async function deleteCurrentFile() {
  if (!editingFile.value) return
  if (!(await askConfirm({
    message: `确定要永久删除文件"${editingFile.value}"吗？此操作不可恢复！`,
    danger: true,
    confirmText: '删除文件',
  }))) return

  try {
    await toolboxApi.deleteToolboxFile(editingFile.value, { loadingKey: 'toolbox.file.delete' })
    const deleted = editingFile.value
    fileContentCache.delete(deleted)
    editingFile.value = ''
    fileContent.value = ''
    originalFileContent.value = ''
    originalFoldSerialized.value = ''
    foldBlocks.value = []

    const idx = tvsFiles.value.indexOf(deleted)
    if (idx !== -1) tvsFiles.value.splice(idx, 1)

    showMessage(`文件 ${deleted} 已删除`, 'success')
  } catch (error) {
    showMessage(`删除文件失败：${getErrorMessage(error)}`, 'error')
  }
}

/* ── Editor Mode ── */
function switchEditorMode(mode: 'raw' | 'visual') {
  if (mode === editorMode.value) return
  if (mode === 'visual') {
    foldBlocks.value = parseFoldBlocks(fileContent.value)
  } else {
    fileContent.value = serializeFoldBlocks(foldBlocks.value)
  }
  editorMode.value = mode
}

/* ── Fold Block Ops ── */
function addFoldBlockAfter(index: number) {
  foldBlocks.value.splice(index + 1, 0, { threshold: 0.5, description: '', content: '' })
}

function addFoldBlockAtEnd() {
  foldBlocks.value.push({ threshold: 0.5, description: '', content: '' })
}

function removeFoldBlock(index: number) {
  if (foldBlocks.value.length <= 1) return
  foldBlocks.value.splice(index, 1)
}

/* ── Map CRUD ── */
async function removeToolboxEntry(localId: string) {
  if (!(await askConfirm({
    message: '确定要删除这个 Toolbox 映射吗？',
    danger: true,
    confirmText: '删除',
  }))) return
  const idx = toolboxMap.value.findIndex(e => e.localId === localId)
  if (idx !== -1) {
    const [removed] = toolboxMap.value.splice(idx, 1)
    if (editingFile.value === removed?.file) {
      editingFile.value = ''
      fileContent.value = ''
      originalFileContent.value = ''
      originalFoldSerialized.value = ''
      foldBlocks.value = []
      if (removed?.file) fileContentCache.delete(removed.file)
    }
  }
  showMessage('已删除映射条目，请点击"保存"以生效', 'info')
}

async function saveToolboxMap() {
  if (mapSaving.value) return
  mapSaving.value = true
  try {
    const emptyCount = toolboxMap.value.filter(e => !e.alias.trim()).length
    if (emptyCount > 0 && !(await askConfirm(`有 ${emptyCount} 个条目别名为空，保存时将被忽略。继续保存吗？`))) return

    const invalidAliases = toolboxMap.value
      .filter(e => e.alias.trim() && !isValidAlias(e.alias.trim()))
      .map(e => e.alias)
    if (invalidAliases.length > 0) {
      showMessage(`以下别名格式无效（仅允许英文、数字、下划线）：${invalidAliases.join(', ')}`, 'error')
      return
    }

    const seen = new Set<string>()
    const dupes: string[] = []
    for (const e of toolboxMap.value) {
      const a = e.alias.trim()
      if (!a) continue
      if (seen.has(a)) dupes.push(a)
      seen.add(a)
    }
    if (dupes.length > 0) {
      showMessage(`存在重复别名：${dupes.join(', ')}`, 'error')
      return
    }

    const payload = toolboxMap.value.reduce<Record<string, { file: string; description: string }>>((acc, e) => {
      const a = e.alias.trim()
      if (!a) return acc
      acc[a] = { file: e.file.trim(), description: e.description || '' }
      return acc
    }, {})

    await toolboxApi.saveToolboxMap(payload, { loadingKey: 'toolbox.map.save' })
    initialMapSnapshot.value = serializeToolboxMap(toolboxMap.value)
    showMessage('Toolbox 映射表已保存！', 'success')
  } catch (error) {
    showMessage(`保存失败：${getErrorMessage(error)}`, 'error')
  } finally {
    mapSaving.value = false
  }
}

/* ── Create Dialog ── */
function openCreateDialog() {
  newAlias.value = ''
  newFile.value = ''
  newDesc.value = ''
  showCreateDialog.value = true
  nextTick(() => createAliasRef.value?.focus())
}

async function confirmCreateToolbox() {
  const alias = newAlias.value.trim()
  let fileName = newFile.value.trim()
  const desc = newDesc.value.trim()

  if (!alias || !isValidAlias(alias)) {
    showMessage('别名仅允许英文字母、数字和下划线', 'error')
    return
  }
  if (!fileName || !isValidFileName(fileName)) {
    showMessage('请输入有效的文件名', 'error')
    return
  }
  if (!isValidToolboxFileName(fileName)) fileName = `${fileName}.txt`

  if (toolboxMap.value.some(e => e.alias.trim() === alias)) {
    showMessage(`别名"${alias}"已存在`, 'error')
    return
  }

  // Create file if it doesn't exist
  const fileExists = tvsFiles.value.includes(fileName)
  if (!fileExists) {
    try {
      await toolboxApi.createToolboxFile(fileName, undefined, { loadingKey: 'toolbox.file.create' })
      tvsFiles.value.push(fileName)
      tvsFiles.value.sort()
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status
      if (status !== 409) {
        showMessage(`创建文件失败：${getErrorMessage(error)}`, 'error')
        return
      }
      // 409 = already exists on server, just not in our list
      if (!tvsFiles.value.includes(fileName)) {
        tvsFiles.value.push(fileName)
        tvsFiles.value.sort()
      }
    }
  }

  toolboxMap.value.push(createToolboxEntry({ alias, file: fileName, description: desc }))
  showCreateDialog.value = false

  await openFileInEditor(fileName, !fileExists)
  showMessage(`Toolbox "${alias}" 已创建，请保存映射表`, 'success')
}

/* ── Keyboard Shortcut ── */
function handleKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (fileDirty.value) {
      void saveToolboxFile()
      return
    }
    if (mapDirty.value) {
      void saveToolboxMap()
    }
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!hasPendingChanges.value) {
    return
  }

  event.preventDefault()
  event.returnValue = ''
}

/* ── Lifecycle ── */
onMounted(() => {
  loadToolboxMap()
  loadTvsFiles()
  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

onBeforeRouteLeave(async () => {
  if (!hasPendingChanges.value) {
    return true
  }

  return await askConfirm({
    message: '存在未保存的 Toolbox 改动，确定要离开吗？',
    danger: true,
    confirmText: '放弃改动',
  })
})
</script>

<style scoped>
.toolbox-manager-page {
  --toolbox-workspace-height: calc(var(--app-viewport-height, 100vh) - 150px);
  --toolbox-workspace-min-height: 520px;
}

.toolbox-page-summary {
  max-width: 390px;
  margin: 0 var(--space-2) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.35;
}

.toolbox-manager-shell {
  display: grid;
  grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
  gap: var(--space-4);
  min-height: var(--toolbox-workspace-min-height);
  height: max(var(--toolbox-workspace-height), var(--toolbox-workspace-min-height));
}

.toolbox-map-pane,
.toolbox-file-pane {
  min-width: 0;
  min-height: 0;
}

.toolbox-map-pane {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.toolbox-file-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.toolbox-file-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 58px;
  padding: var(--space-3) var(--space-4);
}

.toolbox-file-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.toolbox-pane-label {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--secondary-text) 72%, transparent);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.25;
  text-transform: uppercase;
}

.toolbox-file-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbox-file-name .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 16px !important;
}

.toolbox-file-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.toolbox-file-workspace {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: 0 var(--space-3) var(--space-3);
}

/* ── Search ── */
.toolbox-search {
  position: relative;
  margin-bottom: var(--space-3);
  width: 100%;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px !important;
  color: var(--secondary-text);
  pointer-events: none;
}

.search-input {
  padding-left: 36px;
  padding-right: 32px;
}

.search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.search-clear .material-symbols-outlined {
  font-size: 16px !important;
}

/* ── Map List ── */
.toolbox-map-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-1) var(--space-2) 0;
  scrollbar-gutter: stable;
}

.toolbox-map-entry {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 5%, transparent),
      color-mix(in srgb, var(--primary-text) 0.8%, transparent)
    );
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
  overflow: visible;
}

.toolbox-map-entry:hover {
  border-color: color-mix(in srgb, var(--button-bg) 24%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 8%, transparent),
      color-mix(in srgb, var(--primary-text) 1.8%, transparent)
    );
}

.toolbox-map-entry.is-active {
  border-color: color-mix(in srgb, var(--button-bg) 42%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 12%, transparent),
      color-mix(in srgb, var(--primary-text) 2.2%, transparent)
    );
}

.toolbox-map-entry.is-active::before {
  content: "";
  position: absolute;
  inset: 8px auto 8px 2px;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--button-bg);
}

.toolbox-entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.toolbox-entry-identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.toolbox-entry-identity > .material-symbols-outlined {
  flex: 0 0 auto;
  color: var(--secondary-text);
  font-size: 18px !important;
}

.toolbox-entry-title-group {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.toolbox-entry-title,
.toolbox-entry-file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbox-entry-title {
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 650;
  line-height: 1.25;
}

.toolbox-entry-file {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.3;
}

.toolbox-entry-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px var(--space-2);
}

.toolbox-entry-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  margin-bottom: 0;
}

.toolbox-entry-row--description {
  grid-column: 1 / -1;
}

.toolbox-entry-row--description :deep(.ui-textarea) {
  min-height: 66px;
  max-height: none;
  padding-block: 6px;
  overflow: hidden;
}

.toolbox-file-picker {
  width: 100%;
}

.toolbox-entry-row label {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1.25;
}

.input-validated {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.validation-hint {
  font-size: var(--font-size-helper);
  color: var(--danger-text);
  line-height: 1.3;
}

.toolbox-entry-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-left: auto;
}

.toolbox-entry-actions :deep(.ui-icon-button) {
  width: 28px;
  height: 28px;
}

.toolbox-entry-actions :deep(.ui-icon-button .material-symbols-outlined) {
  font-size: 16px !important;
}

/* ── Mode Toggle ── */
.editor-mode-toggle {
  display: flex;
  gap: 2px;
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 2px;
}

.mode-btn {
  gap: 4px;
  font-size: var(--font-size-helper);
}

.mode-btn.active {
  color: var(--on-accent-text);
  background: var(--button-bg);
}

.mode-btn .material-symbols-outlined {
  font-size: 16px !important;
}

/* ── File Editor ── */
.toolbox-file-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.editor-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-5);
  color: var(--secondary-text);
  min-height: 200px;
}

.editor-placeholder .material-symbols-outlined {
  font-size: 48px !important;
  opacity: 0.3;
}

.editor-placeholder p {
  margin: 0;
  font-size: var(--font-size-body);
}

/* ── Raw Editor ── */
.file-content-editor {
  flex: 1;
  width: 100%;
  min-height: 300px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.file-content-editor :deep(.ui-textarea),
.file-content-editor.ui-textarea {
  height: 100%;
  max-height: none;
  min-height: 300px;
  border-color: transparent;
  background: transparent;
  border-radius: 0;
  resize: none;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.file-content-editor :deep(.ui-textarea:hover:not(:disabled)),
.file-content-editor.ui-textarea:hover:not(:disabled),
.file-content-editor :deep(.ui-textarea:focus-visible),
.file-content-editor.ui-textarea:focus-visible {
  border-color: transparent;
  background: transparent;
}

/* ── Visual Editor ── */
.threshold-simulator {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  flex: 0 0 auto;
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--button-bg) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
}

.threshold-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  white-space: nowrap;
}

.threshold-label .material-symbols-outlined {
  font-size: 18px !important;
}

.threshold-slider {
  flex: 1;
  min-width: 100px;
}

.threshold-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  white-space: nowrap;
}

.fold-blocks-visual {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: var(--space-1);
  scrollbar-gutter: stable;
}

.fold-block-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.4%, transparent);
  transition:
    opacity var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.fold-block-card:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 22%, var(--border-color));
  background: color-mix(in srgb, var(--primary-text) 2.2%, transparent);
}

.fold-block-card.block-hidden {
  opacity: 0.52;
}

.fold-block-topline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex-wrap: nowrap;
}

.fold-block-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: max-content;
}

.block-index {
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 650;
  line-height: 1.25;
}

.fold-block-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.fold-block-field:first-of-type {
  flex: 0 1 250px;
}

.fold-block-field:nth-of-type(2) {
  flex: 1 1 280px;
}

.fold-block-field label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  min-width: 36px;
  flex-shrink: 0;
}

.block-threshold-slider {
  flex: 1;
  max-width: 112px;
}

.threshold-slider,
.block-threshold-slider {
  --range-progress: 100%;
  --range-track: color-mix(in srgb, var(--primary-text) 9%, transparent);
  --range-fill: var(--button-bg);
  --range-thumb-border: color-mix(in srgb, var(--button-bg) 52%, var(--border-color));
  appearance: none;
  height: 18px;
  margin: 0;
  border: 0;
  border-radius: var(--radius-full);
  background:
    linear-gradient(
      to right,
      var(--range-fill) 0 var(--range-progress),
      var(--range-track) var(--range-progress) 100%
    )
    center / 100% 4px no-repeat;
  cursor: pointer;
}

.threshold-slider:focus-visible,
.block-threshold-slider:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.threshold-slider::-webkit-slider-thumb,
.block-threshold-slider::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  border: 1px solid var(--range-thumb-border);
  border-radius: var(--radius-full);
  background: var(--primary-bg);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--primary-text) 18%, transparent);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.threshold-slider:hover::-webkit-slider-thumb,
.block-threshold-slider:hover::-webkit-slider-thumb {
  border-color: var(--button-bg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--button-bg) 12%, transparent);
}

.threshold-slider:active::-webkit-slider-thumb,
.block-threshold-slider:active::-webkit-slider-thumb {
  transform: scale(1.08);
}

.threshold-slider::-moz-range-track,
.block-threshold-slider::-moz-range-track {
  height: 4px;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--range-track);
}

.threshold-slider::-moz-range-progress,
.block-threshold-slider::-moz-range-progress {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--range-fill);
}

.threshold-slider::-moz-range-thumb,
.block-threshold-slider::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 1px solid var(--range-thumb-border);
  border-radius: var(--radius-full);
  background: var(--primary-bg);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--primary-text) 18%, transparent);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.threshold-slider:hover::-moz-range-thumb,
.block-threshold-slider:hover::-moz-range-thumb {
  border-color: var(--button-bg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--button-bg) 12%, transparent);
}

.block-threshold-input {
  width: 56px;
  font-size: var(--font-size-helper);
  text-align: center;
}

.block-desc-input {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-body);
}

.fold-block-content {
  width: 100%;
  min-height: 100px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.fold-block-content.ui-textarea {
  min-height: 100px;
  padding: var(--space-2) 0 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: 0;
  background: transparent;
  resize: vertical;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.fold-block-content.ui-textarea:hover:not(:disabled),
.fold-block-content.ui-textarea:focus-visible {
  border-color: color-mix(in srgb, var(--highlight-text) 32%, var(--border-color));
  background: transparent;
}

.block-divider {
  display: flex;
  justify-content: center;
  height: var(--space-2);
  margin: 0;
  padding: 0;
}

.add-block-button {
  opacity: 0;
  border: 1px dashed var(--border-color);
  width: 56px;
  transition:
    opacity var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.add-block-button .material-symbols-outlined {
  font-size: 18px !important;
}

.block-divider:hover .add-block-button,
.add-block-button:focus-visible {
  opacity: 1;
}

/* ── Editor Actions ── */
.editor-actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
}

/* ── Dialog ── */
.dialog-overlay {
  background: var(--overlay-backdrop-strong);
}

.dialog-card {
  padding: var(--space-5);
  min-width: 400px;
  max-width: 520px;
}

.dialog-card h4 {
  margin: 0 0 var(--space-4) 0;
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
}

.dialog-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.file-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-helper);
  line-height: 1.3;
}

.file-hint .material-symbols-outlined {
  font-size: 14px !important;
}

.file-hint.exists {
  color: var(--secondary-text);
}

.file-hint.create {
  color: var(--highlight-text);
}

/* ── Responsive ── */
@media (max-width: 1024px) {
  .toolbox-manager-shell {
    grid-template-columns: 1fr;
    height: auto;
  }

  .toolbox-entry-fields {
    grid-template-columns: 1fr;
  }

  .file-content-editor {
    min-height: 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fold-block-card,
  .add-block-button {
    transition: none;
  }
}
</style>

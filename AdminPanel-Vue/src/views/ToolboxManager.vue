<template>
  <section class="config-section active-section toolbox-manager-page">
    <p class="description">
      维护 toolbox_map.json（alias→file+description），并编辑 TVStxt 下映射文件内容。
    </p>

    <DualPaneEditor
      left-title="Toolbox 映射表"
      right-title="Toolbox 文件内容"
      :initial-left-width="450"
      :min-left-width="350"
      :max-left-width="600"
      collapsible
      persist-key="toolboxManager"
    >
      <template #left-actions>
        <div class="pane-toolbar pane-toolbar--left">
          <div class="pane-toolbar-main">
            <UiButton @click="openCreateDialog" variant="primary" size="sm" title="新建 Toolbox 映射">
              <template #leading>
                <span class="material-symbols-outlined">add</span>
              </template>
              新建
            </UiButton>
            <UiButton
              @click="saveToolboxMap"
              :disabled="mapSaving || !mapDirty"
              variant="primary"
              size="sm"
              title="保存映射表"
            >
              <template #leading>
                <span class="material-symbols-outlined">save</span>
              </template>
              {{ mapSaving ? '保存中…' : mapDirty ? '保存' : '已保存' }}
            </UiButton>
            <details class="pane-toolbar-menu">
              <summary class="pane-toolbar-menu-trigger" aria-label="更多操作" title="更多操作">
                <span class="material-symbols-outlined">more_vert</span>
              </summary>
              <div class="pane-toolbar-menu-content" role="menu" aria-label="Toolbox 映射更多操作">
                <button type="button" @click="refreshAll" class="pane-toolbar-menu-item">
                  <span class="material-symbols-outlined">refresh</span>
                  刷新数据
                </button>
              </div>
            </details>
          </div>
          <UiBadge
            :variant="mapDirty ? 'warning' : 'success'"
            :title="mapDirty ? '映射未保存' : '映射已同步'"
            :aria-label="mapDirty ? '映射未保存' : '映射已同步'"
          >
            {{ mapDirty ? '映射未保存' : '映射已同步' }}
          </UiBadge>
        </div>
      </template>

      <template #left-collapsed>
        <div class="collapsed-list">
          <button
            v-for="entry in toolboxMap"
            :key="entry.localId"
            type="button"
            class="collapsed-item"
            :class="{ active: editingFile === entry.file }"
            :title="entry.alias"
            @click="selectToolboxFile(entry.file)"
          >
            <span class="material-symbols-outlined">inventory_2</span>
            <span class="collapsed-label">{{ entry.alias }}</span>
          </button>
          <div v-if="toolboxMap.length === 0" class="collapsed-empty">
            <span class="material-symbols-outlined">inventory_2</span>
          </div>
        </div>
      </template>

      <template #left-content>
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
          <div v-for="entry in filteredToolboxMap" :key="entry.localId" class="toolbox-map-entry card">
            <div class="toolbox-entry-row">
              <label>别名 (Alias):</label>
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
              <label>文件名:</label>
              <div class="input-validated">
                <UiInput
                  type="text"
                  v-model="entry.file"
                  placeholder="例如：MyTool.txt"
                  list="tvs-files-datalist"
                  :invalid="Boolean(entry.file.trim()) && !isValidToolboxFileName(entry.file.trim())"
                />
                <span v-if="entry.file.trim() && !isValidToolboxFileName(entry.file.trim())" class="validation-hint">
                  文件名须以 .txt 或 .md 结尾，不可含非法字符
                </span>
              </div>
            </div>
            <div class="toolbox-entry-row">
              <label>描述:</label>
              <UiInput
                type="text"
                v-model="entry.description"
                placeholder="工具描述…"
                maxlength="200"
              />
            </div>
            <div class="toolbox-entry-actions">
              <UiButton
                @click="selectToolboxFile(entry.file)"
                variant="outline"
                size="sm"
                :disabled="!entry.file.trim() || !isValidToolboxFileName(entry.file.trim())"
              >
                <template #leading>
                  <span class="material-symbols-outlined">edit</span>
                </template>
                编辑
              </UiButton>
              <UiButton @click="removeToolboxEntry(entry.localId)" variant="danger" size="sm">
                <template #leading>
                  <span class="material-symbols-outlined">delete</span>
                </template>
                删除
              </UiButton>
            </div>
          </div>

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
      </template>

      <template #right-actions>
        <div v-if="editingFile" class="pane-toolbar pane-toolbar--right">
          <div class="pane-toolbar-main">
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
              {{ fileSaving ? '保存中…' : fileDirty ? '保存文件' : '已保存' }}
            </UiButton>
            <details class="pane-toolbar-menu">
              <summary class="pane-toolbar-menu-trigger" aria-label="文件更多操作" title="文件更多操作">
                <span class="material-symbols-outlined">more_vert</span>
              </summary>
              <div class="pane-toolbar-menu-content pane-toolbar-menu-content--right" role="menu" aria-label="文件更多操作">
                <button type="button" @click="deleteCurrentFile" class="pane-toolbar-menu-item pane-toolbar-menu-item--danger">
                  <span class="material-symbols-outlined">delete_forever</span>
                  删除文件
                </button>
              </div>
            </details>
          </div>
        </div>
      </template>

      <template #right-content>
        <div class="toolbox-file-editor">
          <div class="toolbox-editor-controls">
            <span class="editing-file-display">
              <span class="material-symbols-outlined">description</span>
              {{ editingFile || '未选择文件' }}
              <span v-if="fileDirty" class="dirty-indicator">（未保存）</span>
            </span>
          </div>

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
              >
              <span class="threshold-hint">
                {{ visibleBlockCount }}/{{ foldBlocks.length }} 块可见
              </span>
            </div>

            <div class="fold-blocks-visual">
              <template v-for="(block, i) in foldBlocks" :key="i">
                <div class="fold-block-card card" :class="{ 'block-hidden': block.threshold > simulatedThreshold }">
                  <div class="fold-block-header">
                    <span class="block-index">Block {{ i + 1 }}</span>
                    <UiBadge class="block-threshold-badge" :variant="thresholdVariant(block.threshold)">
                      {{ block.threshold.toFixed(2) }}
                    </UiBadge>
                    <UiBadge v-if="block.threshold > simulatedThreshold" variant="danger" class="block-folded-badge">折叠中</UiBadge>
                    <span class="flex-spacer"></span>
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
                  <div class="fold-block-meta">
                    <div class="fold-block-field">
                      <label>阈值:</label>
                      <input type="range" v-model.number="block.threshold" min="0" max="1" step="0.05" class="block-threshold-slider">
                      <UiInput type="number" v-model.number="block.threshold" min="0" max="1" step="0.05" class="block-threshold-input" size="sm" />
                    </div>
                    <div class="fold-block-field">
                      <label>语义描述:</label>
                      <UiInput type="text" v-model="block.description" placeholder="用于按块独立语义匹配（为空则按工具箱整体描述匹配）" class="block-desc-input" />
                    </div>
                  </div>
                  <UiTextarea
                    v-model="block.content"
                    class="fold-block-content"
                    rows="6"
                    spellcheck="false"
                    placeholder="输入此块的内容…"
                  />
                </div>
                <div class="block-divider">
                  <UiIconButton @click="addFoldBlockAfter(i)" class="add-block-button" label="在此处插入新块" title="在此处插入新块">
                    <span class="material-symbols-outlined">add_circle</span>
                  </UiIconButton>
                </div>
              </template>

              <UiButton @click="addFoldBlockAtEnd" variant="outline" size="sm" class="add-block-final">
                <template #leading>
                  <span class="material-symbols-outlined">add</span>
                </template>
                新增 Block
              </UiButton>
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
      </template>
    </DualPaneEditor>

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
import DualPaneEditor from '@/components/DualPaneEditor.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
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

async function selectToolboxFile(fileName: string) {
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
  if (idx !== -1) toolboxMap.value.splice(idx, 1)
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
.collapsed-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: center;
}

.collapsed-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  padding: 0;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.collapsed-item:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.collapsed-item.active {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--highlight-text) 52%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 10%, transparent);
}

.collapsed-label {
  display: none;
}

.collapsed-empty {
  color: var(--secondary-text);
}

.toolbox-manager-page {
  --dual-pane-min-height: 420px;
}

/* Allow both panes to expand naturally with content */
.toolbox-manager-page :deep(.dual-pane-editor) {
  height: auto;
  min-height: var(--dual-pane-min-height);
}

.toolbox-manager-page :deep(.pane) {
  overflow: visible;
}

/* 右侧 pane header 保持单行：标题 + 可视化/原始切换 + 保存 + more_vert */
.toolbox-manager-page :deep(.pane-right .pane-header) {
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-3);
}

.toolbox-manager-page :deep(.pane-right .pane-header h3) {
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbox-manager-page :deep(.pane-right .pane-toolbar),
.toolbox-manager-page :deep(.pane-right .pane-toolbar-main) {
  flex-wrap: nowrap;
  width: auto;
  flex: 0 0 auto;
}

.toolbox-manager-page :deep(.pane-content) {
  overflow-y: visible;
  flex: none;
}

/* ── Search ── */
.toolbox-search {
  position: relative;
  margin-bottom: var(--space-3);
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
  gap: var(--space-3);
}

.toolbox-map-entry {
  padding: var(--space-3);
  border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
}

.toolbox-entry-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.toolbox-entry-row label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 500;
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
  gap: var(--space-2);
  margin-top: var(--space-2);
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
}

.toolbox-editor-controls {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
}

.editing-file-display {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  font-weight: 500;
}

.editing-file-display .material-symbols-outlined {
  font-size: 18px !important;
}

.dirty-indicator {
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
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
  width: 100%;
  min-height: 400px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.file-content-editor.ui-textarea {
  min-height: 400px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

/* ── Visual Editor ── */
.threshold-simulator {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
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
  accent-color: var(--highlight-text);
}

.threshold-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  white-space: nowrap;
}

.fold-blocks-visual {
  display: flex;
  flex-direction: column;
}

.fold-block-card {
  padding: var(--space-3);
  border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
  transition: opacity var(--transition-fast);
}

.fold-block-card.block-hidden {
  opacity: 0.4;
}

.fold-block-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.block-index {
  font-weight: 600;
  font-size: var(--font-size-body);
  color: var(--primary-text);
}

.flex-spacer {
  flex: 1;
}

.fold-block-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.fold-block-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.fold-block-field label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  min-width: 56px;
  flex-shrink: 0;
}

.block-threshold-slider {
  flex: 1;
  max-width: 180px;
  accent-color: var(--highlight-text);
}

.block-threshold-input {
  width: 64px;
  font-size: var(--font-size-helper);
  text-align: center;
}

.block-desc-input {
  flex: 1;
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
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.block-divider {
  display: flex;
  justify-content: center;
  padding: var(--space-1) 0;
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

.add-block-final {
  align-self: flex-start;
  margin-top: var(--space-3);
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
  .file-content-editor {
    min-height: 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .collapsed-item,
  .fold-block-card,
  .add-block-button {
    transition: none;
  }
}
</style>

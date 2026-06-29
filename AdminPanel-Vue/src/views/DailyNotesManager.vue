<template>
  <section class="config-section active-section">
    <div class="daily-notes-manager">
      <FolderList
        :folders="folders"
        :selected-folder="selectedFolder"
        :folder-label="resourceConfig.folderLabel"
        @selectFolder="selectFolder"
      />

      <div class="notes-main-area">
        <RagTagsConfig
          v-if="resourceConfig.enableRagTags"
          :selected-folder="selectedFolder"
          :rag-tags-config="ragTagsConfig"
          :rag-tags-status="ragTagsStatus"
          :rag-tags-status-type="ragTagsStatusType"
          :mode="resourceMode"
          @clearAllTags="clearAllTags"
          @toggleThreshold="onThresholdToggle"
          @updateThreshold="updateThreshold"
          @addTag="addTag"
          @updateTag="updateTag"
          @removeTag="removeTag"
          @updateDescription="updateDescription"
          @saveRagTags="saveRagTags"
        />

        <NoteList
          v-if="!editingNote"
          :selected-folder="selectedFolder"
          :folders="folders"
          :filtered-notes="filteredNotes"
          :selected-notes="selectedNotes"
          :move-target-folder="moveTargetFolder"
          :search-query="searchQuery"
          :loading-notes="loadingNotes"
          :notes-status="notesStatus"
          :notes-status-type="notesStatusType"
          :item-label="resourceConfig.itemLabel"
          :folder-label="resourceConfig.folderLabel"
          :show-move-actions="resourceMode === 'diary'"
          :show-discovery-action="resourceConfig.enableDiscovery"
          @update:search-query="searchQuery = $event"
          @filterNotes="filterNotes"
          @moveSelectedNotes="moveSelectedNotes"
          @update:moveTargetFolder="moveTargetFolder = $event"
          @deleteSelectedNotes="deleteSelectedNotes"
          @update:selectedNotes="selectedNotes = $event"
          @editNote="editNote"
          @deleteNote="deleteNote"
          @discoveryNote="discoveryNote"
        />

        <DiaryEditor
          :editing-note="editingNote"
          :saving-note="savingNote"
          :editor-status="editorStatus"
          :editor-status-type="editorStatusType"
          @saveNote="saveNote"
          @cancelEdit="cancelEdit"
        >
          <template #editor-textarea>
            <textarea
              ref="markdownEditorRef"
              class="note-content-editor"
              spellcheck="false"
              rows="20"
              :placeholder="`编辑${resourceConfig.itemLabel}内容…`"
            ></textarea>
          </template>
        </DiaryEditor>
      </div>
    </div>

    <DiscoveryModal
      v-if="resourceConfig.enableDiscovery"
      v-model="showDiscoveryModal"
      :source-note="discoverySourceNote"
      :selected-folder="selectedFolder"
      @open-note="openNoteForEditing"
    />
  </section>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useDiaryStore, type DiaryNote, type DiaryResourceMode } from '@/stores/diary'
import { useMarkdownRenderer } from '@/composables/useMarkdownRenderer'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'
import 'easymde/dist/easymde.min.css'
import 'font-awesome/css/font-awesome.min.css'
import 'highlight.js/styles/github-dark.css'
import DiaryEditor from './DailyNotesManager/DiaryEditor.vue'
import DiscoveryModal from './DailyNotesManager/DiscoveryModal.vue'
import FolderList from './DailyNotesManager/FolderList.vue'
import NoteList from './DailyNotesManager/NoteList.vue'
import RagTagsConfig from './DailyNotesManager/RagTagsConfig.vue'

const route = useRoute()
const diaryStore = useDiaryStore()
const { initializeRenderer, renderMarkdownSync } = useMarkdownRenderer()
const {
  folders,
  selectedFolder,
  filteredNotes,
  selectedNotes,
  moveTargetFolder,
  searchQuery,
  loadingNotes,
  ragTagsConfig,
  ragTagsStatus,
  ragTagsStatusType,
  notesStatus,
  notesStatusType,
  resourceMode,
  resourceConfig
} = storeToRefs(diaryStore)

interface EditingDiaryNote extends DiaryNote {
  folder: string
}

const editingNote = ref<EditingDiaryNote | null>(null)
const savingNote = ref(false)
const isEditorInitializing = ref(false)
const editorStatus = ref('')
const editorStatusType = ref<'info' | 'success' | 'error'>('info')

const showDiscoveryModal = ref(false)
const discoverySourceNote = ref<{ file: string; title?: string } | null>(null)
const markdownEditorRef = ref<HTMLTextAreaElement | null>(null)

interface EasyMDEInstance {
  value(content?: string): string
  toTextArea(): void
}

interface EasyMDEConstructor {
  new (options: Record<string, unknown>): EasyMDEInstance
}

let easyMDE: EasyMDEInstance | null = null
let EasyMDEClass: EasyMDEConstructor | null = null

async function loadEasyMDE(): Promise<EasyMDEConstructor> {
  if (EasyMDEClass) {
    return EasyMDEClass
  }

  const module = await import('easymde')
  EasyMDEClass = module.default as unknown as EasyMDEConstructor
  return EasyMDEClass
}

async function initMarkdownEditor(content = ''): Promise<void> {
  if (isEditorInitializing.value) {
    return
  }

  await nextTick()
  isEditorInitializing.value = true

  if (easyMDE) {
    easyMDE.toTextArea()
    easyMDE = null
  }

  if (markdownEditorRef.value) {
    const EasyMDE = await loadEasyMDE()
    await initializeRenderer()

    easyMDE = new EasyMDE({
      element: markdownEditorRef.value,
      spellChecker: false,
      autoDownloadFontAwesome: false,
      status: ['lines', 'words', 'cursor'],
      minHeight: '500px',
      maxHeight: '700px',
      placeholder: `编辑${resourceConfig.value.itemLabel}内容，支持 Markdown`,
      toolbar: [
        'bold',
        'italic',
        'strikethrough',
        'heading',
        '|',
        'quote',
        'unordered-list',
        'ordered-list',
        '|',
        'link',
        'image',
        'table',
        'horizontal-rule',
        '|',
        'code',
        'preview',
        'side-by-side',
        'fullscreen',
        '|',
        'guide'
      ],
      renderingConfig: {
        singleLineBreaks: false,
        codeSyntaxHighlighting: true
      },
      previewRender: (plainText: string) => renderMarkdownSync(plainText)
    })

    if (content) {
      easyMDE.value(content)
    }
  }

  isEditorInitializing.value = false
}

async function selectFolder(folder: string): Promise<void> {
  await diaryStore.setSelectedFolder(folder)
}

function filterNotes(): void {
  void diaryStore.filterNotes()
}

function onThresholdToggle(enabled: boolean): void {
  diaryStore.onThresholdToggle(enabled)
}

function updateThreshold(value: number): void {
  diaryStore.updateThreshold(value)
}

async function clearAllTags(): Promise<void> {
  if (!(await askConfirm({
    message: `确定要清空所有 ${ragTagsConfig.value.tags.length} 个标签吗？此操作不可撤销。`,
    danger: true,
    confirmText: '清空标签',
  }))) {
    return
  }

  diaryStore.clearAllTags()
}

function addTag(): void {
  diaryStore.addTag()
}

function updateTag(payload: { index: number; value: string }): void {
  diaryStore.updateTag(payload)
}

function removeTag(index: number): void {
  diaryStore.removeTag(index)
}

function updateDescription(value: string): void {
  diaryStore.updateDescription(value)
}

async function saveRagTags(): Promise<void> {
  await diaryStore.saveRagTags()
}

async function editNote(note: DiaryNote): Promise<void> {
  const sourceFolder = selectedFolder.value
  if (!sourceFolder) {
    showMessage(`请先选择一个${resourceConfig.value.folderLabel}`, 'error')
    return
  }

  try {
    const content = await diaryStore.getNoteContent(note.file, sourceFolder)

    editingNote.value = {
      ...note,
      folder: sourceFolder,
      content
    }

    await nextTick()
    await initMarkdownEditor(content)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    editorStatus.value = `加载${resourceConfig.value.itemLabel}内容失败：${errorMessage}`
    editorStatusType.value = 'error'
    showMessage(`加载${resourceConfig.value.itemLabel}内容失败：${errorMessage}`, 'error')
  }
}

function discoveryNote(note: DiaryNote): void {
  discoverySourceNote.value = { file: note.file, title: note.title }
  showDiscoveryModal.value = true
}

async function openNoteForEditing(folder: string, file: string): Promise<void> {
  if (!folder || !file) {
    return
  }

  if (folder !== selectedFolder.value) {
    await diaryStore.setSelectedFolder(folder)
  }

  const targetNote = diaryStore.notes.find((note) => note.file === file) ?? {
    file,
    title: file.replace(/\.md$/i, ''),
    modified: ''
  }

  await editNote(targetNote)
}

async function saveNote(): Promise<void> {
  if (!editingNote.value || !selectedFolder.value) {
    return
  }

  savingNote.value = true
  editorStatus.value = '正在保存...'
  editorStatusType.value = 'info'

  try {
    const content = easyMDE ? easyMDE.value() : editingNote.value.content
    const saved = await diaryStore.saveNoteContent(
      editingNote.value.file,
      content || '',
      editingNote.value.folder
    )

    if (!saved) {
      throw new Error('保存失败')
    }

    editorStatus.value = `${resourceConfig.value.itemLabel}已保存`
    editorStatusType.value = 'success'
    showMessage(`${resourceConfig.value.itemLabel}已保存`, 'success')

    editingNote.value = null
    isEditorInitializing.value = false

    if (easyMDE) {
      easyMDE.toTextArea()
      easyMDE = null
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    editorStatus.value = `保存失败：${errorMessage}`
    editorStatusType.value = 'error'
  } finally {
    savingNote.value = false
  }
}

function cancelEdit(): void {
  editingNote.value = null
  isEditorInitializing.value = false

  if (easyMDE) {
    easyMDE.toTextArea()
    easyMDE = null
  }
}

async function deleteNote(note: DiaryNote): Promise<void> {
  if (!(await askConfirm({
    message: `确定要删除${resourceConfig.value.itemLabel} "${note.title || note.file}" 吗？`,
    danger: true,
    confirmText: '删除',
  }))) {
    return
  }

  await diaryStore.deleteNote(note.file)
}

async function deleteSelectedNotes(): Promise<void> {
  if (!(await askConfirm({
    message: `确定要删除选中的 ${selectedNotes.value.length} 个${resourceConfig.value.itemLabel}吗？`,
    danger: true,
    confirmText: '批量删除',
  }))) {
    return
  }

  await diaryStore.deleteSelectedNotesBatch()
}

async function moveSelectedNotes(): Promise<void> {
  await diaryStore.moveSelectedNotesBatch()
}

onUnmounted(() => {
  if (easyMDE) {
    easyMDE.toTextArea()
    easyMDE = null
  }
})

function resolveResourceMode(): DiaryResourceMode {
  return route.name === 'KnowledgeBaseManager' ? 'knowledge' : 'diary'
}

watch(
  () => route.name,
  () => {
    cancelEdit()
    void diaryStore.init(resolveResourceMode())
  }
)

onMounted(() => {
  void diaryStore.init(resolveResourceMode())
})
</script>

<style scoped>
.daily-notes-manager {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.notes-main-area {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  height: 100%;
  min-height: 400px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 2px var(--space-6) 0;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 24%, transparent) transparent;
}

.notes-main-area::-webkit-scrollbar {
  width: 8px;
}

.notes-main-area::-webkit-scrollbar-track {
  background: transparent;
}

.notes-main-area::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-full);
  background-color: color-mix(in srgb, var(--secondary-text) 24%, transparent);
  background-clip: padding-box;
}

.notes-main-area::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--secondary-text) 42%, transparent);
}

@media (max-width: 768px) {
  .daily-notes-manager {
    grid-template-columns: 1fr;
    height: auto;
    overflow: visible;
  }

  .notes-main-area {
    height: auto;
    overflow: visible;
    padding: 0;
  }
}
</style>

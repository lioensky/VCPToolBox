<template>
  <section class="config-section active-section">
    <div class="daily-notes-manager">
      <FolderList
        :folders="folders"
        :selected-folder="selectedFolder"
        @selectFolder="selectFolder"
      />

      <div class="notes-main-area">
        <RagTagsConfig
          :selected-folder="selectedFolder"
          :rag-tags-config="ragTagsConfig"
          :rag-tags-status="ragTagsStatus"
          :rag-tags-status-type="ragTagsStatusType"
          @addCommonTags="addAllCommonTags"
          @clearAllTags="clearAllTags"
          @toggleThreshold="onThresholdToggle"
          @updateThreshold="updateThreshold"
          @addTag="addTag"
          @updateTag="updateTag"
          @removeTag="removeTag"
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
              placeholder="编辑日记内容…"
            ></textarea>
          </template>
        </DiaryEditor>
      </div>
    </div>

    <DiscoveryModal
      v-model="showDiscoveryModal"
      :source-note="discoverySourceNote"
      :selected-folder="selectedFolder"
      @open-note="openNoteForEditing"
    />
  </section>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useDiaryStore, type DiaryNote } from '@/stores/diary'
import { showMessage } from '@/utils'
import 'easymde/dist/easymde.min.css'
import DiaryEditor from './DailyNotesManager/DiaryEditor.vue'
import DiscoveryModal from './DailyNotesManager/DiscoveryModal.vue'
import FolderList from './DailyNotesManager/FolderList.vue'
import NoteList from './DailyNotesManager/NoteList.vue'
import RagTagsConfig from './DailyNotesManager/RagTagsConfig.vue'

const diaryStore = useDiaryStore()
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
  notesStatusType
} = storeToRefs(diaryStore)

const editingNote = ref<DiaryNote | null>(null)
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

    easyMDE = new EasyMDE({
      element: markdownEditorRef.value,
      spellChecker: false,
      status: ['lines', 'words', 'cursor'],
      minHeight: '500px',
      maxHeight: '700px',
      placeholder: '编辑日记内容，支持 Markdown',
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
      }
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
  diaryStore.filterNotes()
}

function onThresholdToggle(): void {
  diaryStore.onThresholdToggle()
}

function updateThreshold(value: number): void {
  diaryStore.updateThreshold(value)
}

function clearAllTags(): void {
  if (!confirm(`确定要清空所有 ${ragTagsConfig.value.tags.length} 个标签吗？此操作不可撤销。`)) {
    return
  }

  diaryStore.clearAllTags()
}

function addAllCommonTags(): void {
  diaryStore.addAllCommonTags()
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

async function saveRagTags(): Promise<void> {
  await diaryStore.saveRagTags()
}

async function editNote(note: DiaryNote): Promise<void> {
  if (!selectedFolder.value) {
    showMessage('请先选择一个知识库', 'error')
    return
  }

  try {
    const content = await diaryStore.getNoteContent(note.file)

    editingNote.value = {
      ...note,
      content
    }

    await nextTick()
    await initMarkdownEditor(content)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    editorStatus.value = `加载日记内容失败：${errorMessage}`
    editorStatusType.value = 'error'
    showMessage(`加载日记内容失败：${errorMessage}`, 'error')
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
    const saved = await diaryStore.saveNoteContent(editingNote.value.file, content || '')

    if (!saved) {
      throw new Error('保存失败')
    }

    editorStatus.value = '日记已保存'
    editorStatusType.value = 'success'
    showMessage('日记已保存', 'success')

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
  if (!confirm(`确定要删除日记 "${note.title || note.file}" 吗？`)) {
    return
  }

  await diaryStore.deleteNote(note.file)
}

async function deleteSelectedNotes(): Promise<void> {
  if (!confirm(`确定要删除选中的 ${selectedNotes.value.length} 篇日记吗？`)) {
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

onMounted(() => {
  diaryStore.init()
})
</script>

<style scoped>
.daily-notes-manager {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 24px;
}

.notes-main-area {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 400px;
}

@media (max-width: 768px) {
  .daily-notes-manager {
    grid-template-columns: 1fr;
  }
}
</style>

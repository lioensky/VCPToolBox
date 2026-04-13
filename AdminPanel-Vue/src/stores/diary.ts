import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { diaryApi } from '@/api'
import { showMessage } from '@/utils'
import {
  DEFAULT_RAG_TAGS_CONFIG,
  filterDiaryNotes,
  getMissingCommonRagTags,
  type RagTagsConfig,
} from '@/stores/diary/helpers'

export interface DiaryNote {
  file: string
  title?: string
  modified: string
  content?: string
  preview?: string
}

export const useDiaryStore = defineStore('diary', () => {
  const folders = ref<string[]>([])
  const selectedFolder = ref('')

  const notes = ref<DiaryNote[]>([])
  const filteredNotes = computed(() => filterDiaryNotes(notes.value, searchQuery.value))
  const selectedNotes = ref<string[]>([])
  const moveTargetFolder = ref('')
  const searchQuery = ref('')
  const loadingNotes = ref(false)

  const ragTagsConfig = ref<RagTagsConfig>({ ...DEFAULT_RAG_TAGS_CONFIG })

  const ragTagsStatus = ref('')
  const ragTagsStatusType = ref<'info' | 'success' | 'error'>('info')
  const notesStatus = ref('')
  const notesStatusType = ref<'info' | 'success' | 'error'>('info')

  function resetRagTagsConfig() {
    ragTagsConfig.value = { ...DEFAULT_RAG_TAGS_CONFIG }
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  function filterNotes() {
    // 兼容旧调用方：filteredNotes 已由 computed 自动更新
  }

  async function loadFolders() {
    try {
      const data = await diaryApi.getFolders()
      folders.value = data.map((folder) => folder.name)

      if (folders.value.length > 0) {
        const nextFolder = selectedFolder.value && folders.value.includes(selectedFolder.value)
          ? selectedFolder.value
          : folders.value[0]
        await setSelectedFolder(nextFolder)
      } else {
        selectedFolder.value = ''
        notes.value = []
        resetRagTagsConfig()
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`加载知识库列表失败：${errorMessage}`, 'error')
      folders.value = []
    }
  }

  async function setSelectedFolder(folder: string) {
    selectedFolder.value = folder
    selectedNotes.value = []
    moveTargetFolder.value = ''
    await Promise.all([loadNotes(), loadRagTags()])
  }

  async function loadNotes() {
    if (!selectedFolder.value) return

    loadingNotes.value = true
    try {
      const data = await diaryApi.getDiaryList({ folder: selectedFolder.value })
      notes.value = data.notes.map((note) => ({
        file: note.file,
        title: note.title,
        modified: note.modified,
        preview: note.preview
      }))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `加载日记列表失败：${errorMessage}`
      notesStatusType.value = 'error'
      notes.value = []
    } finally {
      loadingNotes.value = false
    }
  }

  async function loadRagTags() {
    if (!selectedFolder.value) return

    try {
      ragTagsConfig.value = await diaryApi.getRagTagsConfig(selectedFolder.value)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`加载 RAG 标签失败：${errorMessage}`, 'error')
    }
  }

  function onThresholdToggle() {
    if (!ragTagsConfig.value.thresholdEnabled) {
      ragTagsConfig.value.threshold = 0.7
    }
  }

  function updateThreshold(value: number) {
    ragTagsConfig.value.threshold = value
  }

  function clearAllTags() {
    if (ragTagsConfig.value.tags.length === 0) {
      showMessage('当前没有标签', 'info')
      return
    }
    ragTagsConfig.value.tags = []
    showMessage('已清空所有标签', 'success')
  }

  function addAllCommonTags() {
    const newTags = getMissingCommonRagTags(ragTagsConfig.value.tags)

    if (newTags.length === 0) {
      showMessage('所有常用标签已存在', 'info')
      return
    }

    ragTagsConfig.value.tags.push(...newTags)
    showMessage(`已添加 ${newTags.length} 个常用标签`, 'success')
  }

  function addTag() {
    ragTagsConfig.value.tags.push('')
  }

  function updateTag(payload: { index: number; value: string }) {
    if (payload.index < 0 || payload.index >= ragTagsConfig.value.tags.length) {
      return
    }
    ragTagsConfig.value.tags[payload.index] = payload.value
  }

  function removeTag(index: number) {
    ragTagsConfig.value.tags.splice(index, 1)
  }

  async function saveRagTags() {
    if (!selectedFolder.value) return false

    try {
      const config: { tags: string[]; threshold?: number } = {
        tags: ragTagsConfig.value.tags.filter((tag) => tag.trim())
      }
      if (ragTagsConfig.value.thresholdEnabled) {
        config.threshold = ragTagsConfig.value.threshold
      }

      await diaryApi.saveRagTagsConfig(selectedFolder.value, {
        thresholdEnabled: ragTagsConfig.value.thresholdEnabled,
        threshold: ragTagsConfig.value.threshold,
        tags: config.tags
      }, {
        loadingKey: 'diary.rag-tags.save'
      })

      ragTagsStatus.value = 'RAG 标签已保存！'
      ragTagsStatusType.value = 'success'
      showMessage('RAG 标签已保存！', 'success')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      ragTagsStatus.value = `保存失败：${errorMessage}`
      ragTagsStatusType.value = 'error'
      return false
    }
  }

  async function getNoteContent(file: string): Promise<string> {
    if (!selectedFolder.value) {
      throw new Error('请先选择一个知识库')
    }

    return diaryApi.getDiaryContent(`${selectedFolder.value}/${file}`)
  }

  async function saveNoteContent(file: string, content: string): Promise<boolean> {
    if (!selectedFolder.value) return false

    try {
      await diaryApi.saveDiary(
        `${selectedFolder.value}/${file}`,
        content,
        {
          loadingKey: 'diary.note.save'
        }
      )

      showMessage('日记已保存！', 'success')
      await loadNotes()
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `保存失败：${errorMessage}`
      notesStatusType.value = 'error'
      return false
    }
  }

  async function deleteNote(file: string): Promise<boolean> {
    if (!selectedFolder.value) return false

    try {
      await diaryApi.deleteDiary([`${selectedFolder.value}/${file}`], {
        loadingKey: 'diary.note.delete'
      })

      notesStatus.value = '日记已删除'
      notesStatusType.value = 'success'
      await loadNotes()
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `删除失败：${errorMessage}`
      notesStatusType.value = 'error'
      return false
    }
  }

  async function deleteSelectedNotesBatch(): Promise<boolean> {
    if (!selectedFolder.value || selectedNotes.value.length === 0) return false

    try {
      await diaryApi.deleteDiary(
        selectedNotes.value.map((file) => `${selectedFolder.value}/${file}`),
        {
        loadingKey: 'diary.notes.batch-delete'
        }
      )

      notesStatus.value = '已批量删除选中的日记'
      notesStatusType.value = 'success'
      selectedNotes.value = []
      await loadNotes()
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `批量删除失败：${errorMessage}`
      notesStatusType.value = 'error'
      return false
    }
  }

  async function moveSelectedNotesBatch(): Promise<boolean> {
    if (!selectedFolder.value || !moveTargetFolder.value || selectedNotes.value.length === 0) return false

    try {
      await diaryApi.moveDiaries(
        selectedNotes.value.map((file) => ({
          folder: selectedFolder.value,
          file
        })),
        moveTargetFolder.value,
        {
        loadingKey: 'diary.notes.batch-move'
        }
      )

      notesStatus.value = `已移动 ${selectedNotes.value.length} 篇日记到 ${moveTargetFolder.value}`
      notesStatusType.value = 'success'
      selectedNotes.value = []
      moveTargetFolder.value = ''
      await loadNotes()
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `移动失败：${errorMessage}`
      notesStatusType.value = 'error'
      return false
    }
  }

  async function init() {
    await loadFolders()
  }

  return {
    folders,
    selectedFolder,
    notes,
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
    init,
    setSearchQuery,
    filterNotes,
    loadFolders,
    setSelectedFolder,
    loadNotes,
    loadRagTags,
    onThresholdToggle,
    updateThreshold,
    clearAllTags,
    addAllCommonTags,
    addTag,
    updateTag,
    removeTag,
    saveRagTags,
    getNoteContent,
    saveNoteContent,
    deleteNote,
    deleteSelectedNotesBatch,
    moveSelectedNotesBatch
  }
})

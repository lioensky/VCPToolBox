import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { diaryApi, type DiaryOperationError } from '@/api'
import { showMessage } from '@/utils'
import {
  DEFAULT_RAG_TAGS_CONFIG,
  type RagTagsConfig,
} from '@/stores/diary/helpers'

export interface DiaryNote {
  file: string
  title?: string
  modified: string
  content?: string
  preview?: string
}

export type DiaryResourceMode = 'diary' | 'knowledge'

const RESOURCE_CONFIG = {
  diary: {
    label: '日记',
    folderLabel: '日记本',
    itemLabel: '日记',
    basePath: '/admin_api/dailynotes',
    enableRagTags: true,
    enableDiscovery: true,
  },
  knowledge: {
    label: '知识库',
    folderLabel: '知识库',
    itemLabel: '文件',
    basePath: '/admin_api/knowledge',
    enableRagTags: false,
    enableDiscovery: false,
  },
} as const

export const useDiaryStore = defineStore('diary', () => {
  const resourceMode = ref<DiaryResourceMode>('diary')
  const resourceConfig = computed(() => RESOURCE_CONFIG[resourceMode.value])
  const folders = ref<string[]>([])
  const selectedFolder = ref('')

  const notes = ref<DiaryNote[]>([])
  const searchQuery = ref('')
  const filteredNotes = computed(() => notes.value)
  const selectedNotes = ref<string[]>([])
  const moveTargetFolder = ref('')
  const loadingNotes = ref(false)
  let notesRequestId = 0

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

  async function filterNotes() {
    await loadNotes()
  }

  async function loadFolders() {
    try {
      const data = await diaryApi.getFolders(undefined, resourceConfig.value.basePath)
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
      showMessage(`加载${resourceConfig.value.folderLabel}列表失败：${errorMessage}`, 'error')
      folders.value = []
    }
  }

  async function setSelectedFolder(folder: string) {
    selectedFolder.value = folder
    selectedNotes.value = []
    moveTargetFolder.value = ''
    if (resourceConfig.value.enableRagTags) {
      await Promise.all([loadNotes(), loadRagTags()])
    } else {
      resetRagTagsConfig()
      await loadNotes()
    }
  }

  async function loadNotes() {
    const requestId = ++notesRequestId
    const folder = selectedFolder.value
    const search = searchQuery.value.trim()
    if (!folder) return

    loadingNotes.value = true
    try {
      const data = await diaryApi.getDiaryList({ folder, search, basePath: resourceConfig.value.basePath })
      if (requestId !== notesRequestId || folder !== selectedFolder.value) {
        return
      }

      notes.value = data.notes.map((note) => ({
        file: note.file,
        title: note.title,
        modified: note.modified,
        preview: note.preview
      }))
    } catch (error) {
      if (requestId !== notesRequestId) {
        return
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `加载${resourceConfig.value.itemLabel}列表失败：${errorMessage}`
      notesStatusType.value = 'error'
      notes.value = []
    } finally {
      if (requestId === notesRequestId) {
        loadingNotes.value = false
      }
    }
  }

  async function loadRagTags() {
    if (!selectedFolder.value || !resourceConfig.value.enableRagTags) return

    try {
      ragTagsConfig.value = await diaryApi.getRagTagsConfig(selectedFolder.value)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`加载 RAG 标签失败：${errorMessage}`, 'error')
    }
  }

  function onThresholdToggle(enabled: boolean) {
    ragTagsConfig.value.thresholdEnabled = enabled
    if (enabled && !Number.isFinite(ragTagsConfig.value.threshold)) {
      ragTagsConfig.value.threshold = 0.7
    }
  }

  function updateThreshold(value: number) {
    ragTagsConfig.value.threshold = Math.min(1, Math.max(0.1, value))
  }

  function clearAllTags() {
    if (ragTagsConfig.value.tags.length === 0) {
      showMessage('当前没有标签', 'info')
      return
    }
    ragTagsConfig.value.tags = []
    showMessage('已清空所有标签', 'success')
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

  async function getNoteContent(file: string, folder = selectedFolder.value): Promise<string> {
    if (!folder) {
      throw new Error(`请先选择一个${resourceConfig.value.folderLabel}`)
    }

    return diaryApi.getDiaryContent(`${folder}/${file}`, undefined, resourceConfig.value.basePath)
  }

  async function saveNoteContent(file: string, content: string, folder = selectedFolder.value): Promise<boolean> {
    if (!folder) return false

    try {
      await diaryApi.saveDiary(
        `${folder}/${file}`,
        content,
        {
          loadingKey: 'diary.note.save'
        },
        resourceConfig.value.basePath
      )

      showMessage(`${resourceConfig.value.itemLabel}已保存！`, 'success')
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
      const response = await diaryApi.deleteDiary([`${selectedFolder.value}/${file}`], {
        loadingKey: 'diary.note.delete'
      }, resourceConfig.value.basePath)

      if ((response.errors || []).length > 0) {
        throw new Error(formatOperationErrors(response.errors || []))
      }

      notesStatus.value = `${resourceConfig.value.itemLabel}已删除`
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
      const response = await diaryApi.deleteDiary(
        selectedNotes.value.map((file) => `${selectedFolder.value}/${file}`),
        {
        loadingKey: 'diary.notes.batch-delete'
        },
        resourceConfig.value.basePath
      )

      const errors = response.errors || []
      const deletedFiles = new Set(response.deleted.map((entry) => entry.split(/[\\/]/).pop() || entry))
      selectedNotes.value = selectedNotes.value.filter((file) => !deletedFiles.has(file))

      if (errors.length > 0) {
        notesStatus.value = `已删除 ${response.deleted.length} 篇，${errors.length} 篇失败：${formatOperationErrors(errors)}`
        notesStatusType.value = 'error'
        showMessage(notesStatus.value, 'error')
      } else {
        notesStatus.value = `已批量删除选中的${resourceConfig.value.itemLabel}`
        notesStatusType.value = 'success'
        selectedNotes.value = []
      }

      await loadNotes()
      return errors.length === 0
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
      const response = await diaryApi.moveDiaries(
        selectedNotes.value.map((file) => ({
          folder: selectedFolder.value,
          file
        })),
        moveTargetFolder.value,
        {
        loadingKey: 'diary.notes.batch-move'
        },
        resourceConfig.value.basePath
      )

      const errors = response.errors || []
      const failedFiles = new Set(errors.map((entry) => entry.note.split(/[\\/]/).pop() || entry.note))
      const movedCount = response.moved.length
      selectedNotes.value = selectedNotes.value.filter((file) => failedFiles.has(file))

      if (errors.length > 0) {
        notesStatus.value = `已移动 ${movedCount} 篇到 ${moveTargetFolder.value}，${errors.length} 篇失败：${formatOperationErrors(errors)}`
        notesStatusType.value = 'error'
        showMessage(notesStatus.value, 'error')
      } else {
        notesStatus.value = `已移动 ${movedCount} 个${resourceConfig.value.itemLabel}到 ${moveTargetFolder.value}`
        notesStatusType.value = 'success'
        selectedNotes.value = []
        moveTargetFolder.value = ''
      }

      await loadNotes()
      return errors.length === 0
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notesStatus.value = `移动失败：${errorMessage}`
      notesStatusType.value = 'error'
      return false
    }
  }

  async function init(mode: DiaryResourceMode = 'diary') {
    resourceMode.value = mode
    selectedFolder.value = ''
    notes.value = []
    selectedNotes.value = []
    moveTargetFolder.value = ''
    searchQuery.value = ''
    resetRagTagsConfig()
    await loadFolders()
  }

  function formatOperationErrors(errors: DiaryOperationError[]): string {
    return errors
      .slice(0, 2)
      .map((entry) => `${entry.note}: ${entry.error}`)
      .join('；')
  }

  return {
    resourceMode,
    resourceConfig,
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

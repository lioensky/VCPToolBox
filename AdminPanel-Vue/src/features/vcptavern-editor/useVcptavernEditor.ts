import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { vcptavernApi } from '@/api'
import type { RuleRole, TavernPreset, TavernRule } from '@/api'
import { usePointerDragSession } from '@/composables/usePointerDragSession'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'
import { createLogger } from '@/utils/logger'
import {
  getVerticalDropPlacement,
  reorderIdsByPlacement,
  type PointerDropPlacement,
} from '@/utils/pointerReorder'

const logger = createLogger('VcptavernEditor')

const PRESET_NAME_RE = /^[a-zA-Z0-9_-]+$/
const MAX_DEPTH = 999
const DESCRIPTION_MAX_LENGTH = 2000
const CONTENT_MAX_LENGTH = 50000

function makeRuleId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') {
    return `rule-${c.randomUUID()}`
  }
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function clampDepth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_DEPTH, Math.max(1, Math.floor(n)))
}

export function useVcptavernEditor() {
  const presetNames = ref<string[]>([])
  const selectedPresetName = ref('')
  const isLoading = ref(false)
  const isSaving = ref(false)
  const isEditorVisible = ref(false)
  const isNewPreset = ref(false)
  const isDirty = ref(false)
  const collapsedRules = ref<Set<string>>(new Set())
  const suppressListAnimation = ref(false)

  const previewOrder = ref<string[] | null>(null)
  const draggingRuleId = ref<string | null>(null)
  const dragOverRuleId = ref<string | null>(null)
  const dropPlacement = ref<PointerDropPlacement>('after')

  const editorState = reactive({
    name: '',
    description: '',
    rules: [] as TavernRule[],
  })

  // --- Dirty tracking ---

  let cleanSnapshot = ''
  let isApplyingExternal = false

  function takeSnapshot(): string {
    return JSON.stringify({
      name: editorState.name,
      description: editorState.description,
      rules: editorState.rules,
    })
  }

  function markClean() {
    cleanSnapshot = takeSnapshot()
    isDirty.value = false
  }

  watch(
    () => ({ n: editorState.name, d: editorState.description, r: editorState.rules }),
    () => {
      if (isApplyingExternal) return
      if (!isEditorVisible.value) return
      // Once dirty, stay dirty until explicit markClean — avoids O(size) stringify per keystroke.
      if (isDirty.value) return
      isDirty.value = takeSnapshot() !== cleanSnapshot
    },
    { deep: true },
  )

  async function confirmDiscardChanges(): Promise<boolean> {
    if (!isDirty.value) return true
    return askConfirm('当前预设有未保存的更改，是否放弃更改？')
  }

  // --- Name validation ---

  const nameValidationError = computed(() => {
    const name = editorState.name.trim()
    if (!name) return ''
    if (!PRESET_NAME_RE.test(name)) {
      return '预设名称只能包含字母、数字、下划线和连字符'
    }
    return ''
  })

  const nameConflictWarning = computed(() => {
    if (!isNewPreset.value) return ''
    const name = editorState.name.trim()
    if (!name || nameValidationError.value) return ''
    if (presetNames.value.includes(name)) {
      return `已存在同名预设，保存将覆盖`
    }
    return ''
  })

  // --- Drag state ---

  const dragState = {
    get draggingRuleId(): string | null {
      return draggingRuleId.value
    },
    get dragOverRuleId(): string | null {
      return dragOverRuleId.value
    },
    get dropPlacement(): PointerDropPlacement {
      return dropPlacement.value
    },
  }

  const orderedRules = computed<TavernRule[]>(() => {
    if (!previewOrder.value) {
      return editorState.rules
    }

    const itemMap = new Map(editorState.rules.map((rule) => [rule.id, rule] as const))
    return previewOrder.value
      .map((id) => itemMap.get(id))
      .filter((rule): rule is TavernRule => rule !== undefined)
  })

  function getCommittedOrder(): string[] {
    return editorState.rules.map((rule) => rule.id)
  }

  function getWorkingOrder(): string[] {
    return previewOrder.value ?? getCommittedOrder()
  }

  function commitPreviewOrder(nextOrder: readonly string[]) {
    const itemMap = new Map(editorState.rules.map((rule) => [rule.id, rule] as const))
    editorState.rules = nextOrder
      .map((id) => itemMap.get(id))
      .filter((rule): rule is TavernRule => rule !== undefined)
  }

  function updatePreviewOrder(clientX: number, clientY: number) {
    const draggedId = draggingRuleId.value
    if (!draggedId || typeof document === 'undefined') {
      return
    }

    const hoveredElement = document.elementFromPoint(clientX, clientY)
    if (!(hoveredElement instanceof Element)) {
      dragOverRuleId.value = null
      return
    }

    const workingOrder = getWorkingOrder()
    const cardElement = hoveredElement.closest('[data-rule-id]') as HTMLElement | null
    const listElement = hoveredElement.closest('[data-rules-list="true"]') as HTMLElement | null

    let targetId: string | null = null
    let placement: PointerDropPlacement = 'after'

    if (cardElement) {
      targetId = cardElement.dataset.ruleId ?? null
      placement = getVerticalDropPlacement(cardElement, clientY)
    } else if (listElement && workingOrder.length > 0) {
      targetId = workingOrder[workingOrder.length - 1] ?? null
      placement = 'after'
    }

    if (!targetId) {
      dragOverRuleId.value = null
      return
    }

    const nextOrder = reorderIdsByPlacement(workingOrder, draggedId, targetId, placement)
    const hasChanged = nextOrder.some((id, index) => id !== workingOrder[index])

    dragOverRuleId.value = hasChanged ? targetId : null
    dropPlacement.value = placement

    if (hasChanged) {
      previewOrder.value = nextOrder
    }
  }

  // --- Rule helpers ---

  function generateRuleId(): string {
    return makeRuleId()
  }

  function newRule(): TavernRule {
    return {
      id: generateRuleId(),
      name: '新规则',
      enabled: true,
      type: 'relative',
      position: 'before',
      target: 'system',
      depth: 1,
      content: {
        role: 'system',
        content: '',
      },
    }
  }

  function normalizeRule(rule: Partial<TavernRule>): TavernRule {
    const base = newRule()
    const merged: TavernRule = {
      ...base,
      ...rule,
      id: rule.id || base.id,
      content: {
        role: (rule.content?.role as RuleRole) || base.content.role,
        content: rule.content?.content || '',
      },
    }
    // Drop legacy ui field if present on old stored presets.
    delete (merged as unknown as Record<string, unknown>).ui
    if (merged.depth !== undefined) {
      merged.depth = clampDepth(merged.depth)
    }
    return merged
  }

  // --- Drag session ---

  const { dragGhost, dragGhostElement, startPointerDrag } =
    usePointerDragSession<{ ruleId: string }, { label: string; meta: string }>({
      createGhost: ({ ruleId }) => {
        const activeRule = editorState.rules.find((rule) => rule.id === ruleId) ?? null
        if (!activeRule) {
          return null
        }

        return {
          label: activeRule.name || '未命名规则',
          meta: activeRule.type,
        }
      },
      onActivate: ({ item }) => {
        draggingRuleId.value = item.ruleId
        previewOrder.value = getCommittedOrder()
      },
      onFrame: (state) => {
        updatePreviewOrder(state.currentX, state.currentY)
      },
      onCommit: () => {
        if (previewOrder.value) {
          commitPreviewOrder(previewOrder.value)
        }
      },
      onClear: () => {
        previewOrder.value = null
        draggingRuleId.value = null
        dragOverRuleId.value = null
        dropPlacement.value = 'after'
      },
    })

  // --- API operations ---

  async function fetchPresets() {
    isLoading.value = true
    try {
      presetNames.value = await vcptavernApi.getPresets({
        showLoader: false,
        loadingKey: 'vcptavern.presets.load',
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('获取预设列表失败:', error)
      showMessage(`获取预设列表失败：${errorMessage}`, 'error')
    } finally {
      isLoading.value = false
    }
  }

  async function loadPreset(name: string) {
    if (!name) {
      return
    }

    isLoading.value = true
    try {
      const data = await vcptavernApi.getPreset(name, {
        showLoader: false,
        loadingKey: 'vcptavern.preset.load',
      })

      isApplyingExternal = true
      suppressListAnimation.value = true
      editorState.name = name
      editorState.description = data.description || ''
      editorState.rules = (data.rules || []).map((rule) => normalizeRule(rule))
      isEditorVisible.value = true
      isNewPreset.value = false
      collapsedRules.value = new Set()
      markClean()
      await nextTick()
      isApplyingExternal = false
      suppressListAnimation.value = false
      showMessage(`已加载预设：${name}`, 'success')
    } catch (error) {
      isApplyingExternal = false
      suppressListAnimation.value = false
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('加载预设失败:', error)
      showMessage(`加载预设失败：${errorMessage}`, 'error')
    } finally {
      isLoading.value = false
    }
  }

  async function selectPreset(name: string) {
    if (!name) return
    if (name === selectedPresetName.value && isEditorVisible.value && !isNewPreset.value) return

    if (!(await confirmDiscardChanges())) return

    selectedPresetName.value = name
    await loadPreset(name)
  }

  async function createNewPreset() {
    if (!(await confirmDiscardChanges())) return

    isApplyingExternal = true
    suppressListAnimation.value = true
    selectedPresetName.value = ''
    editorState.name = ''
    editorState.description = ''
    editorState.rules = []
    isEditorVisible.value = true
    isNewPreset.value = true
    collapsedRules.value = new Set()
    markClean()
    await nextTick()
    isApplyingExternal = false
    suppressListAnimation.value = false
  }

  function addRule() {
    editorState.rules.push(newRule())
  }

  async function removeRule(index: number) {
    const currentRules = orderedRules.value
    const targetRule = currentRules[index]
    if (!targetRule) {
      return
    }

    if (!(await askConfirm({
      message: `确定要删除规则「${targetRule.name || '未命名规则'}」吗？`,
      danger: true,
      confirmText: '删除',
    }))) {
      return
    }

    const sourceIndex = editorState.rules.findIndex((rule) => rule.id === targetRule.id)
    if (sourceIndex >= 0) {
      editorState.rules.splice(sourceIndex, 1)
    }
  }

  function duplicateRule(index: number) {
    const currentRules = orderedRules.value
    const sourceRule = currentRules[index]
    if (!sourceRule) return

    const copy: TavernRule = JSON.parse(JSON.stringify(sourceRule))
    copy.id = generateRuleId()
    copy.name = `${sourceRule.name} (副本)`

    const sourceIndex = editorState.rules.findIndex((rule) => rule.id === sourceRule.id)
    if (sourceIndex >= 0) {
      editorState.rules.splice(sourceIndex + 1, 0, copy)
    } else {
      editorState.rules.push(copy)
    }

    void nextTick().then(() => {
      if (typeof document === 'undefined') return
      const el = document.querySelector(`[data-rule-id="${copy.id}"]`)
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    })
  }

  function toggleRuleCollapse(ruleId: string) {
    const next = new Set(collapsedRules.value)
    if (next.has(ruleId)) {
      next.delete(ruleId)
    } else {
      next.add(ruleId)
    }
    collapsedRules.value = next
  }

  function isRuleCollapsed(ruleId: string): boolean {
    return collapsedRules.value.has(ruleId)
  }

  function handleRulePointerDown(ruleId: string, event: PointerEvent) {
    const currentTarget = event.currentTarget
    if (!(currentTarget instanceof HTMLElement)) {
      return
    }

    const cardElement = currentTarget.closest('[data-rule-id]') as HTMLElement | null
    if (!(cardElement instanceof HTMLElement)) {
      return
    }

    startPointerDrag({
      item: { ruleId },
      event,
      itemElement: cardElement,
      captureElement: currentTarget,
    })
  }

  async function deletePreset() {
    const name = selectedPresetName.value
    if (!name) {
      return
    }

    if (!(await askConfirm({
      message: `确定要删除预设 "${name}" 吗？此操作不可撤销。`,
      danger: true,
      confirmText: '删除预设',
    }))) {
      return
    }

    isLoading.value = true
    try {
      await vcptavernApi.deletePreset(name, {
        loadingKey: 'vcptavern.preset.delete',
      })
      showMessage('预设删除成功', 'success')

      isApplyingExternal = true
      selectedPresetName.value = ''
      editorState.name = ''
      editorState.description = ''
      editorState.rules = []
      isEditorVisible.value = false
      isNewPreset.value = false
      markClean()
      await nextTick()
      isApplyingExternal = false

      await fetchPresets()
    } catch (error) {
      isApplyingExternal = false
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('删除预设失败:', error)
      showMessage(`删除预设失败：${errorMessage}`, 'error')
    } finally {
      isLoading.value = false
    }
  }

  function validatePresetName(name: string): boolean {
    return PRESET_NAME_RE.test(name)
  }

  async function savePreset() {
    const name = editorState.name.trim()
    if (!name) {
      showMessage('请输入预设名称', 'error')
      return
    }

    if (!validatePresetName(name)) {
      showMessage('预设名称只能包含字母、数字、下划线和连字符', 'error')
      return
    }

    if (isNewPreset.value && presetNames.value.includes(name)) {
      if (!(await askConfirm({
        message: `预设 "${name}" 已存在，是否覆盖？`,
        danger: true,
        confirmText: '覆盖',
      }))) {
        return
      }
    }

    isSaving.value = true
    try {
      const payload: TavernPreset = {
        description: editorState.description.trim().slice(0, DESCRIPTION_MAX_LENGTH),
        rules: editorState.rules.map((rule) => {
          const normalized = normalizeRule(rule)
          if (normalized.content?.content) {
            normalized.content.content = normalized.content.content.slice(0, CONTENT_MAX_LENGTH)
          }
          if (normalized.type !== 'depth') {
            delete normalized.depth
          } else {
            normalized.depth = clampDepth(normalized.depth)
          }
          if (normalized.type === 'depth') {
            delete normalized.position
            delete normalized.target
          }
          if (normalized.type === 'embed') {
            normalized.content.role = 'system'
            if (normalized.target === 'all_user') {
              normalized.target = 'last_user'
            }
          }
          return normalized
        }),
      }

      await vcptavernApi.savePreset(name, payload, {
        loadingKey: 'vcptavern.preset.save',
      })

      showMessage('预设保存成功', 'success')
      selectedPresetName.value = name
      isNewPreset.value = false
      markClean()
      await fetchPresets()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('保存预设失败:', error)
      showMessage(`保存预设失败：${errorMessage}`, 'error')
    } finally {
      isSaving.value = false
    }
  }

  // --- Unsaved-changes guards ---

  function beforeUnloadHandler(event: BeforeUnloadEvent) {
    if (!isDirty.value) return
    event.preventDefault()
    // Some browsers show a generic message; returnValue retained for compatibility.
    event.returnValue = ''
  }

  onMounted(async () => {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', beforeUnloadHandler)
    }
    await fetchPresets()
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', beforeUnloadHandler)
    }
  })

  return {
    presetNames,
    selectedPresetName,
    isLoading,
    isSaving,
    isEditorVisible,
    isNewPreset,
    isDirty,
    nameValidationError,
    nameConflictWarning,
    suppressListAnimation,
    dragState,
    dragGhost,
    dragGhostElement,
    orderedRules,
    editorState,
    confirmDiscardChanges,
    fetchPresets,
    selectPreset,
    createNewPreset,
    addRule,
    removeRule,
    duplicateRule,
    toggleRuleCollapse,
    isRuleCollapsed,
    handleRulePointerDown,
    deletePreset,
    savePreset,
  }
}

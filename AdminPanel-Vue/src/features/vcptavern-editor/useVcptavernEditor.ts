import { computed, onMounted, reactive, ref } from 'vue'
import { vcptavernApi } from '@/api'
import type { RuleRole, TavernPreset, TavernRule } from '@/api'
import { usePointerDragSession } from '@/composables/usePointerDragSession'
import { showMessage } from '@/utils'
import { createLogger } from '@/utils/logger'
import {
  getVerticalDropPlacement,
  reorderIdsByPlacement,
  type PointerDropPlacement,
} from '@/utils/pointerReorder'

const logger = createLogger('VcptavernEditor')

export function useVcptavernEditor() {
  const presetNames = ref<string[]>([])
  const selectedPresetName = ref('')
  const isLoading = ref(false)
  const isSaving = ref(false)
  const isEditorVisible = ref(false)
  const isNewPreset = ref(false)

  const previewOrder = ref<string[] | null>(null)
  const draggingRuleId = ref<string | null>(null)
  const dragOverRuleId = ref<string | null>(null)
  const dropPlacement = ref<PointerDropPlacement>('after')

  const editorState = reactive({
    name: '',
    description: '',
    rules: [] as TavernRule[],
  })

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

  function newRule(): TavernRule {
    return {
      id: `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      ui: {
        textareaWidth: '',
        textareaHeight: '',
      },
    }
  }

  function normalizeRule(rule: Partial<TavernRule>): TavernRule {
    const base = newRule()
    return {
      ...base,
      ...rule,
      id: rule.id || base.id,
      content: {
        role: (rule.content?.role as RuleRole) || base.content.role,
        content: rule.content?.content || '',
      },
    }
  }

  const { dragGhost, dragGhostElement, startPointerDrag, handlePointerMove, handlePointerUp } =
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

      editorState.name = name
      editorState.description = data.description || ''
      editorState.rules = (data.rules || []).map((rule) => normalizeRule(rule))
      isEditorVisible.value = true
      isNewPreset.value = false
      showMessage(`已加载预设：${name}`, 'success')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('加载预设失败:', error)
      showMessage(`加载预设失败：${errorMessage}`, 'error')
    } finally {
      isLoading.value = false
    }
  }

  function createNewPreset() {
    selectedPresetName.value = ''
    editorState.name = ''
    editorState.description = ''
    editorState.rules = []
    isEditorVisible.value = true
    isNewPreset.value = true
  }

  function addRule() {
    editorState.rules.push(newRule())
  }

  function removeRule(index: number) {
    const currentRules = orderedRules.value
    const targetRule = currentRules[index]
    if (!targetRule) {
      return
    }

    const sourceIndex = editorState.rules.findIndex((rule) => rule.id === targetRule.id)
    if (sourceIndex >= 0) {
      editorState.rules.splice(sourceIndex, 1)
    }
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

    if (!confirm(`确定要删除预设 "${name}" 吗？此操作不可撤销。`)) {
      return
    }

    isLoading.value = true
    try {
      await vcptavernApi.deletePreset(name, {
        loadingKey: 'vcptavern.preset.delete',
      })
      showMessage('预设删除成功', 'success')
      createNewPreset()
      isEditorVisible.value = false
      await fetchPresets()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('删除预设失败:', error)
      showMessage(`删除预设失败：${errorMessage}`, 'error')
    } finally {
      isLoading.value = false
    }
  }

  function validatePresetName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name)
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

    isSaving.value = true
    try {
      const payload: TavernPreset = {
        description: editorState.description.trim(),
        rules: editorState.rules.map((rule) => {
          const normalized = normalizeRule(rule)
          if (normalized.type !== 'depth') {
            delete normalized.depth
          }
          if (normalized.type === 'depth') {
            delete normalized.position
            delete normalized.target
          }
          if (normalized.type === 'embed') {
            normalized.content.role = 'system'
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
      await fetchPresets()
      await loadPreset(name)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('保存预设失败:', error)
      showMessage(`保存预设失败：${errorMessage}`, 'error')
    } finally {
      isSaving.value = false
    }
  }

  onMounted(async () => {
    await fetchPresets()
  })

  return {
    presetNames,
    selectedPresetName,
    isLoading,
    isSaving,
    isEditorVisible,
    isNewPreset,
    dragState,
    dragGhost,
    dragGhostElement,
    handlePointerMove,
    handlePointerUp,
    orderedRules,
    editorState,
    fetchPresets,
    loadPreset,
    createNewPreset,
    addRule,
    removeRule,
    handleRulePointerDown,
    deletePreset,
    savePreset,
  }
}

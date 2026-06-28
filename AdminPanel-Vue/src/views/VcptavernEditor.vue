<template>
  <section class="config-section active-section vcp-tavern-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          variant="outline"
          :disabled="isLoading"
          @click="fetchPresets"
        >
          刷新
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="page-header">
      <div>
        <p class="description">
          管理上下文注入预设与规则。按住规则左侧手柄可像仪表盘一样实时预览排序位置，
          并在释放时提交最终顺序。
        </p></div>
    </div>

    <UiCard class="preset-toolbar" size="sm">
      <UiField label="选择预设" for-id="preset-select" class="preset-select-field">
        <UiSelect
          id="preset-select"
          v-model="selectedPresetName"
          :disabled="isLoading"
        >
          <option value="">-- 选择一个预设 --</option>
          <option v-for="name in presetNames" :key="name" :value="name">
            {{ name }}
          </option>
        </UiSelect>
      </UiField>

      <UiButton
        variant="primary"
        :disabled="!selectedPresetName || isLoading"
        @click="selectPreset(selectedPresetName)"
      >
        加载
      </UiButton>
      <UiButton
        variant="outline"
        :disabled="isLoading"
        @click="createNewPreset"
      >
        新建
      </UiButton>
      <UiButton
        variant="danger"
        :disabled="!selectedPresetName || isLoading"
        @click="deletePreset"
      >
        删除
      </UiButton>
    </UiCard>

    <UiEmptyState
      v-if="!isEditorVisible"
      title="请选择预设"
      description="选择一个预设进行编辑，或点击新建创建预设。"
    />

    <UiCard v-else class="editor" size="sm">
      <div class="meta-grid">
        <UiField label="预设名称" for-id="preset-name">
          <UiInput
            id="preset-name"
            v-model.trim="editorState.name"
            type="text"
            placeholder="仅限字母、数字、下划线和连字符"
            :disabled="!isNewPreset"
          />
        </UiField>
        <UiField label="预设描述" for-id="preset-description" class="full-width">
          <UiTextarea
            id="preset-description"
            v-model="editorState.description"
            rows="3"
            placeholder="描述预设用途"
          />
        </UiField>
      </div>

      <div class="rules-header">
        <h3>注入规则</h3>
        <UiButton variant="outline" size="sm" @click="addRule">
          添加规则
        </UiButton>
      </div>

      <UiEmptyState
        v-if="editorState.rules.length === 0"
        title="暂无规则"
        description="点击添加规则创建第一条注入规则。"
      />

      <TransitionGroup
        tag="div"
        name="drag-sort"
        class="rules-list"
        data-rules-list="true"
      >
        <article
          v-for="(rule, index) in orderedRules"
          :key="rule.id"
          :data-rule-id="rule.id"
          :class="[
            'rule-card',
            {
              'rule-card--dragging': dragState.draggingRuleId === rule.id,
              'rule-card--drop-before':
                dragState.draggingRuleId !== null &&
                dragState.dragOverRuleId === rule.id &&
                dragState.dropPlacement === 'before',
              'rule-card--drop-after':
                dragState.draggingRuleId !== null &&
                dragState.dragOverRuleId === rule.id &&
                dragState.dropPlacement === 'after',
            },
          ]"
        >
          <div class="rule-head">
            <DragHandle
              label="拖动排序"
              @pointerdown="handleRulePointerDown(rule.id, $event)"
            />
            <UiInput
              v-model="rule.name"
              class="rule-title"
              type="text"
              placeholder="规则名称"
            />
            <div class="enabled-switch">
              <span>{{ rule.enabled ? "启用" : "停用" }}</span>
              <AppSwitch v-model="rule.enabled" />
            </div>
            <UiButton variant="danger" size="sm" @click="removeRule(index)">
              删除
            </UiButton>
          </div>

          <div class="rule-body">
            <UiField label="注入类型">
              <UiSelect v-model="rule.type">
                <option value="relative">相对注入</option>
                <option value="depth">深度注入</option>
                <option value="embed">嵌入</option>
              </UiSelect>
            </UiField>

            <UiField
              v-if="rule.type === 'relative' || rule.type === 'embed'"
              label="相对位置"
            >
              <UiSelect v-model="rule.position">
                <option value="before">之前</option>
                <option value="after">之后</option>
              </UiSelect>
            </UiField>

            <UiField
              v-if="rule.type === 'relative' || rule.type === 'embed'"
              label="目标"
            >
              <UiSelect v-model="rule.target">
                <option value="system">系统提示</option>
                <option value="last_user">最后的用户消息</option>
                <option value="first_user">第一个用户消息</option>
              </UiSelect>
            </UiField>

            <UiField v-if="rule.type === 'depth'" label="深度">
              <UiInput v-model.number="rule.depth" type="number" min="1" />
            </UiField>

            <UiField v-if="rule.type !== 'embed'" label="注入角色">
              <UiSelect v-model="rule.content.role">
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </UiSelect>
            </UiField>

            <UiField label="注入内容" class="full-width">
              <UiTextarea
                v-model="rule.content.content"
                rows="5"
                placeholder="请输入要注入的文本"
              />
            </UiField>
          </div>
        </article>
      </TransitionGroup>

      <div class="editor-actions">
        <UiButton
          variant="primary"
          :disabled="isSaving"
          @click="savePreset"
        >
          {{ isSaving ? "保存中…" : "保存预设" }}
        </UiButton></div>
    </UiCard>

    <div v-if="dragGhost" ref="dragGhostElement" class="rule-drag-ghost">
      <div class="rule-drag-ghost-shell">
        <div class="rule-drag-ghost-title">{{ dragGhost.label }}</div>
        <div class="rule-drag-ghost-meta">{{ dragGhost.meta }}</div>
      </div></div>
  </section>
</template>

<script setup lang="ts">
import AppSwitch from "@/components/ui/AppSwitch.vue";
import DragHandle from "@/components/ui/DragHandle.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import { useVcptavernEditor } from "@/features/vcptavern-editor/useVcptavernEditor";

const {
  presetNames,
  selectedPresetName,
  isLoading,
  isSaving,
  isEditorVisible,
  isNewPreset,
  dragState,
  dragGhost,
  dragGhostElement,
  orderedRules,
  editorState,
  fetchPresets,
  selectPreset,
  createNewPreset,
  addRule,
  removeRule,
  handleRulePointerDown,
  deletePreset,
  savePreset,
} = useVcptavernEditor();

void dragGhostElement
</script>

<style scoped>
.vcp-tavern-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
}

.preset-toolbar {
  min-width: 0;
}

.preset-toolbar :deep(.ui-card__content) {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) auto auto auto;
  gap: var(--space-2);
  align-items: end;
}

.preset-select-field {
  min-width: 0;
}

.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(220px, 1fr));
  gap: var(--space-3);
}

.full-width {
  grid-column: 1 / -1;
}

.rules-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.rules-header h3 {
  margin: 0;
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.rule-card {
  position: relative;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  will-change: transform;
  transition:
    opacity 0.18s ease,
    filter 0.18s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.rule-card:hover {
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.rule-card--dragging {
  opacity: 0.16;
  filter: saturate(0.88);
}

.rule-card--drop-before::before,
.rule-card--drop-after::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  z-index: 2;
  height: 2px;
  border-radius: 999px;
  background: var(--highlight-text);
}

.rule-card--drop-before::before {
  top: -6px;
}

.rule-card--drop-after::after {
  bottom: -6px;
}

.rule-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: var(--space-2);
  align-items: center;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
}

.rule-title {
  font-weight: 600;
}

.enabled-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.rule-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.rule-drag-ghost {
  position: fixed;
  z-index: 60;
  pointer-events: none;
  will-change: left, top, transform;
}

.rule-drag-ghost-shell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100%;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 35%, var(--border-color));
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
  box-shadow: var(--shadow-lg);
}

.rule-drag-ghost-title {
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.3;
  color: var(--primary-text);
}

.rule-drag-ghost-meta {
  margin-top: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
  text-transform: capitalize;
}

.drag-sort-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.drag-sort-enter-active,
.drag-sort-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.drag-sort-enter-from,
.drag-sort-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 980px) {
  .preset-toolbar :deep(.ui-card__content) {
    grid-template-columns: 1fr;
  }

  .meta-grid {
    grid-template-columns: 1fr;
  }

  .rule-head {
    grid-template-columns: auto 1fr;
  }

  .enabled-switch,
  .rule-head :deep(.ui-button) {
    grid-column: 1 / -1;
  }
}
</style>

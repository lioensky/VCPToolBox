<template>
  <section class="config-section active-section vcp-tavern-page">
    <div class="page-header">
      <div>
        <p class="description">
          管理上下文注入预设与规则。按住规则左侧手柄可像仪表盘一样实时预览排序位置，
          并在释放时提交最终顺序。
        </p>
      </div>
      <div class="header-actions">
        <button
          class="btn-secondary"
          type="button"
          :disabled="isLoading"
          @click="fetchPresets"
        >
          刷新
        </button>
      </div>
    </div>

    <div class="preset-toolbar card">
      <label for="preset-select">选择预设</label>
      <select
        id="preset-select"
        v-model="selectedPresetName"
        :disabled="isLoading"
      >
        <option value="">-- 选择一个预设 --</option>
        <option v-for="name in presetNames" :key="name" :value="name">
          {{ name }}
        </option>
      </select>

      <button
        class="btn-primary"
        type="button"
        :disabled="!selectedPresetName || isLoading"
        @click="loadPreset(selectedPresetName)"
      >
        加载
      </button>
      <button
        class="btn-secondary"
        type="button"
        :disabled="isLoading"
        @click="createNewPreset"
      >
        新建
      </button>
      <button
        class="btn-danger"
        type="button"
        :disabled="!selectedPresetName || isLoading"
        @click="deletePreset"
      >
        删除
      </button>
    </div>

    <div v-if="!isEditorVisible" class="empty-tip card">
      <p>请选择一个预设进行编辑，或点击“新建”创建预设。</p>
    </div>

    <div v-else class="editor card">
      <div class="meta-grid">
        <div class="form-group">
          <label for="preset-name">预设名称</label>
          <input
            id="preset-name"
            v-model.trim="editorState.name"
            type="text"
            placeholder="仅限字母、数字、下划线和连字符"
            :disabled="!isNewPreset"
          />
        </div>
        <div class="form-group full-width">
          <label for="preset-description">预设描述</label>
          <textarea
            id="preset-description"
            v-model="editorState.description"
            rows="3"
            placeholder="描述预设用途"
          ></textarea>
        </div>
      </div>

      <div class="rules-header">
        <h3>注入规则</h3>
        <button class="btn-secondary" type="button" @click="addRule">
          添加规则
        </button>
      </div>

      <div v-if="editorState.rules.length === 0" class="empty-rules">
        暂无规则，点击“添加规则”创建。
      </div>

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
            <button
              class="drag-handle"
              type="button"
              aria-label="拖动排序"
              title="拖动排序"
              @pointerdown="handleRulePointerDown(rule.id, $event)"
            >
              ⋮⋮
            </button>
            <input
              v-model="rule.name"
              class="rule-title"
              type="text"
              placeholder="规则名称"
            />
            <label class="enabled-switch">
              <input v-model="rule.enabled" type="checkbox" />
              <span>{{ rule.enabled ? "启用" : "停用" }}</span>
            </label>
            <button
              class="btn-danger btn-sm"
              type="button"
              @click="removeRule(index)"
            >
              删除
            </button>
          </div>

          <div class="rule-body">
            <div class="form-group">
              <label>注入类型</label>
              <select v-model="rule.type">
                <option value="relative">相对注入</option>
                <option value="depth">深度注入</option>
                <option value="embed">嵌入</option>
              </select>
            </div>

            <div
              v-if="rule.type === 'relative' || rule.type === 'embed'"
              class="form-group"
            >
              <label>相对位置</label>
              <select v-model="rule.position">
                <option value="before">之前</option>
                <option value="after">之后</option>
              </select>
            </div>

            <div
              v-if="rule.type === 'relative' || rule.type === 'embed'"
              class="form-group"
            >
              <label>目标</label>
              <select v-model="rule.target">
                <option value="system">系统提示</option>
                <option value="last_user">最后的用户消息</option>
              </select>
            </div>

            <div v-if="rule.type === 'depth'" class="form-group">
              <label>深度</label>
              <input v-model.number="rule.depth" type="number" min="1" />
            </div>

            <div v-if="rule.type !== 'embed'" class="form-group">
              <label>注入角色</label>
              <select v-model="rule.content.role">
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </div>

            <div class="form-group full-width">
              <label>注入内容</label>
              <textarea
                v-model="rule.content.content"
                rows="5"
                placeholder="请输入要注入的文本"
              ></textarea>
            </div>
          </div>
        </article>
      </TransitionGroup>

      <div class="editor-actions">
        <button
          class="btn-success"
          type="button"
          :disabled="isSaving"
          @click="savePreset"
        >
          {{ isSaving ? "保存中…" : "保存预设" }}
        </button>
      </div>
    </div>

    <div v-if="dragGhost" ref="dragGhostElement" class="rule-drag-ghost">
      <div class="rule-drag-ghost-shell">
        <div class="rule-drag-ghost-title">{{ dragGhost.label }}</div>
        <div class="rule-drag-ghost-meta">{{ dragGhost.meta }}</div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
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
  loadPreset,
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
  gap: 16px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.header-actions {
  display: flex;
  gap: var(--space-3);
}

.preset-toolbar {
  display: grid;
  grid-template-columns: minmax(110px, auto) minmax(240px, 1fr) auto auto auto;
  gap: 10px;
  align-items: center;
}

.preset-toolbar label {
  color: var(--secondary-text);
}

.preset-toolbar select {
  width: 100%;
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

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group.full-width {
  grid-column: 1 / -1;
}

.form-group label {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

input,
select,
textarea {
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  color: var(--primary-text);
  border-radius: var(--radius-sm);
  padding: 10px;
}

textarea {
  resize: vertical;
}

input:focus-visible,
select:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.rules-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  will-change: transform;
  transition:
    opacity 0.18s ease,
    filter 0.18s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.rule-card:hover {
  border-color: var(--highlight-text);
  box-shadow: var(--shadow-md);
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
  grid-template-columns: auto 1fr auto auto;
  gap: 10px;
  align-items: center;
}

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  color: var(--secondary-text);
  border-radius: var(--radius-sm);
  width: 44px;
  height: 44px;
  padding: 0;
  cursor: grab;
  font-size: var(--font-size-body);
  flex-shrink: 0;
  user-select: none;
  touch-action: none;
}

.drag-handle:active {
  cursor: grabbing;
}

.rule-title {
  font-weight: 600;
}

.enabled-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--secondary-text);
}

.rule-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
}

.empty-tip,
.empty-rules {
  color: var(--secondary-text);
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
  padding: 16px;
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
  .preset-toolbar {
    grid-template-columns: 1fr 1fr;
  }

  .preset-toolbar label {
    grid-column: 1 / -1;
  }

  .meta-grid {
    grid-template-columns: 1fr;
  }

  .rule-head {
    grid-template-columns: auto 1fr;
  }

  .enabled-switch,
  .rule-head .btn-danger {
    grid-column: 1 / -1;
  }
}
</style>

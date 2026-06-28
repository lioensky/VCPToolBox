<template>
  <UiCard
    v-if="editingNote"
    class="note-editor-area"
    size="sm"
    variant="subtle"
  >
    <div class="editor-header">
      <div class="editor-title-section">
        <UiIconButton
          class="editor-back-button"
          label="返回日记列表"
          title="返回日记列表"
          aria-label="返回日记列表"
          @click="$emit('cancelEdit')"
        >
          <span class="material-symbols-outlined">arrow_back</span>
        </UiIconButton>
        <h3>编辑日记：{{ editingNote.file }}</h3>
      </div>
      <div class="editor-actions">
        <UiButton
          variant="primary"
          size="md"
          :disabled="savingNote"
          @click="$emit('saveNote')"
        >
          {{ savingNote ? "保存中…" : "保存日记" }}
        </UiButton>
        <UiButton
          variant="outline"
          size="md"
          :disabled="savingNote"
          @click="$emit('cancelEdit')"
        >
          取消编辑
        </UiButton>
        <UiBadge
          v-if="editorStatus"
          :variant="editorStatusBadgeVariant"
          class="editor-status"
        >
          {{ editorStatus }}
        </UiBadge>
      </div>
    </div>

    <div class="markdown-editor-wrapper">
      <slot name="editor-textarea"></slot>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";

interface Note {
  file: string;
}

const props = defineProps<{
  editingNote: Note | null;
  savingNote: boolean;
  editorStatus: string;
  editorStatusType: "info" | "success" | "error";
}>();

defineEmits<{
  (e: "saveNote"): void;
  (e: "cancelEdit"): void;
}>();

const editorStatusBadgeVariant = computed(() =>
  props.editorStatusType === "error" ? "danger" : props.editorStatusType
);
</script>

<style scoped>
.note-editor-area {
  visibility: visible;
  opacity: 1;
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
  gap: var(--space-4);
}

.editor-title-section {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.editor-title-section h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-title);
}

.editor-back-button .material-symbols-outlined {
  font-size: var(--font-size-title) !important;
}

.editor-actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.markdown-editor-wrapper {
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  max-width: 90ch;
  margin-inline: auto;
}

:deep(.EasyMDEContainer) {
  background: var(--input-bg);
  border: none;
  color: var(--primary-text);
}

:deep(.EasyMDEContainer .editor-toolbar) {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border-bottom-color: var(--border-color);
}

:deep(.EasyMDEContainer .editor-toolbar button) {
  color: var(--primary-text) !important;
}

:deep(.EasyMDEContainer .editor-toolbar button:hover) {
  background: color-mix(in srgb, var(--primary-text) 4%, transparent) !important;
}

:deep(.EasyMDEContainer .CodeMirror) {
  background: var(--input-bg);
  color: var(--primary-text);
  border: none;
  min-height: 500px;
}

:deep(.EasyMDEContainer .CodeMirror .CodeMirror-lines) {
  color: var(--primary-text);
}

:deep(.EasyMDEContainer .CodeMirror .cm-header) {
  color: var(--highlight-text);
}

:deep(.EasyMDEContainer .CodeMirror .cm-link) {
  color: var(--highlight-text);
}

:deep(.EasyMDEContainer .CodeMirror-cursor) {
  border-color: var(--primary-text);
}

:deep(.EasyMDEContainer .editor-statusbar) {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border-top-color: var(--border-color);
  color: var(--secondary-text);
}

:deep(.editor-toolbar.fullscreen) {
  background: var(--secondary-bg);
}

:deep(.CodeMirror-fullscreen) {
  background: var(--secondary-bg) !important;
}

@media (max-width: 768px) {
  .note-editor-area {
    border-radius: var(--radius-sm);
  }

  .editor-header {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .editor-title-section {
    width: 100%;
    align-items: flex-start;
  }

  .editor-title-section h3 {
    font-size: var(--font-size-body);
    line-height: 1.4;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .editor-actions {
    width: 100%;
    justify-content: flex-start;
    align-items: stretch;
    flex-wrap: wrap;
    gap: 8px;
  }

  .editor-actions :deep(.ui-button) {
    flex: 1 1 calc(50% - 4px);
    min-height: 40px;
  }

  .editor-actions .editor-status {
    width: 100%;
  }

  :deep(.EasyMDEContainer .editor-toolbar) {
    overflow-x: auto;
    white-space: nowrap;
  }

  :deep(.EasyMDEContainer .CodeMirror) {
    min-height: 320px;
  }
}
</style>

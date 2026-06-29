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
  width: 100%;
  max-width: 100%;
  margin-inline: 0;
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

/* 预览渲染面板 - 主题适配（修复深色模式白底白字 / 半透明叠加问题）
   注意：用 --primary-bg 作为不透明兜底底色，再叠 --secondary-bg 主题层，
   防止 --secondary-bg 在某些主题下为半透明导致的“叠加”穿透。 */
:deep(.EasyMDEContainer .editor-preview),
:deep(.EasyMDEContainer .editor-preview-side),
:deep(.editor-preview-full),
:deep(.editor-preview-side) {
  background-color: var(--primary-bg) !important;
  background-image: linear-gradient(var(--secondary-bg), var(--secondary-bg)) !important;
  background-repeat: no-repeat !important;
  color: var(--primary-text) !important;
  border-color: var(--border-color) !important;
}

/* 预览处于激活态时，强制隐藏底下 CodeMirror，防止透字叠影 */
:deep(.EasyMDEContainer .CodeMirror.CodeMirror-preview-active),
:deep(.editor-preview-active) ~ :deep(.CodeMirror),
:deep(.EasyMDEContainer .CodeMirror:has(+ .editor-preview-active)),
:deep(.EasyMDEContainer .CodeMirror:has(~ .editor-preview-active)) {
  visibility: hidden !important;
}

/* EasyMDE 在全屏预览时会给 .editor-preview-active 加上类，
   保险起见用 sibling 选择器把同级 CodeMirror 整个收起来 */
:deep(.EasyMDEContainer .editor-preview-active) {
  z-index: 8;
}

:deep(.EasyMDEContainer .editor-preview p),
:deep(.EasyMDEContainer .editor-preview-side p),
:deep(.EasyMDEContainer .editor-preview li),
:deep(.EasyMDEContainer .editor-preview-side li),
:deep(.EasyMDEContainer .editor-preview span:not([class^="hljs-"]):not([class*=" hljs-"])),
:deep(.EasyMDEContainer .editor-preview-side span:not([class^="hljs-"]):not([class*=" hljs-"])) {
  color: var(--primary-text) !important;
}

:deep(.EasyMDEContainer .editor-preview h1),
:deep(.EasyMDEContainer .editor-preview h2),
:deep(.EasyMDEContainer .editor-preview h3),
:deep(.EasyMDEContainer .editor-preview h4),
:deep(.EasyMDEContainer .editor-preview h5),
:deep(.EasyMDEContainer .editor-preview h6),
:deep(.EasyMDEContainer .editor-preview-side h1),
:deep(.EasyMDEContainer .editor-preview-side h2),
:deep(.EasyMDEContainer .editor-preview-side h3),
:deep(.EasyMDEContainer .editor-preview-side h4),
:deep(.EasyMDEContainer .editor-preview-side h5),
:deep(.EasyMDEContainer .editor-preview-side h6) {
  color: var(--primary-text) !important;
}

:deep(.EasyMDEContainer .editor-preview a),
:deep(.EasyMDEContainer .editor-preview-side a) {
  color: var(--highlight-text) !important;
}

/* 行内 code 使用主题色调，pre+hljs 块走 highlight.js 主题 */
:deep(.EasyMDEContainer .editor-preview code:not(.hljs)),
:deep(.EasyMDEContainer .editor-preview-side code:not(.hljs)) {
  background: color-mix(in srgb, var(--primary-text) 8%, transparent) !important;
  color: var(--primary-text) !important;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.92em;
}

:deep(.EasyMDEContainer .editor-preview pre),
:deep(.EasyMDEContainer .editor-preview-side pre) {
  background: transparent !important;
  padding: 0 !important;
  margin: 0.8em 0;
}

:deep(.EasyMDEContainer .editor-preview pre code.hljs),
:deep(.EasyMDEContainer .editor-preview-side pre code.hljs) {
  display: block;
  padding: 14px 16px !important;
  border-radius: var(--radius-sm, 6px);
  font-size: 0.9em;
  line-height: 1.55;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

/* 浅色模式：用浅色 hljs 配色，覆盖默认引入的 github-dark */
:root[data-theme="light"] :deep(.EasyMDEContainer .editor-preview pre code.hljs),
:root[data-theme="light"] :deep(.EasyMDEContainer .editor-preview-side pre code.hljs) {
  background: #f6f8fa !important;
  color: #24292e !important;
}

:root[data-theme="light"] :deep(.hljs-comment),
:root[data-theme="light"] :deep(.hljs-quote) {
  color: #6a737d !important;
}

:root[data-theme="light"] :deep(.hljs-keyword),
:root[data-theme="light"] :deep(.hljs-selector-tag),
:root[data-theme="light"] :deep(.hljs-literal),
:root[data-theme="light"] :deep(.hljs-built_in),
:root[data-theme="light"] :deep(.hljs-type) {
  color: #d73a49 !important;
}

:root[data-theme="light"] :deep(.hljs-string),
:root[data-theme="light"] :deep(.hljs-attr),
:root[data-theme="light"] :deep(.hljs-template-tag),
:root[data-theme="light"] :deep(.hljs-template-variable) {
  color: #032f62 !important;
}

:root[data-theme="light"] :deep(.hljs-number),
:root[data-theme="light"] :deep(.hljs-variable),
:root[data-theme="light"] :deep(.hljs-meta) {
  color: #005cc5 !important;
}

:root[data-theme="light"] :deep(.hljs-title),
:root[data-theme="light"] :deep(.hljs-function .hljs-title),
:root[data-theme="light"] :deep(.hljs-section),
:root[data-theme="light"] :deep(.hljs-name) {
  color: #6f42c1 !important;
}

:root[data-theme="light"] :deep(.hljs-tag),
:root[data-theme="light"] :deep(.hljs-attribute) {
  color: #22863a !important;
}

:deep(.EasyMDEContainer .editor-preview blockquote),
:deep(.EasyMDEContainer .editor-preview-side blockquote) {
  border-left: 4px solid var(--border-color) !important;
  color: var(--secondary-text) !important;
}

:deep(.EasyMDEContainer .editor-preview table),
:deep(.EasyMDEContainer .editor-preview-side table) {
  border-color: var(--border-color) !important;
}

:deep(.EasyMDEContainer .editor-preview th),
:deep(.EasyMDEContainer .editor-preview-side th),
:deep(.EasyMDEContainer .editor-preview td),
:deep(.EasyMDEContainer .editor-preview-side td) {
  border-color: var(--border-color) !important;
  color: var(--primary-text) !important;
}

:deep(.EasyMDEContainer .editor-preview th),
:deep(.EasyMDEContainer .editor-preview-side th) {
  background: color-mix(in srgb, var(--primary-text) 6%, transparent) !important;
}

:deep(.EasyMDEContainer .editor-preview hr),
:deep(.EasyMDEContainer .editor-preview-side hr) {
  border-top-color: var(--border-color) !important;
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

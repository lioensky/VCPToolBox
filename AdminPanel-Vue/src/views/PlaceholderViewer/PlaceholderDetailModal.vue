<template>
  <div
    v-if="selectedPlaceholder"
    class="placeholder-detail-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="placeholder-detail-title"
  >
    <div class="placeholder-detail-modal-backdrop" @click="emit('close')"></div>
    <div
      class="placeholder-detail-modal-content"
      ref="modalContentRef"
      tabindex="-1"
      @keydown.escape="emit('close')"
    >
      <div class="placeholder-detail-modal-header">
        <h3 id="placeholder-detail-title">
          <span class="placeholder-name-large">{{
            selectedPlaceholder.name
          }}</span>
          <span class="placeholder-detail-type">{{
            getTypeLabel(selectedPlaceholder.type)
          }}</span>
        </h3>
        <button
          type="button"
          class="placeholder-detail-modal-close"
          @click="emit('close')"
          aria-label="关闭弹窗"
        >
          &times;
        </button>
      </div>
      <div class="placeholder-detail-tabs" role="tablist">
        <button
          type="button"
          :class="['placeholder-detail-tab', { active: activeTab === 'raw' }]"
          @click="emit('update:activeTab', 'raw')"
        >
          原始文本
        </button>
        <button
          type="button"
          :class="[
            'placeholder-detail-tab',
            { active: activeTab === 'markdown' },
          ]"
          @click="emit('update:activeTab', 'markdown')"
        >
          Markdown 渲染
        </button>
        <button
          type="button"
          :class="['placeholder-detail-tab', { active: activeTab === 'json' }]"
          @click="emit('update:activeTab', 'json')"
        >
          JSON 格式化
        </button>
      </div>
      <div id="placeholder-detail-body" class="placeholder-detail-modal-body">
        <div v-if="activeTab === 'raw'" class="placeholder-detail-panel active">
          <pre>{{ detailContent }}</pre>
        </div>
        <div
          v-if="activeTab === 'markdown'"
          class="placeholder-detail-panel"
          v-html="renderedMarkdown"
        ></div>
        <div v-if="activeTab === 'json'" class="placeholder-detail-panel">
          <pre>{{ JSON.stringify(selectedPlaceholder, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type {
  Placeholder,
  PlaceholderDetailTab,
} from "@/features/placeholder-viewer/types";

const props = defineProps<{
  selectedPlaceholder: Placeholder | null;
  activeTab: PlaceholderDetailTab;
  detailContent: string;
  renderedMarkdown: string;
  getTypeLabel: (type: string) => string;
}>();

const emit = defineEmits<{
  close: [];
  "update:activeTab": [tab: PlaceholderDetailTab];
}>();

const modalContentRef = ref<HTMLElement | null>(null);

watch(
  () => props.selectedPlaceholder,
  async (placeholder) => {
    if (!placeholder) {
      return;
    }
    await nextTick();
    modalContentRef.value?.focus();
  }
);
</script>

<style scoped>
.placeholder-detail-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-detail-modal-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--overlay-backdrop);
}

.placeholder-detail-modal-content {
  position: relative;
  background: var(--secondary-bg);
  border-radius: var(--radius-md);
  width: 90%;
  max-width: 800px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.placeholder-detail-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.placeholder-detail-modal-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  font-size: var(--font-size-title);
}

.placeholder-name-large {
  font-family: "Consolas", "Monaco", monospace;
  word-break: break-all;
}

.placeholder-detail-type {
  font-size: var(--font-size-helper);
  padding: 2px 8px;
  background: var(--tertiary-bg);
  border-radius: 4px;
  color: var(--secondary-text);
  white-space: nowrap;
  flex-shrink: 0;
}

.placeholder-detail-modal-close {
  display: grid;
  place-items: center;
  min-width: 36px;
  min-height: 36px;
  background: var(--surface-overlay-soft);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: var(--font-size-display);
  color: var(--secondary-text);
  cursor: pointer;
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.placeholder-detail-modal-close:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--button-bg) 35%, var(--border-color));
  background: var(--accent-bg);
}

.placeholder-detail-modal-close:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 46%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.placeholder-detail-tabs {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--tertiary-bg);
}

.placeholder-detail-tab {
  padding: 8px 16px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  cursor: pointer;
  font-size: var(--font-size-body);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.placeholder-detail-tab:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.placeholder-detail-tab.active {
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-color: var(--button-bg);
}

.placeholder-detail-tab:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.placeholder-detail-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.placeholder-detail-panel {
  display: none;
}

.placeholder-detail-panel.active {
  display: block;
}

.placeholder-detail-panel pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.6;
  padding: 16px;
  background: var(--input-bg);
  border-radius: var(--radius-sm);
  overflow-x: auto;
}

@media (max-width: 768px) {
  .placeholder-detail-modal-content {
    width: calc(100% - 16px);
    max-height: 92vh;
    border-radius: var(--radius-sm);
  }

  .placeholder-detail-modal-header {
    padding: 12px 14px;
    align-items: flex-start;
    gap: 8px;
  }

  .placeholder-detail-modal-header h3 {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    font-size: var(--font-size-emphasis);
  }

  .placeholder-name-large {
    max-width: 100%;
    word-break: break-all;
  }

  .placeholder-detail-modal-close {
    min-width: 36px;
    min-height: 36px;
    font-size: var(--font-size-title);
  }

  .placeholder-detail-tabs {
    padding: 10px 12px;
    overflow-x: auto;
    gap: 6px;
  }

  .placeholder-detail-tab {
    flex: 0 0 auto;
    padding: 7px 12px;
    font-size: var(--font-size-helper);
    white-space: nowrap;
  }

  .placeholder-detail-modal-body {
    padding: 12px;
  }

  .placeholder-detail-panel pre {
    padding: 12px;
    font-size: var(--font-size-helper);
  }
}
</style>

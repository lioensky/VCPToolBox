<template>
  <BaseModal
    :model-value="Boolean(selectedPlaceholder)"
    :lock-scroll="true"
    aria-labelledby="placeholder-detail-title"
    @update:modelValue="handleModalVisibility"
  >
    <template #default="{ overlayAttrs, panelAttrs, panelRef }">
      <div v-bind="overlayAttrs" class="placeholder-detail-modal">
        <div :ref="panelRef" v-bind="panelAttrs" class="placeholder-detail-modal-content">
          <div class="placeholder-detail-modal-header">
            <h3 id="placeholder-detail-title">
              <span class="placeholder-name-large">{{
                selectedPlaceholder?.name
              }}</span>
              <span class="placeholder-detail-type">{{ placeholderTypeLabel }}</span>
            </h3>
            <div class="placeholder-detail-header-actions">
              <UiButton type="button" variant="outline" size="sm" @click="emit('copyDetail')">
                复制内容
              </UiButton>
              <UiButton type="button" variant="outline" size="sm" @click="emit('copyJson')">
                复制 JSON
              </UiButton>
              <UiIconButton
                type="button"
                label="关闭弹窗"
                @click="emit('close')"
              >
                <span class="material-symbols-outlined">close</span>
              </UiIconButton>
            </div>
          </div>
          <div class="placeholder-detail-tabs" role="tablist" aria-label="详情展示模式">
            <UiButton
              type="button"
              role="tab"
              :id="getTabId('raw')"
              :aria-selected="activeTab === 'raw'"
              :aria-controls="getPanelId('raw')"
              :tabindex="activeTab === 'raw' ? 0 : -1"
              size="sm"
              :variant="activeTab === 'raw' ? 'primary' : 'outline'"
              @click="emit('update:activeTab', 'raw')"
            >
              原始文本
            </UiButton>
            <UiButton
              type="button"
              role="tab"
              :id="getTabId('markdown')"
              :aria-selected="activeTab === 'markdown'"
              :aria-controls="getPanelId('markdown')"
              :tabindex="activeTab === 'markdown' ? 0 : -1"
              size="sm"
              :variant="activeTab === 'markdown' ? 'primary' : 'outline'"
              @click="emit('update:activeTab', 'markdown')"
            >
              Markdown 渲染
            </UiButton>
            <UiButton
              type="button"
              role="tab"
              :id="getTabId('json')"
              :aria-selected="activeTab === 'json'"
              :aria-controls="getPanelId('json')"
              :tabindex="activeTab === 'json' ? 0 : -1"
              size="sm"
              :variant="activeTab === 'json' ? 'primary' : 'outline'"
              @click="emit('update:activeTab', 'json')"
            >
              JSON 格式化
            </UiButton>
          </div>
          <div id="placeholder-detail-body" class="placeholder-detail-modal-body">
            <div
              v-show="activeTab === 'raw'"
              :id="getPanelId('raw')"
              class="placeholder-detail-panel"
              role="tabpanel"
              :aria-labelledby="getTabId('raw')"
            >
              <pre>{{ detailContent }}</pre>
            </div>
            <div
              v-show="activeTab === 'markdown'"
              :id="getPanelId('markdown')"
              class="placeholder-detail-panel"
              role="tabpanel"
              :aria-labelledby="getTabId('markdown')"
              v-html="renderedMarkdown"
            ></div>
            <div
              v-show="activeTab === 'json'"
              :id="getPanelId('json')"
              class="placeholder-detail-panel"
              role="tabpanel"
              :aria-labelledby="getTabId('json')"
            >
              <pre>{{ jsonContent }}</pre>
            </div>
          </div>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  Placeholder,
  PlaceholderDetailTab,
} from "@/features/placeholder-viewer/types";
import { getPlaceholderTypeLabel } from "@/features/placeholder-viewer/placeholderTypeLabel";
import BaseModal from "@/components/ui/BaseModal.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";

const props = defineProps<{
  selectedPlaceholder: Placeholder | null;
  activeTab: PlaceholderDetailTab;
  detailContent: string;
  renderedMarkdown: string;
  jsonContent: string;
}>();

const emit = defineEmits<{
  close: [];
  "update:activeTab": [tab: PlaceholderDetailTab];
  copyDetail: [];
  copyJson: [];
}>();

const placeholderTypeLabel = computed(() =>
  getPlaceholderTypeLabel(props.selectedPlaceholder?.type ?? "")
);

function getTabId(tab: PlaceholderDetailTab): string {
  return `placeholder-detail-tab-${tab}`;
}

function getPanelId(tab: PlaceholderDetailTab): string {
  return `placeholder-detail-panel-${tab}`;
}

function handleModalVisibility(visible: boolean): void {
  if (!visible) {
    emit("close");
  }
}
</script>

<style scoped>
.placeholder-detail-modal {
  z-index: var(--z-index-modal);
}

.placeholder-detail-modal-content {
  background: color-mix(in srgb, var(--primary-bg) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 96%, transparent);
  border-radius: var(--radius-lg);
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
  gap: var(--space-3);
  padding: 14px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.placeholder-detail-modal-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.35;
}

.placeholder-detail-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.placeholder-name-large {
  font-family: "Consolas", "Monaco", monospace;
  word-break: break-all;
}

.placeholder-detail-type {
  font-size: var(--font-size-helper);
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border-radius: var(--radius-full);
  color: var(--secondary-text);
  white-space: nowrap;
  flex-shrink: 0;
}

.placeholder-detail-tabs {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.placeholder-detail-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.placeholder-detail-panel pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.6;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  border-radius: var(--radius-md);
  overflow-x: auto;
}

@media (max-width: 768px) {
  .placeholder-detail-modal-content {
    width: calc(100% - 16px);
    max-height: 92vh;
    border-radius: var(--radius-sm);
  }

  .placeholder-detail-modal-header {
    padding: var(--space-3);
    align-items: flex-start;
    gap: var(--space-2);
  }

  .placeholder-detail-modal-header h3 {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    min-width: 0;
    font-size: var(--font-size-emphasis);
  }

  .placeholder-detail-header-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .placeholder-name-large {
    max-width: 100%;
    word-break: break-all;
  }

  .placeholder-detail-tabs {
    padding: var(--space-2) var(--space-3);
    overflow-x: auto;
    gap: var(--space-2);
  }

  .placeholder-detail-tabs :deep(.ui-button) {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .placeholder-detail-modal-body {
    padding: var(--space-3);
  }

  .placeholder-detail-panel pre {
    padding: var(--space-3);
    font-size: var(--font-size-helper);
  }
}
</style>

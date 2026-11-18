<template>
  <UiCard class="placeholder-item" variant="flat" size="sm">
    <div class="placeholder-header">
      <div class="placeholder-title-group">
        <span class="placeholder-name" :title="placeholder.name">{{
          placeholder.name
        }}</span>
        <span class="placeholder-charcount">
          {{ placeholder.charCount ? `${placeholder.charCount} 字符` : "未知长度" }}
        </span>
      </div>
      <UiBadge
        v-if="showTypeBadge"
        variant="outline"
        :title="placeholder.type"
      >
        {{ resolvedTypeLabel }}
      </UiBadge>
    </div>

    <p class="placeholder-preview" :title="placeholder.preview">
      {{ placeholder.preview || "暂无预览内容" }}
    </p>

    <p v-if="placeholder.description" class="placeholder-description">
      {{ placeholder.description }}
    </p>

    <div class="placeholder-footer" aria-label="占位符操作">
      <div class="placeholder-actions">
        <UiButton
          type="button"
          variant="outline"
          size="sm"
          @click="emit('copyName', placeholder.name)"
        >
          复制名称
        </UiButton>
        <UiButton
          type="button"
          variant="outline"
          size="sm"
          @click="emit('viewDetail', placeholder)"
        >
          查看详情
        </UiButton>
      </div>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { Placeholder } from "@/features/placeholder-viewer/types";
import { getPlaceholderTypeLabel } from "@/features/placeholder-viewer/placeholderTypeLabel";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";

const props = withDefaults(
  defineProps<{
    placeholder: Placeholder;
    showTypeBadge?: boolean;
    typeLabel?: string;
  }>(),
  {
    showTypeBadge: false,
    typeLabel: "",
  }
);

const emit = defineEmits<{
  viewDetail: [placeholder: Placeholder];
  copyName: [name: string];
}>();

const resolvedTypeLabel = computed(() => {
  return props.typeLabel || getPlaceholderTypeLabel(props.placeholder.type);
});
</script>

<style scoped>
.placeholder-item {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.placeholder-item:hover {
  border-color: color-mix(in srgb, var(--border-color) 100%, transparent);
  background: color-mix(in srgb, var(--primary-text) 2.4%, transparent);
}

.placeholder-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-2);
}

.placeholder-title-group {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.placeholder-name {
  font-weight: 650;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.25;
  color: var(--primary-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.placeholder-preview {
  margin: 0;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  line-height: 1.5;
}

.placeholder-description {
  margin: 0;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  line-height: 1.5;
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.placeholder-footer {
  display: flex;
  justify-content: flex-end;
  align-items: flex-end;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
}

.placeholder-charcount {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  font-weight: 500;
}

.placeholder-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .placeholder-header {
    flex-direction: column;
    gap: var(--space-2);
  }

  .placeholder-name {
    white-space: normal;
  }

  .placeholder-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .placeholder-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>

<template>
  <UiCard class="placeholder-item" variant="flat">
    <div class="placeholder-header">
      <span class="placeholder-name" :title="placeholder.name">{{
        placeholder.name
      }}</span>
      <UiBadge
        v-if="showTypeBadge"
        variant="outline"
        :title="placeholder.type"
      >
        {{ resolvedTypeLabel }}
      </UiBadge>
    </div>

    <div class="placeholder-preview" :title="placeholder.preview">
      {{ placeholder.preview }}
    </div>

    <div v-if="placeholder.description" class="placeholder-description">
      {{ placeholder.description }}
    </div>

    <div class="placeholder-footer">
      <span class="placeholder-charcount">
        {{ placeholder.charCount ? `${placeholder.charCount} 字符` : "—" }}
      </span>
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
  gap: var(--space-3);
  height: 100%;
  min-height: 210px;
}

.placeholder-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}

.placeholder-name {
  font-weight: 600;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  color: var(--primary-text);
  word-break: break-all;
}

.placeholder-preview {
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
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  padding: var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border-radius: var(--radius-sm);
  line-height: 1.5;
}

.placeholder-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
}

.placeholder-charcount {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 600;
}

.placeholder-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .placeholder-footer {
    flex-direction: column;
    align-items: flex-start;
  }

  .placeholder-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>

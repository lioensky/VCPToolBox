<template>
  <UiCard :class="cardClass" :title="title" :description="description" :size="size" :variant="variant" :divided="divided">
    <template v-if="$slots.icon" #icon>
      <slot name="icon" />
    </template>
    <template v-if="$slots.title" #title>
      <slot name="title" />
    </template>
    <template v-if="$slots.description" #description>
      <slot name="description" />
    </template>
    <template v-if="$slots.action" #action>
      <slot name="action" />
    </template>

    <slot />

    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiCard from "@/components/ui/UiCard.vue";

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    size?: "sm" | "md";
    variant?: "default" | "subtle" | "flat";
    divided?: boolean;
    tone?: "default" | "muted";
  }>(),
  {
    title: "",
    description: "",
    size: "md",
    variant: "default",
    divided: true,
    tone: "default",
  }
);

const cardClass = computed(() => ["ui-settings-card", `ui-settings-card--${props.tone}`]);
</script>

<style scoped>
.ui-settings-card {
  min-width: 0;
}

.ui-settings-card--muted {
  --surface-overlay-soft: color-mix(in srgb, var(--primary-text) 2%, transparent);
}
</style>

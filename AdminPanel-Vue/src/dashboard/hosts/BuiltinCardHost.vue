<template>
  <component v-if="resolvedComponent" :is="resolvedComponent" v-bind="resolvedProps" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { builtinComponentMap } from "@/dashboard/core/builtinComponentMap";
import type { DashboardCardContribution } from "@/dashboard/core/types";

const props = defineProps<{
  contribution: Extract<DashboardCardContribution, { renderer: { kind: "builtin" } }>;
  state: Record<string, unknown>;
}>();

const resolvedComponent = computed(
  () => builtinComponentMap[props.contribution.renderer.componentKey] ?? null
);
const resolvedProps = computed(() =>
  props.contribution.renderer.buildProps(props.state)
);
</script>

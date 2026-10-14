<template>
  <details v-if="declaration" class="jev-declaration">
    <summary>JevCall 声明 · {{ declaration.category || '未标注分类' }}</summary>
    <dl>
      <template v-for="field in fields" :key="field">
        <dt>{{ field }}</dt>
        <dd>{{ declaration[field] || '未提供' }}</dd>
      </template>
    </dl>
  </details>
</template>

<script setup lang="ts">
import type { PluginJevDeclaration } from "@/types/api.plugin";
defineProps<{ declaration?: PluginJevDeclaration }>();
const fields = ["category", "jevDescPrompt", "jevPrompt", "agentPrompt"] as const;
</script>

<style scoped>
.jev-declaration { margin: var(--space-2) 0; font-size: var(--font-size-helper); }
summary { cursor: pointer; color: var(--highlight-text); }
dl { display: grid; gap: var(--space-2); }
dt { font-weight: 600; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--secondary-text); }
</style>
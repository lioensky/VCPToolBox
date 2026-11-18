<template>
  <UiCard title="命令搜索">
    <div class="command-controls">
      <UiInput v-model="query" type="search" placeholder="搜索命令、别名、描述或提示词…" aria-label="搜索调用命令" />
      <UiButton v-for="mode in modes" :key="mode" type="button" size="sm"
        :variant="protocol === mode ? 'primary' : 'outline'" :aria-pressed="protocol === mode"
        @click="protocol = mode">{{ mode === 'vcp' ? 'VCP ToolCall' : 'JevCall' }}</UiButton>
    </div>
    <p v-if="!query.trim()">输入关键词搜索命令，可切换 VCP ToolCall / JevCall。</p>
    <p v-else>{{ results.length ? `找到 ${results.length} 条命令` : '没有匹配的命令' }} · 声明不代表已授权调用</p>
    <details v-for="row in results" :key="row.key" class="command-result">
      <summary>{{ row.plugin.manifest.displayName || row.plugin.name }} · {{ row.name }} · {{ row.plugin.isDistributed ? '分布式' : '本地' }}</summary>
      <p class="command-text">{{ row.description || '未提供描述' }}</p>
      <PluginJevDeclaration v-if="protocol === 'jev'" :declaration="row.plugin.manifest.jev" />
      <UiButton type="button" size="sm" variant="outline" @click="emit('open', row.plugin.manifest.name || row.plugin.name)">打开插件</UiButton>
    </details>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { PluginInfo } from "@/types/api.plugin";
import UiCard from "@/components/ui/UiCard.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiButton from "@/components/ui/UiButton.vue";
import PluginJevDeclaration from "./PluginJevDeclaration.vue";
const props = defineProps<{ plugins: PluginInfo[] }>();
const emit = defineEmits<{ open: [name: string] }>();
const modes = ["vcp", "jev"] as const;
const protocol = ref<"vcp" | "jev">("vcp");
const query = ref("");
const results = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return [];
  return props.plugins.flatMap(plugin => {
    const manifest = plugin.manifest;
    const jev = manifest.jev;
    const commands = protocol.value === "vcp"
      ? manifest.capabilities?.invocationCommands || []
      : jev?.commands || [];
    return commands.map((command, index) => {
      const name = command.commandIdentifier || ("command" in command ? command.command : "") || `命令 ${index + 1}`;
      const description = command.description || "";
      const aliases = "aliases" in command ? command.aliases || [] : [];
      const searchable = [manifest.name, manifest.displayName, name, description, ...aliases,
        ...(protocol.value === "jev" ? [jev?.category, jev?.jevDescPrompt, jev?.jevPrompt, jev?.agentPrompt] : [])]
        .join(" ").toLocaleLowerCase();
      return { key: `${plugin.name}:${index}`, plugin, name, description, searchable };
    }).filter(row => !needle || row.searchable.includes(needle));
  });
});
</script>

<style scoped>
.command-controls { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.command-result { padding: var(--space-2) 0; border-top: 1px solid var(--border-color); }
summary { cursor: pointer; overflow-wrap: anywhere; }
.command-text { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
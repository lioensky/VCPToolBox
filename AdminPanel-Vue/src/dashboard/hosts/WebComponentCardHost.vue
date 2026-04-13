<template>
  <div v-if="assetState.status === 'loading'" class="dashboard-card-shell dashboard-card-shell--cyan plugin-card-loading">
    <h3 class="dashboard-card-title">{{ contribution.title }}</h3>
    <div class="dashboard-card-empty">
      <p>正在加载插件卡片资源...</p>
    </div>
  </div>
  <MissingCardHost
    v-else-if="assetState.status === 'error'"
    :instance="instance"
    :title="contribution.title"
    :message="assetState.message"
  />
  <component
    :is="contribution.renderer.tagName"
    v-else
    :plugin-name="contribution.pluginName"
    :type-id="instance.typeId"
    :instance-id="instance.instanceId"
    :config="serializedConfig"
    :theme="theme"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { loadPluginAsset } from "@/dashboard/core/pluginAssetLoader";
import type { DashboardCardInstance, WebComponentDashboardCardContribution } from "@/dashboard/core/types";
import MissingCardHost from "@/dashboard/hosts/MissingCardHost.vue";

type AssetState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

const props = defineProps<{
  contribution: WebComponentDashboardCardContribution;
  instance: DashboardCardInstance;
  theme: string;
}>();

const assetState = ref<AssetState>({ status: "loading" });
const serializedConfig = computed(() => JSON.stringify(props.instance.config ?? {}));

async function ensureAssetLoaded() {
  assetState.value = { status: "loading" };

  try {
    await loadPluginAsset(props.contribution.renderer.publicPath);
    if (!customElements.get(props.contribution.renderer.tagName)) {
      await Promise.race([
        customElements.whenDefined(props.contribution.renderer.tagName),
        new Promise((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                `插件卡片未注册自定义元素：${props.contribution.renderer.tagName}`
              )
            );
          }, 10000);
        }),
      ]);
    }

    assetState.value = { status: "ready" };
  } catch (error) {
    assetState.value = {
      status: "error",
      message:
        error instanceof Error
          ? `${error.message}。来源插件不可用，可移除或等待恢复。`
          : "插件资源加载失败。来源插件不可用，可移除或等待恢复。",
    };
  }
}

onMounted(() => {
  void ensureAssetLoaded();
});

watch(
  () => props.contribution.renderer.publicPath,
  () => {
    void ensureAssetLoaded();
  }
);
</script>

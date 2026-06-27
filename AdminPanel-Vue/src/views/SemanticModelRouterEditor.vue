<template>
  <section class="config-section active-section semantic-router-page">
    <div class="page-header">
      <div>
        <h2>语义模型路由器</h2>
        <p class="description">
          可视化编辑 <code>SemanticModelRouter.json</code>：管理虚拟模型、预设、候选模型语义描述与容灾链。
        </p>
      </div>
      <div class="header-actions">
        <UiDirtyIndicator :dirty="isDirty" />
        <UiButton variant="outline" size="lg" :disabled="isLoading" @click="loadAll">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton variant="secondary" size="lg" :loading="isSaving" @click="saveConfig">
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          {{ isSaving ? "保存中…" : "保存配置" }}
        </UiButton>
      </div>
    </div>

    <UiCard v-if="isLoading">
      <UiEmptyState title="正在加载语义模型路由配置…">
        <template #icon>
          <span class="loading-spinner loading-spinner--sm"></span>
        </template>
      </UiEmptyState>
    </UiCard>

    <template v-else>
      <div class="summary-grid">
        <div class="summary-item summary-item--toggle">
          <span>总开关</span>
          <div class="summary-toggle-row">
            <strong>{{ config.enabled ? "已启用" : "已关闭" }}</strong>
            <AppSwitch v-model="config.enabled" aria-label="启用语义模型路由器" />
          </div>
        </div>
        <div class="summary-item">
          <span>自动模型</span>
          <strong>{{ config.autoModelName || "-" }}</strong>
        </div>
        <div class="summary-item">
          <span>预设数量</span>
          <strong>{{ presetEntries.length }}</strong>
        </div>
        <div class="summary-item">
          <span>上游模型</span>
          <strong>{{ upstreamModels.length }}</strong>
        </div>
      </div>

      <UiAlert v-if="upstreamWarning" variant="warning">
        <template #icon>
          <span class="material-symbols-outlined">warning</span>
        </template>
        <span>{{ upstreamWarning }}</span>
      </UiAlert>

      <div class="layout-grid">
        <UiCard class="preset-sidebar" title="预设列表" divided>
          <template #action>
            <UiButton size="sm" @click="addPreset">
              <template #leading>
                <span class="material-symbols-outlined">add</span>
              </template>
              新增
            </UiButton>
          </template>

          <div class="sidebar-field-stack">
            <UiField label="自动模型名">
              <UiInput v-model.trim="config.autoModelName" type="text" placeholder="VCPModelAuto" />
            </UiField>

            <UiField label="默认预设">
              <UiSelect v-model="config.defaultPreset">
                <option v-for="[presetId] in presetEntries" :key="presetId" :value="presetId">
                  {{ presetId }}
                </option>
              </UiSelect>
            </UiField>

            <UiSettingsGroup title="全局匹配参数" inset>
              <UiSettingsForm as="div" :columns="1" gap="sm">
                <UiField label="全局阈值">
                  <UiInput v-model.number="config.matchThreshold" type="number" min="0" max="1" step="0.01" />
                </UiField>
                <UiField label="User 权重">
                  <UiInput v-model.number="globalUserWeight" type="number" min="0" step="0.1" />
                </UiField>
                <UiField label="AI 权重">
                  <UiInput v-model.number="globalAssistantWeight" type="number" min="0" step="0.1" />
                </UiField>
              </UiSettingsForm>
            </UiSettingsGroup>
          </div>

          <UiList class="preset-list">
            <UiListItem
              v-for="[presetId, preset] in presetEntries"
              :key="presetId"
              :title="presetId"
              :description="preset.displayName || '未命名'"
              :active="selectedPresetId === presetId"
              @click="selectedPresetId = presetId"
            >
              <template #trailing>
                <UiBadge variant="outline">{{ enabledRouteCount(preset) }}/{{ preset.routes.length }}</UiBadge>
              </template>
            </UiListItem>
          </UiList>
        </UiCard>

        <main class="editor-stack">
          <UiCard v-if="hasSelectedPreset" class="editor-card" :title="`预设：${selectedPresetId}`">
            <template #action>
              <UiToolbar density="compact">
                <template #actions>
                  <UiButton variant="outline" size="sm" @click="duplicatePreset">
                    <template #leading>
                      <span class="material-symbols-outlined">content_copy</span>
                    </template>
                    复制
                  </UiButton>
                  <UiButton variant="danger" size="sm" :disabled="presetEntries.length <= 1" @click="removePreset">
                    <template #leading>
                      <span class="material-symbols-outlined">delete</span>
                    </template>
                    删除
                  </UiButton>
                </template>
              </UiToolbar>
            </template>

            <UiSettingsForm as="div">
              <UiField label="预设 ID">
                <UiInput :model-value="selectedPresetId" type="text" @change="renamePreset(($event.target as HTMLInputElement).value)" />
              </UiField>
              <UiField label="展示名">
                <UiInput v-model.trim="selectedPreset.displayName" type="text" placeholder="VCPModelAuto" />
              </UiField>
              <UiField label="默认模型">
                <UiInput v-model.trim="selectedPreset.defaultModel" type="text" list="semantic-router-models" />
              </UiField>
              <UiField label="预设阈值">
                <UiInput v-model.number="selectedPreset.matchThreshold" type="number" min="0" max="1" step="0.01" />
              </UiField>
              <UiField label="User 权重">
                <UiInput v-model.number="presetUserWeight" type="number" min="0" step="0.1" />
              </UiField>
              <UiField label="AI 权重">
                <UiInput v-model.number="presetAssistantWeight" type="number" min="0" step="0.1" />
              </UiField>

              <UiField label="容灾模型（每行一个，按顺序尝试）" data-settings-span="full">
                <UiTextarea v-model="fallbackModelsText" rows="3" placeholder="gpt-5.5&#10;DeepSeek-V4-Pro" @blur="syncFallbackModels" />
              </UiField>
            </UiSettingsForm>

            <UiSection title="语义路由项" description="描述越具体，embedding 匹配越稳定；关闭 enabled 后该项不会参与匹配。">
              <template #action>
                <UiButton size="sm" @click="addRoute">
                  <template #leading>
                    <span class="material-symbols-outlined">add</span>
                  </template>
                  新增路由
                </UiButton>
              </template>

              <UiEmptyState v-if="selectedPreset.routes.length === 0" title="还没有路由项" description="添加路由项后，语义模型路由器会根据描述匹配最合适的模型。">
                <template #action>
                  <UiButton size="sm" @click="addRoute">新增路由</UiButton>
                </template>
              </UiEmptyState>

              <div v-else class="route-list">
                <UiCard v-for="(route, routeIndex) in selectedPreset.routes" :key="routeIndex" class="route-card" size="sm" variant="subtle">
                  <div class="route-head">
                    <div class="route-status">
                      <UiBadge :variant="route.enabled ? 'success' : 'secondary'">
                        {{ route.enabled ? "启用中" : "已关闭" }}
                      </UiBadge>
                      <AppCheckbox :model-value="route.enabled !== false" label="启用" @update:model-value="route.enabled = $event" />
                      <AppCheckbox :model-value="route.failoverPool !== false" label="加入容灾池" @update:model-value="route.failoverPool = $event" />
                    </div>
                    <div class="route-actions">
                      <UiButton variant="outline" size="sm" :disabled="routeIndex === 0" @click="moveRoute(routeIndex, -1)">
                        上移
                      </UiButton>
                      <UiButton variant="outline" size="sm" :disabled="routeIndex === selectedPreset.routes.length - 1" @click="moveRoute(routeIndex, 1)">
                        下移
                      </UiButton>
                      <UiButton variant="danger" size="sm" @click="removeRoute(routeIndex)">删除</UiButton>
                    </div>
                  </div>

                  <UiSettingsForm as="div" class="route-form">
                    <UiField label="名称">
                      <UiInput v-model.trim="route.name" type="text" placeholder="research_and_coding" />
                    </UiField>
                    <UiField label="模型">
                      <UiInput v-model.trim="route.model" type="text" list="semantic-router-models" />
                    </UiField>

                    <UiField label="语义描述" data-settings-span="full">
                      <UiTextarea v-model="route.description" rows="4" placeholder="该模型擅长的场景、关键词、任务类型……" />
                    </UiField>
                  </UiSettingsForm>

                  <UiAlert v-if="route.description && route.description.trim().length < 20" variant="warning">
                    描述少于 20 字，建议补充更多任务关键词以提升匹配质量。
                  </UiAlert>
                </UiCard>
              </div>
            </UiSection>
          </UiCard>

          <UiCard class="preview-card" title="匹配预览">
            <template #action>
              <UiButton variant="outline" size="sm" :loading="isPreviewing" @click="runPreview">
                <template #leading>
                  <span class="material-symbols-outlined">play_arrow</span>
                </template>
                {{ isPreviewing ? "计算中…" : "预览匹配" }}
              </UiButton>
            </template>

            <UiSettingsForm as="div">
              <UiField label="用户示例文本">
                <UiTextarea v-model="previewUserText" rows="4" placeholder="输入一段用户请求，用于测试路由匹配" />
              </UiField>
              <UiField label="上一条 AI 文本（可选）">
                <UiTextarea v-model="previewAssistantText" rows="4" placeholder="可选：上一条 assistant 回复" />
              </UiField>
            </UiSettingsForm>

            <div v-if="previewResult" class="preview-result">
              <div class="result-line">
                <span>选中模型</span>
                <strong>{{ previewResult.selectedModel || "-" }}</strong>
              </div>
              <div class="result-line">
                <span>原因</span>
                <strong>{{ previewResult.plan.reason }}</strong>
              </div>
              <div class="candidate-chain">
                <span v-for="candidate in previewResult.candidates" :key="candidate" class="tag">{{ candidate }}</span>
              </div>
              <UiTableFrame density="compact">
                <thead>
                  <tr>
                    <th>路由</th>
                    <th>模型</th>
                    <th>相似度</th>
                    <th>容灾</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="route in previewResult.rankedRoutes" :key="`${route.name}-${route.model}`">
                    <td>{{ route.name || "-" }}</td>
                    <td>{{ route.model }}</td>
                    <td>{{ route.similarity.toFixed(4) }}</td>
                    <td>{{ route.failoverPool === false ? "否" : "是" }}</td>
                  </tr>
                </tbody>
              </UiTableFrame>
            </div>
          </UiCard>
        </main>
      </div>
    </template>

    <datalist id="semantic-router-models">
      <option v-for="model in upstreamModels" :key="model.id" :value="model.id">
        {{ model.redirected ? `${model.id} → ${model.upstreamId}` : model.id }}
      </option>
    </datalist>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import AppSwitch from "@/components/ui/AppSwitch.vue";
import UiAlert from "@/components/ui/UiAlert.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiDirtyIndicator from "@/components/ui/UiDirtyIndicator.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiList from "@/components/ui/UiList.vue";
import UiListItem from "@/components/ui/UiListItem.vue";
import UiSection from "@/components/ui/UiSection.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiSettingsGroup from "@/components/ui/UiSettingsGroup.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";
import {
  semanticRouterApi,
  type SemanticRouterConfig,
  type SemanticRouterPreset,
  type SemanticRouterPreviewResponse,
  type SemanticRouterRoute,
  type SemanticRouterUpstreamModel,
} from "@/api/semanticRouter";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const isLoading = ref(true);
const isSaving = ref(false);
const isPreviewing = ref(false);
const isDirty = ref(false);
const selectedPresetId = ref("");
const upstreamModels = ref<SemanticRouterUpstreamModel[]>([]);
const upstreamWarning = ref("");
const previewUserText = ref("");
const previewAssistantText = ref("");
const previewResult = ref<SemanticRouterPreviewResponse | null>(null);
const fallbackModelsText = ref("");

const config = ref<SemanticRouterConfig>(createDefaultConfig());

const presetEntries = computed(() => Object.entries(config.value.presets));
const selectedPreset = computed(() => config.value.presets[selectedPresetId.value]);
const hasSelectedPreset = computed(() => Boolean(selectedPreset.value));

const globalUserWeight = computed({
  get: () => config.value.contextWeights[0] ?? 0.7,
  set: (value: number) => {
    config.value.contextWeights = [Number(value) || 0, config.value.contextWeights[1] ?? 0];
  },
});

const globalAssistantWeight = computed({
  get: () => config.value.contextWeights[1] ?? 0.3,
  set: (value: number) => {
    config.value.contextWeights = [config.value.contextWeights[0] ?? 0, Number(value) || 0];
  },
});

const presetUserWeight = computed({
  get: () => selectedPreset.value?.contextWeights?.[0] ?? config.value.contextWeights[0] ?? 0.7,
  set: (value: number) => {
    ensureSelectedPresetWeights();
    selectedPreset.value.contextWeights = [Number(value) || 0, selectedPreset.value.contextWeights?.[1] ?? 0];
  },
});

const presetAssistantWeight = computed({
  get: () => selectedPreset.value?.contextWeights?.[1] ?? config.value.contextWeights[1] ?? 0.3,
  set: (value: number) => {
    ensureSelectedPresetWeights();
    selectedPreset.value.contextWeights = [selectedPreset.value.contextWeights?.[0] ?? 0, Number(value) || 0];
  },
});

watch(
  selectedPreset,
  (preset) => {
    fallbackModelsText.value = (preset?.fallbackModels ?? []).join("\n");
    previewResult.value = null;
  },
  { immediate: true }
);

watch(
  config,
  () => {
    isDirty.value = true;
  },
  { deep: true }
);

function createDefaultConfig(): SemanticRouterConfig {
  return {
    enabled: true,
    autoModelName: "VCPModelAuto",
    defaultPreset: "default",
    matchThreshold: 0.18,
    contextWeights: [0.7, 0.3],
    presets: {
      default: createPreset("VCPModelAuto"),
    },
  };
}

function createPreset(displayName = ""): SemanticRouterPreset {
  return {
    displayName,
    defaultModel: "",
    fallbackModels: [],
    matchThreshold: 0.18,
    contextWeights: [0.7, 0.3],
    routes: [createRoute()],
  };
}

function createRoute(): SemanticRouterRoute {
  return {
    name: "new_route",
    model: "",
    description: "",
    failoverPool: true,
    enabled: true,
  };
}

function cloneConfig(value: SemanticRouterConfig): SemanticRouterConfig {
  return JSON.parse(JSON.stringify(value)) as SemanticRouterConfig;
}

function normalizePreset(preset: SemanticRouterPreset): SemanticRouterPreset {
  return {
    displayName: preset.displayName ?? "",
    defaultModel: preset.defaultModel ?? "",
    fallbackModels: Array.isArray(preset.fallbackModels) ? preset.fallbackModels : [],
    matchThreshold: Number.isFinite(Number(preset.matchThreshold)) ? Number(preset.matchThreshold) : config.value.matchThreshold,
    contextWeights: Array.isArray(preset.contextWeights) && preset.contextWeights.length > 0
      ? preset.contextWeights
      : [...config.value.contextWeights],
    routes: Array.isArray(preset.routes) ? preset.routes.map(normalizeRoute) : [],
  };
}

function normalizeRoute(route: SemanticRouterRoute): SemanticRouterRoute {
  return {
    name: route.name ?? route.model ?? "unnamed",
    model: route.model ?? "",
    description: route.description ?? "",
    failoverPool: route.failoverPool !== false,
    enabled: route.enabled !== false,
  };
}

function enabledRouteCount(preset: SemanticRouterPreset): number {
  return preset.routes.filter((route) => route.enabled !== false).length;
}

function ensureSelectedPresetWeights(): void {
  if (!selectedPreset.value) return;
  if (!Array.isArray(selectedPreset.value.contextWeights)) {
    selectedPreset.value.contextWeights = [...config.value.contextWeights];
  }
}

function generateUniquePresetId(base: string): string {
  const normalizedBase = base.trim().replace(/\s+/g, "_") || "NewPreset";
  if (!config.value.presets[normalizedBase]) return normalizedBase;

  let index = 2;
  while (config.value.presets[`${normalizedBase}_${index}`]) {
    index += 1;
  }
  return `${normalizedBase}_${index}`;
}

function addPreset(): void {
  const presetId = generateUniquePresetId("NewSemanticPreset");
  config.value.presets[presetId] = createPreset(presetId);
  selectedPresetId.value = presetId;
  if (!config.value.defaultPreset) {
    config.value.defaultPreset = presetId;
  }
}

async function removePreset(): Promise<void> {
  if (!selectedPreset.value || presetEntries.value.length <= 1) return;

  const confirmed = await askConfirm({
    title: "删除语义预设",
    message: `确认删除预设 "${selectedPresetId.value}"？`,
    danger: true,
    confirmText: "删除",
  });
  if (!confirmed) return;

  delete config.value.presets[selectedPresetId.value];
  if (config.value.defaultPreset === selectedPresetId.value) {
    config.value.defaultPreset = Object.keys(config.value.presets)[0] ?? "";
  }
  selectedPresetId.value = config.value.defaultPreset || Object.keys(config.value.presets)[0] || "";
}

function duplicatePreset(): void {
  if (!selectedPreset.value) return;
  const presetId = generateUniquePresetId(`${selectedPresetId.value}_copy`);
  config.value.presets[presetId] = cloneConfig({
    ...config.value,
    presets: { temp: selectedPreset.value },
  }).presets.temp;
  selectedPresetId.value = presetId;
}

function renamePreset(nextIdRaw: string): void {
  const nextId = nextIdRaw.trim();
  const currentId = selectedPresetId.value;
  if (!nextId || nextId === currentId || !selectedPreset.value) return;

  if (config.value.presets[nextId]) {
    showMessage(`预设 ID "${nextId}" 已存在。`, "error");
    return;
  }

  const preset = selectedPreset.value;
  delete config.value.presets[currentId];
  config.value.presets[nextId] = preset;
  if (config.value.defaultPreset === currentId) {
    config.value.defaultPreset = nextId;
  }
  selectedPresetId.value = nextId;
}

function syncFallbackModels(): void {
  if (!selectedPreset.value) return;
  selectedPreset.value.fallbackModels = fallbackModelsText.value
    .split(/\r?\n/)
    .map((model) => model.trim())
    .filter(Boolean);
}

function addRoute(): void {
  if (!selectedPreset.value) return;
  selectedPreset.value.routes.push(createRoute());
}

function removeRoute(index: number): void {
  if (!selectedPreset.value) return;
  selectedPreset.value.routes.splice(index, 1);
}

function moveRoute(index: number, direction: -1 | 1): void {
  if (!selectedPreset.value) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= selectedPreset.value.routes.length) return;

  const [route] = selectedPreset.value.routes.splice(index, 1);
  selectedPreset.value.routes.splice(targetIndex, 0, route);
}

function validateConfigBeforeSave(): string | null {
  if (!config.value.autoModelName.trim()) return "自动模型名不能为空。";
  if (!config.value.defaultPreset || !config.value.presets[config.value.defaultPreset]) {
    return "默认预设必须存在。";
  }

  for (const [presetId, preset] of presetEntries.value) {
    if (!presetId.trim()) return "预设 ID 不能为空。";
    if (!preset.defaultModel.trim()) return `预设 "${presetId}" 缺少默认模型。`;
    if (!Array.isArray(preset.routes) || preset.routes.length === 0) {
      return `预设 "${presetId}" 至少需要一个路由项。`;
    }

    for (const [index, route] of preset.routes.entries()) {
      if (!route.model.trim()) return `预设 "${presetId}" 的第 ${index + 1} 个路由缺少模型。`;
      if (!route.description.trim()) return `预设 "${presetId}" 的第 ${index + 1} 个路由缺少语义描述。`;
    }
  }

  return null;
}

async function loadAll(): Promise<void> {
  isLoading.value = true;
  try {
    const [configResponse, modelsResponse] = await Promise.all([
      semanticRouterApi.getConfig(),
      semanticRouterApi.getUpstreamModels({ showLoader: false, suppressErrorMessage: true }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return {
          models: [],
          redirectEnabled: false,
          redirectRules: {},
          warning: `上游模型列表拉取失败：${message}`,
        };
      }),
    ]);

    const nextConfig = cloneConfig(configResponse.config);
    nextConfig.presets = Object.fromEntries(
      Object.entries(nextConfig.presets || {}).map(([id, preset]) => [id, normalizePreset(preset)])
    );

    config.value = nextConfig;
    upstreamModels.value = modelsResponse.models ?? [];
    upstreamWarning.value = modelsResponse.warning ?? "";
    const presetIds = Object.keys(config.value.presets);
    selectedPresetId.value = config.value.defaultPreset && config.value.presets[config.value.defaultPreset]
      ? config.value.defaultPreset
      : presetIds[0] || "";
    isDirty.value = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`加载语义模型路由配置失败：${message}`, "error");
  } finally {
    isLoading.value = false;
  }
}

async function saveConfig(): Promise<void> {
  syncFallbackModels();

  const validationError = validateConfigBeforeSave();
  if (validationError) {
    showMessage(validationError, "error");
    return;
  }

  try {
    isSaving.value = true;
    const payload = cloneConfig(config.value);
    await semanticRouterApi.saveConfig(payload, {
      loadingKey: "semantic-router.config.save",
    });
    isDirty.value = false;
    showMessage("语义模型路由配置已保存并热加载。", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`保存失败：${message}`, "error");
  } finally {
    isSaving.value = false;
  }
}

async function runPreview(): Promise<void> {
  if (!selectedPresetId.value) {
    showMessage("请先选择预设。", "error");
    return;
  }
  if (!previewUserText.value.trim() && !previewAssistantText.value.trim()) {
    showMessage("请先输入用户示例文本或上一条 AI 文本。", "error");
    return;
  }

  try {
    isPreviewing.value = true;
    previewResult.value = await semanticRouterApi.preview(
      {
        requestedModel: selectedPresetId.value === config.value.defaultPreset
          ? config.value.autoModelName
          : selectedPresetId.value,
        presetName: selectedPresetId.value,
        userText: previewUserText.value,
        assistantText: previewAssistantText.value,
      },
      {
        loadingKey: "semantic-router.preview",
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`预览失败：${message}`, "error");
  } finally {
    isPreviewing.value = false;
  }
}

onMounted(() => {
  void loadAll();
});

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true;

  return await askConfirm({
    title: "存在未保存更改",
    message: "语义模型路由配置尚未保存，确定要离开吗？",
    danger: true,
    confirmText: "放弃更改",
  });
});
</script>

<style scoped>
.semantic-router-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.page-header h2 {
  margin: 0;
}

.header-actions,
.candidate-chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.summary-item {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--card-bg, var(--secondary-bg));
  padding: var(--space-4);
}

.summary-item span {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.summary-item strong {
  display: block;
  overflow-wrap: anywhere;
  font-size: var(--font-size-emphasis);
}

.summary-item--toggle {
  display: block;
  cursor: pointer;
}

.summary-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.layout-grid {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.editor-stack,
.route-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sidebar-field-stack {
  display: grid;
  gap: var(--space-3);
}

.preset-list {
  margin-top: var(--space-4);
}

.route-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.route-status,
.route-actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.route-actions {
  margin-left: auto;
  justify-content: flex-end;
}

.preview-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.result-line {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--input-bg);
}

.tag {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-full);
  padding: 2px 8px;
  color: var(--primary-text);
  background: var(--hover-bg, var(--tertiary-bg));
  font-size: var(--font-size-helper);
}

code {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--tertiary-bg);
  color: var(--highlight-text);
}

@media (max-width: 1100px) {
  .layout-grid,
  .summary-grid {
    grid-template-columns: 1fr;
  }

  .page-header {
    flex-direction: column;
  }
}
</style>

<template>
  <section class="config-section active-section sarprompt-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          variant="outline"
          size="lg"
          type="button"
          :disabled="isLoading"
          @click="fetchSarPrompts"
        >
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton
          variant="secondary"
          size="lg"
          type="button"
          :loading="isSaving"
          @click="saveSarPrompts"
        >
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          {{ isSaving ? "保存中…" : "保存配置" }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiToolbar class="page-header" align="start">
      <div>
        <h2>SarPrompt 提示词映射</h2>
        <p class="description">
          多模型提示词管理。用于为不同模型映射特定的提示词内容，解决新模型对齐问题。
          支持 <code>SarPromptN</code> 占位符的热载入。
        </p>
      </div>
      <template #actions>
        <UiButton
          size="sm"
          type="button"
          :disabled="isLoading"
          @click="addSarGroup"
        >
          新增Sar组
        </UiButton>
      </template>
    </UiToolbar>

    <UiCard v-if="isLoading" class="sarprompt-surface" variant="subtle">
      <UiEmptyState title="正在加载..." description="正在读取 SarPrompt 配置。" />
    </UiCard>

    <UiCard v-else-if="sarPrompts.length === 0" class="sarprompt-surface" variant="subtle">
      <UiEmptyState title="暂无SarPrompt配置" description="点击新增Sar组开始维护模型提示词映射。">
        <template #action>
          <UiButton size="sm" type="button" @click="addSarGroup">新增Sar组</UiButton>
        </template>
      </UiEmptyState>
    </UiCard>

    <div v-else class="sarprompt-list">
      <UiCard
        v-for="(group, index) in sarPrompts"
        :key="index"
        class="sarprompt-card sarprompt-surface"
        size="sm"
        variant="subtle"
        divided
      >
        <template #title>
          <UiInput
            v-model="group.promptKey"
            class="rule-title"
            size="sm"
            type="text"
            placeholder="提示词键 (如 SarPrompt1)"
          />
        </template>
        <template #action>
          <UiButton
            variant="danger"
            size="sm"
            type="button"
            @click="removeSarGroup(index)"
          >
            删除
          </UiButton>
        </template>

        <UiSettingsForm as="div" :columns="1" gap="sm">
          <UiField
            label="适用模型"
            description="多个模型用英文逗号分隔。"
            size="sm"
          >
            <UiInput
              v-model="group.modelsInput"
              size="sm"
              type="text"
              placeholder="例如: gpt-4, claude-3-opus"
              @blur="syncModelsArray(index)"
            />
          </UiField>
          <UiField
            label="注入内容"
            description="可直接输入提示词，或填写 TVStxt 目录下的 .txt 文件名。"
            size="sm"
          >
            <UiTextarea
              v-model="group.content"
              size="sm"
              rows="6"
              placeholder="直接输入提示词，或输入 TVStxt 目录下的文件名"
            />
          </UiField>
        </UiSettingsForm>
      </UiCard>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { sarPromptApi, type SarPrompt } from "@/api/sarPrompt";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";

const sarPrompts = ref<(SarPrompt & { modelsInput: string })[]>([]);
const isLoading = ref(false);
const isSaving = ref(false);

const fetchSarPrompts = async () => {
  isLoading.value = true;
  try {
    const data = await sarPromptApi.getPrompts();
    sarPrompts.value = data.map((p) => ({
      ...p,
      modelsInput: p.models.join(", "),
    }));
  } catch (error) {
    console.error("Failed to fetch SarPrompts:", error);
  } finally {
    isLoading.value = false;
  }
};

const addSarGroup = () => {
  sarPrompts.value.push({
    promptKey: `SarPrompt${sarPrompts.value.length + 1}`,
    models: [],
    modelsInput: "",
    content: "",
  });
};

const removeSarGroup = (index: number) => {
  sarPrompts.value.splice(index, 1);
};

const syncModelsArray = (index: number) => {
  const group = sarPrompts.value[index];
  group.models = group.modelsInput
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
};

const saveSarPrompts = async () => {
  isSaving.value = true;
  try {
    // Sync all before saving
    sarPrompts.value.forEach((_, i) => syncModelsArray(i));

    const payload = sarPrompts.value.map(({ promptKey, models, content }) => ({
      promptKey,
      models,
      content,
    }));
    await sarPromptApi.savePrompts(payload);
  } catch (error) {
    console.error("Failed to save SarPrompts:", error);
  } finally {
    isSaving.value = false;
  }
};

onMounted(() => {
  fetchSarPrompts();
});
</script>

<style scoped>
.sarprompt-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-header {
  min-height: 36px;
}

.page-header h2 {
  margin: 0;
  line-height: 1.25;
}

.page-header .description {
  margin-top: var(--space-1);
}

.sarprompt-surface {
  --sarprompt-surface-border: color-mix(in srgb, var(--border-color) 96%, transparent);
  --sarprompt-card-surface: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.sarprompt-surface,
:deep(.ui-card.sarprompt-surface) {
  border-color: var(--sarprompt-surface-border);
  background: var(--sarprompt-card-surface);
}

.sarprompt-surface :deep(.ui-card__header),
:deep(.ui-card.sarprompt-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--sarprompt-surface-border);
}

.sarprompt-surface :deep(.ui-input),
.sarprompt-surface :deep(.ui-textarea) {
  border-color: var(--sarprompt-surface-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
}

.sarprompt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.rule-title {
  width: min(320px, 100%);
  font-weight: 600;
}

code {
  background: color-mix(in srgb, var(--primary-text) 6%, transparent);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
}

@media (max-width: 640px) {
  .page-header {
    align-items: stretch;
  }

  .page-header :deep(.ui-toolbar__actions),
  .page-header :deep(.ui-toolbar__main) {
    width: 100%;
  }

  .page-header :deep(.ui-button) {
    flex: 1;
  }
}
</style>

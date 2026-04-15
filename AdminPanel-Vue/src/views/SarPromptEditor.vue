<template>
  <section class="config-section active-section sarprompt-page">
    <div class="page-header">
      <div>
        <p class="description">
          多模型提示词管理。用于为不同模型映射特定的提示词内容，解决新模型对齐问题。
          支持 <code>SarPromptN</code> 占位符的热载入。
        </p>
      </div>
      <div class="header-actions">
        <button
          class="btn-secondary"
          type="button"
          :disabled="isLoading"
          @click="fetchSarPrompts"
        >
          刷新
        </button>
        <button
          class="btn-primary"
          type="button"
          :disabled="isLoading"
          @click="addSarGroup"
        >
          新增Sar组
        </button>
      </div>
    </div>

    <div v-if="isLoading" class="empty-tip card">
      <p>正在加载...</p>
    </div>

    <div v-else-if="sarPrompts.length === 0" class="empty-tip card">
      <p>暂无SarPrompt配置，点击“新增Sar组”开始。</p>
    </div>

    <div v-else class="sarprompt-list">
      <article
        v-for="(group, index) in sarPrompts"
        :key="index"
        class="rule-card sarprompt-card card"
      >
        <div class="rule-head">
          <input
            v-model="group.promptKey"
            class="rule-title"
            type="text"
            placeholder="提示词键 (如 SarPrompt1)"
          />
          <div class="flex-grow"></div>
          <button
            class="btn-danger btn-sm"
            type="button"
            @click="removeSarGroup(index)"
          >
            删除
          </button>
        </div>

        <div class="rule-body">
          <div class="form-group full-width">
            <label>适用模型 (逗号分隔)</label>
            <input
              v-model="group.modelsInput"
              type="text"
              placeholder="例如: gpt-4, claude-3-opus"
              @blur="syncModelsArray(index)"
            />
          </div>
          <div class="form-group full-width">
            <label>注入内容 (文本或 .txt 文件名)</label>
            <textarea
              v-model="group.content"
              rows="6"
              placeholder="直接输入提示词，或输入 TVStxt 目录下的文件名"
            ></textarea>
          </div>
        </div>
      </article>

      <div class="editor-actions">
        <button
          class="btn-success"
          type="button"
          :disabled="isSaving"
          @click="saveSarPrompts"
        >
          {{ isSaving ? "保存中…" : "保存配置" }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { sarPromptApi, type SarPrompt } from "@/api/sarPrompt";

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
  gap: 16px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.header-actions {
  display: flex;
  gap: var(--space-3);
}

.sarprompt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sarprompt-card {
  border: 1px solid var(--border-color);
  transition: border-color 0.2s ease;
}

.sarprompt-card:hover {
  border-color: var(--highlight-text);
}

.rule-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: var(--space-3);
}

.rule-title {
  font-weight: 600;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  color: var(--primary-text);
}

.flex-grow {
  flex-grow: 1;
}

.rule-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

input,
textarea {
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  color: var(--primary-text);
  border-radius: var(--radius-sm);
  padding: 10px;
}

textarea {
  resize: vertical;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.empty-tip {
  color: var(--secondary-text);
  text-align: center;
  padding: 40px;
}

code {
  background: var(--secondary-bg);
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--highlight-text);
}
</style>

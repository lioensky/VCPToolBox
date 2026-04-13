<template>
  <section class="config-section active-section">
    <p class="description">
      管理 RAGDiaryPlugin 使用的语义组。语义组会通过关键词激活，将相关向量注入查询，以提升检索准确性。
    </p>

    <div class="semantic-groups-controls">
      <button @click="saveSemanticGroups" class="btn-primary">保存所有更改</button>
      <button @click="addSemanticGroup" class="btn-secondary">添加新组</button>
      <span v-if="statusMessage" :class="['status-message', statusType]">
        {{ statusMessage }}
      </span>
    </div>

    <div id="semantic-groups-container">
      <div
        v-for="(group, index) in semanticGroups"
        :key="group.localId"
        class="semantic-group-item card"
      >
        <div class="semantic-group-header">
          <input
            v-model="group.name"
            type="text"
            placeholder="组名称"
            class="group-name-input"
          />
          <button @click="removeGroup(index)" class="btn-danger btn-sm">
            删除
          </button>
        </div>

        <div class="semantic-group-keywords">
          <label>关键词（逗号分隔）</label>
          <textarea
            v-model="group.keywords"
            placeholder="关键词 1, 关键词 2, ..."
            rows="3"
          ></textarea>
          <div class="keyword-stats">
            <span class="keyword-count">
              关键词数：{{ getKeywordCount(group.keywords) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ragApi } from "@/api";
import { showMessage } from "@/utils";

interface SemanticGroupDraft {
  localId: string;
  name: string;
  keywords: string;
}

interface SemanticGroupApiValue {
  words?: string[];
}

interface SemanticGroupsResponse {
  groups?: Record<string, SemanticGroupApiValue>;
}

const semanticGroups = ref<SemanticGroupDraft[]>([]);
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");

let nextSemanticGroupLocalId = 0;

function createSemanticGroupDraft(
  entry: Partial<Omit<SemanticGroupDraft, "localId">> = {}
): SemanticGroupDraft {
  nextSemanticGroupLocalId += 1;

  return {
    localId: `semantic-group-${nextSemanticGroupLocalId}`,
    name: entry.name ?? "",
    keywords: entry.keywords ?? "",
  };
}

function getKeywordCount(keywords: string): number {
  return keywords
    .split(",")
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0).length;
}

async function loadSemanticGroups(): Promise<void> {
  try {
    const data = (await ragApi.getSemanticGroups({
      showLoader: false,
      loadingKey: "semantic-groups.load",
    })) as SemanticGroupsResponse;

    if (data.groups && typeof data.groups === "object") {
      semanticGroups.value = Object.entries(data.groups).map(([name, group]) =>
        createSemanticGroupDraft({
          name,
          keywords: Array.isArray(group.words) ? group.words.join(",") : "",
        })
      );
      return;
    }

    semanticGroups.value = [];
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to load semantic groups:", error);
    showMessage(`加载语义组失败：${errorMessage}`, "error");
  }
}

async function saveSemanticGroups(): Promise<void> {
  try {
    const groupsObject: Record<
      string,
      { words: string[]; auto_learned: string[]; weight: number }
    > = {};

    semanticGroups.value.forEach((group) => {
      groupsObject[group.name] = {
        words: group.keywords
          .split(",")
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword.length > 0),
        auto_learned: [],
        weight: 1.0,
      };
    });

    await ragApi.saveSemanticGroups(
      { groups: groupsObject },
      {
        loadingKey: "semantic-groups.save",
      }
    );

    statusMessage.value = "语义组已保存。";
    statusType.value = "success";
    showMessage("语义组已保存。", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(`保存失败：${errorMessage}`, "error");
  }
}

function addSemanticGroup(): void {
  semanticGroups.value.push(
    createSemanticGroupDraft({
      name: "新语义组",
    })
  );
}

function removeGroup(index: number): void {
  if (confirm("确定要删除这个语义组吗？")) {
    semanticGroups.value.splice(index, 1);
  }
}

onMounted(() => {
  void loadSemanticGroups();
});
</script>

<style scoped>
.semantic-groups-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.semantic-group-item {
  margin-bottom: var(--space-4);
}

.semantic-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.group-name-input {
  flex: 1;
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.semantic-group-keywords {
  margin-bottom: var(--space-3);
}

.semantic-group-keywords label {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.semantic-group-keywords textarea {
  width: 100%;
  min-height: 80px;
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  resize: vertical;
}

.keyword-stats {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-2);
}

.keyword-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}
</style>

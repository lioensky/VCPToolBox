<template>
  <section class="config-section active-section semantic-groups-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <p class="semantic-page-summary">
          管理 RAGDiaryPlugin 语义组，通过关键词激活相关向量以提升检索准确性。
        </p>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">{{ statusMessage }}</UiBadge>
        <UiBadge v-else :variant="isDirty ? 'warning' : 'success'">
          {{ isDirty ? "未保存" : "已同步" }}
        </UiBadge>
        <UiButton type="button" variant="outline" size="lg" @click="addSemanticGroup">
          <span class="material-symbols-outlined">add</span>
          新增语义组
        </UiButton>
        <UiButton type="button" size="lg" :disabled="!isDirty" @click="saveSemanticGroups">
          <span class="material-symbols-outlined">save</span>
          保存更改
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div id="semantic-groups-container" class="semantic-groups-layout">
      <aside class="semantic-groups-sidebar" aria-label="语义组操作台">
        <span class="group-console__label">操作台</span>
        <div class="semantic-groups-sidebar-header">
          <h3>语义组</h3>
          <UiBadge variant="outline">{{ filteredGroupEntries.length }}/{{ semanticGroups.length }}</UiBadge>
        </div>

        <div class="group-search-box">
          <span class="material-symbols-outlined">search</span>
          <UiInput
            id="semantic-group-search-input"
            v-model="groupQuery"
            type="search"
            size="sm"
            placeholder="筛选名称或关键词..."
          />
          <UiIconButton
            v-if="groupQuery"
            label="清空筛选"
            title="清空筛选"
            @click="clearGroupQuery"
          >
            <span class="material-symbols-outlined">close</span>
          </UiIconButton>
        </div>

        <ul class="semantic-groups-list">
          <li
            v-for="entry in filteredGroupEntries"
            :key="entry.group.localId"
            class="group-list-item"
          >
            <button
              type="button"
              :class="['group-row', { 'is-active': entry.index === selectedGroupIndex }]"
              @click="selectGroup(entry.index)"
            >
              <span class="material-symbols-outlined">category</span>
              <span class="group-row-copy">
                <span class="group-row-name">{{ entry.group.name || `未命名组 #${entry.index + 1}` }}</span>
                <span class="group-row-meta">
                  {{ getKeywordCount(entry.group.keywords) }} 个关键词 · 权重 {{ entry.group.weight }}
                </span>
              </span>
            </button>
          </li>
          <li v-if="semanticGroups.length === 0">
            <UiEmptyState title="暂无语义组" />
          </li>
          <li v-else-if="filteredGroupEntries.length === 0">
            <UiEmptyState title="未找到匹配项" :description="`未找到匹配“${groupQuery}”的语义组`" />
          </li>
        </ul>
      </aside>

      <UiSettingsCard
        v-if="selectedGroup"
        class="semantic-group-detail"
        title="编辑语义组"
        description="维护语义组名称、权重与关键词。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="2" gap="md">
          <UiField label="组名称" for-id="semantic-group-name">
            <UiInput
              id="semantic-group-name"
              v-model="selectedGroup.name"
              type="text"
              placeholder="组名称"
              maxlength="100"
            />
          </UiField>

          <UiField label="权重" for-id="semantic-group-weight">
            <UiInput
              id="semantic-group-weight"
              v-model.number="selectedGroup.weight"
              type="number"
              min="0"
              max="10"
              step="0.1"
              class="group-weight-input"
              size="sm"
            />
          </UiField>

          <UiField
            label="关键词"
            description="用英文逗号分隔。"
            data-settings-span="full"
          >
            <UiTextarea
              v-model="selectedGroup.keywords"
              placeholder="关键词 1, 关键词 2, ..."
              rows="6"
              maxlength="5000"
            />
            <div class="keyword-stats">
              <span class="keyword-count">
                关键词数：{{ getKeywordCount(selectedGroup.keywords) }}
              </span>
            </div>
          </UiField>

          <UiField
            v-if="selectedGroup.autoLearned.length > 0"
            label="自动学习的关键词"
            description="只读，由系统学习生成。"
            data-settings-span="full"
          >
            <div class="auto-learned-tags">
              <UiBadge
                v-for="word in selectedGroup.autoLearned"
                :key="word"
                variant="secondary"
              >
                {{ word }}
              </UiBadge>
            </div>
          </UiField>
        </UiSettingsForm>

        <template #footer>
          <div class="detail-actions">
            <UiButton variant="danger" type="button" @click="removeSelectedGroup">
              删除
            </UiButton>
            <UiButton type="button" @click="saveSemanticGroups">
              保存更改
            </UiButton>
          </div>
        </template>
      </UiSettingsCard>

      <UiCard v-else class="semantic-group-detail-empty" variant="subtle">
        <UiEmptyState title="请选择语义组" description="请选择左侧语义组进行编辑，或先添加新组。" />
      </UiCard>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ragApi } from "@/api";
import type { SemanticGroupsResponse } from "@/api/rag";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSettingsCard from "@/components/ui/UiSettingsCard.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

interface SemanticGroupDraft {
  localId: string;
  name: string;
  keywords: string;
  weight: number;
  autoLearned: string[];
}

const semanticGroups = ref<SemanticGroupDraft[]>([]);
const selectedGroupIndex = ref<number | null>(null);
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");
const groupQuery = ref("");
const isDirty = ref(false);

const statusBadgeVariant = computed(() => {
  if (statusType.value === "success") return "success";
  if (statusType.value === "error") return "danger";
  return "info";
});

let nextLocalId = 0;
let suppressDirtyWatch = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function createDraft(
  entry: Partial<Omit<SemanticGroupDraft, "localId">> = {}
): SemanticGroupDraft {
  nextLocalId += 1;
  return {
    localId: `sg-${nextLocalId}`,
    name: entry.name ?? "",
    keywords: entry.keywords ?? "",
    weight: entry.weight ?? 1.0,
    autoLearned: entry.autoLearned ?? [],
  };
}

function getKeywordCount(keywords: string): number {
  return keywords
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0).length;
}

const selectedGroup = computed<SemanticGroupDraft | null>(() => {
  const index = selectedGroupIndex.value;
  if (index === null) return null;
  return semanticGroups.value[index] ?? null;
});

const filteredGroupEntries = computed(() => {
  const query = groupQuery.value.trim().toLowerCase();
  const entries = semanticGroups.value.map((group, index) => ({ group, index }));

  if (!query) {
    return entries;
  }

  return entries.filter(({ group }) => {
    const name = group.name.toLowerCase();
    const keywords = group.keywords.toLowerCase();
    return name.includes(query) || keywords.includes(query);
  });
});

function clearGroupQuery(): void {
  groupQuery.value = "";
}

function selectGroup(index: number): void {
  if (index < 0 || index >= semanticGroups.value.length) {
    selectedGroupIndex.value = null;
    return;
  }
  selectedGroupIndex.value = index;
}

function syncSelectedGroupAfterMutation(removedIndex?: number): void {
  if (semanticGroups.value.length === 0) {
    selectedGroupIndex.value = null;
    return;
  }
  if (selectedGroupIndex.value === null) {
    selectedGroupIndex.value = 0;
    return;
  }
  if (removedIndex === undefined) {
    if (selectedGroupIndex.value >= semanticGroups.value.length) {
      selectedGroupIndex.value = semanticGroups.value.length - 1;
    }
    return;
  }
  if (selectedGroupIndex.value === removedIndex) {
    selectedGroupIndex.value = Math.min(removedIndex, semanticGroups.value.length - 1);
    return;
  }
  if (selectedGroupIndex.value > removedIndex) {
    selectedGroupIndex.value -= 1;
  }
}

function setStatus(message: string, type: "info" | "success" | "error"): void {
  if (statusTimer !== undefined) {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }
  statusMessage.value = message;
  statusType.value = type;
  if (message) {
    statusTimer = setTimeout(() => {
      statusMessage.value = "";
      statusTimer = undefined;
    }, 4000);
  }
}

function generateNewGroupName(): string {
  const base = "新语义组";
  const existing = new Set(semanticGroups.value.map((g) => g.name));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/* ---- dirty tracking ---- */

watch(semanticGroups, () => {
  if (!suppressDirtyWatch) isDirty.value = true;
}, { deep: true });

function handleBeforeUnload(e: BeforeUnloadEvent): void {
  if (isDirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true;
  const confirmed = await askConfirm("有未保存的修改，确定要离开吗？");
  return confirmed;
});

/* ---- API ---- */

async function loadSemanticGroups(): Promise<void> {
  try {
    const data = (await ragApi.getSemanticGroups({
      showLoader: false,
      loadingKey: "semantic-groups.load",
    })) as SemanticGroupsResponse;

    suppressDirtyWatch = true;

    if (data.groups && typeof data.groups === "object") {
      semanticGroups.value = Object.entries(data.groups).map(([name, group]) =>
        createDraft({
          name,
          keywords: Array.isArray(group.words) ? group.words.join(",") : "",
          weight: group.weight ?? 1.0,
          autoLearned: Array.isArray(group.auto_learned) ? [...group.auto_learned] : [],
        })
      );
    } else {
      semanticGroups.value = [];
    }

    syncSelectedGroupAfterMutation();
    await nextTick();
    suppressDirtyWatch = false;
    isDirty.value = false;
  } catch (error: unknown) {
    suppressDirtyWatch = false;
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Failed to load semantic groups:", error);
    showMessage(`加载语义组失败：${msg}`, "error");
  }
}

async function saveSemanticGroups(): Promise<void> {
  try {
    const groupsObject: Record<
      string,
      { words: string[]; auto_learned: string[]; weight: number }
    > = {};
    const seenNames = new Set<string>();

    for (const group of semanticGroups.value) {
      const name = group.name.trim();

      if (!name) {
        throw new Error("语义组名称不能为空");
      }
      if (seenNames.has(name)) {
        throw new Error(`语义组名称重复：${name}`);
      }

      seenNames.add(name);
      group.name = name;

      groupsObject[name] = {
        words: group.keywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
        auto_learned: group.autoLearned,
        weight: group.weight,
      };
    }

    await ragApi.saveSemanticGroups(
      { groups: groupsObject },
      { loadingKey: "semantic-groups.save" }
    );

    isDirty.value = false;
    setStatus("语义组已保存。", "success");
    showMessage("语义组已保存。", "success");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    setStatus(`保存失败：${msg}`, "error");
    showMessage(`保存失败：${msg}`, "error");
  }
}

function addSemanticGroup(): void {
  semanticGroups.value.push(
    createDraft({ name: generateNewGroupName() })
  );
  selectedGroupIndex.value = semanticGroups.value.length - 1;
}

async function removeSelectedGroup(): Promise<void> {
  const index = selectedGroupIndex.value;
  if (index === null) return;

  if (!(await askConfirm({
    message: "确定要删除这个语义组吗？删除后将立即保存。",
    danger: true
  }))) return;

  semanticGroups.value.splice(index, 1);
  syncSelectedGroupAfterMutation(index);
  await saveSemanticGroups();
}

onMounted(() => {
  window.addEventListener("beforeunload", handleBeforeUnload);
  void loadSemanticGroups();
});

onUnmounted(() => {
  window.removeEventListener("beforeunload", handleBeforeUnload);
  if (statusTimer !== undefined) clearTimeout(statusTimer);
});
</script>

<style scoped>
.semantic-groups-page {
  --semantic-workspace-height: calc(var(--app-viewport-height, 100vh) - 150px);
  --semantic-workspace-min-height: 520px;
}

.semantic-page-summary {
  max-width: 430px;
  margin: 0 var(--space-2) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.35;
}

.semantic-groups-layout {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  gap: var(--space-4);
  min-height: var(--semantic-workspace-min-height);
  height: max(var(--semantic-workspace-height), var(--semantic-workspace-min-height));
}

.semantic-groups-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.group-console__label {
  color: color-mix(in srgb, var(--secondary-text) 72%, transparent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: 1.25;
  text-transform: uppercase;
}

.semantic-groups-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 36px;
  margin-bottom: var(--space-2);
}

.semantic-groups-sidebar-header h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 650;
  line-height: 1.25;
}

.group-search-box {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: var(--space-3);
}

.group-search-box > .material-symbols-outlined {
  position: absolute;
  left: 10px;
  color: var(--secondary-text);
  font-size: 18px !important;
  pointer-events: none;
}

.group-search-box :deep(.ui-input) {
  padding-left: 36px;
  padding-right: 34px;
}

.group-search-box :deep(.ui-icon-button) {
  position: absolute;
  right: 4px;
  width: 28px;
  height: 28px;
}

.semantic-groups-list {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--space-1) var(--space-2) 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-gutter: stable;
}

.group-list-item {
  display: flex;
  padding: 0;
}

.group-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 48px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 4%, transparent),
      color-mix(in srgb, var(--primary-text) 0.7%, transparent)
    );
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.group-row:hover {
  border-color: color-mix(in srgb, var(--button-bg) 22%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 7%, transparent),
      color-mix(in srgb, var(--primary-text) 1.6%, transparent)
    );
}

.group-row.is-active {
  border-color: color-mix(in srgb, var(--button-bg) 42%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 11%, transparent),
      color-mix(in srgb, var(--primary-text) 2%, transparent)
    );
}

.group-row.is-active::before {
  content: "";
  position: absolute;
  inset: 8px auto 8px 2px;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--button-bg);
}

.group-row:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.group-row > .material-symbols-outlined {
  flex: 0 0 auto;
  color: var(--secondary-text);
  font-size: 18px !important;
}

.group-row-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.group-row-name,
.group-row-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-row-name {
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 650;
  line-height: 1.25;
}

.group-row-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.3;
}

.semantic-group-detail,
.semantic-group-detail-empty {
  min-width: 0;
  min-height: 0;
  border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.semantic-group-detail :deep(.ui-card__header),
.semantic-group-detail-empty :deep(.ui-card__header) {
  border-bottom-color: color-mix(in srgb, var(--border-color) 68%, transparent);
}

.semantic-group-detail :deep(.ui-card__content) {
  min-height: 0;
}

.semantic-group-detail :deep(.ui-input),
.semantic-group-detail :deep(.ui-textarea) {
  border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
  background: color-mix(in srgb, var(--primary-bg) 38%, transparent);
}

.semantic-group-detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--secondary-text);
}

.group-weight-input {
  width: 120px;
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

.auto-learned-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  justify-content: flex-end;
  width: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .group-row {
    transition: none;
  }
}

@media (max-width: 1024px) {
  .semantic-groups-layout {
    grid-template-columns: 1fr;
    height: auto;
  }

  .semantic-groups-list {
    max-height: 40vh;
  }
}

@media (max-width: 768px) {
  .detail-actions {
    justify-content: space-between;
  }
}
</style>

<template>
  <section class="config-section active-section">
    <p class="description">
      管理 RAGDiaryPlugin 使用的语义组。语义组会通过关键词激活，将相关向量注入查询，以提升检索准确性。
    </p>

    <div v-if="statusMessage" class="semantic-groups-controls">
      <span :class="['status-message', statusType]">
        {{ statusMessage }}
      </span>
    </div>

    <div id="semantic-groups-container" class="semantic-groups-layout" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
      <aside
        class="semantic-groups-sidebar card"
        :class="{ 'is-collapsed': sidebarCollapsed }"
        :aria-label="sidebarCollapsed ? '语义组操作台（已折叠）' : '语义组操作台'"
      >
        <template v-if="sidebarCollapsed">
          <div class="console-rail">
            <button
              type="button"
              class="console-rail-toggle"
              aria-label="展开操作台"
              title="展开操作台"
              @click="toggleSidebar"
            >
              <span class="material-symbols-outlined">left_panel_open</span>
            </button>
            <div class="console-rail-divider"></div>
            <button
              type="button"
              class="console-rail-icon"
              aria-label="添加新组"
              title="添加新组"
              @click="addSemanticGroup"
            >
              <span class="material-symbols-outlined">add</span>
            </button>
            <button
              v-for="entry in filteredGroupEntries.slice(0, 8)"
              :key="entry.group.localId"
              type="button"
              class="console-rail-icon"
              :class="{ 'is-active': entry.index === selectedGroupIndex }"
              :title="entry.group.name || `未命名组 #${entry.index + 1}`"
              @click="selectGroup(entry.index)"
            >
              <span class="material-symbols-outlined">category</span>
            </button>
          </div>
        </template>
        <template v-else>
          <div class="group-console__section">
            <span class="group-console__label">操作台</span>
            <div class="semantic-groups-sidebar-header">
              <h3>语义组列表</h3>
              <div class="sidebar-header-meta">
                <span class="group-count">{{ filteredGroupEntries.length }}/{{ semanticGroups.length }} 组</span>
                <button
                  type="button"
                  class="console-rail-toggle"
                  aria-label="折叠操作台"
                  title="折叠操作台"
                  @click="toggleSidebar"
                >
                  <span class="material-symbols-outlined">left_panel_close</span>
                </button>
              </div>
            </div>
          </div>

          <div class="group-console__section">
            <label class="group-search-label" for="semantic-group-search-input">搜索筛选</label>
            <div class="group-search-box">
              <input
                id="semantic-group-search-input"
                v-model="groupQuery"
                type="search"
                class="group-search-input"
                placeholder="按语义组名称或关键词筛选..."
              />
              <button
                v-if="groupQuery"
                type="button"
                class="group-search-clear"
                aria-label="清空筛选"
                @click="clearGroupQuery"
              >
                清空
              </button>
            </div>
          </div>

          <div class="group-console__section group-console__section--actions">
            <button type="button" class="btn-primary btn-sm" @click="addSemanticGroup">
              <span class="material-symbols-outlined">add</span>
              添加新组
            </button>
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
                <span class="group-row-name">{{ entry.group.name || `未命名组 #${entry.index + 1}` }}</span>
                <span class="group-row-meta">{{ getKeywordCount(entry.group.keywords) }} 个关键词</span>
              </button>
            </li>
            <li v-if="semanticGroups.length === 0" class="no-groups">暂无语义组。</li>
            <li v-else-if="filteredGroupEntries.length === 0" class="no-groups">
              未找到匹配“{{ groupQuery }}”的语义组
            </li>
          </ul>
        </template>
      </aside>

      <div v-if="selectedGroup" class="semantic-group-item card semantic-group-detail">
        <div class="semantic-group-header">
          <h3>编辑语义组</h3>
        </div>

        <div class="semantic-group-field">
          <label>组名称</label>
          <input
            v-model="selectedGroup.name"
            type="text"
            placeholder="组名称"
            class="group-name-input"
            maxlength="100"
          />
        </div>

        <div class="semantic-group-field">
          <label>权重</label>
          <input
            v-model.number="selectedGroup.weight"
            type="number"
            min="0"
            max="10"
            step="0.1"
            class="group-weight-input"
          />
        </div>

        <div class="semantic-group-field">
          <label>关键词（逗号分隔）</label>
          <textarea
            v-model="selectedGroup.keywords"
            placeholder="关键词 1, 关键词 2, ..."
            rows="6"
            maxlength="5000"
          ></textarea>
          <div class="keyword-stats">
            <span class="keyword-count">
              关键词数：{{ getKeywordCount(selectedGroup.keywords) }}
            </span>
          </div>
        </div>

        <div v-if="selectedGroup.autoLearned.length > 0" class="semantic-group-field">
          <label>自动学习的关键词（只读）</label>
          <div class="auto-learned-tags">
            <span
              v-for="word in selectedGroup.autoLearned"
              :key="word"
              class="auto-learned-tag"
            >
              {{ word }}
            </span>
          </div>
        </div>

        <div class="detail-actions">
          <button class="btn-danger" type="button" @click="removeSelectedGroup">
            删除
          </button>
          <button class="btn-primary" type="button" @click="saveSemanticGroups">
            保存更改
          </button>
        </div>
      </div>

      <div v-else class="semantic-group-detail-empty card">
        <p>请选择左侧语义组进行编辑，或先添加新组。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ragApi } from "@/api";
import type { SemanticGroupsResponse } from "@/api/rag";
import { useConsoleCollapse } from "@/composables/useConsoleCollapse";
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

const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useConsoleCollapse(
  "semantic-groups"
);

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
.semantic-groups-controls {
  margin-bottom: var(--space-4);
}

.semantic-group-item {
  margin-bottom: 0;
}

.semantic-groups-layout {
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  gap: var(--space-4);
}

.semantic-groups-layout.is-sidebar-collapsed {
  grid-template-columns: 56px 1fr;
}

.semantic-groups-sidebar {
  --group-console-viewport-gap: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  position: sticky;
  top: var(--group-console-viewport-gap);
  align-self: start;
  height: calc(100vh - (var(--group-console-viewport-gap) * 2));
  max-height: calc(100vh - (var(--group-console-viewport-gap) * 2));
  overflow: hidden;
  padding: var(--space-5);
  border-radius: var(--radius-xl);
}

.semantic-groups-sidebar.is-collapsed {
  padding: var(--space-3) 0;
  gap: 0;
  align-items: center;
}

.sidebar-header-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.group-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.semantic-groups-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.semantic-groups-sidebar-header h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--primary-text);
}

.group-count {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 500;
}

.group-search-label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.group-search-box {
  display: flex;
  gap: var(--space-2);
}

.group-search-input {
  flex: 1;
  min-width: 0;
}

.group-search-clear {
  flex-shrink: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.group-search-clear:hover {
  border-color: var(--highlight-text);
  color: var(--highlight-text);
  background: var(--info-bg);
}

.group-search-clear:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.group-console__section--actions .btn-primary {
  justify-content: center;
}

.semantic-groups-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  flex: 1;
}

.group-list-item {
  display: flex;
  padding: 0;
}

.group-row {
  flex: 1;
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  justify-items: start;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
}

.group-row:hover {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.group-row.is-active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--highlight-text) 20%, transparent);
}

.group-row:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.group-row-name {
  font-weight: 600;
  color: var(--primary-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.group-row.is-active .group-row-name {
  color: var(--highlight-text);
}

.group-row-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.no-groups {
  padding: var(--space-3);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  text-align: center;
  font-size: var(--font-size-helper);
}

.semantic-group-detail,
.semantic-group-detail-empty {
  min-height: 320px;
}

.semantic-group-detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--secondary-text);
}

.semantic-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.semantic-group-header h3 {
  margin: 0;
  color: var(--primary-text);
}

.semantic-group-field {
  margin-bottom: var(--space-3);
}

.semantic-group-field label {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.group-name-input,
.group-weight-input {
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.group-name-input {
  flex: 1;
  width: 100%;
}

.group-weight-input {
  width: 120px;
}

.semantic-group-field textarea {
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

.auto-learned-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.auto-learned-tag {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  background: var(--surface-overlay-soft);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.4;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  justify-content: flex-end;
  margin-top: var(--space-4);
}

@media (max-width: 1024px) {
  .semantic-groups-layout,
  .semantic-groups-layout.is-sidebar-collapsed {
    grid-template-columns: 1fr;
  }

  .semantic-groups-sidebar {
    position: static;
    top: auto;
    height: auto;
    max-height: none;
    padding: var(--space-4);
  }
}

@media (max-width: 768px) {
  .group-search-box {
    flex-direction: column;
  }

  .semantic-groups-list {
    max-height: 40vh;
  }

  .detail-actions {
    justify-content: space-between;
  }
}
</style>

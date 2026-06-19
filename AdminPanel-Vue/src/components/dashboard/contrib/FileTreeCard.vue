<!--
  目录树仪表盘卡片

  通过手动填写占位符名称，展示对应占位符里的目录树内容。
  默认预置 VCPFilestructureInfo，可继续追加其他名称。
  支持“保留层级”开关；填写后可每 30 秒自动刷新详情。
-->

<script lang="ts">
import type { CardMeta } from "./_types";

export const cardMeta: CardMeta = {
  typeId: "contrib.file-tree",
  title: "目录树",
  description: "手动填写占位符名称，展示对应目录树内容。",
  defaultEnabled: false,
  singleton: true,
  defaultSize: { desktopCols: 12, tabletCols: 6, rows: 8 },
  minSize: { desktopCols: 12, tabletCols: 6, rows: 5 },
  maxSize: { desktopCols: 12, tabletCols: 6, rows: 40 },
};
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { cardSdk } from "./_sdk";

const logger = cardSdk.utils.createLogger("FileTreeCard");

interface TreeItem {
  id: string;
  name: string;
  rawName: string;
  content: string;
  charCount: number;
  error: string | null;
  loading: boolean;
  maxDepth: number;
  isEditingName: boolean;
  draftName: string;
}

interface SavedItem {
  name: string;
  maxDepth: number;
}

const ITEMS_KEY = "dashboard.file-tree-card.items";
const LEGACY_INPUT_KEY = "dashboard.file-tree-card.manual-input";
const LEGACY_DEPTH_KEY = "dashboard.file-tree-card.max-depth";
const DEFAULT_NAME = "VCPFilestructureInfo";
const DEFAULT_DEPTH = 0;
const MAX_DEPTH_LIMIT = 20;

const items = ref<TreeItem[]>([]);

function genId(): string {
  return `ft-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function normalizeDepth(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > MAX_DEPTH_LIMIT) return MAX_DEPTH_LIMIT;
  return Math.floor(value);
}

function makeTreeItem(
  name: string,
  maxDepth: number,
  opts: { editing?: boolean } = {}
): TreeItem {
  const cleanName = (name || "").replace(/^\{\{|\}\}$/g, "").trim();
  return {
    id: genId(),
    name: cleanName,
    rawName: cleanName ? `{{${cleanName}}}` : "",
    content: "",
    charCount: 0,
    error: null,
    loading: false,
    maxDepth: normalizeDepth(maxDepth),
    isEditingName: opts.editing ?? false,
    draftName: cleanName,
  };
}

function readSavedItems(): SavedItem[] {
  const raw = localStorage.getItem(ITEMS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (x): x is { name?: unknown; maxDepth?: unknown } =>
              x != null && typeof x === "object"
          )
          .map((x) => ({
            name: typeof x.name === "string" ? x.name : "",
            maxDepth:
              typeof x.maxDepth === "number" && Number.isFinite(x.maxDepth)
                ? x.maxDepth
                : DEFAULT_DEPTH,
          }));
      }
    } catch (err) {
      logger.warn("解析持久化数据失败:", err);
    }
  }
  // 旧版本兼容：单输入框 + 单一深度 → 多块
  const legacyInput = localStorage.getItem(LEGACY_INPUT_KEY);
  if (legacyInput != null) {
    const legacyDepthRaw = localStorage.getItem(LEGACY_DEPTH_KEY);
    const legacyDepth =
      legacyDepthRaw != null
        ? Number.parseInt(legacyDepthRaw, 10)
        : DEFAULT_DEPTH;
    const names = legacyInput
      .split(/[\n,,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => n.replace(/^\{\{|\}\}$/g, ""));
    if (names.length > 0) {
      return names.map((name) => ({
        name,
        maxDepth: Number.isFinite(legacyDepth) ? legacyDepth : DEFAULT_DEPTH,
      }));
    }
  }
  return [{ name: DEFAULT_NAME, maxDepth: DEFAULT_DEPTH }];
}

function persistItems() {
  const data: SavedItem[] = items.value
    .filter((it) => it.name)
    .map((it) => ({ name: it.name, maxDepth: it.maxDepth }));
  localStorage.setItem(ITEMS_KEY, JSON.stringify(data));
}

/**
 * 从 placeholder 详情接口返回的原始字符串中提取真正的目录树文本：
 * 1. 若是 {"status":"success","result":"..."} 这种 JSON，取 result 字段；
 * 2. 否则按纯文本处理。
 */
function extractTreeText(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown };
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.result === "string"
      ) {
        return parsed.result;
      }
    } catch {
      /* 解析失败则当成纯文本继续处理 */
    }
  }
  return raw;
}

/** 根据树形前缀计算行的层级（顶级 ├── / └── 为 1，依次类推；非树枝行返回 0） */
function lineDepth(line: string): number {
  const idx = line.indexOf("── ");
  if (idx < 0) return 0;
  return Math.floor(idx / 4) + 1;
}

/** 是否属于应剔除的深度标记行（"(Expanded to depth: N)" / "(Fully expanded)"） */
function isHeaderLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\(Expanded to depth:\s*\d+\)$/.test(t)) return true;
  if (t === "(Fully expanded)") return true;
  return false;
}

/** 把 "Directory tree for: /root/xxx" 这种前缀剥掉，只保留路径作为根节点 */
function stripDirectoryTreePrefix(line: string): string {
  const m = line.match(/^\s*Directory tree for:\s*(.*)$/);
  return m ? m[1].trimEnd() : line;
}

function formatItemContent(item: TreeItem): string {
  const text = extractTreeText(item.content);
  if (!text) return "";
  const limit = item.maxDepth;
  const lines = text.split("\n");
  const out: string[] = [];
  for (const rawLine of lines) {
    if (isHeaderLine(rawLine)) continue;
    const line = stripDirectoryTreePrefix(rawLine);
    if (limit > 0) {
      const depth = lineDepth(line);
      if (depth > 0 && depth > limit) continue;
    }
    out.push(line);
  }
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

const OFFLINE_MSG = "设备离线";

async function loadOne(item: TreeItem, silent = false): Promise<void> {
  if (!item.rawName) {
    item.content = "";
    item.charCount = 0;
    item.error = "占位符名称为空。";
    item.loading = false;
    return;
  }
  // silent 模式（轮询）下不切 loading，避免内容区闪烁到“加载中…”
  if (!silent) item.loading = true;
  try {
    const detailRes = await fetch(
      `/admin_api/placeholders/detail?type=static_plugin&name=${encodeURIComponent(
        item.rawName
      )}`
    );
    if (!detailRes.ok) {
      // 不动既有 content，只标记离线
      item.error = OFFLINE_MSG;
      return;
    }
    const detailData = (await detailRes.json()) as {
      data?: { value?: string };
    };
    const value = detailData.data?.value;
    if (value != null && value !== "") {
      const content = String(value);
      const nextChar = extractTreeText(content).length;
      // 只在内容/字符数真正变化时写回，减少不必要的重渲染
      if (item.content !== content) item.content = content;
      if (item.charCount !== nextChar) item.charCount = nextChar;
      if (item.error !== null) item.error = null;
    } else {
      // value 缺失视为离线，保留上一次内容
      item.error = OFFLINE_MSG;
    }
  } catch {
    // 网络/解析异常一律视为离线，保留上一次内容
    item.error = OFFLINE_MSG;
  } finally {
    if (!silent) item.loading = false;
  }
}

async function refreshAll() {
  const targets = items.value.filter((it) => it.name && !it.isEditingName);
  if (targets.length === 0) return;
  await Promise.all(targets.map((it) => loadOne(it, true)));
}

const polling = cardSdk.utils.usePolling(refreshAll, {
  interval: 5 * 1000,
  immediate: false,
  onError: () => {
    /* 静默：不向控制台输出轮询错误 */
  },
});

function startEdit(item: TreeItem) {
  item.draftName = item.name;
  item.isEditingName = true;
}

function cancelEdit(item: TreeItem) {
  // 取消空白新增 = 删除该块
  if (!item.name) {
    removeItem(item.id);
    return;
  }
  item.draftName = item.name;
  item.isEditingName = false;
}

function saveEdit(item: TreeItem) {
  const cleaned = (item.draftName || "").replace(/^\{\{|\}\}$/g, "").trim();
  if (!cleaned) {
    // 保存空内容：等同于删除该块
    removeItem(item.id);
    return;
  }
  const renamed = cleaned !== item.name;
  item.name = cleaned;
  item.rawName = `{{${cleaned}}}`;
  item.isEditingName = false;
  item.draftName = cleaned;
  if (renamed) {
    item.content = "";
    item.charCount = 0;
    item.error = null;
  }
  persistItems();
  void loadOne(item);
}

function addItem() {
  // 防止连点产生多个空块
  if (items.value.some((it) => !it.name && it.isEditingName)) return;
  const fresh = makeTreeItem("", DEFAULT_DEPTH, { editing: true });
  items.value.push(fresh);
}

function removeItem(id: string) {
  const idx = items.value.findIndex((it) => it.id === id);
  if (idx >= 0) {
    items.value.splice(idx, 1);
    persistItems();
  }
  if (items.value.length === 0) polling.stop();
}

function handleItemDepthChange(item: TreeItem, event: Event) {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;
  const raw = Number.parseInt(target.value, 10);
  const next = normalizeDepth(Number.isFinite(raw) ? raw : DEFAULT_DEPTH);
  item.maxDepth = next;
  target.value = String(next);
  persistItems();
}

onMounted(() => {
  const saved = readSavedItems();
  items.value = saved.map((s) => makeTreeItem(s.name, s.maxDepth));
  if (items.value.some((it) => it.name)) {
    polling.start();
    void refreshAll();
  }
});

onUnmounted(() => {
  polling.stop();
});
</script>

<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal filetree-card">
    <div class="dashboard-card-header">
      <h3 class="dashboard-card-title">
        <span class="filetree-icon">📂</span>
        目录树
      </h3>
      <div class="filetree-controls">
        <button
          class="filetree-add-btn"
          type="button"
          title="新增占位符块"
          @click="addItem"
        >
          + 新增
        </button>
      </div>
    </div>

    <div v-if="items.length === 0" class="dashboard-card-empty">
      <p class="filetree-hint">点击右上角“+ 新增”添加一个占位符块。</p>
    </div>

    <div v-else class="filetree-list">
      <div v-for="item in items" :key="item.id" class="filetree-item">
        <div class="filetree-item-header">
          <div class="filetree-item-name-area">
            <template v-if="item.isEditingName">
              <input
                v-model="item.draftName"
                class="filetree-name-input"
                type="text"
                placeholder="占位符名（可带或不带 {{}}）"
                spellcheck="false"
                autofocus
                @keydown.enter.prevent="saveEdit(item)"
                @keydown.esc.prevent="cancelEdit(item)"
              />
              <button
                class="filetree-save-btn"
                type="button"
                title="保存"
                @click="saveEdit(item)"
              >
                保存
              </button>
            </template>
            <button
              v-else
              class="filetree-name-btn"
              type="button"
              :title="item.rawName + '（点击编辑）'"
              @click="startEdit(item)"
            >
              <span class="filetree-name-text">{{
                item.name || "（未命名）"
              }}</span>
              <span v-if="item.loading" class="filetree-name-status"
                >· 刷新中…</span
              >
              <span v-else-if="item.charCount > 0" class="filetree-name-status"
                >· {{ item.charCount }} 字符</span
              >
            </button>
          </div>
          <div class="filetree-item-tools">
            <label
              class="filetree-depth-control"
              title="只展示前 N 层；0 表示不限制"
            >
              <span>层级</span>
              <input
                class="filetree-depth-input"
                type="number"
                min="0"
                :max="MAX_DEPTH_LIMIT"
                step="1"
                :value="item.maxDepth"
                @change="handleItemDepthChange(item, $event)"
              />
            </label>
            <button
              class="filetree-remove-btn"
              type="button"
              title="删除该块"
              @click="removeItem(item.id)"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="filetree-content-wrapper">
          <p v-if="item.isEditingName && !item.name" class="filetree-loading">
            填写占位符名后点击保存。
          </p>
          <p v-else-if="item.loading" class="filetree-loading">加载中…</p>
          <pre
            v-else-if="formatItemContent(item)"
            class="filetree-content"
          ><code>{{ formatItemContent(item) }}</code></pre>
          <pre
            v-else-if="item.error"
            class="filetree-content filetree-content--muted"
          ><code>{{ item.error }}</code></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../dashboard-card.css";

.filetree-card {
  /* 颜色由 .dashboard-card-shell--sky 提供，这里不再覆盖 */
}

.filetree-icon {
  font-size: 1.1em;
  margin-right: 4px;
}

.filetree-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.filetree-depth-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  user-select: none;
}

.filetree-depth-input {
  width: 56px;
  padding: 2px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
  background: var(--accent-bg);
  color: var(--primary-text);
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas",
    monospace;
  font-size: var(--font-size-caption);
  line-height: 1.4;
  text-align: center;
}

.filetree-depth-input:focus {
  outline: none;
  border-color: var(--dashboard-accent);
}

.filetree-add-btn {
  flex-shrink: 0;
  padding: 4px 12px;
  border: 1px solid var(--dashboard-accent-border);
  border-radius: var(--radius-md, 10px);
  background: oklch(1 0 0 / 0.04);
  color: var(--dashboard-accent);
  cursor: pointer;
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1.3;
  transition: background 0.2s ease, color 0.2s ease;
}

.filetree-add-btn:hover {
  background: var(--dashboard-accent);
  color: #fff;
}

.filetree-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filetree-item {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid oklch(1 0 0 / 0.08);
  border-radius: var(--radius-md, 10px);
  background: oklch(0 0 0 / 0.32);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.04), 0 1px 3px oklch(0 0 0 / 0.25);
  overflow: hidden;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.filetree-item:hover {
  border-color: var(--dashboard-accent-border);
  background: oklch(0 0 0 / 0.38);
}

.filetree-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid oklch(1 0 0 / 0.06);
  background: linear-gradient(
    180deg,
    oklch(1 0 0 / 0.04) 0%,
    oklch(1 0 0 / 0.01) 100%
  );
  flex-wrap: wrap;
}

.filetree-item-name-area {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}

.filetree-name-btn {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 8px;
  border: 1px dashed transparent;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--primary-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.filetree-name-btn:hover {
  background: oklch(1 0 0 / 0.04);
  border-color: var(--dashboard-accent-border);
}

.filetree-name-text {
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas",
    monospace;
  font-size: var(--font-size-caption);
  font-weight: 600;
  color: var(--primary-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.filetree-name-status {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  white-space: nowrap;
  flex-shrink: 0;
}

.filetree-name-input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  padding: 2px 8px;
  border: 1px solid var(--dashboard-accent);
  border-radius: var(--radius-sm, 6px);
  background: var(--accent-bg);
  color: var(--primary-text);
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas",
    monospace;
  font-size: var(--font-size-caption);
  line-height: 1.4;
}

.filetree-name-input:focus {
  outline: none;
  border-color: var(--dashboard-accent);
  box-shadow: 0 0 0 2px var(--dashboard-accent-border);
}

.filetree-save-btn {
  flex-shrink: 0;
  padding: 2px 12px;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: var(--dashboard-accent);
  color: #fff;
  cursor: pointer;
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1.3;
  transition: filter 0.2s ease;
}

.filetree-save-btn:hover {
  filter: brightness(1.1);
}

.filetree-item-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.filetree-remove-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.filetree-remove-btn:hover {
  background: oklch(0.7 0.18 30 / 0.15);
  color: oklch(0.7 0.18 30);
  border-color: oklch(0.7 0.18 30 / 0.6);
}

.filetree-content-wrapper {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px;
  background: oklch(0 0 0 / 0.18);
}

.filetree-content {
  margin: 0;
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas",
    monospace;
  font-size: var(--font-size-caption, 0.8rem);
  line-height: 1.4;
  white-space: pre;
  word-break: keep-all;
  overflow-wrap: normal;
  color: var(--primary-text);
}

.filetree-content code {
  font-family: inherit;
}

.filetree-content--muted {
  color: var(--secondary-text);
  font-style: italic;
  opacity: 0.85;
}

.filetree-loading,
.filetree-hint {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.filetree-error {
  font-size: var(--font-size-helper);
  color: var(--error-text, oklch(0.7 0.18 30));
}

@container dashboard-card (max-width: 360px) {
  .filetree-controls {
    width: 100%;
    justify-content: space-between;
  }

  .filetree-content-wrapper {
    padding: 8px 10px;
  }

  .filetree-content {
    font-size: 0.7rem;
  }

  .filetree-item-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
}
</style>

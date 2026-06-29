<template>
  <section class="claw-mail-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton type="button" variant="outline" size="lg" :disabled="isLoadingState" :loading="isLoadingState" @click="loadState(true)">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          {{ isLoadingState ? "刷新中…" : "刷新邮箱缓存" }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <section class="mail-status-strip" aria-label="Agent 信箱状态">
      <div class="status-copy">
        <strong>邮件总览与垃圾箱操作</strong>
        <span>查看 VCPClawMail 公共邮箱与子邮箱邮件，读取正文并安全移入垃圾箱。</span>
      </div>
      <div class="status-metrics">
        <article class="stat-chip">
          <span>SDK</span>
          <UiBadge :variant="state?.sdkLoaded ? 'success' : 'danger'">
            {{ state?.sdkLoaded ? "已加载" : "不可用" }}
          </UiBadge>
        </article>
        <article class="stat-chip">
          <span>邮箱</span>
          <strong>{{ state?.mailboxes.length ?? 0 }}</strong>
        </article>
        <article class="stat-chip">
          <span>更新时间</span>
          <strong>{{ state?.updatedAt || "未轮询" }}</strong>
        </article>
        <article v-if="state?.lastError" class="stat-chip stat-chip--error">
          <span>最近错误</span>
          <UiBadge variant="danger">{{ state.lastError }}</UiBadge>
        </article>
      </div>
    </section>

    <section class="mail-layout">
      <aside class="mailbox-panel" aria-label="邮箱列表">
        <div class="panel-header">
          <h3>邮箱</h3>
        </div>
        <button
          v-for="mailbox in state?.mailboxes || []"
          :key="`${mailbox.mailbox}:${mailbox.user}`"
          type="button"
          class="mailbox-item"
          :class="{ active: selectedMailboxKey === getMailboxKey(mailbox) }"
          @click="selectMailbox(mailbox)"
        >
          <span class="material-symbols-outlined">alternate_email</span>
          <span class="mailbox-copy">
            <strong>{{ mailbox.label }}</strong>
            <small>
              {{ mailbox.agentName ? `Agent：${mailbox.agentName}` : "公共邮箱" }} · 缓存 {{ mailbox.cachedCount }}
            </small>
          </span>
        </button>
        <UiEmptyState v-if="!state?.mailboxes.length" title="暂无已配置邮箱" />
      </aside>

      <main class="message-panel" aria-label="邮件列表">
        <div class="panel-header message-toolbar">
          <div>
            <h3>邮件列表</h3>
            <p>{{ selectedMailbox?.label || "请选择邮箱" }}</p>
          </div>
          <div class="toolbar-actions">
            <label class="inline-field">
              <span>数量</span>
              <UiInput v-model.number="limit" class="limit-input" type="number" min="1" max="100" size="sm" />
            </label>
            <AppCheckbox v-model="unreadOnly" label="仅未读" />
            <UiButton type="button" variant="outline" size="sm" :disabled="!selectedMailbox || isLoadingMessages" :loading="isLoadingMessages" @click="loadMessages()">
              <span class="material-symbols-outlined">refresh</span>
              <span>{{ isLoadingMessages ? "加载中…" : "加载邮件" }}</span>
            </UiButton>
          </div>
        </div>

        <div class="message-list-shell">
          <UiEmptyState v-if="isLoadingMessages" title="正在加载邮件..." />
          <UiEmptyState v-else-if="messages.length === 0" title="暂无邮件" description="请选择邮箱，或调整筛选条件后重新加载。" />
          <div v-else class="message-list">
            <article
              v-for="message in messages"
              :key="String(message.mailId || message.id)"
              class="message-item"
              :class="{ active: selectedMailId === String(message.mailId || message.id) }"
            >
              <button type="button" class="message-main" @click="openMessage(message)">
                <span class="status-dot" :class="{ unread: message.unread }"></span>
                <span class="message-content">
                  <strong>{{ message.subject || "(无主题)" }}</strong>
                  <small>{{ formatAddress(message.from) }} · {{ message.date || "未知时间" }}</small>
                  <span>{{ message.preview || "无预览" }}</span>
                </span>
              </button>
              <UiButton type="button" variant="danger" size="sm" class="trash-btn" @click="trashMessage(message)">
                <span class="material-symbols-outlined">delete</span>
                <span>移入垃圾箱</span>
              </UiButton>
            </article>
          </div>
        </div>
      </main>

      <aside class="mail-detail-panel" aria-label="邮件详情">
        <div class="panel-header">
          <div>
            <h3>邮件详情</h3>
            <p>{{ selectedMailId ? "当前邮件正文" : "选择一封邮件查看正文" }}</p>
          </div>
          <UiButton v-if="selectedMailMarkdown" type="button" variant="ghost" size="sm" @click="selectedMailMarkdown = ''">
            <span class="material-symbols-outlined">close</span>
            <span>关闭</span>
          </UiButton>
        </div>
        <pre v-if="selectedMailMarkdown">{{ selectedMailMarkdown }}</pre>
        <UiEmptyState v-else title="未选择邮件" description="从邮件列表中点击一封邮件后，正文会显示在这里。" />
      </aside>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { clawMailApi, type ClawMailMailbox, type ClawMailState, type ClawMailSummary } from "@/api";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const state = ref<ClawMailState | null>(null);
const selectedMailboxKey = ref("");
const messages = ref<ClawMailSummary[]>([]);
const selectedMailId = ref("");
const selectedMailMarkdown = ref("");
const isLoadingState = ref(false);
const isLoadingMessages = ref(false);
const limit = ref(20);
const unreadOnly = ref(false);

const selectedMailbox = computed(() =>
  (state.value?.mailboxes || []).find((mailbox) => getMailboxKey(mailbox) === selectedMailboxKey.value) || null
);

function getMailboxKey(mailbox: ClawMailMailbox): string {
  return `${mailbox.mailbox}:${mailbox.user}`;
}

function formatAddress(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value || "未知发件人");
}

async function loadState(refresh = false): Promise<void> {
  isLoadingState.value = true;
  try {
    state.value = await clawMailApi.getState(refresh, { showLoader: false });
    if (!selectedMailboxKey.value && state.value.mailboxes.length > 0) {
      selectedMailboxKey.value = getMailboxKey(state.value.mailboxes[0]);
      await loadMessages();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`加载邮箱状态失败：${message}`, "error");
  } finally {
    isLoadingState.value = false;
  }
}

function selectMailbox(mailbox: ClawMailMailbox): void {
  selectedMailboxKey.value = getMailboxKey(mailbox);
  selectedMailMarkdown.value = "";
  selectedMailId.value = "";
  void loadMessages();
}

async function loadMessages(): Promise<void> {
  if (!selectedMailbox.value) {
    return;
  }
  isLoadingMessages.value = true;
  try {
    const result = await clawMailApi.listMessages(
      {
        mailbox: selectedMailbox.value.mailbox,
        user: selectedMailbox.value.user,
        limit: limit.value,
        unreadOnly: unreadOnly.value,
      },
      { showLoader: false }
    );
    messages.value = result.emails;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`加载邮件失败：${message}`, "error");
  } finally {
    isLoadingMessages.value = false;
  }
}

async function openMessage(message: ClawMailSummary): Promise<void> {
  const mailId = String(message.mailId || message.id || "");
  if (!mailId || !selectedMailbox.value) {
    showMessage("邮件缺少 mailId，无法读取。", "warning");
    return;
  }
  selectedMailId.value = mailId;
  try {
    const result = await clawMailApi.readMessage(mailId, {
      mailbox: selectedMailbox.value.mailbox,
      user: selectedMailbox.value.user,
      markRead: false,
      includeAttachmentContent: false,
    });
    selectedMailMarkdown.value = result.markdown;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`读取邮件失败：${errorMessage}`, "error");
  }
}

async function trashMessage(message: ClawMailSummary): Promise<void> {
  const mailId = String(message.mailId || message.id || "");
  if (!mailId || !selectedMailbox.value) {
    showMessage("邮件缺少 mailId，无法移入垃圾箱。", "warning");
    return;
  }

  const confirmed = await askConfirm({
    message: `确定将邮件「${message.subject || "(无主题)"}」移入垃圾箱吗？`,
    danger: true,
    confirmText: "移入垃圾箱",
  });
  if (!confirmed) {
    return;
  }

  try {
    const result = await clawMailApi.moveToTrash(mailId, {
      mailbox: selectedMailbox.value.mailbox,
      user: selectedMailbox.value.user,
    });
    showMessage("邮件已移入垃圾箱。", "success");
    selectedMailMarkdown.value = result.markdown;
    await loadMessages();
    await loadState(false);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`移入垃圾箱失败：${errorMessage}`, "error");
  }
}

onMounted(() => {
  void loadState(false);
});
</script>

<style scoped>
.claw-mail-page {
  --mail-workspace-height: calc(var(--app-viewport-height, 100vh) - 220px);
  --mail-workspace-min-height: 520px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.mail-status-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 0 0 var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
}

.status-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.status-copy strong {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
  line-height: 1.25;
}

.status-copy span,
.panel-header p {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.status-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.stat-chip {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  min-height: 32px;
  padding: 0 var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.stat-chip span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  white-space: nowrap;
}

.stat-chip strong {
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 650;
  overflow-wrap: anywhere;
}

.stat-chip--error {
  border-color: color-mix(in srgb, var(--danger-color) 34%, var(--border-color));
}

.mail-layout {
  display: grid;
  grid-template-areas:
    "mailboxes messages"
    "mailboxes detail";
  grid-template-columns: minmax(230px, 280px) minmax(0, 1fr);
  grid-template-rows: minmax(320px, 1fr) minmax(180px, 0.72fr);
  gap: var(--space-4);
  min-height: var(--mail-workspace-min-height);
  height: max(var(--mail-workspace-height), var(--mail-workspace-min-height));
}

.mailbox-panel,
.message-panel,
.mail-detail-panel {
  min-width: 0;
  min-height: 0;
}

.mailbox-panel {
  grid-area: mailboxes;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.message-panel,
.mail-detail-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.message-panel {
  grid-area: messages;
}

.mail-detail-panel {
  grid-area: detail;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 48px;
  padding: var(--space-3);
}

.mailbox-panel > .panel-header {
  min-height: 32px;
  padding: 0 0 var(--space-2);
}

.panel-header h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 650;
  line-height: 1.25;
}

.panel-header p {
  margin: 2px 0 0;
}

.mailbox-item {
  width: 100%;
  display: flex;
  gap: var(--space-2);
  align-items: center;
  min-height: 42px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.mailbox-item:hover {
  background: var(--accent-bg);
}

.mailbox-item.active {
  border-color: color-mix(in srgb, var(--button-bg) 32%, var(--border-color));
  background: color-mix(in srgb, var(--button-bg) 7%, transparent);
}

.mailbox-item > .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 18px !important;
}

.mailbox-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.mailbox-copy strong,
.mailbox-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mailbox-copy small {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.message-toolbar {
  align-items: flex-start;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  justify-content: flex-end;
}

.inline-field,
.checkbox-field {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.limit-input {
  width: 72px;
}

.message-list-shell {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  overflow-y: auto;
  padding-right: var(--space-1);
  scrollbar-gutter: stable;
}

.message-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-3) 0;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
  border-radius: 0;
  background: transparent;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.message-item:hover {
  background: color-mix(in srgb, var(--primary-text) 1.8%, transparent);
}

.message-item.active {
  background: color-mix(in srgb, var(--button-bg) 5%, transparent);
}

.message-main {
  display: flex;
  min-width: 0;
  gap: var(--space-3);
  border: 0;
  background: transparent;
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
}

.status-dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--border-color);
  flex-shrink: 0;
}

.status-dot.unread {
  background: var(--success-color);
}

.message-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.message-content strong,
.message-content small,
.message-content span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-content small,
.message-content span,
.empty-note {
  color: var(--secondary-text);
}

.trash-btn {
  white-space: nowrap;
}

.mail-detail-panel pre {
  flex: 1;
  min-height: 0;
  margin: 0 var(--space-3) var(--space-3);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--space-3) 0 0;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  background: transparent;
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.mail-detail-panel :deep(.empty-state) {
  flex: 1;
}

@media (prefers-reduced-motion: reduce) {
  .mailbox-item,
  .message-item {
    transition: none;
  }
}

@media (max-width: 1024px) {
  .mail-status-strip {
    align-items: flex-start;
    flex-direction: column;
  }

  .status-metrics {
    justify-content: flex-start;
  }

  .mail-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
    grid-template-areas:
      "mailboxes"
      "messages"
      "detail";
    height: auto;
  }

  .toolbar-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 640px) {
  .message-item {
    grid-template-columns: 1fr;
  }

  .trash-btn {
    justify-content: center;
  }
}
</style>

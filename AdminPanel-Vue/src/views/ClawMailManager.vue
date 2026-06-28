<template>
  <section class="claw-mail-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton type="button" variant="outline" :disabled="isLoadingState" :loading="isLoadingState" @click="loadState(true)">
          <span class="material-symbols-outlined">sync</span>
          <span>{{ isLoadingState ? "刷新中…" : "刷新邮箱缓存" }}</span>
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiCard class="hero-card" variant="subtle">
      <div>
        <span class="eyebrow">VCPClawMail</span>
        <h2>邮件总览与垃圾箱操作</h2>
        <p>
          在服务器面板中查看 VCPClawMail 已配置的公共邮箱与子邮箱邮件，支持读取正文，并将邮件安全移入垃圾箱。
        </p>
      </div>
    </UiCard>

    <UiCard class="status-card" variant="subtle">
      <article class="stat-chip">
        <span>SDK</span>
        <UiBadge :variant="state?.sdkLoaded ? 'success' : 'danger'">
          {{ state?.sdkLoaded ? "已加载" : "不可用" }}
        </UiBadge>
      </article>
      <article class="stat-chip">
        <span>邮箱数</span>
        <strong>{{ state?.mailboxes.length ?? 0 }}</strong>
      </article>
      <article class="stat-chip">
        <span>更新时间</span>
        <strong>{{ state?.updatedAt || "未轮询" }}</strong>
      </article>
      <article v-if="state?.lastError" class="stat-chip warning">
        <span>最近错误</span>
        <UiBadge variant="danger">{{ state.lastError }}</UiBadge>
      </article>
    </UiCard>

    <section class="mail-layout">
      <UiCard class="mailbox-panel" variant="subtle">
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
      </UiCard>

      <UiCard class="message-panel" variant="subtle">
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
      </UiCard>
    </section>

    <UiCard v-if="selectedMailMarkdown" class="detail-card" variant="subtle">
      <div class="panel-header">
        <h3>邮件详情</h3>
        <UiButton type="button" variant="ghost" size="sm" @click="selectedMailMarkdown = ''">
          <span class="material-symbols-outlined">close</span>
          <span>关闭</span>
        </UiButton>
      </div>
      <pre>{{ selectedMailMarkdown }}</pre>
    </UiCard>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { clawMailApi, type ClawMailMailbox, type ClawMailState, type ClawMailSummary } from "@/api";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
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
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.hero-card,
.status-card,
.mail-layout {
  display: grid;
  gap: var(--space-4);
}

.hero-card {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.hero-card h2 {
  font-size: var(--font-size-headline);
  margin: var(--space-2) 0;
}

.hero-card p,
.panel-header p {
  color: var(--secondary-text);
}

.status-card {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.stat-chip {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.stat-chip span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.stat-chip strong {
  overflow-wrap: anywhere;
}

.mail-layout {
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  align-items: start;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.mailbox-item {
  width: 100%;
  display: flex;
  gap: var(--space-3);
  align-items: center;
  min-height: 44px;
  padding: var(--space-3);
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
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.mailbox-item.active {
  border-color: color-mix(in srgb, var(--button-bg) 36%, var(--border-color));
  background: color-mix(in srgb, var(--button-bg) 8%, transparent);
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
}

.message-toolbar {
  align-items: flex-start;
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  justify-content: flex-end;
}

.inline-field,
.checkbox-field {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  color: var(--secondary-text);
}

.limit-input {
  width: 72px;
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.message-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: transparent;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.message-item:hover {
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.message-item.active {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  background: color-mix(in srgb, var(--button-bg) 6%, transparent);
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
  width: 10px;
  height: 10px;
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
  gap: 4px;
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

.detail-card pre {
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  color: var(--primary-text);
}

@media (prefers-reduced-motion: reduce) {
  .mailbox-item,
  .message-item {
    transition: none;
  }
}

@media (max-width: 1024px) {
  .hero-card,
  .mail-layout {
    grid-template-columns: 1fr;
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

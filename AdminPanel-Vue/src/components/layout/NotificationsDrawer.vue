<template>
  <Teleport to="body">
    <Transition name="notifications-backdrop-fade">
      <div
        v-if="store.isDrawerOpen"
        class="notifications-backdrop"
        @click="store.closeDrawer"
      ></div>
    </Transition>

    <Transition name="notifications-drawer-slide">
      <aside
        v-if="store.isDrawerOpen"
        class="notifications-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notifications-drawer-title"
      >
        <header class="notifications-drawer__header">
          <div>
            <h2 id="notifications-drawer-title">系统通知</h2>
            <p class="notifications-drawer__subtitle">
              VCPLog 实时推送 · {{ statusLabel }}
            </p>
          </div>
          <button
            type="button"
            class="notifications-drawer__close"
            aria-label="关闭通知栏"
            title="关闭"
            @click="store.closeDrawer"
          >
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>

        <div class="notifications-drawer__toolbar">
          <span
            class="notifications-drawer__status"
            :class="`notifications-drawer__status--${store.status}`"
          >
            <span class="notifications-drawer__status-dot"></span>
            {{ store.statusMessage }}
          </span>
          <div class="notifications-drawer__actions">
            <button type="button" @click="store.markAllRead">标记已读</button>
            <button type="button" :disabled="store.items.length === 0" @click="store.clearAll">
              清空
            </button>
          </div>
        </div>

        <section class="notifications-drawer__list" aria-live="polite">
          <div v-if="store.items.length === 0" class="notifications-empty">
            <span class="material-symbols-outlined" aria-hidden="true">notifications_paused</span>
            <strong>暂无通知</strong>
            <p>当 VCP 工具、异步任务或人工审核产生消息时，会显示在这里。</p>
          </div>

          <article
            v-for="item in store.items"
            :key="item.id"
            class="notification-card"
            :class="{
              'notification-card--unread': item.receivedAt > lastViewedAtSnapshot,
              'notification-card--approval': item.toolApproval,
            }"
          >
            <div class="notification-card__head">
              <strong>{{ item.title }}</strong>
              <button
                type="button"
                class="notification-card__copy"
                title="复制原始消息"
                aria-label="复制原始消息"
                @click="copyRaw(item.raw)"
              >
                <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
              </button>
            </div>

            <pre v-if="item.preformatted" class="notification-card__content">{{ item.content }}</pre>
            <p v-else class="notification-card__content">{{ item.content }}</p>

            <div v-if="item.toolApproval" class="notification-approval">
              <textarea
                v-model="approvalReasons[item.toolApproval.requestId]"
                class="notification-approval__reason"
                rows="3"
                maxlength="1000"
                placeholder="可选：告诉 AI 为什么通过或拒绝"
              ></textarea>
              <div class="notification-approval__actions">
                <button
                  type="button"
                  class="notification-approval__btn notification-approval__btn--allow"
                  @click="finishApproval(item, true)"
                >
                  允许
                </button>
                <button
                  type="button"
                  class="notification-approval__btn notification-approval__btn--reject"
                  @click="finishApproval(item, false)"
                >
                  拒绝
                </button>
              </div>
            </div>

            <footer class="notification-card__footer">
              <span>{{ formatNotificationTime(item.receivedAt) }}</span>
              <button type="button" @click="store.removeOne(item.id)">移除</button>
            </footer>
          </article>
        </section>
      </aside>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useNotificationsStore, type NotificationItem } from "@/stores/notifications";
import { copyToClipboard, showMessage } from "@/utils";

const store = useNotificationsStore();
const approvalReasons = reactive<Record<string, string>>({});
const lastViewedAtSnapshot = ref(0);

const statusLabel = computed(() => {
  switch (store.status) {
    case "open":
      return "在线";
    case "connecting":
      return "连接中";
    case "error":
      return "错误";
    case "closed":
      return "已关闭";
    default:
      return "待连接";
  }
});

watch(
  () => store.isDrawerOpen,
  (open) => {
    if (open) {
      lastViewedAtSnapshot.value = Date.now();
      store.markAllRead();
    }
  }
);

function formatNotificationTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function copyRaw(raw: string) {
  try {
    await copyToClipboard(raw);
    showMessage("通知原始消息已复制。", "success");
  } catch {
    showMessage("复制失败，请检查浏览器剪贴板权限。", "error");
  }
}

function finishApproval(item: NotificationItem, approved: boolean) {
  const requestId = item.toolApproval?.requestId;
  if (!requestId) return;

  const sent = store.sendToolApprovalResponse(
    requestId,
    approved,
    approvalReasons[requestId] || ""
  );

  if (!sent) {
    showMessage("审核响应发送失败：通知通道未连接。", "error");
    return;
  }

  store.removeOne(item.id);
  delete approvalReasons[requestId];
  showMessage(approved ? "已允许工具调用。" : "已拒绝工具调用。", "success");
}
</script>

<style scoped>
.notifications-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: color-mix(in srgb, #000000 24%, transparent);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.notifications-drawer {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 2201;
  display: flex;
  flex-direction: column;
  width: min(420px, 100vw);
  height: var(--app-viewport-height, 100vh);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--primary-bg) 96%, transparent),
      color-mix(in srgb, var(--secondary-bg) 92%, transparent)
    );
  color: var(--primary-text);
  border-left: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  box-shadow: -18px 0 42px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.notifications-drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 18px 18px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.notifications-drawer__header h2 {
  margin: 0;
  font-size: 1.12rem;
  line-height: 1.25;
}

.notifications-drawer__subtitle {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.notifications-drawer__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--secondary-text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.notifications-drawer__close:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.notifications-drawer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 10px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 58%, transparent);
}

.notifications-drawer__status {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 7px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.notifications-drawer__status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--secondary-text);
}

.notifications-drawer__status--open .notifications-drawer__status-dot {
  background: var(--success-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--success-color) 16%, transparent);
}

.notifications-drawer__status--connecting .notifications-drawer__status-dot {
  background: #f9a825;
}

.notifications-drawer__status--error .notifications-drawer__status-dot {
  background: var(--danger-color);
}

.notifications-drawer__actions {
  display: inline-flex;
  gap: 6px;
  flex: 0 0 auto;
}

.notifications-drawer__actions button,
.notification-card__footer button {
  height: 28px;
  padding: 0 10px;
  color: var(--secondary-text);
  background: color-mix(in srgb, var(--secondary-bg) 76%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: 999px;
  cursor: pointer;
  font-size: var(--font-size-helper);
}

.notifications-drawer__actions button:hover:not(:disabled),
.notification-card__footer button:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--highlight-text) 42%, transparent);
}

.notifications-drawer__actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.notifications-drawer__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 30%, transparent) transparent;
}

.notifications-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 260px;
  padding: 28px;
  text-align: center;
  color: var(--secondary-text);
}

.notifications-empty .material-symbols-outlined {
  margin-bottom: 10px;
  font-size: 42px;
  color: color-mix(in srgb, var(--highlight-text) 70%, var(--secondary-text));
}

.notifications-empty strong {
  color: var(--primary-text);
}

.notifications-empty p {
  max-width: 260px;
  margin: 8px 0 0;
  line-height: 1.6;
  font-size: var(--font-size-helper);
}

.notification-card {
  position: relative;
  margin-bottom: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: 14px;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--secondary-bg) 84%, transparent),
      color-mix(in srgb, var(--primary-bg) 78%, transparent)
    );
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}

.notification-card--unread {
  border-color: color-mix(in srgb, var(--highlight-text) 48%, var(--border-color));
}

.notification-card--approval {
  border-color: color-mix(in srgb, #f9a825 58%, var(--border-color));
}

.notification-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.notification-card__head strong {
  color: var(--highlight-text);
  font-size: 0.93rem;
  line-height: 1.45;
  word-break: break-word;
}

.notification-card__copy {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--secondary-text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.notification-card__copy:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.notification-card__copy .material-symbols-outlined {
  font-size: 16px;
}

.notification-card__content {
  margin: 8px 0 0;
  color: var(--primary-text);
  font-size: 0.875rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

pre.notification-card__content {
  max-height: 190px;
  padding: 8px;
  overflow: auto;
  background: color-mix(in srgb, #000000 12%, transparent);
  border-radius: 8px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.8rem;
}

.notification-approval {
  margin-top: 10px;
}

.notification-approval__reason {
  width: 100%;
  min-height: 72px;
  box-sizing: border-box;
  padding: 8px 10px;
  resize: vertical;
  color: var(--primary-text);
  background: color-mix(in srgb, var(--primary-bg) 84%, transparent);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 28%, var(--border-color));
  border-radius: 10px;
  font: inherit;
  font-size: 0.84rem;
}

.notification-approval__reason:focus {
  outline: none;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--highlight-text) 18%, transparent);
}

.notification-approval__actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.notification-approval__btn {
  height: 30px;
  padding: 0 14px;
  color: #fff;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 600;
}

.notification-approval__btn--allow {
  background: var(--success-color);
}

.notification-approval__btn--reject {
  background: var(--danger-color);
}

.notification-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.notifications-backdrop-fade-enter-active,
.notifications-backdrop-fade-leave-active {
  transition: opacity var(--transition-normal);
}

.notifications-backdrop-fade-enter-from,
.notifications-backdrop-fade-leave-to {
  opacity: 0;
}

.notifications-drawer-slide-enter-active,
.notifications-drawer-slide-leave-active {
  transition:
    transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.28s ease;
}

.notifications-drawer-slide-enter-from,
.notifications-drawer-slide-leave-to {
  opacity: 0;
  transform: translateX(100%);
}

@media (max-width: 480px) {
  .notifications-drawer {
    width: 100vw;
  }

  .notifications-drawer__toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .notifications-drawer__actions {
    width: 100%;
  }

  .notifications-drawer__actions button {
    flex: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .notifications-backdrop-fade-enter-active,
  .notifications-backdrop-fade-leave-active,
  .notifications-drawer-slide-enter-active,
  .notifications-drawer-slide-leave-active {
    transition: none;
  }
}
</style>
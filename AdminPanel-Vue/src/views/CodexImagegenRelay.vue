<template>
  <section class="config-section active-section">
    <div class="relay-page">
      <header class="relay-header">
        <div>
          <h2 class="page-title">Codex ImageGen Relay</h2>
          <p class="page-subtitle">Codex 在线协作队列 · artifact_ready 为第一版验收边界</p>
        </div>
        <button class="icon-button" type="button" :disabled="isLoading" aria-label="刷新请求列表" @click="loadRequests">
          <span class="material-symbols-outlined">refresh</span>
        </button>
      </header>

      <form class="request-form" @submit.prevent="createRequest">
        <div class="field field-wide">
          <label for="relay-prompt">Prompt</label>
          <textarea
            id="relay-prompt"
            v-model="prompt"
            rows="7"
            maxlength="8000"
            placeholder="A clean product photo of a glass cube on a white background"
          ></textarea>
          <div class="field-footer">
            <span>{{ prompt.length }}/8000</span>
            <span v-if="promptError" class="field-error">{{ promptError }}</span>
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="relay-size">Size</label>
            <select id="relay-size" v-model="size">
              <option value="auto">auto</option>
              <option value="1024x1024">1024x1024</option>
              <option value="1024x1536">1024x1536</option>
              <option value="1536x1024">1536x1024</option>
            </select>
          </div>
          <div class="field">
            <label for="relay-quality">Quality</label>
            <select id="relay-quality" v-model="quality">
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </div>
          <div class="field">
            <label for="relay-format">Format</label>
            <select id="relay-format" v-model="outputFormat">
              <option value="png">png</option>
              <option value="jpg">jpg</option>
              <option value="webp">webp</option>
            </select>
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="relay-request-id">Request ID</label>
            <input id="relay-request-id" v-model="requestId" type="text" placeholder="留空自动生成" />
          </div>
          <div class="field">
            <label for="relay-idempotency">Idempotency Key</label>
            <input id="relay-idempotency" v-model="idempotencyKey" type="text" placeholder="默认同 Request ID" />
          </div>
        </div>

        <div class="form-actions">
          <button class="primary-button" type="submit" :disabled="isCreating || Boolean(promptError)">
            <span v-if="isCreating" class="loading-spinner-sm"></span>
            <span v-else class="material-symbols-outlined">add_photo_alternate</span>
            Submit
          </button>
          <button class="secondary-button" type="button" :disabled="isCreating" @click="resetForm">
            <span class="material-symbols-outlined">restart_alt</span>
            Reset
          </button>
        </div>
      </form>

      <div v-if="errorMessage" class="message message-error">
        <span class="material-symbols-outlined">error</span>
        {{ errorMessage }}
      </div>
      <div v-if="successMessage" class="message message-success">
        <span class="material-symbols-outlined">check_circle</span>
        {{ successMessage }}
      </div>

      <section class="queue-section">
        <div class="queue-toolbar">
          <div class="status-tabs" aria-label="状态筛选">
            <button
              v-for="item in statusTabs"
              :key="item.value"
              type="button"
              :class="['status-tab', { active: statusFilter === item.value }]"
              @click="setStatusFilter(item.value)"
            >
              {{ item.label }}
              <span>{{ item.count }}</span>
            </button>
          </div>
          <label class="limit-control">
            Limit
            <input v-model.number="limit" type="number" min="1" max="500" @change="loadRequests" />
          </label>
        </div>

        <div v-if="isLoading" class="empty-state">
          <span class="loading-spinner"></span>
          Loading queue
        </div>

        <div v-else-if="requests.length === 0" class="empty-state">
          <span class="material-symbols-outlined">inbox</span>
          No requests
        </div>

        <div v-else class="request-list">
          <article v-for="request in requests" :key="request.request_id" class="request-card">
            <div class="request-main">
              <div class="request-title-row">
                <span :class="['status-badge', `status-${request.status}`]">{{ statusLabel(request.status) }}</span>
                <code>{{ request.request_id }}</code>
                <span v-if="request.attempt !== undefined" class="attempt">attempt {{ request.attempt }}</span>
              </div>

              <p class="prompt-preview">{{ request.prompt || "-" }}</p>

              <div class="meta-grid">
                <div>
                  <span>created</span>
                  <strong>{{ formatDate(request.created_at) }}</strong>
                </div>
                <div>
                  <span>expires</span>
                  <strong>{{ formatDate(request.claim_expires_at) }}</strong>
                </div>
                <div>
                  <span>output</span>
                  <strong>{{ request.options?.output_format || "-" }}</strong>
                </div>
                <div>
                  <span>idempotency</span>
                  <strong>{{ request.idempotency_key || "-" }}</strong>
                </div>
              </div>

              <div v-if="request.status_mismatch" class="inline-warning">
                <span class="material-symbols-outlined">sync_problem</span>
                directory={{ request.status_mismatch.directory_status }} file={{ request.status_mismatch.file_status }}
              </div>

              <div v-if="request.error" class="inline-error">
                <span class="material-symbols-outlined">report</span>
                {{ request.error.code || "ERROR" }} · {{ request.error.message || "-" }}
              </div>

              <div v-if="request.result?.local_files?.length" class="file-list">
                <span v-for="file in request.result.local_files" :key="file">{{ file }}</span>
              </div>
            </div>

            <div class="request-actions">
              <button
                v-if="request.status === 'pending'"
                class="secondary-button compact"
                type="button"
                :disabled="isMutating(request.request_id)"
                @click="cancelRequest(request)"
              >
                <span class="material-symbols-outlined">cancel</span>
                Cancel
              </button>

              <button
                v-if="request.status === 'failed'"
                class="secondary-button compact"
                type="button"
                :disabled="isMutating(request.request_id)"
                @click="retryRequest(request)"
              >
                <span class="material-symbols-outlined">replay</span>
                Retry
              </button>

              <div v-if="request.status === 'artifact_ready'" class="inline-form">
                <input
                  v-model="savedPaths[request.request_id]"
                  type="text"
                  placeholder="state/codex-imagegen/assets/result.png"
                />
                <button
                  class="primary-button compact"
                  type="button"
                  :disabled="isMutating(request.request_id)"
                  @click="markSaved(request)"
                >
                  <span class="material-symbols-outlined">task_alt</span>
                  Mark
                </button>
              </div>

              <div v-if="request.status === 'claimed'" class="inline-form">
                <input
                  v-model="staleMessages[request.request_id]"
                  type="text"
                  placeholder="Claim lease expired"
                />
                <button
                  class="danger-button compact"
                  type="button"
                  :disabled="isMutating(request.request_id)"
                  @click="failStaleClaim(request)"
                >
                  <span class="material-symbols-outlined">timer_off</span>
                  Fail stale
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  codexImagegenRelayApi,
  type CodexImagegenRequest,
  type CodexImagegenStatus,
} from "@/api";

type StatusFilter = CodexImagegenStatus | "all";

const statuses: CodexImagegenStatus[] = [
  "pending",
  "claimed",
  "artifact_ready",
  "done",
  "failed",
  "cancelled",
];

const statusLabels: Record<StatusFilter, string> = {
  all: "All",
  pending: "Pending",
  claimed: "Claimed",
  artifact_ready: "Artifact",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const prompt = ref("");
const requestId = ref("");
const idempotencyKey = ref("");
const size = ref("auto");
const quality = ref("high");
const outputFormat = ref("png");
const statusFilter = ref<StatusFilter>("all");
const limit = ref(100);
const requests = ref<CodexImagegenRequest[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);
const mutatingIds = ref(new Set<string>());
const errorMessage = ref("");
const successMessage = ref("");
const savedPaths = ref<Record<string, string>>({});
const staleMessages = ref<Record<string, string>>({});

const promptError = computed(() => {
  const value = prompt.value.trim();
  if (value.length === 0) return "Prompt is required";
  if (value.length > 8000) return "Prompt is too long";
  return "";
});

const statusCounts = computed(() => {
  const counts: Record<StatusFilter, number> = {
    all: requests.value.length,
    pending: 0,
    claimed: 0,
    artifact_ready: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const request of requests.value) {
    counts[request.status] += 1;
  }

  return counts;
});

const statusTabs = computed(() => [
  { value: "all" as const, label: statusLabels.all, count: statusCounts.value.all },
  ...statuses.map((status) => ({
    value: status,
    label: statusLabels[status],
    count: statusCounts.value[status],
  })),
]);

function statusLabel(status: CodexImagegenStatus): string {
  return statusLabels[status];
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function clearMessages(): void {
  errorMessage.value = "";
  successMessage.value = "";
}

function setStatusFilter(status: StatusFilter): void {
  statusFilter.value = status;
  void loadRequests();
}

function isMutating(requestIdValue: string): boolean {
  return mutatingIds.value.has(requestIdValue);
}

function setMutating(requestIdValue: string, value: boolean): void {
  const next = new Set(mutatingIds.value);
  if (value) {
    next.add(requestIdValue);
  } else {
    next.delete(requestIdValue);
  }
  mutatingIds.value = next;
}

function resetForm(): void {
  prompt.value = "";
  requestId.value = "";
  idempotencyKey.value = "";
  size.value = "auto";
  quality.value = "high";
  outputFormat.value = "png";
  clearMessages();
}

function parseLocalFiles(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadRequests(): Promise<void> {
  clearMessages();
  isLoading.value = true;
  try {
    requests.value = await codexImagegenRelayApi.listRequests(
      {
        status: statusFilter.value,
        limit: limit.value,
      },
      {},
      { showLoader: false }
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    isLoading.value = false;
  }
}

async function createRequest(): Promise<void> {
  clearMessages();
  if (promptError.value) return;

  isCreating.value = true;
  try {
    const request = await codexImagegenRelayApi.createRequest(
      {
        prompt: prompt.value.trim(),
        request_id: requestId.value.trim() || undefined,
        idempotency_key: idempotencyKey.value.trim() || undefined,
        mode: "generate",
        options: {
          size: size.value,
          quality: quality.value,
          output_format: outputFormat.value,
        },
      },
      {},
      { showLoader: false }
    );
    successMessage.value = `submitted ${request.request_id}`;
    resetForm();
    await loadRequests();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    isCreating.value = false;
  }
}

async function cancelRequest(request: CodexImagegenRequest): Promise<void> {
  clearMessages();
  setMutating(request.request_id, true);
  try {
    await codexImagegenRelayApi.cancelRequest(request.request_id, "Cancelled from AdminPanel-Vue", {}, { showLoader: false });
    successMessage.value = `cancelled ${request.request_id}`;
    await loadRequests();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    setMutating(request.request_id, false);
  }
}

async function retryRequest(request: CodexImagegenRequest): Promise<void> {
  clearMessages();
  setMutating(request.request_id, true);
  try {
    const retry = await codexImagegenRelayApi.retryRequest(request.request_id, {}, { showLoader: false });
    successMessage.value = `retry submitted ${retry.request_id}`;
    await loadRequests();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    setMutating(request.request_id, false);
  }
}

async function markSaved(request: CodexImagegenRequest): Promise<void> {
  clearMessages();
  const localFiles = parseLocalFiles(savedPaths.value[request.request_id] || "");
  if (localFiles.length === 0) {
    errorMessage.value = "local file path is required";
    return;
  }

  setMutating(request.request_id, true);
  try {
    await codexImagegenRelayApi.markSaved(request.request_id, localFiles, {}, { showLoader: false });
    savedPaths.value = { ...savedPaths.value, [request.request_id]: "" };
    successMessage.value = `saved ${request.request_id}`;
    await loadRequests();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    setMutating(request.request_id, false);
  }
}

async function failStaleClaim(request: CodexImagegenRequest): Promise<void> {
  clearMessages();
  setMutating(request.request_id, true);
  try {
    await codexImagegenRelayApi.failStaleClaim(
      request.request_id,
      staleMessages.value[request.request_id] || "Claim lease expired",
      {},
      { showLoader: false }
    );
    successMessage.value = `failed stale claim ${request.request_id}`;
    await loadRequests();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    setMutating(request.request_id, false);
  }
}

onMounted(() => {
  void loadRequests();
});
</script>

<style scoped>
.relay-page {
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.relay-header,
.queue-toolbar,
.form-actions,
.request-title-row,
.request-actions,
.inline-form,
.message,
.inline-warning,
.inline-error,
.file-list {
  display: flex;
  align-items: center;
}

.relay-header {
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.page-title {
  margin: 0;
  font-size: var(--font-size-headline);
  font-weight: 650;
  color: var(--primary-text);
}

.page-subtitle {
  margin: var(--space-1) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

.request-form,
.queue-section {
  padding: var(--space-5) 0;
  border-top: 1px solid var(--border-color);
}

.field,
.field-wide {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-wide {
  margin-bottom: var(--space-4);
}

.field label,
.limit-control {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.field input,
.field select,
.field textarea,
.inline-form input,
.limit-control input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
  font: inherit;
}

.field input,
.field select,
.inline-form input,
.limit-control input {
  padding: 0 12px;
}

.field textarea {
  padding: 12px;
  resize: vertical;
  line-height: 1.55;
}

.field input:focus,
.field select:focus,
.field textarea:focus,
.inline-form input:focus,
.limit-control input:focus {
  outline: none;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.field-footer {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.field-error,
.inline-error {
  color: var(--danger-text);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.form-actions {
  gap: var(--space-3);
}

.primary-button,
.secondary-button,
.danger-button,
.icon-button,
.status-tab {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
}

.primary-button,
.secondary-button,
.danger-button {
  padding: 0 16px;
}

.primary-button {
  background: var(--button-bg);
  color: var(--on-accent-text);
}

.primary-button:hover:not(:disabled) {
  background: var(--button-hover-bg);
}

.secondary-button,
.icon-button,
.status-tab {
  background: var(--surface-overlay);
  border-color: var(--border-color);
  color: var(--primary-text);
}

.secondary-button:hover:not(:disabled),
.icon-button:hover:not(:disabled),
.status-tab:hover {
  background: var(--surface-overlay-strong);
}

.danger-button {
  background: var(--danger-color);
  color: var(--on-accent-text);
}

.danger-button:hover:not(:disabled) {
  background: var(--danger-hover-bg);
}

.icon-button {
  width: 42px;
  padding: 0;
  flex: 0 0 42px;
}

.compact {
  min-height: 34px;
  padding: 0 12px;
  font-size: var(--font-size-helper);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.message {
  gap: var(--space-2);
  min-height: 42px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-3);
  font-size: var(--font-size-body);
}

.message-error {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
}

.message-success {
  background: var(--success-bg);
  border: 1px solid var(--success-border);
  color: var(--success-text);
}

.queue-toolbar {
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.status-tab {
  min-height: 34px;
  padding: 0 10px 0 12px;
  color: var(--secondary-text);
}

.status-tab span {
  min-width: 22px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--tertiary-bg);
  color: var(--primary-text);
  font-size: var(--font-size-caption);
}

.status-tab.active {
  border-color: var(--highlight-text);
  color: var(--primary-text);
  background: var(--accent-bg);
}

.limit-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.limit-control input {
  width: 84px;
}

.request-list {
  display: grid;
  gap: var(--space-3);
}

.request-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 360px);
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--secondary-bg);
}

.request-main {
  min-width: 0;
}

.request-title-row {
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.request-title-row code,
.attempt,
.file-list span {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.request-title-row code {
  color: var(--primary-text);
  word-break: break-all;
}

.attempt {
  color: var(--secondary-text);
}

.prompt-preview {
  margin: 0 0 var(--space-3);
  color: var(--primary-text);
  line-height: 1.55;
  word-break: break-word;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.meta-grid div {
  min-width: 0;
}

.meta-grid span {
  display: block;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  margin-bottom: 2px;
}

.meta-grid strong {
  display: block;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.request-actions {
  justify-content: flex-end;
  align-items: flex-start;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.inline-form {
  gap: var(--space-2);
  width: 100%;
}

.inline-form input {
  min-width: 0;
}

.inline-warning,
.inline-error,
.file-list {
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-size: var(--font-size-helper);
}

.inline-warning {
  color: var(--warning-text);
}

.file-list {
  flex-wrap: wrap;
}

.file-list span {
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  overflow-wrap: anywhere;
}

.status-badge {
  min-width: 104px;
  text-align: center;
  border-radius: var(--radius-full);
  padding: 4px 10px;
  font-size: var(--font-size-caption);
  font-weight: 750;
}

.status-pending {
  background: var(--info-bg);
  color: var(--info-text);
}

.status-claimed {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.status-artifact_ready,
.status-done {
  background: var(--success-bg);
  color: var(--success-text);
}

.status-failed {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.status-cancelled {
  background: var(--surface-overlay);
  color: var(--secondary-text);
}

.empty-state {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--secondary-text);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
}

.loading-spinner,
.loading-spinner-sm {
  border-radius: 50%;
  border-style: solid;
  border-color: color-mix(in srgb, var(--primary-text) 24%, transparent);
  border-top-color: var(--highlight-text);
  animation: spin 0.8s linear infinite;
}

.loading-spinner {
  width: 22px;
  height: 22px;
  border-width: 3px;
}

.loading-spinner-sm {
  width: 18px;
  height: 18px;
  border-width: 2px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .form-grid,
  .meta-grid,
  .request-card {
    grid-template-columns: 1fr;
  }

  .queue-toolbar,
  .relay-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .icon-button {
    align-self: flex-start;
  }
}

@media (max-width: 560px) {
  .relay-page {
    padding: var(--space-4) var(--space-3);
  }

  .inline-form,
  .form-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .primary-button,
  .secondary-button,
  .danger-button {
    width: 100%;
  }
}
</style>


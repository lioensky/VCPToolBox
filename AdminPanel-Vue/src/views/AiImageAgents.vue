<template>
  <section class="config-section active-section">
    <div class="ai-image-page">
      <h2 class="page-title">AI Image Agent</h2>

      <!-- Dry-Run -->
      <form class="dry-run-form" @submit.prevent="handleDryRun">
        <div class="form-group">
          <label for="pipeline-id">Pipeline ID</label>
          <input
            id="pipeline-id"
            v-model="pipelineId"
            type="text"
            placeholder="例如：my-pipeline-001"
          />
        </div>

        <div class="form-group">
          <label for="task-id">Task ID</label>
          <input
            id="task-id"
            v-model="taskId"
            type="text"
            placeholder="例如：my-task-001"
          />
        </div>

        <div class="form-group">
          <label for="plan-json">Plan JSON</label>
          <textarea
            id="plan-json"
            v-model="planJson"
            rows="6"
            placeholder='{ "steps": [] }'
          ></textarea>
          <span v-if="planError" class="field-error">{{ planError }}</span>
        </div>

        <button
          type="submit"
          class="action-btn"
          :disabled="isLoading || planError !== null"
        >
          <span v-if="isLoading" class="loading-spinner-sm"></span>
          <span v-else class="material-symbols-outlined">play_arrow</span>
          Dry Run
        </button>
      </form>

      <!-- Real Execute 危险区域 -->
      <div class="execute-section">
        <div class="execute-warning">
          <span class="material-symbols-outlined">warning</span>
          Real Execute：真实调用外部 API，可能产生费用
        </div>

        <form class="execute-form" @submit.prevent="handleExecute">
          <div class="form-group">
            <label for="operator">Operator（谁在执行）</label>
            <input
              id="operator"
              v-model="operator"
              type="text"
              placeholder="输入操作者名称"
            />
          </div>

          <div class="form-group-check">
            <label>
              <input v-model="confirmed" type="checkbox" />
              我确认要真实生成图片
            </label>
          </div>

          <div class="execute-actions">
            <button
              type="submit"
              class="action-btn action-btn-danger"
              :disabled="isLoading || !operator.trim() || !confirmed || planError !== null || stepCount !== 1"
            >
              <span v-if="isLoading" class="loading-spinner-sm"></span>
              <span v-else class="material-symbols-outlined">bolt</span>
              Execute DoubaoGen
            </button>
            <span v-if="stepCount !== 1" class="field-error">
              真实执行只允许 1 个 step，当前 plan 有 {{ stepCount }} 个
            </span>
          </div>
        </form>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="result-error">
        <span class="material-symbols-outlined">error</span>
        {{ errorMessage }}
      </div>

      <!-- 结果区 -->
      <div v-if="result" class="result-panel">
        <h3>返回结果</h3>

        <div class="result-grid">
          <div class="result-item">
            <span class="result-label">Status</span>
            <span :class="['result-value', 'badge', result.ok ? 'badge-ok' : 'badge-fail']">
              {{ result.status || '-' }}
            </span>
          </div>
          <div class="result-item">
            <span class="result-label">Mode</span>
            <span class="result-value">{{ result.mode || '-' }}</span>
          </div>
        </div>

        <!-- Images（真实执行） -->
        <div v-if="resultImages.length > 0" class="result-section">
          <details open>
            <summary>Images ({{ resultImages.length }})</summary>
            <div class="images-list">
              <div v-for="(img, i) in resultImages" :key="i" class="image-item">
                <div class="image-field">
                  <span class="image-label">Plugin:</span>
                  <span>{{ img.plugin || '-' }}</span>
                </div>
                <div class="image-field">
                  <span class="image-label">Path:</span>
                  <code>{{ img.path || '-' }}</code>
                </div>
                <div class="image-field">
                  <span class="image-label">URL:</span>
                  <a v-if="img.url" :href="img.url" target="_blank" rel="noopener">{{ img.url }}</a>
                  <span v-else>-</span>
                </div>
                <div class="image-field">
                  <span class="image-label">Filename:</span>
                  <code>{{ img.filename || '-' }}</code>
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- Errors（失败） -->
        <details v-if="resultErrors.length > 0" class="result-section result-section-error" open>
          <summary>Errors ({{ resultErrors.length }})</summary>
          <ul class="errors-list">
            <li v-for="(e, i) in resultErrors" :key="i">{{ e }}</li>
          </ul>
        </details>

        <details v-if="result.state" class="result-section">
          <summary>State</summary>
          <pre>{{ formatJson(result.state) }}</pre>
        </details>

        <details v-if="result.safety" class="result-section">
          <summary>Safety</summary>
          <pre>{{ formatJson(result.safety) }}</pre>
        </details>

        <details v-if="result.audit" class="result-section">
          <summary>Audit</summary>
          <pre>{{ formatJson(result.audit) }}</pre>
        </details>

        <details v-if="result.error" class="result-section result-section-error">
          <summary>Error</summary>
          <pre>{{ result.error }}</pre>
        </details>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { aiImageAgentsApi, type AiImageDryRunResult, type AiImageExecuteImage } from "@/api/aiImageAgents";

const pipelineId = ref("");
const taskId = ref("");
const planJson = ref('{\n  "steps": []\n}');
const isLoading = ref(false);
const result = ref<AiImageDryRunResult | null>(null);
const errorMessage = ref("");

// Execute 专属
const operator = ref("");
const confirmed = ref(false);
const resultImages = ref<AiImageExecuteImage[]>([]);
const resultErrors = ref<string[]>([]);

const planError = computed(() => {
  if (!planJson.value.trim()) return null;
  try {
    JSON.parse(planJson.value);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});

const stepCount = computed(() => {
  try {
    const plan = JSON.parse(planJson.value);
    const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    return steps.length;
  } catch {
    return -1;
  }
});

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resetResult() {
  result.value = null;
  resultImages.value = [];
  resultErrors.value = [];
  errorMessage.value = "";
}

async function handleDryRun() {
  resetResult();

  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(planJson.value);
  } catch {
    errorMessage.value = "Plan JSON 格式无效";
    return;
  }

  isLoading.value = true;
  try {
    const res = await aiImageAgentsApi.dryRun(
      {
        pipelineId: pipelineId.value || "default-pipeline",
        taskId: taskId.value || "default-task",
        plan,
      },
      {},
      { showLoader: false }
    );
    result.value = res;
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

async function handleExecute() {
  resetResult();

  if (!operator.value.trim() || !confirmed.value) return;
  if (planError.value) return;
  if (stepCount.value !== 1) return;

  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(planJson.value);
  } catch {
    errorMessage.value = "Plan JSON 格式无效";
    return;
  }

  isLoading.value = true;
  try {
    const res = await aiImageAgentsApi.execute(
      pipelineId.value || "execute-pipeline",
      taskId.value || "execute-task",
      plan,
      operator.value.trim(),
      {},
      { showLoader: false }
    );

    result.value = {
      ok: res.ok,
      mode: res.mode || "",
      status: res.result?.status || "",
      state: (res.result?.state as Record<string, unknown>) || null,
      safety: (res.result?.safety as Record<string, unknown>) || null,
      audit: (res.result?.audit as Record<string, unknown>) || null,
      error: res.error || res.result?.error || null,
    };

    resultImages.value = res.result?.images || [];
    resultErrors.value = res.result?.errors || [];
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}
</script>

<style scoped>
.ai-image-page {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.page-title {
  font-size: var(--font-size-heading);
  font-weight: 600;
  color: var(--primary-text);
  margin-bottom: var(--space-6);
}

.dry-run-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--border-color);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.form-group label {
  font-size: var(--font-size-helper);
  font-weight: 500;
  color: var(--secondary-text);
}

.form-group input,
.form-group textarea {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg, var(--tertiary-bg));
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-family: inherit;
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

.field-error {
  font-size: var(--font-size-helper);
  color: #fca5a5;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 10px 24px;
  border: none;
  border-radius: 8px;
  background: var(--button-bg);
  color: var(--on-accent-text);
  font-size: var(--font-size-body);
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.action-btn:hover:not(:disabled) {
  background: var(--button-hover-bg);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Execute 危险区域 */
.execute-section {
  margin-bottom: var(--space-6);
}

.execute-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: #fca5a5;
  font-size: var(--font-size-body);
  margin-bottom: var(--space-4);
}

.execute-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.form-group-check {
  display: flex;
  align-items: center;
}

.form-group-check label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-body);
  color: var(--primary-text);
  cursor: pointer;
}

.form-group-check input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: var(--highlight-text);
}

.execute-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.action-btn-danger {
  background: #dc2626;
}

.action-btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

/* 结果区 */
.result-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  font-size: var(--font-size-body);
  margin-bottom: var(--space-4);
}

.result-panel {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: var(--space-5);
  background: var(--secondary-bg);
}

.result-panel h3 {
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
  margin-bottom: var(--space-4);
}

.result-grid {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-4);
}

.result-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.result-value {
  font-size: var(--font-size-body);
  color: var(--primary-text);
}

.badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.badge-ok {
  background: rgba(34, 197, 94, 0.15);
  color: #86efac;
}

.badge-fail {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}

/* Images */
.images-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.image-item {
  padding: var(--space-3);
  background: var(--tertiary-bg);
  border-radius: 6px;
}

.image-field {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: var(--font-size-body);
  color: var(--primary-text);
  word-break: break-all;
}

.image-label {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--secondary-text);
}

.image-field a {
  color: var(--highlight-text);
}

.image-field code {
  font-size: var(--font-size-code);
  color: var(--secondary-text);
}

/* Errors */
.errors-list {
  margin: var(--space-2) 0;
  padding-left: var(--space-5);
}

.errors-list li {
  font-size: var(--font-size-body);
  color: #fca5a5;
  margin-bottom: 4px;
  word-break: break-all;
}

.result-section {
  margin-top: var(--space-3);
}

.result-section summary {
  cursor: pointer;
  font-size: var(--font-size-body);
  font-weight: 500;
  color: var(--secondary-text);
  padding: var(--space-1) 0;
}

.result-section summary:hover {
  color: var(--primary-text);
}

.result-section pre {
  margin-top: var(--space-2);
  padding: var(--space-3);
  background: var(--tertiary-bg);
  border-radius: 6px;
  font-size: var(--font-size-code);
  color: var(--primary-text);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
}

.result-section-error summary {
  color: #fca5a5;
}

.result-section-error pre {
  color: #fca5a5;
}

.loading-spinner-sm {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .result-grid {
    flex-direction: column;
    gap: var(--space-3);
  }
}
</style>

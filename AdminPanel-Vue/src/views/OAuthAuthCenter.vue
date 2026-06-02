<template>
  <section class="config-section active-section">
    <div class="oauth-page">
      <header class="oauth-header">
        <div>
          <h2 class="page-title">OAuth 认证中心</h2>
          <p class="page-subtitle">管理 ChatGPT/Codex 与 GitHub Copilot 的本地授权账号</p>
        </div>
        <button class="icon-button" type="button" :disabled="isLoading" aria-label="刷新认证状态" @click="loadAll">
          <span class="material-symbols-outlined">refresh</span>
        </button>
      </header>

      <div v-if="loadError" class="message message-error">
        <span class="material-symbols-outlined">error</span>
        {{ loadError }}
      </div>

      <div class="provider-list">
        <article v-for="provider in providerCards" :key="provider.id" class="provider-card">
          <div class="provider-main">
            <div class="provider-title-row">
              <span class="provider-icon material-symbols-outlined">{{ provider.icon }}</span>
              <div>
                <h3>{{ provider.title }}</h3>
                <p>{{ provider.subtitle }}</p>
              </div>
            </div>

            <div class="provider-summary">
              <span :class="['status-dot', provider.status?.authenticated ? 'online' : 'offline']"></span>
              <span>{{ provider.status?.authenticated ? "已授权" : "未授权" }}</span>
              <span>{{ provider.status?.accounts.length || 0 }} 个账号</span>
            </div>
          </div>

          <div class="provider-actions">
            <button
              class="primary-button"
              type="button"
              :disabled="isProviderBusy(provider.id)"
              @click="startLogin(provider.id)"
            >
              <span class="material-symbols-outlined">login</span>
              登录
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="isProviderBusy(provider.id)"
              @click="loadStatus(provider.id)"
            >
              <span class="material-symbols-outlined">sync</span>
              刷新
            </button>
          </div>

          <div v-if="activeLogin?.provider === provider.id" class="login-panel">
            <div class="code-block">
              <span>验证码</span>
              <strong>{{ activeLogin.userCode }}</strong>
              <button class="icon-button small" type="button" aria-label="复制验证码" @click="copyCode(activeLogin.userCode)">
                <span class="material-symbols-outlined">content_copy</span>
              </button>
            </div>
            <div class="login-actions">
              <button class="secondary-button compact" type="button" @click="openVerification(activeLogin.verificationUri)">
                <span class="material-symbols-outlined">open_in_new</span>
                打开授权页
              </button>
              <span v-if="pollingProvider === provider.id" class="polling-text">
                <span class="loading-spinner-sm"></span>
                正在等待浏览器授权
              </span>
            </div>
          </div>

          <div v-if="provider.id === 'codex_oauth'" class="responses-provider-panel">
            <div class="responses-provider-main">
              <span
                :class="[
                  'status-dot',
                  responsesProviderStatus?.enabled ? 'online' : 'offline',
                ]"
              ></span>
              <div>
                <h4>VCP Responses Provider</h4>
                <p>
                  {{ responsesProviderStatus?.enabled ? "已接入主服务 /v1/responses" : "未接入主服务 /v1/responses" }}
                </p>
              </div>
            </div>
            <div class="responses-provider-meta">
              <span>provider={{ responsesProviderStatus?.configuredProvider || "-" }}</span>
              <span>account={{ responsesProviderStatus?.accountId || responsesProviderStatus?.defaultAccountId || "-" }}</span>
            </div>
            <div class="responses-provider-actions">
              <button
                v-if="!responsesProviderStatus?.enabled"
                class="secondary-button compact"
                type="button"
                :disabled="responsesProviderBusy || !canEnableResponsesProvider"
                :title="canEnableResponsesProvider ? '启用 Provider' : '请先完成 Codex OAuth 授权'"
                @click="enableResponsesProvider"
              >
                <span class="material-symbols-outlined">power_settings_new</span>
                启用 Provider
              </button>
              <button
                v-else
                class="danger-button compact"
                type="button"
                :disabled="responsesProviderBusy"
                title="停用 Provider"
                @click="disableResponsesProvider"
              >
                <span class="material-symbols-outlined">power_settings_new</span>
                停用 Provider
              </button>
              <button
                class="secondary-button compact"
                type="button"
                :disabled="responsesProviderBusy"
                @click="loadResponsesProviderStatus"
              >
                <span class="material-symbols-outlined">sync</span>
                刷新接入
              </button>
              <button
                class="secondary-button compact"
                type="button"
                :disabled="responsesProviderBusy || !canSmokeResponsesProvider"
                :title="canSmokeResponsesProvider ? '测试 Provider' : '请先启用 Provider 并完成授权'"
                @click="smokeResponsesProvider"
              >
                <span class="material-symbols-outlined">network_check</span>
                测试 Provider
              </button>
            </div>
            <div v-if="responsesProviderSmoke" class="responses-provider-smoke">
              <span :class="['status-dot', responsesProviderSmoke.upstream.ok ? 'online' : 'offline']"></span>
              <span>status={{ responsesProviderSmoke.upstream.status }}</span>
              <span>keys={{ responsesProviderSmoke.upstream.payload.keys.join(",") || "-" }}</span>
              <span>expires={{ formatDate(responsesProviderSmoke.tokenExpiresAt) }}</span>
            </div>
          </div>

          <div v-if="provider.status?.accounts.length" class="account-list">
            <article v-for="account in provider.status.accounts" :key="account.id" class="account-row">
              <div class="account-avatar">
                <img v-if="account.avatarUrl" :src="account.avatarUrl" alt="" />
                <span v-else class="material-symbols-outlined">account_circle</span>
              </div>

              <div class="account-body">
                <div class="account-name-row">
                  <strong>{{ account.displayName || account.username || account.id }}</strong>
                  <span v-if="account.isDefault" class="default-badge">默认</span>
                </div>
                <div class="account-meta">
                  <span>{{ account.email || account.username || account.id }}</span>
                  <span>access={{ account.hasAccessToken ? "yes" : "no" }}</span>
                  <span>refresh={{ account.hasRefreshToken ? "yes" : "no" }}</span>
                  <span>expires={{ formatDate(account.tokenExpiresAt) }}</span>
                </div>
              </div>

              <div class="account-actions">
                <button
                  class="secondary-button compact"
                  type="button"
                  :disabled="account.isDefault || isProviderBusy(provider.id)"
                  @click="setDefault(provider.id, account.id)"
                >
                  <span class="material-symbols-outlined">star</span>
                  设默认
                </button>
                <button
                  class="danger-button compact"
                  type="button"
                  :disabled="isProviderBusy(provider.id)"
                  @click="removeAccount(provider.id, account.id)"
                >
                  <span class="material-symbols-outlined">delete</span>
                  移除
                </button>
              </div>
            </article>
          </div>

          <div v-else class="empty-state">
            <span class="material-symbols-outlined">key_off</span>
            暂无本地授权账号
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  oauthAuthApi,
  type CodexResponsesProviderStatus,
  type OAuthUpstreamSmokeResult,
  type OAuthLoginSession,
  type OAuthProviderId,
  type OAuthStatus,
} from "@/api";
import { showMessage } from "@/utils";

interface ProviderCard {
  id: OAuthProviderId;
  title: string;
  subtitle: string;
  icon: string;
  status: OAuthStatus | null;
}

const providers: ProviderCard[] = [
  {
    id: "codex_oauth",
    title: "ChatGPT / Codex OAuth",
    subtitle: "复刻 CC Switch 的 OpenAI Device Code 授权流程",
    icon: "terminal",
    status: null,
  },
  {
    id: "github_copilot",
    title: "GitHub Copilot OAuth",
    subtitle: "使用 GitHub Device Code 登录并换取 Copilot token",
    icon: "code",
    status: null,
  },
];

const statuses = ref<Record<OAuthProviderId, OAuthStatus | null>>({
  codex_oauth: null,
  github_copilot: null,
});
const isLoading = ref(false);
const busyProviders = ref(new Set<OAuthProviderId>());
const loadError = ref("");
const activeLogin = ref<OAuthLoginSession | null>(null);
const pollingProvider = ref<OAuthProviderId | null>(null);
const responsesProviderStatus = ref<CodexResponsesProviderStatus | null>(null);
const responsesProviderSmoke = ref<OAuthUpstreamSmokeResult | null>(null);
const responsesProviderBusy = ref(false);
let pollTimer: number | undefined;

const providerCards = computed(() =>
  providers.map((provider) => ({
    ...provider,
    status: statuses.value[provider.id],
  }))
);
const codexAccounts = computed(() => statuses.value.codex_oauth?.accounts || []);
const codexDefaultAccountId = computed(() => {
  const status = statuses.value.codex_oauth;
  return status?.defaultAccountId || status?.accounts.find((account) => account.isDefault)?.id || status?.accounts[0]?.id || "";
});
const canEnableResponsesProvider = computed(() => Boolean(codexDefaultAccountId.value));
const canSmokeResponsesProvider = computed(() =>
  Boolean(responsesProviderStatus.value?.enabled && codexAccounts.value.length > 0)
);

function setProviderBusy(provider: OAuthProviderId, value: boolean): void {
  const next = new Set(busyProviders.value);
  if (value) {
    next.add(provider);
  } else {
    next.delete(provider);
  }
  busyProviders.value = next;
}

function isProviderBusy(provider: OAuthProviderId): boolean {
  return busyProviders.value.has(provider);
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function clearPolling(): void {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  pollingProvider.value = null;
}

async function loadStatus(provider: OAuthProviderId): Promise<void> {
  setProviderBusy(provider, true);
  try {
    const status = await oauthAuthApi.getStatus(provider, {}, { showLoader: false });
    statuses.value = {
      ...statuses.value,
      [provider]: status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`加载 ${provider} 认证状态失败：${message}`, "error");
  } finally {
    setProviderBusy(provider, false);
  }
}

async function loadAll(): Promise<void> {
  loadError.value = "";
  isLoading.value = true;
  try {
    await Promise.all([
      ...providers.map((provider) => loadStatus(provider.id)),
      loadResponsesProviderStatus(),
    ]);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isLoading.value = false;
  }
}

async function loadResponsesProviderStatus(): Promise<void> {
  responsesProviderBusy.value = true;
  try {
    responsesProviderStatus.value = await oauthAuthApi.getCodexResponsesProviderStatus({}, { showLoader: false });
  } catch (error) {
    showMessage(`加载 Responses Provider 状态失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    responsesProviderBusy.value = false;
  }
}

async function enableResponsesProvider(): Promise<void> {
  const accountId = codexDefaultAccountId.value || null;
  if (!accountId) {
    showMessage("请先完成 Codex OAuth 授权。", "error");
    return;
  }
  responsesProviderBusy.value = true;
  try {
    responsesProviderStatus.value = await oauthAuthApi.enableCodexResponsesProvider(accountId, {}, { showLoader: false });
    responsesProviderSmoke.value = null;
    showMessage("Codex OAuth Responses Provider 已启用。", "success");
  } catch (error) {
    showMessage(`启用 Responses Provider 失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    responsesProviderBusy.value = false;
  }
}

async function disableResponsesProvider(): Promise<void> {
  if (!window.confirm("确定停用 Codex OAuth Responses Provider？")) {
    return;
  }
  responsesProviderBusy.value = true;
  try {
    responsesProviderStatus.value = await oauthAuthApi.disableCodexResponsesProvider({}, { showLoader: false });
    responsesProviderSmoke.value = null;
    showMessage("Codex OAuth Responses Provider 已停用。", "success");
  } catch (error) {
    showMessage(`停用 Responses Provider 失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    responsesProviderBusy.value = false;
  }
}

async function smokeResponsesProvider(): Promise<void> {
  const accountId =
    responsesProviderStatus.value?.accountId ||
    codexDefaultAccountId.value ||
    null;
  if (!responsesProviderStatus.value?.enabled || !accountId) {
    showMessage("请先启用 Provider 并完成 Codex OAuth 授权。", "error");
    return;
  }
  responsesProviderBusy.value = true;
  try {
    responsesProviderSmoke.value = await oauthAuthApi.smokeCodexUpstream(accountId, {}, { showLoader: false });
    showMessage(
      responsesProviderSmoke.value.upstream.ok
        ? "Provider 连接测试通过。"
        : `Provider 连接测试失败：HTTP ${responsesProviderSmoke.value.upstream.status}`,
      responsesProviderSmoke.value.upstream.ok ? "success" : "error"
    );
  } catch (error) {
    showMessage(`Provider 连接测试失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    responsesProviderBusy.value = false;
  }
}

async function startLogin(provider: OAuthProviderId): Promise<void> {
  clearPolling();
  setProviderBusy(provider, true);
  try {
    const login = await oauthAuthApi.startLogin(provider, {}, { showLoader: false });
    activeLogin.value = login;
    await copyCode(login.userCode, false);
    openVerification(login.verificationUri);
    pollLogin(login);
    showMessage("验证码已生成，请在浏览器完成授权。", "success");
  } catch (error) {
    showMessage(`启动 OAuth 登录失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    setProviderBusy(provider, false);
  }
}

function pollLogin(login: OAuthLoginSession): void {
  clearPolling();
  pollingProvider.value = login.provider;

  const run = async () => {
    try {
      const result = await oauthAuthApi.pollLogin(login.provider, login.sessionId, {}, { showLoader: false, suppressErrorMessage: true });
      if (result.status === "authenticated") {
        clearPolling();
        activeLogin.value = null;
        await loadStatus(login.provider);
        showMessage(`账号 ${result.account.displayName || result.account.id} 已授权。`, "success");
        return;
      }

      const retryAfter = Math.max(2, result.retryAfterSeconds || login.intervalSeconds || 5);
      pollTimer = window.setTimeout(run, retryAfter * 1000);
    } catch (error) {
      clearPolling();
      showMessage(`OAuth 轮询失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pollTimer = window.setTimeout(run, Math.max(1, login.intervalSeconds || 5) * 1000);
}

function openVerification(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyCode(code: string, notify = true): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    if (notify) {
      showMessage("验证码已复制。", "success");
    }
  } catch (_error) {
    if (notify) {
      showMessage(code, "info");
    }
  }
}

async function setDefault(provider: OAuthProviderId, accountId: string): Promise<void> {
  setProviderBusy(provider, true);
  try {
    const accounts = await oauthAuthApi.setDefaultAccount(provider, accountId, {}, { showLoader: false });
    const currentStatus = statuses.value[provider];
    statuses.value = {
      ...statuses.value,
      [provider]: currentStatus
        ? {
            ...currentStatus,
            defaultAccountId: accountId,
            accounts,
          }
        : null,
    };
    showMessage("默认账号已更新。", "success");
  } catch (error) {
    showMessage(`设置默认账号失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    setProviderBusy(provider, false);
  }
}

async function removeAccount(provider: OAuthProviderId, accountId: string): Promise<void> {
  const removingActiveCodexProviderAccount =
    provider === "codex_oauth" &&
    responsesProviderStatus.value?.enabled &&
    (
      responsesProviderStatus.value.accountId === accountId ||
      (!responsesProviderStatus.value.accountId && codexDefaultAccountId.value === accountId)
    );
  const prompt = removingActiveCodexProviderAccount
    ? "这个账号正在被 Codex OAuth Responses Provider 使用，移除后 Provider 可能无法继续转发。确定移除？"
    : "确定移除这个 OAuth 账号？";
  if (!window.confirm(prompt)) {
    return;
  }
  setProviderBusy(provider, true);
  try {
    const accounts = await oauthAuthApi.removeAccount(provider, accountId, {}, { showLoader: false });
    const currentStatus = statuses.value[provider];
    statuses.value = {
      ...statuses.value,
      [provider]: currentStatus
        ? {
            ...currentStatus,
            authenticated: accounts.length > 0,
            defaultAccountId: accounts.find((account) => account.isDefault)?.id || null,
            accounts,
          }
        : null,
    };
    if (provider === "codex_oauth") {
      responsesProviderSmoke.value = null;
      await loadResponsesProviderStatus();
    }
    showMessage("账号已移除。", "success");
  } catch (error) {
    showMessage(`移除账号失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    setProviderBusy(provider, false);
  }
}

onMounted(() => {
  void loadAll();
});

onBeforeUnmount(() => {
  clearPolling();
});
</script>

<style scoped>
.oauth-page {
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.oauth-header,
.provider-title-row,
.provider-summary,
.provider-actions,
.message,
.code-block,
.login-actions,
.account-row,
.account-name-row,
.account-meta,
.account-actions,
.empty-state,
.polling-text {
  display: flex;
  align-items: center;
}

.oauth-header {
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

.provider-list {
  display: grid;
  gap: var(--space-4);
}

.provider-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  padding: var(--space-5) 0;
  border-top: 1px solid var(--border-color);
}

.provider-main {
  min-width: 0;
}

.provider-title-row {
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.provider-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-overlay);
  color: var(--highlight-text);
  flex: 0 0 44px;
}

.provider-title-row h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-title);
}

.provider-title-row p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.provider-summary {
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--secondary-text);
}

.status-dot.online {
  background: var(--success-text);
}

.status-dot.offline {
  background: var(--warning-text);
}

.provider-actions {
  align-items: flex-start;
  gap: var(--space-2);
}

.login-panel,
.responses-provider-panel,
.account-list,
.empty-state {
  grid-column: 1 / -1;
}

.login-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--secondary-bg);
}

.responses-provider-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--secondary-bg);
}

.responses-provider-main,
.responses-provider-meta,
.responses-provider-actions,
.responses-provider-smoke {
  display: flex;
  align-items: center;
}

.responses-provider-main {
  gap: var(--space-3);
  min-width: 0;
}

.responses-provider-main h4 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.responses-provider-main p {
  margin: 3px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.responses-provider-meta {
  grid-column: 1 / -1;
  gap: var(--space-3);
  flex-wrap: wrap;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.responses-provider-actions {
  gap: var(--space-2);
  justify-content: flex-end;
  flex-wrap: wrap;
}

.responses-provider-smoke {
  grid-column: 1 / -1;
  gap: var(--space-3);
  flex-wrap: wrap;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.code-block {
  gap: var(--space-3);
  flex-wrap: wrap;
}

.code-block span:first-child {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.code-block strong {
  font-family: var(--font-mono);
  font-size: 1.35rem;
  letter-spacing: 0;
  color: var(--primary-text);
}

.login-actions {
  gap: var(--space-3);
  flex-wrap: wrap;
}

.polling-text {
  gap: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.account-list {
  display: grid;
  gap: var(--space-2);
}

.account-row {
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--secondary-bg);
}

.account-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--surface-overlay);
  overflow: hidden;
  flex: 0 0 42px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.account-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.account-body {
  min-width: 0;
  flex: 1 1 auto;
}

.account-name-row {
  gap: var(--space-2);
  margin-bottom: 4px;
}

.account-name-row strong {
  color: var(--primary-text);
  overflow-wrap: anywhere;
}

.default-badge {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--success-bg);
  color: var(--success-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.account-meta {
  gap: var(--space-3);
  flex-wrap: wrap;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.account-actions {
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.primary-button,
.secondary-button,
.danger-button,
.icon-button {
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

.secondary-button,
.icon-button {
  background: var(--surface-overlay);
  border-color: var(--border-color);
  color: var(--primary-text);
}

.danger-button {
  background: var(--danger-color);
  color: var(--on-accent-text);
}

.icon-button {
  width: 42px;
  padding: 0;
  flex: 0 0 42px;
}

.icon-button.small {
  width: 34px;
  min-height: 34px;
  flex-basis: 34px;
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

.empty-state {
  min-height: 96px;
  justify-content: center;
  gap: var(--space-2);
  color: var(--secondary-text);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
}

.loading-spinner-sm {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--primary-text) 24%, transparent);
  border-top-color: var(--highlight-text);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 820px) {
  .provider-card,
  .responses-provider-panel,
  .account-row {
    grid-template-columns: 1fr;
  }

  .provider-actions,
  .responses-provider-actions,
  .account-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .oauth-page {
    padding: var(--space-4) var(--space-3);
  }

  .oauth-header,
  .provider-actions,
  .login-actions,
  .account-actions {
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

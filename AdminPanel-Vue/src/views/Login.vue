<template>
  <div class="login-page">
    <div class="login-container">
      <UiCard class="login-card" variant="subtle">
        <div class="logo-section">
          <img src="/VCPLogo2.png" alt="VCP Logo" @error="onImageError" />
          <p>控制中心管理面板</p>
        </div>

        <form @submit.prevent="handleLogin">
          <UiField label="用户名" for-id="username">
            <div class="input-wrapper">
              <UiInput
                type="text"
                id="username"
                v-model="username"
                size="lg"
                placeholder="请输入用户名"
                autocomplete="username"
                name="username"
                required
              />
              <span class="material-symbols-outlined input-icon" aria-hidden="true">person</span>
            </div>
          </UiField>

          <UiField label="密码" for-id="password">
            <div class="input-wrapper">
              <UiInput
                :type="showPassword ? 'text' : 'password'"
                id="password"
                v-model="password"
                size="lg"
                placeholder="请输入密码"
                autocomplete="current-password"
                name="password"
                required
              />
              <span class="material-symbols-outlined input-icon" aria-hidden="true">lock</span>
              <UiIconButton
                class="password-toggle"
                :label="showPassword ? '隐藏密码' : '显示密码'"
                :title="showPassword ? '隐藏密码' : '显示密码'"
                @click="togglePassword"
                :aria-pressed="showPassword"
              >
                <span class="material-symbols-outlined" aria-hidden="true">
                  {{ showPassword ? "visibility_off" : "visibility" }}
                </span>
              </UiIconButton>
            </div>
          </UiField>

          <UiButton
            type="submit"
            class="login-button"
            size="lg"
            block
            :disabled="isLoading"
            :loading="isLoading"
          >
            登 录
          </UiButton>

          <UiAlert
            v-if="message"
            class="message"
            :variant="messageType === 'error' ? 'danger' : 'success'"
          >
            {{ message }}
          </UiAlert>
        </form>

        <p class="footer-text">安全连接 · 仅限授权管理员访问</p>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { resolveSafeAppRedirect } from "@/app/routes/redirect";
import UiAlert from "@/components/ui/UiAlert.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiField from "@/components/ui/UiField.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const username = ref("");
const password = ref("");
const showPassword = ref(false);
const isLoading = ref(false);
const message = ref("");
const messageType = ref<"error" | "success">("error");

function onImageError(e: Event) {
  const target = e.target as HTMLImageElement;
  target.style.display = "none";
}

function togglePassword() {
  showPassword.value = !showPassword.value;
}

async function handleLogin() {
  if (!username.value || !password.value) {
    message.value = "请输入用户名和密码";
    messageType.value = "error";
    return;
  }

  isLoading.value = true;
  message.value = "";

  try {
    const result = await authStore.login(username.value, password.value);

    if (result.success) {
      message.value = "登录成功，正在跳转…";
      messageType.value = "success";

      // 优先回跳到登录前目标页（无效 redirect 自动回退到仪表盘）
      const redirect = resolveSafeAppRedirect(router, route.query.redirect);
      router.push(redirect);
    } else {
      message.value = result.message || "用户名或密码错误";
      messageType.value = "error";
    }
  } catch (error) {
    console.error("Login error:", error);
    message.value = "连接服务器失败，请检查网络连接后重试";
    messageType.value = "error";
  } finally {
    isLoading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: var(--app-viewport-height, 100vh);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-bg);
}

.login-container {
  width: 100%;
  max-width: 420px;
  padding: var(--space-5);
}

.login-card {
  padding: var(--space-6) var(--space-5);
}

.logo-section {
  text-align: center;
  margin-bottom: var(--space-6);
}

.logo-section img {
  max-width: 200px;
  height: auto;
  margin-bottom: var(--space-2);
}

.logo-section p {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

form {
  display: grid;
  gap: var(--space-4);
}

.input-wrapper {
  position: relative;
}

.input-wrapper .input-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--secondary-text);
  font-size: var(--font-size-title);
  pointer-events: none;
  transition: color var(--transition-fast);
}

.input-wrapper :deep(.ui-input) {
  padding-left: 44px;
  padding-right: 44px;
}

.password-toggle {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
}

.password-toggle .material-symbols-outlined {
  font-size: var(--font-size-title);
}

.login-button {
  position: relative;
  overflow: hidden;
}

.message {
  margin-top: var(--space-4);
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.footer-text {
  text-align: center;
  margin-top: var(--space-5);
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

@media (max-width: 480px) {
  .login-page {
    align-items: stretch;
    overflow-y: auto;
    padding: var(--space-4) 0;
  }

  .login-container {
    max-width: none;
    padding: var(--space-4);
  }

  .login-card {
    padding: var(--space-6) var(--space-5);
    border-radius: var(--radius-lg);
  }

  .logo-section {
    margin-bottom: var(--space-5);
  }

  .logo-section img {
    max-width: 160px;
  }

  .logo-section p {
    font-size: var(--font-size-helper);
  }

  .input-wrapper .input-icon {
    left: 12px;
    font-size: var(--font-size-emphasis);
  }

  .password-toggle {
    right: 6px;
  }

  .password-toggle .material-symbols-outlined {
    font-size: var(--font-size-emphasis);
  }

  .message {
    font-size: var(--font-size-helper);
  }

  .footer-text {
    margin-top: var(--space-4);
    line-height: 1.5;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message {
    animation: none;
  }

  .password-toggle {
    transition: none;
  }
}
</style>

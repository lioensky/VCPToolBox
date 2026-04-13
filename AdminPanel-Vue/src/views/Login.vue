<template>
  <div class="login-page">
    <div class="login-container">
      <div class="login-card">
        <div class="logo-section">
          <img src="/VCPLogo2.png" alt="VCP Logo" @error="onImageError" />
          <p>控制中心管理面板</p>
        </div>

        <form @submit.prevent="handleLogin">
          <div class="form-group">
            <label for="username">用户名</label>
            <div class="input-wrapper">
              <input
                type="text"
                id="username"
                v-model="username"
                placeholder="请输入用户名"
                autocomplete="username"
                name="username"
                required
              />
              <span class="material-symbols-outlined input-icon" aria-hidden="true">person</span>
            </div>
          </div>

          <div class="form-group">
            <label for="password">密码</label>
            <div class="input-wrapper">
              <input
                :type="showPassword ? 'text' : 'password'"
                id="password"
                v-model="password"
                placeholder="请输入密码"
                autocomplete="current-password"
                name="password"
                required
              />
              <span class="material-symbols-outlined input-icon" aria-hidden="true">lock</span>
              <button
                type="button"
                class="password-toggle"
                @click="togglePassword"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                :aria-pressed="showPassword"
              >
                <span class="material-symbols-outlined" aria-hidden="true">
                  {{ showPassword ? "visibility_off" : "visibility" }}
                </span>
              </button>
            </div>
          </div>

          <button
            type="submit"
            class="btn-primary login-button"
            :disabled="isLoading"
            :class="{ loading: isLoading }"
          >
            <span class="spinner"></span>
            <span class="btn-text">登 录</span>
          </button>

          <div v-if="message" :class="['message', messageType]">
            {{ message }}
          </div>
        </form>

        <p class="footer-text">安全连接 · 仅限授权管理员访问</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { resolveSafeAppRedirect } from "@/app/routes/redirect";
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

      // 等待状态更新后跳转
      await new Promise((resolve) => setTimeout(resolve, 500));

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

// 页面加载时检查是否已登录（异步执行）
if (!authStore.isLoading && authStore.isAuthenticated) {
  router.push({ name: "Dashboard" });
} else if (!authStore.isLoading) {
  // 仅在未加载时检查一次
  authStore.checkAuth().then((isAuth) => {
    if (isAuth) {
      router.push({ name: "Dashboard" });
    }
  });
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
  padding: 20px;
}

.login-card {
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 48px 40px;
  box-shadow: var(--shadow-md);
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

.form-group {
  margin-bottom: var(--space-5);
}

.form-group label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: var(--font-size-body);
  font-weight: 500;
  color: var(--primary-text);
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
  transition: color 0.2s;
}

.form-group input {
  width: 100%;
  padding: 14px 14px 14px 48px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: var(--font-size-body);
  color: var(--primary-text);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.form-group input:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.form-group input:focus:not(:focus-visible) {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.password-toggle {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--secondary-text);
  cursor: pointer;
  padding: var(--space-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s;
  border-radius: var(--radius-sm);
}

.password-toggle:hover {
  color: var(--primary-text);
  background: var(--surface-overlay);
}

.password-toggle:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.password-toggle .material-symbols-outlined {
  font-size: var(--font-size-title);
}

.login-button {
  width: 100%;
  padding: 14px var(--space-5);
  position: relative;
  overflow: hidden;
  justify-content: center;
}

.login-button .spinner {
  display: none;
  width: 20px;
  height: 20px;
  border: 2px solid color-mix(in srgb, var(--on-accent-text) 30%, transparent);
  border-top-color: var(--on-accent-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: var(--space-2);
}

.login-button.loading .spinner {
  display: inline-block;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.message {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-body);
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.message.error {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-color);
}

.message.success {
  background: var(--success-bg);
  border: 1px solid var(--success-border);
  color: var(--success-color);
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

  .form-group {
    margin-bottom: var(--space-4);
  }

  .form-group input {
    padding: 13px 44px 13px 44px;
    font-size: var(--font-size-body);
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

  .login-button {
    padding: 13px var(--space-4);
    font-size: var(--font-size-body);
  }

  .message {
    padding: 10px 12px;
    font-size: var(--font-size-helper);
  }

  .footer-text {
    margin-top: var(--space-4);
    line-height: 1.5;
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-button .spinner,
  .message {
    animation: none;
  }

  .form-group input,
  .password-toggle,
  .login-button {
    transition: none;
  }
}
</style>

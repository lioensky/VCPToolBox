import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authApi } from '@/api'
import type { LoginResponse } from '@/types/api.auth'

const AUTH_CACHE_TTL = 5 * 60 * 1000

export const useAuthStore = defineStore('auth', () => {
  const isAuthenticated = ref(false)
  const isLoading = ref(true)
  const error = ref<string | null>(null)
  const user = ref<{
    username: string
    role?: string
  } | null>(null)
  const lastAuthCheckAt = ref(0)

  let authCheckPromise: Promise<boolean> | null = null

  function isAuthCacheFresh(): boolean {
    if (lastAuthCheckAt.value === 0) {
      return false
    }

    return Date.now() - lastAuthCheckAt.value < AUTH_CACHE_TTL
  }

  async function syncUserProfile(fallbackUsername?: string): Promise<void> {
    const profile = await authApi.getCurrentUserInfo()
    if (profile) {
      user.value = profile
      return
    }

    if (fallbackUsername) {
      user.value = { username: fallbackUsername }
      return
    }

    user.value = null
  }

  async function checkAuth(options: { force?: boolean } = {}): Promise<boolean> {
    const { force = false } = options

    if (!force && isAuthCacheFresh()) {
      return isAuthenticated.value
    }

    if (authCheckPromise) {
      return authCheckPromise
    }

    authCheckPromise = (async () => {
      try {
        isLoading.value = true
        error.value = null

        const result = await authApi.checkAuthStatus()
        isAuthenticated.value = result
        lastAuthCheckAt.value = Date.now()

        if (result) {
          await syncUserProfile()
        } else {
          user.value = null
        }

        return result
      } catch (err) {
        error.value = err instanceof Error ? err.message : '认证检查失败'
        isAuthenticated.value = false
        user.value = null
        return false
      } finally {
        isLoading.value = false
        authCheckPromise = null
      }
    })()

    return authCheckPromise
  }

  async function login(username: string, password: string): Promise<LoginResponse> {
    try {
      isLoading.value = true
      error.value = null

      const result = await authApi.login({ username, password })

      if (result.success) {
        isAuthenticated.value = true
        lastAuthCheckAt.value = Date.now()
        await syncUserProfile(username)
      } else {
        error.value = result.message || '登录失败'
      }

      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : '登录失败'
      return {
        success: false,
        message: error.value,
      }
    } finally {
      isLoading.value = false
    }
  }

  function logout(): void {
    isAuthenticated.value = false
    user.value = null
    error.value = null
    lastAuthCheckAt.value = 0
    authCheckPromise = null

    if (typeof window !== 'undefined') {
      sessionStorage.clear()
    }
  }

  function clearError(): void {
    error.value = null
  }

  return {
    isAuthenticated,
    isLoading,
    error,
    user,
    checkAuth,
    login,
    logout,
    clearError,
  }
})

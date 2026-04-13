import type {
  AuthCheckResponse,
  LoginRequest,
  LoginResponse,
} from "@/types/api.auth";
import { executeRequest } from '@/platform/http/request'
import { HttpError, toHttpError } from '@/platform/http/errors'
import { createLogger } from '@/utils/logger'

export type AuthUserInfo = NonNullable<AuthCheckResponse['user']>

const logger = createLogger('AuthApi')

interface StatusError extends Error {
  status?: number
}

interface AuthRequestResult<T> {
  ok: boolean
  status?: number
  data?: T
  message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractAuthUser(payload: unknown): AuthUserInfo | null {
  if (!isRecord(payload)) {
    return null
  }

  const user = payload.user
  if (!isRecord(user)) {
    return null
  }

  const username = user.username
  const role = user.role

  if (typeof username !== 'string' || username.length === 0) {
    return null
  }

  return {
    username,
    role: typeof role === 'string' ? role : undefined,
  }
}

function toStatusError(error: unknown): StatusError {
  if (error instanceof HttpError) {
    return error
  }

  if (error instanceof Error) {
    return error as StatusError
  }

  return toHttpError(error)
}

function createBasicAuth(credentials: LoginRequest): string {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
  }

async function requestAuth<T>(
  request: {
    url: string
    method: 'GET' | 'POST'
    headers?: Record<string, string>
  }
): Promise<AuthRequestResult<T>> {
  try {
    const data = await executeRequest<T>(request)
    return {
      ok: true,
      data,
    }
  } catch (error) {
    const statusError = toStatusError(error)
    return {
      ok: false,
      status: statusError.status,
      message: statusError.message,
    }
  }
}

async function requestVerifyLogin(
  credentials?: LoginRequest
): Promise<AuthRequestResult<unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (credentials) {
    headers.Authorization = createBasicAuth(credentials)
  }

  return requestAuth({
    url: '/admin_api/verify-login',
    method: 'POST',
    headers,
  })
}

async function requestCheckAuth(): Promise<AuthRequestResult<AuthCheckResponse>> {
  return requestAuth<AuthCheckResponse>({
    url: '/admin_api/check-auth',
    method: 'GET',
  })
}

function isAuthenticatedResponse(payload: AuthCheckResponse | undefined): boolean {
  if (!payload) {
    return false
  }

  if (typeof payload.authenticated === 'boolean') {
    return payload.authenticated
  }

  return true
}

function normalizeLoginError(result: AuthRequestResult<unknown>): LoginResponse {
  if (result.status === 429) {
    return {
      success: false,
      message: result.message || '登录尝试过于频繁，请稍后再试',
    }
  }

  if (result.status === 401 || result.status === 403) {
    return {
      success: false,
      message: '用户名或密码错误',
    }
  }

  if (result.status && result.status >= 500) {
    return {
      success: false,
      message: '服务器暂时不可用，请稍后再试',
    }
  }

  if (result.message) {
    return {
      success: false,
      message: '连接服务器失败，请检查网络',
    }
  }

  return {
    success: false,
    message: '登录失败，请稍后重试',
  }
}

export const authApi = {
  async verifyLogin(): Promise<boolean> {
    const result = await requestVerifyLogin()
    if (!result.ok) {
      logger.warn('verify-login check failed:', {
        status: result.status,
        message: result.message,
      })
    }

    return result.ok
  },

  async checkAuthStatus(): Promise<boolean> {
    const result = await requestCheckAuth()

    if (result.ok) {
      return isAuthenticatedResponse(result.data)
    }

    if (result.status === 404) {
      logger.warn('check-auth not found, falling back to verify-login')
      return authApi.verifyLogin()
    }

    logger.warn('check-auth failed, falling back to verify-login:', {
      status: result.status,
      message: result.message,
    })
    return authApi.verifyLogin()
  },

  async getCurrentUserInfo(): Promise<AuthUserInfo | null> {
    const result = await requestCheckAuth()

    if (!result.ok) {
      if (result.status !== 404) {
        logger.warn('fetch user info failed at /admin_api/check-auth:', {
          status: result.status,
          message: result.message,
        })
      }
      return null
    }

    return extractAuthUser(result.data)
  },

  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const result = await requestVerifyLogin(credentials)

    if (result.ok) {
      return { success: true }
    }

    logger.warn('login request failed:', {
      status: result.status,
      message: result.message,
    })

    return normalizeLoginError(result)
  },
}

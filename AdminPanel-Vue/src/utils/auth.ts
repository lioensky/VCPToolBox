import type { Router } from 'vue-router'
import { APP_ROUTER_BASE } from '@/app/routes/base'
import { getAppRoutePath } from '@/app/routes/manifest'
import { createLogger } from './logger'

const logger = createLogger('Auth')

export function redirectToLogin(router?: Router): void {
  if (router) {
    router.push({ name: 'Login' })
    return
  }

  if (typeof window !== 'undefined') {
    window.location.href = `${APP_ROUTER_BASE}${getAppRoutePath('login')}`
  }
}

export function redirectToDashboard(router: Router): void {
  router.push({ name: 'Dashboard' })
}

export function handle401Response(response: Response, router?: Router): boolean {
  if (response.status === 401) {
    logger.warn('401 Unauthorized, redirecting to login...')
    redirectToLogin(router)
    return true
  }

  return false
}

export async function withAuth<T>(
  requestFn: () => Promise<T>,
  router?: Router
): Promise<T> {
  try {
    return await requestFn()
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('401')) {
      logger.warn('API request failed with 401, redirecting to login...')
      redirectToLogin(router)
      throw new Error('AUTH_REQUIRED: 401 Unauthorized')
    }

    throw error
  }
}

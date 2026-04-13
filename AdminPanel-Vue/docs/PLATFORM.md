# AdminPanel-Vue 平台层

本文档详细说明 AdminPanel-Vue 平台层的设计，包括认证系统、反馈系统和 HTTP 基础设施。

## 目录

- [架构概览](#架构概览)
- [认证系统](#认证系统)
- [反馈系统](#反馈系统)
- [HTTP 基础设施](#http-基础设施)
- [使用示例](#使用示例)
- [扩展指南](#扩展指南)

---

## 架构概览

平台层位于架构最底层，为上层提供与业务无关的基础设施能力。

```
┌─────────────────────────────────────────────────────────────┐
│                      App Layer                              │
│         (main.ts 初始化并配置平台层)                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Platform Layer                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │    Auth     │  │  Feedback   │  │    HTTP     │         │
│  │   Session   │  │    Bus      │  │   Errors    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **零业务依赖** - 不依赖任何业务代码
2. **事件驱动** - 通过回调和事件与上层通信
3. **统一接口** - 提供稳定的 API 供上层使用
4. **可替换性** - 实现细节可被替换而不影响上层

---

## 认证系统

**位置**: `src/platform/auth/session.ts`

### 核心功能

- Session 状态管理
- Token 过期处理
- 401 错误统一响应
- 防抖机制（防止重复触发）

### 核心类型

```typescript
// 认证过期来源
export type AuthExpiredSource = 'httpClient' | 'apiFetch'

// 认证过期事件
export interface AuthExpiredEvent {
  source: AuthExpiredSource
  status: 401
  requestUrl?: string
  error?: unknown
  at: number
}

// 认证过期监听器
export type AuthExpiredListener = (event: AuthExpiredEvent) => void
```

### API 参考

#### setAuthExpiredListener

设置认证过期监听器，当检测到 401 错误时触发。

```typescript
export function setAuthExpiredListener(
  listener: AuthExpiredListener | null | undefined
): void
```

**使用场景**:
```typescript
// main.ts
setAuthExpiredListener(() => {
  const authStore = useAuthStore()
  authStore.logout()
  router.replace({ name: 'Login' })
})
```

#### notifyAuthExpired

通知认证已过期，由 HTTP 层调用。

```typescript
export function notifyAuthExpired(event: {
  source: AuthExpiredSource
  requestUrl?: string
  error?: unknown
}): void
```

**防抖机制**:
- 冷却时间: 1000ms
- 短时间内多次调用只会触发一次

#### isAuthRequiredError

判断错误是否为认证相关错误。

```typescript
export function isAuthRequiredError(error: unknown): boolean
```

**判断条件**:
- 错误是 `AuthExpiredError` 实例
- `error.status === 401`
- `error.code === 'AUTH_EXPIRED'` 或 `'AUTH_REQUIRED'`
- `error.message === 'Unauthorized'`

### 实现细节

```typescript
// platform/auth/session.ts

const AUTH_EXPIRED_COOLDOWN_MS = 1000

let authExpiredListener: AuthExpiredListener | null = null
let lastEmittedAt = 0

export function notifyAuthExpired(event: AuthExpiredEventParams): void {
  const now = Date.now()
  
  // 防抖检查
  if (now - lastEmittedAt < AUTH_EXPIRED_COOLDOWN_MS) {
    return
  }
  
  lastEmittedAt = now
  authExpiredListener?.({
    ...event,
    status: 401,
    at: now,
  })
}
```

---

## 反馈系统

**位置**: `src/platform/feedback/`

### 核心功能

- 全局消息提示
- 加载状态管理
- 统一的反馈接口
- 可替换的反馈实现

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     Feedback Bus                            │
│              (platform/feedback/feedbackBus.ts)             │
│                      - 统一接口定义                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Feedback Sink                             │
│           (platform/feedback/feedbackState.ts)              │
│                  - 具体实现（Toast等）                       │
└─────────────────────────────────────────────────────────────┘
```

### 核心类型

```typescript
// 消息类型
export type FeedbackMessageType = 'info' | 'success' | 'error' | 'warning'

// 反馈接收器接口
export interface FeedbackSink {
  showLoading(show: boolean): void
  showMessage(
    message: string,
    type?: FeedbackMessageType,
    duration?: number
  ): void
}
```

### API 参考

#### setFeedbackSink

设置反馈接收器，由上层在应用初始化时调用。

```typescript
export function setFeedbackSink(
  sink: FeedbackSink | null | undefined
): void
```

**使用场景**:
```typescript
// main.ts
import { feedbackSink } from '@/platform/feedback/feedbackState'
import { setFeedbackSink } from '@/platform/feedback/feedbackBus'

setFeedbackSink(feedbackSink)
```

#### showLoading

显示/隐藏全局加载状态。

```typescript
export function showLoading(show: boolean): void
```

**使用示例**:
```typescript
import { showLoading } from '@/platform/feedback/feedbackBus'

// 显示加载
showLoading(true)

// 执行异步操作
await fetchData()

// 隐藏加载
showLoading(false)
```

#### showMessage

显示消息提示。

```typescript
export function showMessage(
  message: string,
  type: FeedbackMessageType = 'info',
  duration?: number
): void
```

**参数说明**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| message | string | - | 消息内容 |
| type | FeedbackMessageType | 'info' | 消息类型 |
| duration | number | undefined | 显示时长(ms)，undefined使用默认 |

**使用示例**:
```typescript
import { showMessage } from '@/platform/feedback/feedbackBus'

// 成功消息
showMessage('操作成功！', 'success')

// 错误消息
showMessage('操作失败', 'error')

// 警告消息（3秒）
showMessage('请检查输入', 'warning', 3000)

// 信息消息
showMessage('加载中...', 'info')
```

### 默认实现

`feedbackState.ts` 提供了基于 UI 的默认实现：

```typescript
// platform/feedback/feedbackState.ts

export const feedbackSink: FeedbackSink = {
  showLoading(show: boolean) {
    // 实现加载状态显示
    // 可以连接到全局 loading store
  },
  
  showMessage(message, type = 'info', duration) {
    // 实现消息提示
    // 可以使用 Toast 组件或其他 UI 组件
  }
}
```

---

## HTTP 基础设施

**位置**: `src/platform/http/errors.ts`

### 核心功能

- 定义 HTTP 错误类型
- 提供错误识别工具
- 统一错误处理基础

### 错误类型

#### AuthExpiredError

认证过期错误，继承自 Error。

```typescript
export class AuthExpiredError extends Error {
  status = 401
  code = 'AUTH_EXPIRED'
  
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'AuthExpiredError'
  }
}
```

### 错误识别

```typescript
// 判断是否为认证过期错误
error instanceof AuthExpiredError

// 判断是否为认证相关错误
isAuthRequiredError(error)
```

---

## 使用示例

### 完整初始化流程

```typescript
// main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// 平台层
import { setAuthExpiredListener } from '@/platform/auth/session'
import { setFeedbackSink } from '@/platform/feedback/feedbackBus'
import { feedbackSink } from '@/platform/feedback/feedbackState'

// Store
import { useAuthStore } from '@/stores/auth'

const app = createApp(App)
const pinia = createPinia()

// 初始化平台层
setFeedbackSink(feedbackSink)

setAuthExpiredListener(() => {
  const authStore = useAuthStore(pinia)
  authStore.logout()
  
  const currentRoute = router.currentRoute.value
  if (currentRoute.name !== 'Login') {
    router.replace({
      name: 'Login',
      query: { redirect: currentRoute.fullPath }
    })
  }
})

app.use(pinia)
app.use(router)
app.mount('#app')
```

### API 层集成

```typescript
// api/request.ts
import { notifyAuthExpired, AuthExpiredError } from '@/platform/auth/session'
import { showMessage } from '@/platform/feedback/feedbackBus'

export async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (response.status === 401) {
      const error = new AuthExpiredError()
      notifyAuthExpired({ 
        source: 'apiFetch',
        requestUrl: url,
        error 
      })
      throw error
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return response.json()
  } catch (error) {
    showMessage('请求失败', 'error')
    throw error
  }
}
```

### 组件中使用

```vue
<template>
  <div>
    <button @click="handleSubmit">提交</button>
  </div>
</template>

<script setup lang="ts">
import { showMessage, showLoading } from '@/platform/feedback/feedbackBus'

async function handleSubmit() {
  showLoading(true)
  
  try {
    await submitForm()
    showMessage('提交成功！', 'success')
  } catch (error) {
    showMessage('提交失败', 'error')
  } finally {
    showLoading(false)
  }
}
</script>
```

---

## 扩展指南

### 自定义反馈实现

可以替换默认的 `feedbackSink` 实现：

```typescript
// customFeedback.ts
import { setFeedbackSink, type FeedbackSink } from '@/platform/feedback/feedbackBus'

const customSink: FeedbackSink = {
  showLoading(show) {
    // 自定义加载实现
    // 例如：使用 Element Plus 的 Loading 服务
  },
  
  showMessage(message, type, duration) {
    // 自定义消息实现
    // 例如：使用 Element Plus 的 Message 组件
    ElMessage({
      message,
      type,
      duration
    })
  }
}

// 在 main.ts 中设置
setFeedbackSink(customSink)
```

### 自定义认证处理

可以实现不同的认证过期处理逻辑：

```typescript
setAuthExpiredListener((event) => {
  // 记录日志
  console.error('Auth expired:', event)
  
  // 刷新 Token 尝试
  refreshToken().then(success => {
    if (!success) {
      // 刷新失败，跳转登录
      redirectToLogin()
    }
  })
})
```

### 添加新的错误类型

```typescript
// platform/http/errors.ts

export class NetworkError extends Error {
  code = 'NETWORK_ERROR'
  
  constructor(message = 'Network Error') {
    super(message)
    this.name = 'NetworkError'
  }
}

export class TimeoutError extends Error {
  code = 'TIMEOUT_ERROR'
  
  constructor(message = 'Request Timeout') {
    super(message)
    this.name = 'TimeoutError'
  }
}

// 在 API 层使用
if (error.name === 'AbortError') {
  throw new TimeoutError()
}
```

---

## 相关文档

- [架构总览](ARCHITECTURE.md) - 平台层在整体架构中的位置
- [API层](API_LAYER.md) - 如何使用平台层的基础设施
- [路由系统](ROUTING.md) - 认证与路由守卫的集成

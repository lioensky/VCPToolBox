# AdminPanel-Vue API层

本文档详细说明 AdminPanel-Vue 的 API 层设计，包括架构设计、模块划分、错误处理和类型定义。

## 目录

- [架构概览](#架构概览)
- [目录结构](#目录结构)
- [API客户端](#api客户端)
- [模块划分](#模块划分)
- [类型定义](#类型定义)
- [错误处理](#错误处理)
- [使用示例](#使用示例)
- [添加新API](#添加新api)

---

## 架构概览

API 层采用**按业务域拆分**的设计，每个模块对应后端的一个业务领域。

```
┌─────────────────────────────────────────────────────────────┐
│                      API Layer                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  authApi    │  │  diaryApi   │  │ systemApi   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  agentApi   │  │  pluginApi  │  │  ragApi     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     HTTP Client                             │
│                  (utils/api.ts)                             │
│              - 统一的请求封装                                │
│              - 拦截器处理                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend API                              │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **业务域拆分** - 按后端业务模块组织 API
2. **统一出口** - 通过 `index.ts` 统一导出
3. **类型安全** - 完整的请求/响应类型定义
4. **错误统一** - 集中处理 HTTP 错误

---

## 目录结构

```
api/
├── index.ts              # 统一导出入口
├── auth.ts               # 认证相关 API
├── agent.ts              # Agent 管理 API
├── diary.ts              # 日记管理 API
├── dream.ts              # 梦境管理 API
├── forum.ts              # 论坛 API
├── admin-config.ts       # 全局配置 API
├── media-cache.ts        # 多媒体缓存 API
├── newapi-monitor.ts     # API 监控 API
├── news.ts               # 新闻 API
├── placeholder.ts        # 占位符 API
├── plugin.ts             # 插件管理 API
├── rag.ts                # RAG 系统 API
├── schedule.ts           # 日程管理 API
├── system.ts             # 系统监控 API
├── toolbox.ts            # Toolbox API
├── toolList.ts           # 工具列表 API
├── tvs.ts                # TVS 变量 API
├── vcptavern.ts          # VCPTavern API
└── weather.ts            # 天气 API
```

---

## API 客户端

**位置**: `src/utils/api.ts`

### 核心功能

- 统一的请求封装
- 基础 URL 配置
- 默认请求头
- 401 错误处理

### 核心函数

#### apiFetch

基础请求函数，封装了 fetch API。

```typescript
export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T>
```

**特点**:
- 自动添加 `/admin_api` 前缀
- 自动添加 `Content-Type: application/json`
- 401 错误自动触发认证过期通知
- JSON 响应自动解析

**使用示例**:
```typescript
const data = await apiFetch<User[]>('/api/users')
const user = await apiFetch<User>('/api/users/1')
```

### 配置说明

```typescript
// utils/api.ts

const API_BASE = '/admin_api'

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',  // 携带 Cookie
  })
  
  // 401 处理
  if (response.status === 401) {
    notifyAuthExpired({ source: 'apiFetch', requestUrl: url })
    throw new AuthExpiredError()
  }
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  
  return response.json()
}
```

---

## 模块划分

每个 API 模块对应一个业务领域，提供该领域的所有接口。

### 认证模块 (auth.ts)

```typescript
export const authApi = {
  // 登录
  async login(credentials: LoginCredentials): Promise<LoginResponse>
  
  // 登出
  async logout(): Promise<void>
  
  // 检查认证状态
  async checkAuthStatus(): Promise<boolean>
  
  // 获取当前用户信息
  async getCurrentUserInfo(): Promise<UserProfile | null>
}
```

### 日记模块 (diary.ts)

```typescript
export const diaryApi = {
  // 获取文件夹列表
  async getFolders(): Promise<Folder[]>
  
  // 获取日记列表
  async getDiaryList(folder?: string): Promise<Note[]>
  
  // 获取日记内容
  async getDiaryContent(file: string): Promise<string>
  
  // 保存日记
  async saveDiary(file: string, content: string): Promise<void>
  
  // 删除日记
  async deleteDiary(file: string): Promise<void>
}
```

### 系统监控模块 (system.ts)

```typescript
export const systemApi = {
  // 获取系统资源
  async getSystemResources(): Promise<SystemResources>
  
  // 获取 PM2 进程列表
  async getPM2Processes(): Promise<PM2Process[]>
  
  // 获取系统日志
  async getSystemLogs(lines?: number): Promise<string[]>
}
```

### Agent 模块 (agent.ts)

```typescript
export const agentApi = {
  // 获取 Agent 映射
  async getAgentMap(): Promise<AgentMapEntry[]>
  
  // 获取 Agent 文件内容
  async getAgentFile(name: string): Promise<string>
  
  // 保存 Agent 文件
  async saveAgentFile(name: string, content: string): Promise<void>
  
  // 获取 Agent 助手配置
  async getAgentAssistantConfig(): Promise<AgentAssistantConfig>
  
  // 保存 Agent 助手配置
  async saveAgentAssistantConfig(config: AgentAssistantConfig): Promise<void>
  
  // 获取 Agent 积分
  async getAgentScores(): Promise<AgentScore[]>
}
```

### 插件模块 (plugin.ts)

```typescript
export const pluginApi = {
  // 获取插件列表
  async getPlugins(enabledOnly?: boolean): Promise<PluginInfo[]>
  
  // 获取插件配置
  async getPluginConfig(pluginName: string): Promise<PluginConfig>
  
  // 保存插件配置
  async savePluginConfig(
    pluginName: string, 
    config: PluginConfig
  ): Promise<void>
  
  // 启用/禁用插件
  async togglePlugin(pluginName: string, enabled: boolean): Promise<void>
}
```

---

## 类型定义

### 响应类型

```typescript
// types/api.common.ts

// 通用 API 响应
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// 分页响应
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// 分页参数
export interface PaginationParams {
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}
```

### 认证类型

```typescript
// types/api.auth.ts

export interface LoginCredentials {
  username: string
  password: string
}

export interface LoginResponse {
  success: boolean
  message?: string
  token?: string
}

export interface UserProfile {
  username: string
  role?: string
  avatar?: string
}
```

### 业务类型

```typescript
// types/index.ts

// Agent 相关
export interface AgentMapEntry {
  name: string
  file: string
}

export interface AgentAssistantConfig {
  maxHistoryRounds: number
  contextTtlHours: number
  globalSystemPrompt: string
  agents: Array<{
    baseName: string
    chineseName: string
    modelId: string
    description: string
    systemPrompt: string
    maxOutputTokens: number
    temperature: number
  }>
}

// 日记相关
export interface Note {
  file: string
  title?: string
  modified: string
  content?: string
  preview?: string
}

export interface Folder {
  name: string
  path: string
  noteCount?: number
}
```

---

## 错误处理

### 错误分类

| 错误类型 | HTTP 状态码 | 处理方式 |
|----------|-------------|----------|
| 认证过期 | 401 | 触发认证过期通知，跳转登录页 |
| 权限不足 | 403 | 显示错误消息，可选跳转 |
| 资源不存在 | 404 | 显示错误消息 |
| 服务器错误 | 500+ | 显示错误消息，记录日志 |
| 网络错误 | - | 重试或显示错误消息 |

### 统一错误处理

```typescript
// utils/api.ts

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(url, config)
    
    if (response.status === 401) {
      notifyAuthExpired({ source: 'apiFetch', requestUrl: url })
      throw new AuthExpiredError()
    }
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new ApiError(
        error.message || `HTTP ${response.status}`,
        response.status
      )
    }
    
    return response.json()
  } catch (error) {
    // 网络错误处理
    if (error instanceof TypeError) {
      throw new NetworkError('网络连接失败')
    }
    throw error
  }
}
```

### API 层错误处理

```typescript
// api/diary.ts

export const diaryApi = {
  async getDiaryList(folder?: string): Promise<Note[]> {
    try {
      const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
      return await apiFetch<Note[]>(`/api/diary${params}`)
    } catch (error) {
      // 可以在这里进行特定错误处理
      showMessage('获取日记列表失败', 'error')
      throw error  // 继续抛出供上层处理
    }
  }
}
```

### Store 层错误处理

```typescript
// stores/diary.ts

export const useDiaryStore = defineStore('diary', () => {
  const error = ref<string | null>(null)
  
  async function loadDiaryList(folder?: string) {
    error.value = null
    
    try {
      diaries.value = await diaryApi.getDiaryList(folder)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载失败'
      // 不再显示消息，由 UI 层决定如何处理
    }
  }
})
```

---

## 使用示例

### 基础使用

```typescript
import { diaryApi } from '@/api'

// 获取日记列表
const diaries = await diaryApi.getDiaryList()

// 获取指定文件夹的日记
const diaries = await diaryApi.getDiaryList('folder1')
```

### 在组合式函数中使用

```typescript
// composables/useDiary.ts
import { diaryApi } from '@/api'
import type { Note } from '@/types'

export function useDiary(folder?: string) {
  const diaries = ref<Note[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  
  async function loadDiaries() {
    isLoading.value = true
    error.value = null
    
    try {
      diaries.value = await diaryApi.getDiaryList(folder)
    } catch (err) {
      error.value = '加载失败'
    } finally {
      isLoading.value = false
    }
  }
  
  return { diaries, isLoading, error, loadDiaries }
}
```

### 在 Store 中使用

```typescript
// stores/diary.ts
import { defineStore } from 'pinia'
import { diaryApi } from '@/api'

export const useDiaryStore = defineStore('diary', () => {
  const diaries = ref<Note[]>([])
  const currentFolder = ref<string>('')
  
  async function fetchDiaries() {
    diaries.value = await diaryApi.getDiaryList(currentFolder.value)
  }
  
  return { diaries, currentFolder, fetchDiaries }
})
```

### 批量请求

```typescript
import { systemApi, weatherApi, newsApi } from '@/api'

// 并行请求
const [system, weather, news] = await Promise.all([
  systemApi.getSystemResources(),
  weatherApi.getWeather(),
  newsApi.getNews()
])
```

---

## 添加新API

### 步骤 1：定义类型

在 `src/types/` 中添加相关类型：

```typescript
// types/index.ts

export interface NewEntity {
  id: string
  name: string
  // ... 其他字段
}

export interface CreateNewEntityRequest {
  name: string
}
```

### 步骤 2：创建 API 模块

创建 `src/api/newModule.ts`：

```typescript
import { apiFetch } from '@/utils/api'
import type { NewEntity, CreateNewEntityRequest } from '@/types'

export const newModuleApi = {
  // 获取列表
  async getList(): Promise<NewEntity[]> {
    return apiFetch<NewEntity[]>('/api/new-module')
  },
  
  // 获取详情
  async getById(id: string): Promise<NewEntity> {
    return apiFetch<NewEntity>(`/api/new-module/${id}`)
  },
  
  // 创建
  async create(data: CreateNewEntityRequest): Promise<NewEntity> {
    return apiFetch<NewEntity>('/api/new-module', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  
  // 更新
  async update(id: string, data: Partial<CreateNewEntityRequest>): Promise<NewEntity> {
    return apiFetch<NewEntity>(`/api/new-module/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  
  // 删除
  async delete(id: string): Promise<void> {
    return apiFetch<void>(`/api/new-module/${id}`, {
      method: 'DELETE'
    })
  }
}
```

### 步骤 3：导出 API

在 `src/api/index.ts` 中添加导出：

```typescript
export { newModuleApi } from './newModule'
export type * from './newModule'
```

### 步骤 4：使用新 API

```typescript
import { newModuleApi } from '@/api'

// 使用
const list = await newModuleApi.getList()
const item = await newModuleApi.create({ name: 'New Item' })
```

---

## 最佳实践

### 1. 命名规范

```typescript
// ✅ 推荐
export const diaryApi = { ... }
export const agentApi = { ... }

// ❌ 避免
export const DiaryAPI = { ... }
export const diaryAPI = { ... }
```

### 2. 函数命名

```typescript
// ✅ 推荐
async function getDiaryList()
async function getDiaryById()
async function createDiary()
async function updateDiary()
async function deleteDiary()

// ❌ 避免
async function getList()  // 太泛
async function diaryList()  // 非动词开头
```

### 3. 类型导出

```typescript
// ✅ 推荐
export type { Diary, CreateDiaryRequest } from '@/types'

// 同时在 api/index.ts 中统一导出
export type * from './diary'
```

### 4. 错误处理

```typescript
// ✅ 推荐
async function getDiaryList() {
  try {
    return await apiFetch('/api/diary')
  } catch (error) {
    // 记录日志
    console.error('Failed to get diary list:', error)
    // 继续抛出
    throw error
  }
}

// ❌ 避免 - 吞掉错误
async function getDiaryList() {
  try {
    return await apiFetch('/api/diary')
  } catch (error) {
    return []  // 错误被吞掉
  }
}
```

### 5. URL 构建

```typescript
// ✅ 推荐
const params = new URLSearchParams()
if (folder) params.append('folder', folder)
const query = params.toString()
const url = `/api/diary${query ? `?${query}` : ''}`

// ❌ 避免
const url = `/api/diary?folder=${folder}`  // 未编码
```

---

## 相关文档

- [架构总览](ARCHITECTURE.md) - API 层在整体架构中的位置
- [平台层](PLATFORM.md) - HTTP 基础设施和错误处理
- [状态管理](STATE_MANAGEMENT.md) - 在 Store 中使用 API

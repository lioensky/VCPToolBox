# AdminPanel-Vue 架构收敛执行文档（V1）

## 1. 目标
将 AdminPanel-Vue 收敛为 6 层前端系统，并采用“先最小改造、后批量迁移”的策略：

1. Shell
2. Routing
3. Feature
4. Domain/Data
5. Platform
6. Legacy Bridge

核心原则：
- 单一真相源
- 副作用上移
- 领域按 feature 收口
- 遗留入口显式隔离

## 2. 本次交付范围
本次为第一批可落地改造，优先处理高耦合高风险点。

### 2.1 最小改造（本次必须完成）
- 新增纯 Transport 层：`src/platform/http/*`
- 保持原有 `apiFetch` 不删除，作为兼容层继续存在
- 将以下 API 模块迁移到纯 Transport：
  - `src/api/auth.ts`
  - `src/api/forum.ts`
  - `src/api/newapi-monitor.ts`
- 保持对外函数签名尽量不变（尤其是可选 `uiOptions` 参数），避免页面层大规模改动
- 同步更新单元测试，验证迁移后行为不回退

### 2.2 兼容点（本次保留）
- `src/utils/api.ts` 仍保留 UI 副作用（loading/toast/401 跳转），用于未迁移模块
- `src/utils/ui.ts` 仍通过 DOM id 驱动反馈
- `src/composables/useMainLayoutState.ts` 仍含 DOM 监听与 body 样式控制
- `store` 中仍允许历史 `showMessage/confirm` 逻辑存在，待后续批次迁移

### 2.3 可一次性交付（无需最小化拆分）
以下改动面小、风险低、收益明确，可在单批完成：
- `forumApi` 返回体归一化与输入校验
- `newApiMonitorApi` 的 Envelope 解析与错误统一
- `authApi` 的 404 回退策略保持并显式化

## 3. 后续批次（未在本次完成）
- 批次 2（已完成）：Feedback Provider + Bus，替换 `showMessage/showLoading`
- 批次 3（已完成）：Auth Session 单向化（401 仅抛错，AppShell 统一跳转）
- 批次 4（已完成）：Layout 拆壳（`useMainLayoutState` -> shell/browser composables）
- 批次 5（已完成）：Routing 全量收口（移除多余路由常量层）
- 批次 6（已完成）：Feature 目录迁移 + 契约测试补齐 + 收口验收
- 批次 7（进行中）：Legacy 入口隔离（`/AdminPanelLegacy`）
  - 阶段 A（已完成）：Legacy Bridge 工程护栏（bridge 清单 + 隔离守卫测试）
  - 阶段 B（已完成）：Legacy 入口规范化（legacy 路径自动收敛到 canonical 路径）
  - 阶段 C（已完成）：桥接文件废弃标记与守卫测试加严

## 4. 执行清单（本次）
- [x] 新建 `src/platform/http/errors.ts`
- [x] 新建 `src/platform/http/httpClient.ts`
- [x] 迁移 `src/api/auth.ts`
- [x] 迁移 `src/api/forum.ts`
- [x] 迁移 `src/api/newapi-monitor.ts`
- [x] 更新 `tests/stores/authApi.test.ts`
- [x] 更新 `tests/stores/forumApi.test.ts`
- [x] 更新 `tests/composables/newApiMonitorApi.test.ts`
- [x] 运行并通过相关测试
- [x] 回填本文档“完成状态”和“剩余兼容点”

## 5. 验收标准（本次）
- 迁移后的 3 个 API 模块不再依赖 `showMessage/showLoading/router` 跳转副作用
- 行为向后兼容：调用方式、主要返回语义、错误语义不破坏现有页面
- 单元测试覆盖迁移后的核心路径：
  - auth：404 fallback / 登录错误映射
  - forum：帖子与详情归一化 / 回复参数校验
  - monitor：envelope 解析 / 降级聚合

---

## 6. 本次完成状态（施工后回填）
- 状态：`已完成（第一批最小改造）`
- 完成项：
  - 已新增 `src/platform/http/errors.ts` 与 `src/platform/http/httpClient.ts`，形成纯 Transport 基础层
  - 已完成 `src/api/auth.ts` 迁移，保留 404 -> verify-login 回退策略
  - 已完成 `src/api/forum.ts` 迁移，并补齐：
    - envelope 兼容解析（`{ success, data }` 与直接 payload）
    - 帖子列表归一化过滤
    - 回复参数校验与标准化（trim + 空值拦截）
  - 已完成 `src/api/newapi-monitor.ts` 迁移，统一 envelope 解析与错误归一
  - 已同步更新并通过测试：
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - 结果：3 文件通过，11 用例通过
- 未完成项：
  - 批次 3 及以后改造（Auth Session 单向化、Layout 拆壳、Routing 全量收口、Legacy 入口隔离）
- 剩余兼容点：
  - `src/utils/api.ts` 仍保留兼容入口；内部已改为通过反馈总线分发反馈事件
  - `src/utils/ui.ts` 仍作为兼容包装存在（内部已改为调用反馈总线）
  - `src/composables/useMainLayoutState.ts` 的 DOM 监听与 body 样式控制未改动
  - `store` 内历史 UI 副作用逻辑仍保留

## 7. 增量进展（批次 2 / 阶段 A）
- 状态：`已完成`
- 目标：先将请求层从“直接 UI 调用”切换为“反馈总线调用”，保留现有页面行为。
- 完成项：
  - 新增 `src/platform/feedback/feedbackBus.ts`，定义 `FeedbackSink` 与 `feedbackBus`
  - `src/utils/api.ts` 已改为通过 `feedbackBus.showLoading/showMessage` 分发反馈
  - `src/utils/index.ts` 的 `showLoading/showMessage` 导出已切换到 feedback bus
  - `src/main.ts` 注入默认 sink（桥接到 `src/utils/ui.ts` 的现有实现）
- 验证结果：
  - 已通过回归测试：
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
    - 结果：4 文件通过，13 用例通过
- 下一步（批次 2 / 阶段 B）：
  - 已完成：在页面/composable/store 侧通过 `@/utils` 导出收口 `showMessage/showLoading` 到反馈总线
  - 已完成：引入统一反馈 provider 组件，替换对 DOM id 的隐式依赖

## 8. 增量进展（批次 2 / 阶段 B）
- 状态：`已完成`
- 完成项：
  - 新增 `src/platform/feedback/feedbackState.ts`，提供响应式反馈状态与默认 sink
  - 新增 `src/components/feedback/FeedbackHost.vue`，统一渲染 loading overlay 与 message popup
  - `src/layouts/MainLayout.vue` 已移除历史 `loading-overlay` / `message-popup` DOM 容器，改为挂载 `FeedbackHost`
  - `src/main.ts` 已将默认 sink 切换为 `feedbackState`，不再依赖 `utils/ui.ts` 的 DOM 实现
  - `src/utils/ui.ts` 已改为 feedback bus 兼容包装
- 验证结果：
  - 已通过回归测试：
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
    - 结果：4 文件通过，13 用例通过

## 9. 增量进展（批次 3：Auth Session 单向化）
- 状态：`已完成`
- 目标：401 在请求层仅抛错/上报，不直接触发路由副作用；登录跳转统一收口到 App Shell。
- 完成项：
  - 新增 `src/platform/auth/session.ts`：
    - 认证失效事件通道（`notifyAuthExpired`）
    - 事件监听注入（`setAuthExpiredListener`）
    - 401 错误识别工具（`isAuthRequiredError`）
    - 短窗口去重，避免并发请求导致重复跳转
  - `src/platform/http/httpClient.ts`：
    - 401 分支改为“上报认证失效事件 + 抛 `AuthExpiredError`”
  - `src/utils/api.ts`：
    - 移除直接 `redirectToLogin` 副作用
    - 401 分支改为“上报认证失效事件 + 抛 `AUTH_REQUIRED` 错误”
  - `src/main.ts`：
    - 在壳层注册统一认证失效处理器
    - 统一执行 `authStore.logout()` 与 `router.replace({ name: 'Login' })`
- 验证项：
  - 新增 `tests/utils/authSession.test.ts`，覆盖认证失效事件去重与错误识别
  - 保留并回归第一批/第二批关键测试，确保无行为回退

## 10. 增量进展（批次 4 / 阶段 A：MainLayout 壳层副作用拆分）
- 状态：`已完成（阶段 A）`
- 目标：将 MainLayout 的 DOM 生命周期副作用从状态 composable 中拆出，保持状态层纯度并维持现有行为。
- 完成项：
  - 新增 `src/app/shell/useMainLayoutShellEffects.ts`，集中承接：
    - 文档/键盘/点击外部事件监听
    - `contentRef` 滚动监听绑定与解绑
    - `.brand` 点击监听绑定与解绑
    - body overflow 初始化与恢复
    - 沉浸模式 DOM 状态切换（`ui-hidden-immersive` + overflow）
    - 主题恢复与插件导航初始化
  - `src/composables/useMainLayoutState.ts`：
    - 删除直接 DOM 操作与 onMounted/onUnmounted 副作用逻辑
    - 改为调用 shell composable 暴露的 DOM 控制方法
  - `src/layouts/MainLayout.vue`：
    - 修复样式区误混入模板片段导致的 `.sidebar-overlay` 规则损坏
- 验证结果：
  - 通过回归测试：
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：6 文件通过，19 用例通过

## 11. 增量进展（批次 4 / 阶段 B：路由与沉浸触发副作用下沉）
- 状态：`已完成（阶段 B）`
- 目标：继续减少 `useMainLayoutState` 中的“浏览器/壳层策略”代码，将路由变化副作用与品牌连击触发逻辑下沉到 shell 层。
- 完成项：
  - `src/app/shell/useMainLayoutShellEffects.ts`：
    - 新增路由监听入口（`getRouteFullPath` + `onRouteChanged`），统一处理路由切换后的 UI 收敛与内容区滚动复位
    - 将品牌连击计数与定时器下沉到 shell，达到阈值后回调 `onEnterImmersiveMode`
    - 卸载阶段统一清理品牌点击监听与连击定时器
  - `src/composables/useMainLayoutState.ts`：
    - 删除路由 watch 与品牌连击计时逻辑
    - 仅保留状态与动作编排，并通过 shell 回调承接副作用
- 验证结果：
  - 通过回归测试：
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：6 文件通过，19 用例通过

## 12. 增量进展（批次 5 / 阶段 A：活跃路由入口收口）
- 状态：`已完成（阶段 A）`
- 目标：将活跃业务代码从 `constants/routes` 兼容层切换到 `app/routes` 清单与统一 base 能力，降低路由双源维护风险。
- 完成项：
  - 新增 `src/app/routes/base.ts`：
    - `APP_ROUTER_BASE` 统一路由基路径
    - `stripAppRouterBase` 提供路径归一化工具
  - `src/router/index.ts`：
    - `login/dashboard` 路径与重定向回退改为 `getAppRoutePath(...)`
    - `createWebHistory` 改为使用 `APP_ROUTER_BASE`
  - `src/main.ts`：
    - 认证失效回退目标改为 `getAppRoutePath('dashboard')`
  - `src/views/Login.vue`：
    - 登录成功回跳兜底路径改为 `getAppRoutePath('dashboard')`
  - `src/utils/auth.ts`：
    - 登录页 URL 回退改为 `APP_ROUTER_BASE + getAppRoutePath('login')`
  - `src/components/layout/Sidebar.vue`：
    - 移除 `/AdminPanel` 魔法字符串，改用 `stripAppRouterBase(route.path)`
  - `src/constants/routes.ts`：
    - 保留兼容导出，但 BASE 来源改为 `APP_ROUTER_BASE`，减少基路径漂移风险
- 验证结果：
  - 回归测试通过：
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：7 文件通过，26 用例通过

## 13. 增量进展（批次 5 / 阶段 B：Redirect 解析统一）
- 状态：`已完成（阶段 B）`
- 目标：统一登录回跳与路由守卫中的 redirect 安全校验逻辑，避免重复实现导致语义漂移。
- 完成项：
  - 新增 `src/app/routes/redirect.ts`：
    - `resolveSafeAppRedirect(router, target, fallback)` 统一校验 redirect
  - `src/router/index.ts`：
    - 登录页守卫分支与受保护页回退分支统一调用 `resolveSafeAppRedirect`
  - `src/views/Login.vue`：
    - 登录成功后的 redirect 解析改为调用统一函数
  - `tests/utils/navigation.test.ts`：
    - 新增 `resolveSafeAppRedirect` 行为测试（有效路径、登录页路径、未知路径、非法输入）
- 验证结果：
  - 回归测试通过：
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：7 文件通过，27 用例通过

  ## 14. 增量进展（批次 5 / 阶段 C：路由常量层彻底下线）
  - 状态：`已完成（阶段 C）`
  - 目标：彻底移除 `src/constants/routes.ts`，完成 Routing 层单一真相源收口。
  - 完成项：
    - 删除 `src/constants/routes.ts`
    - 确认活跃源码无 `@/constants/routes` 依赖（路由路径/标题/base 均已迁移到 `src/app/routes/*`）
    - 路由基路径和 redirect 安全解析由以下模块统一承担：
      - `src/app/routes/base.ts`
      - `src/app/routes/manifest.ts`
      - `src/app/routes/redirect.ts`
  - 验证结果：
    - 语言服务全量检查 `src/` 无报错
    - 回归测试通过：
      - `tests/utils/navigation.test.ts`
      - `tests/composables/useMainLayoutState.test.ts`
      - `tests/utils/authSession.test.ts`
      - `tests/stores/authApi.test.ts`
      - `tests/stores/forumApi.test.ts`
      - `tests/composables/newApiMonitorApi.test.ts`
      - `tests/composables/useDashboardState.test.ts`
    - 结果：7 文件通过，27 用例通过

  ## 15. 增量进展（批次 6 / 阶段 A：VcpForum Feature 迁移模板）
  - 状态：`已完成（阶段 A）`
  - 目标：建立“先迁移业务逻辑与领域类型，再保留兼容入口”的 feature 迁移模板，并补齐契约测试。
  - 完成项：
    - 新增 `src/features/vcp-forum/types.ts`（论坛领域类型）
    - 新增 `src/features/vcp-forum/useVcpForum.ts`（论坛业务 composable）
    - 视图层接入迁移：
      - `src/views/VcpForum.vue` 改为直接引用 feature composable
    - 领域依赖收口：
      - `src/api/forum.ts` 类型依赖改为 `src/features/vcp-forum/types.ts`
    - 兼容桥接保留：
      - `src/views/VcpForum/useVcpForum.ts` 改为 re-export
      - `src/views/VcpForum/types.ts` 改为 type re-export
    - 契约测试补齐：
      - `tests/composables/useVcpForum.test.ts` 增加“导出面契约”断言
  - 预期收益：
    - 论坛 feature 的业务层与类型层不再绑定 `views` 目录
    - 后续迁移 Placeholder/ToolList 等 feature 可复用同一策略

## 16. 增量进展（批次 6 / 阶段 B：ToolList Feature 迁移模板）
- 状态：`已完成（阶段 B）`
- 目标：将 ToolList 的领域类型与业务 composable 从 `views` 目录迁移到 `features` 目录，并通过兼容桥接保证最小改造落地。
- 完成项：
  - 新增 `src/features/tool-list/types.ts`（ToolList 领域类型）
  - 新增 `src/features/tool-list/useToolListEditor.ts`（ToolList 业务 composable）
  - 视图层接入迁移：
    - `src/views/ToolListEditor.vue` 改为直接引用 feature composable
  - 领域依赖收口：
    - `src/api/toolList.ts` 类型依赖改为 `src/features/tool-list/types.ts`
  - 兼容桥接保留：
    - `src/views/ToolListEditor/useToolListEditor.ts` 改为 re-export
    - `src/views/ToolListEditor/types.ts` 改为 type re-export
  - 契约测试补齐：
    - `tests/composables/useToolListEditor.test.ts` 增加“导出面契约”断言
- 兼容点与最小改造说明：
  - 保留 `src/views/ToolListEditor/*` 的兼容导出，避免存量导入路径在同批次内失效
  - 仅将消费端入口切换至 `src/features/tool-list/*`，未变更 API 结构与页面行为
  - API 与视图之间通过 feature 类型层解耦，减少后续迁移连锁改动范围
- 验证结果：
  - 语言服务检查：批次 6 阶段 B 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：9 文件通过，33 用例通过

## 17. 增量进展（批次 6 / 阶段 C：PlaceholderViewer Feature 迁移模板）
- 状态：`已完成（阶段 C）`
- 目标：将 PlaceholderViewer 的领域类型与业务 composable 从 `views` 目录迁移到 `features` 目录，延续批次 6 的低风险迁移模板。
- 完成项：
  - 新增 `src/features/placeholder-viewer/types.ts`（Placeholder 领域类型）
  - 新增 `src/features/placeholder-viewer/usePlaceholderViewer.ts`（Placeholder 业务 composable）
  - 视图层接入迁移：
    - `src/views/PlaceholderViewer.vue` 改为直接引用 feature composable
  - 领域依赖收口：
    - `src/api/placeholder.ts` 类型依赖改为 `src/features/placeholder-viewer/types.ts`
  - 兼容桥接保留：
    - `src/views/PlaceholderViewer/usePlaceholderViewer.ts` 改为 re-export
    - `src/views/PlaceholderViewer/types.ts` 改为 type re-export
  - 契约测试补齐：
    - `tests/composables/usePlaceholderViewer.test.ts` 增加“导出面契约”断言
- 兼容点与最小改造说明：
  - 保留 `src/views/PlaceholderViewer/*` 的兼容导出，避免存量导入路径在同批次内失效
  - 仅将消费端入口切换至 `src/features/placeholder-viewer/*`，不改 API 协议与页面交互语义
  - 通过 feature 类型层承接 API 与视图之间的类型依赖，缩小后续迁移影响面
- 验证结果：
  - 语言服务检查：批次 6 阶段 C 相关文件无报错
  - 回归测试通过：
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：10 文件通过，36 用例通过

## 18. 增量进展（批次 6 / 阶段 D：AgentFilesEditor 一次性迁移）
- 状态：`已完成（阶段 D）`
- 目标：按批次 6 模板一次性完成 AgentFilesEditor 的 feature 迁移，确保“迁移实现 + 兼容桥接 + 契约测试 + 回归验证”同批次闭环。
- 完成项：
  - 新增 `src/features/agent-files-editor/types.ts`（AgentFilesEditor 领域类型）
  - 新增 `src/features/agent-files-editor/useAgentFilesEditor.ts`（AgentFilesEditor 业务 composable）
  - 视图层接入迁移：
    - `src/views/AgentFilesEditor.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/AgentFilesEditor/useAgentFilesEditor.ts` 改为 re-export
  - 契约测试补齐：
    - `tests/composables/useAgentFilesEditor.test.ts` 增加“导出面契约”断言
- 兼容点与最小改造说明：
  - 保留 `src/views/AgentFilesEditor/useAgentFilesEditor.ts` 作为兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/agent-files-editor/*`，未修改接口协议与页面交互行为
  - 迁移后类型定义独立到 feature 层，降低后续 API-View 调整的耦合范围
- 验证结果：
  - 语言服务检查：批次 6 阶段 D 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：11 文件通过，40 用例通过

## 19. 增量进展（批次 6 / 阶段 E：PreprocessorOrderManager 一次性迁移）
- 状态：`已完成（阶段 E）`
- 目标：按批次 6 模板一次性完成 PreprocessorOrderManager 的 feature 迁移，并修复拖拽测试契约缺口，保证迁移后回归可稳定通过。
- 完成项：
  - 新增 `src/features/preprocessor-order-manager/types.ts`（预处理器排序领域类型）
  - 新增 `src/features/preprocessor-order-manager/usePreprocessorOrderManager.ts`（预处理器排序业务 composable）
  - 视图层接入迁移：
    - `src/views/PreprocessorOrderManager.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/PreprocessorOrderManager/usePreprocessorOrderManager.ts` 改为 re-export
  - 契约测试补齐：
    - `tests/composables/usePreprocessorOrderManager.test.ts` 增加“导出面契约”断言
  - 拖拽会话兼容修复：
    - `src/composables/usePointerDragSession.ts` 补充导出 `handlePointerMove` / `handlePointerUp` / `handlePointerCancel`
    - 使 PreprocessorOrderManager 拖拽测试场景可通过显式事件驱动完成验证
- 兼容点与最小改造说明：
  - 保留 `src/views/PreprocessorOrderManager/usePreprocessorOrderManager.ts` 作为兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/preprocessor-order-manager/*`，未修改后端接口协议与页面行为
  - 指针事件导出属于向后兼容增强，不改变现有拖拽交互语义
- 验证结果：
  - 语言服务检查：批次 6 阶段 E 相关文件无报错
  - 回归测试通过：
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：12 文件通过，44 用例通过

## 20. 增量进展（批次 6 / 阶段 F：ServerLogViewer 一次性迁移）
- 状态：`已完成（阶段 F）`
- 目标：按批次 6 模板一次性完成 ServerLogViewer 的 feature 迁移，确保业务逻辑从 `views` 目录收口到 `features` 并保持兼容导出。
- 完成项：
  - 新增 `src/features/server-log-viewer/useServerLogViewer.ts`（日志查看业务 composable）
  - 视图层接入迁移：
    - `src/views/ServerLogViewer.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/ServerLogViewer/useServerLogViewer.ts` 改为 re-export
  - 契约测试补齐：
    - `tests/composables/useServerLogViewer.test.ts` 增加“导出面契约”断言
- 兼容点与最小改造说明：
  - 保留 `src/views/ServerLogViewer/useServerLogViewer.ts` 作为兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/server-log-viewer/*`，不改日志 API 协议与页面交互语义
  - 迁移过程中不改模板结构与样式，仅收口业务实现所在层级
- 验证结果：
  - 语言服务检查：批次 6 阶段 F 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useServerLogViewer.test.ts`
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：13 文件通过，48 用例通过

## 21. 增量进展（批次 6 / 阶段 G：ThinkingChainsEditor 一次性迁移）
- 状态：`已完成（阶段 G）`
- 目标：按批次 6 模板一次性完成 ThinkingChainsEditor 的 feature 迁移，并同步收口排序 helper，确保业务逻辑与拖拽规则从 `views` 层迁移到 `features` 层。
- 完成项：
  - 新增 `src/features/thinking-chains-editor/useThinkingChainsEditor.ts`（思维链编辑业务 composable）
  - 新增 `src/features/thinking-chains-editor/reorderClusters.ts`（思维链拖拽排序 helper）
  - 视图层接入迁移：
    - `src/views/ThinkingChainsEditor.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/ThinkingChainsEditor/useThinkingChainsEditor.ts` 改为 re-export
    - `src/views/ThinkingChainsEditor/reorderClusters.ts` 改为 re-export
  - 契约测试补齐：
    - `tests/composables/useThinkingChainsEditor.test.ts` 增加“导出面契约”断言
  - 测试入口迁移：
    - `tests/composables/reorderClusters.test.ts` 引用切换到 feature helper
- 兼容点与最小改造说明：
  - 保留 `src/views/ThinkingChainsEditor/*` 的兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/thinking-chains-editor/*`，不改后端接口协议与页面模板结构
  - helper 迁移保持实现等价，仅调整模块归属以降低后续维护耦合
- 验证结果：
  - 语言服务检查：批次 6 阶段 G 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useThinkingChainsEditor.test.ts`
    - `tests/composables/reorderClusters.test.ts`
    - `tests/composables/useServerLogViewer.test.ts`
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：15 文件通过，60 用例通过

## 22. 增量进展（批次 6 / 阶段 H：AgentAssistantConfig 一次性迁移）
- 状态：`已完成（阶段 H）`
- 目标：按批次 6 模板一次性完成 AgentAssistantConfig 的 feature 迁移，确保配置解析与保存逻辑从 `views` 层收口到 `features` 层，并保留兼容导出。
- 完成项：
  - 新增 `src/features/agent-assistant-config/useAgentAssistantConfig.ts`（AgentAssistant 配置业务 composable）
  - 视图层接入迁移：
    - `src/views/AgentAssistantConfig.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/AgentAssistantConfig/useAgentAssistantConfig.ts` 改为 re-export（含类型导出）
  - 契约测试补齐：
    - `tests/composables/useAgentAssistantConfig.test.ts` 增加“导出面契约”断言
- 兼容点与最小改造说明：
  - 保留 `src/views/AgentAssistantConfig/useAgentAssistantConfig.ts` 的兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/agent-assistant-config/*`，不改配置 API 协议与页面模板结构
  - 解析/归一化实现保持语义等价，仅调整实现归属层级
- 验证结果：
  - 语言服务检查：批次 6 阶段 H 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useAgentAssistantConfig.test.ts`
    - `tests/composables/useThinkingChainsEditor.test.ts`
    - `tests/composables/reorderClusters.test.ts`
    - `tests/composables/useServerLogViewer.test.ts`
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：16 文件通过，64 用例通过

## 23. 增量进展（批次 6 / 阶段 I：VcptavernEditor 一次性迁移）
- 状态：`已完成（阶段 I）`
- 目标：按批次 6 模板一次性完成 VcptavernEditor 的 feature 迁移，并保持拖拽交互测试契约稳定。
- 完成项：
  - 新增 `src/features/vcptavern-editor/useVcptavernEditor.ts`（VCP Tavern 预设编辑业务 composable）
  - 视图层接入迁移：
    - `src/views/VcptavernEditor.vue` 改为直接引用 feature composable
  - 兼容桥接保留：
    - `src/views/VcptavernEditor/useVcptavernEditor.ts` 改为 re-export
  - 契约测试补齐：
    - `tests/composables/useVcptavernEditor.test.ts` 增加“导出面契约”断言
  - 拖拽测试契约对齐：
    - 在 feature composable 返回值中显式透出 `handlePointerMove` / `handlePointerUp`
    - 保持现有 pointer 测试驱动方式兼容
- 兼容点与最小改造说明：
  - 保留 `src/views/VcptavernEditor/useVcptavernEditor.ts` 兼容导出，避免存量导入路径在同批次内失效
  - 仅切换 view/test 消费入口到 `src/features/vcptavern-editor/*`，未改后端接口协议与模板结构
  - 逻辑迁移保持语义等价，重点是目录归属收口与契约稳定
- 验证结果：
  - 语言服务检查：批次 6 阶段 I 相关文件无报错
  - 回归测试通过：
    - `tests/composables/useVcptavernEditor.test.ts`
    - `tests/composables/useAgentAssistantConfig.test.ts`
    - `tests/composables/useThinkingChainsEditor.test.ts`
    - `tests/composables/reorderClusters.test.ts`
    - `tests/composables/useServerLogViewer.test.ts`
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：17 文件通过，68 用例通过

## 24. 增量进展（批次 6 / 阶段 J：收口验收与兼容点确认）
- 状态：`已完成（阶段 J）`
- 目标：在批次 6 完成多轮 feature 迁移后，执行收口审计，确认业务消费入口已从 `views` 层收敛至 `features` 层，并明确剩余兼容点。
- 完成项：
  - 审计 `src/views/*.vue`：确认不再直接引用本地 `./*/use*.ts` 业务 composable
  - 审计 `src/**/*.ts` 与 `tests/**/*.ts`：确认无 `@/views/*/use*` / `@/views/*/reorder*` 业务导入残留
  - 确认当前 `src/views/*/use*.ts` 与 `src/views/*/reorder*.ts` 仅承担兼容 re-export 职责
- 批次 6 完成结论：
  - Feature 迁移模板已在以下模块完成落地：
    - `vcp-forum`
    - `tool-list`
    - `placeholder-viewer`
    - `agent-files-editor`
    - `preprocessor-order-manager`
    - `server-log-viewer`
    - `thinking-chains-editor`
    - `agent-assistant-config`
    - `vcptavern-editor`
  - 契约测试已覆盖上述迁移模块核心导出面
- 剩余兼容点（为批次 7 预留）：
  - `src/views/*/use*.ts` 与 `src/views/*/reorder*.ts` 的 re-export 桥接文件尚保留
  - Legacy 路径隔离与兼容桥接下线将在批次 7 统一处理

## 25. 增量进展（批次 7 / 阶段 A：Legacy Bridge 护栏）
- 状态：`已完成（阶段 A）`
- 目标：在正式执行 Legacy 入口隔离与桥接下线前，先建立可审计、可阻断的工程护栏，防止新代码回流依赖 `views` 业务桥。
- 完成项：
  - 新增 `src/legacy/bridgeManifest.ts`：
    - 建立 Legacy Bridge 清单（`id`、`kind`、`aliasImportPath`、`featureImportPath`）
    - 将当前保留的兼容桥接模块显式登记为“可治理对象”
  - 新增 `tests/utils/legacyBridgeIsolation.test.ts`：
    - 断言桥接文件仅作为 feature re-export
    - 审计 `src` 与 `tests` 中是否新增对 legacy bridge 的业务导入
    - 以失败用例阻断“新依赖回流到 views 桥接层”
- 兼容点与最小改造说明：
  - 本阶段不删除任何现有桥接文件，仅新增清单与守卫测试
  - 目标是先锁定边界，再进入批次 7 后续的入口隔离与桥接下线动作
  - 保持当前运行行为不变，避免批次切换期出现功能回退
- 验证结果：
  - 回归测试通过：
    - `tests/utils/legacyBridgeIsolation.test.ts`
    - `tests/composables/useVcptavernEditor.test.ts`
    - `tests/composables/useAgentAssistantConfig.test.ts`
    - `tests/composables/useThinkingChainsEditor.test.ts`
    - `tests/composables/reorderClusters.test.ts`
    - `tests/composables/useServerLogViewer.test.ts`
    - `tests/composables/usePreprocessorOrderManager.test.ts`
    - `tests/composables/useAgentFilesEditor.test.ts`
    - `tests/composables/usePlaceholderViewer.test.ts`
    - `tests/composables/useVcpForum.test.ts`
    - `tests/composables/useToolListEditor.test.ts`
    - `tests/stores/forumApi.test.ts`
    - `tests/utils/navigation.test.ts`
    - `tests/composables/useMainLayoutState.test.ts`
    - `tests/utils/authSession.test.ts`
    - `tests/stores/authApi.test.ts`
    - `tests/composables/newApiMonitorApi.test.ts`
    - `tests/composables/useDashboardState.test.ts`
  - 结果：18 文件通过，70 用例通过

## 26. 增量进展（批次 7 / 阶段 B：Legacy 入口规范化）
- 状态：`已完成（阶段 B）`
- 目标：将 legacy 入口路径 `/AdminPanelLegacy` 与 canonical 入口 `/AdminPanel` 显式隔离，避免运行时路径漂移和回跳语义分叉。
- 完成项：
  - `src/app/routes/base.ts`：
    - 新增 `APP_LEGACY_ROUTER_BASE`
    - 新增 `normalizeLegacyAppPath(...)`，将 legacy 路径规范化到 canonical 路径
    - 新增 `resolveCanonicalAppLocation(...)`，保留 query/hash 的地址规范化能力
  - `src/router/index.ts`：
    - 在 `createRouter(...)` 前执行 legacy 地址规范化
    - 命中 legacy 入口时通过 `history.replaceState` 无刷收敛到 canonical 入口
  - `tests/utils/navigation.test.ts`：
    - 新增 legacy 入口规范化测试，覆盖：
      - `/AdminPanelLegacy/dashboard?tab=system#section-a` -> `/AdminPanel/dashboard?tab=system#section-a`
      - `/AdminPanelLegacy` -> `/AdminPanel`
      - canonical 路径不触发规范化（返回 `null`）
- 兼容点与最小改造说明：
  - 本阶段仅做入口路径收敛，不改动路由清单与页面组件映射
  - 使用 `replaceState` 避免新增历史栈噪音，保持用户回退体验稳定
  - 规范化逻辑纯函数化，便于后续在服务端或网关层复用
- 验证结果：
  - 回归测试通过：
    - `tests/utils/navigation.test.ts`
    - `tests/utils/legacyBridgeIsolation.test.ts`
  - 结果：2 文件通过，11 用例通过

## 27. 增量进展（批次 7 / 阶段 C：桥接废弃标记与守卫加严）
- 状态：`已完成（阶段 C）`
- 目标：在桥接下线前，将 `views` 兼容桥接文件明确标记为废弃入口，并通过自动化测试强制执行该约束。
- 完成项：
  - 为 `src/views/*/use*.ts`、`src/views/*/types.ts`、`src/views/*/reorder*.ts` 的已登记桥接文件补充统一 `@deprecated` 注释。
  - `tests/utils/legacyBridgeIsolation.test.ts` 加严：
    - 除“仅允许 re-export 到 feature 路径”外，新增“桥接文件必须包含 `@deprecated` 标记”的断言。
- 兼容点与最小改造说明：
  - 本阶段未删除桥接文件，也未改变导出符号。
  - 对外行为保持兼容，仅新增静态标记与治理约束。
  - 后续下线阶段可据此进行分批删除并减少误删风险。
- 验证结果：
  - 回归测试通过：
    - `tests/utils/legacyBridgeIsolation.test.ts`
    - `tests/utils/navigation.test.ts`
  - 结果：2 文件通过，11 用例通过

## 28. 增量进展（批次 7 / 阶段 D：构建验证与桥接清理收尾）
- 状态：`已完成（阶段 D）`
- 目标：完成桥接清理后，执行生产构建验证，确认分层收口后的工程可编译、可打包。
- 完成项：
  - 生产构建验证通过：
    - 执行命令：`npm run build`
    - 执行内容：`vue-tsc && vite build`
    - 结果：`✓ 314 modules transformed`，`✓ built in 3.66s`
  - 测试回归保持通过（同批次收尾基线）：
    - 执行命令：`npx vitest run --testTimeout=60000`
    - 结果：`28` 测试文件通过，`92` 用例通过
  - Legacy 桥接收尾状态确认：
    - `src/legacy/bridgeManifest.ts` 已移除
    - `tests/utils/legacyBridgeIsolation.test.ts` 已移除
    - `src/views/*/use*.ts`、`src/views/*/types.ts`、`src/views/*/reorder*.ts` 兼容桥接文件已清理
    - 清理后遗留导入已修复到 feature 层（Placeholder/ToolList/VcpForum 相关组件）
- 兼容点与最小改造说明：
  - 构建通过说明迁移与清理后的模块边界在当前产物链路可用
  - 反馈层仍保留总线兼容包装（`utils/api.ts` -> feedback bus），属于可控技术债，不影响本批次收尾验收

## 29. 当前架构复审（2026-04-03）
- 复审结论：`总体通过，具备继续推进批次 8 的条件`

- 分层状态（按 6 层模型复核）：
  - Shell：`MainLayout + FeedbackHost` 已成为统一壳层承载点
  - Routing：路由基路径与 legacy 入口规范化已收敛到 `src/app/routes/*`
  - Feature：核心业务 composable 已收口到 `src/features/*`
  - Domain/Data：API 与 feature 类型依赖关系已解除 `views` 绑定
  - Platform：`platform/http` 与 `platform/feedback` 已稳定承载基础能力
  - Legacy Bridge：桥接文件与桥接清单已完成下线

- 发现项（按严重度）：
  - 中：`docs/ARCH_REFACTOR_EXECUTION.md` 在第 25-27 节仍保留“桥接存在态”的历史描述，虽有时间序列价值，但易被误读为当前状态。建议在后续文档整理时增加“历史状态”显式标识。
  - 低：构建产物体积中 `easymde` 与 `dashboard-components` chunk 偏大（分别约 `331.49 kB` 与 `142.59 kB`），当前不阻塞发布，但建议后续按页面访问频次继续做分包与惰性加载优化。
  - 低：`utils/api.ts` 仍承担兼容语义（反馈总线分发、错误提示策略），建议在后续阶段继续向 platform/domain 细化切分。

- 本次复审验收结论：
  - 无阻断级问题（Critical/High）
  - 构建与测试双基线均通过
  - 架构收口方向与仓库现状一致

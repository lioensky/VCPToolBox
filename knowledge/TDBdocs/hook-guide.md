# TriviumDB Hook 开发指南

> 🔌 面向想要深度定制检索管线的开发者：从零实现自定义 Hook 的完整攻略。

---

## 目录

- [Hook 系统概述](#hook-系统概述)
- [管线架构与 6 个注入点](#管线架构与-6-个注入点)
- [方式一：管线性能诊断（零代码）](#方式一管线性能诊断零代码)
- [方式二：C/C++ FFI 插件开发](#方式二cc-ffi-插件开发)
- [方式三：Rust 原生 Hook 开发](#方式三rust-原生-hook-开发)
- [HookContext 详解](#hookcontext-详解)
- [CompositeHook 多 Hook 组合](#compositehook-多-hook-组合)
- [跨语言 API 参考](#跨语言-api-参考)
- [安全注意事项](#安全注意事项)
- [FAQ](#faq)

---

## Hook 系统概述

TriviumDB v0.6.0 引入的 Hook 系统提供了 **6 个管线关键阶段的自定义注入点**，允许开发者在构建 RAG 系统时：

- 🔍 改写查询参数、注入用户上下文
- 🔄 替代内置召回（对接外部 FAISS / ScaNN 等高性能模块）
- 🎯 自定义评分调权、业务逻辑过滤
- 🧠 外置 Cross-Encoder 精排 / ONNX 推理
- 📊 结果增强、统计埋点、回传自定义数据

### 设计原则

| 原则 | 说明 |
|------|------|
| **零开销可选** | 未注册 Hook 时默认 `NoopHook`，编译器内联消除全部调用开销 |
| **按需覆写** | 所有方法都有默认空实现，开发者只需覆写感兴趣的阶段 |
| **FFI 友好** | `FfiHook` 支持运行时加载 C/C++ `.so/.dll/.dylib` 动态库 |
| **类型安全** | `SearchHook: Send + Sync` 编译器强制线程安全 |

---

## 管线架构与 6 个注入点

```text
  查询输入 (query_vector, query_text, SearchConfig)
      │
  🔌 #1 on_pre_search        ← 查询预处理
      │                         可修改: query_vector, SearchConfig, HookContext
      │                         可设置: ctx.abort = true 提前终止管线
      │
  🔌 #2 on_custom_recall     ← 自定义召回
      │                         返回 Some(Vec<SearchHit>) → 替代内置召回
      │                         返回 None → 走内置管线
      │
  ┌── 内置召回管线 ──────────┐
  │  L1 AC自动机 + BM25 文本  │
  │  L2 BruteForce / QuIVer 向量 │
  │  L3 布隆特征预过滤        │
  │  L4 FISTA 残差寻隐        │
  │  L5 影子查询              │
  └──────────────────────────┘
      │
  🔌 #3 on_post_recall       ← 召回后处理
      │                         可修改: &mut Vec<SearchHit>
      │
  🔌 #4 on_pre_graph_expand  ← 图扩散前拦截
      │                         可修改: &mut Vec<SearchHit> (种子集)
      │
  ┌── 图谱扩散 ──────────────┐
  │  L6 PPR 扩散激活          │
  │  L7 不应期 / 侧向抑制     │
  └──────────────────────────┘
      │
  🔌 #5 on_rerank            ← 自定义重排序
      │                         可修改: &mut Vec<SearchHit>
      │                         可替换: 返回 Some(Vec<SearchHit>)
      │
  ┌── 多样性采样 ────────────┐
  │  L9 DPP 行列式采样        │
  └──────────────────────────┘
      │
  🔌 #6 on_post_search       ← 最终后处理
      │                         可修改: &mut Vec<SearchHit>
      │
  返回结果 + HookContext
```

---

## 方式一：管线性能诊断（零代码）

最简单的使用方式——**不需要编写任何 Hook**，直接使用 `search_with_context()` 获取管线执行报告。

### Python

```python
hits, ctx = db.search_with_context(
    query_vector=query_vec,
    top_k=10,
    expand_depth=2,
    min_score=0.1,
)

# 打印管线耗时报告
for stage, ms in ctx.timings.items():
    print(f"  {stage}: {ms:.2f}ms")

# 检查是否被 Hook 提前终止
print(f"管线终止: {ctx.aborted}")
```

### Node.js

```javascript
const { hits, context } = db.searchWithContext(queryVec, {
    topK: 10,
    expandDepth: 2,
    minScore: 0.1,
})

// 打印管线耗时
for (const [stage, ms] of Object.entries(context.timings)) {
    console.log(`  ${stage}: ${ms.toFixed(2)}ms`)
}
```

### Rust

```rust
let config = SearchConfig {
    top_k: 10,
    expand_depth: 2,
    ..Default::default()
};
let (results, ctx) = db.search_hybrid_with_context(None, Some(&query_vec), &config)?;

for (stage, dur) in &ctx.stage_timings {
    println!("  {}: {:.2}ms", stage, dur.as_secs_f64() * 1000.0);
}
```

---

## 方式二：C/C++ FFI 插件开发

当需要高性能的外部计算模块（如 FAISS、ScaNN、ONNX Runtime）时，编写 C/C++ 动态库。

### 支持的 FFI 符号

`FfiHook` 按名称查找以下 C ABI 符号（**均为可选**，未找到的符号自动降级为空操作）：

| 符号名 | 对应 Hook 点 | 签名 |
|--------|-------------|------|
| `trivium_recall` | `on_custom_recall` | `void(const float* query, uint32_t dim, uint64_t* out_ids, float* out_scores, uint32_t* out_count)` |
| `trivium_rerank` | `on_rerank` | `void(uint64_t* ids, float* scores, uint32_t count)` |

### 完整示例：自定义重排序插件

**C++ 代码** (`my_reranker.cpp`)：

```cpp
#include <cstdint>
#include <algorithm>
#include <vector>

// 导出 C ABI 符号
extern "C" {

// 自定义重排序：按业务规则调整分数
void trivium_rerank(
    uint64_t* ids,       // [in/out] 节点 ID 数组
    float* scores,       // [in/out] 对应分数数组
    uint32_t count       // 结果数量
) {
    // 示例：对 "VIP 节点" (ID 1000-2000) 提权 50%
    for (uint32_t i = 0; i < count; ++i) {
        if (ids[i] >= 1000 && ids[i] <= 2000) {
            scores[i] *= 1.5f;
        }
    }

    // 按分数降序重排
    std::vector<std::pair<float, uint64_t>> pairs(count);
    for (uint32_t i = 0; i < count; ++i) {
        pairs[i] = {scores[i], ids[i]};
    }
    std::sort(pairs.begin(), pairs.end(),
        [](auto& a, auto& b) { return a.first > b.first; });
    for (uint32_t i = 0; i < count; ++i) {
        scores[i] = pairs[i].first;
        ids[i] = pairs[i].second;
    }
}

} // extern "C"
```

**编译**：

```bash
# Linux
g++ -shared -fPIC -O2 -o libmy_reranker.so my_reranker.cpp

# macOS
clang++ -shared -fPIC -O2 -o libmy_reranker.dylib my_reranker.cpp

# Windows (MSVC)
cl /LD /O2 my_reranker.cpp /Fe:my_reranker.dll
```

**使用**：

```python
# 加载插件
db.load_ffi_hook("./libmy_reranker.so")

# 后续所有检索自动经过 C++ 重排序
results = db.search(query_vec, top_k=10)

# 查看管线计时（含 Hook 阶段）
hits, ctx = db.search_with_context(query_vec, top_k=10)
print(f"重排序耗时: {ctx.timings.get('hook_rerank', 0):.2f}ms")

# 清除插件
db.clear_hook()
```

---

## 方式三：Rust 原生 Hook 开发

直接实现 `SearchHook` trait，获得编译器优化和完整的类型安全。

### SearchHook Trait 定义

```rust
pub trait SearchHook: Send + Sync {
    /// #1 查询预处理
    fn on_pre_search(
        &self,
        query_vector: &mut Vec<f32>,
        config: &mut SearchConfig,
        ctx: &mut HookContext,
    ) {}

    /// #2 自定义召回（返回 Some 替代内置召回，None 走内置管线）
    fn on_custom_recall(
        &self,
        query_vector: &[f32],
        config: &SearchConfig,
        ctx: &mut HookContext,
    ) -> Option<Vec<SearchHit>> { None }

    /// #3 召回后处理
    fn on_post_recall(
        &self,
        results: &mut Vec<SearchHit>,
        ctx: &mut HookContext,
    ) {}

    /// #4 图扩散前拦截
    fn on_pre_graph_expand(
        &self,
        seeds: &mut Vec<SearchHit>,
        ctx: &mut HookContext,
    ) {}

    /// #5 自定义重排序（返回 Some 替换结果，None 使用原地修改）
    fn on_rerank(
        &self,
        results: &mut Vec<SearchHit>,
        ctx: &mut HookContext,
    ) -> Option<Vec<SearchHit>> { None }

    /// #6 最终后处理
    fn on_post_search(
        &self,
        results: &mut Vec<SearchHit>,
        ctx: &mut HookContext,
    ) {}
}
```

### 示例：统计埋点 Hook

```rust
use std::sync::atomic::{AtomicU64, Ordering};

struct MetricsHook {
    total_queries: AtomicU64,
    total_results: AtomicU64,
}

impl SearchHook for MetricsHook {
    fn on_pre_search(
        &self, _: &mut Vec<f32>, _: &mut SearchConfig, ctx: &mut HookContext,
    ) {
        self.total_queries.fetch_add(1, Ordering::Relaxed);
    }

    fn on_post_search(
        &self, results: &mut Vec<SearchHit>, ctx: &mut HookContext,
    ) {
        self.total_results.fetch_add(results.len() as u64, Ordering::Relaxed);
        ctx.custom_data = serde_json::json!({
            "total_queries": self.total_queries.load(Ordering::Relaxed),
            "total_results": self.total_results.load(Ordering::Relaxed),
            "avg_results": self.total_results.load(Ordering::Relaxed) as f64
                / self.total_queries.load(Ordering::Relaxed).max(1) as f64,
        });
    }
}

// 注册
db.set_hook(MetricsHook {
    total_queries: AtomicU64::new(0),
    total_results: AtomicU64::new(0),
});
```

### 示例：查询拦截 Hook（权限控制）

```rust
struct AuthHook;

impl SearchHook for AuthHook {
    fn on_pre_search(
        &self, _: &mut Vec<f32>, _: &mut SearchConfig, ctx: &mut HookContext,
    ) {
        let role = ctx.custom_data.get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("anonymous");

        if role == "anonymous" {
            ctx.abort = true;  // 终止管线，返回空结果
            ctx.custom_data = serde_json::json!({"error": "unauthorized"});
        }
    }
}
```

---

## HookContext 详解

`HookContext` 是管线各阶段之间的共享状态容器：

```rust
pub struct HookContext {
    pub custom_data: serde_json::Value,              // 自定义数据
    pub stage_timings: Vec<(String, Duration)>,       // 阶段计时
    pub abort: bool,                                  // 终止标志
}
```

### 跨阶段数据传递

```rust
impl SearchHook for MyHook {
    fn on_pre_search(&self, _, _, ctx: &mut HookContext) {
        // 在第 1 阶段写入数据
        ctx.custom_data = serde_json::json!({"user_id": "u123"});
    }

    fn on_rerank(&self, results: &mut Vec<SearchHit>, ctx: &mut HookContext) -> Option<Vec<SearchHit>> {
        // 在第 5 阶段读取第 1 阶段写入的数据
        let user_id = ctx.custom_data.get("user_id")
            .and_then(|v| v.as_str());
        // ... 根据用户 ID 做个性化重排序
        None
    }
}
```

### 提前终止管线

在 `on_pre_search` 中设置 `ctx.abort = true`，管线将跳过后续所有阶段，直接返回空结果。

```python
# Python 侧接收终止信号
hits, ctx = db.search_with_context(query_vec)
if ctx.aborted:
    print(f"查询被拦截: {ctx.custom_data}")
```

---

## CompositeHook 多 Hook 组合

需要同时使用多个 Hook 时，使用 `CompositeHook` 按注册顺序链式调用：

```rust
use triviumdb::hook::CompositeHook;

let composite = CompositeHook::new(vec![
    Arc::new(AuthHook),
    Arc::new(MetricsHook::new()),
    Arc::new(FfiHook::load("./libcustom_reranker.so")?),
]);

db.set_hook(composite);
```

调用顺序：`AuthHook → MetricsHook → FfiHook`，每个 Hook 的修改对后续 Hook 可见。

---

## 跨语言 API 参考

| 功能 | Python | Node.js | Rust |
|------|--------|---------|------|
| 加载 FFI 插件 | `db.load_ffi_hook(path)` | `db.loadFfiHook(path)` | `db.set_hook(FfiHook::load(path)?)` |
| 清除 Hook | `db.clear_hook()` | `db.clearHook()` | `db.clear_hook()` |
| 带上下文检索 | `hits, ctx = db.search_with_context(...)` | `const { hits, context } = db.searchWithContext(...)` | `let (hits, ctx) = db.search_hybrid_with_context(...)` |
| 上下文·耗时 | `ctx.timings` (dict, ms) | `context.timings` (object, ms) | `ctx.stage_timings` (Vec, Duration) |
| 上下文·数据 | `ctx.custom_data` (dict) | `context.customData` (object) | `ctx.custom_data` (serde_json::Value) |
| 上下文·终止 | `ctx.aborted` (bool) | `context.aborted` (bool) | `ctx.abort` (bool) |

---

## 安全注意事项

1. **FFI 插件信任**：`load_ffi_hook()` 加载的动态库在进程内执行任意代码，**请确保来源可信**
2. **Hook 回调不要阻塞**：管线执行期间持有 MemTable 锁，Hook 中执行网络 I/O 或长时间计算会阻塞所有读写
3. **不要修改向量维度**：`on_pre_search` 中可以修改查询向量的分量值，但**不要改变 Vec 长度**
4. **C++ 异常安全**：FFI 回调中的 C++ 异常穿越 Rust FFI 边界会导致 UB，请在 C++ 侧 `try-catch` 所有异常
5. **及时清除**：测试/调试用的 Hook 使用完毕后调用 `clear_hook()` 移除，避免影响后续正常查询性能

> 📖 更多安全细节请查看 **[安全设计说明](security.md)** 中的 "FFI Hook 插件安全" 章节。

---

## FAQ

**Q: Hook 对普通 `search()` 有效吗？**

A: 有效。`search()` 和 `search_hybrid()` 内部都走 `execute_pipeline`，已注册的 Hook 会在所有检索路径中生效。

**Q: 能否用纯 Python / JavaScript 编写 Hook？**

A: 目前不支持纯 Python/JS Hook（跨 FFI 回调 GIL/事件循环的性能和安全代价太大）。推荐方案：
- 简单逻辑：在 Python/JS 侧对 `search()` 的返回结果做后处理
- 高性能逻辑：编写 C/C++ 动态库通过 `load_ffi_hook()` 加载
- 完整控制：在 Rust 项目中直接实现 `SearchHook` trait

**Q: Hook 的性能开销是多少？**

A: 未注册 Hook 时（默认 `NoopHook`）**零开销**——编译器会完全内联消除空方法调用。注册 Hook 后的开销等于 Hook 回调本身的执行时间，可通过 `search_with_context()` 的 `timings` 精确观测。

**Q: 多个 `search()` 调用之间 Hook 状态是否共享？**

A: `HookContext` 是每次查询独立创建的，不在查询之间共享。但 Hook 实现本身（如 `MetricsHook` 中的 `AtomicU64`）可以通过 `Sync` 安全类型维护跨查询的累积状态。

# TriviumDB API 完整参考

> **版本**: v0.7.0  
> **语言**: Rust 核心 + Python 绑定 (PyO3) + Node.js 绑定 (napi-rs)  
> **许可**: Apache-2.0

---

## 目录

- [数据库生命周期](#数据库生命周期)
- [节点 CRUD](#节点-crud)
- [图谱操作](#图谱操作)
- [向量检索](#向量检索)
- [Hook 扩展系统](#hook-扩展系统)
- [元数据过滤](#元数据过滤)
- [TQL 统一查询](#tql-统一查询)
- [属性二级索引](#属性二级索引)
- [持久化与压缩](#持久化与压缩)
- [内存管理](#内存管理)
- [工具方法](#工具方法)
- [维度迁移](#维度迁移)
- [事务支持](#事务支持-rust-only)
- [Pythonic 魔术方法](#pythonic-魔术方法)
- [数据类型说明](#数据类型说明)

---

## 数据库生命周期

### Python

```python
import triviumdb

# 基础打开方式（默认 f32 向量、1536 维、normal 同步模式）
db = triviumdb.TriviumDB("my_data.tdb", dim=1536)

# 完整参数
db = triviumdb.TriviumDB(
    path="my_data.tdb",    # 文件路径（不存在则新建）
    dim=1536,              # 向量维度（一旦创建不可更改）
    dtype="f32",           # 向量类型："f32" | "f16" | "u64"
    sync_mode="normal"     # WAL 同步模式："full" | "normal" | "off"
)

# 推荐：使用上下文管理器（退出时自动 flush 落盘）
with triviumdb.TriviumDB("my_data.tdb", dim=1536) as db:
    # ... 所有操作 ...
    pass  # 退出时自动调用 db.flush()
```

**参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `path` | `str` | *必填* | `.tdb` 文件路径，不存在时自动创建 |
| `dim` | `int` | `1536` | 向量维度，必须与后续插入的向量长度一致 |
| `dtype` | `str` | `"f32"` | 向量存储精度：`f32`（标准）、`f16`（省内存）、`u64`（SimHash） |
| `sync_mode` | `str` | `"normal"` | WAL 写入安全级别，详见[持久化与压缩](#持久化与压缩) |

### Rust

```rust
use triviumdb::Database;
use triviumdb::database::{Config, StorageMode};
use triviumdb::storage::wal::SyncMode;

// 基础打开（默认 Mmap 模式 + Normal 同步）
let mut db = Database::<f32>::open("my_data.tdb", 1536)?;

// 指定同步模式（向后兼容）
let mut db = Database::<f32>::open_with_sync("my_data.tdb", 1536, SyncMode::Full)?;

// 高级配置（v0.4+）——同时指定存储模式和同步模式
let mut db = Database::<f32>::open_with_config("my_data.tdb", Config {
    dim: 1536,
    storage_mode: StorageMode::Rom,  // Rom：单文件便携 | Mmap：分离零拷贝（默认）
    sync_mode: SyncMode::Normal,
})?;

// 运行时切换同步模式
db.set_sync_mode(SyncMode::Off);
```

**泛型类型参数 `T`：**

| 类型 | 说明 | 适用场景 |
|------|------|----------|
| `f32` | 32 位浮点 | 标准 embedding（OpenAI、BGE 等） |
| `half::f16` | 16 位半精度浮点 | 大规模数据集省内存 |
| `u64` | 64 位无符号整数 | SimHash / 二值化向量 |

---

## 节点 CRUD

### insert — 插入节点

向数据库写入一个新节点，同时携带向量和 JSON 元数据。返回自动分配的 `u64` 节点 ID。

**Python：**
```python
node_id = db.insert(
    vector=[0.12, -0.45, 0.78, ...],       # 向量（长度必须等于 dim）
    payload={"text": "小明喜欢吃苹果", "ts": 1711440000}  # 任意 JSON
)
```

**Rust：**
```rust
let id = db.insert(&[0.12, -0.45, 0.78], json!({"text": "Hello"}))?;
```

### insert_with_id — 带自定义 ID 插入

适用于从外部系统导入数据时，保持原始 ID 不变。如果 ID 已存在会返回错误。

**Python：**
```python
db.insert_with_id(id=42, vector=[0.1, 0.2, 0.3, ...], payload={"source": "external"})
```

**Rust：**
```rust
db.insert_with_id(42, &[0.1, 0.2, 0.3], json!({"source": "external"}))?;
```

### batch_insert — 批量插入

一次性插入多个节点，返回所有新 ID 的列表。

**Python：**
```python
ids = db.batch_insert(
    vectors=[[0.1, 0.2, ...], [0.3, 0.4, ...]],
    payloads=[{"name": "A"}, {"name": "B"}]
)
```

### batch_insert_with_ids — 带自定义 ID 批量插入

**Python：**
```python
db.batch_insert_with_ids(
    ids=[100, 101],
    vectors=[[0.1, 0.2, ...], [0.3, 0.4, ...]],
    payloads=[{"name": "A"}, {"name": "B"}]
)
```

### get — 获取单个节点

按 ID 获取节点的完整视图，包含向量、元数据和边的数量。不存在时返回 `None`。

**Python：**
```python
node = db.get(42)
if node:
    print(node.id)         # 42
    print(node.vector)     # [0.1, 0.2, ...]
    print(node.payload)    # {"name": "Alice", ...}
    print(node.num_edges)  # 3
```

**Rust：**
```rust
if let Some(view) = db.get(42) {
    println!("ID={}, edges={}", view.id, view.edges.len());
    println!("payload={:?}", view.payload);
}
```

### update_payload — 更新元数据

整体替换节点的 JSON 元数据（向量和图谱关系不受影响）。

**Python：**
```python
db.update_payload(id=42, payload={"text": "更新后的文本", "version": 2})
```

### update_vector — 更新向量

就地替换节点的向量（维度必须一致，元数据和图谱关系不受影响）。

**Python：**
```python
db.update_vector(vector=[0.5, 0.6, 0.7, ...], id=42)
```

### delete — 删除节点

**三层原子联删**：同时清除该节点的向量、元数据以及所有关联的图谱边（包括其他节点指向它的入边）。

**Python：**
```python
db.delete(42)
```

**Rust：**
```rust
db.delete(42)?;
```

> ⚠️ 删除操作不可逆。删除后，该节点的向量区间被逻辑置零，待 Compaction 时物理回收。

### get_payload — 轻量级获取元数据

只获取节点的 JSON Payload，不含向量，比 `get()` 更轻量。

**Python：**
```python
payload = db.get_payload(42)
if payload:
    print(payload["name"])  # "Alice"
```

**Node.js：**
```js
const payload = db.getPayload(42)
if (payload) console.log(payload.name)
```

### get_edges — 获取出边列表

获取节点的所有出向边（不含向量和 Payload）。

**Python：**
```python
edges = db.get_edges(42)
for e in edges:
    print(f"{e.target_id} ({e.label}, w={e.weight})")
```

**Node.js：**
```js
const edges = db.getEdges(42)
edges.forEach(e => console.log(`${e.targetId} (${e.label})`))
```

### contains — 节点存在检查

**Python：**
```python
if db.contains(42):     # 或用 42 in db
    print("节点存在")
```

**Node.js：**
```js
if (db.contains(42)) console.log('节点存在')
```

---

## 图谱操作

### link — 建立有向边

在两个节点之间建立一条有向带权边。两个端点必须已存在，否则返回错误。

**Python：**
```python
db.link(src=1, dst=2, label="knows", weight=0.95)
```

**Rust：**
```rust
db.link(1, 2, "knows", 0.95)?;
```

**参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `u64` | *必填* | 源节点 ID |
| `dst` | `u64` | *必填* | 目标节点 ID |
| `label` | `str` | `"related"` | 边的类型标签（自定义字符串） |
| `weight` | `f32` | `1.0` | 边的权重（支持负值，可用于表达抑制关系） |

> 💡 边是**有向**的。如需双向关系，需调用两次 `link()`：`link(A, B)` + `link(B, A)`。

### unlink — 断开边

移除从 `src` 到 `dst` 的**所有**边（无论 label 是什么）。

**Python：**
```python
db.unlink(src=1, dst=2)
```

**Rust：**
```rust
db.unlink(1, 2)?;
```

### neighbors — N 跳邻居

从指定节点出发，沿有向边进行广度优先遍历（BFS），返回 N 跳以内所有可达节点的 ID。

**Python：**
```python
neighbor_ids = db.neighbors(id=1, depth=2)  # 2 跳以内的所有邻居
```

**Rust：**
```rust
let ids = db.neighbors(1, 2);
```

---

## 搜索与召回

### search_hybrid — 双路混合认知检索 (强推)

TriviumDB 核心杀手锏：引入稀疏文本表示（BM25/AC自动机）与稠密向量（Dense Vector）构成双路融合召回锚定，再在第二阶段进行图谱激活扩散。这极大弥补了纯向量检索容易导致的专有名词幻觉（Hallucination）。

**Python：**
```python
results = db.search_hybrid(
    query_vector=[0.10, -0.48, 0.80, ...], 
    query_text="Rust 内存安全",
    top_k=5,
    expand_depth=2,
    min_score=0.1,
    hybrid_alpha=0.7  # 0.7 偏向量，0.3 偏精确文本
)
for hit in results:
    print(f"[{hit.id}] score={hit.score:.3f} | {hit.payload}")
```

### search — 纯向量图扩散检索 (基础)

TriviumDB 的基础检索能力（退化态）：**先用核心稠密向量相似度找到锚点，再沿图谱关系向外扩散**。

**Python：**
```python
results = db.search(
    query_vector=[0.10, -0.48, 0.80, ...],  # 查询向量
    top_k=5,            # 向量阶段返回的锚点数量
    expand_depth=2,     # 图谱扩散跳数（0 = 纯向量检索）
    min_score=0.5       # 最低相似度阈值
)
for hit in results:
    print(f"[{hit.id}] score={hit.score:.3f} | {hit.payload}")
```

**Rust：**
```rust
let results = db.search(&[0.10, -0.48, 0.80], 5, 2, 0.5)?;
for hit in &results {
    println!("[{}] score={:.3} {:?}", hit.id, hit.score, hit.payload);
}
```

**参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `query_vector` | `list[float]` | *必填* | 查询向量 |
| `top_k` | `int` | `5` | 向量阶段返回的最相似节点数 |
| `expand_depth` | `int` | `0` | 图谱扩散深度。设为 0 则退化为纯向量检索 |
| `min_score` | `float` | `0.5` | 余弦相似度下限，低于此值的结果被过滤 |

**返回值 `SearchHit`：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `u64` | 命中节点的 ID |
| `score` | `f32` | 相似度得分（余弦相似度或扩散热度） |
| `payload` | `dict` | 节点的 JSON 元数据 |

**检索流程：**
```
查询向量 ──→ [向量索引层] ──→ Top-K 锚点
                                  │
                                  ▼
              [图谱扩散层] ──→ N 跳邻居（Spreading Activation）
                                  │
                                  ▼
                           最终排序结果
```

---

### search_advanced — 认知管线检索

内置九层认知管线的全功能入口。通过 `SearchConfig` 参数化控制 FISTA 残差寻隐、PPR 图扩散、DPP 多样性采样等高级特性。

**Python：**
```python
results = db.search_advanced(
    query_vector=[0.10, -0.48, 0.80, ...],
    top_k=10,
    expand_depth=2,
    min_score=0.1,
    teleport_alpha=0.15,          # PPR 回跳概率
    enable_advanced_pipeline=True, # 总开关
    enable_sparse_residual=True,   # FISTA 影子查询
    fista_lambda=0.1,
    fista_threshold=0.3,
    enable_dpp=True,               # DPP 多样性采样
    dpp_quality_weight=1.0,
)
for hit in results:
    print(f"[{hit.id}] score={hit.score:.3f} | {hit.payload}")
```

**Node.js：**
```javascript
const results = db.searchAdvanced(queryVector, {
    topK: 10,
    expandDepth: 2,
    teleportAlpha: 0.15,
    enableAdvancedPipeline: true,
    enableSparseResidual: true,
    enableDpp: true,
});
```

**Rust：**
```rust
use triviumdb::database::SearchConfig;

let config = SearchConfig {
    top_k: 10,
    expand_depth: 2,
    min_score: 0.1,
    teleport_alpha: 0.15,
    enable_advanced_pipeline: true,
    enable_sparse_residual: true,
    fista_lambda: 0.1,
    fista_threshold: 0.3,
    enable_dpp: true,
    dpp_quality_weight: 1.0,
};
let results = db.search_advanced(&query_vec, &config)?;
```

**SearchConfig 参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `top_k` | `usize` | `5` | 最终返回的结果数量 |
| `expand_depth` | `usize` | `2` | 图谱扩散跳数 |
| `min_score` | `f32` | `0.1` | 余弦相似度下限 |
| `teleport_alpha` | `f32` | `0.0` | PPR 回跳概率 (0.0~1.0)，越高越抑制深层扩散 |
| `enable_advanced_pipeline` | `bool` | `false` | 认知管线总开关，关闭时退化为普通检索 |
| `enable_sparse_residual` | `bool` | `false` | 启用 FISTA 残差寻隐 + 影子查询 |
| `fista_lambda` | `f32` | `0.1` | FISTA L1 正则化系数 |
| `fista_threshold` | `f32` | `0.3` | 残差范数超过此值时触发影子查询 |
| `enable_dpp` | `bool` | `false` | 启用 DPP 多样性采样 |
| `dpp_quality_weight` | `f32` | `1.0` | DPP 质量权重幂次 |
| `enable_text_hybrid_search`| `bool`| `false`| 是否开启 BM25/AC 双路混合搜索 |
| `text_boost` | `f32` | `1.5` | 文本混合查询分数提权倍率 |
| `hybrid_alpha` | `f32` | `0.7` | 混合检索中向量权重 (0~1)，(1-alpha) 为稀疏文本权重 |
| `custom_query_text` | `str`| `None` | (可选) 手动传入用于文本匹配的原始文本 |
| `force_brute_force` | `bool` | `false`| 强制使用暴力搜索，禁用 QuIVer 图索引（用于基准测试和需要精确结果的场景） |

> 💡 所有参数均内置安全钳位：`teleport_alpha` 被约束在 [0, 1]，`fista_lambda` 在 [1e-5, 100]，`dpp_quality_weight` 在 [0, 10]。传入越界值不会崩溃，而是被静默钳平。

> 💡 当 `enable_advanced_pipeline = false` 时，`search_advanced` 的行为与 `search` 完全一致。

---

## 🔌 Hook 扩展系统

TriviumDB v0.6.0 新增的检索管线 Hook 系统，允许开发者在 6 个关键阶段注入自定义逻辑，高度自定义检索管线。

### 管线 Hook 点整体架构

```text
  查询输入
      │
  🔌 #1 on_pre_search        — 查询预处理（改写向量 / 修改配置 / 提前终止）
      │
  🔌 #2 on_custom_recall     — 自定义召回（可替代内置召回）
      │
  ┌── 内置召回管线 ──┐
  │  L1 文本稀疏召回  │
  │  L2 向量稠密召回  │
  │  L3 布隆预过滤    │
  └──────────────────┘
      │
  🔌 #3 on_post_recall       — 召回后处理（业务过滤 / 分数调权）
      │
  🔌 #4 on_pre_graph_expand  — 图扩散前拦截
      │
  ┌── 图谱扩散 ──────┐
  │  L6 PPR 扩散      │
  │  L7 不应期/抑制    │
  └──────────────────┘
      │
  🔌 #5 on_rerank            — 自定义重排序
      │
  🔌 #6 on_post_search       — 最终后处理
      │
  返回结果
```

### load_ffi_hook — 加载 C/C++ 动态库插件

加载一个导出了 C ABI 符号的动态库（`.so` / `.dll` / `.dylib`）作为检索管线 Hook。动态库中的所有符号均为可选，未找到的符号将自动被无操作替代。

**Python：**
```python
db.load_ffi_hook("./libmy_plugin.so")
results = db.search(query_vec)  # 自动经过 C++ Hook
```

**Node.js：**
```javascript
db.loadFfiHook('./libmy_plugin.so')
const results = db.search(queryVec)  // 自动经过 C++ Hook
```

**Rust：**
```rust
use triviumdb::hook::FfiHook;

let ffi_hook = FfiHook::load("./libmy_plugin.so")?;
db.set_hook(ffi_hook);
```

### clear_hook — 清除已注册 Hook

清除当前的 Hook，恢复为默认的零开销 `NoopHook`。

**Python：**
```python
db.clear_hook()
```

**Node.js：**
```javascript
db.clearHook()
```

**Rust：**
```rust
db.clear_hook();
```

### search_with_context — 带管线上下文的检索

与 `search` 相同的检索能力，但额外返回 `HookContext` 对象，包含管线各阶段的计时统计和 Hook 注入的自定义数据。

**Python：**
```python
hits, ctx = db.search_with_context(
    query_vector=[0.10, -0.48, 0.80, ...],
    top_k=10,
    expand_depth=2,
    min_score=0.1,
)

print(ctx.timings)
# {'hook_pre_search': 0.012, 'hook_custom_recall': 0.001, 'graph_expand': 2.34, ...}

print(ctx.custom_data)   # Hook 注入的自定义数据
print(ctx.aborted)       # 管线是否被 Hook 提前终止
```

**Node.js：**
```javascript
const { hits, context } = db.searchWithContext(queryVec, {
    topK: 10,
    expandDepth: 2,
    minScore: 0.1,
})

console.log(context.timings)     // { hook_pre_search: 0.012, graph_expand: 2.34, ... }
console.log(context.customData)  // Hook 注入的自定义数据
console.log(context.aborted)     // 管线是否被提前终止
```

**Rust：**
```rust
use triviumdb::database::SearchConfig;

let config = SearchConfig {
    top_k: 10,
    expand_depth: 2,
    ..Default::default()
};
let (results, ctx) = db.search_hybrid_with_context(None, Some(&query_vec), &config)?;

for (stage, dur) in &ctx.stage_timings {
    println!("{}: {:.2}ms", stage, dur.as_secs_f64() * 1000.0);
}
```

### Rust 原生 Hook Trait

在 Rust 中，开发者可以直接实现 `SearchHook` trait 来创建自定义 Hook：

```rust
use triviumdb::hook::{SearchHook, HookContext};
use triviumdb::database::SearchConfig;
use triviumdb::node::SearchHit;

struct MyHook;

impl SearchHook for MyHook {
    fn on_pre_search(
        &self,
        query_vector: &mut Vec<f32>,
        config: &mut SearchConfig,
        ctx: &mut HookContext,
    ) {
        // 修改查询向量、调整配置等
        ctx.custom_data = serde_json::json!({"user_id": "u_12345"});
    }

    fn on_rerank(
        &self,
        results: &mut Vec<SearchHit>,
        _ctx: &mut HookContext,
    ) -> Option<Vec<SearchHit>> {
        // 自定义重排序逻辑
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        None // 返回 None 表示使用原地修改，返回 Some 替换结果
    }
}

// 注册 Hook
db.set_hook(MyHook);
```

> 💡 **零开销设计**：未注册 Hook 时，默认的 `NoopHook` 的所有方法均为空实现，编译器会将它们完全内联消除，对无 Hook 的普通检索完全零开销。

> ⚠️ **FFI 插件安全提示**：`FfiHook` 加载的动态库将在进程内执行任意代码，请确保动态库来源可信。

---

## 元数据过滤

### filter_where — 高级条件过滤

使用类 MongoDB 语法对所有节点的 Payload 进行条件过滤。返回匹配的 `NodeView` 列表。

**Python：**
```python
# 单条件
adults = db.filter_where({"age": {"$gt": 18}})

# 多条件组合
results = db.filter_where({
    "$and": [
        {"age": {"$lt": 30}},
        {"role": {"$in": ["admin", "mod"]}}
    ]
})

# OR 组合
results = db.filter_where({
    "$or": [
        {"age": {"$lt": 18}},
        {"role": "admin"}
    ]
})
```

**支持的操作符：**

| 操作符 | 含义 | 值类型 | 示例 |
|--------|------|--------|------|
| `$eq` | 等于 | 任意 | `{"name": {"$eq": "Alice"}}` 或直接 `{"name": "Alice"}` |
| `$ne` | 不等于 | 任意 | `{"status": {"$ne": "deleted"}}` |
| `$gt` | 大于 | 数字 | `{"age": {"$gt": 18}}` |
| `$gte` | 大于等于 | 数字 | `{"score": {"$gte": 0.8}}` |
| `$lt` | 小于 | 数字 | `{"age": {"$lt": 30}}` |
| `$lte` | 小于等于 | 数字 | `{"price": {"$lte": 99.9}}` |
| `$in` | 包含于列表 | 数组 | `{"role": {"$in": ["admin", "mod"]}}` |
| `$nin` | 不在列表中 | 数组 | `{"status": {"$nin": ["banned", "deleted"]}}` |
| `$startsWith` | 前缀匹配 | 字符串 | `{"folder": {"$startsWith": "/地理"}}` |
| `$contains` | 包含子串 | 字符串 | `{"tag": {"$contains": "重要"}}` |
| `$exists` | 字段是否存在 | 布尔 | `{"email": {"$exists": true}}` |
| `$size` | 数组长度 | 正整数 | `{"tags": {"$size": 3}}` |
| `$all` | 数组包含所有 | 数组 | `{"tags": {"$all": ["A", "B"]}}` |
| `$type` | 字段类型 | 字符串 | `{"age": {"$type": "number"}}` |
| `$and` | 逻辑与 | 条件数组 | `{"$and": [{...}, {...}]}` |
| `$or` | 逻辑或 | 条件数组 | `{"$or": [{...}, {...}]}` |

**字符串匹配示例（v0.7.1 新增）：**

```python
# 前缀匹配：匹配 /地理 及其所有子路径
results = db.filter_where({"folder": {"$startsWith": "/地理"}})

# 多前缀 OR 组合：匹配多个路径前缀
results = db.filter_where({
    "$or": [
        {"folder": {"$startsWith": "/地理"}},
        {"folder": {"$startsWith": "/天文"}}
    ]
})

# 子串包含
results = db.filter_where({"description": {"$contains": "关键词"}})

# search() 中使用 payload_filter 前缀过滤
results = db.search(
    query_vector=[0.1, ...],
    payload_filter={"folder": {"$startsWith": "/地理"}}
)
```

**Rust：**
```rust
use triviumdb::filter::Filter;

let filter = Filter::And(vec![
    Filter::Gt("age".into(), 18.0),
    Filter::In("role".into(), vec![json!("admin"), json!("mod")]),
]);
let results = db.filter_where(&filter);
```

---

## TQL 统一查询

### tql — 执行 TQL 只读查询

支持三种入口：MATCH（图遍历）/ FIND（文档过滤）/ SEARCH（向量检索）。

**Python：**
```python
# 图遍历
rows = db.tql('MATCH (a)-[:knows]->(b) WHERE b.age > 18 RETURN b')
for row in rows:
    node = row.row["b"]    # {"id": ..., "payload": {...}, "num_edges": ...}
    print(node["payload"])

# 文档过滤
rows = db.tql('FIND {type: "event", heat: {$gte: 0.7}} RETURN *')

# 带内联属性 + WHERE
rows = db.tql('MATCH (a {id: 1})-[]->(b) WHERE b.score >= 0.8 RETURN a, b')
```

**Node.js：**
```js
const rows = db.tql('MATCH (a)-[:knows]->(b) WHERE b.age > 18 RETURN b')
rows.forEach(row => console.log(row.b.payload))
```

**Rust：**
```rust
let rows = db.tql("MATCH (a)-[:knows]->(b) WHERE b.age > 20 RETURN b")?;
for row in &rows {
    if let Some(node) = row.get("b") {
        println!("{}: {:?}", node.id, node.payload);
    }
}
```

### tql_mut — 执行 TQL 写操作 (v0.6.0 新增)

支持 CREATE / SET / DELETE / DETACH DELETE 语法，返回受影响行数和新创建的节点 ID。

**Python：**
```python
# 创建节点
result = db.tql_mut('CREATE (a {name: "Alice", age: 30})')
print(result["affected"])      # 1
print(result["created_ids"])   # [1]

# 更新属性
db.tql_mut('MATCH (a {name: "Alice"}) SET a.age == 31')

# 删除节点
db.tql_mut('MATCH (a {name: "Alice"}) DELETE a')

# 删除节点及其所有关联边
db.tql_mut('MATCH (a {type: "temp"}) DETACH DELETE a')
```

**Node.js：**
```js
const result = db.tqlMut('CREATE (a {name: "Alice", age: 30})')
console.log(result.affected)     // 1
console.log(result.createdIds)   // [1]
```

**返回值：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `affected` | `int` | 受影响的节点数 |
| `created_ids` / `createdIds` | `list[int]` / `number[]` | CREATE 新建的节点 ID 列表 |

**语法规范：**

```
Query      := MATCH Pattern (WHERE Condition)? RETURN ReturnList
            | MATCH Pattern (WHERE Condition)? (SET SetExpr | DELETE Ident | DETACH DELETE Ident)
            | CREATE NodePat
            | FIND JsonFilter RETURN ReturnList
Pattern    := NodePat (EdgePat NodePat)*
NodePat    := '(' Ident? ('{' PropList '}')? ')'
EdgePat    := '-[' (':' Ident)? ']->' 
Condition  := CompareExpr ((AND | OR) CompareExpr)*
ReturnList := Ident (',' Ident)* | '*'
```

> 💡 当起始节点已知 ID 时，强烈建议将 `id` 写入节点属性过滤器。主键 `id` 走 **O(1) 哈希短路扫描**，而 `type` 等非主键字段会触发 O(N) 全表扫描（除非已建立属性索引）。

> 💡 当前仅支持**有向**边模式 `-[]->` ，不支持无向匹配或反向匹配。

---

## 属性二级索引

### create_index — 创建属性索引 (v0.6.0 新增)

对指定的 JSON Payload 字段建立 O(1) 倒排索引。创建时自动回填全表现有数据，后续 insert / update_payload / delete 自动维护索引一致性。

**Python：**
```python
db.create_index("name")    # 之后 tql('FIND {name: "Alice"} RETURN *') 使用 O(1) 索引
db.create_index("type")
```

**Node.js：**
```js
db.createIndex('name')
db.createIndex('type')
```

**Rust：**
```rust
db.create_index("name");
```

### drop_index — 删除属性索引 (v0.6.0 新增)

删除指定字段的索引。查询仍然可用，只是退化为 O(N) 全表扫描。

**Python：**
```python
db.drop_index("name")
```

**Node.js：**
```js
db.dropIndex('name')
```


## 持久化与压缩

### flush — 手动落盘

将当前内存中的全部数据写入 `.tdb` 文件。安全写入流程：先写临时文件 → fsync → 原子 rename → 清除 WAL。

**Python：**
```python
db.flush()
```

### WAL 同步模式

通过构造函数参数或运行时方法切换 WAL（Write-Ahead Log）的同步策略：

| 模式 | 安全性 | 性能 | 说明 |
|------|--------|------|------|
| `"full"` | ★★★ | 最慢 | 每条写入后 fsync，断电零丢失 |
| `"normal"` | ★★☆ | 均衡 | flush 到 OS 缓冲区，操作系统崩溃可能丢少量数据（**默认**） |
| `"off"` | ★☆☆ | 最快 | 不主动 flush，仅适合测试/批量导入 |

**运行时切换：**
```python
db.set_sync_mode("full")   # 切到最安全模式
db.set_sync_mode("off")    # 批量导入时临时提速
```

### enable_auto_compaction — 后台自动压缩

启动后台守护线程，定时在后台串行化执行数据压缩与全量落盘（包含 `flush` + WAL 截断清理）。

**Python：**
```python
db.enable_auto_compaction(interval_secs=30)  # 每 30 秒后台自动落盘
db.disable_auto_compaction()                 # 停止后台压缩线程
```

**Rust：**
```rust
db.enable_auto_compaction(Duration::from_secs(30));
db.disable_auto_compaction();
```

### compact — 手动强制压实 (Manual Compaction)

主动触发一次全量数据重写与压实。**此调用会阻塞当前线程**，直到所有的内存数据被安全落盘，并彻底截断清理旧的 WAL 文件。
为了极致的崩溃安全性，执行压实时会短暂阻塞前台读写。强烈建议在关闭了自动压缩后，于业务低峰期（如凌晨调度）执行此方法。

**Python：**
```python
db.compact()
```

**Rust：**
```rust
db.compact()?;
```


---

## 内存管理

### set_memory_limit — 内存预算控制

设置 MemTable 内存使用上限。当估算内存超过限额时，写操作完成后自动触发 flush。

**Python：**
```python
db.set_memory_limit(mb=256)  # 限制为 256 MB
db.set_memory_limit(mb=0)    # 取消限制（默认）
```

### estimated_memory — 查询当前内存占用

**Python：**
```python
usage_bytes = db.estimated_memory()
print(f"当前内存占用: {usage_bytes / 1024 / 1024:.1f} MB")
```

---

## 文本索引与稀疏检索

### index_text — 建立全文稀疏索引
对指定节点的长文本内容提取 BM25 特征，用于后续的混合检索召回。需在节点 insert 后调用。

**Python：**
```python
db.index_text(id=42, text="Rust 在嵌入式领域取得突破")
```

### index_keyword — 建立精确关键词索引
建立基于 AC 自动机 (Aho-Corasick) 的精确词汇匹配索引，极速锁定特征锚点。

**Python：**
```python
db.index_keyword(id=42, keyword="Rust")
```

### build_text_index — 编译倒排字典树
在数据初始化批量调用完毕后，**必须调用此方法**完成底层 AC 自动机的编译与全局文本 IDF 频率汇算。之后方可进行 `search_hybrid` 混合检索。

**Python：**
```python
db.build_text_index()
```

---

## 工具方法

### all_node_ids — 获取全部节点 ID

返回当前数据库中所有活跃节点的 ID 列表（顺序不定）。可用于遍历全库或批量操作。

**Python：**
```python
ids = db.all_node_ids()          # 返回 list[int]
print(f"共 {len(ids)} 个节点")
```

**Rust：**
```rust
let ids = db.all_node_ids();     // Vec<NodeId>
```

### QuIVer 自动索引说明

TriviumDB v0.7.0 起采用自研的 **QuIVer** SOTA 级 ANN 图索引，全自动双引擎向量索引路由，无需手动 `rebuild_index()` 接口：

| 条件 | 检索引擎 | 召回行为 |
|------|----------|----------|
| < 1 万节点 或 QuIVer 未就绪 | **BruteForce** | 100% 精确召回，零误差 |
| ≥ 1 万节点 + 索引就绪 | **QuIVer (BQ + Vamana)** | BQ 签名 + 图导航 + f32 精排，Recall@10 > 97% |

QuIVer 索引支持增量 Insert/Delete/Update，无需全量重建。索引以独立的 `.tdb.quiver` 文件持久化，重启后零延迟恢复。

> 💡 如果你的业务对 100% 召回率有强需求（如金融/医疗），可以通过 `force_brute_force: true` 强制使用 BruteForce。

---

## 维度迁移

当需要更换 Embedding 模型（维度发生变化）时，使用 `migrate` 将旧库的结构迁移到新维度。

### migrate — 迁移到新维度

将当前数据库的所有节点 Payload、图谱边复制到一个全新的数据库文件中，向量以零向量占位（因为维度变了，旧向量无法直接复用）。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `new_path` | `str` | 新数据库文件路径 |
| `new_dim` | `int` | 新的向量维度 |

**返回值：** 所有已迁移节点的 ID 列表（`list[int]`）

**Python：**
```python
# 第一步：迁移结构（保留 payload + 边，向量置零）
with triviumdb.TriviumDB("old.tdb", dim=768) as old_db:
    node_ids = old_db.migrate("new.tdb", new_dim=1536)

# 第二步：打开新库，用新模型逐节点更新向量
with triviumdb.TriviumDB("new.tdb", dim=1536) as new_db:
    for nid in node_ids:
        payload = new_db.get(nid).payload
        new_vec = new_model.encode(payload["text"]).tolist()
        new_db.update_vector(new_vec, nid)
```

**Rust：**
```rust
// 迁移结构
let (mut new_db, node_ids) = old_db.migrate_to("new.tdb", 1536)?;

// 更新向量
for &nid in &node_ids {
    let new_vec = new_model.encode(&payload_map[&nid]);
    new_db.update_vector(nid, &new_vec)?;
}
new_db.flush()?;
```

> ⚠️ 迁移不修改原数据库，原库仍可正常使用。新库创建完毕后，需要手动更新所有向量后才能进行有效的向量检索。

> 💡 如果希望同时切换 dtype（例如从 f32 换 f16），需在创建新库时指定 `dtype` 参数：`TriviumDB("new.tdb", dim=1536, dtype="f16")`。

## 事务支持 (Rust Only)

TriviumDB 提供轻量级事务，采用**验证前置（Dry-Run）架构**：所有操作先缓冲在内存中，`commit()` 分两阶段执行——首先在纯内存验证全部约束（维度、节点存在性、ID 冲突），全部通过后才一次性写入。

**特性：**
- `commit()` 返回 `Err` 时，**底层数据没有被修改一个字节**，可加入日志后安全重试
- 在同一事务内，`insert_with_id(999)` 后立即 `link(..., 999)` 是完全合法的（虚拟状态叠加给 999 号打过标记）
- `rollback()`（或直接 `drop` 事务对象）将丢弃所有缓冲操作

```rust
let mut tx = db.begin_tx();
tx.insert(&vec1, json!({"type": "event"}));
tx.insert_with_id(9999, &vec2, json!({"type": "person"}));
tx.link(1, 9999, "attended", 1.0);

// 原子提交 → 两阶段: 干跑验证 → 物理写入
let ids = tx.commit()?;

// 或显式回滚（丢弃所有操作）
// tx.rollback();
```

> ⚠️ 事务目前仅在 Rust API 中可用，Python 侧暂未暴露。

---

## Pythonic 魔术方法

| 语法 | 等价调用 | 说明 |
|------|----------|------|
| `len(db)` | `db.node_count()` | 当前活跃节点数 |
| `42 in db` | `db.contains(42)` | 节点是否存在 |
| `print(db)` | `db.__repr__()` | 输出如 `TriviumDB(dtype=f32, nodes=100, dim=1536)` |
| `with db:` | `__enter__` / `__exit__` | 退出时自动 `flush()` |

---

## 数据类型说明

### NodeView

节点的完整视图，通过 `get()` 或 `filter_where()` 返回。

| 属性 (Python) | 属性 (Rust) | 类型 | 说明 |
|---------------|-------------|------|------|
| `id` | `id` | `u64` | 全局唯一节点 ID |
| `vector` | `vector` | `list[float]` / `Vec<T>` | 节点的特征向量 |
| `payload` | `payload` | `dict` / `serde_json::Value` | JSON 元数据 |
| `edges` | `edges` | `list[Edge]` / `Vec<Edge>` | 详细出边列表（包含 target_id, label, weight） |
| `num_edges` | `edges.len()` | `int` / `usize` | 快速获取出边数量 |

### SearchHit

向量检索命中结果，通过 `search()` 返回。

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `u64` | 命中节点 ID |
| `score` | `f32` | 相似度得分 |
| `payload` | `dict` | 节点元数据 |

### QueryRow

Cypher 查询结果行，通过 `query()` 返回。

| 属性 | 类型 | 说明 |
|------|------|------|
| `row` | `dict[str, dict]` | 变量名 → 节点摘要字典 |

### Edge (Rust)

图谱边的内部结构。

| 字段 | 类型 | 说明 |
|------|------|------|
| `target_id` | `NodeId (u64)` | 目标节点 ID |
| `label` | `String` | 关系类型标签 |
| `weight` | `f32` | 权重（支持负值） |

### HookContext

Hook 管线执行上下文，通过 `search_with_context()` 返回。

| 属性 (Python) | 属性 (Node.js) | 属性 (Rust) | 类型 | 说明 |
|---------------|----------------|-------------|------|------|
| `timings` | `timings` | `stage_timings` | `dict` / `Object` / `Vec<(String, Duration)>` | 各管线阶段的耗时（Python/JS 单位毫秒） |
| `custom_data` | `customData` | `custom_data` | `dict` / `Object` / `serde_json::Value` | Hook 注入的自定义数据 |
| `aborted` | `aborted` | `abort` | `bool` | 管线是否被 Hook 提前终止 |

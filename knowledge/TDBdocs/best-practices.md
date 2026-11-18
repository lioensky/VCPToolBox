# TriviumDB 最佳实践

> 高效使用 TriviumDB 的实战指南：从项目集成到性能调优，从数据建模到避坑指南。

---

## 目录

- [快速集成](#快速集成)
- [选择存储模式](#选择存储模式)
- [数据建模范式](#数据建模范式)
- [性能调优](#性能调优)
- [可靠性保障](#可靠性保障)
- [事务最佳实践](#事务最佳实践)
- [Cypher 查询最佳实践](#cypher-查询最佳实践)
- [常见使用模式](#常见使用模式)
- [避坑指南](#避坑指南)
- [模型升级与维度迁移](#模型升级与维度迁移)
- [QuIVer 索引策略与调优](#quiver-索引策略与调优)
- [Hook 扩展系统最佳实践](#hook-扩展系统最佳实践)
- [架构边界认知与规避策略](#架构边界认知与规避策略)

---

## 快速集成

TriviumDB 核心使用极致性能的 Rust 编写，但官方已经为各类平台环境预先编译并发布了底层扩展包。**无需在本地配置和折腾任何编译工具链！**

### Node.js / TypeScript 环境搭建

NPM 包内部自带 `triviumdb.d.ts` 提供全量的 TS 类型注解，支持主流全栈框架。

```bash
# 推荐使用 NPM 或者 PNPM 一键提包：
npm install triviumdb

# 验证安装
node -e "console.log(require('triviumdb').TriviumDB.name)"
```

### Python 环境搭建

直接通过 PyPI 拉取原生交叉编译后的 Wheel 包。

```bash
# 推荐使用超快速的 uv (支持 3.9 ~ 3.12)
uv pip install triviumdb

# 或者传统 pip
pip install triviumdb

# 验证安装
python -c "import triviumdb; print('OK')"
```

### Rust 项目集成（原生模式）

你可以直接通过 `cargo add` 命令快速引入最新版本：

```bash
cargo add triviumdb
```

在 `Cargo.toml` 中也会自动生成如下配置：

```toml
[dependencies]
triviumdb = "0.7.0" 
```

### 30 秒入门模板

```python
import triviumdb

with triviumdb.TriviumDB("my_app.tdb", dim=768) as db:
    # 插入
    id1 = db.insert([0.1] * 768, {"text": "第一条记忆", "ts": 1711440000})
    id2 = db.insert([0.2] * 768, {"text": "第二条记忆", "ts": 1711450000})
    
    # 建立关系
    db.link(id1, id2, label="caused_by", weight=0.9)
    
    # 混合检索
    results = db.search([0.15] * 768, top_k=3, expand_depth=1)
    for hit in results:
        print(f"[{hit.id}] {hit.score:.3f} | {hit.payload}")
# 退出 with 块时自动 flush 落盘
```

---

## 选择存储模式

TriviumDB v0.4 引入了 **Rom / Mmap 双存储引擎**，在打开数据库时通过 `Config` 选择（Rust 原生 API），**两者可以随时热切换**，下一次 `flush()` 时会自动转换磁盘格式。

| 模式 | 启动开销 | 内存占用 | 磁盘文件 | 推荐场景 |
|------|----------|----------|----------|----------|
| **Rom（单文件）** | O(N) 全量加载 | = 数据体积 | 单一 `.tdb` | 知识库 < 50 万节点、需要一键打包转移 |
| **Mmap（分离，默认）** | ~O(1) 映射 | ≈ 增量 + 工作集 | `.tdb` + `.vec` | 超大规模数据、追求冷启动性能 |

```rust
use triviumdb::database::{Database, Config, StorageMode};

// Rom 模式（单文件便携）
let db = Database::<f32>::open_with_config("agent.tdb", Config {
    dim: 1536,
    storage_mode: StorageMode::Rom,
    ..Default::default()
})?;

// Mmap 模式（默认，适合大规模）
let db = Database::<f32>::open("huge_kb.tdb", 1536)?;
```

### 模式热切换（无需任何数据迁移脚本）

```rust
// 这个库最初是 Mmap 模式建的，想打包发给别人
// 只需以 Rom 模式重新打开，flush 一次即可
let mut db = Database::<f32>::open_with_config("agent.tdb", Config {
    dim: 1536,
    storage_mode: StorageMode::Rom, // 声明目标状态
    ..Default::default()
})?;
db.flush()?;  // 引擎自动完成: 向量解封 → 写入单 .tdb → 删除旧 .vec
```

---

## 数据建模范式

### 范式一：扁平记忆（最简单）

每条记忆/事件作为独立节点，不建边。适合纯语义搜索场景。

```python
db.insert(encode("今天天气真好"), {"type": "memory", "date": "2024-03-26"})
db.insert(encode("吃了一碗拉面"), {"type": "memory", "date": "2024-03-26"})
# 查询时只用向量检索
results = db.search(encode("天气"), top_k=5, expand_depth=0)
```

### 范式二：实体-关系图（推荐）

为每类实体创建节点，用边表达它们之间的关系。发挥 TriviumDB 的图谱扩散优势。

```python
# 实体节点
person_a  = db.insert(encode("小明"), {"type": "person", "name": "小明"})
person_b  = db.insert(encode("小红"), {"type": "person", "name": "小红"})
place     = db.insert(encode("星巴克三里屯店"), {"type": "place", "name": "星巴克"})
event     = db.insert(encode("小明和小红在星巴克喝咖啡"), {
    "type": "event", "date": "2024-03-26", "summary": "喝咖啡"
})

# 关系边
db.link(event, person_a, label="participant", weight=1.0)
db.link(event, person_b, label="participant", weight=1.0)
db.link(event, place,    label="location",    weight=1.0)
db.link(person_a, person_b, label="friend",   weight=0.8)
db.link(person_b, person_a, label="friend",   weight=0.8)  # 双向

# 检索："谁在喝咖啡？" → 找到事件 → 扩散到人物和地点
results = db.search(encode("喝咖啡"), top_k=3, expand_depth=2)
```

### 范式三：关系具象化（高级）

当关系本身也需要被语义检索时，将关系升格为节点。

```python
# "小明擅长编程" 这个关系本身也是一条可搜索的知识
relation = db.insert(
    encode("擅长编程"),
    {"type": "relation", "label": "skill", "confidence": 0.95}
)
db.link(person_a, relation, label="rel_src", weight=1.0)
db.link(relation, skill_node, label="rel_dst", weight=1.0)
```

### 节点设计 Checklist

| 决策点 | 建议 |
|--------|------|
| `type` 字段 | **必加**。方便按类型过滤：`filter_where({"type": "person"})` |
| `created_at` 字段 | **推荐**。支持时间范围过滤和数据清理 |
| 向量维度 | 与你使用的 embedding 模型对齐（如 OpenAI = 1536, BGE = 768） |
| 边的 label | 使用清晰的英文标签。保持项目内一致 |
| 边的 weight | `0.0~1.0` 表示强弱关联；负值表示抑制关系 |

---

## 性能调优

### 选择合适的 dtype

```python
# 标准场景（推荐）
db = triviumdb.TriviumDB("data.tdb", dim=768, dtype="f32")

# 大规模场景：内存减半，精度损失 < 1%
db = triviumdb.TriviumDB("data.tdb", dim=768, dtype="f16")

# SimHash / 指纹类场景
db = triviumdb.TriviumDB("data.tdb", dim=64, dtype="u64")
```

### 批量写入优化

批量导入大量数据时，临时关闭 WAL 同步可大幅提速：

```python
with triviumdb.TriviumDB("data.tdb", dim=768, sync_mode="off") as db:
    # 批量插入（sync_mode=off 跳过每次写入的 fsync）
    ids = db.batch_insert(
        vectors=all_vectors,
        payloads=all_payloads
    )
    # 全部写完后手动 flush 一次（退出 with 块时也会自动 flush）
    db.flush()
```

> ⚠️ `sync_mode="off"` 期间如果进程崩溃，未 flush 的数据**可能丢失**。仅在初始批量导入时使用。

### 内存预算控制

长时间运行的服务应设置内存上限，避免 MemTable 无限膨胀：

```python
db.set_memory_limit(mb=512)  # 超过 512MB 自动触发 flush
```

### 搜索参数调优

| 参数 | 调大效果 | 调小效果 |
|------|----------|----------|
| `top_k` | 更多候选 → 更高召回率 | 更少候选 → 更快响应 |
| `expand_depth` | 更深扩散 → 发现更远关联 | 更浅扩散 → 避免噪声 |
| `min_score` | 更严格 → 结果更精准 | 更宽松 → 结果更多 |

**推荐起步参数：**
```python
db.search(query_vec, top_k=10, expand_depth=1, min_score=0.5)
```

### Compaction 策略

| 场景 | 推荐配置 |
|------|----------|
| 生产服务（持续写入） | `db.enable_auto_compaction(interval_secs=7200)` (默认 2 小时) |
| 批量导入（一次性） | 不启用，导入完成后手动 `flush()` |
| 延迟极敏感服务 | `db.enable_auto_compaction(interval_secs=86400)` (每天 1 次) |

### 认知管线 (search_advanced) 开关策略

| 场景 | 建议配置 |
|------|----------|
| 纯向量检索（不需要深层认知） | 直接用 `search()`，完全不涉及管线开销 |
| 向量 + 图扩散（轻量认知） | `search_advanced(enable_advanced_pipeline=True, enable_dpp=False)` |
| 全流程认知探索（发现隐藏记忆） | `enable_sparse_residual=True` + `enable_dpp=True` |
| 非常复杂的跨领域记忆查询 | 低 `fista_threshold`（如 0.15）+ 高 `teleport_alpha`（如 0.2）|

```python
# “简单问答”场景：纯向量 + 图扩散，不需要 FISTA/DPP
results = db.search(query_vec, top_k=5, expand_depth=2)

# “深度回忆”场景：开启全管线，类似“挑重点+去重复”
results = db.search_advanced(
    query_vec, top_k=10, expand_depth=2,
    enable_advanced_pipeline=True,
    enable_sparse_residual=True,  # 挖掘隐藏记忆
    enable_dpp=True,              # 保证结果多样性
)
```

---

## 可靠性保障

### 数据安全等级选择

| 场景 | sync_mode | auto_compaction | 说明 |
|------|-----------|-----------------|------|
| 金融级零丢失 | `"full"` | 60s | 每次写入 fsync，性能最低 |
| 生产服务（推荐） | `"normal"` | 60s | 均衡方案，OS 崩溃可能丢最近几条 |
| 开发/测试 | `"off"` | 关闭 | 最快，不保证持久化 |
| 批量导入 | `"off"` → `"normal"` | 关闭 | 导入时提速，完成后切回 |

### 正确关闭数据库

```python
# ✅ 推荐：使用 with 语句
with triviumdb.TriviumDB("data.tdb", dim=768) as db:
    # ... 操作 ...
    pass  # 退出时自动 flush

# ✅ 手动关闭
db = triviumdb.TriviumDB("data.tdb", dim=768)
# ... 操作 ...
db.flush()  # 必须手动调用！

# ❌ 错误：不调用 flush 就退出 → WAL 里的数据下次重启才会回放
```

### 文件锁冲突处理

TriviumDB 使用独占文件锁防止多进程并发写入。如果遇到锁冲突：

```
RuntimeError: Database 'data.tdb' is already opened by another process.
If this is unexpected, delete 'data.tdb.lock'
```

**解决方法：**
1. 确认没有其他进程在使用该数据库
2. 如果进程异常退出残留了锁文件，手动删除 `data.tdb.lock`

### 为什么采用全独占锁定（Exclusive Lock）？

这主要是由于 TriviumDB 的底层架构定位与内存特性决定的：

1. **Agent 私有记忆仓库的定位**：TriviumDB 的核心使用场景是为每一个 AI Agent 或本地应用分配独立专属的“记忆仓库”。在绝大多数情况下，一个 Agent 不会在文件级别与外部毫无关联的进程“共享同一个脑子”。
2. **Mmap 内存映射的一致性边界**：由于底层采用了 `Mmap` 模式将多达 GB 级的向量文件直接映射入进程的虚拟内存空间，如果在缺乏复杂协调中心的情况下允许多个进程同时改写同一物理文件，要保持它们之间的内存状态完全同步（例如让进程 B 实时知晓进程 A 刚更新了某一块页表内存）工程复杂度将会呈指数级上升。

相比引入重型的跨进程内存通信与多版本控制架构（这会使其直接变成一头 MySQL 级别的庞然大物），TriviumDB 选择了**“极其精简与安全第一”**的全文件级独占锁定策略，以换取极小的二进制体积、极速的启动加载与随手拷贝的零运维体验。

**如果确实存在多端读写或高并发共享的需求，请遵循嵌入式数据库的最佳实践：多线程调度、读写仲裁、锁的抢占等复杂机制，应由外部业务逻辑或应用服务进行设计（如通过单例模式封装连接池，或在应用程序外层架设统一的 RESTful API 网关代理）。存储引擎本身的职责是坚守绝对的数据一致性边界。**

---

## 事务最佳实践

TriviumDB 的事务（`begin_tx()`）采用**验证前置（Dry-Run）架构**：`commit()` 分为两个严格的阶段执行，任何错误都会在第一阶段被提前拦截，不会产生部分写入污染。

### 事务的典型用法

```rust
let mut tx = db.begin_tx();

// 第 1 步：缓冲操作（纯内存，零开销）
let person_id = tx.next_id();   // 预测将要分配的 ID
tx.insert(&vec1, json!({"type": "person", "name": "Alice"}));
tx.insert_with_id(9999, &vec2, json!({"type": "event"}));
tx.link(person_id, 9999, "attended", 1.0);

// 第 2 步：commit 两阶段执行
// 阶段 1: 干跑验证 → 维度 OK？节点存在？ID 未冲突？
// 阶段 2: 验证通过后一次性物理写入，不会中途失败
let ids = tx.commit()?;
```

### 事务内 insert_with_id 后立即 link：完全安全

由于干跑阶段有虚拟状态叠加（`pending_ids`），在同一个事务里先 `insert_with_id(999)`，再 `link(999, ...)` 是完全合法的——验证器能感知到 999 将要存在。

```rust
let mut tx = db.begin_tx();
tx.insert_with_id(999, &vec, json!({"name": "新节点"}));
tx.link(1, 999, "relates_to", 0.8);  // ✅ 合法，999 在事务内已被追踪
let _ = tx.commit()?;
```

### 只有逻辑错误才会让 commit() 失败

| 失败原因 | 说明 |
|----------|------|
| `DimensionMismatch` | 插入的向量维度与 `dim` 不符 |
| `NodeNotFound` | `link`/`delete`/`update` 引用了不存在的 ID |
| ID 已存在 | `insert_with_id` 的 ID 在已有库或同事务中重复 |

> ✅ 任何 `commit()` 返回的 `Err` 都意味着底层数据完全未被修改，可以安全重试或放弃。

---

## TQL 查询最佳实践

### 优先使用 ID 锚定，避免全表扫描

TQL 执行器针对主键 `id` 内联了 O(1) 短路扫描优化。**每当起始节点是已知 ID 时，一定要将 `id` 写入节点属性过滤器**，这比直接使用 `type` 等 Payload 字段快上几个数量级。

```python
# 💡 推荐：AI Agent 的标准使用流程
# 1. 用语义向量盲搜，取得锚点 ID
results = db.search(encode("小明和小红的咖啡馆"), top_k=1)
anchor_id = results[0].id   # 拿到了准确的 ID，如 42

# 2. 以 ID 精准起跳 TQL → O(1) 定位 + 图谱扩散
rows = db.tql(f'MATCH (a {{id: {anchor_id}}})-[:participant]->(b) RETURN b')

# ❌ 避免（触发 O(N) 全表扫描，除非已对 type 建立属性索引）
# db.tql('MATCH (a {type: "event"})-[:participant]->(b) RETURN b')

# ✅ 如果确实需要按字段查询，先建索引
db.create_index("type")   # O(1) 倒排加速
rows = db.tql('FIND {type: "event"} RETURN *')  # 自动使用索引
```

### 使用 tql_mut 进行结构化写操作

v0.6.0 新增的 `tql_mut` 提供声明式写操作，适合批量修改和条件删除：

```python
# 批量创建节点
for name in ["Alice", "Bob", "Charlie"]:
    db.tql_mut(f'CREATE (a {{name: "{name}", type: "person"}})')

# 条件更新
db.tql_mut('MATCH (a {name: "Alice"}) SET a.role == "admin"')

# 条件删除（带关联边清理）
db.tql_mut('MATCH (a {type: "temp"}) DETACH DELETE a')
```

### 三种获取 ID 的方式

| 方式 | 获取时机 | 说明 |
|------|----------|------|
| `insert()` 返回值 | 插入节点时 | 引擎自动分配，调用方必须自行保存 |
| `insert_with_id(my_id, ...)` | 插入时 | 业务侧使用自己的主键（如数据库 UID、雪花 ID）直接指定 |
| `search()` 结果的 `result.id` | 向量语义搜索时 | 最常用的 AI Agent 工作流——先盲搜锚定，再 TQL 扩散 |

---


### 模式一：AI Agent 长期记忆

```python
def store_memory(db, text, embedding_model, metadata=None):
    """将一段对话/观察存入记忆库"""
    vec = embedding_model.encode(text).tolist()
    payload = {"text": text, "ts": time.time(), "type": "memory"}
    if metadata:
        payload.update(metadata)
    return db.insert(vec, payload)

def recall(db, query_text, embedding_model, top_k=5, depth=2):
    """根据查询文本召回相关记忆"""
    vec = embedding_model.encode(query_text).tolist()
    return db.search(vec, top_k=top_k, expand_depth=depth, min_score=0.4)
```

### 模式二：知识库 + 图谱导航

```python
# 两种检索方式并存
# 方式 A：语义搜索 → 精准定位
results = db.search(encode("Python 异步编程"), top_k=5)

# 方式 B：图谱查询 → 结构化导航
rows = db.tql('MATCH (a {type: "concept"})-[:related]->(b) RETURN b')
```

### 模式三：更新边权而非覆盖

由于 `unlink` 会断开源节点到目标节点的**所有**边，更新特定类型的边权重需要谨慎：

```python
def update_edge_weight(db, src, dst, label, new_weight):
    """安全地更新特定边的权重"""
    # 先查看当前所有边（通过 get 获取 node 的 edges 信息）
    db.unlink(src, dst)
    db.link(src, dst, label=label, weight=new_weight)
```

> ⚠️ 如果同一对 (src, dst) 之间有多种 label 的边，`unlink` 会全部断开。
> 建议同一对节点之间只建立一条边，用 label 区分类型。

### 模式四：定期清理过期数据

```python
import time

# 找出 7 天前的旧数据
cutoff = time.time() - 7 * 86400
old_nodes = db.filter_where({"ts": {"$lt": cutoff}})

# 逐个删除（三层联删，自动清理关联的边和向量）
for node in old_nodes:
    db.delete(node.id)

db.flush()  # 落盘
```

### 模式五：终极管线（双路混合锚定 + 图扩散 + 认知强化管线）

这是 TriviumDB 解决复杂 AI 幻觉和深层逻辑发掘的“杀手锏”级用法。它在一个 O(1) 的上层接口调用中，同时榨干了底层所有的特性引擎：
1. **双路锚定**：文本稀疏索引精确锁定专有名词（保证不偏题）；稠密向量锁定深层语义（保证能泛化）。
2. **图谱扩散**：从锚点出发，沿实体与事件的图结构发生 N 跳化学反应式传播。
3. **数学强化 (认知管线)**：利用 FISTA 稀疏残差算子找寻未被直接提及的潜台词，利用 DPP (行列式点过程) 矩阵推导进行多角度的极度多样化采样。

```python
# 假设我们正在为一个高级 AI 提取上下文
results = db.search_advanced(
    query_vector=encode("昨天那个红色头发的女孩是不是又在生气？"),
    top_k=8,
    expand_depth=2,                 # 第一步图游走深度（必须开启）
    
    # 启用文本/向量双路混合召回 (防幻觉关键)
    enable_text_hybrid_search=True,
    custom_query_text="红色头发 女孩 生气", 
    hybrid_alpha=0.6,               # 60%看总体向量语义，40%看倒排词频匹配
    
    # 启用数学强化认知
    enable_advanced_pipeline=True,
    enable_sparse_residual=True,    # FISTA 影子查询发现隐藏潜台词
    fista_threshold=0.2,            
    enable_dpp=True,                # DPP 矩阵多样性脱水
)

# 打印出的命中结果不仅包含最精准的记录，还因为残差与图扩散，包含了极其发散但逻辑自洽的深层原因！
```

---

## 避坑指南

### ❌ 坑 1：维度不匹配

```python
db = triviumdb.TriviumDB("data.tdb", dim=768)
db.insert([0.1] * 512, {"text": "hello"})  # 💥 DimensionMismatch!
```

**规则**：`dim` 在创建数据库时确定，之后所有 insert / update_vector / search 的向量长度**必须等于 dim**。

### ❌ 坑 2：忘记 flush

```python
db = triviumdb.TriviumDB("data.tdb", dim=768)
db.insert([0.1] * 768, {"text": "important data"})
# 程序退出... 数据可能只在 WAL 里，下次重启才回放！
```

**解决**：始终使用 `with` 语句，或在程序退出前调用 `db.flush()`。

### ❌ 坑 3：对已删除节点建边

```python
db.delete(42)
db.link(1, 42, label="ref")  # 💥 NodeNotFound!
```

**规则**：`link` 要求两个端点都必须存在。已删除的节点不能作为边的端点。

### ❌ 坑 4：unlink 的范围比预期大

```python
db.link(1, 2, label="friend", weight=0.8)
db.link(1, 2, label="colleague", weight=0.5)
db.unlink(1, 2)  # ⚠️ 两条边都被断开了！
```

**规则**：`unlink(src, dst)` 会移除 src → dst 之间的**全部**边，不区分 label。

### ❌ 坑 5：多进程同时打开

```python
# 进程 A
db_a = triviumdb.TriviumDB("shared.tdb", dim=768)

# 进程 B（同时）
db_b = triviumdb.TriviumDB("shared.tdb", dim=768)  # 💥 文件锁冲突!
```

**规则**：TriviumDB 是嵌入式数据库，同一个 `.tdb` 文件同一时刻只能被一个进程打开。如需多进程访问，请在应用层实现读写代理。

---

## 模型升级与维度迁移

当你需要切换 Embedding 模型（导致向量维度变化）时，不必重建整个数据库——使用 `migrate()` 保留全部 Payload 和图谱结构。

### 标准迁移流程

```python
import triviumdb

OLD_DIM = 768    # 旧模型维度（如 BGE-small）
NEW_DIM = 1536   # 新模型维度（如 OpenAI text-embedding-3-small）

# 第一步：迁移结构（payload + 图谱边保留，向量置零）
with triviumdb.TriviumDB("knowledge.tdb", dim=OLD_DIM) as old_db:
    node_ids = old_db.migrate("knowledge_v2.tdb", new_dim=NEW_DIM)
    print(f"结构迁移完成，共 {len(node_ids)} 个节点待更新向量")

# 第二步：打开新库，用新模型逐节点重新编码
with triviumdb.TriviumDB("knowledge_v2.tdb", dim=NEW_DIM) as new_db:
    for nid in node_ids:
        node = new_db.get(nid)
        if node and "text" in node.payload:
            new_vec = new_model.encode(node.payload["text"]).tolist()
            new_db.update_vector(new_vec, nid)
    print("向量更新完成")
# 退出 with 自动 flush
```

### 迁移注意事项

| 注意点 | 说明 |
|--------|------|
| 原库不受影响 | `migrate()` 只读原库，不会修改或删除任何数据 |
| 新库初始不可检索 | 迁移后所有向量为零，必须先更新向量才能进行语义搜索 |
| 图谱关系完整保留 | 所有 `link()` 建立的边、label、weight 全部复制到新库 |
| 同时换 dtype | 建以 `TriviumDB("new.tdb", dim=NEW_DIM, dtype="f16")` 创建新库后再迁移 |
| 大库分批更新向量 | 每更新 1000 个节点手动 `flush()` 一次，避免内存积压 |

---

## QuIVer 索引策略与调优

TriviumDB v0.7.0 起采用自研的 **QuIVer**（Quantized Indexed Vector Retrieval）SOTA 级 ANN 图索引，开发者**无需也无法手动触发重建**。了解以下策略可以取得最佳检索效果。

### QuIVer 自动激活条件

| 条件 | 检索引擎 | 行为 |
|------|----------|------|
| < 1 万节点 | **BruteForce** | 100% 精确召回 |
| ≥ 1 万节点 + 首次构建完成 | **QuIVer (BQ + Vamana)** | BQ 签名 + 图导航 + f32 精排，Recall@10 > 97% |

### 快速达到 QuIVer 激活

```python
# 1. 打开数据库
with triviumdb.TriviumDB("data.tdb", dim=1536) as db:
    # 2. 导入 >= 1 万条数据
    db.batch_insert(vectors_10k, payloads_10k)
    # 3. flush —— QuIVer 索引将在首次查询时自动构建
    db.flush()
```

### 高精度场景：强制绕过 QuIVer

如果业务对 100% 召回率有强要求（如金融风控、医疗诊断），可以用 `force_brute_force` 强制走 BruteForce：

```rust
let config = SearchConfig {
    top_k: 10,
    force_brute_force: true,  // 强制 BruteForce 100% 精确检索
    ..Default::default()
};
let results = db.search_hybrid(None, Some(&query_vec), &config)?;
```

---

## Hook 扩展系统最佳实践

TriviumDB v0.6.0 引入的 Hook 系统让开发者在构建 RAG 系统时拥有了对检索管线的深度定制能力。以下是高效使用 Hook 的实战指南。

### 场景一：管线性能诊断

最基础也是最常用的 Hook 场景——使用 `search_with_context()` 获取管线各阶段的执行耗时。

```python
# 不需要编写任何 Hook 代码，直接使用 search_with_context
hits, ctx = db.search_with_context(
    query_vector=query_vec,
    top_k=10,
    expand_depth=2,
)

# 打印管线各阶段耗时
print("=== 管线性能报告 ===")
for stage, ms in ctx.timings.items():
    bar = "█" * int(ms)  # 简单柱状图
    print(f"  {stage:25s} {ms:7.2f}ms {bar}")

# 典型输出：
#   hook_pre_search              0.01ms █
#   hook_custom_recall           0.00ms
#   graph_expand                 2.34ms ██
#   hook_rerank                  0.00ms
#   hook_post_search             0.00ms
```

> 💡 即使没有注册任何 Hook，`search_with_context` 也会返回内置管线阶段的计时。它是零开销的性能可观测性工具。

### 场景二：加载 C/C++ FFI 高性能插件

当内置召回或重排序无法满足性能需求时，用 C/C++ 编写高性能计算模块。

**C++ 插件编写模板**：

```cpp
// my_plugin.cpp
#include <cstdint>

// 导出符号：自定义重排序（按业务逻辑调整分数）
extern "C" void trivium_rerank(
    uint64_t* ids,      // 节点 ID 数组
    float* scores,      // 对应分数数组
    uint32_t count      // 结果数量
) {
    for (uint32_t i = 0; i < count; ++i) {
        // 示例：对特定 ID 范围的节点进行加权
        if (ids[i] >= 1000 && ids[i] <= 2000) {
            scores[i] *= 1.5f;  // VIP 节点提权
        }
    }
}
```

**编译与加载**：

```bash
# Linux
g++ -shared -fPIC -O2 -o libmy_plugin.so my_plugin.cpp

# macOS
clang++ -shared -fPIC -O2 -o libmy_plugin.dylib my_plugin.cpp

# Windows (MSVC)
cl /LD /O2 my_plugin.cpp /Fe:my_plugin.dll
```

```python
# Python 侧加载
db.load_ffi_hook("./libmy_plugin.so")
results = db.search(query_vec, top_k=10)  # 自动经过 C++ 重排序

# 不再需要时及时清除
db.clear_hook()
```

```javascript
// Node.js 侧加载
db.loadFfiHook('./libmy_plugin.so')
const results = db.search(queryVec)  // 自动经过 C++ 重排序

// 清除 Hook
db.clearHook()
```

### 场景三：Rust 自定义 Hook（高级）

在 Rust 项目中直接实现 `SearchHook` trait，获得完全的类型安全和编译器优化。

```rust
use triviumdb::hook::{SearchHook, HookContext};
use triviumdb::database::SearchConfig;
use triviumdb::node::SearchHit;

/// 用户权限拦截 Hook：在查询前检查权限
struct AuthHook {
    allowed_user_ids: Vec<String>,
}

impl SearchHook for AuthHook {
    fn on_pre_search(
        &self,
        _query_vector: &mut Vec<f32>,
        _config: &mut SearchConfig,
        ctx: &mut HookContext,
    ) {
        // 从 custom_data 中读取用户身份
        let user_id = ctx.custom_data.get("user_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if !self.allowed_user_ids.contains(&user_id.to_string()) {
            // 权限不足，终止管线
            ctx.abort = true;
            ctx.custom_data = serde_json::json!({
                "error": "permission_denied",
                "user_id": user_id,
            });
        }
    }

    fn on_post_search(
        &self,
        results: &mut Vec<SearchHit>,
        ctx: &mut HookContext,
    ) {
        // 在结果中注入审计日志
        ctx.custom_data["result_count"] = serde_json::json!(results.len());
    }
}

// 注册 Hook
db.set_hook(AuthHook {
    allowed_user_ids: vec!["admin".into(), "agent_001".into()],
});

// 使用带上下文的检索
let mut hook_ctx = HookContext::new();
hook_ctx.custom_data = serde_json::json!({"user_id": "agent_001"});

let (results, ctx) = db.search_hybrid_with_context(
    None, Some(&query_vec), &config
)?;
```

### Hook 使用策略一览

| 场景 | 推荐方案 | 复杂度 |
|------|----------|--------|
| 管线性能诊断 | `search_with_context()` 直接使用 | ⭐ |
| 业务分数调权 | Rust `SearchHook` trait | ⭐⭐ |
| 对接外部 FAISS/ScaNN | C++ FFI 插件 (`on_custom_recall`) | ⭐⭐⭐ |
| Cross-Encoder 重排序 | C++ FFI 或 Rust Hook (`on_rerank`) | ⭐⭐⭐ |
| 用户权限拦截 | Rust Hook (`on_pre_search` + `ctx.abort`) | ⭐⭐ |
| 统计埋点 / A/B 测试 | Rust Hook (`on_post_search` + `ctx.custom_data`) | ⭐⭐ |

### Hook 避坑指南

| 陷阱 | 说明 | 解决方法 |
|------|------|----------|
| FFI 回调中 panic | C++ 异常穿越 FFI 边界导致 UB | 在 C++ 侧 try-catch 所有异常 |
| Hook 回调中阻塞 I/O | 管线持有 MemTable 锁期间阻塞 | Hook 回调中避免网络请求/磁盘 I/O |
| 修改了查询向量维度 | `on_pre_search` 中改变 `query_vector` 长度 | 只修改分量值，不要改变长度 |
| 遗忘清除 Hook | 测试用 Hook 残留导致性能下降 | 使用 `clear_hook()` 显式移除 |

---

## 架构边界认知与规避策略

TriviumDB 是一款经过深度取舍、专为 AI 嵌入式记忆场景设计的存储引擎，而不是通用数据库。理解下面这些固有的架构边界，并采用合适的应用层手段对冲，是生产环境稳定运行的前提。

---

### 一、内存占用：Payload 精简原则

**边界**：向量数据通过 Mmap 按需换入，OS 只加载被访问的 Page，不占满全部物理内存。然而 Payload（JSON 元数据）和图关系边（`HashMap`）是**全量常驻内存**的结构。若每个节点存储了几 KB 甚至几十 KB 的大文本对象，百万节点规模下将会出现数 GB 级别的 RAM 消耗。

**规避策略**：

1. **Payload 只存检索需要的字段**，长文本正文单独存入外部存储（如文件、对象存储），Payload 只记录指针或摘要：

```python
# ❌ 不推荐：把完整文章正文塞进 payload
db.insert(vec, {
    "title": "量子计算入门",
    "full_text": "量子计算是一种利用量子力学现象...（5000字）",
})

# ✅ 推荐：payload 只保留用于过滤和展示的关键字段
doc_id = save_to_external_storage(full_text)  # 存 S3/本地文件/数据库
db.insert(vec, {
    "title": "量子计算入门",
    "doc_id": doc_id,   # 指向外部存储的 ID
    "type": "article",
    "ts": 1711440000,
})
```

2. **使用 `set_memory_limit()` 设置内存上限**，引擎会在超限时自动触发 flush 将向量 delta 写回磁盘，释放增量层内存：

```python
db.set_memory_limit(mb=512)
```

3. **对于 payload 体积不可控的场景**，使用 `dtype="f16"` 将向量内存减半，为 payload 腾出空间：

```python
db = triviumdb.TriviumDB("data.tdb", dim=1536, dtype="f16")  # 向量内存减半
```

---

### 二、字段索引：利用并行特征布隆网与"缩圈"策略

**架构现状 (v0.6)**：TriviumDB 通过 **行级隐式布隆特征阵列 (Parallel Bit-Tag Array)** 技术，已经实现了绝大部分等值 `$eq` 的极速硬件并发拦截。这意味着过滤查询**不再需要昂贵的 JSON O(N) 反序列化**，99% 的不匹配节点会在几个 CPU 时钟周期内被直接物理截断返回。

> 💡 对范围查询 `$gt` 或部分极复杂逻辑的优化，引擎依然会回落到精准 JSON 解析对比。对 JSON 字段建立 B-Tree 或完整 Hash 索引（`create_index("field_name")`）是后续路线。

**规避策略**：

遵循 TriviumDB 的**正确使用范式**——在绝大多数 AI 检索场景中，不应该直接用 Payload 字段作为主入口，而应先用向量检索将候选集缩小到几十个节点，再在小候选集上做条件过滤：

```python
# ❌ 低效：直接用 Payload 字段全量扫描（O(N)，节点多时慢）
all_alices = db.filter_where({"name": "Alice"})

# ✅ 高效：先向量检索缩圈，再在 top_k 候选集上过滤（O(K)，K 极小）
candidates = db.search(encode("Alice 的个人介绍"), top_k=20, expand_depth=0)
alices = [hit for hit in candidates if hit.payload.get("name") == "Alice"]

# ✅ 或者：对已知 ID 用 O(1) 直接定位
node = db.get(known_id)
```

对于确实需要高频全表 Payload 过滤的业务场景（如统计报表），建议在外部维护一份专用数据库（SQLite / PostgreSQL）同步记录关键字段索引，由 TriviumDB 负责语义检索，外部数据库负责精确过滤，实现互补。

---

### 三、TQL 子集：定位是"图谱导航"而非完整图查询语言

**边界**：TriviumDB 内置的 TQL 查询引擎支持 `MATCH`、`WHERE`、`RETURN`、`CREATE`、`SET`、`DELETE` 等基础语法，**不支持** `UNWIND`、`OPTIONAL MATCH`、聚合函数、路径算法等高级语法。它不是 Neo4j 的替代品。

**正确定位**：TriviumDB 的 TQL 引擎的设计职责是在**向量检索已完成锚点定位后，沿已知图谱结构做精准的结构化跳转**。这类查询通常只有 1~3 跳，节点集极小，根本不需要复杂的查询计划器。

```python
# TriviumDB TQL 的正确用法：向量找锚，TQL 做图谱扩散导航
anchor_id = db.search(encode("小明的工作关系"), top_k=1)[0].id

# 从锚点出发做结构化导航（O(1) 起跳 + BFS）
rows = db.tql(f'MATCH (a {{id: {anchor_id}}})-[:colleague]->(b) RETURN b')
```

对于需要复杂图算法（最短路径、社区发现、PageRank）的场景，TriviumDB 内置的**扩散激活（Spreading Activation）+ PPR（Personalized PageRank）**认知管线已覆盖了 AI 场景下最实用的图语义传播需求，且比纯 TQL 查询更具 AI 语义感知能力：

```python
results = db.search_advanced(
    query_vector=vec,
    expand_depth=3,
    teleport_alpha=0.15,   # PPR 回跳概率，等效于图算法中的 PageRank 阻尼因子
    enable_advanced_pipeline=True,
)
```

---

### 四、WAL 回放与启动延迟：定时提交策略

**边界**：如果长期进行写操作但从未调用 `flush()`，所有变更都会堆积在 `.wal` 文件里。下次启动时，引擎需要逐条回放这些日志来重建内存状态，积累越多，启动越慢。

**规避策略**：

这个问题在现有机制下**完全可以消除**，关键在于让 WAL 不要堆积太多：

```python
# ✅ 方案 A：默认开启的后台自动压实（推荐）
# 默认每 2 小时自动落盘，WAL 记录永远保持在可控范围
# 若写入量极高，可调整 db.enable_auto_compaction(interval_secs=1800)

# ✅ 方案 B：对延迟敏感的服务（关闭自动，在低峰期手动触发）
db.disable_auto_compaction()
# 在业务调度（如 cron 凌晨 3 点）中调用：
db.compact()   # 阻塞式全量压实 + 清空 WAL

# ✅ 方案 C：分批写入时配合内存上限（适合持续写入场景）
db.set_memory_limit(mb=256)  # 超限后自动 flush，同步清空 delta
```

| 场景 | 推荐方案 | 启动 WAL 回放量 |
|------|----------|----------------|
| 实时 AI 服务 | 方案 A（60s 自动压实） | ≤ 60 秒写入量 |
| 批量导入 + 夜间维护 | 方案 B（手动 compact） | 几乎为零 |
| 持续内存受限写入 | 方案 C（内存上限触发） | 极小 |

---

### 五、弱类型 Payload：应用层 Schema 约束规范

**边界**：Payload 是纯 JSON，TriviumDB 引擎本身**不做任何 Schema 校验**。同一个字段在不同节点上可能类型不一致（如 `"age": 20` 和 `"age": "20"`），这不会触发引擎报错，但会导致 `filter_where` 过滤时静默地漏掉数据。

**规避策略**：

Schema 约束的正确位置是**应用层调用 API 之前**，而不是数据库引擎层。建议定义一套简单的插入辅助函数作为统一入口，在其中强制类型校验：

```python
from typing import Any
import time

def insert_memory(db, vec: list[float], text: str, metadata: dict[str, Any] = None):
    """统一的记忆插入入口——强制 Schema 约束"""
    payload = {
        "text": str(text),        # 强制 str
        "ts": int(time.time()),   # 强制 int
        "type": "memory",         # 强制存在
    }
    if metadata:
        # 强制校验扩展字段的类型
        for k, v in metadata.items():
            if k == "importance" and not isinstance(v, (int, float)):
                raise TypeError(f"importance 字段必须是数字，got {type(v)}")
            payload[k] = v
    return db.insert(vec, payload)

# 所有写入都通过这个统一入口，而不是直接调用 db.insert
node_id = insert_memory(db, embedding, "今天和小红喝了咖啡", {"importance": 0.8})
```

此外，对于 Payload 过滤，在查询时可以显式做类型保护：

```python
# ⚠️ 不安全：age 字段可能是 str 或 int
adults = db.filter_where({"age": {"$gt": 18}})

# ✅ 安全：在过滤前统一做类型保证（应用层约束）
# 插入时: payload["age"] = int(age)  ← 写入时就确保是整数
```

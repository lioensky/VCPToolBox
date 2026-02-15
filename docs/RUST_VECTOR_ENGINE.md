# VCPToolBox Rust 向量引擎技术文档

> **版本**: 0.1.0  
> **提交**: bg_761825e7  
> **目录**: `rust-vexus-lite/`

---

## 目录

1. [概述](#1-概述)
2. [项目结构](#2-项目结构)
3. [Cargo 配置与依赖](#3-cargo-配置与依赖)
4. [VexusIndex 类完整 API](#4-vexusindex-类完整-api)
5. [N-API 接口规范](#5-n-api-接口规范)
6. [高级数学运算](#6-高级数学运算)
7. [异步 SQLite 恢复](#7-异步-sqlite-恢复)
8. [跨平台构建](#8-跨平台构建)
9. [性能特性](#9-性能特性)
10. [与 KnowledgeBaseManager 集成](#10-与-knowledgebasemanager-集成)

---

## 1. 概述

`rust-vexus-lite` 是 VCPToolBox 的高性能 Rust N-API 向量引擎，为主 Node.js 运行时提供性能敏感路径（向量检索与相关数学计算）的原生能力。该组件是 VCP 记忆系统（TagMemo "浪潮"算法）的核心数学引擎。

### 核心特性

- **USearch HNSW 索引**: 业界最快的向量搜索引擎之一
- **SVD 奇异值分解**: 用于 EPA（Embedding Projection Analysis）基底构建
- **Gram-Schmidt 正交化**: 残差金字塔算法的数学核心
- **异步 SQLite 恢复**: 非阻塞的索引重建能力
- **跨平台原生模块**: 支持 Windows/Linux/macOS 多架构

---

## 2. 项目结构

```
rust-vexus-lite/
├── Cargo.toml              # Rust 包配置与依赖
├── Cargo.lock              # 依赖锁定文件
├── build.rs                # NAPI 构建脚本
├── package.json            # npm 包配置与构建命令
├── index.js                # Node.js 加载入口（平台检测）
├── index.d.ts              # TypeScript 类型声明
├── src/
│   └── lib.rs              # Rust 核心实现（642行）
├── target/
│   └── release/            # 编译产物
│       └── vexus_lite.dll  # Windows 动态库
├── vexus-lite.win32-x64-msvc.node   # Windows x64
├── vexus-lite.linux-x64-gnu.node    # Linux x64 (glibc)
├── vexus-lite.linux-x64-musl.node   # Linux x64 (musl)
├── vexus-lite.linux-arm64-musl.node # Linux ARM64 (musl)
└── vexus-lite.darwin-arm64.node     # macOS ARM64
```

---

## 3. Cargo 配置与依赖

### 3.1 包元数据 (`Cargo.toml`)

```toml
[package]
name = "vexus-lite"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]  # 动态库输出

[profile.release]
lto = true           # 链接时优化
codegen-units = 1    # 最大优化
opt-level = 3        # 最高优化级别
strip = true         # 移除符号信息
```

### 3.2 核心依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `napi` | 2.16 | N-API-RS 核心绑定 |
| `napi-derive` | 2.16 | N-API 过程宏 |
| `tokio` | 1.x (full) | 异步运行时 |
| `bincode` | 1.3 | 高效二进制序列化 |
| `serde` | 1.0 | 序列化框架 |
| `usearch` | 2.8 | HNSW 向量索引引擎 |
| `hashbrown` | 0.14 | 高性能哈希 Map |
| `nalgebra` | 0.32 | 线性代数库（SVD） |
| `rusqlite` | 0.29 (bundled) | SQLite 数据库驱动 |

### 3.3 构建依赖

```toml
[build-dependencies]
napi-build = "2.1"
```

---

## 4. VexusIndex 类完整 API

### 4.1 数据结构

#### SearchResult - 搜索结果
```typescript
interface SearchResult {
  id: number;      // SQLite 中的 chunks.id 或 tags.id
  score: number;   // 相似度分数 (0-1)
}
```

#### SvdResult - SVD 分解结果
```typescript
interface SvdResult {
  u: number[];     // 扁平化正交基底向量集 (k * dim)
  s: number[];     // 特征值（奇异值）
  k: number;       // 保留的主成分数量
  dim: number;     // 向量维度
}
```

#### OrthogonalProjectionResult - 正交投影结果
```typescript
interface OrthogonalProjectionResult {
  projection: number[];       // 投影向量
  residual: number[];         // 残差向量
  basisCoefficients: number[]; // 基底系数
}
```

#### HandshakeResult - 握手分析结果
```typescript
interface HandshakeResult {
  magnitudes: number[];   // 各方向的幅值
  directions: number[];   // 扁平化方向向量 (n * dim)
}
```

#### ProjectResult - EPA 投影结果
```typescript
interface ProjectResult {
  projections: number[];    // 各主成分投影值
  probabilities: number[];  // 能量分布概率
  entropy: number;          // 投影熵
  totalEnergy: number;      // 总能量
}
```

#### VexusStats - 索引统计信息
```typescript
interface VexusStats {
  totalVectors: number;  // 向量总数
  dimensions: number;    // 向量维度
  capacity: number;      // 容量
  memoryUsage: number;   // 内存使用量（字节）
}
```

### 4.2 构造函数

#### `new(dim, capacity)` - 创建空索引
```javascript
const { VexusIndex } = require('./rust-vexus-lite');

// 创建 3072 维、容量 10000 的索引
const index = new VexusIndex(3072, 10000);
```

**参数**:
- `dim: number` - 向量维度（如 3072 用于 text-embedding-3-large）
- `capacity: number` - 初始容量

**索引配置**:
- 度量: L2sq（对于归一化向量等价于余弦相似度）
- 量化: F32
- 连接度: 16
- 添加扩展: 128
- 搜索扩展: 64

#### `VexusIndex.load(indexPath, unusedMapPath, dim, capacity)` - 从磁盘加载
```javascript
const index = VexusIndex.load(
  './data/vectors.usearch',  // 索引文件路径
  null,                       // 废弃参数（保持兼容）
  3072,                       // 维度
  10000                       // 容量（用于扩容）
);
```

**注意**: 映射关系现在由 SQLite 管理，`unusedMapPath` 参数仅保持签名兼容。

### 4.3 索引操作方法

#### `save(indexPath)` - 保存索引
```javascript
index.save('./data/vectors.usearch');
```

**特性**: 原子写入（先写临时文件，再重命名）

#### `add(id, vector)` - 单向量添加
```javascript
// 向量需为 Float32 ArrayBuffer
const vector = new Float32Array([0.1, 0.2, ...]); // 3072 维
const buffer = Buffer.from(vector.buffer);

index.add(42, buffer);  // id=42
```

**自动扩容**: 当 `size + 1 >= capacity` 时自动扩容 1.5 倍

#### `addBatch(ids, vectors)` - 批量添加
```javascript
const ids = [1, 2, 3];
const vectors = new Float32Array([
  ...vec1, // 3072 个元素
  ...vec2, // 3072 个元素
  ...vec3  // 3072 个元素
]);
const buffer = Buffer.from(vectors.buffer);

index.addBatch(ids, buffer);
```

**性能**: 比 JS 循环调用 `add()` 更高效

#### `addBatch(ids, vectors)` - 批量添加

```javascript
const ids = [1, 2, 3];
const vectors = new Float32Array([
  ...vec1, // 3072 个元素
  ...vec2, // 3072 个元素
  ...vec3  // 3072 个元素
]);
const buffer = Buffer.from(vectors.buffer);

index.addBatch(ids, buffer);
```

**性能**: 比 JS 循环调用 `add()` 更高效，适合批量导入场景

**自动扩容**: 当批量添加导致容量不足时，自动扩容 1.5 倍

#### `search(query, k)` - 向量搜索
```javascript
const query = new Float32Array([...]); // 3072 维
const results = index.search(Buffer.from(query.buffer), 10);

// results: [{ id: 42, score: 0.95 }, ...]
```

**返回**: 按相似度降序排列的 `SearchResult[]`

#### `remove(id)` - 删除向量
```javascript
index.remove(42);
```

#### `stats()` - 获取统计信息
```javascript
const stats = index.stats();
// { totalVectors: 1000, dimensions: 3072, capacity: 10000, memoryUsage: 49152000 }
```

---

## 5. N-API 接口规范

### 5.1 函数签名总览

| 方法 | 签名 | 同步/异步 |
|------|------|----------|
| `new` | `(dim: u32, capacity: u32) -> VexusIndex` | 同步 |
| `load` | `(path: String, _: Option<String>, dim: u32, capacity: u32) -> VexusIndex` | 同步 |
| `save` | `(path: String) -> void` | 同步 |
| `add` | `(id: u32, vector: Buffer) -> void` | 同步 |
| `add_batch` | `(ids: Vec<u32>, vectors: Buffer) -> void` | 同步 |
| `search` | `(query: Buffer, k: u32) -> Vec<SearchResult>` | 同步 |
| `remove` | `(id: u32) -> void` | 同步 |
| `stats` | `() -> VexusStats` | 同步 |
| `recover_from_sqlite` | `(db_path: String, table_type: String, filter: Option<String>) -> Promise<u32>` | **异步** |
| `compute_svd` | `(vectors: Buffer, n: u32, max_k: u32) -> SvdResult` | 同步 |
| `compute_orthogonal_projection` | `(vector: Buffer, tags: Buffer, n_tags: u32) -> OrthogonalProjectionResult` | 同步 |
| `compute_handshakes` | `(query: Buffer, tags: Buffer, n_tags: u32) -> HandshakeResult` | 同步 |
| `project` | `(vector: Buffer, basis: Buffer, mean: Buffer, k: u32) -> ProjectResult` | 同步 |

### 5.2 参数类型映射

| Rust 类型 | N-API 类型 | JavaScript 类型 |
|-----------|-----------|-----------------|
| `u32` | `u32` | `number` |
| `String` | `String` | `string` |
| `Option<String>` | `Option<String>` | `string \| null \| undefined` |
| `Buffer` | `Buffer` | `Buffer` (Node.js) |
| `Vec<T>` | `Vec<T>` | `Array<T>` |
| `struct` with `#[napi(object)]` | Object | Plain Object |

### 5.3 错误处理

所有方法返回 `Result<T, napi::Error>`，错误通过 `Error::from_reason()` 构造：

```rust
// 维度不匹配示例
if vec_slice.len() != self.dimensions as usize {
    return Err(Error::from_reason(format!(
        "Dimension mismatch: expected {}, got {}",
        self.dimensions,
        vec_slice.len()
    )));
}
```

---

## 6. 高级数学运算

### 6.1 SVD 奇异值分解 (`compute_svd`)

**用途**: EPA（Embedding Projection Analysis）基底构建，提取主成分用于语义空间降维。

```javascript
// 假设有 100 个标签向量，每个 3072 维
const tagVectors = new Float32Array(100 * 3072); // 扁平化存储
// ... 填充数据 ...

const result = index.computeSvd(
  Buffer.from(tagVectors.buffer),
  100,   // 向量数量 n
  10     // 最多保留 10 个主成分
);

// result.u: 10 * 3072 的正交基底（扁平化）
// result.s: 10 个奇异值
// result.k: 实际保留数量
// result.dim: 3072
```

**算法**: 使用 `nalgebra::DMatrix::svd(false, true)` 计算

**返回**: `V^T` 的前 k 行作为主成分基底

### 6.2 Gram-Schmidt 正交投影 (`compute_orthogonal_projection`)

**用途**: 残差金字塔算法核心，将查询向量分解为"已解释能量"和"残差能量"。

```javascript
const queryVector = new Float32Array([...]); // 3072 维
const tagVectors = new Float32Array([...]);  // n * 3072 维

const result = index.computeOrthogonalProjection(
  Buffer.from(queryVector.buffer),
  Buffer.from(tagVectors.buffer),
  50  // 标签数量
);

// result.projection: 查询在标签基底上的投影
// result.residual: 残差向量（未被解释的部分）
// result.basisCoefficients: 各标签的贡献系数
```

**算法流程**:
1. 对标签向量依次进行 Gram-Schmidt 正交化
2. 计算查询向量在正交基底上的投影
3. 计算残差向量（未被标签解释的部分）
4. 返回投影、残差和各标签的贡献系数

### 6.3 握手分析 (`compute_handshakes`)

**用途**: 计算查询向量与多个标签向量之间的"握手"关系，用于分析语义方向和强度。

```javascript
const queryVector = new Float32Array([...]); // 3072 维
const tagVectors = new Float32Array([...]);  // n * 3072 维

const result = index.computeHandshakes(
  Buffer.from(queryVector.buffer),
  Buffer.from(tagVectors.buffer),
  50  // 标签数量
);

// result.magnitudes: 各标签与查询的相似度幅值
// result.directions: 扁平化的方向向量 (n * 3072)
```

**用途场景**:
- 分析查询向量在多个语义方向上的分布
- 计算标签之间的方向一致性
- 用于残差金字塔的握手分析步骤

### 6.4 EPA 投影 (`project`)
2. 计算查询向量在每个正交基底上的投影系数
3. 汇总所有投影得到 `projection`
4. 计算残差 `residual = query - projection`

### 6.3 握手分析 (`compute_handshakes`)

**用途**: 计算查询向量与多个标签向量之间的"握手"关系，用于分析语义方向和强度。

```javascript
const queryVector = new Float32Array([...]); // 3072 维
const tagVectors = new Float32Array([...]);  // n * 3072 维

const result = index.computeHandshakes(
  Buffer.from(queryVector.buffer),
  Buffer.from(tagVectors.buffer),
  50  // 标签数量
);

// result.magnitudes: 各标签与查询的相似度幅值
// result.directions: 扁平化的方向向量 (n * 3072)
```

**用途场景**:
- 分析查询向量在多个语义方向上的分布
- 计算标签之间的方向一致性
- 用于残差金字塔的握手分析步骤（ResidualPyramid.js:279-320）

**算法实现** (lib.rs:433-478):
1. 计算每个标签向量到查询向量的欧氏距离作为幅值
2. 计算归一化的方向向量（从标签指向查询）
3. 返回幅值数组和扁平化的方向向量数组

### 6.4 EPA 投影 (`project`)

**用途**: 将向量投影到预计算的 SVD 基底上，计算能量分布和熵。

```javascript
// 需要预计算:
// - basis: SVD 主成分基底 (k * dim)
// - mean: 标签向量的均值 (dim)

const result = index.project(
  Buffer.from(vector.buffer),
  Buffer.from(basis.buffer),
  Buffer.from(mean.buffer),
  10  // k
);

// result.projections: 各主成分上的投影值
// result.probabilities: 能量分布概率（归一化）
// result.entropy: 投影熵（衡量意图聚焦程度）
// result.totalEnergy: 总能量
```

**熵的解释**:
- 低熵 → 意图高度聚焦
- 高熵 → 意图分散/模糊

---

## 7. 异步 SQLite 恢复

### 7.1 概述

`recover_from_sqlite` 是一个异步方法，用于从 SQLite 数据库恢复向量索引，不会阻塞 Node.js 主线程。

### 7.2 使用方法

```javascript
// 恢复标签索引
const tagCount = await index.recoverFromSqlite(
  './data/vcp_memory.db',
  'tags',
  null  // 不过滤
);

// 恢复特定日记本的 chunks 索引
const chunkCount = await index.recoverFromSqlite(
  './data/vcp_memory.db',
  'chunks',
  'Nova日记本'  // 只恢复该日记本的向量
);
```

### 7.3 SQL 查询

**tags 表**:
```sql
SELECT id, vector FROM tags WHERE vector IS NOT NULL
```

**chunks 表** (带过滤):
```sql
SELECT c.id, c.vector 
FROM chunks c 
JOIN files f ON c.file_id = f.id 
WHERE f.diary_name = ? AND c.vector IS NOT NULL
```

### 7.4 内部实现

```rust
pub struct RecoverTask {
    index: Arc<RwLock<Index>>,
    db_path: String,
    table_type: String,
    filter_diary_name: Option<String>,
    dimensions: u32,
}

impl Task for RecoverTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        // 在线程池中执行，不阻塞主线程
        let conn = Connection::open(&self.db_path)?;
        // ... 执行查询并添加向量到索引 ...
        Ok(count)
    }
}
```

**特性**:
- 使用 `napi::AsyncTask` 在 libuv 线程池中执行
- 自动维度检查，跳过不匹配的向量
- 自动扩容

---

## 8. 跨平台构建

### 8.1 支持的平台

| 平台 | 架构 | 产物名称 |
|------|------|----------|
| Windows | x64 | `vexus-lite.win32-x64-msvc.node` |
| Windows | ia32 | `vexus-lite.win32-ia32-msvc.node` |
| Windows | arm64 | `vexus-lite.win32-arm64-msvc.node` |
| Linux | x64 (glibc) | `vexus-lite.linux-x64-gnu.node` |
| Linux | x64 (musl) | `vexus-lite.linux-x64-musl.node` |
| Linux | arm64 (glibc) | `vexus-lite.linux-arm64-gnu.node` |
| Linux | arm64 (musl) | `vexus-lite.linux-arm64-musl.node` |
| Linux | arm | `vexus-lite.linux-arm-gnueabihf.node` |
| macOS | x64 | `vexus-lite.darwin-x64.node` |
| macOS | arm64 (M1/M2) | `vexus-lite.darwin-arm64.node` |
| FreeBSD | x64 | `vexus-lite.freebsd-x64.node` |
| Android | arm64 | `vexus-lite.android-arm64.node` |

### 8.2 构建命令

```bash
# 开发构建
cd rust-vexus-lite
npm run build:debug

# 发布构建（当前平台）
npm run build

# 生成多平台产物
npm run artifacts
```

### 8.3 package.json 配置

```json
{
  "napi": {
    "name": "vexus-lite",
    "triples": {
      "defaults": true,
      "additional": [
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-gnu",
        "aarch64-apple-darwin"
      ]
    }
  }
}
```

### 8.4 加载逻辑 (index.js)

```javascript
// 自动检测平台和架构
switch (platform) {
  case 'win32':
    nativeBinding = require('./vexus-lite.win32-x64-msvc.node');
    break;
  case 'linux':
    if (isMusl()) {
      nativeBinding = require('./vexus-lite.linux-x64-musl.node');
    } else {
      nativeBinding = require('./vexus-lite.linux-x64-gnu.node');
    }
    break;
  case 'darwin':
    nativeBinding = require('./vexus-lite.darwin-arm64.node');
    break;
}
```

---

## 9. 性能特性

### 9.1 编译优化

```toml
[profile.release]
lto = true           # 链接时优化（跨 crate 优化）
codegen-units = 1    # 单代码生成单元（最大优化机会）
opt-level = 3        # 最高优化级别
strip = true         # 移除符号信息（减小体积）
```

### 9.2 USearch 性能特性

| 特性 | 配置 | 说明 |
|------|------|------|
| 度量 | L2sq | 对归一化向量等价余弦相似度 |
| 量化 | F32 | 32位浮点（精度优先） |
| 连接度 | 16 | HNSW 图连接数 |
| 添加扩展 | 128 | 添加时的候选扩展因子 |
| 搜索扩展 | 64 | 搜索时的候选扩展因子 |

### 9.3 内存管理

- **自动扩容**: 当索引满时自动扩容 1.5 倍
- **预分配**: 建议在创建时指定足够容量避免频繁扩容
- **mmap 支持**: USearch 支持磁盘映射模式（当前未启用）

### 9.4 线程安全

```rust
pub struct VexusIndex {
    index: Arc<RwLock<Index>>,  // 读写锁保护
    dimensions: u32,
}
```

- **读操作** (`search`, `stats`): 共享读锁
- **写操作** (`add`, `remove`, `save`): 独占写锁
- **异步恢复**: 在独立线程池执行

### 9.5 预期性能基准

| 操作 | 10K 向量 | 100K 向量 | 1M 向量 |
|------|----------|-----------|---------|
| 添加 (单向量) | < 1ms | < 1ms | < 1ms |
| 搜索 (k=10) | < 1ms | < 2ms | < 5ms |
| 批量添加 (1000) | < 100ms | < 150ms | < 200ms |
| SQLite 恢复 | ~500ms | ~5s | ~50s |

*注: 实际性能取决于硬件配置和向量维度*

---

## 10. 与 KnowledgeBaseManager 集成

### 10.1 集成架构

```
KnowledgeBaseManager.js
        │
        ├── TagVectorManager (标签向量管理)
        │       │
        │       └── VexusIndex (Rust N-API)
        │               │
        │               ├── 标签索引 (tags.usearch)
        │               └── 搜索/投影/分析
        │
        └── ChunkVectorManager (知识块向量管理)
                │
                └── VexusIndex (Rust N-API)
                        │
                        ├── 知识块索引 (chunks-{diary}.usearch)
                        └── 语义搜索
```

### 10.2 典型调用流程

```javascript
// KnowledgeBaseManager.js 中的使用示例

const { VexusIndex } = require('./rust-vexus-lite');

class TagVectorManager {
  constructor() {
    this.index = new VexusIndex(3072, 50000);
  }

  // 添加标签向量
  async addTag(id, embedding) {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    this.index.add(id, buffer);
  }

  // TagMemo "浪潮"算法 - 语义搜索
  async searchTags(queryEmbedding, k = 20) {
    const buffer = Buffer.from(new Float32Array(queryEmbedding).buffer);
    return this.index.search(buffer, k);
  }

  // EPA 投影分析
  async analyzeProjection(queryEmbedding, basisData) {
    const { basis, mean, k } = basisData;
    return this.index.project(
      Buffer.from(new Float32Array(queryEmbedding).buffer),
      Buffer.from(new Float32Array(basis).buffer),
      Buffer.from(new Float32Array(mean).buffer),
      k
    );
  }

  // 残差金字塔 - Gram-Schmidt
  async computeResidual(queryEmbedding, tagEmbeddings) {
    return this.index.computeOrthogonalProjection(
      Buffer.from(new Float32Array(queryEmbedding).buffer),
      Buffer.from(new Float32Array(tagEmbeddings.flat()).buffer),
      tagEmbeddings.length
    );
  }

  // 启动时从 SQLite 恢复
  async restoreFromDatabase(dbPath) {
    const count = await this.index.recoverFromSqlite(dbPath, 'tags', null);
    console.log(`[TagVectorManager] Restored ${count} tag vectors`);
    return count;
  }

  // 持久化
  async save(indexPath) {
    this.index.save(indexPath);
  }
}
```

### 10.3 TagMemo "浪潮"算法 V5 集成点

| 算法组件 | Rust 方法 | 用途 |
|----------|-----------|------|
| EPA 投影分析 | `project()` | 计算逻辑深度、世界观门控 |
| 残差金字塔 | `compute_orthogonal_projection()` | 递归搜索微弱信号 |
| SVD 主题提取 | `compute_svd()` | 相控阵去重主成分分析 |
| 握手分析 | `compute_handshakes()` | 语义方向检测 |
| 向量搜索 | `search()` | 核心召回能力 |

### 10.4 错误处理约定

```javascript
// JS 侧包装
try {
  const results = index.search(queryBuffer, k);
} catch (error) {
  // 维度不匹配、索引损坏等错误
  console.error('[VexusIndex] Search failed:', error.message);
  // 降级处理...
}
```

---

## 附录 A: 完整 TypeScript 类型定义

```typescript
// index.d.ts

export interface SearchResult {
  id: number;
  score: number;
}

export interface SvdResult {
  u: number[];
  s: number[];
  k: number;
  dim: number;
}

export interface OrthogonalProjectionResult {
  projection: number[];
  residual: number[];
  basisCoefficients: number[];
}

export interface HandshakeResult {
  magnitudes: number[];
  directions: number[];
}

export interface ProjectResult {
  projections: number[];
  probabilities: number[];
  entropy: number;
  totalEnergy: number;
}

export interface VexusStats {
  totalVectors: number;
  dimensions: number;
  capacity: number;
  memoryUsage: number;
}

export declare class VexusIndex {
  constructor(dim: number, capacity: number);
  
  static load(
    indexPath: string, 
    unusedMapPath: string | undefined | null, 
    dim: number, 
    capacity: number
  ): VexusIndex;
  
  save(indexPath: string): void;
  add(id: number, vector: Buffer): void;
  addBatch(ids: number[], vectors: Buffer): void;
  search(query: Buffer, k: number): SearchResult[];
  remove(id: number): void;
  stats(): VexusStats;
  
  recoverFromSqlite(
    dbPath: string, 
    tableType: string, 
    filterDiaryName?: string | null
  ): Promise<number>;
  
  computeSvd(
    flattenedVectors: Buffer, 
    n: number, 
    maxK: number
  ): SvdResult;
  
  computeOrthogonalProjection(
    vector: Buffer, 
    flattenedTags: Buffer, 
    nTags: number
  ): OrthogonalProjectionResult;
  
  computeHandshakes(
    query: Buffer, 
    flattenedTags: Buffer, 
    nTags: number
  ): HandshakeResult;
  
  project(
    vector: Buffer, 
    flattenedBasis: Buffer, 
    meanVector: Buffer, 
    k: number
  ): ProjectResult;
}
```

---

## 附录 B: 常见问题

### Q1: 为什么使用 L2sq 而不是 Cosine？

对于归一化向量，L2 平方距离与余弦相似度有单调关系。USearch 的 L2sq 实现性能更优，且大多数嵌入模型输出已归一化。

### Q2: 如何选择 capacity？

建议根据预期数据量的 1.2-1.5 倍设置初始容量。过小会导致频繁扩容，过大浪费内存。

### Q3: 批量添加和单个添加的区别？

`add_batch` 减少了 JS-Rust 边界穿越次数，对于大量数据性能提升明显。建议批量操作时使用。

### Q4: 异步恢复会阻塞主线程吗？

不会。`recover_from_sqlite` 使用 `napi::AsyncTask` 在 libuv 线程池中执行，完全异步。

---

## 更新日志

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-02 | 初始版本，包含完整 N-API 接口 |

---

*文档生成时间: 2026-02-13*  
*提交: bg_761825e7*

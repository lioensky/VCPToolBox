# TQL (Trivium Query Language) 完整参考

> **版本**: v0.7.0 (Phase 2a)  
> **定位**: 统一查询 DSL — 融合文档过滤、图模式匹配、向量检索于一体  
> **前置依赖**: 零外部依赖，纯 Rust 实现

---

## 目录

- [概述](#概述)
- [快速入门](#快速入门)
- [FIND — 文档过滤查询](#find--文档过滤查询)
- [MATCH — 图模式匹配](#match--图模式匹配)
- [SEARCH — 向量检索](#search--向量检索)
- [WHERE — 统一谓词系统](#where--统一谓词系统)
- [RETURN / ORDER BY / LIMIT / OFFSET](#return--order-by--limit--offset)
- [操作符速查表](#操作符速查表)
- [与旧 API 的对照迁移](#与旧-api-的对照迁移)
- [形式语法 (EBNF)](#形式语法-ebnf)
- [内部架构](#内部架构)
- [已知限制与路线图](#已知限制与路线图)

---

## 概述

TQL 是 TriviumDB 的统一查询语言，将三种原本独立的查询范式合并为一个连贯的 DSL：

| 入口 | 对应能力 | 替代的旧 API |
|------|---------|-------------|
| `FIND` | MongoDB 风格文档过滤 | `db.filter()` / `db.filter_where()` |
| `MATCH` | Cypher 风格图模式匹配 | `db.query()` |
| `SEARCH` | 向量相似度检索 + 图扩散 | `db.search()` |

**设计哲学**：

- **文档-图-向量 三位一体**：一条 TQL 语句可以同时表达文档过滤、图遍历和向量检索
- **渐进式复杂度**：简单查询极简，高级功能按需叠加
- **与存储引擎深度集成**：内联节点过滤支持完整的 MongoDB `$op` 语法，WHERE 子句同时支持 Cypher 比较和 `MATCHES` 文档断言
- **零成本抽象**：解析器和执行器完全内联，无运行时反射开销

### 调用方式

**Rust：**
```rust
let results = db.tql(r#"FIND {type: "event", heat: {$gte: 0.7}} RETURN * LIMIT 10"#)?;
for row in &results {
    let node = &row["_"];
    println!("[{}] {:?}", node.id, node.payload);
}
```

**Python (计划中)：**
```python
results = db.tql('FIND {type: "event", heat: {$gte: 0.7}} RETURN * LIMIT 10')
for row in results:
    print(row["_"]["payload"])
```

---

## 快速入门

### 30 秒上手

```sql
-- 文档过滤：查找所有 type=person 的节点
FIND {type: "person"} RETURN *

-- 图遍历：沿 knows 边找到 Alice 的朋友
MATCH (a {name: "Alice"})-[:knows]->(b) RETURN b

-- 向量检索：找最相似的 5 个节点
SEARCH VECTOR [0.1, 0.2, 0.3] TOP 5 RETURN *
```

### 完整能力示例

```sql
-- 复杂图遍历 + 文档过滤 + 排序分页
MATCH (a {region: "cn"})-[:knows|works_with*1..3]->(b)
WHERE b.age > 25 AND b MATCHES {role: {$in: ["engineer", "manager"]}}
RETURN a, b
ORDER BY b.age DESC
LIMIT 20 OFFSET 10

-- 向量检索 + 图扩散 + 过滤
SEARCH VECTOR [0.1, -0.2, 0.8, ...] TOP 10
EXPAND [:related*1..2]
WHERE {type: "event"}
RETURN *
```

> 💡 TQL 支持行注释：以 `--` 开头的内容到行尾会被忽略。

---

## FIND — 文档过滤查询

`FIND` 入口对全库节点的 JSON Payload 进行条件过滤，功能完全覆盖旧的 `db.filter()` 和 `db.filter_where()` API。

### 基础语法

```
FIND {文档过滤条件} RETURN ...
```

### 等值匹配

```sql
-- 精确匹配单字段
FIND {type: "person"} RETURN *

-- 多字段隐式 AND
FIND {type: "person", region: "cn"} RETURN *
```

### 操作符过滤

```sql
-- 数值比较
FIND {age: {$gt: 18}} RETURN *
FIND {score: {$gte: 0.8, $lt: 1.0}} RETURN *

-- 集合匹配
FIND {role: {$in: ["admin", "mod"]}} RETURN *
FIND {status: {$nin: ["deleted", "banned"]}} RETURN *

-- 字段存在性
FIND {avatar: {$exists: true}} RETURN *

-- 数组操作
FIND {tags: {$all: ["rust", "database"]}} RETURN *
FIND {tags: {$size: 3}} RETURN *

-- 类型匹配
FIND {metadata: {$type: "object"}} RETURN *
```

### 逻辑组合

```sql
-- 显式 $or
FIND {$or: [{age: {$lt: 18}}, {role: "admin"}]} RETURN *

-- 显式 $and（等价于隐式多字段）
FIND {$and: [{age: {$gte: 18}}, {region: "cn"}]} RETURN *
```

### 排序与分页

```sql
-- ORDER BY + LIMIT + OFFSET
FIND {type: "event"} RETURN *
ORDER BY _.heat DESC
LIMIT 10 OFFSET 20
```

> 💡 `FIND` 场景下节点绑定到隐式变量 `_`，在 `ORDER BY` 中通过 `_.field` 引用字段。

### 支持的全部操作符

| 操作符 | 含义 | 值类型 | TQL 示例 |
|--------|------|--------|----------|
| `$eq` | 等于 | 任意 | `{name: {$eq: "Alice"}}` 或 `{name: "Alice"}` |
| `$ne` | 不等于 | 任意 | `{status: {$ne: "deleted"}}` |
| `$gt` | 大于 | 数字 | `{age: {$gt: 18}}` |
| `$gte` | 大于等于 | 数字 | `{score: {$gte: 0.8}}` |
| `$lt` | 小于 | 数字 | `{age: {$lt: 30}}` |
| `$lte` | 小于等于 | 数字 | `{price: {$lte: 99.9}}` |
| `$in` | 包含于列表 | 数组 | `{role: {$in: ["admin", "mod"]}}` |
| `$nin` | 不包含于列表 | 数组 | `{status: {$nin: ["deleted"]}}` |
| `$exists` | 字段存在性 | 布尔 | `{avatar: {$exists: true}}` |
| `$size` | 数组长度 | 整数 | `{tags: {$size: 3}}` |
| `$all` | 数组全包含 | 数组 | `{tags: {$all: ["a", "b"]}}` |
| `$type` | 字段类型 | 字符串 | `{data: {$type: "object"}}` |
| `$and` | 逻辑与 | 条件数组 | `{$and: [{...}, {...}]}` |
| `$or` | 逻辑或 | 条件数组 | `{$or: [{...}, {...}]}` |

---

## MATCH — 图模式匹配

`MATCH` 入口沿图谱边进行模式匹配遍历，完全覆盖旧的 `db.query()` API，并新增可变长路径、多标签边等高级能力。

### 基础语法

```
MATCH (节点模式)(-[边模式]->(节点模式))* (WHERE 谓词)? RETURN ...
```

### 节点模式

```sql
-- 裸节点（无条件，匹配所有节点）
MATCH (a) RETURN a

-- 内联等值属性过滤
MATCH (a {name: "Alice"}) RETURN a

-- 内联 MongoDB 操作符（Q1-B 决策）
MATCH (a {age: {$gte: 30}}) RETURN a

-- 空属性大括号（等价于无条件）
MATCH (a {}) RETURN a

-- 按 ID 精确查找（O(1) 短路优化）
MATCH (a {id: 42}) RETURN a
```

> 💡 当内联属性包含 `{id: N}` 时，执行器会启用 **O(1) 主键哈希短路**，跳过全表扫描直接定位节点。

### 边模式

```sql
-- 按标签过滤
MATCH (a)-[:knows]->(b) RETURN b

-- 通配边（匹配任意标签）
MATCH (a)-[]->(b) RETURN b

-- 多标签 OR（管道符分隔，Q2-A 决策）
MATCH (a)-[:knows|works_with]->(b) RETURN b
```

### 多跳路径

```sql
-- 两跳路径
MATCH (a {name: "Alice"})-[:knows]->(b)-[:likes]->(c) RETURN c

-- 三跳路径
MATCH (a)-[:next]->(b)-[:next]->(c)-[:next]->(d) RETURN d
```

### 可变长路径

```sql
-- 1 到 3 跳的 knows 关系
MATCH (a {name: "Alice"})-[:knows*1..3]->(b) RETURN b

-- 任意边 2 到 5 跳
MATCH (a)-[*2..5]->(b) RETURN b

-- 多标签 + 可变长组合
MATCH (a)-[:knows|works_with*1..2]->(b) RETURN b
```

**可变长路径执行机制**：

```
DFS 遍历 + 环检测（HashSet visited）
├── depth < min_depth: 继续展开，不收敛
├── min_depth <= depth <= max_depth: 收敛到下一层 + 继续展开
└── depth == max_depth: 仅收敛，停止展开
```

> ⚠️ 可变长路径内置环检测：同一条路径上不会重复访问已经到达过的节点，防止无限循环。

### WHERE 条件

```sql
-- Cypher 风格比较
MATCH (a)-[:knows]->(b) WHERE b.age > 25 RETURN b

-- AND / OR 组合
MATCH (a)-[:knows]->(b)
WHERE b.age > 18 AND (b.role == "admin" OR b.role == "mod")
RETURN b

-- MATCHES 文档断言（将 MongoDB Filter 绑定到变量）
MATCH (a)-[:authored]->(e)
WHERE e MATCHES {heat: {$gte: 0.5}, type: "event"}
RETURN a, e

-- NOT 取反
MATCH (a)-[:knows]->(b)
WHERE NOT b.role == "banned"
RETURN b
```

### 变量绑定规则

| 规则 | 说明 |
|------|------|
| 路径中间/末尾节点**必须**指定变量名 | `(a)-[]->(b)` ✅ / `(a)-[]->()` ❌ |
| 包含边的路径中起始节点**必须**指定变量名 | `(a)-[]->(b)` ✅ / `()-[]->(b)` ❌ |
| 纯单节点查询允许匿名 | `MATCH (n) RETURN n` ✅ |
| 变量在 RETURN 中引用 | `RETURN a, b` |
| `RETURN *` 返回所有绑定变量 | `RETURN *` |

### 执行器安全机制

| 机制 | 配置 | 说明 |
|------|------|------|
| 预算熔断 | 100,000 步 | 单次查询最多评估 10 万步，防止内存爆炸 |
| 行数上限 | LIMIT 或默认 5,000 | 结果行数达标后立即停止所有 DFS 分支 |
| 环路检测 | 可变长路径 | `HashSet<u64>` 跟踪已访问节点 |

---

## SEARCH — 向量检索

`SEARCH` 入口执行向量相似度检索，并可选通过 `EXPAND` 子句沿图谱扩散，将语义锚点与结构关系融合。

### 基础语法

```
SEARCH VECTOR [v1, v2, ...] TOP k (EXPAND [...])? (WHERE 谓词)? RETURN ...
```

### 基础向量检索

```sql
-- 找最相似的 5 个节点
SEARCH VECTOR [0.1, 0.2, 0.3] TOP 5 RETURN *

-- 支持负数分量
SEARCH VECTOR [0.1, -0.48, 0.8] TOP 10 RETURN *
```

### 带图扩散 (EXPAND)

```sql
-- 向量锚点 + 1 跳 related 扩散
SEARCH VECTOR [0.1, 0.2, 0.3] TOP 5
EXPAND [:related*1..2]
RETURN *

-- 多标签扩散
SEARCH VECTOR [0.1, 0.2] TOP 3
EXPAND [:knows|works_with*1..3]
RETURN *
```

**EXPAND 执行流程**：

```
查询向量 → T::similarity 全量打分 → Top-K 锚点
                                       │
                                       ▼
                              k_hop_neighbors 图扩散
                                       │
                                       ▼
                              候选集去重 → WHERE 过滤 → 返回
```

### 带 WHERE 过滤

```sql
-- 向量检索 + 文档过滤
SEARCH VECTOR [0.5, 0.5] TOP 10
WHERE {type: "event"}
RETURN *

-- 向量检索 + Cypher 比较
SEARCH VECTOR [0.5, 0.5] TOP 10
WHERE _.score > 0.8
RETURN *
```

> 💡 `SEARCH` 的 WHERE 过滤在向量打分和 EXPAND 之后执行，作为最终的候选集筛选。

> ⚠️ 当前 `SEARCH` 使用全量 brute-force 打分。对于大规模数据集，建议使用 `db.search_advanced()` 走 QuIVer ANN 图索引加速管线。

---

## WHERE — 统一谓词系统

TQL 的 WHERE 子句统一了两种过滤范式，可在同一条件中自由组合：

### Cypher 比较表达式

```sql
WHERE a.age > 25
WHERE b.name == "Alice"
WHERE a.score >= 0.8 AND a.score < 1.0
```

**支持的比较运算符**：

| 运算符 | 含义 |
|--------|------|
| `==` | 等于 |
| `!=` | 不等于 |
| `>` | 大于 |
| `>=` | 大于等于 |
| `<` | 小于 |
| `<=` | 小于等于 |

**属性访问**: `变量名.字段名`，特殊字段 `id` 引用节点的结构主键。

### MATCHES 文档断言

```sql
-- 将完整的 MongoDB 过滤器绑定到变量
WHERE b MATCHES {age: {$gte: 18}, role: {$in: ["admin", "mod"]}}

-- 无变量绑定（FIND/SEARCH 场景）
WHERE {type: "event"}
```

### 逻辑组合

```sql
-- AND
WHERE a.age > 18 AND b.name == "Bob"

-- OR
WHERE a.role == "admin" OR a.role == "mod"

-- NOT
WHERE NOT a.status == "banned"

-- 括号优先级
WHERE (a.age > 18 OR a.role == "admin") AND b.active == true

-- 混合 Cypher + MATCHES
WHERE a.age > 25 AND b MATCHES {tags: {$all: ["rust"]}}
```

### 类型安全

| 场景 | 行为 |
|------|------|
| 字段不存在 | 比较结果为 `false`，不报错 |
| 类型不匹配（如 `age > "text"`）| 比较结果为 `false`，不报错 |
| `Int` vs `Float` 跨类型比较 | 自动提升为 `f64` 比较 |
| `Null` 值 | 与任何值比较均为 `false` |

---

## RETURN / ORDER BY / LIMIT / OFFSET

### RETURN

```sql
RETURN *          -- 返回所有绑定变量
RETURN a, b       -- 仅返回指定变量
```

- `FIND` / `SEARCH` 场景下，`RETURN *` 将节点绑定到隐式变量 `_`
- `MATCH` 场景下，`RETURN *` 返回模式中所有具名节点变量

### ORDER BY

```sql
ORDER BY b.age ASC          -- 升序（默认）
ORDER BY b.age DESC         -- 降序
ORDER BY a.name, b.age DESC -- 多字段排序
ORDER BY _.heat DESC        -- FIND/SEARCH 场景
```

### LIMIT / OFFSET

```sql
LIMIT 10              -- 最多返回 10 条
LIMIT 10 OFFSET 20    -- 跳过前 20 条，返回 10 条
```

**执行顺序**：`WHERE 过滤 → ORDER BY 排序 → OFFSET 偏移 → LIMIT 截断`

---

## 与旧 API 的对照迁移

### db.query() → db.tql()

| 旧 `db.query()` 写法 | TQL 等价写法 | 新增能力 |
|---|---|---|
| `MATCH (n {name: "alice"}) RETURN n` | 完全相同 | — |
| `MATCH (n {id: 42}) RETURN n` | 完全相同 | O(1) 短路 |
| `MATCH (a)-[:knows]->(b) RETURN b` | 完全相同 | — |
| `WHERE b.age < 27` | 完全相同 | — |
| `WHERE a AND (b OR c)` | 完全相同 | +NOT 支持 |
| — | `(a)-[:knows\|likes]->(b)` | **多标签边** |
| — | `(a)-[:knows*1..3]->(b)` | **可变长路径** |
| — | `ORDER BY b.age DESC` | **排序** |
| — | `LIMIT 10 OFFSET 5` | **分页** |
| — | `WHERE b MATCHES {$op}` | **混合谓词** |

### db.filter_where() → db.tql()

| 旧 `Filter` 枚举 | TQL FIND 写法 |
|---|---|
| `Filter::Eq("name", json!("Alice"))` | `FIND {name: "Alice"}` |
| `Filter::Gt("age", 18.0)` | `FIND {age: {$gt: 18}}` |
| `Filter::In("role", vec![...])` | `FIND {role: {$in: [...]}}` |
| `Filter::And(vec![...])` | `FIND {a: x, b: y}` |
| `Filter::Or(vec![...])` | `FIND {$or: [{...}, {...}]}` |
| `Filter::Exists("f", true)` | `FIND {f: {$exists: true}}` |
| `Filter::Size("arr", 3)` | `FIND {arr: {$size: 3}}` |
| `Filter::All("tags", vec![...])` | `FIND {tags: {$all: [...]}}` |
| `Filter::TypeMatch("f", "object")` | `FIND {f: {$type: "object"}}` |

---

## 形式语法 (EBNF)

```ebnf
Query       := Entry (WHERE Predicate)? RETURN ReturnClause
               (ORDER BY OrderList)? (LIMIT Int)? (OFFSET Int)?

Entry       := MatchEntry | FindEntry | SearchEntry

MatchEntry  := MATCH Pattern
FindEntry   := FIND DocFilter
SearchEntry := SEARCH VECTOR '[' NumList ']' TOP Int (ExpandClause)?

Pattern     := NodePat (EdgePat NodePat)*
NodePat     := '(' Ident? ('{' DocBody '}')? ')'
EdgePat     := '-[' (':' LabelList)? ('*' Int '..' Int)? ']->'
LabelList   := Ident ('|' Ident)*

DocFilter   := '{' DocBody '}'
DocBody     := (LogicOp | FieldEntry) (',' (LogicOp | FieldEntry))*
LogicOp     := ('$and' | '$or') ':' '[' DocFilter (',' DocFilter)* ']'
FieldEntry  := FieldName ':' (Value | OpObject)
OpObject    := '{' '$op' ':' Value (',' '$op' ':' Value)* '}'

ExpandClause := EXPAND '[' (':' LabelList)? '*' Int '..' Int ']'

Predicate   := PredOr
PredOr      := PredAnd (OR PredAnd)*
PredAnd     := PredAtom (AND PredAtom)*
PredAtom    := NOT PredAtom
             | '(' Predicate ')'
             | DocFilter
             | Ident MATCHES DocFilter
             | Ident '.' Ident CompOp Expr

CompOp      := '==' | '!=' | '>' | '>=' | '<' | '<='
Expr        := Ident '.' Ident | Literal
Literal     := Int | Float | String | Bool | null

ReturnClause := '*' | Ident (',' Ident)*
OrderList    := OrderExpr (',' OrderExpr)*
OrderExpr    := Expr (ASC | DESC)?
```

---

## 内部架构

TQL 由四个模块组成，遵循项目既有的模块化拆分模式：

| 模块 | 文件 | 行数 | 职责 |
|------|------|------|------|
| **AST** | `query/tql_ast.rs` | ~160 | 统一语法树定义 |
| **词法分析器** | `query/tql_lexer.rs` | ~300 | Token 化：17 关键字 + `$op` + 注释 |
| **语法分析器** | `query/tql_parser.rs` | ~670 | 递归下降解析 → AST |
| **执行器** | `query/tql_executor.rs` | ~790 | DFS 遍历 + 谓词评估 + 排序 |

### 执行流程

```
TQL 字符串
    │
    ▼
TqlLexer::tokenize()  →  Vec<TqlToken>
    │
    ▼
TqlParser::parse_query()  →  TqlQuery (AST)
    │
    ▼
execute_tql(&query, &memtable)
    ├── FIND  → 全表扫描 + Filter::matches
    ├── MATCH → DFS 图遍历 + Predicate 评估
    └── SEARCH → T::similarity + EXPAND + WHERE
    │
    ▼
ORDER BY → OFFSET → LIMIT → TqlResult<T>
```

---

## 已知限制与路线图

### TQL SEARCH 与现有检索管线的关系

> ⚠️ **重要定位说明**：TQL 的 `SEARCH` 入口定位为**轻量级语义探查工具**，而非现有 `db.search()` / `db.search_advanced()` 检索管线的替代品。

| 维度 | `db.search*()` 管线 | `db.tql("SEARCH ...")` |
|------|---------------------|------------------------|
| 向量索引 | QuIVer ANN 图索引 + rayon 并行 | brute-force 全扫 |
| 图扩散 | Spreading Activation（热度传播 + 边权衰减） | 简单 k-hop 邻居收集 |
| 文本混合 | BM25 + AC 自动机双路召回 | 不支持 |
| 认知管线 | FISTA / DPP / NMF | 不支持 |
| Hook 注入 | 6 阶段管线 Hook | 不支持 |
| 适用场景 | **生产级 RAG 检索** | **数据探查 / 简单语义过滤** |

- **FIND / MATCH**：✅ 设计目标是完全替代 `db.filter_where()` / `db.query()`
- **SEARCH**：定位为补充，不替代现有管线。两者长期共存

### 当前限制 (Phase 2a)

| 限制 | 说明 | 计划 |
|------|------|------|
| 仅有向边 | 仅支持 `-[]->`，不支持反向或无向匹配 | Phase 3 |
| 无聚合函数 | 不支持 COUNT / AVG / SUM / GROUP BY | Phase 3 |
| 无子查询 | 不支持 SEARCH 结果输入 MATCH | Phase 3 |
| 无 OPTIONAL MATCH | 所有模式匹配均为内连接语义 | Phase 3 |
| 无 CREATE / SET / DELETE | TQL 当前为只读查询语言 | Phase 4 |

### 路线图

- **Phase 2b**：旧 `db.query()` / `db.filter_where()` 标记 deprecated，引导迁移至 TQL
- **Phase 3**：聚合函数、子查询、OPTIONAL MATCH、反向边匹配
- **Phase 4**：DML 写入支持（CREATE / SET / DELETE）

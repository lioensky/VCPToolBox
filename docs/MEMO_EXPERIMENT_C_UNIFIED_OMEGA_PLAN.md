# Memo 实验 C 施工图：NNLS 正交种差提纯与高级 Ω 统一拓扑排序

## 0. 工程与基线坐标
- **ProjectForge ID**：`p5gh7`（承接实验 A `pddqg` 与实验 B `pfjgu`）
- **开发分支**：`experiment/memo-nnls-full`（同分支继续迭代，实验 B 检查点独立提交并封存至 `H:\VCP\artifacts\memo-experiment-B-20261114`）
- **实验 B 产物指纹**：`vexus-lite.win32-x64-msvc.node` · SHA256 `84F23A085BF07321AC6880A5F3DE8D91A503E8405125E45A3FD5B3E19A22D682`

---

## 1. 实验 B 实测验尸结论（华为汽车双案）
莱恩主人使用实验 B 实测《华为汽车的幽默操作》与《华为汽车》两案，揭示出**“NNLS 上游已解出唯一正确几何系数，但下游被词法救援与直锚特权联手翻盘”**的四级病灶：

1. **NNLS 几何裁决完全正确**：
   - 在《华为汽车》案中，NNLS 仅1次迭代即给出：`华为汽车 (#40783) = 1.0000`，而 `华为 (#2985) = 0`、`华为小米造车 (#36808) = 0`，残差 `4.61e-32`，KKT 对偶误差 `0`。
2. **病灶一：单向词法包含欺骗与伪 `lexical_seed` 满血复活**（`memo_pipeline.rs:928, 1064, 1096`）
   - `lexical_grounding` 计算 `|Tag ∩ Query| / |Tag|`，导致泛上位词 `华为` 对查询 `华为汽车` 拿到 `1.0 >= 0.5`。
   - `if lexical` 分支无视 NNLS 的 `0` 裁决，强行赋予 `华为` `0.6 * maximum * 1.6 = 0.96` 的满血能量（`0.4164` vs `0.4337`）并授予 `lexical_seed` 身份。
3. **病灶二：Embedding 重力质心塌缩 + `+0.10` 直锚特权倒挂**（`rivermemo_topology_v3.rs:2575-2593`）
   - 预训练向量空间中 `V("华为汽车")` 含约 `0.82` 的 `V("华为")` 重力分量，导致写满“华为”的手机/大模型文章天然获得 `0.588~0.606` 的高 `queryScore`，而仅写下位专名 `尊界V800 / 问界M9` 的真汽车日记只有 `0.481~0.571`（天然亏空 `0.035~0.120`）。
   - 同时数码文章因携带泛标签 `华为` 触发 `explicitExactContacts = 1`，白嫖 `+0.1000` 直锚封顶奖励与 `+0.0300` 泛场共振，总加分 `+0.1300` 远超候选池 Top1-Top10 的原始分差（`0.0626`）。
4. **病灶三：XW 见证虫洞 RRF 异量纲篡位与半套覆盖**（`rivermemo_wormhole.rs` & `rivermemo_topology_v3.rs:3020`）
   - XW 旁路依赖 `1/(60+rank)` 异量纲 `ranking_score` 强行改写排序，不仅导致面板“最终分 (`final_score`)”与实际排名脱节，且单焦点复合词查询（如《华为汽车》）因无第二显式焦点做跨文件见证而 `0/14` 全军覆没，连三轨第一的 `11761` 也无法救回。

---

## 2. 实验 C 四大核心重构设计（大统一高级 Ω）

### 2.1 上游：NNLS 遮蔽上位词识别与词法真子集降权（`memo_pipeline.rs`）
定义**被种差锁死的冗余上位词（Superseded Hypernym）**：
- 若同层存在已支撑的主概念标签 $C$（$a_C \ge \tau_{\text{seed}}$ 且 $\text{sim}(q, C) > 0$），且候选标签 $P$ 满足：
  1. 词元真子集：$\emptyset \subsetneq \text{tokens}(P) \subsetneq \text{tokens}(C)$（或 $|P \cap Q| < |C \cap Q|$ 且 $P \subset C$）；
  2. NNLS 裁决冗余：$a_P < \tau_{\text{seed}}$（即非负锥已证实 $C$ 足以覆盖 $P$ 的方向）。
- **处置法则**：
  - 剥夺 $P$ 的 `lexical = true` 特权与 `lexical_seed` 身份，禁止触发 `0.6 * maximum` 覆写与 `1.6x` 乘子；
  - 引入**查询词元覆盖率（Query Token Specificity）** $\rho_{\text{lex}}(t) = \frac{|\text{tokens}(t) \cap \text{tokens}(Q)|}{|\text{tokens}(Q)|}$，唯有真正覆盖查询完整修饰结构的标签才能享受满额字面点火。

### 2.2 向量侧：正交种差方向提纯（消除重力质心，`memo_pipeline.rs` -> `rivermemo_topology_v3.rs`）
当层内检测到主概念 $C$（如 `华为汽车`, $a_C > 0$）及其被遮蔽的高余弦上位词集合 $\{P_m\}$（如 `华为`, $\cos(q, P_m) \ge 0.65, a_{P_m} \approx 0$）时：
- 在 FP64 下构造上位词重力子空间基 $U_P = \text{Orthonormal}(\{P_m\})$；
- 从查询向量 $q$（或主概念向量 $v_C$）中剥离共性品牌重力，提纯**单位正交种差向量（Differentia Vector）** $q_{\perp}$：
  $$q_{\perp} = \text{normalize}\!\left(q - \gamma_{\text{grav}} \sum_{u \in U_P} (q \cdot u)\, u\right)$$
- 将 $q_{\perp}$ 随观测状态传入 V3 读出层：
  - 对每个候选 Chunk 计算种差对齐度 $s_{\perp}(c) = \text{clamp01}(\cos(q_{\perp}, v_c))$；
  - 当存在显著上位词遮蔽时，候选的语义基础分不再单看被品牌重力污染的 $\cos(q, v_c)$，而是由**完整语义 + 正交种差对比度**联合校准，直接抹平“满篇写华为的手机文章”相对“只写尊界/问界的汽车文章”的 Embedding 虚假优势。

### 2.3 拓扑与直锚侧：锚点专一性折算 + Hop-1 强树枝概念传导（`rivermemo_topology_v3.rs`）
1. **直锚专一性门控**：
   - `compute_anchors` 中每个种子的锚点贡献必须乘以其**概念专一性因子**（由 NNLS 贡献占比与查询词元覆盖率共同决定），杜绝零 NNLS 贡献的泛词砸出 `+0.10` 的 `direct_answer`。
2. **Hop-1 高导通下位实体传导（HIMA 专名桥接）**：
   - 当 Hop-0 主锚 $C$（如 `华为汽车`）通过 CSR 高导通正向边（非噪声弱边）单跳激发 Hop-1 子节点 $E$（如 `鸿蒙智行 / 问界 / 智界 / 享界 / 尊界 / 尊界V800`）时，赋予 $E$ 受 $\Omega$ 与边导通率约束的**一跳代理锚权（Proxy Sub-Concept Anchor）**，使只写下位专名的核心日记获得合法的概念身份确权。

### 2.4 收官大统一：废除 XW `fuse_rrf` 旁路篡位，并入连续标量总方程（`rivermemo_wormhole.rs` & `rivermemo_topology_v3.rs`）
- **退役 `wormhole::fuse_rrf` 对 `ranking_score` 的异量纲覆盖**：保证 `ranking_score == final_score`，修复实验室面板“最终分与排名倒挂”的展示撕裂。
- **统一高级 $\Omega_{\text{adv}}$ 与拓扑预算**：
  - 将 NNLS 锥集中度（Cone Concentration / Active Sparsity）与种差清晰度纳入高级 $\Omega_{\text{adv}}$；
  - 将经过全局超图见证的静态虫洞与动态残差虫洞统一折算为连续标量结构增量 $\Omega_{\text{adv}}^\gamma B_{\text{topo+wormhole}}(c)$，在统一量纲下与基础场分、直锚分闭合相加。

---

## 3. 验证矩阵
1. `cargo test --manifest-path rust-vexus-lite/Cargo.toml --lib` 全量 208+ 单测全绿；
2. 新增实验 C 专项单测：
   - 复合词 `华为汽车` vs 泛词 `华为`：验证 `华为` 不再获封 `lexical_seed`、正交种差向量 $q_{\perp}$ 对汽车正相关而对手机压制、Hop-1 子品牌传导生效；
   - `final_score == ranking_score` 单调性契约测试（废除 RRF 异量纲篡位后，展示分严格等于排序依据）；
3. 编译实验 C Release `.node` 产物，交付莱恩主人实测《华为汽车》《华为汽车的幽默操作》及 200 组回归。
## 4. 实施校准（2026-11-14）
- 主人批准直接在实验 B 分支迭代，最终覆盖源码仓库平台 .node；B 封存检查点保留，不自动部署服务器。
- 已核实 source_field 为 Spike FIR 累积观测（包括涌现节点）L1 归一化，不是原始 NNLS 系数；不得据其反推 NNLS 能量，也不以“已额外 Hub 除法”为修改双场的依据。
- 零系数不等于语义无关；词元真包含加低贡献，仅在非高度共线时判为 superseded。高度共线简称保留原保护。这是可审计启发式，非语义同义关系证明。
- 正交种差采用 FP64 双遍正交化、相对残差护栏；仅在存在受遮蔽父词时启用。真实案例排序需主人实测，不预承诺名次或零退化。
- NNLS 解释率由 pyramid 原始能量闭合读出，独立保存在请求快照；不把多层非正交投影的逐 Tag 系数平方冒充能量。
- Ω 为候选无关结构授权；Hop-1 与 XW 连续读出共享结构预算，直锚保留独立通道。ranking_score 与 final_score 同源。
- 单焦点见证保留不同 checksum、跨文件共现与第三桥标签要求；这些只证明关联，不宣称独立证据或真实上下位关系。

## 5. C 检查点与 Fix3 / Fix4 验收
- 已上机测试的 C 检查点：`645155c3`；Windows x64 SHA256 `36F305A20221945105B655467C37FA56AF54ABD0E708A97AE7F78846B3B89C0B`。
- 主人报告：15 组弱化边缘河网测试跑分提升约 60%，5 组黄金满分组无衰退。属于主人实测汇报；未在此附录中提供逐组原始分数、指标定义与消融，不能据此认定每一机制的独立贡献。
- Fix3：普通 Hop-1 与 XW 仍取最大包络；该输运证据与原始 `v2_bonus * Omega^gamma` 采用共享预算内的有界互补合成，不作统计独立性声明；从原始证据重算以保证幂等；零输运保留原奖励逐位不变。
- Fix4：唯一显式焦点为路由源，且已触发种差校准，或已知全局特异性 `1-sqrt(inbound/maxInbound) >= 0.65` 时，可进入单焦点见证审查。统计缺失、非有限或无效全局分母不能作为稀有依据；仍要求两文件不同非空 checksum 与共享第三非焦点桥标签；截断证据拒绝。
- 全量 Rust 单测：216 passed / 0 failed / 0 ignored，117.97s，`FIX34_TEST_EXIT=0`（主人提供完成终端结果）。
- Fix1（缩写/上位词判别）和 Fix2（双场去母体）未纳入本次发布，交实验 D 源码调查与消融决定，不顺手扩大改动。
- 实验 D 的性能数字必须实测；此前“额外20ms/零成本边张力/NNLS直接证明父子关系”均非已验证结论。小核求解的等价性仅覆盖实际保留的原始生成列；不能把选轴后的近似说成完整邻域锥最优解。
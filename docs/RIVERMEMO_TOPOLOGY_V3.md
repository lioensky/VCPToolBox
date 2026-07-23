# RiverMemo：拓扑 V3 与 Ω 泛函

> 当前生产构型：Topology V3
> 算法标识：`rivermemo.topology-v3.1`
> 结果协议：`rivermemo-topology-v3-result-v1`
> 原生计算内核：`rivermemo.topology-v3.1-rust`
> 文档更新时间：2026-07-23
> 本文只记录拓扑 V3；其他历史、实验或对照构型不属于本文范围。
>
> **当前实现状态**：Topology V3 的候选投影、候选超集、路径几何、相对拓扑、
> DSTC 观测、Direct Anchor、批级条件创新与最终排序已下沉至 Rust。
> JS 只负责 V9 查询观测、双场准备、一次 N-API 提交和稳定结果组装。

## 拓扑 V3 总方程

RiverMemo 的生产落地可由一式总括：

\[
\boxed{
S_i
=
\Pi_{[0,1]}
\left[
S_i^{\mathrm{field}}
+
\underbrace{
\Omega_Q^\gamma\,
\Pi_{[0,C_{r_i}]}
\left(
\lambda_{r_i}\,
\mathcal C_i\,
\left[
G_i-\mathbb E(G\mid Z_i)-z\,\sigma(G\mid Z_i)
\right]_+
\right)
}_{\text{关系拓扑创新}}
+
\underbrace{
C_A\,
\operatorname{SmoothStep}
\left(
\frac{
A_iR_i^A-\tau_A
}{
s_A-\tau_A
}
\right)
}_{\text{直接锚点创新}}
\right]
}
\]

其中：

- \(\Pi_{[a,b]}(x)=\min(b,\max(a,x))\) 是区间投影；
- \([x]_+=\max(0,x)\) 是正部；
- \(S_i^{\mathrm{field}}\) 是 V9 降噪观测经 RiverMemo 双场读出的语义基线；
- \(G_i\) 是候选对查询河网的相对拓扑匹配；
- \(Z_i\) 是候选的语义、闭合、直接证据和角色条件；
- \(\mathbb E(G\mid Z_i)\) 是在条件 \(Z_i\) 下该类候选本来应有的拓扑分；
- \(\sigma(G\mid Z_i)\) 是该条件预测的不确定性；
- \(z\) 是创新下置信界的不确定性系数；
- \(\mathcal C_i\) 是查询、候选和统计样本的联合置信度；
- \(\Omega_Q\) 是查询河网的可观测性；
- \(C_{r_i}\) 与 \(\lambda_{r_i}\) 是候选角色对应的奖励上限与倍率；
- \(A_iR_i^A\) 是候选的直接锚点强度；
- \(\tau_A\) 是本批候选的自适应锚点异常阈值；
- \(s_A\) 是锚点激活的饱和尺度；
- \(C_A\) 是直接锚点通道的独立奖励上限。

这不是若干特判的并列清单，而是拓扑 V3 的完整计算结构：

\[
\text{双场语义基线}
+
\text{由 }\Omega_Q\text{ 授权的条件拓扑创新}
+
\text{与河网密度正交的直接锚点创新}
\]

其中，关系拓扑通道只奖励候选超出同条件期望及其不确定性上界的正创新；直接锚点通道则保护无需复杂河网即可成立的 hop-0 事实接触。两条创新通道均受独立上限约束，最终结果统一投影至 \([0,1]\)。

生产代码落点为 Rust 原生内核
[`run_native()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:1756) 与异步 N-API 入口
[`rerank_rivermemo_topology_v3()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:2121)。
JS 入口 [`RiverMemoEngine.rerank()`](../RiverMemoEngine.js:425) 只准备连续查询场并消费原生结果。
[`experimentArms.js`](../modules/tagmemoV10/experimentArms.js) 等旧 JS 实验构型保留在仓库中，
但不再属于 RiverMemo Topology V3 的生产执行路径。

---

## 1. 定位

RiverMemo 是 VCP 长期记忆系统中建立在 TagMemo V9 已验证传播底座之上的连续信息场检索引擎。

它首次把以下过去分别讨论的对象放入同一个可计算闭环：

1. 查询信息如何从整个上下文中被降噪并形成源；
2. 信息如何沿长期记忆拓扑传递；
3. 传递过程如何生成请求级有向河网；
4. 离散传递如何诱导局部场与迁移场；
5. 候选记忆如何作为有序曲线读取这些场；
6. 河网是否充分形成，如何由 Ω 泛函统一度量；
7. 拓扑证据与直接事实锚如何在同一最终泛函中闭合。

因此，RiverMemo 的核心不是再增加一层经验规则，而是建立：

\[
\text{上下文观测}
\rightarrow
\text{信息源}
\rightarrow
\text{守恒传输}
\rightarrow
\text{河网}
\rightarrow
\text{连续场}
\rightarrow
\text{候选曲线读出}
\rightarrow
\Omega
\rightarrow
\text{统一排序}
\]

拓扑 V3 是当前唯一需要记录的 RiverMemo 构型。

---

## 2. 理论边界

### 2.1 RiverMemo 不重新发明查询降噪

当查询内容是“整个上下文”而不是一个孤立关键词时，RiverMemo 沿用 TagMemo V9 的查询观测架构：

- EPA 全局语义状态分析；
- Residual Pyramid 多层残差分解；
- Core Tag 与语言置信度调制；
- 有界 Spike 传播；
- 软非回溯；
- 有限时域加权；
- 查询增强向量与源场生成。

这一链路已经在工程上证明是当前项目已知的最优全上下文降噪方案，因此 RiverMemo 不对它进行替换。

实现上，[`TagMemoV10Engine.prepareQuery()`](../TagMemoV10Engine.js:981) 默认要求 `v9_epa_pyramid_spike` 观测，并调用 [`TagMemoEngine.observeQueryForV10()`](../TagMemoEngine.js:1298)。普通 Tag KNN 回退默认关闭；完整降噪观测不可用时，系统拒绝把未降噪近邻伪装成 RiverMemo 源场。

### 2.2 V9 底座与 V3 贡献的分界

V9 提供：

\[
(q,\ S,\ \mathcal R_q,\ q_d)
\]

其中：

- \(q\)：原始整个上下文的查询向量；
- \(S\)：归一化查询源场；
- \(\mathcal R_q\)：本次查询实际传播形成的有向河网；
- \(q_d\)：V9 降噪后的查询向量。

拓扑 V3 在此基础上新增并统一：

\[
(S,\mathcal R_q)
\rightarrow
(u_L,u_T)
\rightarrow
\Gamma_c
\rightarrow
\mathcal T(c)
\rightarrow
\Omega(\mathcal R_q)
\rightarrow
\mathcal S_{V3}(c)
\]

所以，RiverMemo 的创新不在于否定 V9，而在于第一次把 V9 已验证的信息源与传播结果提升为可计算的场、拓扑对应和统一泛函。

### 2.3 与层层特判式工程拟合的区别

拓扑 V3 不把“某个规则是否通过”当作信息存在的定义。

候选的直接性、结构性、主题性和闭合性仍可作为测量坐标，但它们只是对同一信息场的不同投影，不是四套互相防御的独立世界模型。

拓扑 V3 的核心裁决量是：

- 信息源是否完成观测；
- 河网是否真实产生边流与涌现；
- 边流是否具有非退化分布；
- 候选是否复现查询河网的相对结构；
- 候选是否闭合回正文；
- 直接锚是否独立成立。

因此，旧实现中保留的观测字段或历史命名应理解为测量接口和兼容层，不应被误解为 RiverMemo 的理论基础。

---

## 3. 基础对象

令长期记忆 Tag 图为：

\[
G=(V,E,P)
\]

其中：

- \(V\) 是 Tag 节点集合；
- \(E\) 是有向关系边集合；
- \(P_{ij}\ge 0\) 是从节点 \(i\) 到节点 \(j\) 的传输率；
- 每一行满足固定出流预算：

\[
\sum_j P_{ij}<1
\]

该严格次随机条件保证传输算子不会无界创造质量，并使后续 resolvent 场收敛。

拓扑 V3 使用的传输资产直接继承 V9.1 的事实压缩、枢纽校正、预算内虫洞和固定行预算。构建时还显式拒绝最大行质量不小于 1 的不稳定资产，见 [`TagMemoV10Engine.buildArtifact()`](../TagMemoV10Engine.js:447)。

---

## 4. 从整个上下文到查询源

### 4.1 全上下文观测

输入不是简单关键词，而是整个当前上下文的 embedding：

\[
q\in\mathbb R^d
\]

EPA 估计其逻辑深度、熵和跨域共振；Residual Pyramid 逐层解释主方向并继续读取未解释残差。

由此得到带权初始 Tag：

\[
Z_0=\{(z_i,w_i)\}
\]

这些权重已包含层级贡献、层级衰减、Core 调制和语言置信度。

### 4.2 V9 有限传播

对传播状态：

\[
x=(v_{\mathrm{prev}},v,e,m,h)
\]

分别记录前驱、当前节点、能量、动量和跳数。

沿边 \(i\rightarrow j\) 的注入流近似为：

\[
f_{ij}^{(h)}
=
e_i^{(h)}
P_{ij}
d_{ij}
\rho_{ij}
\]

其中：

- \(d_{ij}\) 是普通边或虫洞边衰减；
- \(\rho_{ij}\) 是立即回流抑制；
- 虫洞可降低动量成本，但不突破固定出流预算。

有限时域权重为：

\[
a_h=
\frac{\gamma^h}
{\sum_{r=0}^{H}\gamma^r}
\]

节点最终能量为：

\[
E_i=\sum_{h=0}^{H}a_h e_i^{(h)}
\]

这一步同时生成两种不同但同源的对象：

1. 节点势 \(E_i\)；
2. 实际承载过信息的边流 \(F_{ij}=\sum_h f_{ij}^{(h)}\)。

实现位于 [`TagMemoEngine._propagateSpikes()`](../TagMemoEngine.js:541)。

### 4.3 请求级查询河网

查询河网定义为：

\[
\mathcal R_q=(V_q,E_q,E,F)
\]

它不是全局静态知识图的复制，而是“本次查询在全局图上实际走过的部分”。

每个河网节点保存：

- 节点能量；
- 归一化能量；
- `core`、`seed` 或 `emergent` 来源；
- 首次或最短到达跳数；
- 最强父边。

每条河网边保存：

- 累计实际流量；
- 最大单次流量；
- 传导率；
- 最小到达跳数；
- 是否虫洞；
- 是否立即回流。

这使“图上存在一条边”和“本次信息确实经过这条边”成为两个严格不同的命题。

---

## 5. 从离散传递到双尺度连续场

### 5.1 场方程

RiverMemo 使用同一源场 \(S\) 和同一条件化传输算子 \(T\)，并行求解两个尺度：

\[
u_L=(1-\alpha_L)S+\alpha_L T(u_L)
\]

\[
u_T=(1-\alpha_T)S+\alpha_T T(u_T)
\]

其中：

- \(u_L\) 是局部场；
- \(u_T\) 是迁移场；
- 默认 \(\alpha_L=0.15\)；
- 默认 \(\alpha_T=0.55\)。

当谱半径小于 1 时，可写为 resolvent 形式：

\[
u_\alpha
=
(1-\alpha)(I-\alpha T)^{-1}S
\]

这给出从“信息传递”到“场生成”的统一数学关系：

> 场不是额外虚构出来的评分地图，而是同一守恒传输过程在不同观测尺度下的稳态响应。

双场求解目前仍由查询准备阶段的
[`solveDualScaledFields()`](../modules/tagmemoV10/scaledFieldSolver.js:169) 完成；
求解产生的局部场、迁移场及有效支持域随后通过唯一 N-API 请求交给 Rust 内核。

### 5.2 两个尺度的物理含义

局部场强调源附近的稳定解释：

\[
\alpha_L<\alpha_T
\]

迁移场允许信息沿可靠关系传播到更远结构。

二者共享：

- 同一节点空间；
- 同一查询源；
- 同一代传输资产；
- 同一迭代调度；
- 同一质量诊断。

它们不是两个互不相关的召回器，而是同一传输方程的两个尺度截面。

### 5.3 有效支持域

场的正尾部不全部拥有同等解释权。系统按累计质量选择有效支持域：

\[
D_\eta(u)
=
\operatorname{TopMass}_\eta(u)
\]

默认保留：

\[
\eta_L=0.8,\qquad \eta_T=0.9
\]

候选路径的主质量只能由有效支持域内的场接触贡献。长尾仍保留诊断，但不能伪装成稳定路径。

---

## 6. 候选记忆作为有序曲线

候选 chunk \(c\) 所属文件的有序 Tag 链为：

\[
\Gamma_c=(t_1,t_2,\ldots,t_n)
\]

RiverMemo 不只判断候选是否包含某些 Tag，而是判断整条曲线如何穿过局部场与迁移场。

对相邻段 \(t_i\rightarrow t_{i+1}\)，定义局部势：

\[
U_L^{(i)}
=
\sqrt{u_L(t_i)u_L(t_{i+1})}
\]

\[
U_T^{(i)}
=
\sqrt{u_T(t_i)u_T(t_{i+1})}
\]

方向一致性为：

\[
D_i=
\frac{P_{i,i+1}}
{P_{i,i+1}+P_{i+1,i}}
\]

语义连续性与场连续性共同形成：

\[
C_i=
\frac{1}{2}C_i^{semantic}
+
\frac{1}{2}C_i^{field}
\]

有效路径段质量为：

\[
Q_i
=
U_i
\sqrt{\max(D_{\min},D_i)}
\sqrt{C_i}
\]

未进入局部或迁移有效支持域的段满足：

\[
Q_i=0
\]

候选整体路径质量再由支持覆盖与 Tag 到 chunk 的闭合度收束。生产实现位于
Rust [`evaluate_path()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:790)；
同名 JS 算法仅作为已退役实验实现保留，不参与 RiverMemo 生产召回。

---

## 7. 相对拓扑：传递结构的候选复现

### 7.1 节点对应

查询河网节点 \(r\in V_q\) 可以通过两种方式对应候选 Tag：

1. Tag ID 精确一致；
2. 向量或持久化 Pairwise 语义相似度超过阈值。

对应质量同时要求候选 Tag 能闭合回候选 chunk：

\[
A(r,t)
=
\sqrt{
Semantic(r,t)\cdot Closure(t,c)
}
\]

### 7.2 边对应

若查询河网边 \(r_a\rightarrow r_b\) 的两个端点都在候选曲线上找到对应，则比较：

- 查询跳距；
- 候选序位距离；
- 方向一致性；
- 端点对应质量；
- 独立来源比例。

边质量为：

\[
G_e
=
A_e
\cdot
D_e^{relative}
\cdot
D_e^{direction}
\cdot
I_e
\]

其中 \(I_e\) 降低候选文件自身对关系证据的循环自证。

### 7.3 Motif 保持

对于分叉或汇聚节点，系统比较查询河网与候选曲线是否保持相似入度、出度关系。

最终相对拓扑分综合：

\[
\mathcal T(c)
=
w_NN_c+
w_RD_c+
w_{\rightarrow}Dir_c+
w_EE_c+
w_MM_c
\]

若没有完整边对应，则只允许受限节点退化读出，不能把不可观测的距离、方向和 Motif 当成零值混入。

生产实现位于 Rust
[`evaluate_topology()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:928)，
候选之间通过 Rayon 并行执行。

---

## 8. Ω：河网生成的统一可观测泛函

### 8.1 为什么需要 Ω

只看到候选上的局部匹配，不足以证明查询本身形成了可解释的信息河网。

拓扑 V3 因此先对查询侧传播整体做一次候选无关的可观测性测量。

Ω 只读取查询状态，不读取候选，也不读取数据库。它回答：

> 本次整个上下文是否真的激活了足够的边、产生了足够的涌现，并形成了不过度坍缩于单边的流量分布？

### 8.2 边激活项

设：

- \(N_s\) 为种子节点数；
- \(M\) 为实际激活边数；
- \(\kappa_E\) 为边尺度。

则：

\[
\Omega_E
=
\operatorname{clip}_{[0,1]}
\left(
\frac{M}{\kappa_E\max(1,N_s)}
\right)
\]

它测量源节点是否真正产生了关系流，而不是只停留在原始标签上。

### 8.3 涌现项

设到达节点数为 \(N_r\)，涌现节点数为：

\[
N_e=\max(0,N_r-N_s)
\]

则：

\[
\Omega_N
=
\operatorname{clip}_{[0,1]}
\left(
\frac{N_e}{\kappa_N\max(1,N_s)}
\right)
\]

它测量信息是否从源出发形成了新的结构支持。

### 8.4 流熵项

对所有正边流 \(F_k\)，定义：

\[
p_k=\frac{F_k}{\sum_jF_j}
\]

归一化流熵为：

\[
\Omega_F
=
\frac{-\sum_kp_k\log p_k}
{\log |E_q^+|}
\]

单条正流边采用有限值 \(0.5\)，无正流时为 \(0\)。

它区分：

- 多条边共同承载的信息河网；
- 几乎全部质量坍缩到单边的退化传播。

### 8.5 Ω 泛函

三个分量以几何平均统一：

\[
\Omega_{geo}
=
\sqrt[3]{
\max(\Omega_E,\varepsilon)
\max(\Omega_N,\varepsilon)
\max(\Omega_F,\varepsilon)
}
\]

再乘以观测完整度：

\[
\Omega
=
\operatorname{clip}_{[0,1]}
\left(
\Omega_{geo}\cdot \chi_{obs}
\right)
\]

其中：

\[
\chi_{obs}
=
\begin{cases}
1,& \text{V9 完整降噪观测成立}\\
0.5,& \text{观测不完整}
\end{cases}
\]

几何平均意味着任何一个维度严重退化都会压低整体 Ω，任何单一维度都不能独自伪造完整河网。

生产召回中的 Ω 由 Rust
[`compute_omega()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:1430)
在同一次原生任务中计算。JS
[`computeRiverObservability()`](../modules/tagmemoV10/riverObservability.js:44)
只保留给独立只读测量接口，不参与 Topology V3 原生排序。

### 8.6 工况

当前默认工况为：

\[
regime=
\begin{cases}
collapsed,& \Omega<0.12\\
sparse,& 0.12\le\Omega<0.45\\
dense,& \Omega\ge0.45
\end{cases}
\]

工况不是三套算法，只是同一 Ω 泛函在不同区间的可解释标签。

---

## 9. 直接锚：与河网正交的事实通道

河网弱不代表直接事实不存在。

对于查询的 hop-0 `core/seed` 锚 \(s\)，候选可通过精确 Tag 或高阈值语义对应形成接触。

单个接触贡献为：

\[
a_{sc}
=
m_s
\cdot
Spec(t)
\cdot
Closure(t,c)
\cdot
Rarity(s)
\cdot
Match(s,t)
\]

多个独立接触使用 noisy-OR 聚合：

\[
A(c)=1-\prod_s(1-a_{sc})
\]

可靠度为：

\[
R_A(c)
=
\sqrt{
\overline{Closure}
\cdot
\min\left(1,\frac{N_{contact}}{N_{sat}}\right)
}
\]

锚强度：

\[
H(c)=A(c)R_A(c)
\]

这一通道只读取 hop-0 源锚，不允许远端涌现节点伪装成直接事实。生产实现位于
Rust [`compute_anchors()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:1284)，
接触发现与候选锚计算由 Rayon 并行执行。

---

## 10. 拓扑 V3 统一泛函

### 10.1 基础场分

基础分 \(S_0(c)\) 由原查询、V9 降噪场、局部场、迁移场、路径质量和正文闭合共同形成。

它表示候选在不依赖额外拓扑创新奖励时，已经获得的连续场解释。

### 10.2 结构增量

令 \(B_G(c)\) 为候选相对于同类、相近基础状态候选所表现出的正结构创新。

它只能是非负增量：

\[
B_G(c)\ge0
\]

候选不能因 RiverMemo 没有找到结构证据而被统一惩罚。

### 10.3 Ω 门控

结构信息的排序权限由查询河网的整体可观测性统一控制：

\[
G_\Omega=\Omega^\gamma
\]

\[
B_\Omega(c)=G_\Omega B_G(c)
\]

这条式子是拓扑 V3 的关键：

> 候选的局部结构证据是否能转化为排序权，不再只由候选自身决定，而必须服从生成该结构的查询河网整体是否可观测。

### 10.4 锚激活

批内锚强度均值与标准差为：

\[
\mu_H=\mathbb E[H(c)]
\]

\[
\sigma_H=\sqrt{\mathbb E[(H(c)-\mu_H)^2]}
\]

激活阈值：

\[
\theta_H
=
\max(H_{floor},\mu_H+z\sigma_H)
\]

超过阈值后使用平滑激活：

\[
g_H(c)
=
smoothstep
\left(
\frac{H(c)-\theta_H}
{H_{sat}-\theta_H}
\right)
\]

直接锚增量为：

\[
B_H(c)=C_Hg_H(c)
\]

### 10.5 最终公式

拓扑 V3 的最终统一评分为：

\[
\boxed{
S_{V3}(c)
=
\operatorname{clip}_{[0,1]}
\left[
S_0(c)
+
\Omega^\gamma B_G(c)
+
B_H(c)
\right]
}
\]

这三个部分分别表示：

- \(S_0(c)\)：连续语义场与正文闭合；
- \(\Omega^\gamma B_G(c)\)：由河网整体可观测性授权的结构传递增量；
- \(B_H(c)\)：不依赖河网密度的直接事实锚。

生产实现位于 Rust
[`assign_v3_scores()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:1497)。
该函数在候选级并行观测结束后执行批级条件期望、创新下置信界、锚激活阈值、
角色改判和最终有界排序。

---

## 11. 大统一的具体含义

拓扑 V3 所完成的统一是工程数学意义上的统一，而不是宣称发现了任意信息系统的终极自然定律。

它成功闭合了以下关系：

### 11.1 传递与场不再分离

同一个传输算子 \(T\) 同时决定：

- V9 请求级传播能够走到哪里；
- RiverMemo 局部场与迁移场如何生成；
- 候选曲线相邻段是否导通；
- 相对拓扑边是否具有方向依据。

场是传递方程的响应，不再是独立拟合出来的评分层。

### 11.2 查询与候选不再分离

查询河网提供被传递的信息结构，候选有序 Tag 曲线提供可观测载体。

相对拓扑不是要求 Tag 名称完全相同，而是判断两个结构是否在节点对应、相对距离、方向和 Motif 上同构。

### 11.3 局部证据与全局可信度不再分离

候选结构增量必须乘以查询侧 Ω。

因此，一个候选即使局部看起来“很有结构”，也不能在查询河网本身已经坍缩时获得完整结构权限。

### 11.4 结构传递与直接事实不再互相排斥

Ω 管理河网结构证据；直接锚管理 hop-0 事实接触。

两者在最终泛函中相加，但来源正交、可靠度独立，避免：

- 河网稀疏时抹杀直接事实；
- 直接事实强时伪造复杂传播；
- 远端涌现节点冒充查询原始意图。

---

## 12. 完整生产链

[`RiverMemoEngine.rerank()`](../RiverMemoEngine.js:425) 的拓扑 V3 生产链为：

```text
JS：整个上下文查询向量
→ JS：V9 EPA + Residual Pyramid 降噪
→ JS：V9 有界 Spike 传播
→ JS：查询源场 + 请求级有向河网
→ JS：同一守恒传输资产上的局部场/迁移场求解
→ 单次 N-API AsyncTask 提交
→ Rust：加载并缓存同代不可变 RiverMemo Artifact
→ Rust/SQLite：候选 Chunk、向量和有序 Tag 曲线投影
→ Rust/Rayon：Query / Denoised / Local / Transfer / BM25 / Anchor 六路候选超集
→ Rust/Rayon：双尺度路径几何
→ Rust/Rayon：查询河网—候选曲线相对拓扑匹配
→ Rust/Rayon：DSTC、正文闭合与 hop-0 Direct Anchor
→ Rust：查询河网 Ω 与批级条件创新
→ Rust：Topology V3 统一评分与 Top-K
→ JS：稳定结果协议组装
```

整个请求持有同一代不可变 Artifact，禁止在查询中途混合不同传输核、残差、
Pairwise 或配置代际。原生 Artifact 按签名缓存；签名变化时旧缓存整体淘汰。

### 12.1 并发与线程边界

生产路径不再创建 [`worker_threads`](../modules/tagmemoV10/riverMemoWorkerPool.js)
形式的 RiverMemo Node Worker 池。旧 Worker 文件仅作为退役代码保留，不会被
[`KnowledgeBaseManager.rerankWithRiverMemoAsync()`](../KnowledgeBaseManager.js:935)
引用或启动。

当前线程模型为：

1. Node 主线程完成查询观测和双场准备；
2. [`rerank_rivermemo_topology_v3()`](../rust-vexus-lite/src/rivermemo_topology_v3.rs:2121)
   返回原生 `AsyncTask`，将整次原生计算移出 Node 事件循环；
3. Rust 任务内部使用 Rayon 对候选路径、相对拓扑、观测和锚接触并行计算；
4. 批级统计与最终排序在 Rust 内闭合；
5. 只跨越一次请求边界和一次结果边界，不在候选循环中往返 JS/Rust。

### 12.2 运行诊断

生产日志应包含 `RiverMemo Topology V3 [Rust/Rayon]`，并报告：

- `nativeTotal`：原生任务总耗时；
- `load`：Artifact、SQLite 候选曲线及查询/锚 Tag 向量加载耗时；
- `compute`：Rayon 候选计算和批级排序耗时；
- `ffi`：从 JS 提交到结果返回的总边界耗时；
- `threads`：当前 Rayon 工作线程数；
- `nativeProjection`：Rust 成功投影的候选数；
- `nativeSelection`：Rust 候选超集选中数。

正常生产日志不应再出现 `RiverMemoWorkerPool Started`。

---

## 13. 不变量

拓扑 V3 必须保持以下不变量：

1. 输入是整个上下文时，必须优先使用 V9 完整降噪观测；
2. 未完成 V9 降噪时，不得把普通 Tag KNN 静默标记为完整 RiverMemo；
3. 传输算子的最大行质量必须严格小于 1；
4. 河网边必须来自本次查询实际承载过的流量；
5. Ω 只读取查询河网，不读取候选；
6. 局部场与迁移场必须共享同一源和节点空间；
7. 候选主路径质量只能来自有效支持域；
8. 候选 Tag 顺序必须来自稳定的文件 Tag 序位；
9. 相对拓扑必须区分节点对应与完整边对应；
10. 没有完整边对应时，只能使用受限节点退化读出；
11. 结构增量必须由 \(\Omega^\gamma\) 统一授权；
12. 直接锚只能来自 hop-0 `core/seed`；
13. 直接锚与结构增量不得互相伪造；
14. RiverMemo 只做非负修正，无证据候选保留基础分；
15. 所有结果必须绑定 Artifact 签名与查询 ID；
16. 候选级 Topology V3 热点必须在 Rust 内部并行，禁止恢复 JS 逐候选计算；
17. 生产请求只允许一次原生任务提交，不得为 RiverMemo 再启动 Node Worker 池；
18. 拓扑 V3 是本文唯一正式构型。

---

## 14. 结果解释

生产结果中的核心字段含义如下：

| 字段 | 数学含义 |
|:--|:--|
| `baseScore` | \(S_0(c)\)，连续场与闭合基础分 |
| `omega` | \(\Omega(\mathcal R_q)\)，查询河网总可观测性 |
| `riverRegime` | Ω 所处的解释区间 |
| `topologyBonus` | \(\Omega^\gamma B_G(c)\) |
| `anchorBonus` | \(B_H(c)\) |
| `score` | \(S_{V3}(c)\) |
| `role` | 候选在当前查询中的解释角色 |
| `candidateSources` | 候选进入超集的召回来源 |
| `matchedTags` | 候选原生 Tag 曲线中的 Tag |
| `coreTagsMatched` | 与查询 Core Tag 相交的候选 Tag |

结果诊断中的 `nativeTopologyV3.backend` 应为 `rust-rayon-sqlite`。

当开启 trace 时，还可检查：

- 河网节点与边；
- Ω 的边、涌现、流熵分量；
- 相对拓扑节点和边对应；
- 路径段势能、方向和连续性；
- 直接锚接触、闭合、特异性和稀有度；
- 结构增量被 Ω 门控前后的差异。

---

## 15. 科学结论与限制

### 已经成立的结论

在当前 RiverMemo 数学和实现中，已经明确成立：

1. V9 的全上下文降噪结果可以构成归一化信息源；
2. 有界传输过程可同时产生节点势与实际边流；
3. 同一守恒传输算子可通过 resolvent 方程生成不同尺度的连续场；
4. 候选有序 Tag 曲线可以读取该场；
5. 查询河网可以在候选曲线上进行相对拓扑对应；
6. Ω 可以候选无关地测量河网是否形成；
7. Ω 可以统一控制结构证据的排序权限；
8. 直接事实锚可以作为与河网密度正交的通道；
9. 三者可以在一个有界、可回放、只做非负修正的泛函中闭合。

### 不应扩张的结论

本文不声称：

- 人类认知在微观上等价于 RiverMemo；
- Ω 是所有信息系统唯一可能的可观测泛函；
- 当前参数是跨模型、跨知识库的普适常数；
- 语义向量相似度等价于形式逻辑同一；
- 统计叙事方向等价于严格因果关系。

RiverMemo 拓扑 V3 的严谨价值在于：它把系统内部的信息传递、场生成和候选读出统一为可测量、可消融、可回放的数学对象。

---

## 16. 总结

RiverMemo 没有抛弃 TagMemo V9。

相反，它保留了 V9 在“整个上下文”查询场景中已经验证的 EPA、Residual Pyramid 与有界传播降噪，把其输出从“增强向量和节点能量”提升为完整的请求级信息河网。

在拓扑 V3 中：

\[
\text{传播产生河网}
\]

\[
\text{河网与同一传输算子产生连续场}
\]

\[
\text{候选曲线读取场并复现相对拓扑}
\]

\[
\Omega\text{ 测量河网是否真正形成}
\]

\[
\text{直接锚保护不依赖复杂河网的事实接触}
\]

最终：

\[
\boxed{
S_{V3}
=
S_0
+
\Omega^\gamma B_G
+
B_H
}
\]

这就是 RiverMemo 拓扑 V3 的核心成果：信息的传递、场的生成、结构的观测与记忆的排序第一次在同一条数学链上闭合。
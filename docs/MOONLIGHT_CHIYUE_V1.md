# 池月1号算法验证开发与思路文档

**状态**：V1 已实现并通过前端构建验证  
**入口页面**：`AdminPanel-Vue/src/views/FinalContextViewer.vue`  
**公共算法模块**：`AdminPanel-Vue/src/utils/moonlight.ts`  
**最后更新**：2026-06-19

---

## 1. 背景与目标

池月1号是 VCP 在“最终上下文处理”页面中加入的第一期纯前端上下文验证实验功能。

它的目标不是直接判断 AI 是否幻觉，也不是读取黑盒模型内部真实注意力，而是通过可观测文本统计回答两个问题：

1. 选中某个 Assistant 块后，该 Assistant 输出中的词项材料在它之前的上下文中如何分布？
2. 该 Assistant 输出与此前 system 提示词材料之间存在怎样的可观测词项关联？

因此，池月1号应被理解为：

> 基于最终上下文切片的外部词项证据分布光谱仪。

它是后续“皓月系统 / CVC / RMI / 自激回声 / 空洞总结风险”等研究方向的第一步工程基础。

---

## 2. 非目标与边界

池月1号 V1 明确不做以下事情：

- 不证明模型内部真实 attention 权重。
- 不直接判定事实真假。
- 不直接判定幻觉。
- 不调用模型。
- 不调用向量数据库。
- 不向主上下文注入任何内容。
- 不依赖后端新接口。
- 不引入额外 token 成本。

池月1号只做：

- 前端本地净化文本；
- 前端本地词项提取；
- 前端本地 BM25 统计；
- 前端本地角色/位置加权；
- 前端本地可视化与报告导出。

---

## 3. 用户交互流程

入口位于 `AdminPanel-Vue/src/views/FinalContextViewer.vue` 的每个 Assistant 块 header。

流程：

1. 用户打开“最终上下文处理”页面。
2. 用户找到某个 Assistant / AI 块。
3. 点击该块右上角“池月1号”按钮。
4. 前端以该 Assistant 块为 query。
5. 仅取该块之前的上下文块作为 corpus。
6. 运行 `runMoonlightAnalysis()`。
7. 弹出池月报告模态窗。
8. 用户查看：
   - 核心代理指标；
   - 诊断标签；
   - 线性证据密度图与线性注意力代理曲线；
   - 全上下文块级光谱；
   - system 提示词关联光谱；
   - 高贡献词；
   - 被移除高频词；
   - 数字/版本/标识符；
   - 零命中具体词。
9. 用户可复制报告为 JSON 或 Markdown，供第三方校验应用继续分析。

---

## 4. 文件与职责

### 4.1 `AdminPanel-Vue/src/utils/moonlight.ts`

公共算法模块，负责所有非 UI 的核心计算。

主要职责：

- 文本净化；
- OneRing / 伪 system / 工具标记清洗；
- 词项提取；
- BM25 计算；
- 线性证据密度片段生成；
- 线性注意力代理曲线点与波峰/波谷标记生成；
- 角色权重与位置权重；
- 指标聚合；
- 报告结构生成。

关键导出：

- `getDefaultMoonlightOptions()`
- `stripHtml()`
- `stripEmoji()`
- `stripToolMarkers()`
- `stripSystemNotification()`
- `stripOneRingMarkers()`
- `sanitizeMoonlightText()`
- `shouldExcludeMoonlightBlock()`
- `tokenizeMoonlightText()`
- `runMoonlightAnalysis()`

关键类型：

- `MoonlightOptions`
- `MoonlightBlockScore`
- `MoonlightLinearSegment`
- `MoonlightCurvePoint`
- `MoonlightTermStat`
- `MoonlightReport`

### 4.2 `AdminPanel-Vue/src/views/FinalContextViewer.vue`

UI 接入层，负责：

- 在 Assistant 块上显示“池月1号”按钮；
- 调用 `runMoonlightAnalysis()`；
- 管理报告模态窗；
- 展示光谱图；
- 展示指标与词项；
- 复制 JSON / Markdown 报告；
- 应用配置重算。

---

## 5. 净化流程设计

净化是池月1号的根基。若净化不稳定，BM25 结果会被系统标记、工具协议、OneRing 尾标、HTML 等噪声污染。

### 5.1 块级排除

通过 `shouldExcludeMoonlightBlock()` 排除：

- 空文本块；
- 伪 system user 块；
- OneRing 分离来源注入块；
- OneRing 纯来源尾部块。

当前策略偏保守，只排除确定噪声，不随意删除可能有语义价值的普通块。

### 5.2 文本级净化

通过 `sanitizeMoonlightText()` 统一入口执行：

1. user 角色先移除系统通知；
2. 移除 OneRing 标记；
3. 使用 DOMParser 提取 HTML 纯文本；
4. 移除 emoji / 特殊符号；
5. 移除 VCP 工具调用技术标记；
6. 归一化空白与多余换行。

### 5.3 HTML 处理

前端采用 `DOMParser` 而不是 `cheerio`：

- 避免引入 Node 风格依赖；
- 避免增加打包体积；
- 更符合纯前端运行环境；
- 对 Assistant 中可能出现的 HTML 渲染文本做隔离提取。

---

## 6. 词项提取策略

`tokenizeMoonlightText()` 当前使用轻量规则：

- 英文标识符；
- 数字、版本号、带单位数字；
- 中文连续片段；
- 中文 2-gram；
- 可选中文 3-gram；
- 混合字母数字词；
- 内置停用词过滤；
- 最小词长过滤。

配置项来自 `MoonlightOptions`：

- `topStopwordCount`：移除 corpus 中最高频词数量；
- `minTermLength`：最小词项长度；
- `useCharBigrams`：是否启用中文 2-gram；
- `useCharTrigrams`：是否启用中文 3-gram；
- `keepNumbers`：是否保留数字；
- `keepIdentifiers`：是否保留英文/路径/标识符；
- `k1`：BM25 参数；
- `b`：BM25 长度归一化参数。

UI 当前暴露：

- 移除最高频词；
- 最小词长；
- 中文 2-gram；
- 中文 3-gram。

---

## 7. BM25 统计模型

池月1号将“选中的 Assistant 块”作为 query，将此前上下文块作为 documents。

计算步骤：

1. 净化 selected Assistant 文本；
2. 提取 query terms；
3. 净化此前上下文块；
4. 提取 corpus terms；
5. 统计 corpus frequency；
6. 移除最高频词；
7. 统计 document frequency；
8. 计算 BM25；
9. 按 block role 与距离加权；
10. 归一化得分；
11. 聚合指标。

注意：

- 当前 V1 以 block 为最小 document。
- 尚未实现 block 内 chunk 切分。
- 对超长 system 块，后续可增加 chunk 光谱。

---

## 8. 角色与位置权重

BM25 原始分只说明词项命中强度，不说明证据可靠性。

因此 V1 增加两个权重：

### 8.1 TypeWeight

当前经验值：

- `tool`：1.05
- `system`：0.75
- `assistant`：0.32
- `user`：
  - 距离 ≤ 2：1.0
  - 更远：0.62
- 其他：0.5

设计意图：

- tool 更像外部事实回执；
- 最近 user 强牵引；
- system 重要但可能很长，存在跳读风险；
- assistant 历史命中可能是自激回声，因此权重低。

### 8.2 PositionWeight

当前经验值：

- 距离 ≤ 1：1.0
- 距离 ≤ 3：0.92
- 距离 ≤ 8：0.78
- 距离 ≤ 20：0.58
- 更远：0.42

设计意图：

- 模型对近邻上下文通常更敏感；
- 远距块即使存在证据，也不等同稳定可见；
- 该权重是“注意力可见性代理”，不是内部 attention 结论。

---

## 9. 报告指标

`MoonlightReport.metrics` 包含：

- `coverage`：有原始命中的块占比；
- `weightedCoverage`：有加权命中的块占比；
- `gapMax`：最大连续无命中块数量；
- `edgeBias`：头尾命中占比；
- `midVoid`：中段空洞程度；
- `selfEchoRatio`：历史 Assistant 命中占比；
- `externalSupportRatio`：非 Assistant 外部证据占比；
- `systemSupportRatio`：system 命中占比；
- `recentUserSupportRatio`：最近 user 命中占比；
- `contextAttentionProxy`：上下文注意力代理；
- `systemAdherenceProxy`：system 遵循代理；
- `selfEchoRisk`：自激回声风险；
- `hollowSummaryRisk`：空洞总结风险。

所有代理分数均为启发式统计，不应解释为事实判决。

---

## 10. 可视化说明

### 10.1 线性证据密度图

线性证据密度图将选中 Assistant 块之前的全部可索引上下文压成一条连续文本轴。

当前实现：

- 每个可索引 block 生成一个 `MoonlightLinearSegment`；
- segment 宽度按该 block 净化后文本长度占此前上下文总长度的比例；
- segment 底色继承 block role；
- segment 上层热度透明度由 `normalizedWeightedScore` 决定；
- 同一区域叠加线性注意力代理曲线，横轴为上下文线性位置，纵轴为归一化加权命中强度；
- 曲线点按 block 中心位置生成，点色继承 role；
- 局部显著高点标记为波峰，局部显著低点标记为波谷；
- hover 显示 block 编号、角色、线性位置、强度、加权分、命中词数、文本预览；
- click 跳转到对应 block。

用途：

- 观察长 system 块内部命中分布；
- 观察用户长代码/长文档内部命中位置；
- 直观发现"头尾命中、中段空洞"；
- 通过曲线波峰观察输出材料主要集中在哪些上下文位置；
- 通过曲线波谷观察上下文证据断层与可能跳读区域；
- 直观发现"只命中自己历史 AI 块"的自激回声。

### 10.2 全上下文块级光谱

横向柱状光谱：

- 横轴：此前上下文 block；
- 柱高：normalized weighted BM25；
- 颜色：继承 block role；
- hover：显示 raw / weighted / 命中词；
- click：关闭模态窗并跳转到对应 block。

用途：

- 观察输出材料主要来自近邻 user、system、tool、历史 assistant，还是分布稀疏。

### 10.3 System 提示词关联光谱

只展示 system 块命中。

用途：

- 观察 Assistant 输出是否与 system 提示词材料存在显式词项关联；
- 初步观察系统提示词遵循程度。

### 10.4 词项区

四组横向 chip：

- 保留高贡献词；
- 被移除高频词；
- 数字/版本/标识符；
- 零命中具体词。

用途：

- 让用户看到“图是由哪些词撑起来的”；
- 让高频词移除透明化；
- 方便定位无上下文支撑的具体数字、版本号、专名。

---

## 11. 报告导出

模态窗提供两个复制按钮：

### 11.1 复制 JSON

复制完整 `MoonlightReport`。

适合：

- 第三方校验应用；
- 离线分析；
- 后续自动化评估；
- 对比不同模型/不同上下文的统计结果。

### 11.2 复制 Markdown

复制面向人类阅读的摘要报告，包含：

- 核心指标；
- 诊断标签；
- query 统计；
- top 命中块；
- 高贡献词；
- 被移除高频词；
- 零命中具体词。

适合：

- 会议记录；
- issue；
- 人工审核；
- 研发讨论。

---

## 12. UI 实现注意事项

### 12.1 模态窗层级

池月报告使用页面内模态窗。由于 AdminPanel 总布局可能存在顶层 bar / stacking context，单纯提高 z-index 不一定能越过顶层。

最终采用：

- `modal-backdrop` 顶部安全 padding；
- `align-items: flex-start`；
- 池月 modal 最大高度扣除顶部安全区。

关键原因：

> 子页面模态可能无法跨越父布局 stacking context，因此应主动避开顶层 bar，而不是只依赖 z-index。

### 12.2 当前安全边距

当前桌面端：

- 顶部 padding：72px；
- 底部 padding：12px；
- modal 最大高度：视口高度 - 96px。

当前小屏：

- 顶部 padding：64px；
- 底部 padding：8px；
- modal 最大高度：视口高度 - 80px。

---

## 13. 已验证事项

已执行：

```bash
cd AdminPanel-Vue
npm run build
```

验证结果：

- `vue-tsc` 类型检查通过；
- Vite 生产构建通过；
- 用户前端测试通过。

---

## 14. 已知限制

1. 当前只做 block 级 BM25，线性曲线点也是 block 级中心点，未做 block 内 chunk。
2. 当前分词是轻量规则，不是完整中文分词。
3. 当前 system 遵循代理只衡量词项材料关联，不理解约束是否语义满足。
4. 当前高频词移除基于当前 corpus，不是全局语料。
5. 当前权重是经验启发式，尚未经过大规模标注校准。
6. 当前报告不持久化，刷新页面后消失。
7. 当前无法判断“素材存在但错误组合”的情况。

---

## 15. 后续改进方向

### 15.1 Chunk 级光谱

对长 system / user / tool 块按 512～1024 token 或字符窗口切 chunk。

目标：

- 检测 system 块内部空洞；
- 检测长上下文中间段是否被跳读；
- 实现更细粒度 Evidence Density Field。

### 15.2 Claim 级分析

当前 query 是整个 Assistant 块。后续可以：

- 按段落切分；
- 按句子切分；
- 按 claim 切分；
- 对每个 claim 单独做光谱。

目标：

- 判断具体结论的证据分布；
- 避免整段回答平均化掩盖局部问题。

### 15.3 数字/版本/专名强校验

对具体数字、版本号、文件名、API 名、模型名提升权重。

目标：

- 抓“低可见上下文中输出高细节”的风险；
- 特别适合幻觉排查。

### 15.4 System 约束抽取

从 system 中抽取：

- 必须；
- 禁止；
- 不得；
- 只允许；
- 输出格式；
- 工具协议；
- 安全边界；
- 角色规则。

再统计 Assistant 是否出现违反或响应迹象。

目标：

- 从“system 材料关联”升级为“system 约束遵循代理”。

### 15.5 权重可配置化

将 TypeWeight / PositionWeight 暴露到高级配置。

目标：

- 支持不同模型、不同上下文结构下调参；
- 支持实验比较。

### 15.6 持久化与批量比较

后续可考虑保存池月报告：

- localStorage；
- 后端文件；
- SQLite；
- 下载 JSON。

目标：

- 比较同一上下文下不同模型输出；
- 比较同一模型不同版本；
- 研究幻觉如何随上下文累积。

### 15.7 与皓月系统整合

池月1号可成为皓月系统的前端可视化与快速实验层。

后续可叠加：

- CVC；
- RMI；
- 锚点重注入；
- 自激回声追踪；
- 空洞总结拦截；
- 工具回执一致性审计。

---

## 16. 维护建议

1. 保持 `moonlight.ts` 纯函数化，不引入 Vue 状态。
2. 新算法优先写在 `moonlight.ts`，UI 只负责展示。
3. 任何影响统计结论的过滤项都应在 UI 可见。
4. 避免让报告文案变成“事实判决”，保持“代理统计”措辞。
5. 每次修改后执行 `npm run build`。
6. 若加入 chunk，需要注意性能与长上下文渲染成本。
<template>
  <Teleport to="body">
    <Transition name="diary-syntax-modal">
      <div
        v-if="modelValue"
        class="diary-syntax-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diary-syntax-title"
        @click.self="close"
      >
        <section
          class="diary-syntax-panel"
          @click.stop
          @mousedown.stop
          @keydown.stop
        >
          <header class="diary-syntax-header">
            <div>
              <span class="eyebrow">DailyNote DSL</span>
              <h2 id="diary-syntax-title">日记本语法编辑器</h2>
              <p>
                生成 <code>《《小吉日记本》》</code>、<code>[[公共知识日记本]]</code>
                这类可直接放入 Agent 系统提示词的记忆占位符。
              </p>
            </div>
            <UiIconButton class="diary-close-btn" label="关闭" title="关闭" @click="close">
              <span class="material-symbols-outlined">close</span>
            </UiIconButton>
          </header>

          <div class="diary-syntax-body">
            <label class="syntax-field syntax-field--full">
              <span>日记本名称</span>
              <UiInput
                v-model="notebookName"
                type="text"
                placeholder="例如：小吉日记本 / 物理|政治日记本"
                @keydown.stop
              />
              <small>
                支持聚合检索，用 <code>|</code> 分隔多个日记本名。
                示例：<code>物理|政治|python日记本</code>，最终可生成
                <code>[[物理|政治|python日记本:1.2]]</code> 或
                <code>《《物理|政治|python日记本::TagMemo+::Rerank+》》</code>。
              </small>
            </label>

            <div class="dsl-page-tabs" role="tablist" aria-label="日记本 DSL 类型">
              <UiButton
                role="tab"
                variant="ghost"
                :aria-selected="dslPage === 'advanced'"
                :class="{ active: dslPage === 'advanced' }"
                @click="dslPage = 'advanced'"
              >
                <span class="material-symbols-outlined">auto_awesome</span>
                [[]] / 《《》》 高级 RAG
              </UiButton>
              <UiButton
                role="tab"
                variant="ghost"
                :aria-selected="dslPage === 'direct'"
                :class="{ active: dslPage === 'direct' }"
                @click="dslPage = 'direct'"
              >
                <span class="material-symbols-outlined">subject</span>
                {{}} / <<>> 轻量直读
              </UiButton>
            </div>

            <div v-if="dslPage === 'advanced'" class="syntax-card syntax-card--mode">
              <div class="syntax-card-title">
                <span class="material-symbols-outlined">route</span>
                注入模式
              </div>
              <div class="mode-toggle">
                <UiButton
                  variant="ghost"
                  :class="{ active: syntaxMode === 'dynamic' }"
                  @click="syntaxMode = 'dynamic'"
                >
                  《《》》 动态注入
                </UiButton>
                <UiButton
                  variant="ghost"
                  :class="{ active: syntaxMode === 'fixed' }"
                  @click="syntaxMode = 'fixed'"
                >
                  [[]] 固定注入
                </UiButton>
              </div>
              <p>
                <strong>动态注入</strong>会先判断当前上下文与日记本是否相关，达标后才检索片段；
                <strong>固定注入</strong>会无条件执行 RAG 片段检索。
              </p>
            </div>

            <div v-if="dslPage === 'advanced'" class="syntax-grid">
              <div class="syntax-card syntax-option-card syntax-option-card--wide syntax-classic-card">
                <div class="syntax-card-title">
                  <span class="material-symbols-outlined">auto_awesome</span>
                  经典 RAG 后缀
                </div>
                <p>
                  这些是最常用的单语法开关，可自由组合。<code>::Time</code> 负责时间感知，
                  <code>::Group</code> 负责语义组增强，<code>::BM25+</code> 负责日记全文 BM25 匹配，
                  <code>::BM25</code> 负责日记 tag / keyword BM25 匹配，
                  <code>::Rerank</code> 负责普通精排，<code>::Expand</code> 负责父文档展开。
                  注意：普通 <code>::Rerank</code> 与 <code>::Rerank+</code> 只能二选一。
                </p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Time 时间感知检索</strong>
                    <code>::Time0.2</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.time" />
                </div>
                <p>
                  解析“上周、最近、三个月前”等自然语言时间线索，并融合时间范围召回。可选数字表示时间路占比，
                  例如 <code>::Time0.3</code> 表示时间召回约 30%、语义召回约 70%；留空使用默认 0.2。
                  该语法还支持新建聊天时自动传递上一个聊天的记忆，无视任意前端。
                </p>
                <label class="inline-number">
                  <span>时间路占比</span>
                  <UiInput
                    v-model="timeRatio"
                    :disabled="!enabledSuffixes.time"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="默认 0.2"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Group 语义组增强</strong>
                    <code>::Group</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.group" />
                </div>
                <p>命中语义组后融合组向量，适合逻辑串、黑话、玩梗和专精主题捕网。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>BM25+ 日记全文匹配</strong>
                    <code>::BM25+0.7</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.bm25Plus" />
                </div>
                <p>
                  启用日记全文 BM25 关键词匹配，适合通过原文措辞、专有名词或精确短语补充向量召回。
                  可选数字表示 BM25 稀疏分融合权重，例如 <code>::BM25+0.7</code>；留空使用默认 0.6。
                </p>
                <label class="inline-number">
                  <span>BM25 权重</span>
                  <UiInput
                    v-model="bm25PlusWeight"
                    :disabled="!enabledSuffixes.bm25Plus"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="默认 0.6"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>BM25 Tag / Keyword 匹配</strong>
                    <code>::BM250.4</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.bm25" />
                </div>
                <p>
                  启用日记 tag / keyword 字段的 BM25 匹配，适合用标签、关键词和主题词快速命中相关记忆。
                  可选数字表示 BM25 稀疏分融合权重，例如 <code>::BM250.4</code>；留空使用默认 0.6。
                </p>
                <label class="inline-number">
                  <span>BM25 权重</span>
                  <UiInput
                    v-model="bm25Weight"
                    :disabled="!enabledSuffixes.bm25"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="默认 0.6"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Rerank 普通精排</strong>
                    <code>::Rerank</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.rerank"
                    @update:model-value="setExclusiveSuffix('rerank', $event)"
                  />
                </div>
                <p>先超量召回，再用 Reranker 模型重新排序。普通 Rerank 与 Rerank+ 只能二选一。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Expand 父文档展开</strong>
                    <code>::Expand</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.expand" />
                </div>
                <p>命中任意 chunk 后展开所属完整日记，适合长文档、API 手册和设定集。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Associate 联想共现</strong>
                    <code>::Associate</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.associate" />
                </div>
                <p>以已召回 chunk 作为种子，寻找多路径共同指向的潜在关联记忆。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Base64Memo 多模态附件召回</strong>
                    <code>::Base64Memo</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.base64Memo" />
                </div>
                <p>从召回日记中提取图片、音频、视频、PDF 等附件并注入当前对话。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>TagMemo</strong>
                    <code>::TagMemo</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.tagMemo"
                    @update:model-value="setExclusiveSuffix('tagMemo', $event)"
                  />
                </div>
                <p>
                  启用浪潮 TagMemo 拓扑记忆增强。留空权重时系统会动态估算，通常建议不要手写数字。
                  TagMemo 与 TagMemo+ 只能二选一。
                </p>
                <label class="inline-number">
                  <span>可选权重</span>
                  <UiInput
                    v-model="tagMemoWeight"
                    :disabled="!enabledSuffixes.tagMemo"
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    placeholder="留空自动"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>TagMemo+</strong>
                    <code>::TagMemo+</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.tagMemoPlus"
                    @update:model-value="setExclusiveSuffix('tagMemoPlus', $event)"
                  />
                </div>
                <p>
                  在 TagMemo 基础上加入测地线重排，适合标签体系完善的大型知识库。留空权重时自动动态计算。
                  TagMemo+ 与 TagMemo 只能二选一。
                </p>
                <label class="inline-number">
                  <span>可选权重</span>
                  <UiInput
                    v-model="tagMemoPlusWeight"
                    :disabled="!enabledSuffixes.tagMemoPlus"
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    placeholder="留空自动"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Rerank+</strong>
                    <code>::Rerank+</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.rerankPlus"
                    @update:model-value="setExclusiveSuffix('rerankPlus', $event)"
                  />
                </div>
                <p>
                  双路融合精排。α 越高越信任 Reranker，留空则使用默认 0.5。
                  Rerank+ 与标准 Rerank 只能二选一。
                </p>
                <label class="inline-number">
                  <span>α 权重</span>
                  <UiInput
                    v-model="rerankPlusAlpha"
                    :disabled="!enabledSuffixes.rerankPlus"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="默认 0.5"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>时间衰减进阶</strong>
                    <code>::TimeDecay30/0.5/box_archive</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.timeDecay" />
                </div>
                <p>
                  对旧记忆做时间衰减，支持 <code>::TimeDecay半衰期天数/最低分/白名单标签</code>。
                  第三段是固定衰减内容的标签白名单，多个标签用英文逗号分隔；不写第三段则衰减所有可解析日期的非时间路召回结果。
                  标签会按原文保留，支持中文、英文、数字和下划线，例如 <code>box归档,临时记忆,box_archive</code>。
                </p>
                <div class="time-decay-grid" :class="{ disabled: !enabledSuffixes.timeDecay }">
                  <label class="inline-number">
                    <span>半衰期天数</span>
                    <UiInput
                      v-model="timeDecayHalfLifeDays"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      placeholder="30"
                    />
                  </label>
                  <label class="inline-number">
                    <span>最低分</span>
                    <UiInput
                      v-model="timeDecayMinScore"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      inputmode="decimal"
                      placeholder="0.5"
                    />
                  </label>
                  <label class="syntax-field">
                    <span>只衰减这些标签</span>
                    <UiInput
                      v-model="timeDecayTargetTags"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      placeholder="box归档,临时记忆,box_archive"
                    />
                    <small>
                      推荐在日记里写稳定标签：<code>Tag: 2026-05-19, box归档, 临时记忆</code>，
                      再用第三段选择固定衰减内容。
                    </small>
                  </label>
                </div>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>最小阈值截断</strong>
                    <code>::Truncate</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.truncate" />
                </div>
                <p>
                  丢弃最终分低于阈值的记忆片段，适合过滤噪音。常用范围 0.25 - 0.6。
                </p>
                <label class="inline-number">
                  <span>阈值</span>
                  <UiInput
                    v-model="truncateThreshold"
                    :disabled="!enabledSuffixes.truncate"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    placeholder="0.4"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>RoleValve 角色楼层门控</strong>
                    <code>::RoleValve@User>3</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.roleValve" />
                </div>
                <p>
                  根据上下文中 User / Assistant / System 的发言楼层数决定是否加载日记本，
                  适合“聊到一定深度才启用”的知识库。
                </p>

                <div class="role-valve-builder" :class="{ disabled: !enabledSuffixes.roleValve }">
                  <div class="role-valve-row">
                    <UiSelect v-model="roleValveDraft.role" :disabled="!enabledSuffixes.roleValve">
                      <option value="@User">@User 用户发言</option>
                      <option value="@Assistant">@Assistant 助手发言</option>
                      <option value="@System">@System 系统消息</option>
                    </UiSelect>
                    <UiSelect v-model="roleValveDraft.operator" :disabled="!enabledSuffixes.roleValve">
                      <option value=">">></option>
                      <option value="<"><</option>
                      <option value=">=">>=</option>
                      <option value="<="><=</option>
                    </UiSelect>
                    <UiInput
                      v-model.number="roleValveDraft.count"
                      :disabled="!enabledSuffixes.roleValve"
                      type="number"
                      min="0"
                      step="1"
                      @keydown.stop
                    />
                    <UiButton
                      variant="outline"
                      size="sm"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="addRoleValveCondition"
                    >
                      添加条件
                    </UiButton>
                  </div>

                  <div class="logic-row">
                    <span>条件连接符</span>
                    <UiButton
                      variant="ghost"
                      size="sm"
                      :class="{ active: roleValveJoiner === '&' }"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="roleValveJoiner = '&'"
                    >
                      且 &
                    </UiButton>
                    <UiButton
                      variant="ghost"
                      size="sm"
                      :class="{ active: roleValveJoiner === '|' }"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="roleValveJoiner = '|'"
                    >
                      或 |
                    </UiButton>
                  </div>

                  <div class="condition-list">
                    <span
                      v-for="(condition, index) in roleValveConditions"
                      :key="`${condition}-${index}`"
                      class="condition-chip"
                    >
                      {{ condition }}
                      <UiIconButton size="sm" label="移除条件" @click="removeRoleValveCondition(index)">
                        <span class="material-symbols-outlined">close</span>
                      </UiIconButton>
                    </span>
                    <span v-if="roleValveConditions.length === 0" class="condition-empty">
                      暂无条件，将使用当前编辑行自动生成。
                    </span>
                  </div>
                </div>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>AIMemo / AIMemo+</strong>
                    <code>::AIMemo</code>
                  </div>
                </div>
                <p>
                  两个 AI 语法都需要在前端系统提示词中加入 <code>[[AIMemo=True]]</code> 特殊占位符才会触发。
                  <strong>AIMemo</strong> 是独立 AI 召回管线，触发时其它 RAG 后缀不会工作，但可写在一起；
                  <strong>AIMemo+</strong> 会先复用完整后缀管线构建5倍K候选池，再交给 AI 总结，支持与任意语法兼容。
                </p>
                <div class="ai-mode-row">
                  <UiButton
                    variant="ghost"
                    :class="{ active: aiMode === 'none' }"
                    @click="aiMode = 'none'"
                  >
                    不使用
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    :class="{ active: aiMode === 'aimemo' }"
                    @click="aiMode = 'aimemo'"
                  >
                    AIMemo
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    :class="{ active: aiMode === 'aimemoPlus' }"
                    @click="aiMode = 'aimemoPlus'"
                  >
                    AIMemo+
                  </UiButton>
                </div>
                <label class="syntax-field">
                  <span>可选预设名</span>
                  <UiInput
                    v-model="aiPreset"
                    :disabled="aiMode === 'none'"
                    type="text"
                    placeholder="例如 custom_preset，可留空"
                    @keydown.stop
                  />
                </label>
              </div>
            </div>

            <div v-if="dslPage === 'advanced'" class="syntax-card k-card">
              <div class="syntax-option-head">
                <div>
                  <strong>K 倍率（必须放最后）</strong>
                  <code>:1.5</code>
                </div>
                <AppSwitch v-model="useKMultiplier" />
              </div>
              <p>
                调整 RAG 召回数量。注意 K 倍率语法使用单引号风格的冒号位置：
                它必须追加在日记本名称与所有后缀之后，并放在最终闭合符号之前。
              </p>
              <label class="inline-number">
                <span>K 倍率</span>
                <UiInput
                  v-model="kMultiplier"
                  :disabled="!useKMultiplier"
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  placeholder="1.5"
                  @keydown.stop
                />
              </label>
            </div>

            <div v-if="dslPage === 'direct'" class="direct-dsl-page">
              <div class="syntax-card syntax-card--mode">
                <div class="syntax-card-title">
                  <span class="material-symbols-outlined">route</span>
                  轻量直读模式
                </div>
                <div class="mode-toggle">
                  <UiButton
                    variant="ghost"
                    :class="{ active: directSyntaxMode === 'static' }"
                    @click="directSyntaxMode = 'static'"
                  >
                    {{}} 直接文本注入
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    :class="{ active: directSyntaxMode === 'dynamic' }"
                    @click="directSyntaxMode = 'dynamic'"
                  >
                    <<>> 相关时注入
                  </UiButton>
                </div>
                <p>
                  <strong>{{}}</strong> 直接读取日记文本；<strong><<>></strong>
                  会先判断上下文相关性，再复用轻量直读能力注入文本。
                </p>
              </div>

              <div class="syntax-grid">
                <div class="syntax-card syntax-option-card syntax-option-card--wide syntax-classic-card">
                  <div class="syntax-card-title">
                    <span class="material-symbols-outlined">subject</span>
                    轻量直读 DSL
                  </div>
                  <p>
                    该模式不启用完整向量 RAG，只生成当前支持的轻量后缀：
                    <code>::Random</code>、<code>::RandomN</code>、<code>::LastN</code>、
                    <code>::BM25</code>、<code>::BM25+</code> 与
                    <code>::RoleValve@User>3</code>。
                  </p>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>默认读取</strong>
                      <code>无后缀</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="none"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>不追加检索后缀，使用后端默认的直接文本读取策略。</p>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>随机 1 篇</strong>
                      <code>::Random</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="random"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>随机抽取 1 篇日记，适合灵感、回忆和非确定性背景注入。</p>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>随机 N 篇</strong>
                      <code>::RandomN</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="randomN"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>随机抽取指定数量的日记。</p>
                  <label class="inline-number">
                    <span>数量 N</span>
                    <UiInput
                      v-model="directRandomCount"
                      :disabled="directRecallMode !== 'randomN'"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      placeholder="5"
                      @keydown.stop
                    />
                  </label>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>最近 N 篇</strong>
                      <code>::LastN</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="lastN"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>读取最近 N 篇日记，适合近期状态、连续剧情和短期记忆。</p>
                  <label class="inline-number">
                    <span>数量 N</span>
                    <UiInput
                      v-model="directLastCount"
                      :disabled="directRecallMode !== 'lastN'"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      placeholder="10"
                      @keydown.stop
                    />
                  </label>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>BM25 Tag / Keyword 匹配</strong>
                      <code>::BM25</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="bm25"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>使用最新用户输入匹配日记 tag / keyword 字段。</p>
                </div>

                <div class="syntax-card syntax-option-card">
                  <div class="syntax-option-head">
                    <div>
                      <strong>BM25+ 日记全文匹配</strong>
                      <code>::BM25+</code>
                    </div>
                      <input
                        type="radio"
                      name="direct-recall-mode"
                      value="bm25Plus"
                      v-model="directRecallMode"
                    />
                  </div>
                  <p>使用最新用户输入匹配日记全文内容，适合精确短语和原文措辞。</p>
                </div>

                <div class="syntax-card syntax-option-card syntax-option-card--wide">
                  <div class="syntax-option-head">
                    <div>
                      <strong>RoleValve 角色楼层门控</strong>
                      <code>::RoleValve@User>3</code>
                    </div>
                    <AppSwitch v-model="directRoleValveEnabled" />
                  </div>
                  <p>
                    根据上下文中 User / Assistant / System 的发言楼层数决定是否加载轻量日记文本。
                  </p>

                  <div class="role-valve-builder" :class="{ disabled: !directRoleValveEnabled }">
                    <div class="role-valve-row">
                      <UiSelect v-model="roleValveDraft.role" :disabled="!directRoleValveEnabled">
                        <option value="@User">@User 用户发言</option>
                        <option value="@Assistant">@Assistant 助手发言</option>
                        <option value="@System">@System 系统消息</option>
                      </UiSelect>
                      <UiSelect v-model="roleValveDraft.operator" :disabled="!directRoleValveEnabled">
                        <option value=">">></option>
                        <option value="<"><</option>
                        <option value=">=">>=</option>
                        <option value="<="><=</option>
                      </UiSelect>
                      <UiInput
                        v-model.number="roleValveDraft.count"
                        :disabled="!directRoleValveEnabled"
                        type="number"
                        min="0"
                        step="1"
                        @keydown.stop
                      />
                      <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="!directRoleValveEnabled"
                        @click="addRoleValveCondition"
                      >
                        添加条件
                      </UiButton>
                    </div>

                    <div class="logic-row">
                      <span>条件连接符</span>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        :class="{ active: roleValveJoiner === '&' }"
                        :disabled="!directRoleValveEnabled"
                        @click="roleValveJoiner = '&'"
                      >
                        且 &
                      </UiButton>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        :class="{ active: roleValveJoiner === '|' }"
                        :disabled="!directRoleValveEnabled"
                        @click="roleValveJoiner = '|'"
                      >
                        或 |
                      </UiButton>
                    </div>

                    <div class="condition-list">
                      <span
                        v-for="(condition, index) in roleValveConditions"
                        :key="`direct-${condition}-${index}`"
                        class="condition-chip"
                      >
                        {{ condition }}
                        <UiIconButton size="sm" label="移除条件" @click="removeRoleValveCondition(index)">
                          <span class="material-symbols-outlined">close</span>
                        </UiIconButton>
                      </span>
                      <span v-if="roleValveConditions.length === 0" class="condition-empty">
                        暂无条件，将使用当前编辑行自动生成。
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer class="syntax-preview-bar">
            <div>
              <span>最终语法预览</span>
              <code>{{ generatedSyntax }}</code>
            </div>
            <div class="preview-actions">
              <UiButton variant="outline" @click="copySyntax">
                <template #leading>
                  <span class="material-symbols-outlined">content_copy</span>
                </template>
                复制文本
              </UiButton>
              <UiButton variant="primary" @click="insertSyntax">
                <template #leading>
                  <span class="material-symbols-outlined">keyboard_return</span>
                </template>
                {{ mode === "replace" ? "替换原语法" : "插入到编辑器" }}
              </UiButton>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import AppSwitch from "@/components/ui/AppSwitch.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import { showMessage } from "@/utils";
import {
  createDefaultDiarySyntaxState,
  type DiaryAiMode,
  type DiaryDirectRecallMode,
  type DiaryDirectSyntaxMode,
  type DiaryDslPage,
  type DiarySuffixKey,
  type DiarySyntaxEditorState,
  type DiarySyntaxMode,
} from "./diarySyntaxParser";

type DslPage = DiaryDslPage;
type SyntaxMode = DiarySyntaxMode;
type DirectSyntaxMode = DiaryDirectSyntaxMode;
type DirectRecallMode = DiaryDirectRecallMode;
type AiMode = DiaryAiMode;
type SuffixKey = DiarySuffixKey;

interface RoleValveDraft {
  role: "@User" | "@Assistant" | "@System";
  operator: ">" | "<" | ">=" | "<=";
  count: number;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    initialState?: DiarySyntaxEditorState | null;
    mode?: "insert" | "replace";
  }>(),
  {
    initialState: null,
    mode: "insert",
  }
);

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "insert", value: string): void;
  (event: "replace", value: string): void;
}>();

const defaultState = createDefaultDiarySyntaxState();
const notebookName = ref(defaultState.notebookName);
const dslPage = ref<DslPage>(defaultState.dslPage);
const syntaxMode = ref<SyntaxMode>(defaultState.syntaxMode);
const directSyntaxMode = ref<DirectSyntaxMode>(defaultState.directSyntaxMode);
const directRecallMode = ref<DirectRecallMode>(defaultState.directRecallMode);
const directRandomCount = ref(defaultState.directRandomCount);
const directLastCount = ref(defaultState.directLastCount);
const directRoleValveEnabled = ref(defaultState.directRoleValveEnabled);
const useKMultiplier = ref(defaultState.useKMultiplier);
const kMultiplier = ref(defaultState.kMultiplier);
const timeRatio = ref(defaultState.timeRatio);
const bm25Weight = ref(defaultState.bm25Weight);
const bm25PlusWeight = ref(defaultState.bm25PlusWeight);
const tagMemoWeight = ref(defaultState.tagMemoWeight);
const tagMemoPlusWeight = ref(defaultState.tagMemoPlusWeight);
const rerankPlusAlpha = ref(defaultState.rerankPlusAlpha);
const timeDecayHalfLifeDays = ref(defaultState.timeDecayHalfLifeDays);
const timeDecayMinScore = ref(defaultState.timeDecayMinScore);
const timeDecayTargetTags = ref(defaultState.timeDecayTargetTags);
const truncateThreshold = ref(defaultState.truncateThreshold);
const aiMode = ref<AiMode>(defaultState.aiMode);
const aiPreset = ref(defaultState.aiPreset);
const roleValveJoiner = ref<"&" | "|">(defaultState.roleValveJoiner);
const roleValveConditions = ref<string[]>([...defaultState.roleValveConditions]);
const roleValveDraft = reactive<RoleValveDraft>({
  role: "@User",
  operator: ">",
  count: 3,
});

const enabledSuffixes = reactive<Record<SuffixKey, boolean>>({ ...defaultState.enabledSuffixes });

const generatedSyntax = computed(() => {
  const rawName = notebookName.value.trim() || "日记本";

  if (dslPage.value === "direct") {
    return buildDirectSyntax(rawName);
  }

  const suffixes: string[] = [];

  if (enabledSuffixes.time) suffixes.push(`::Time${sanitizeNumber(timeRatio.value)}`);
  if (enabledSuffixes.group) suffixes.push("::Group");
  if (enabledSuffixes.bm25Plus) suffixes.push(`::BM25+${sanitizeNumber(bm25PlusWeight.value)}`);
  if (enabledSuffixes.bm25) suffixes.push(`::BM25${sanitizeNumber(bm25Weight.value)}`);
  if (enabledSuffixes.tagMemo) suffixes.push(`::TagMemo${sanitizeNumber(tagMemoWeight.value)}`);
  if (enabledSuffixes.tagMemoPlus) suffixes.push(`::TagMemo+${sanitizeNumber(tagMemoPlusWeight.value)}`);
  if (enabledSuffixes.rerank) suffixes.push("::Rerank");
  if (enabledSuffixes.rerankPlus) suffixes.push(`::Rerank+${sanitizeNumber(rerankPlusAlpha.value)}`);
  if (enabledSuffixes.timeDecay) suffixes.push(buildTimeDecaySuffix());
  if (enabledSuffixes.truncate) suffixes.push(`::Truncate${sanitizeNumber(truncateThreshold.value) || "0.4"}`);
  if (enabledSuffixes.associate) suffixes.push("::Associate");
  if (enabledSuffixes.expand) suffixes.push("::Expand");
  if (enabledSuffixes.base64Memo) suffixes.push("::Base64Memo");
  if (aiMode.value === "aimemo") suffixes.push(`::AIMemo${formatAiPreset()}`);
  if (aiMode.value === "aimemoPlus") suffixes.push(`::AIMemo+${formatAiPreset()}`);
  if (enabledSuffixes.roleValve) suffixes.push(`::RoleValve${buildRoleValveExpression()}`);

  const kSuffix = useKMultiplier.value ? `:${sanitizeNumber(kMultiplier.value) || "1.5"}` : "";
  const inner = `${rawName}${suffixes.join("")}${kSuffix}`;

  return syntaxMode.value === "dynamic" ? `《《${inner}》》` : `[[${inner}]]`;
});

function buildDirectSyntax(rawName: string): string {
  const suffixes: string[] = [];

  if (directRecallMode.value === "random") {
    suffixes.push("::Random");
  }

  if (directRecallMode.value === "randomN") {
    suffixes.push(`::Random${sanitizePositiveInteger(directRandomCount.value, "5")}`);
  }

  if (directRecallMode.value === "lastN") {
    suffixes.push(`::Last${sanitizePositiveInteger(directLastCount.value, "10")}`);
  }

  if (directRecallMode.value === "bm25") {
    suffixes.push("::BM25");
  }

  if (directRecallMode.value === "bm25Plus") {
    suffixes.push("::BM25+");
  }

  if (directRoleValveEnabled.value) {
    suffixes.push(`::RoleValve${buildRoleValveExpression()}`);
  }

  const inner = `${rawName}${suffixes.join("")}`;
  return directSyntaxMode.value === "dynamic" ? `<<${inner}>>` : `{{${inner}}}`;
}

function setExclusiveSuffix(key: SuffixKey, value: boolean): void {
  enabledSuffixes[key] = value;

  if (!value) {
    return;
  }

  if (key === "tagMemo") {
    enabledSuffixes.tagMemoPlus = false;
    return;
  }

  if (key === "tagMemoPlus") {
    enabledSuffixes.tagMemo = false;
    return;
  }

  if (key === "rerank") {
    enabledSuffixes.rerankPlus = false;
    return;
  }

  if (key === "rerankPlus") {
    enabledSuffixes.rerank = false;
  }
}

function sanitizeNumber(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  return String(numeric);
}

function sanitizePositiveInteger(value: unknown, fallback: string): string {
  const numeric = Number(sanitizeNumber(value));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return String(Math.max(1, Math.floor(numeric)));
}

function formatAiPreset(): string {
  const preset = aiPreset.value.trim();
  return preset ? `:${preset}` : "";
}

function sanitizeTimeDecayTags(value: string): string {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(",");
}

function buildTimeDecaySuffix(): string {
  const halfLife = sanitizeNumber(timeDecayHalfLifeDays.value);
  const minScore = sanitizeNumber(timeDecayMinScore.value);
  const targetTags = sanitizeTimeDecayTags(timeDecayTargetTags.value);

  if (!halfLife && !minScore && !targetTags) {
    return "::TimeDecay";
  }

  const head = halfLife || "30";
  if (!minScore && !targetTags) {
    return `::TimeDecay${head}`;
  }

  const middle = minScore || "0.5";
  return targetTags ? `::TimeDecay${head}/${middle}/${targetTags}` : `::TimeDecay${head}/${middle}`;
}

function buildRoleValveExpression(): string {
  const conditions =
    roleValveConditions.value.length > 0
      ? roleValveConditions.value
      : [formatRoleValveCondition()];

  return conditions.join(roleValveJoiner.value);
}

function formatRoleValveCondition(): string {
  const count = Number.isFinite(roleValveDraft.count) ? Math.max(0, Math.floor(roleValveDraft.count)) : 0;
  return `${roleValveDraft.role}${roleValveDraft.operator}${count}`;
}

function addRoleValveCondition(): void {
  const condition = formatRoleValveCondition();
  roleValveConditions.value.push(condition);
}

function removeRoleValveCondition(index: number): void {
  roleValveConditions.value.splice(index, 1);
}

async function copySyntax(): Promise<void> {
  try {
    await navigator.clipboard.writeText(generatedSyntax.value);
    showMessage("日记本语法已复制。", "success");
  } catch {
    showMessage("复制失败，请手动选中预览文本复制。", "error");
  }
}

function insertSyntax(): void {
  if (props.mode === "replace") {
    emit("replace", generatedSyntax.value);
    showMessage("日记本语法已替换。", "success");
    return;
  }

  emit("insert", generatedSyntax.value);
  showMessage("日记本语法已插入到 Agent 文件编辑器。", "success");
}

function applyEditorState(state: DiarySyntaxEditorState): void {
  notebookName.value = state.notebookName;
  dslPage.value = state.dslPage;
  syntaxMode.value = state.syntaxMode;
  directSyntaxMode.value = state.directSyntaxMode;
  directRecallMode.value = state.directRecallMode;
  directRandomCount.value = state.directRandomCount;
  directLastCount.value = state.directLastCount;
  directRoleValveEnabled.value = state.directRoleValveEnabled;
  useKMultiplier.value = state.useKMultiplier;
  kMultiplier.value = state.kMultiplier;
  timeRatio.value = state.timeRatio;
  bm25Weight.value = state.bm25Weight;
  bm25PlusWeight.value = state.bm25PlusWeight;
  tagMemoWeight.value = state.tagMemoWeight;
  tagMemoPlusWeight.value = state.tagMemoPlusWeight;
  rerankPlusAlpha.value = state.rerankPlusAlpha;
  timeDecayHalfLifeDays.value = state.timeDecayHalfLifeDays;
  timeDecayMinScore.value = state.timeDecayMinScore;
  timeDecayTargetTags.value = state.timeDecayTargetTags;
  truncateThreshold.value = state.truncateThreshold;
  aiMode.value = state.aiMode;
  aiPreset.value = state.aiPreset;
  roleValveJoiner.value = state.roleValveJoiner;
  roleValveConditions.value = [...state.roleValveConditions];

  Object.assign(enabledSuffixes, state.enabledSuffixes);
}

watch(
  () => [props.modelValue, props.initialState] as const,
  ([isOpen, initialState]) => {
    if (!isOpen) {
      return;
    }

    applyEditorState(initialState ?? createDefaultDiarySyntaxState());
  },
  { immediate: true }
);

function close(): void {
  emit("update:modelValue", false);
}
</script>

<style scoped>
.diary-syntax-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--overlay-backdrop);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.diary-syntax-panel {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  max-height: min(92vh, 920px);
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.diary-syntax-header,
.syntax-preview-bar {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5);
  border-bottom: 1px solid var(--border-color);
}

.diary-syntax-header h2 {
  margin: var(--space-2) 0;
  font-size: var(--font-size-display);
}

.diary-syntax-header p,
.syntax-card p,
.k-card p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.diary-close-btn {
  color: var(--primary-text);
}

.diary-syntax-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  overflow-y: auto;
}

.syntax-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.syntax-field--full :deep(.ui-input) {
  width: 100%;
}

.syntax-field span,
.inline-number span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.syntax-field small {
  color: var(--secondary-text);
}

.syntax-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.syntax-card {
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--tertiary-bg);
}

.syntax-classic-card {
  background: color-mix(in srgb, var(--highlight-text) 8%, var(--tertiary-bg));
  border-color: color-mix(in srgb, var(--highlight-text) 26%, var(--border-color));
}

.syntax-card--mode {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.syntax-card-title,
.syntax-option-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.syntax-card-title {
  justify-content: flex-start;
  color: var(--primary-text);
  font-weight: 700;
}

.syntax-card-title .material-symbols-outlined {
  color: var(--highlight-text);
}

.syntax-option-head strong {
  display: block;
  margin-bottom: 4px;
}

.syntax-option-head code,
.diary-syntax-header code,
.syntax-preview-bar code,
.syntax-field code,
.syntax-card p code,
.k-card p code {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--highlight-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.syntax-option-card--wide {
  grid-column: 1 / -1;
}

.dsl-page-tabs,
.mode-toggle,
.ai-mode-row,
.logic-row,
.preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.dsl-page-tabs :deep(.ui-button),
.mode-toggle :deep(.ui-button),
.ai-mode-row :deep(.ui-button),
.logic-row :deep(.ui-button) {
  border-radius: var(--radius-full);
}

.dsl-page-tabs :deep(.ui-button.active),
.mode-toggle :deep(.ui-button.active),
.ai-mode-row :deep(.ui-button.active),
.logic-row :deep(.ui-button.active) {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  color: var(--highlight-text);
}

.dsl-page-tabs {
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--tertiary-bg);
}

.dsl-page-tabs :deep(.ui-button .material-symbols-outlined) {
  font-size: 18px !important;
}

.direct-dsl-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.inline-number {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-3);
}

.inline-number :deep(.ui-input) {
  width: 100%;
}

.time-decay-grid,
.role-valve-builder {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.time-decay-grid.disabled,
.role-valve-builder.disabled {
  opacity: 0.62;
}

.role-valve-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) 96px 96px auto;
  gap: var(--space-2);
}

.condition-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.condition-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--info-border);
  border-radius: var(--radius-full);
  background: var(--info-bg);
  color: var(--info-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.condition-chip :deep(.ui-icon-button) {
  color: inherit;
}

.condition-empty {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.k-card {
  border-color: var(--warning-border);
  background: var(--warning-bg);
}

.syntax-preview-bar {
  align-items: center;
  border-top: 1px solid var(--border-color);
  border-bottom: none;
  background: color-mix(in srgb, var(--primary-bg) 34%, var(--secondary-bg));
}

.syntax-preview-bar > div:first-child {
  min-width: 0;
}

.syntax-preview-bar span {
  display: block;
  margin-bottom: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.syntax-preview-bar code {
  display: block;
  max-width: 62vw;
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--font-size-body);
}

.diary-syntax-modal-enter-active,
.diary-syntax-modal-leave-active {
  transition: opacity var(--transition-fast);
}

.diary-syntax-modal-enter-from,
.diary-syntax-modal-leave-to {
  opacity: 0;
}

@media (max-width: 860px) {
  .syntax-grid {
    grid-template-columns: 1fr;
  }

  .role-valve-row {
    grid-template-columns: 1fr;
  }

  .syntax-preview-bar,
  .diary-syntax-header {
    flex-direction: column;
  }

  .syntax-preview-bar code {
    max-width: 100%;
  }

  .preview-actions :deep(.ui-button) {
    flex: 1 1 180px;
    justify-content: center;
  }
}
</style>

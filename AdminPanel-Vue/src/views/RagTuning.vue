<template>
  <section class="config-section active-section rag-lab">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiDirtyIndicator
          label="未保存"
          :is-dirty="isDirty"
        />
        <UiButton
          variant="secondary"
          :disabled="isThemeLoading"
          @click="loadThemes"
        >
          {{ isThemeLoading ? "刷新中…" : "刷新预设" }}
        </UiButton>
        <UiButton
          variant="secondary"
          :disabled="!isDirty"
          @click="resetParams"
        >
          重置修改
        </UiButton>
        <UiButton
          type="submit"
          :form="formId"
          :disabled="isSaving || !hasParams || !isDirty"
        >
          {{ isSaving ? "保存中…" : "保存参数配置" }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div v-if="isLoading" class="rag-lab__state card">
      <span class="material-symbols-outlined">hourglass_top</span>
      <div>
        <strong>正在加载 RAG 参数</strong>
        <p>读取完成后会按分组展开到参数工作台中。</p>
      </div>
    </div>

    <div v-else-if="loadError" class="rag-lab__state rag-lab__state--error card">
      <span class="material-symbols-outlined">error</span>
      <div>
        <strong>参数加载失败</strong>
        <p>{{ loadError }}</p>
      </div>
      <UiButton variant="secondary" @click="loadParams">重新加载</UiButton>
    </div>

    <form v-else :id="formId" class="rag-lab__workspace" @submit.prevent="saveParams">
      <aside class="rag-lab__aside">
        <div
          class="rag-console"
          aria-label="RAG 调优操作台"
        >
            <div class="rag-console__section rag-console__section--themes">
              <div class="rag-console__themes-header">
                <div>
                  <span class="rag-console__label">参数预设</span>
                  <p>以 <code>rag_params_模型名.json</code> 保存不同向量模型方案。</p>
                </div>
              </div>

              <label class="theme-field">
                <span>选择预设</span>
                <UiSelect v-model="selectedThemeName" :disabled="isThemeLoading || isThemeSaving">
                  <option value="">未选择预设</option>
                  <option
                    v-for="theme in ragParamThemes"
                    :key="theme.fileName"
                    :value="theme.name"
                  >
                    {{ theme.name }}
                  </option>
                </UiSelect>
              </label>

              <div class="rag-console__actions rag-console__theme-actions">
                <UiButton
                  variant="secondary"
                  :disabled="!selectedThemeName || isThemeLoading || isThemeSaving"
                  @click="openSelectedTheme"
                >
                  打开预设调参
                </UiButton>
                <UiButton
                  variant="secondary"
                  :disabled="!selectedThemeName || isThemeLoading || isThemeSaving || !hasParams"
                  @click="saveCurrentToSelectedTheme"
                >
                  保存到所选预设
                </UiButton>
                <UiButton
                  :disabled="!selectedThemeName || isThemeLoading || isThemeSaving"
                  @click="applySelectedTheme"
                >
                  应用所选预设
                </UiButton>
              </div>

              <UiBadge
                v-if="statusMessage"
                class="rag-console__status"
                :variant="statusBadgeVariant"
                role="status"
                aria-live="polite"
              >
                {{ statusMessage }}
              </UiBadge>

              <label class="theme-field">
                <span>新预设名称 / 向量模型名</span>
                <UiInput
                  v-model.trim="newThemeName"
                  type="text"
                  placeholder="例如 gemini-embedding-2-preview"
                  :disabled="isThemeSaving"
                />
              </label>

              <UiButton
                :disabled="!canSaveNewTheme"
                block
                @click="saveCurrentAsNewTheme"
              >
                {{ isThemeSaving ? "保存预设中…" : "保存当前为新预设" }}
              </UiButton>
            </div>

            <div class="rag-console__section rag-console__section--simulation">
              <span class="rag-console__label">语义沙盘</span>
              <div class="semantic-sim-card">
                <div class="semantic-sim-card__copy">
                  <strong>浪潮语义地形模拟器</strong>
                  <p>预览 KNN 击中、顺逆流、虫洞跃迁与测地线能量场。</p>
                </div>
                <UiButton @click="openSemanticSimulation">
                  打开沙盘
                </UiButton>
              </div>
            </div>

            <div class="rag-console__section rag-console__section--training">
              <span class="rag-console__label">主动自学习</span>
              <div class="active-training-card">
                <div class="active-training-card__copy">
                  <strong>全量重训练</strong>
                  <p>立即触发浪潮引擎原本由 1% 新标签阈值触发的全量训练，并重置阈值计数。</p>
                </div>
                <UiButton
                  variant="secondary"
                  :disabled="isActiveTraining"
                  @click="triggerActiveFullTraining"
                >
                  {{ isActiveTraining ? "训练已排队…" : "触发全量自学习" }}
                </UiButton>
              </div>
            </div>

            <div class="rag-console__section">
              <span class="rag-console__label">快速跳转</span>
              <div class="rag-console__jump-list">
                <UiButton
                  v-for="section in groupSections"
                  :key="`${section.name}-jump`"
                  variant="ghost"
                  class="rag-console__jump-btn"
                  @click="scrollToGroup(section.anchor)"
                >
                  <span>{{ section.meta.title }}</span>
                  <small>{{ section.changedLeaves }}/{{ section.totalLeaves }}</small>
                </UiButton>
              </div>
            </div>

            <div class="rag-console__section">
              <span class="rag-console__label">风险提示</span>
              <ul class="rag-console__tips">
                <li>高风险参数建议单独修改并观察效果。</li>
                <li>虫洞路由参数耦合较强，不建议一次联动改太多项。</li>
                <li>
                  召回漂移时优先回看 <code>tensionThreshold</code>、
                  <code>baseMomentum</code> 和 <code>dynamicBoostRange</code>。
                </li>
              </ul>
            </div>
        </div>
      </aside>

      <div class="rag-lab__main">
        <header class="rag-lab__summary">
          <div class="rag-lab__summary-copy">
            <h2>浪潮 RAG 参数调优工作台</h2>
            <p>
              按模块浏览和调整核心参数；复杂的虫洞脉冲、有序共现与语义地形模拟可进入独立控制舱细化。
            </p>
          </div>

          <div class="rag-lab__summary-stats">
            <div class="hero-stat">
              <span class="hero-stat__value">{{ groupSections.length }}</span>
              <span class="hero-stat__label">参数组</span>
            </div>
            <div class="hero-stat">
              <span class="hero-stat__value">{{ totalLeafCount }}</span>
              <span class="hero-stat__label">可调节点</span>
            </div>
            <div class="hero-stat" :class="{ 'hero-stat--warning': isDirty }">
              <span class="hero-stat__value">{{ changedLeafCount }}</span>
              <span class="hero-stat__label">未保存修改</span>
            </div>
          </div>
        </header>

        <article
          v-for="section in groupSections"
          :id="section.anchor"
          :key="section.name"
          :class="[
            'group-panel',
            `group-panel--${section.name}`,
          ]"
          :style="{ '--group-accent': section.meta.accent }"
        >
          <header class="group-panel__header">
            <div class="group-panel__header-main">
              <div class="group-panel__title-row">
                <span class="material-symbols-outlined">{{ section.meta.icon }}</span>
                <div class="group-panel__title-copy">
                  <h3>{{ section.meta.title }}</h3>
                  <div class="group-panel__meta-row">
                    <UiBadge class="group-panel__badge" variant="outline">{{ section.meta.badge }}</UiBadge>
                    <span class="group-panel__name">{{ section.name }}</span>
                  </div>
                </div>
              </div>
              <p class="group-panel__description">{{ section.meta.description }}</p>
            </div>

            <div class="group-panel__metrics">
              <div class="group-panel__metric">
                <span>{{ section.entries.length }}</span>
                <small>模块</small>
              </div>
              <div class="group-panel__metric">
                <span>{{ section.changedLeaves }}/{{ section.totalLeaves }}</span>
                <small>已改动</small>
              </div>
            </div>
          </header>

          <div class="group-panel__list">
            <section
              v-for="entry in section.entries"
              :key="entry.key"
              :class="[
                'param-row',
                `param-row--${entry.kind}`,
                {
                  'param-row--changed': entry.changedLeaves > 0,
                  'param-row--wormhole': isWormholeEntry(section.name, entry),
                  'param-row--ordered': isOrderedCooccurrenceEntry(section.name, entry),
                  'param-row--geodesic': isGeodesicEntry(section.name, entry),
                },
              ]"
            >
              <template v-if="isWormholeEntry(section.name, entry)">
                <div class="wormhole-launchpad">
                  <div class="wormhole-launchpad__copy">
                    <div class="param-row__heading">
                      <div class="param-row__title-block">
                        <h4>{{ entry.meta.label }}</h4>
                        <details v-if="entry.meta.logic" class="param-row__details param-row__details--inline">
                          <summary>展开调优逻辑</summary>
                          <div class="param-row__details-body">
                            <p>{{ entry.meta.logic }}</p>
                          </div>
                        </details>
                        <p class="param-row__key">{{ entry.key }}</p>
                      </div>

                      <div class="param-row__pills">
                        <UiBadge :variant="getToneBadgeVariant(entry.meta.tone)">
                          {{ getToneLabel(entry.meta.tone) }}
                        </UiBadge>
                        <UiBadge
                          v-if="entry.changedLeaves > 0"
                          variant="info"
                        >
                          已修改 {{ entry.changedLeaves }}
                        </UiBadge>
                      </div>
                    </div>

                    <p class="param-row__summary">{{ entry.meta.summary }}</p>

                    <p v-if="entry.meta.range" class="param-row__range">
                      <span class="material-symbols-outlined">straighten</span>
                      {{ entry.meta.range }}
                    </p>

                  </div>

                  <div class="wormhole-launchpad__control">
                    <div class="wormhole-launchpad__stats">
                      <article
                        v-for="subKey in WORMHOLE_PRIMARY_KEYS"
                        :key="subKey"
                        class="wormhole-launchpad__stat"
                      >
                        <span>{{ getWormholeQuickLabel(subKey) }}</span>
                        <strong>{{ getWormholeQuickValue(entry, subKey) }}</strong>
                      </article>
                    </div>

                    <div class="wormhole-launchpad__footer">
                      <UiButton @click="openWormholeModal">
                        打开虫洞控制舱
                      </UiButton>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else-if="isOrderedCooccurrenceEntry(section.name, entry)">
                <div class="wormhole-launchpad ordered-launchpad">
                  <div class="wormhole-launchpad__copy">
                    <div class="param-row__heading">
                      <div class="param-row__title-block">
                        <h4>{{ entry.meta.label }}</h4>
                        <details v-if="entry.meta.logic" class="param-row__details param-row__details--inline">
                          <summary>展开 V8.2 调优逻辑</summary>
                          <div class="param-row__details-body">
                            <p>{{ entry.meta.logic }}</p>
                          </div>
                        </details>
                        <p class="param-row__key">{{ entry.key }}</p>
                      </div>

                      <div class="param-row__pills">
                        <UiBadge :variant="getToneBadgeVariant(entry.meta.tone)">
                          {{ getToneLabel(entry.meta.tone) }}
                        </UiBadge>
                        <UiBadge
                          v-if="entry.changedLeaves > 0"
                          variant="info"
                        >
                          已修改 {{ entry.changedLeaves }}
                        </UiBadge>
                      </div>
                    </div>

                    <p class="param-row__summary">{{ entry.meta.summary }}</p>

                    <p v-if="entry.meta.range" class="param-row__range">
                      <span class="material-symbols-outlined">account_tree</span>
                      {{ entry.meta.range }}
                    </p>

                  </div>

                  <div class="wormhole-launchpad__control ordered-launchpad__control">
                    <div class="ordered-launchpad__axis">
                      <article
                        v-for="axis in ORDERED_COOCCURRENCE_PANELS.slice(0, 3)"
                        :key="axis.id"
                        class="ordered-launchpad__axis-card"
                      >
                        <span>{{ axis.title }}</span>
                        <strong>{{ axis.axis }}</strong>
                      </article>
                    </div>

                    <div class="wormhole-launchpad__stats">
                      <article
                        v-for="subKey in ORDERED_COOCCURRENCE_PRIMARY_KEYS"
                        :key="subKey"
                        class="wormhole-launchpad__stat"
                      >
                        <span>{{ getOrderedQuickLabel(subKey) }}</span>
                        <strong>{{ getOrderedQuickValue(entry, subKey) }}</strong>
                      </article>
                    </div>

                    <div class="wormhole-launchpad__footer">
                      <UiButton @click="openOrderedCooccurrenceModal">
                        打开 V8.2 流形舱
                      </UiButton>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else-if="isGeodesicEntry(section.name, entry)">
                <div class="geodesic-launchpad__copy">
                  <div class="param-row__heading">
                    <div class="param-row__title-block">
                      <h4>{{ entry.meta.label }}</h4>
                      <details v-if="entry.meta.logic" class="param-row__details param-row__details--inline">
                        <summary>展开测地线融合逻辑</summary>
                        <div class="param-row__details-body">
                          <p>{{ entry.meta.logic }}</p>
                        </div>
                      </details>
                      <p class="param-row__key">{{ entry.key }}</p>
                    </div>

                    <div class="param-row__pills">
                      <UiBadge :variant="getToneBadgeVariant(entry.meta.tone)">
                        {{ getToneLabel(entry.meta.tone) }}
                      </UiBadge>
                      <UiBadge
                        v-if="entry.changedLeaves > 0"
                        variant="info"
                      >
                        已修改 {{ entry.changedLeaves }}
                      </UiBadge>
                    </div>
                  </div>

                  <p class="param-row__summary">{{ entry.meta.summary }}</p>

                  <p v-if="entry.meta.range" class="param-row__range">
                    <span class="material-symbols-outlined">route</span>
                    {{ entry.meta.range }}
                  </p>

                </div>

                <div class="geodesic-launchpad__control">
                  <div class="geodesic-meter">
                    <div class="geodesic-meter__label-row">
                      <span>KNN 置信度</span>
                      <strong>{{ formatNumber(1 - getGeodesicAlpha(entry)) }}</strong>
                    </div>
                    <div class="geodesic-meter__bar">
                      <span
                        class="geodesic-meter__fill"
                        :style="{ width: `${getGeodesicAlpha(entry) * 100}%` }"
                      ></span>
                    </div>
                    <div class="geodesic-meter__label-row">
                      <span>测地线置信度 α</span>
                      <strong>{{ formatNumber(getGeodesicAlpha(entry)) }}</strong>
                    </div>
                  </div>

                  <div
                    v-for="subKey in Object.keys(entry.value)"
                    :key="`${entry.key}-${subKey}`"
                    class="geodesic-field"
                  >
                    <div class="geodesic-field__copy">
                      <h5>{{ getNestedMeta(section.name, entry.key, subKey).label }}</h5>
                      <p>{{ getNestedMeta(section.name, entry.key, subKey).summary }}</p>
                      <span v-if="getNestedMeta(section.name, entry.key, subKey).range">
                        {{ getNestedMeta(section.name, entry.key, subKey).range }}
                      </span>
                    </div>

                    <div class="geodesic-field__control">
                      <input
                        v-model.number="
                          (section.raw[entry.key] as Record<string, number>)[subKey]
                        "
                        type="range"
                        :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 滑杆`"
                        :min="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).min"
                        :max="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).max"
                        :step="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).step"
                      />
                      <UiInput
                        v-model.number="
                          (section.raw[entry.key] as Record<string, number>)[subKey]
                        "
                        type="number"
                        :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 数值输入`"
                        :min="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).min"
                        :max="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).max"
                        :step="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).step"
                      />
                    </div>
                  </div>

                  <UiButton
                    variant="secondary"
                    :disabled="entry.changedLeaves === 0"
                    @click="resetGeodesicParams"
                  >
                    恢复测地线参数
                  </UiButton>
                </div>
              </template>

              <template v-else>
                <div class="param-row__copy">
                  <div class="param-row__heading">
                    <div class="param-row__title-block">
                      <h4>{{ entry.meta.label }}</h4>
                      <details v-if="entry.meta.logic" class="param-row__details param-row__details--inline">
                        <summary>展开调优逻辑</summary>
                        <div class="param-row__details-body">
                          <p>{{ entry.meta.logic }}</p>
                        </div>
                      </details>
                      <p class="param-row__key">{{ entry.key }}</p>
                    </div>

                    <div class="param-row__pills">
                      <UiBadge variant="secondary">
                        {{ getKindLabel(entry.kind) }}
                      </UiBadge>
                      <UiBadge
                        v-if="entry.meta.tone"
                        :variant="getToneBadgeVariant(entry.meta.tone)"
                      >
                        {{ getToneLabel(entry.meta.tone) }}
                      </UiBadge>
                      <UiBadge
                        v-if="entry.changedLeaves > 0"
                        variant="info"
                      >
                        已修改 {{ entry.changedLeaves }}
                      </UiBadge>
                    </div>
                  </div>

                  <p class="param-row__summary">{{ entry.meta.summary }}</p>

                  <p v-if="entry.meta.range" class="param-row__range">
                    <span class="material-symbols-outlined">straighten</span>
                    {{ entry.meta.range }}
                  </p>

                </div>

                <div class="param-row__control">
                  <div v-if="entry.kind === 'number'" class="control-shell">
                    <label class="control-shell__label" :for="entry.fieldId">当前数值</label>
                    <UiInput
                      :id="entry.fieldId"
                      v-model.number="(section.raw as Record<string, number>)[entry.key]"
                      type="number"
                      :step="getNumberStep(entry.value)"
                    />
                  </div>

                  <div
                    v-else-if="entry.kind === 'tuple'"
                    class="control-shell control-shell--tuple"
                  >
                    <div class="tuple-grid">
                      <label
                        v-for="(itemValue, index) in entry.value"
                        :key="`${entry.key}-${index}`"
                        class="tuple-field"
                      >
                        <span>{{ getTupleFieldLabel(entry, index) }}</span>
                        <UiInput
                          v-model.number="(section.raw[entry.key] as number[])[index]"
                          type="number"
                          :step="getNumberStep(itemValue)"
                        />
                      </label>
                    </div>
                  </div>

                  <div v-else class="control-shell control-shell--nested">
                    <div class="nested-header">
                      <span>子参数模块</span>
                      <span>{{ Object.keys(entry.value).length }} 项</span>
                    </div>

                    <div class="nested-list">
                      <div
                        v-for="subKey in Object.keys(entry.value)"
                        :key="`${entry.key}-${subKey}`"
                        class="nested-item"
                      >
                        <div class="nested-item__copy">
                          <div class="nested-item__title">
                            <h5>{{ getNestedMeta(section.name, entry.key, subKey).label }}</h5>
                            <span class="nested-item__key">{{ subKey }}</span>
                          </div>

                          <p class="nested-item__summary">
                            {{ getNestedMeta(section.name, entry.key, subKey).summary }}
                          </p>

                          <div class="nested-item__meta">
                            <UiBadge
                              v-if="getNestedMeta(section.name, entry.key, subKey).tone"
                              :variant="getToneBadgeVariant(getNestedMeta(section.name, entry.key, subKey).tone)"
                            >
                              {{
                                getToneLabel(
                                  getNestedMeta(section.name, entry.key, subKey).tone
                                )
                              }}
                            </UiBadge>
                            <span
                              v-if="getNestedMeta(section.name, entry.key, subKey).range"
                              class="nested-item__range"
                            >
                              {{ getNestedMeta(section.name, entry.key, subKey).range }}
                            </span>
                          </div>
                        </div>

                        <div class="nested-item__control">
                          <input
                            v-model.number="
                              (section.raw[entry.key] as Record<string, number>)[subKey]
                            "
                            class="nested-item__slider"
                            type="range"
                            :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 滑杆`"
                            :min="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).min"
                            :max="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).max"
                            :step="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).step"
                          />
                          <UiInput
                            v-model.number="
                              (section.raw[entry.key] as Record<string, number>)[subKey]
                            "
                            class="nested-item__number"
                            type="number"
                            :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 数值输入`"
                            :min="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).min"
                            :max="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).max"
                            :step="getSubParamRange(`${entry.key}.${subKey}`, (section.raw[entry.key] as Record<string, number>)[subKey]).step"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </section>
          </div>
        </article>
      </div>

    </form>

    <WormholeRoutingModal
      v-if="wormholeEntry"
      :model-value="wormholeModalOpen"
      :group-name="WORMHOLE_GROUP_NAME"
      :param-key="WORMHOLE_PARAM_KEY"
      :values="wormholeCurrentValues"
      :original-values="wormholeOriginalValues"
      :changed-leaves="wormholeEntry.changedLeaves"
      :total-leaves="wormholeEntry.totalLeaves"
      :is-saving="isSaving"
      :is-dirty="isDirty"
      :form-id="formId"
      @close="closeWormholeModal"
      @restore="resetWormholeParams"
      @update-field="updateWormholeField"
    />

    <OrderedCooccurrenceModal
      v-if="orderedCooccurrenceEntry"
      :model-value="orderedCooccurrenceModalOpen"
      :group-name="ORDERED_COOCCURRENCE_GROUP_NAME"
      :param-key="ORDERED_COOCCURRENCE_PARAM_KEY"
      :values="orderedCooccurrenceCurrentValues"
      :original-values="orderedCooccurrenceOriginalValues"
      :changed-leaves="orderedCooccurrenceEntry.changedLeaves"
      :total-leaves="orderedCooccurrenceEntry.totalLeaves"
      :is-saving="isSaving"
      :is-dirty="isDirty"
      :form-id="formId"
      @close="closeOrderedCooccurrenceModal"
      @restore="resetOrderedCooccurrenceParams"
      @update-field="updateOrderedCooccurrenceField"
    />

    <Teleport to="body">
      <div
        v-if="semanticSimulationOpen"
        class="semantic-sim-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="semantic-sim-modal-title"
      >
        <div class="semantic-sim-modal__backdrop" @click="closeSemanticSimulation"></div>
        <section class="semantic-sim-modal__panel">
          <header class="semantic-sim-modal__header">
            <div>
              <span class="semantic-sim-modal__eyebrow">TagMemo Terrain Sandbox</span>
              <h3 id="semantic-sim-modal-title">浪潮语义地形沙盘</h3>
              <p>
                当前沙盘会接收此页面尚未保存的有序共现与虫洞脉冲参数，用于快速观察调参方向的视觉影响。
              </p>
            </div>
            <div class="semantic-sim-modal__actions">
              <UiButton variant="secondary" @click="postSemanticSimulationParams">
                同步当前参数
              </UiButton>
              <UiButton variant="secondary" @click="closeSemanticSimulation">
                关闭沙盘
              </UiButton>
            </div>
          </header>
          <iframe
            ref="semanticSimulationFrame"
            class="semantic-sim-modal__frame"
            :src="semanticSimulationUrl"
            title="浪潮语义地形沙盘"
            @load="postSemanticSimulationParams"
          ></iframe>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ragApi,
  type ParamGroup,
  type ParamValue,
  type RagParamTheme,
  type RagParams,
} from "@/api";
import { useAppStore } from "@/stores/app";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiDirtyIndicator from "@/components/ui/UiDirtyIndicator.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import OrderedCooccurrenceModal from "@/features/rag-tuning/OrderedCooccurrenceModal.vue";
import WormholeRoutingModal from "@/features/rag-tuning/WormholeRoutingModal.vue";
import {
  GROUP_ORDER,
  ORDERED_COOCCURRENCE_PANELS,
  ORDERED_COOCCURRENCE_PRIMARY_KEYS,
  WORMHOLE_PRIMARY_KEYS,
  getGroupMeta,
  getParamMeta,
  getSubParamRange,
  getToneLabel,
  getTupleLabel,
  type GroupMeta,
  type ParamMeta,
  type ParamTone,
  type OrderedCooccurrencePrimaryKey,
  type WormholePrimaryKey,
} from "@/features/rag-tuning/metadata";
import { showMessage } from "@/utils";

type NumericRecord = Record<string, number>;
type ParamEntryKind = "number" | "tuple" | "nested";
type StatusType = "info" | "success" | "error";
type BadgeVariant = "default" | "secondary" | "success" | "warning" | "danger" | "info" | "outline";

interface ParamEntryBase {
  key: string;
  fieldId: string;
  meta: ParamMeta;
  kind: ParamEntryKind;
  changedLeaves: number;
  totalLeaves: number;
}

interface NumberParamEntry extends ParamEntryBase {
  kind: "number";
  value: number;
}

interface TupleParamEntry extends ParamEntryBase {
  kind: "tuple";
  value: number[];
}

interface NestedParamEntry extends ParamEntryBase {
  kind: "nested";
  value: NumericRecord;
}

type ParamEntry = NumberParamEntry | TupleParamEntry | NestedParamEntry;

interface GroupSection {
  name: string;
  anchor: string;
  meta: GroupMeta;
  raw: ParamGroup;
  entries: ParamEntry[];
  changedLeaves: number;
  totalLeaves: number;
}

const WORMHOLE_GROUP_NAME = "KnowledgeBaseManager";
const WORMHOLE_PARAM_KEY = "spikeRouting";
const GEODESIC_GROUP_NAME = "KnowledgeBaseManager";
const GEODESIC_PARAM_KEY = "geodesicRerank";
const ORDERED_COOCCURRENCE_GROUP_NAME = "KnowledgeBaseManager";
const ORDERED_COOCCURRENCE_PARAM_KEY = "orderedCooccurrence";
const formId = "rag-tuning-form";
const CONTENT_CONTAINER_ID = "config-details-container";
const GROUP_SCROLL_OFFSET = 16;
const semanticSimulationUrl = `${import.meta.env.BASE_URL}tagmemo-simulation.html`;

const appStore = useAppStore();
const params = ref<RagParams>({});
const originalParams = ref<RagParams>({});
const isLoading = ref(true);
const isSaving = ref(false);
const loadError = ref("");
const statusMessage = ref("");
const statusType = ref<StatusType>("info");
const wormholeModalOpen = ref(false);
const orderedCooccurrenceModalOpen = ref(false);
const semanticSimulationOpen = ref(false);
const semanticSimulationFrame = ref<HTMLIFrameElement | null>(null);
const ragParamThemes = ref<RagParamTheme[]>([]);
const selectedThemeName = ref("");
const newThemeName = ref("");
const isThemeLoading = ref(false);
const isThemeSaving = ref(false);
const isActiveTraining = ref(false);

function cloneParams(source: RagParams): RagParams {
  return JSON.parse(JSON.stringify(source));
}

function isNumericRecord(value: ParamValue | undefined): value is NumericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLeafValues(value: ParamValue): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (isNumericRecord(value)) {
    return Object.keys(value).length;
  }

  return 1;
}

function countChangedLeaves(current: ParamValue, original?: ParamValue): number {
  if (original === undefined) {
    return countLeafValues(current);
  }

  if (Array.isArray(current) && Array.isArray(original)) {
    const maxLength = Math.max(current.length, original.length);
    let changedCount = 0;

    for (let index = 0; index < maxLength; index += 1) {
      if (current[index] !== original[index]) {
        changedCount += 1;
      }
    }

    return changedCount;
  }

  if (isNumericRecord(current) && isNumericRecord(original)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(original)]);
    let changedCount = 0;

    keys.forEach((key) => {
      if (current[key] !== original[key]) {
        changedCount += 1;
      }
    });

    return changedCount;
  }

  return current === original ? 0 : 1;
}

function createAnchor(groupName: string): string {
  const normalized = groupName
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `rag-group-${normalized || "default"}`;
}

function createFieldId(groupName: string, paramKey: string): string {
  return `rag-field-${groupName}-${paramKey}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function compareGroupOrder(left: string, right: string): number {
  const leftIndex = GROUP_ORDER.indexOf(left as (typeof GROUP_ORDER)[number]);
  const rightIndex = GROUP_ORDER.indexOf(right as (typeof GROUP_ORDER)[number]);

  if (leftIndex === -1 && rightIndex === -1) {
    return left.localeCompare(right);
  }

  if (leftIndex === -1) {
    return 1;
  }

  if (rightIndex === -1) {
    return -1;
  }

  return leftIndex - rightIndex;
}

function buildEntry(
  groupName: string,
  paramKey: string,
  value: ParamValue,
  original: ParamValue | undefined
): ParamEntry {
  const base = {
    key: paramKey,
    fieldId: createFieldId(groupName, paramKey),
    meta: getParamMeta(groupName, paramKey),
    changedLeaves: countChangedLeaves(value, original),
    totalLeaves: countLeafValues(value),
  };

  if (Array.isArray(value)) {
    return { ...base, kind: "tuple", value };
  }

  if (isNumericRecord(value)) {
    return { ...base, kind: "nested", value };
  }

  return { ...base, kind: "number", value };
}

const groupSections = computed<GroupSection[]>(() =>
  Object.entries(params.value)
    .sort(([left], [right]) => compareGroupOrder(left, right))
    .map(([groupName, groupParams]) => {
      const entries = Object.entries(groupParams).map(([paramKey, value]) =>
        buildEntry(groupName, paramKey, value, originalParams.value[groupName]?.[paramKey])
      );

      return {
        name: groupName,
        anchor: createAnchor(groupName),
        meta: getGroupMeta(groupName),
        raw: groupParams,
        entries,
        changedLeaves: entries.reduce((total, entry) => total + entry.changedLeaves, 0),
        totalLeaves: entries.reduce((total, entry) => total + entry.totalLeaves, 0),
      };
    })
);

const totalLeafCount = computed(() =>
  groupSections.value.reduce((total, section) => total + section.totalLeaves, 0)
);

const changedLeafCount = computed(() =>
  groupSections.value.reduce((total, section) => total + section.changedLeaves, 0)
);

const isDirty = computed(() => changedLeafCount.value > 0);
const hasParams = computed(() => groupSections.value.length > 0);
const statusBadgeVariant = computed<BadgeVariant>(() => {
  if (statusType.value === "success") return "success";
  if (statusType.value === "error") return "danger";
  return "info";
});

const canSaveNewTheme = computed(
  () => hasParams.value && newThemeName.value.trim().length > 0 && !isThemeSaving.value
);

const wormholeEntry = computed<NestedParamEntry | null>(() => {
  const section = groupSections.value.find((item) => item.name === WORMHOLE_GROUP_NAME);
  const entry = section?.entries.find((item) => item.key === WORMHOLE_PARAM_KEY);
  return entry && entry.kind === "nested" ? entry : null;
});

const wormholeCurrentValues = computed<NumericRecord>(() => {
  const raw = params.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

const wormholeOriginalValues = computed<NumericRecord>(() => {
  const raw = originalParams.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

const orderedCooccurrenceEntry = computed<NestedParamEntry | null>(() => {
  const section = groupSections.value.find((item) => item.name === ORDERED_COOCCURRENCE_GROUP_NAME);
  const entry = section?.entries.find((item) => item.key === ORDERED_COOCCURRENCE_PARAM_KEY);
  return entry && entry.kind === "nested" ? entry : null;
});

const orderedCooccurrenceCurrentValues = computed<NumericRecord>(() => {
  const raw = params.value[ORDERED_COOCCURRENCE_GROUP_NAME]?.[ORDERED_COOCCURRENCE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

const orderedCooccurrenceOriginalValues = computed<NumericRecord>(() => {
  const raw = originalParams.value[ORDERED_COOCCURRENCE_GROUP_NAME]?.[ORDERED_COOCCURRENCE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

const semanticSimulationParams = computed<NumericRecord>(() => ({
  ...orderedCooccurrenceCurrentValues.value,
  ...wormholeCurrentValues.value,
}));

function isWormholeNestedEntry(entry: ParamEntry): entry is NestedParamEntry {
  return entry.kind === "nested" && entry.key === WORMHOLE_PARAM_KEY;
}

function isGeodesicNestedEntry(entry: ParamEntry): entry is NestedParamEntry {
  return entry.kind === "nested" && entry.key === GEODESIC_PARAM_KEY;
}

function isWormholeEntry(sectionName: string, entry: ParamEntry): boolean {
  return sectionName === WORMHOLE_GROUP_NAME && isWormholeNestedEntry(entry);
}

function isGeodesicEntry(sectionName: string, entry: ParamEntry): boolean {
  return sectionName === GEODESIC_GROUP_NAME && isGeodesicNestedEntry(entry);
}

function isOrderedCooccurrenceNestedEntry(entry: ParamEntry): entry is NestedParamEntry {
  return entry.kind === "nested" && entry.key === ORDERED_COOCCURRENCE_PARAM_KEY;
}

function isOrderedCooccurrenceEntry(sectionName: string, entry: ParamEntry): boolean {
  return sectionName === ORDERED_COOCCURRENCE_GROUP_NAME && isOrderedCooccurrenceNestedEntry(entry);
}

function getKindLabel(kind: ParamEntryKind): string {
  switch (kind) {
    case "number":
      return "单值";
    case "tuple":
      return "区间/配比";
    case "nested":
      return "子模块";
    default:
      return "参数";
  }
}

function getToneBadgeVariant(tone?: ParamTone): BadgeVariant {
  if (tone === "critical") return "danger";
  if (tone === "sensitive") return "warning";
  return "secondary";
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) {
    return "--";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const precision = Math.abs(value) >= 1 ? 2 : 3;
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function getNumberStep(value: number): number {
  if (Number.isInteger(value) && Math.abs(value) >= 1) {
    return 1;
  }

  if (Math.abs(value) < 0.1) {
    return 0.001;
  }

  if (Math.abs(value) < 1) {
    return 0.01;
  }

  return 0.05;
}

function getTupleFieldLabel(entry: TupleParamEntry, index: number): string {
  return getTupleLabel(entry.meta, index);
}

function getNestedMeta(groupName: string, paramKey: string, subKey: string): ParamMeta {
  return getParamMeta(groupName, `${paramKey}.${subKey}`);
}

function getGeodesicAlpha(entry: ParamEntry): number {
  if (!isGeodesicNestedEntry(entry)) {
    return 0;
  }

  const rawAlpha = Number(entry.value.alpha);
  return Number.isFinite(rawAlpha) ? Math.max(0, Math.min(1, rawAlpha)) : 0;
}

function getWormholeQuickLabel(subKey: WormholePrimaryKey): string {
  return getNestedMeta(WORMHOLE_GROUP_NAME, WORMHOLE_PARAM_KEY, subKey).label;
}

function getWormholeQuickValue(entry: ParamEntry, subKey: WormholePrimaryKey): string {
  if (!isWormholeNestedEntry(entry)) {
    return "--";
  }

  return formatNumber(entry.value[subKey]);
}

function getOrderedQuickLabel(subKey: OrderedCooccurrencePrimaryKey): string {
  return getNestedMeta(
    ORDERED_COOCCURRENCE_GROUP_NAME,
    ORDERED_COOCCURRENCE_PARAM_KEY,
    subKey
  ).label;
}

function getOrderedQuickValue(entry: ParamEntry, subKey: OrderedCooccurrencePrimaryKey): string {
  if (!isOrderedCooccurrenceNestedEntry(entry)) {
    return "--";
  }

  return formatNumber(entry.value[subKey]);
}

function resolveContentContainer(target?: HTMLElement): HTMLElement | null {
  const container = document.getElementById(CONTENT_CONTAINER_ID);
  if (container instanceof HTMLElement) {
    return container;
  }

  if (target) {
    const fallbackContainer = target.closest<HTMLElement>(".content");
    if (fallbackContainer) {
      return fallbackContainer;
    }
  }

  return null;
}

function scrollToGroup(anchor: string): void {
  const target = document.getElementById(anchor);
  if (!target) {
    return;
  }

  const contentContainer = resolveContentContainer(target);
  if (contentContainer) {
    const containerRect = contentContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop =
      contentContainer.scrollTop +
      (targetRect.top - containerRect.top) -
      GROUP_SCROLL_OFFSET;

    contentContainer.scrollTo({
      top: Math.max(targetTop, 0),
      behavior: "smooth",
    });
  }
}

function openWormholeModal(): void {
  if (wormholeEntry.value) {
    wormholeModalOpen.value = true;
  }
}

function closeWormholeModal(): void {
  wormholeModalOpen.value = false;
}

function updateSimulationField(subKey: string, value: number): void {
  if (subKey in orderedCooccurrenceCurrentValues.value) {
    updateOrderedCooccurrenceField(subKey, value);
    return;
  }

  if (subKey in wormholeCurrentValues.value) {
    updateWormholeField(subKey, value);
  }
}

function updateWormholeField(subKey: string, value: number): void {
  const raw = params.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];

  if (isNumericRecord(raw)) {
    raw[subKey] = value;
  }
}

function resetWormholeParams(): void {
  const original = originalParams.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];

  if (!params.value[WORMHOLE_GROUP_NAME] || !isNumericRecord(original)) {
    return;
  }

  params.value[WORMHOLE_GROUP_NAME][WORMHOLE_PARAM_KEY] = { ...original };
  statusMessage.value = "已恢复虫洞脉冲路由的未保存修改。";
  statusType.value = "info";
}

function resetGeodesicParams(): void {
  const original = originalParams.value[GEODESIC_GROUP_NAME]?.[GEODESIC_PARAM_KEY];

  if (!params.value[GEODESIC_GROUP_NAME] || !isNumericRecord(original)) {
    return;
  }

  params.value[GEODESIC_GROUP_NAME][GEODESIC_PARAM_KEY] = { ...original };
  statusMessage.value = "已恢复测地线重排的未保存修改。";
  statusType.value = "info";
}

function openOrderedCooccurrenceModal(): void {
  if (orderedCooccurrenceEntry.value) {
    orderedCooccurrenceModalOpen.value = true;
  }
}

function closeOrderedCooccurrenceModal(): void {
  orderedCooccurrenceModalOpen.value = false;
}

function updateOrderedCooccurrenceField(subKey: string, value: number): void {
  const raw = params.value[ORDERED_COOCCURRENCE_GROUP_NAME]?.[ORDERED_COOCCURRENCE_PARAM_KEY];

  if (isNumericRecord(raw)) {
    raw[subKey] = value;
  }
}

function resetOrderedCooccurrenceParams(): void {
  const original =
    originalParams.value[ORDERED_COOCCURRENCE_GROUP_NAME]?.[ORDERED_COOCCURRENCE_PARAM_KEY];

  if (!params.value[ORDERED_COOCCURRENCE_GROUP_NAME] || !isNumericRecord(original)) {
    return;
  }

  params.value[ORDERED_COOCCURRENCE_GROUP_NAME][ORDERED_COOCCURRENCE_PARAM_KEY] = {
    ...original,
  };
  statusMessage.value = "已恢复 V8.2 有序双向势能流形的未保存修改。";
  statusType.value = "info";
}

function handleSemanticSimulationMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) {
    return;
  }

  if (!event.data || event.data.type !== "tagmemo-simulation-params-changed") {
    return;
  }

  const nextParams = event.data.params;

  if (!nextParams || typeof nextParams !== "object") {
    return;
  }

  Object.entries(nextParams as Record<string, unknown>).forEach(([subKey, rawValue]) => {
    if (typeof rawValue !== "number" || Number.isNaN(rawValue)) {
      return;
    }

    updateSimulationField(subKey, rawValue);
  });

  statusMessage.value = "已从浪潮语义沙盘同步未保存参数。";
  statusType.value = "info";
}

function postSemanticSimulationParams(): void {
  const frameWindow = semanticSimulationFrame.value?.contentWindow;

  if (!frameWindow) {
    return;
  }

  frameWindow.postMessage(
    {
      type: "tagmemo-simulation-params",
      params: semanticSimulationParams.value,
      theme: appStore.theme,
    },
    window.location.origin
  );
}

async function openSemanticSimulation(): Promise<void> {
  semanticSimulationOpen.value = true;
  await nextTick();
  postSemanticSimulationParams();
}

function closeSemanticSimulation(): void {
  semanticSimulationOpen.value = false;
}

async function loadThemes(): Promise<void> {
  isThemeLoading.value = true;

  try {
    ragParamThemes.value = await ragApi.getRagParamThemes({
      showLoader: false,
      loadingKey: "rag-tuning.themes.load",
    });

    if (
      selectedThemeName.value &&
      !ragParamThemes.value.some((theme) => theme.name === selectedThemeName.value)
    ) {
      selectedThemeName.value = "";
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `预设列表加载失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isThemeLoading.value = false;
  }
}

async function openSelectedTheme(): Promise<void> {
  if (!selectedThemeName.value || isThemeLoading.value || isThemeSaving.value) {
    return;
  }

  isThemeLoading.value = true;

  try {
    const data = await ragApi.getRagParamTheme(selectedThemeName.value, {
      loadingKey: "rag-tuning.themes.open",
    });

    params.value = cloneParams(data);
    originalParams.value = cloneParams(data);
    statusMessage.value = `已打开预设「${selectedThemeName.value}」，可继续调参后保存到该预设。`;
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `打开预设失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isThemeLoading.value = false;
  }
}

async function saveTheme(themeName: string, successMessage: string): Promise<void> {
  if (!themeName || !hasParams.value || isThemeSaving.value) {
    return;
  }

  isThemeSaving.value = true;

  try {
    const response = await ragApi.saveRagParamTheme(themeName, params.value, {
      loadingKey: "rag-tuning.themes.save",
    });

    const savedThemeName = response.theme?.name || themeName;
    selectedThemeName.value = savedThemeName;
    newThemeName.value = "";
    originalParams.value = cloneParams(params.value);
    await loadThemes();
    statusMessage.value = successMessage.replace("{theme}", savedThemeName);
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存预设失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isThemeSaving.value = false;
  }
}

async function saveCurrentAsNewTheme(): Promise<void> {
  await saveTheme(newThemeName.value, "已保存当前参数为预设「{theme}」。");
}

async function saveCurrentToSelectedTheme(): Promise<void> {
  await saveTheme(selectedThemeName.value, "已更新预设「{theme}」。");
}

async function applySelectedTheme(): Promise<void> {
  if (!selectedThemeName.value || isThemeLoading.value || isThemeSaving.value) {
    return;
  }

  isThemeSaving.value = true;

  try {
    const response = await ragApi.applyRagParamTheme(selectedThemeName.value, {
      loadingKey: "rag-tuning.themes.apply",
    });

    if (response.params) {
      params.value = cloneParams(response.params);
      originalParams.value = cloneParams(response.params);
    } else {
      await loadParams();
    }

    const appliedThemeName = response.theme?.name || selectedThemeName.value;
    selectedThemeName.value = appliedThemeName;
    statusMessage.value = `已应用预设「${appliedThemeName}」到主 RAG 参数。`;
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `应用预设失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isThemeSaving.value = false;
  }
}

async function triggerActiveFullTraining(): Promise<void> {
  if (isActiveTraining.value) {
    return;
  }

  isActiveTraining.value = true;

  try {
    const response = await ragApi.triggerActiveFullTraining({
      loadingKey: "rag-tuning.active-full-training",
    });
    const result = response.result;
    const resetCount = result?.resetPendingNewTags ?? 0;
    const threshold = result?.threshold;

    statusMessage.value = threshold
      ? `已排队浪潮全量自学习任务，已重置 ${resetCount}/${threshold} 个阈值计数。`
      : `已排队浪潮全量自学习任务，已重置 ${resetCount} 个阈值计数。`;
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `触发全量自学习失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isActiveTraining.value = false;
  }
}

async function loadParams(): Promise<void> {
  isLoading.value = true;
  loadError.value = "";

  try {
    const data = await ragApi.getRagParams({
      showLoader: false,
      loadingKey: "rag-tuning.params.load",
    });

    params.value = cloneParams(data);
    originalParams.value = cloneParams(data);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    loadError.value = `加载失败：${errorMessage}`;
    statusMessage.value = loadError.value;
    statusType.value = "error";
    console.error("Failed to load RAG params:", error);
    showMessage(loadError.value, "error");
  } finally {
    isLoading.value = false;
  }
}

async function saveParams(): Promise<void> {
  if (!hasParams.value || !isDirty.value || isSaving.value) {
    return;
  }

  isSaving.value = true;

  try {
    await ragApi.saveRagParams(params.value, {
      loadingKey: "rag-tuning.params.save",
    });

    originalParams.value = cloneParams(params.value);
    statusMessage.value = "RAG 参数已保存。";
    statusType.value = "success";
    showMessage("RAG 参数已保存。", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isSaving.value = false;
  }
}

function resetParams(): void {
  params.value = cloneParams(originalParams.value);
  statusMessage.value = "已恢复到最近一次保存的参数状态。";
  statusType.value = "info";
}

watch(
  semanticSimulationParams,
  () => {
    if (semanticSimulationOpen.value) {
      postSemanticSimulationParams();
    }
  },
  { deep: true }
);

watch(
  () => appStore.theme,
  () => {
    if (semanticSimulationOpen.value) {
      postSemanticSimulationParams();
    }
  }
);

onMounted(() => {
  window.addEventListener("message", handleSemanticSimulationMessage);
  void loadParams();
  void loadThemes();
});

onBeforeUnmount(() => {
  window.removeEventListener("message", handleSemanticSimulationMessage);
});
</script>

<style scoped>
.rag-lab {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.rag-lab__summary-copy h2 {
  margin: 0;
  font-size: 1.125rem;
  line-height: 1.35;
}

.rag-lab__summary-copy p {
  max-width: 68ch;
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.rag-lab__summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.rag-lab__summary-copy {
  display: grid;
  gap: 6px;
}

.rag-lab__summary-stats {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(88px, 108px));
  gap: var(--space-2);
  align-content: start;
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 58px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.hero-stat--warning {
  border-color: var(--warning-border);
  background: var(--warning-bg);
}

.hero-stat__value {
  font-size: var(--font-size-display);
  font-weight: 700;
  line-height: 1;
}

.hero-stat__label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.rag-lab__state {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 20px var(--space-5);
}

.rag-lab__state p {
  margin: 0;
  color: var(--secondary-text);
}

.rag-lab__state .material-symbols-outlined {
  font-size: var(--font-size-section-icon);
  color: var(--highlight-text);
}

.rag-lab__state--error {
  justify-content: space-between;
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.rag-lab__workspace {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.rag-lab__main {
  display: grid;
  gap: var(--space-5);
}

.group-panel {
  position: relative;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  scroll-margin-top: calc(var(--app-top-bar-height, 60px) + 16px);
}

.group-panel + .group-panel {
  margin-top: var(--space-2);
}

.group-panel--ContextFoldingV2 {
  background: transparent;
}

.group-panel__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-4) var(--space-5);
  position: relative;
  border: 1px solid color-mix(in srgb, var(--group-accent) 24%, var(--border-color));
  border-radius: var(--radius-lg);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--group-accent) 4%, transparent),
    transparent 52%
  );
}

.group-panel--ContextFoldingV2 .group-panel__header {
  border-color: color-mix(in srgb, var(--group-accent) 28%, var(--border-color));
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--group-accent) 5%, transparent),
    transparent 56%
  );
}

.group-panel__header-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-panel__badge {
  width: fit-content;
  border-color: color-mix(in srgb, var(--group-accent) 32%, var(--border-color));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--group-accent) 7%, transparent);
}

.group-panel__title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.group-panel__title-row .material-symbols-outlined {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  border: 1px solid color-mix(in srgb, var(--group-accent) 28%, var(--border-color));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--group-accent) 9%, transparent);
  color: color-mix(in srgb, var(--highlight-text) 84%, var(--primary-text));
  font-size: 22px;
}

.group-panel__title-row h3 {
  margin: 0;
  font-size: var(--font-size-title);
}

.group-panel__title-copy {
  display: grid;
  gap: 6px;
}

.group-panel__meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.group-panel__name {
  margin: 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1;
}

.group-panel__description {
  max-width: 70ch;
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  line-height: 1.55;
}

.group-panel__metrics {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.group-panel__metric {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  justify-content: center;
  min-height: 28px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.group-panel__metric span {
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-emphasis);
  font-weight: 700;
}

.group-panel__metric small {
  color: var(--secondary-text);
}

.group-panel__list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
}

.param-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.62fr);
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 58%, transparent);
}

/* 第一行去除上边框：第一个项总要去掉；
   如果第一个是简单卡片且第二个也是简单卡片（两者并排为第一行），第二个也要去掉。 */
.group-panel__list > .param-row:first-child {
  border-top: 0;
}
.group-panel__list > .param-row--number:first-child + .param-row--number,
.group-panel__list > .param-row--number:first-child + .param-row--tuple,
.group-panel__list > .param-row--tuple:first-child + .param-row--number,
.group-panel__list > .param-row--tuple:first-child + .param-row--tuple {
  border-top: 0;
}

.param-row--changed {
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

/* 简单卡片（单值 / 区间）：在 2 列父网格中占 1 列，
   内部从左右两栏改为单列上下堆叠，提高窄宽度下的可读性。 */
.param-row--number,
.param-row--tuple {
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  align-content: start;
  align-items: stretch;
}

.param-row--number .param-row__control,
.param-row--tuple .param-row__control {
  align-self: stretch;
}

/* 复杂卡片：跨满父网格两列，内部仍保留原左右两栏布局。 */
.param-row--nested,
.param-row--wormhole,
.param-row--ordered,
.param-row--geodesic {
  grid-column: 1 / -1;
}

.param-row--nested {
  grid-template-columns: 1fr;
  gap: var(--space-2);
}

.param-row--nested .param-row__control {
  padding-top: 0;
}

.param-row__copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.param-row__heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-4);
}

.param-row__title-block h4 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  line-height: 1.35;
}

.param-row__title-block {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px var(--space-3);
}

.param-row__key {
  flex-basis: 100%;
  margin: 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.param-row__pills {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.param-row__summary {
  margin: 0;
  color: color-mix(in srgb, var(--primary-text) 84%, transparent);
  font-size: var(--font-size-body);
  line-height: 1.55;
}

.param-row__range {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: fit-content;
  min-height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.param-row__range .material-symbols-outlined {
  font-size: var(--font-size-body);
}

.param-row__details summary {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  cursor: pointer;
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
  line-height: 1;
}

.param-row__details--inline {
  display: contents;
}

.param-row__details--inline summary {
  gap: 4px;
  color: var(--secondary-text);
}

.param-row__details--inline summary:hover {
  color: var(--highlight-text);
}

.param-row__details--inline[open] .param-row__details-body {
  flex-basis: 100%;
  order: 3;
}

.param-row__details-body {
  max-width: 68ch;
  margin-top: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.param-row__control {
  display: flex;
  align-items: center;
}

.control-shell {
  display: grid;
  gap: 6px;
  width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.control-shell__label,
.tuple-field span,
.nested-header {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.control-shell :deep(.ui-input),
.tuple-field :deep(.ui-input),
.nested-item__number {
  font-family: "Consolas", "Monaco", monospace;
  min-height: 32px;
}

.control-shell > :deep(.ui-input) {
  width: min(100%, 180px);
  justify-self: end;
  min-height: 30px;
  border-color: transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: right;
}

.control-shell > :deep(.ui-input:hover),
.control-shell > :deep(.ui-input:focus) {
  border-color: color-mix(in srgb, var(--border-color) 78%, var(--highlight-text));
  background: color-mix(in srgb, var(--input-bg) 46%, transparent);
}

.tuple-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3);
}

.tuple-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.control-shell--nested {
  gap: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 64%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 64%, transparent);
  container: nested-shell / inline-size;
}

.nested-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  min-height: 36px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 58%, transparent);
  background: transparent;
  font-weight: 600;
}

.nested-list {
  display: grid;
}

.nested-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.56fr);
  gap: var(--space-5);
  align-items: center;
  padding: 10px var(--space-3);
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 54%, transparent);
  border-radius: 0;
  background: transparent;
}

.nested-item:first-child {
  border-top: 0;
}

.nested-item__copy {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.nested-item__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.nested-item__title h5 {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: 1.35;
}

.nested-item__key {
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.nested-item__summary {
  overflow: hidden;
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nested-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.nested-item__range {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.nested-item__control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px;
  gap: var(--space-3);
  align-items: center;
}

.nested-item__slider {
  width: 100%;
  height: 16px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}

.nested-item__slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--secondary-text) 18%, transparent);
}

.nested-item__slider::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4px;
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 50%, var(--border-color));
  border-radius: 50%;
  background: var(--primary-bg);
  transition: box-shadow var(--transition-fast), border-color var(--transition-fast);
}

.nested-item__slider::-moz-range-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--secondary-text) 18%, transparent);
}

.nested-item__slider::-moz-range-progress {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--highlight-text);
}

.nested-item__slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 50%, var(--border-color));
  border-radius: 50%;
  background: var(--primary-bg);
  transition: box-shadow var(--transition-fast), border-color var(--transition-fast);
}

.nested-item__slider:focus-visible {
  outline: none;
}

.nested-item__slider:focus-visible::-webkit-slider-thumb,
.nested-item__slider:hover::-webkit-slider-thumb {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--highlight-text) 16%, transparent);
}

.nested-item__slider:focus-visible::-moz-range-thumb,
.nested-item__slider:hover::-moz-range-thumb {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--highlight-text) 16%, transparent);
}

.nested-item__number {
  min-width: 0;
  text-align: right;
}

.nested-item__number :deep(.ui-input) {
  min-height: 28px;
  padding-inline: var(--space-2);
  border-color: transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: right;
}

.nested-item__number :deep(.ui-input:hover),
.nested-item__number :deep(.ui-input:focus) {
  border-color: color-mix(in srgb, var(--border-color) 80%, var(--highlight-text));
  background: color-mix(in srgb, var(--input-bg) 54%, transparent);
}

@container nested-shell (max-width: 480px) {
  .nested-item {
    grid-template-columns: 1fr;
  }

  .nested-item__control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 112px;
    align-items: center;
  }
}

@container nested-shell (max-width: 340px) {
  .nested-item__control {
    grid-template-columns: 1fr;
  }
}

.wormhole-launchpad {
  display: contents;
}

.wormhole-launchpad__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.wormhole-launchpad__control {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  justify-content: space-between;
  width: 100%;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.wormhole-launchpad__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.wormhole-launchpad__stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 64px;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.wormhole-launchpad__stat span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.wormhole-launchpad__stat strong {
  font-size: var(--font-size-display);
  line-height: 1;
}

.wormhole-launchpad__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0;
}

.wormhole-launchpad__footer :deep(.ui-button),
.wormhole-launchpad__control :deep(.ui-button) {
  width: 100%;
  justify-content: center;
}

.ordered-launchpad__control {
  border-color: color-mix(in srgb, var(--highlight-text) 18%, var(--border-color));
  background:
    radial-gradient(circle at 16% 0%, color-mix(in srgb, var(--highlight-text) 4%, transparent), transparent 42%),
    color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.ordered-launchpad__axis {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.ordered-launchpad__axis-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  min-height: 56px;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.ordered-launchpad__axis-card span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.ordered-launchpad__axis-card strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.geodesic-launchpad__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.geodesic-launchpad__control {
  display: grid;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 18%, var(--border-color));
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--highlight-text) 4%, transparent), transparent 42%),
    color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.geodesic-meter {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.geodesic-meter__label-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.geodesic-meter__label-row strong {
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
}

.geodesic-meter__bar {
  position: relative;
  height: 10px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--secondary-text) 20%, transparent);
}

.geodesic-meter__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--highlight-text), color-mix(in srgb, var(--highlight-text) 62%, white));
}

.geodesic-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 170px;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.geodesic-field__copy {
  display: grid;
  gap: var(--space-2);
}

.geodesic-field__copy h5,
.geodesic-field__copy p {
  margin: 0;
}

.geodesic-field__copy p,
.geodesic-field__copy span {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.geodesic-field__copy span {
  font-size: var(--font-size-caption);
}

.geodesic-field__control {
  display: grid;
  gap: 10px;
}

.geodesic-field__control input[type="range"] {
  width: 100%;
  margin: 0;
  accent-color: var(--highlight-text);
}

.geodesic-field__control input[type="number"] {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
  text-align: right;
}

.rag-lab__aside {
  position: sticky;
  top: var(--space-2);
  max-height: calc(100vh - var(--app-top-bar-height, 48px) - 28px);
  overflow: auto;
}

.rag-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  transition: padding 0.2s ease;
}

.rag-console__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rag-console__section h3,
.rag-console__section p {
  margin: 0;
}

.rag-console__section p {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.rag-console__label {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.rag-console__actions,
.rag-console__jump-list {
  display: grid;
  gap: var(--space-2);
}

.rag-console__actions button {
  justify-content: center;
}

.rag-console__actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.rag-console__status {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
  line-height: 1.4;
}

.rag-console__themes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.rag-console__themes-header code {
  font-family: "Consolas", "Monaco", monospace;
}

.theme-field {
  display: grid;
  gap: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.rag-console__theme-actions {
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.rag-console__theme-actions :deep(.ui-button) {
  min-width: 0;
  padding-inline: var(--space-2);
}

.rag-console__theme-actions :deep(.ui-button):last-child {
  grid-column: 1 / -1;
}

.rag-console__section--themes {
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 74%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1%, transparent);
}

.rag-console__jump-btn {
  width: 100%;
  border-color: transparent;
  color: var(--primary-text);
  text-align: left;
}

.rag-console__jump-btn :deep(.ui-button__content) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
}

.rag-console__jump-btn small,
.rag-console__tips {
  color: var(--secondary-text);
}

.rag-console__jump-btn small,
.rag-console__tips code {
  font-family: "Consolas", "Monaco", monospace;
}

.rag-console__tips {
  display: grid;
  gap: 10px;
  padding-left: var(--space-4);
}

.active-training-card {
  position: relative;
  overflow: hidden;
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--warning-border) 58%, var(--border-color));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning-bg) 54%, transparent);
}

.active-training-card__copy {
  display: grid;
  gap: var(--space-2);
}

.active-training-card__copy strong {
  font-size: var(--font-size-emphasis);
}

.active-training-card__copy p {
  margin: 0;
  color: var(--secondary-text);
  line-height: 1.6;
}

.active-training-card :deep(.ui-button) {
  justify-content: center;
  width: 100%;
}

.semantic-sim-card {
  position: relative;
  overflow: hidden;
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.group-panel--ContextFoldingV2 .group-panel__metric {
  border-color: transparent;
  background: transparent;
}

.semantic-sim-card__copy {
  position: relative;
  z-index: 1;
  display: grid;
  gap: var(--space-2);
}

.semantic-sim-card__copy strong {
  font-size: var(--font-size-emphasis);
}

.semantic-sim-card__copy p {
  margin: 0;
  color: var(--secondary-text);
  line-height: 1.6;
}

.semantic-sim-card :deep(.ui-button) {
  position: relative;
  z-index: 1;
  justify-content: center;
  width: 100%;
}

.semantic-sim-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.semantic-sim-modal__backdrop {
  position: absolute;
  inset: 0;
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.semantic-sim-modal__panel {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(1480px, calc(100vw - (var(--space-4) * 2)));
  height: min(920px, calc(var(--app-viewport-height) - (var(--space-4) * 2)));
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--highlight-text) 14%, transparent), transparent 34%),
    linear-gradient(0deg, var(--secondary-bg), var(--secondary-bg)),
    var(--primary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.semantic-sim-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--surface-overlay-soft), transparent);
}

.semantic-sim-modal__header h3,
.semantic-sim-modal__header p {
  margin: 0;
}

.semantic-sim-modal__header h3 {
  margin-top: 8px;
  font-size: var(--font-size-section-title-strong);
  line-height: 1.1;
}

.semantic-sim-modal__header p {
  max-width: 82ch;
  margin-top: 10px;
  color: var(--secondary-text);
  line-height: 1.7;
}

.semantic-sim-modal__eyebrow {
  display: inline-flex;
  width: fit-content;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.semantic-sim-modal__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.semantic-sim-modal__frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--primary-bg);
}

@media (max-width: 860px) {
  .semantic-sim-modal__header {
    flex-direction: column;
  }

  .semantic-sim-modal__actions {
    justify-content: flex-start;
  }
}

@media (max-width: 1180px) {
  .rag-lab__summary {
    grid-template-columns: 1fr;
  }

  .rag-lab__summary-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .rag-lab__workspace {
    grid-template-columns: 1fr;
  }

  .rag-lab__aside {
    position: static;
  }
}

@media (max-width: 960px) {
  .group-panel__list {
    grid-template-columns: 1fr;
  }

  .group-panel__header,
  .param-row,
  .wormhole-launchpad,
  .nested-item,
  .geodesic-field {
    grid-template-columns: 1fr;
  }

  .group-panel__header,
  .param-row {
    padding-right: var(--space-4);
  }

  .group-panel__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wormhole-launchpad__footer {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 640px) {
  .rag-lab__summary {
    padding: var(--space-4);
  }

  .rag-lab__summary-stats {
    grid-template-columns: 1fr;
  }

  .group-panel__header {
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  }

  .param-row {
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  }

  .param-row__heading {
    flex-direction: column;
  }

  .param-row__pills {
    justify-content: flex-start;
  }

  .tuple-grid,
  .wormhole-launchpad__stats,
  .ordered-launchpad__axis {
    grid-template-columns: 1fr;
  }
}
</style>

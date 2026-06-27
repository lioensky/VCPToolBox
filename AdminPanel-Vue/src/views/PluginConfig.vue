<template>
  <section class="config-section active-section">
    <p v-if="pluginName" class="description">配置插件：{{ pluginName }}</p>

    <div v-if="pluginData" class="plugin-config-container">
      <UiCard class="plugin-controls" size="sm">
        <UiButton
          @click="togglePlugin"
          :variant="pluginData.enabled ? 'danger' : 'primary'"
          :disabled="isDistributedPlugin"
          :title="isDistributedPlugin ? '分布式插件状态由所属节点管理' : undefined"
        >
          {{ pluginData.enabled ? '禁用插件' : '启用插件' }}
        </UiButton>
        <UiBadge v-if="statusMessage" :variant="getStatusVariant(statusType)">
          {{ statusMessage }}
        </UiBadge>
      </UiCard>

      <form @submit.prevent="savePluginConfig">
        <div v-if="!hasEnvContent && !hasConfigSchema" class="config-warning">
          <div class="warning-content">
            <p class="warning-title">该插件暂无配置文件</p>
            <p class="warning-text">
              插件 <code>{{ pluginName }}</code> 目录下不存在 <code>config.env</code> 文件。
            </p>
            <p class="warning-text">
              您可以在下方添加配置项，点击保存后将自动创建 <code>config.env</code> 文件。
            </p>
          </div>
        </div>

        <div v-if="hasSchemaFields" class="schema-fields-section">
          <h3>Schema 定义的配置</h3>
          <UiField
            v-for="(entry, index) in schemaEntries"
            :key="entry.key || `schema-${index}`"
            :label="entry.key || ''"
            :for-id="`plugin-${entry.key}`"
            class="config-field"
          >

            <div v-if="entry.type === 'boolean'" class="switch-container">
              <AppSwitch
                :input-id="`plugin-${entry.key}`"
                :model-value="Boolean(entry.value)"
                :label="entry.value ? '启用' : '禁用'"
                @update:model-value="entry.value = $event"
              />
            </div>

            <UiInput
              v-else-if="entry.type === 'integer'"
              type="number"
              :id="`plugin-${entry.key}`"
              :model-value="toNumberInputValue(entry.value)"
              @update:model-value="entry.value = $event"
            />

            <div v-if="entry.isMultilineQuoted || String(entry.value || '').length > 60" class="textarea-wrapper">
              <div v-if="entry.key && isSensitiveKey(entry.key)" class="input-with-toggle">
                <UiTextarea
                  :id="`plugin-${entry.key}`"
                  :value="entry.value as unknown as TextareaValue"
                  @update:model-value="entry.value = $event"
                  rows="4"
                  :class="{ 'password-masked': !sensitiveFields[entry.key] }"
                />
                <UiIconButton
                  class="toggle-visibility-btn"
                  :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                  :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                  @click="toggleSensitiveField(entry.key)"
                  :aria-pressed="sensitiveFields[entry.key]"
                >
                  <span class="material-symbols-outlined">
                    {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                  </span>
                </UiIconButton>
              </div>
              <UiTextarea
                v-else
                :id="`plugin-${entry.key}`"
                :value="entry.value as unknown as TextareaValue"
                @update:model-value="entry.value = $event"
                rows="4"
              />
            </div>

            <div v-else-if="entry.key && isSensitiveKey(entry.key)" class="input-with-toggle">
              <UiInput
                :type="sensitiveFields[entry.key] ? 'text' : 'password'"
                :id="`plugin-${entry.key}`"
                :model-value="toTextInputValue(entry.value)"
                @update:model-value="entry.value = $event"
              />
              <UiIconButton
                class="toggle-visibility-btn"
                :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                @click="toggleSensitiveField(entry.key)"
                :aria-pressed="sensitiveFields[entry.key]"
              >
                <span class="material-symbols-outlined">
                  {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                </span>
              </UiIconButton>
            </div>

            <UiInput
              v-else
              type="text"
              :id="`plugin-${entry.key}`"
              :model-value="toTextInputValue(entry.value)"
              @update:model-value="entry.value = $event"
            />

            <span v-if="entry.key" class="description">
              {{ getSchemaDescription(entry.key) }}
              <span class="defined-in" v-if="isKeyInEnv(entry.key)">(当前在插件 .env 中定义)</span>
              <span class="defined-in" v-else-if="hasDefault(entry.key)">(使用插件清单默认值)</span>
              <span class="defined-in" v-else>(未设置，将继承全局或为空)</span>
            </span>
          </UiField>
        </div>

        <div v-if="hasCustomFields || hasCommentEntries" class="custom-fields-section">
          <h3>自定义 .env 配置项 (及注释/空行)</h3>
          <div v-for="(entry, index) in customEntries" :key="entry.key || `custom-${index}`" class="custom-entry-row">
            <div v-if="entry.isCommentOrEmpty" class="custom-entry-comment">
              <pre>{{ entry.value }}</pre>
            </div>

            <div v-else>
              <UiField
                :label="entry.key || ''"
                :for-id="`plugin-${entry.key}`"
                class="config-field"
              >
                <template v-if="entry.key && !isKeyInSchema(entry.key)" #action>
                  <UiButton
                    variant="danger"
                    size="xs"
                    @click="removeCustomField(entry.key)"
                    :title="`删除自定义项 ${entry.key}`"
                  >
                    删除
                  </UiButton>
                </template>

              <div v-if="entry.type === 'boolean'" class="switch-container">
                <AppSwitch
                  :input-id="`plugin-${entry.key}`"
                  :model-value="Boolean(entry.value)"
                  :label="entry.value ? '启用' : '禁用'"
                  @update:model-value="entry.value = $event"
                />
              </div>

              <UiInput
                v-else-if="entry.type === 'integer'"
                type="number"
                :id="`plugin-${entry.key}`"
                :model-value="toNumberInputValue(entry.value)"
                @update:model-value="entry.value = $event"
              />

              <div v-if="entry.isMultilineQuoted || String(entry.value || '').length > 60" class="textarea-wrapper">
                <div v-if="entry.key && isSensitiveKey(entry.key)" class="input-with-toggle">
                  <UiTextarea
                    :id="`plugin-${entry.key}`"
                    :value="entry.value as unknown as TextareaValue"
                    @update:model-value="entry.value = $event"
                    rows="4"
                    :class="{ 'password-masked': !sensitiveFields[entry.key] }"
                  />
                  <UiIconButton
                    class="toggle-visibility-btn"
                    :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                    :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                    @click="toggleSensitiveField(entry.key)"
                    :aria-pressed="sensitiveFields[entry.key]"
                  >
                    <span class="material-symbols-outlined">
                      {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                    </span>
                  </UiIconButton>
                </div>
                <UiTextarea
                  v-else
                  :id="`plugin-${entry.key}`"
                  :value="entry.value as unknown as TextareaValue"
                  @update:model-value="entry.value = $event"
                  rows="4"
                />
              </div>

              <div v-else-if="entry.key && isSensitiveKey(entry.key)" class="input-with-toggle">
                <UiInput
                  :type="sensitiveFields[entry.key] ? 'text' : 'password'"
                  :id="`plugin-${entry.key}`"
                  :model-value="toTextInputValue(entry.value)"
                  @update:model-value="entry.value = $event"
                />
                <UiIconButton
                  class="toggle-visibility-btn"
                  :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                  :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                  @click="toggleSensitiveField(entry.key)"
                  :aria-pressed="sensitiveFields[entry.key]"
                >
                  <span class="material-symbols-outlined">
                    {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                  </span>
                </UiIconButton>
              </div>

              <UiInput
                v-else
                type="text"
                :id="`plugin-${entry.key}`"
                :model-value="toTextInputValue(entry.value)"
                @update:model-value="entry.value = $event"
              />

              <span v-if="entry.key" class="description">自定义配置项：{{ entry.key }} <span class="defined-in">(当前在插件 .env 中定义)</span></span>
              </UiField>
            </div>
          </div>
        </div>

        <div v-if="invocationCommands.length > 0" class="invocation-commands-section">
          <h3>调用命令 AI 指令编辑</h3>
          <div
            v-for="(cmd, index) in invocationCommands"
            :key="`cmd-${getCommandIdentifier(cmd) || index}`"
            class="command-item"
          >
            <h4>命令: {{ getCommandIdentifier(cmd) }}</h4>
            <UiField label="指令描述 (AI Instructions)" :for-id="`cmd-desc-${getCommandIdentifier(cmd)}`">
              <UiTextarea
                :id="`cmd-desc-${getCommandIdentifier(cmd)}`"
                class="command-description-edit"
                rows="5"
                v-model="commandDescriptions[getCommandIdentifier(cmd)]"
              />
              <UiButton
                @click="saveInvocationCommandDescription(cmd)"
                variant="outline"
                size="sm"
                class="command-save-btn"
              >保存此指令描述</UiButton>
              <p :class="['status', 'command-status', commandStatuses[getCommandIdentifier(cmd)]?.type || '']">
                {{ commandStatuses[getCommandIdentifier(cmd)]?.message || '' }}
              </p>
            </UiField>
          </div>
        </div>

        <div class="form-actions">
          <UiButton variant="outline" @click="addCustomField">添加自定义配置项</UiButton>
          <UiButton type="submit" variant="primary">保存 {{ pluginName }} 配置</UiButton>
        </div>
      </form>
    </div>

    <UiEmptyState v-else title="加载插件配置中…" />
  </section>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import AppSwitch from '@/components/ui/AppSwitch.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiCard from '@/components/ui/UiCard.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiField from '@/components/ui/UiField.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import { usePluginConfigStore, type InvocationCommand } from '@/stores/pluginConfig'

type TextareaValue = string | number | readonly string[] | null

const route = useRoute()
const pluginName = computed(() => route.params.pluginName as string)
const pluginConfigStore = usePluginConfigStore()
const {
  pluginData,
  statusMessage,
  statusType,
  sensitiveFields,
  commandDescriptions,
  commandStatuses,
  hasEnvContent,
  hasConfigSchema,
  schemaEntries,
  customEntries,
  hasSchemaFields,
  hasCommentEntries,
  hasCustomFields,
  invocationCommands
} = storeToRefs(pluginConfigStore)
const isDistributedPlugin = computed(() => Boolean(pluginData.value?.isDistributed))

const {
  isSensitiveKey,
  toggleSensitiveField,
  getCommandIdentifier,
  isKeyInSchema,
  isKeyInEnv,
  hasDefault,
  getSchemaDescription,
  removeCustomField,
  addCustomField
} = pluginConfigStore

async function saveInvocationCommandDescription(cmd: InvocationCommand) {
  await pluginConfigStore.saveInvocationCommandDescription(pluginName.value, cmd)
}

async function togglePlugin() {
  await pluginConfigStore.togglePlugin(pluginName.value)
}

async function savePluginConfig() {
  await pluginConfigStore.savePluginConfig(pluginName.value)
}

function getStatusVariant(status?: string): "secondary" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "success":
      return "success"
    case "error":
      return "danger"
    case "warning":
      return "warning"
    default:
      return "info"
  }
}

function toTextInputValue(value: unknown): string {
  return value == null ? "" : String(value)
}

function toNumberInputValue(value: unknown): number {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : 0
}

watch(
  () => pluginName.value,
  () => {
    pluginConfigStore.loadPluginConfig(pluginName.value)
  },
  { immediate: true }
)
</script>

<style scoped>
.plugin-config-container {
  max-width: 900px;
}

.plugin-controls {
  margin-bottom: var(--space-4);
}

.plugin-controls :deep(.ui-card__content) {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.config-warning {
  display: flex;
  gap: var(--space-4);
  align-items: flex-start;
  padding: var(--space-4);
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-5);
}

.warning-content {
  flex: 1;
}

.warning-title {
  font-weight: 600;
  color: var(--warning-text);
  margin: 0 0 var(--space-2) 0;
}

.warning-text {
  margin: var(--space-1) 0;
  color: var(--warning-text);
}

.schema-fields-section,
.custom-fields-section {
  margin-bottom: var(--space-5);
}

.schema-fields-section,
.custom-fields-section,
.invocation-commands-section {
  display: grid;
  gap: var(--space-3);
}

.config-field {
  min-width: 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.config-field:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.defined-in {
  opacity: 0.85;
}

.invocation-commands-section {
  margin-bottom: var(--space-5);
}

.command-item {
  margin-bottom: var(--space-4);
}

.command-item h4 {
  margin: 6px 0 8px;
}

.command-description-edit {
  width: 100%;
}

.command-save-btn {
  margin-top: 12px;
}

.command-status {
  margin: 8px 0 0;
}

.custom-entry-comment pre {
  color: var(--secondary-text);
  font-family: inherit;
  white-space: pre-wrap;
  margin: 8px 0;
}

.input-with-toggle {
  position: relative;
  display: block;
}

.input-with-toggle :deep(.ui-input) {
  padding-right: 42px;
}

.toggle-visibility-btn {
  position: absolute;
  right: 8px;
  top: 2px;
}

/* 文本掩码样式 (用于 textarea) */
.password-masked {
  -webkit-text-security: disc !important;
  text-security: disc !important;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* .empty-state 已在全局 layout.css 中统一定义 */
</style>

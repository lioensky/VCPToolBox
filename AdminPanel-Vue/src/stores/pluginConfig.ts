import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { pluginApi } from '@/api'
import { useAppStore } from '@/stores/app'
import type { PluginInfo, PluginInvocationCommand } from '@/types/api.plugin'
import { 
  parseEnvToList, 
  serializeEnvAssignment, 
  showMessage,
  castEnvValue,
  isSensitiveConfigKey
} from '@/utils'

export type ConfigValue = string | boolean | number | null

export interface ConfigEntry {
  key: string | null
  value: ConfigValue
  isCommentOrEmpty: boolean
  isMultilineQuoted: boolean
  type: 'string' | 'boolean' | 'integer'
}

export type InvocationCommand = PluginInvocationCommand

export const usePluginConfigStore = defineStore('plugin-config', () => {
  const appStore = useAppStore()
  const pluginData = ref<PluginInfo | null>(null)
  const configEntries = ref<ConfigEntry[]>([])
  const statusMessage = ref('')
  const statusType = ref<'info' | 'success' | 'error'>('info')
  const sensitiveFields = reactive<Record<string, boolean>>({})
  const commandDescriptions = reactive<Record<string, string>>({})
  const commandStatuses = reactive<Record<string, { type: 'info' | 'success' | 'error'; message: string }>>({})

  const envKeys = computed(() => new Set(
    configEntries.value
      .filter((entry) => !entry.isCommentOrEmpty && !!entry.key)
      .map((entry) => entry.key as string)
  ))

  const hasEnvContent = computed(() => configEntries.value.some((entry) => !entry.isCommentOrEmpty))
  const hasConfigSchema = computed(() => {
    const schema = pluginData.value?.manifest.configSchema
    return !!schema && Object.keys(schema).length > 0
  })

  const schemaEntries = computed(() => {
    const schema = pluginData.value?.manifest.configSchema || {}
    const defaults = pluginData.value?.manifest.defaults || {}

    return Object.keys(schema).map((key) => {
      const existing = configEntries.value.find((entry) => !entry.isCommentOrEmpty && entry.key === key)
      const expectedType = normalizeSchemaType(schema[key])
      const fallback = defaults[key] ?? ''
      const rawValue = existing ? String(existing.value ?? '') : fallback

      return {
        key,
        value: castEnvValue(rawValue, expectedType),
        isCommentOrEmpty: false,
        isMultilineQuoted: existing?.isMultilineQuoted ?? String(rawValue).includes('\n'),
        type: expectedType
      } as ConfigEntry
    })
  })

  const customEntries = computed(() => configEntries.value.filter((entry) => {
    if (entry.isCommentOrEmpty) return true
    if (!entry.key) return false
    return !isKeyInSchema(entry.key)
  }))

  const hasSchemaFields = computed(() => schemaEntries.value.length > 0)
  const hasCommentEntries = computed(() => configEntries.value.some((entry) => entry.isCommentOrEmpty))
  const hasCustomFields = computed(() => configEntries.value.some((entry) => !entry.isCommentOrEmpty && !!entry.key && !isKeyInSchema(entry.key)))
  const invocationCommands = computed(() => pluginData.value?.manifest.capabilities?.invocationCommands || [])

  function clearTransientUiState() {
    Object.keys(sensitiveFields).forEach((key) => {
      delete sensitiveFields[key]
    })
    Object.keys(commandDescriptions).forEach((key) => {
      delete commandDescriptions[key]
    })
    Object.keys(commandStatuses).forEach((key) => {
      delete commandStatuses[key]
    })
  }

  function isSensitiveKey(key: string): boolean {
    return isSensitiveConfigKey(key)
  }

  function toggleSensitiveField(key: string) {
    sensitiveFields[key] = !sensitiveFields[key]
  }

  function getCommandIdentifier(cmd: InvocationCommand): string {
    return cmd.commandIdentifier || cmd.command || ''
  }

  function normalizeSchemaType(type: string): ConfigEntry['type'] {
    if (type === 'boolean' || type === 'integer' || type === 'string') {
      return type
    }
    return 'string'
  }

  function inferInputType(key: string | null, value: string): ConfigEntry['type'] {
    // 如果是敏感字段（Token/Key等），强制设为字符串，防止被误判为整数
    if (key && isSensitiveConfigKey(key)) return 'string'

    if (/^(true|false)$/i.test(value)) {
      return 'boolean'
    }
    if (!Number.isNaN(Number.parseFloat(value)) && Number.isFinite(Number.parseFloat(value)) && !value.includes('.')) {
      return 'integer'
    }
    return 'string'
  }

  function serializeConfigEntry(entry: ConfigEntry): string {
    const raw = entry.value
    let value = String(raw ?? '')

    if (entry.type === 'boolean') {
      value = raw ? 'true' : 'false'
    } else if (entry.type === 'integer') {
      const parsed = Number.parseInt(String(raw), 10)
      value = Number.isNaN(parsed) ? '' : String(parsed)
    }

    return serializeEnvAssignment(entry.key!, value)
  }

  function isKeyInSchema(key: string): boolean {
    return !!pluginData.value?.manifest.configSchema?.[key]
  }

  function isKeyInEnv(key: string): boolean {
    return envKeys.value.has(key)
  }

  function hasDefault(key: string): boolean {
    return pluginData.value?.manifest.defaults?.[key] !== undefined
  }

  function getSchemaDescription(key: string): string {
    return pluginData.value?.manifest.configSchemaDescriptions?.[key] || `Schema 定义: ${key}`
  }

  function removeCustomField(key: string) {
    if (!confirm(`确定要删除自定义配置项 "${key}" 吗？更改将在保存后生效。`)) {
      return
    }
    configEntries.value = configEntries.value.filter((entry) => entry.isCommentOrEmpty || entry.key !== key)
  }

  function addCustomField() {
    const key = prompt('请输入新自定义配置项的键名 (例如 MY_PLUGIN_VAR):')
    if (!key || !key.trim()) {
      return
    }

    const normalizedKey = key.trim().replace(/\s+/g, '_')
    const exists = configEntries.value.some((entry) => !entry.isCommentOrEmpty && entry.key === normalizedKey)
    if (exists) {
      showMessage(`配置项 "${normalizedKey}" 已存在！`, 'error')
      return
    }

    configEntries.value.push({
      key: normalizedKey,
      value: '',
      isCommentOrEmpty: false,
      isMultilineQuoted: false,
      type: 'string'
    })

    showMessage(`已添加自定义配置项 "${normalizedKey}"`, 'success')
  }

  async function loadPluginConfig(pluginName: string, options: { forceRefresh?: boolean } = {}) {
    clearTransientUiState()
    pluginData.value = null
    configEntries.value = []

    try {
      const plugins = options.forceRefresh
        ? await appStore.refreshPlugins()
        : await appStore.ensurePluginsLoaded()
      const plugin = plugins.find((item) => item.manifest.name === pluginName || item.name === pluginName)

      if (!plugin) {
        pluginData.value = null
        configEntries.value = []
        return
      }

      pluginData.value = plugin
      const configText = plugin.configEnvContent ?? plugin.configENVContent ?? ''
      const entries = parseEnvToList(configText)

      configEntries.value = entries.map((entry) => {
        const inferredType: ConfigEntry['type'] = entry.isCommentOrEmpty || !entry.key
          ? 'string'
          : inferInputType(entry.key, entry.value)

        return {
          ...entry,
          type: inferredType,
          value: entry.isCommentOrEmpty || !entry.key ? entry.value : castEnvValue(entry.value, inferredType)
        }
      })

      invocationCommands.value.forEach((cmd) => {
        const identifier = getCommandIdentifier(cmd)
        if (!identifier) return
        commandDescriptions[identifier] = cmd.description || ''
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`加载插件配置失败：${errorMessage}`, 'error')
    }
  }

  async function saveInvocationCommandDescription(pluginName: string, cmd: InvocationCommand) {
    const identifier = getCommandIdentifier(cmd)
    if (!identifier) return

    commandStatuses[identifier] = {
      type: 'info',
      message: '正在保存描述...'
    }

    try {
      await pluginApi.saveInvocationCommandDescription(
        pluginName,
        identifier,
        commandDescriptions[identifier] || '',
        {
        loadingKey: 'plugin-config.command-description.save'
        }
      )

      commandStatuses[identifier] = {
        type: 'success',
        message: '描述已保存!'
      }
      showMessage(`指令 "${identifier}" 的描述已成功保存!`, 'success')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      commandStatuses[identifier] = {
        type: 'error',
        message: `保存失败: ${errorMessage}`
      }
      showMessage(`保存指令描述失败：${errorMessage}`, 'error')
    }
  }

  async function togglePlugin(pluginName: string) {
    if (!pluginData.value) {
      showMessage('插件信息尚未加载完成。', 'warning')
      return
    }

    if (pluginData.value.isDistributed) {
      showMessage('分布式插件的启停状态需要在所属节点侧管理。', 'warning')
      return
    }

    const enable = !pluginData.value.enabled
    const action = enable ? '启用' : '禁用'

    if (!confirm(`确定要${action}插件 "${pluginData.value?.manifest.displayName || pluginName}" 吗？`)) {
      return
    }

    try {
      const result = await pluginApi.togglePlugin(pluginName, enable, {
        loadingKey: 'plugin-config.toggle'
      })
      showMessage(result.message || `${action}插件成功`, 'success')
      await loadPluginConfig(pluginName, { forceRefresh: true })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`${action}插件失败：${errorMessage}`, 'error')
    }
  }

  async function savePluginConfig(pluginName: string) {
    const allEntriesMap = new Map<string, ConfigEntry>()

    schemaEntries.value.forEach((entry) => {
      if (entry.key) {
        allEntriesMap.set(entry.key, entry)
      }
    })

    customEntries.value.forEach((entry) => {
      if (!entry.isCommentOrEmpty && entry.key) {
        allEntriesMap.set(entry.key, entry)
      }
    })

    const remainingKeys = new Set(allEntriesMap.keys())
    const finalLines: string[] = []

    configEntries.value.forEach((entry) => {
      if (entry.isCommentOrEmpty || !entry.key) {
        finalLines.push(String(entry.value))
        return
      }

      const currentEntry = allEntriesMap.get(entry.key)
      if (!currentEntry) {
        return
      }

      finalLines.push(serializeConfigEntry(currentEntry))
      remainingKeys.delete(entry.key)
    })

    remainingKeys.forEach((key) => {
      const entry = allEntriesMap.get(key)
      if (!entry) {
        return
      }

      finalLines.push(serializeConfigEntry(entry))
    })

    const configString = finalLines.join('\n')

    try {
      await pluginApi.savePluginConfig(pluginName, configString, {
        loadingKey: 'plugin-config.save'
      })
      statusMessage.value = '插件配置已保存！'
      statusType.value = 'success'
      showMessage('插件配置已保存！', 'success')
      await loadPluginConfig(pluginName, { forceRefresh: true })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      statusMessage.value = `保存失败：${errorMessage}`
      statusType.value = 'error'
      showMessage(`保存失败：${errorMessage}`, 'error')
    }
  }

  return {
    pluginData,
    configEntries,
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
    invocationCommands,
    isSensitiveKey,
    toggleSensitiveField,
    getCommandIdentifier,
    isKeyInSchema,
    isKeyInEnv,
    hasDefault,
    getSchemaDescription,
    removeCustomField,
    addCustomField,
    loadPluginConfig,
    saveInvocationCommandDescription,
    togglePlugin,
    savePluginConfig
  }
})

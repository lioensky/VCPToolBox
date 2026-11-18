'use strict';

class PluginManagerMetaPlugin {
    constructor() {
        this.pluginManager = null;
        this.config = {};
        this.debugMode = false;
    }

    initialize(initialConfig = {}, dependencies = {}) {
        this.config = initialConfig || {};
        this.debugMode = this.config.DebugMode === true || String(this.config.DebugMode || '').toLowerCase() === 'true';
        this.pluginManager = dependencies.pluginManager || null;

        if (!this.pluginManager) {
            try {
                this.pluginManager = require('../../Plugin.js');
            } catch (error) {
                console.error('[PluginManagerMetaPlugin] Failed to fallback-require core PluginManager:', error.message);
            }
        }

        if (!this.pluginManager) {
            console.error('[PluginManagerMetaPlugin] Initialized without core PluginManager. Tool calls will fail.');
            return;
        }

        console.log('[PluginManagerMetaPlugin] Initialized.');
    }

    _normalizeCommand(args = {}) {
        return String(args.command || args.action || args.commandIdentifier || 'ListPlugins').trim();
    }

    _validateAdmin(args = {}, context = {}) {
        const supplied = args.requireAdmin ?? args.adminCode ?? args.authCode;
        const realCode = context.decryptedAuthCode;

        if (!realCode) {
            const error = new Error('无法获取管理员验证码。请确保主服务器配置正确。');
            error.code = 'ADMIN_AUTH_UNAVAILABLE';
            throw error;
        }

        if (String(supplied || '').trim() !== String(realCode).trim()) {
            const error = new Error('管理员验证码错误或缺失。');
            error.code = 'ADMIN_AUTH_FAILED';
            throw error;
        }
    }

    _requirePluginManagerMethod(methodName) {
        if (!this.pluginManager || typeof this.pluginManager[methodName] !== 'function') {
            throw new Error(`Core PluginManager method "${methodName}" is not available.`);
        }
        return this.pluginManager[methodName].bind(this.pluginManager);
    }

    _normalizePluginName(args = {}) {
        const pluginName = String(args.pluginName || args.name || args.toolName || '').trim();
        if (!pluginName) {
            throw new Error('pluginName is required.');
        }
        return pluginName;
    }

    _asTextContent(markdown, meta = {}) {
        return {
            status: 'success',
            content: [
                {
                    type: 'text',
                    text: markdown
                }
            ],
            ...meta
        };
    }

    _escapeTableCell(value) {
        return String(value ?? '')
            .replace(/\|/g, '\\|')
            .replace(/\r?\n/g, '<br>');
    }

    _formatPluginListMarkdown(registry) {
        const plugins = Array.isArray(registry?.plugins) ? registry.plugins : [];
        const lines = [
            '# PluginManager 插件列表',
            '',
            `- 总数: **${registry.total ?? plugins.length}**`,
            `- 已启用: **${registry.enabledCount ?? plugins.filter(p => p.enabled).length}**`,
            `- 已禁用: **${registry.disabledCount ?? plugins.filter(p => !p.enabled).length}**`,
            `- 本地: **${registry.localCount ?? plugins.filter(p => !p.isDistributed).length}**`,
            `- 云端/分布式: **${registry.cloudCount ?? plugins.filter(p => p.isDistributed).length}**`,
            '',
            '| 状态 | 来源 | 类型 | 插件 | 指令数 | 指令 |',
            '|---|---|---|---|---:|---|'
        ];

        for (const plugin of plugins) {
            const state = plugin.enabled ? '✅ 启用' : '⛔ 禁用';
            const origin = plugin.isDistributed ? `☁️ 云端${plugin.serverId ? ` (${plugin.serverId})` : ''}` : '💻 本地';
            const pluginName = `**${plugin.displayName || plugin.name}**\n\`${plugin.name}\``;
            const commands = Array.isArray(plugin.commands) && plugin.commands.length > 0
                ? plugin.commands.map(cmd => `\`${cmd}\``).join(', ')
                : '-';
            lines.push([
                state,
                origin,
                `\`${plugin.pluginType || 'unknown'}\``,
                pluginName,
                plugin.commandCount ?? 0,
                commands
            ].map(cell => this._escapeTableCell(cell)).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }

        lines.push('');
        lines.push('> 启用/禁用操作仅支持本地 `synchronous`、`asynchronous`、`static` 插件；云端工具和常驻服务类插件仅可查询。');
        return lines.join('\n');
    }

    _formatPluginDetailMarkdown(detail) {
        const plugin = detail?.plugin || {};
        const lines = [
            `# 插件详情：${plugin.displayName || plugin.name || 'Unknown'}`,
            '',
            `- 名称: \`${plugin.name || 'N/A'}\``,
            `- 状态: **${plugin.enabled ? '启用' : '禁用'}**`,
            `- 来源: **${plugin.isDistributed ? '云端/分布式' : '本地'}**${plugin.serverId ? ` (${plugin.serverId})` : ''}`,
            `- 类型: \`${plugin.pluginType || 'unknown'}\``,
            `- 版本: \`${plugin.version || 'N/A'}\``,
            `- 作者: ${plugin.author || 'N/A'}`,
            `- 需要管理员权限: **${plugin.requiresAdmin ? '是' : '否'}**`,
            `- 通信协议: \`${plugin.communicationProtocol || plugin.communication?.protocol || 'N/A'}\``,
            `- Manifest: \`${plugin.manifestFile || 'N/A'}\``,
            `- 目录: \`${plugin.folderName || plugin.basePath || 'N/A'}\``,
            `- 占位符: ${plugin.placeholder ? `\`${plugin.placeholder}\`` : '无'}`,
            '',
            '## 描述',
            '',
            plugin.description || '无描述。',
            '',
            '## 注册指令'
        ];

        const commands = Array.isArray(plugin.commands) ? plugin.commands : [];
        if (commands.length === 0) {
            lines.push('');
            lines.push('该插件未注册 invocationCommands。');
        } else {
            for (const cmd of commands) {
                const title = cmd.identifier || cmd.commandIdentifier || cmd.command || cmd.name || 'UnnamedCommand';
                lines.push('');
                lines.push(`### \`${title}\``);
                if (cmd.commandIdentifier) lines.push(`- commandIdentifier: \`${cmd.commandIdentifier}\``);
                if (cmd.command) lines.push(`- command: \`${cmd.command}\``);
                lines.push('');
                lines.push(cmd.description || '无指令描述。');
                if (cmd.example) {
                    lines.push('');
                    lines.push('**示例**');
                    lines.push('');
                    lines.push('```text');
                    lines.push(cmd.example);
                    lines.push('```');
                }
            }
        }

        if (plugin.placeholderDescription) {
            lines.push('');
            lines.push('## 当前占位符注入文本');
            lines.push('');
            lines.push('```text');
            lines.push(plugin.placeholderDescription);
            lines.push('```');
        }

        return lines.join('\n');
    }

    _formatToggleResultMarkdown(result, actionLabel) {
        const plugin = result?.plugin || {};
        const lines = [
            `# ${actionLabel}结果`,
            '',
            `- 状态: **${result?.status || 'success'}**`,
            `- 是否发生变更: **${result?.changed ? '是' : '否'}**`,
            `- 消息: ${result?.message || '操作完成。'}`,
            '',
            '## 插件',
            '',
            `- 名称: \`${plugin.name || 'N/A'}\``,
            `- 显示名: ${plugin.displayName || 'N/A'}`,
            `- 类型: \`${plugin.pluginType || 'unknown'}\``,
            `- 当前状态: **${plugin.enabled ? '启用' : '禁用'}**`,
            `- 来源: **${plugin.isDistributed ? '云端/分布式' : '本地'}**`,
            `- Manifest: \`${plugin.manifestFile || 'N/A'}\``
        ];
        return lines.join('\n');
    }

    _formatReloadMarkdown(preprocessorOrder) {
        const order = Array.isArray(preprocessorOrder) ? preprocessorOrder : [];
        const lines = [
            '# 插件热重载完成',
            '',
            `- 预处理器数量: **${order.length}**`,
            '',
            '## 当前预处理器顺序'
        ];

        if (order.length === 0) {
            lines.push('');
            lines.push('当前没有已注册的消息预处理器。');
        } else {
            lines.push('');
            order.forEach((item, index) => {
                lines.push(`${index + 1}. **${item.displayName || item.name}** (\`${item.name}\`)`);
                if (item.description && item.description !== 'N/A') {
                    lines.push(`   - ${item.description}`);
                }
            });
        }

        return lines.join('\n');
    }

    async processToolCall(args = {}, context = {}) {
        this._validateAdmin(args, context);

        const command = this._normalizeCommand(args);
        if (this.debugMode) {
            console.log(`[PluginManagerMetaPlugin] Processing command: ${command}`);
        }

        switch (command) {
            case 'ListPlugins':
            case 'list':
            case 'listPlugins': {
                const listPluginRegistry = this._requirePluginManagerMethod('listPluginRegistry');
                const registry = await listPluginRegistry();
                return this._asTextContent(this._formatPluginListMarkdown(registry), {
                    summary: {
                        total: registry.total,
                        enabledCount: registry.enabledCount,
                        disabledCount: registry.disabledCount,
                        cloudCount: registry.cloudCount,
                        localCount: registry.localCount
                    }
                });
            }

            case 'GetPluginDetail':
            case 'detail':
            case 'getPluginDetail': {
                const getPluginRegistryDetail = this._requirePluginManagerMethod('getPluginRegistryDetail');
                const detail = await getPluginRegistryDetail(this._normalizePluginName(args));
                return this._asTextContent(this._formatPluginDetailMarkdown(detail), {
                    pluginName: detail?.plugin?.name || this._normalizePluginName(args)
                });
            }

            case 'EnablePlugin':
            case 'enable':
            case 'enablePlugin': {
                const enableLocalPlugin = this._requirePluginManagerMethod('enableLocalPlugin');
                const result = await enableLocalPlugin(this._normalizePluginName(args));
                return this._asTextContent(this._formatToggleResultMarkdown(result, '启用插件'), {
                    pluginName: result?.plugin?.name || this._normalizePluginName(args),
                    changed: !!result?.changed
                });
            }

            case 'DisablePlugin':
            case 'disable':
            case 'disablePlugin': {
                const disableLocalPlugin = this._requirePluginManagerMethod('disableLocalPlugin');
                const result = await disableLocalPlugin(this._normalizePluginName(args));
                return this._asTextContent(this._formatToggleResultMarkdown(result, '禁用插件'), {
                    pluginName: result?.plugin?.name || this._normalizePluginName(args),
                    changed: !!result?.changed
                });
            }

            case 'ReloadPlugins':
            case 'reload':
            case 'reloadPlugins': {
                const hotReloadPluginsAndOrder = this._requirePluginManagerMethod('hotReloadPluginsAndOrder');
                const preprocessorOrder = await hotReloadPluginsAndOrder();
                return this._asTextContent(this._formatReloadMarkdown(preprocessorOrder), {
                    preprocessorCount: Array.isArray(preprocessorOrder) ? preprocessorOrder.length : 0
                });
            }

            default:
                throw new Error(`Unknown PluginManager command: ${command}`);
        }
    }

    shutdown() {
        if (this.debugMode) {
            console.log('[PluginManagerMetaPlugin] Shutdown.');
        }
    }
}

module.exports = new PluginManagerMetaPlugin();
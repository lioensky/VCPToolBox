(function (global) {
    'use strict';

    const ADAPTER_PRESETS = {
        dingtalk: {
            channel: 'dingtalk',
            name: '钉钉适配器',
            config: {
                appKey: 'replace-with-ding-app-key',
                appSecret: 'replace-with-ding-app-secret',
                bridgeUrl: 'http://127.0.0.1:6010/internal/channel-ingest',
                bridgeKey: '',
                useBridge: true,
                sdkPackage: 'dingtalk-stream',
                defaultAgentId: 'Nova',
                defaultAgentDisplayName: 'Nova',
                baseUrl: 'http://127.0.0.1:6005',
                chatPath: '/v1/chat/completions',
                apiKey: '',
                model: 'Nova',
                timeoutMs: 120000,
                debugRawEvent: false,
                debugRawResponse: false,
                debugRichReply: false
            }
        },
        qq: {
            channel: 'qq',
            name: 'QQ OneBot 适配器',
            config: {
                onebotWsUrl: 'ws://127.0.0.1:3001',
                onebotAccessToken: '',
                channelHubUrl: 'http://127.0.0.1:6010/internal/channel-hub/events',
                bridgeKey: '',
                agentName: 'Nova',
                agentDisplayName: 'Nova',
                supportsImage: true,
                supportsFile: false,
                supportsAudio: true,
                maxMessageLength: 4500,
                timeoutMs: 120000,
                retryCount: 3,
                retryIntervalMs: 1000,
                sessionTimeoutHours: 24
            }
        }
    };

    const BINDING_PRESETS = {
        dingtalk: {
            name: '钉钉绑定',
            preferredAdapterIds: ['dingtalk-adapter', 'ding-main', 'dingtalk-main'],
            adapterKeyword: 'ding',
            externalSessionKey: 'dingtalk:group:cidxxxxxxxx:staffxxxxxxxx',
            conversationId: 'topic-dingtalk-group-cidxxxxxxxx',
            agentId: 'Nova'
        },
        qq: {
            name: 'QQ 绑定',
            preferredAdapterIds: ['onebot-qq-main', 'qq-main', 'onebot-main'],
            adapterKeyword: 'qq',
            externalSessionKey: 'qq:group:123456789:987654321',
            conversationId: 'topic-qq-group-123456789',
            agentId: 'Nova'
        }
    };

    const ADAPTER_CONFIG_SCHEMAS = {
        dingtalk: [
            { key: 'appKey', label: 'App Key', type: 'text', required: true, example: 'dingxxxxxxxxxxxxxxxx', help: '从钉钉应用后台获取，对应 vcp-dingtalk-adapter/.env 里的 DING_APP_KEY。' },
            { key: 'appSecret', label: 'App Secret', type: 'text', required: true, example: 'your-ding-app-secret', help: '从钉钉应用后台获取，对应 vcp-dingtalk-adapter/.env 里的 DING_APP_SECRET。' },
            { key: 'bridgeUrl', label: 'Bridge URL', type: 'text', example: 'http://127.0.0.1:6010/internal/channel-ingest', help: '填你这台 VCPToolBox 的桥接入口，当前钉钉适配器默认走 /internal/channel-ingest。' },
            { key: 'bridgeKey', label: 'Bridge Key', type: 'text', example: 'your-channel-bridge-key', help: '填 VCPToolBox config.env 里的 VCP_CHANNEL_BRIDGE_KEY；如果服务端没配可先留空。' },
            { key: 'useBridge', label: '启用 Bridge', type: 'checkbox', help: '当前钉钉链路建议保持开启，表示通过旧桥接入口把消息转进 VCPToolBox。' },
            { key: 'sdkPackage', label: 'Stream SDK 包名', type: 'text', example: 'dingtalk-stream', help: '一般保持 dingtalk-stream，只有你明确切换到其他 Stream SDK 包才需要修改。' },
            { key: 'defaultAgentId', label: '默认 Agent ID', type: 'text', example: 'Nova', help: '填系统里真实存在的 Agent 名称或 ID，不要只填展示名。' },
            { key: 'defaultAgentDisplayName', label: '默认 Agent 显示名', type: 'text', example: 'Nova', help: '这是页面展示名，可与 Agent ID 相同，也可写成更友好的中文名。' },
            { key: 'baseUrl', label: 'VCP Base URL', type: 'text', example: 'http://127.0.0.1:6005', help: '仅在桥接内部回退到旧聊天接口时使用，通常填本机 VCP 服务地址。' },
            { key: 'chatPath', label: 'Chat Path', type: 'text', example: '/v1/chat/completions', help: 'VCP 聊天接口路径，通常保持默认值即可。' },
            { key: 'apiKey', label: 'VCP API Key', type: 'text', example: 'sk-xxxxxxxxxxxxxxxx', help: '只有在走旧聊天接口回退时才需要，通常填 VCP 服务要求的 API Key。' },
            { key: 'model', label: '模型 / Agent', type: 'text', example: 'Nova', help: '旧聊天接口回退时使用的默认模型或 Agent 名称。' },
            { key: 'timeoutMs', label: '超时毫秒', type: 'number', example: '120000', help: '适配器等待 VCP 返回结果的超时时间，单位毫秒。' },
            { key: 'debugRawEvent', label: '调试原始事件', type: 'checkbox', help: '开启后会打印钉钉 Stream 原始事件，排查接入问题时有用。' },
            { key: 'debugRawResponse', label: '调试原始响应', type: 'checkbox', help: '开启后会打印 VCP 原始响应，内容可能较长。' },
            { key: 'debugRichReply', label: '调试富回复', type: 'checkbox', help: '开启后会打印 richReply 解析结果，适合排查图片/文件/卡片回复。' }
        ],
        qq: [
            { key: 'onebotWsUrl', label: 'OneBot WS URL', type: 'text', required: true, example: 'ws://127.0.0.1:3001', help: '从 go-cqhttp / NapCat / LLOneBot 的 WebSocket 配置里获取，填它对外监听的 ws 地址。' },
            { key: 'onebotAccessToken', label: 'OneBot Access Token', type: 'text', example: 'your-onebot-access-token', help: '如果 OneBot 配了 access_token，这里填同一个值；没配就留空。' },
            { key: 'channelHubUrl', label: 'ChannelHub URL', type: 'text', required: true, example: 'http://127.0.0.1:6010/internal/channel-hub/events', help: '填你这台 VCPToolBox 的正式 B2 入口，QQ 当前建议走 /internal/channel-hub/events。' },
            { key: 'bridgeKey', label: 'Bridge Key', type: 'text', example: 'your-channel-bridge-key', help: '填 VCPToolBox config.env 里的 VCP_CHANNEL_BRIDGE_KEY；服务端没配可先留空。' },
            { key: 'agentName', label: '默认 Agent 名称', type: 'text', example: 'Nova', help: '填系统里真实存在的 Agent 名称或 ID。' },
            { key: 'agentDisplayName', label: '默认 Agent 显示名', type: 'text', example: 'Nova', help: '仅用于展示，可与默认 Agent 名称相同。' },
            { key: 'supportsImage', label: '支持图片', type: 'checkbox', help: '按你的 OneBot 实现是否支持图片发送来勾选。大多数实现支持。' },
            { key: 'supportsFile', label: '支持文件', type: 'checkbox', help: 'QQ 文件直发兼容性较差，当前项目默认建议关闭。' },
            { key: 'supportsAudio', label: '支持语音', type: 'checkbox', help: '按你的 OneBot 实现是否支持语音发送来勾选。' },
            { key: 'maxMessageLength', label: '最大消息长度', type: 'number', example: '4500', help: 'QQ 单条消息长度上限，超长会被截断，通常填 4500。' },
            { key: 'timeoutMs', label: '超时毫秒', type: 'number', example: '120000', help: '适配器等待 ChannelHub 返回结果的超时时间，单位毫秒。' },
            { key: 'retryCount', label: '重试次数', type: 'number', example: '3', help: '发送失败时的重试次数。' },
            { key: 'retryIntervalMs', label: '重试间隔毫秒', type: 'number', example: '1000', help: '每次重试之间的间隔，单位毫秒。' },
            { key: 'sessionTimeoutHours', label: '会话超时小时', type: 'number', example: '24', help: '适配器本地会话超时窗口，单位小时。' }
        ]
    };

    const ChannelHubPage = {
        currentSection: 'dashboard',

        init() {
            this.bindNavigation();
            this.bindActions();
            this.showSection('dashboard');
        },

        bindNavigation() {
            document.querySelectorAll('.nav-link[data-section]').forEach((link) => {
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    this.showSection(link.dataset.section);
                });
            });
        },

        bindActions() {
            this.bindClick('save-adapter', () => this.saveAdapter());
            this.bindClick('save-binding', () => this.saveBinding());
            this.bindClick('refresh-outbox', () => this.loadOutbox());
            this.bindClick('refresh-audit', () => this.loadAudit());
            this.bindClick('apply-dingtalk-preset', () => this.applyAdapterPreset('dingtalk'));
            this.bindClick('apply-qq-preset', () => this.applyAdapterPreset('qq'));
            this.bindClick('apply-dingtalk-binding-preset', () => this.applyBindingPreset('dingtalk'));
            this.bindClick('apply-qq-binding-preset', () => this.applyBindingPreset('qq'));

            const addAdapterTrigger = document.querySelector('[data-bs-target="#adapter-modal"]');
            if (addAdapterTrigger) {
                addAdapterTrigger.addEventListener('click', () => this.resetAdapterForm());
            }

            const adapterModal = document.getElementById('adapter-modal');
            if (adapterModal) {
                adapterModal.addEventListener('hidden.bs.modal', () => this.resetAdapterForm());
            }

            const addBindingTrigger = document.querySelector('[data-bs-target="#binding-modal"]');
            if (addBindingTrigger) {
                addBindingTrigger.addEventListener('click', () => this.resetBindingForm());
            }

            const bindingModal = document.getElementById('binding-modal');
            if (bindingModal) {
                bindingModal.addEventListener('hidden.bs.modal', () => this.resetBindingForm());
            }

            const auditFilterForm = document.getElementById('audit-filter-form');
            if (auditFilterForm) {
                auditFilterForm.addEventListener('submit', (event) => {
                    event.preventDefault();
                    this.loadAudit(this.collectAuditFilters());
                });
            }

            const adapterForm = document.getElementById('adapter-form');
            const adapterChannelField = adapterForm?.elements?.channel;
            if (adapterChannelField) {
                adapterChannelField.addEventListener('change', () => {
                    this.renderAdapterConfigFields(adapterChannelField.value, {});
                });
            }
        },

        bindClick(id, handler) {
            const node = document.getElementById(id);
            if (node) {
                node.addEventListener('click', handler);
            }
        },

        async showSection(section) {
            this.currentSection = section;

            document.querySelectorAll('.nav-link[data-section]').forEach((link) => {
                link.classList.toggle('active', link.dataset.section === section);
            });

            document.querySelectorAll('.section').forEach((node) => {
                node.classList.toggle('active', node.id === section);
            });

            if (section === 'dashboard') await this.loadDashboard();
            if (section === 'adapters') await this.loadAdapters();
            if (section === 'bindings') await this.loadBindings();
            if (section === 'outbox') await this.loadOutbox();
            if (section === 'dead-letter') {
                if (window.DeadLetterUI) DeadLetterUI.init();
            }
            if (section === 'media') {
                if (window.MediaGatewayUI) MediaGatewayUI.init();
            }
            if (section === 'metrics') await this.loadMetrics();
            if (section === 'audit') await this.loadAudit();
        },

        async loadDashboard() {
            try {
                const [adaptersResp, bindingsResp, metricsResp, outboxStatsResp] = await Promise.all([
                    global.ChannelHubAPI.getAdapters(),
                    global.ChannelHubAPI.getBindings(),
                    global.ChannelHubAPI.getMetrics(),
                    global.ChannelHubAPI.getOutboxStats().catch(() => ({ data: {} }))
                ]);

                const adapters = adaptersResp.data || [];
                const bindings = bindingsResp.data || [];
                const metrics = metricsResp.data || {};
                const outboxStats = outboxStatsResp.data || {};

                this.setText('metric-adapters', adapters.filter((adapter) => adapter.status === 'active').length || adapters.length);
                this.setText('metric-bindings', bindings.length);
                this.setText('metric-events', metrics.totalEvents || 0);
                this.setText('metric-messages', outboxStats.total || 0);

                const tbody = document.getElementById('dashboard-adapters-table');
                if (!tbody) return;

                tbody.innerHTML = adapters.length
                    ? adapters.map((adapter) => `
                        <tr>
                            <td>${this.escape(adapter.adapterId)}</td>
                            <td>${this.escape(adapter.channel || '-')}</td>
                            <td>${this.renderStatus(adapter.status)}</td>
                            <td>${adapter.updatedAt ? global.ChannelHubAPI.formatDate(adapter.updatedAt) : '-'}</td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="4" class="text-center text-muted">暂无数据</td></tr>';
            } catch (error) {
                console.error('Failed to load dashboard:', error);
                this.toast(`加载仪表盘失败: ${error.message}`, 'danger');
            }
        },

        async loadAdapters() {
            try {
                const response = await global.ChannelHubAPI.getAdapters();
                const adapters = response.data || [];
                const tbody = document.getElementById('adapters-table');

                if (!tbody) return;

                tbody.innerHTML = adapters.length
                    ? adapters.map((adapter) => `
                        <tr>
                            <td>${this.escape(adapter.adapterId)}</td>
                            <td>${this.escape(adapter.channel || '-')}</td>
                            <td>${this.escape(adapter.name || '-')}</td>
                            <td>${this.renderStatus(adapter.status)}</td>
                            <td><code>${this.escape(adapter.config?.webhookUrl || '-')}</code></td>
                            <td>
                                <button type="button" class="btn btn-sm btn-outline-primary" data-edit-adapter="${this.escape(adapter.adapterId)}">编辑</button>
                                <button type="button" class="btn btn-sm btn-outline-danger" data-delete-adapter="${this.escape(adapter.adapterId)}">删除</button>
                            </td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="6" class="text-center text-muted">暂无适配器</td></tr>';

                tbody.querySelectorAll('[data-edit-adapter]').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const adapterId = button.dataset.editAdapter;
                        try {
                            const adapter = adapters.find((item) => item.adapterId === adapterId)
                                || (await global.ChannelHubAPI.adapters.get(adapterId)).data;
                            this.openAdapterEditor(adapter);
                        } catch (error) {
                            console.error('Failed to load adapter for edit:', error);
                            this.toast(`加载适配器失败: ${error.message}`, 'danger');
                        }
                    });
                });

                tbody.querySelectorAll('[data-delete-adapter]').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const adapterId = button.dataset.deleteAdapter;
                        if (!global.confirm(`确定删除适配器 "${adapterId}" 吗？`)) {
                            return;
                        }

                        try {
                            await global.ChannelHubAPI.adapters.delete(adapterId);
                            this.toast('适配器已删除', 'success');
                            await this.loadAdapters();
                            await this.loadDashboard();
                        } catch (error) {
                            console.error('Failed to delete adapter:', error);
                            this.toast(`删除澶辫触: ${error.message}`, 'danger');
                        }
                    });
                });
            } catch (error) {
                console.error('Failed to load adapters:', error);
                this.toast(`加载适配器失败: ${error.message}`, 'danger');
            }
        },

        async saveAdapter() {
            const form = document.getElementById('adapter-form');
            if (!form) return;

            const formData = new FormData(form);
            const editingAdapterId = form.dataset.editingAdapterId || '';
            let parsedConfig = {};

            try {
                parsedConfig = this.collectAdapterConfig(form, formData);
            } catch (error) {
                this.toast(`配置 JSON 无效: ${error.message}`, 'danger');
                return;
            }

            const payload = {
                adapterId: String(formData.get('adapterId') || '').trim(),
                channel: String(formData.get('channel') || '').trim(),
                name: String(formData.get('name') || '').trim(),
                config: parsedConfig
            };

            if (!payload.adapterId || !payload.channel || !payload.name) {
                this.toast('请完整填写适配器 ID、渠道类型和名称', 'danger');
                return;
            }

            try {
                if (editingAdapterId) {
                    await global.ChannelHubAPI.adapters.update(editingAdapterId, payload);
                    this.toast('适配器已更新', 'success');
                } else {
                    await global.ChannelHubAPI.adapters.create(payload);
                    this.toast('适配器已创建', 'success');
                }
                this.hideModal('adapter-modal');
                this.resetAdapterForm();
                await this.loadAdapters();
                await this.loadDashboard();
            } catch (error) {
                console.error('Failed to save adapter:', error);
                this.toast(`保存失败: ${error.message}`, 'danger');
            }
        },

        openAdapterEditor(adapter) {
            const form = document.getElementById('adapter-form');
            const modalEl = document.getElementById('adapter-modal');
            const titleEl = document.getElementById('adapter-modal-title');
            if (!form || !modalEl || !adapter) return;

            form.dataset.editingAdapterId = adapter.adapterId || '';

            const adapterIdInput = form.querySelector('[name="adapterId"]');
            const channelInput = form.querySelector('[name="channel"]');
            const nameInput = form.querySelector('[name="name"]');
            const configInput = form.querySelector('[name="config"]');

            if (adapterIdInput) {
                adapterIdInput.value = adapter.adapterId || '';
                adapterIdInput.readOnly = true;
            }
            if (channelInput) {
                channelInput.value = adapter.channel || '';
            }
            if (nameInput) {
                nameInput.value = adapter.name || '';
            }
            if (configInput) {
                configInput.value = JSON.stringify(adapter.config || {}, null, 2);
            }
            this.renderAdapterConfigFields(adapter.channel || '', adapter.config || {});
            if (titleEl) {
                titleEl.textContent = '编辑适配器';
            }

            const modal = global.bootstrap?.Modal?.getOrCreateInstance(modalEl);
            modal?.show();
        },

        resetAdapterForm() {
            const form = document.getElementById('adapter-form');
            const titleEl = document.getElementById('adapter-modal-title');
            if (!form) return;

            form.reset();
            delete form.dataset.editingAdapterId;

            const adapterIdInput = form.querySelector('[name="adapterId"]');
            if (adapterIdInput) {
                adapterIdInput.readOnly = false;
            }
            if (titleEl) {
                titleEl.textContent = '添加适配器';
            }
            this.renderAdapterConfigFields('', {});
        },

        applyAdapterPreset(type) {
            const preset = ADAPTER_PRESETS[type];
            const form = document.getElementById('adapter-form');
            if (!preset || !form) return;

            const channelField = form.elements.channel;
            const nameField = form.elements.name;
            const configField = form.elements.config;

            if (configField && String(configField.value || '').trim()) {
                const confirmed = global.confirm('当前配置框里已经有内容，是否用预设模板覆盖？');
                if (!confirmed) {
                    return;
                }
            }

            if (channelField) {
                channelField.value = preset.channel;
            }

            if (nameField && !String(nameField.value || '').trim()) {
                nameField.value = preset.name;
            }

            if (configField) {
                configField.value = JSON.stringify(preset.config, null, 2);
            }
            this.renderAdapterConfigFields(preset.channel, preset.config);

            this.toast(`已填入${preset.name}模板`, 'success');
        },

        collectAdapterConfig(form, formData) {
            const channel = String(formData.get('channel') || '').trim();
            const schema = ADAPTER_CONFIG_SCHEMAS[channel];
            const configInput = form.querySelector('[name="config"]');

            if (!schema) {
                const rawConfig = String(formData.get('config') || '').trim();
                return rawConfig ? JSON.parse(rawConfig) : {};
            }

            const extraConfig = this.parseConfigJson(String(configInput?.value || '').trim());
            const result = { ...extraConfig };

            schema.forEach((field) => {
                const input = form.querySelector(`[data-config-key="${field.key}"]`);
                if (!input) {
                    return;
                }

                let value;
                if (field.type === 'checkbox') {
                    value = Boolean(input.checked);
                } else if (field.type === 'number') {
                    const rawValue = String(input.value || '').trim();
                    value = rawValue === '' ? null : Number(rawValue);
                } else {
                    value = String(input.value || '').trim();
                }

                if (field.required && (value === '' || value === null)) {
                    throw new Error(`${field.label} 不能为空`);
                }

                if (value === '' || value === null) {
                    delete result[field.key];
                } else {
                    result[field.key] = value;
                }
            });

            if (configInput) {
                configInput.value = JSON.stringify(result, null, 2);
            }

            return result;
        },

        renderAdapterConfigFields(channel, config = {}) {
            const schema = ADAPTER_CONFIG_SCHEMAS[String(channel || '').trim()];
            const fieldsContainer = document.getElementById('adapter-config-fields');
            const rawWrapper = document.getElementById('adapter-config-raw-wrapper');
            const form = document.getElementById('adapter-form');
            const configInput = form?.querySelector('[name="config"]');

            if (!fieldsContainer || !rawWrapper) {
                return;
            }

            if (!schema) {
                fieldsContainer.innerHTML = '';
                fieldsContainer.style.display = 'none';
                rawWrapper.style.display = '';
                return;
            }

            fieldsContainer.style.display = '';
            rawWrapper.style.display = 'none';

            fieldsContainer.innerHTML = `
                <div class="row g-2">
                    ${schema.map((field) => this.renderAdapterConfigField(field, config[field.key])).join('')}
                </div>
            `;

            if (configInput) {
                configInput.value = JSON.stringify(config || {}, null, 2);
            }
        },

        renderAdapterConfigField(field, value) {
            if (field.type === 'checkbox') {
                return `
                    <div class="col-md-6">
                        <div class="border rounded px-3 py-2 h-100">
                            <div class="form-check form-switch d-flex align-items-center mb-1">
                                <input class="form-check-input me-2" type="checkbox" data-config-key="${this.escape(field.key)}" ${value ? 'checked' : ''}>
                                <label class="form-check-label">${this.escape(field.label)}</label>
                            </div>
                            ${field.help ? `<div class="form-text">${this.escape(field.help)}</div>` : ''}
                        </div>
                    </div>
                `;
            }

            const inputType = field.type === 'number' ? 'number' : 'text';
            const displayValue = value === undefined || value === null ? '' : String(value);
            const placeholder = field.example ? `示例：${field.example}` : '';
            return `
                <div class="col-md-6">
                    <label class="form-label">${this.escape(field.label)}</label>
                    <input
                        type="${inputType}"
                        class="form-control"
                        data-config-key="${this.escape(field.key)}"
                        value="${this.escape(displayValue)}"
                        placeholder="${this.escape(placeholder)}"
                        ${field.required ? 'required' : ''}
                    >
                    ${(field.help || field.example) ? `<div class="form-text">${field.help ? this.escape(field.help) : ''}${field.help && field.example ? '<br>' : ''}${field.example ? `示例：${this.escape(field.example)}` : ''}</div>` : ''}
                </div>
            `;
        },

        parseConfigJson(rawConfig) {
            if (!rawConfig) {
                return {};
            }
            return JSON.parse(rawConfig);
        },

        applyBindingPreset(type) {
            const preset = BINDING_PRESETS[type];
            const form = document.getElementById('binding-form');
            if (!preset || !form) return;

            if (form.dataset.editingBindingKey) {
                this.toast('当前是编辑模式，请关闭弹窗后再使用模板创建新绑定', 'warning');
                return;
            }

            const adapterField = form.elements.adapterId;
            const externalSessionKeyField = form.elements.externalSessionKey;
            const conversationIdField = form.elements.vcpSessionId;
            const agentIdField = form.elements.agentId;

            const hasExistingValue = [
                externalSessionKeyField?.value,
                conversationIdField?.value,
                agentIdField?.value
            ].some((value) => String(value || '').trim());

            if (hasExistingValue) {
                const confirmed = global.confirm('当前绑定表单里已经有内容，是否用预设模板覆盖？');
                if (!confirmed) {
                    return;
                }
            }

            const selectedAdapterId = this.selectBindingAdapter(adapterField, preset);
            if (externalSessionKeyField) {
                externalSessionKeyField.value = preset.externalSessionKey;
            }
            if (conversationIdField) {
                conversationIdField.value = preset.conversationId;
            }
            if (agentIdField) {
                agentIdField.value = preset.agentId;
            }

            if (selectedAdapterId) {
                this.toast(`已填入${preset.name}模板，并选中适配器 ${selectedAdapterId}`, 'success');
            } else {
                this.toast(`已填入${preset.name}模板，请手动选择适配器 ID`, 'success');
            }
        },

        selectBindingAdapter(adapterField, preset) {
            if (!adapterField || !adapterField.options) {
                return '';
            }

            const options = Array.from(adapterField.options)
                .map((option) => String(option.value || '').trim())
                .filter(Boolean);

            const exactMatch = preset.preferredAdapterIds.find((candidate) => options.includes(candidate));
            if (exactMatch) {
                adapterField.value = exactMatch;
                return exactMatch;
            }

            const fuzzyMatch = options.find((value) => value.toLowerCase().includes(String(preset.adapterKeyword || '').toLowerCase()));
            if (fuzzyMatch) {
                adapterField.value = fuzzyMatch;
                return fuzzyMatch;
            }

            return '';
        },

        async loadBindings() {
            try {
                const [bindingsResp, adaptersResp] = await Promise.all([
                    global.ChannelHubAPI.getBindings(),
                    global.ChannelHubAPI.getAdapters()
                ]);

                const bindings = bindingsResp.data || [];
                const adapters = adaptersResp.data || [];
                const tbody = document.getElementById('bindings-table');
                const bindingAdapterSelect = document.querySelector('#binding-form select[name="adapterId"]');
                const auditAdapterSelect = document.querySelector('#audit-filter-form select[name="adapterId"]');

                if (tbody) {
                    tbody.innerHTML = bindings.length
                        ? bindings.map((binding) => `
                            <tr>
                                <td><code>${this.escape(binding.bindingKey || '-')}</code></td>
                                <td>${this.escape(binding.adapterId || '-')}</td>
                                <td>${this.escape(binding.externalSessionKey || '-')}</td>
                                <td>${this.escape(binding.conversationId || '-')}</td>
                                <td>${this.escape(binding.agentId || '-')}</td>
                                <td>${binding.createdAt ? global.ChannelHubAPI.formatDate(binding.createdAt) : '-'}</td>
                                <td>
                                    <button type="button" class="btn btn-sm btn-outline-primary" data-edit-binding="${this.escape(binding.bindingKey)}">编辑</button>
                                    <button type="button" class="btn btn-sm btn-outline-danger" data-delete-binding="${this.escape(binding.bindingKey)}">删除</button>
                                </td>
                            </tr>
                        `).join('')
                        : '<tr><td colspan="7" class="text-center text-muted">暂无绑定</td></tr>';

                    tbody.querySelectorAll('[data-edit-binding]').forEach((button) => {
                        button.addEventListener('click', async () => {
                            const bindingKey = button.dataset.editBinding;
                            if (!bindingKey) return;

                            const binding = bindings.find((item) => item.bindingKey === bindingKey);
                            if (!binding) {
                                this.toast(`未找到绑定：${bindingKey}`, 'warning');
                                return;
                            }

                            this.openBindingEditor(binding);
                        });
                    });

                    tbody.querySelectorAll('[data-delete-binding]').forEach((button) => {
                        button.addEventListener('click', async () => {
                            const bindingKey = button.dataset.deleteBinding;
                            if (!global.confirm(`确定删除绑定 "${bindingKey}" 吗？`)) {
                                return;
                            }

                            try {
                                await global.ChannelHubAPI.deleteBinding(bindingKey);
                                this.toast('绑定已删除', 'success');
                                await this.loadBindings();
                                await this.loadDashboard();
                            } catch (error) {
                                console.error('Failed to delete binding:', error);
                                this.toast(`删除澶辫触: ${error.message}`, 'danger');
                            }
                        });
                    });
                }

                const bindingOptions = `
                    <option value="">请选择...</option>
                    ${adapters.map((adapter) => `<option value="${this.escape(adapter.adapterId)}">${this.escape(adapter.name || adapter.adapterId)}</option>`).join('')}
                `;

                if (bindingAdapterSelect) {
                    bindingAdapterSelect.innerHTML = bindingOptions;
                }

                if (auditAdapterSelect) {
                    const currentValue = auditAdapterSelect.value;
                    auditAdapterSelect.innerHTML = `
                        <option value="">全部</option>
                        ${adapters.map((adapter) => `<option value="${this.escape(adapter.adapterId)}">${this.escape(adapter.name || adapter.adapterId)}</option>`).join('')}
                    `;
                    auditAdapterSelect.value = currentValue;
                }
            } catch (error) {
                console.error('Failed to load bindings:', error);
                this.toast(`加载绑定失败: ${error.message}`, 'danger');
            }
        },

        async saveBinding() {
            const form = document.getElementById('binding-form');
            if (!form) return;

            const adapterField = form.elements.adapterId;
            const externalSessionKeyField = form.elements.externalSessionKey;
            const conversationIdField = form.elements.vcpSessionId;
            const agentIdField = form.elements.agentId;
            const editingBindingKey = form.dataset.editingBindingKey || '';
            const payload = {
                adapterId: String(adapterField?.value || '').trim(),
                externalSessionKey: String(externalSessionKeyField?.value || '').trim(),
                conversationId: String(conversationIdField?.value || '').trim(),
                agentId: String(agentIdField?.value || '').trim()
            };

            if (!payload.adapterId || !payload.externalSessionKey || !payload.agentId) {
                this.toast('请完整填写适配器、外部会话 Key 和 Agent ID', 'danger');
                return;
            }

            payload.bindingKey = editingBindingKey || `${payload.adapterId}:${payload.externalSessionKey}`;

            try {
                if (editingBindingKey) {
                    await global.ChannelHubAPI.updateBinding(editingBindingKey, payload);
                    this.toast('绑定已更新', 'success');
                } else {
                    await global.ChannelHubAPI.createBinding(payload);
                    this.toast('绑定已创建', 'success');
                }
                this.hideModal('binding-modal');
                this.resetBindingForm();
                await this.loadBindings();
                await this.loadDashboard();
            } catch (error) {
                console.error('Failed to save binding:', error);
                this.toast(`保存失败: ${error.message}`, 'danger');
            }
        },

        openBindingEditor(binding) {
            const form = document.getElementById('binding-form');
            if (!form || !binding) return;

            const adapterField = form.elements.adapterId;
            const externalSessionKeyField = form.elements.externalSessionKey;
            const conversationIdField = form.elements.vcpSessionId;
            const agentIdField = form.elements.agentId;
            const title = document.getElementById('binding-modal-title');

            form.dataset.editingBindingKey = binding.bindingKey || '';

            if (adapterField) {
                adapterField.value = binding.adapterId || '';
                adapterField.disabled = true;
            }

            if (externalSessionKeyField) {
                externalSessionKeyField.value = binding.externalSessionKey || '';
            }

            if (conversationIdField) {
                conversationIdField.value = binding.conversationId || binding.vcpSessionId || '';
            }

            if (agentIdField) {
                agentIdField.value = binding.agentId || '';
            }

            if (title) {
                title.textContent = '编辑会话绑定';
            }

            this.showModal('binding-modal');
        },

        resetBindingForm() {
            const form = document.getElementById('binding-form');
            if (!form) return;

            const adapterField = form.elements.adapterId;
            const externalSessionKeyField = form.elements.externalSessionKey;
            const title = document.getElementById('binding-modal-title');

            form.reset();
            delete form.dataset.editingBindingKey;

            if (adapterField) {
                adapterField.disabled = false;
            }

            if (externalSessionKeyField) {
                externalSessionKeyField.readOnly = false;
            }

            if (title) {
                title.textContent = '创建会话绑定';
            }
        },

        async loadOutbox() {
            try {
                const response = await global.ChannelHubAPI.getOutboxMessages({ limit: 100 });
                const messages = response.data?.messages || [];
                const tbody = document.getElementById('outbox-table');

                if (!tbody) return;

                tbody.innerHTML = messages.length
                    ? messages.map((message) => `
                        <tr>
                            <td>${this.escape(message.jobId || '-')}</td>
                            <td>${this.escape(message.adapterId || '-')}</td>
                            <td>${this.escape(message.channel || '-')}</td>
                            <td>${this.escape(message.payload?.requestId || message.payload?.replyId || '-')}</td>
                            <td>${this.renderStatus(message.status)}</td>
                            <td>${message.attempts || 0}</td>
                            <td>${message.createdAt ? global.ChannelHubAPI.formatDate(message.createdAt) : '-'}</td>
                            <td>
                                <button type="button" class="btn btn-sm btn-outline-primary" data-retry-outbox="${this.escape(message.jobId || '')}">重试</button>
                            </td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="8" class="text-center text-muted">暂无消息</td></tr>';

                tbody.querySelectorAll('[data-retry-outbox]').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const jobId = button.dataset.retryOutbox;
                        if (!jobId) return;

                        try {
                            await global.ChannelHubAPI.retryOutboxMessage(jobId);
                            this.toast('出站任务已加入重试队列', 'success');
                            await this.loadOutbox();
                        } catch (error) {
                            console.error('Failed to retry outbox job:', error);
                            this.toast(`重试澶辫触: ${error.message}`, 'danger');
                        }
                    });
                });
            } catch (error) {
                console.error('Failed to load outbox:', error);
                this.toast(`加载发件箱失败: ${error.message}`, 'danger');
            }
        },

        async loadMetrics() {
            try {
                const response = await global.ChannelHubAPI.getMetrics();
                const metrics = response.data || {};
                const tbody = document.getElementById('channel-metrics-table');
                const rows = metrics.byChannel || [];

                if (!tbody) return;

                tbody.innerHTML = rows.length
                    ? rows.map((row) => `
                        <tr>
                            <td>${this.escape(row.channel || '-')}</td>
                            <td>${row.eventCount || 0}</td>
                            <td>${row.eventCount || 0}</td>
                            <td>${((row.successRate || 0) * 100).toFixed(1)}%</td>
                            <td>${row.avgLatency || 0}ms</td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="5" class="text-center text-muted">暂无指标</td></tr>';
            } catch (error) {
                console.error('Failed to load metrics:', error);
                this.toast(`加载指标失败: ${error.message}`, 'danger');
            }
        },

        async loadAudit(filters = {}) {
            try {
                if (!document.querySelector('#audit-filter-form select[name="adapterId"]')?.options?.length) {
                    await this.loadBindings();
                }

                const response = await global.ChannelHubAPI.getAuditLogs({
                    limit: 100,
                    ...filters
                });
                const logs = response.data || [];
                const tbody = document.getElementById('audit-table');
                const total = response.pagination?.total || logs.length;
                const totalCount = document.getElementById('audit-total-count');

                if (!tbody) return;

                if (totalCount) {
                    totalCount.textContent = `共 ${total} 条记录`;
                }

                tbody.innerHTML = logs.length
                    ? logs.map((log) => `
                        <tr>
                            <td>${log.timestamp ? global.ChannelHubAPI.formatDate(log.timestamp) : '-'}</td>
                            <td><code>${this.escape(log.requestId || log.traceId || '-')}</code></td>
                            <td>${this.escape(log.adapterId || '-')}</td>
                            <td>${this.escape(log.eventType || log.type || '-')}</td>
                            <td>${this.escape(log.status || log.level || '-')}</td>
                            <td>${log.durationMs ? `${log.durationMs}ms` : '-'}</td>
                            <td>-</td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="7" class="text-center text-muted">暂无审计记录</td></tr>';
            } catch (error) {
                console.error('Failed to load audit:', error);
                this.toast(`加载审计记录失败: ${error.message}`, 'danger');
            }
        },

        collectAuditFilters() {
            const form = document.getElementById('audit-filter-form');
            if (!form) return {};
            const formData = new FormData(form);
            return Object.fromEntries(Array.from(formData.entries()).filter(([, value]) => value !== ''));
        },

        showModal(id) {
            const modalEl = document.getElementById(id);
            if (!modalEl) return;
            const modal = global.bootstrap?.Modal?.getOrCreateInstance(modalEl);
            modal?.show();
        },

        hideModal(id) {
            const modalEl = document.getElementById(id);
            if (!modalEl) return;
            const modal = global.bootstrap?.Modal?.getInstance(modalEl);
            if (modal) {
                modal.hide();
            }
        },

        renderStatus(status) {
            const normalized = status || 'inactive';
            const classMap = {
                active: 'status-active',
                delivered: 'status-active',
                success: 'status-active',
                pending: 'status-pending',
                processing: 'status-pending',
                inactive: 'status-inactive',
                failed: 'status-error',
                error: 'status-error'
            };

            return `<span class="status-badge ${classMap[normalized] || 'status-inactive'}">${this.escape(normalized)}</span>`;
        },

        setText(id, value) {
            const node = document.getElementById(id);
            if (node) {
                node.textContent = value;
            }
        },

        toast(message, type) {
            if (typeof global.showToast === 'function') {
                global.showToast(message, type);
            } else {
                console.error(message);
            }
        },

        escape(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }
    };

    global.ChannelHubPage = ChannelHubPage;
})(typeof window !== 'undefined' ? window : global);


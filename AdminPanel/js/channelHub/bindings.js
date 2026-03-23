/**
 * ChannelHub Session Bindings Management UI
 * 会话绑定管理界面
 * 
 * 负责渲染和管理外部平台会话与 VCP Agent 的绑定关系
 */

const BindingsManager = {
    /**
     * 初始化绑定管理器
     * @param {HTMLElement} container - 容器元素
     */
    init(container) {
        this.container = container;
        this.bindings = [];
        this.render();
    },

    /**
     * 渲染绑定管理界面
     */
    render() {
        this.container.innerHTML = `
            <div class="bindings-manager">
                <div class="section-header">
                    <h3>会话绑定管理</h3>
                    <button class="btn btn-primary" onclick="BindingsManager.showCreateModal()">
                        + 新建绑定
                    </button>
                </div>
                
                <div class="bindings-filters">
                    <select id="binding-channel-filter" onchange="BindingsManager.loadBindings()">
                        <option value="">全部渠道</option>
                        <option value="dingtalk">钉钉</option>
                        <option value="wecom">企业微信</option>
                        <option value="feishu">飞书</option>
                        <option value="qq">QQ</option>
                        <option value="wechat">微信</option>
                    </select>
                    <input type="text" id="binding-search" placeholder="搜索绑定Key..." 
                           onkeyup="BindingsManager.searchBindings(this.value)">
                </div>
                
                <div class="bindings-stats">
                    <span>总计: <strong id="bindings-total">0</strong> 个绑定</span>
                </div>
                
                <table class="bindings-table">
                    <thead>
                        <tr>
                            <th>绑定Key</th>
                            <th>渠道</th>
                            <th>外部会话ID</th>
                            <th>Agent ID</th>
                            <th>状态</th>
                            <th>创建时间</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody id="bindings-tbody">
                        <tr>
                            <td colspan="7" class="loading">加载中...</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            
            <!-- 创建/编辑绑定模态框 -->
            <div id="binding-modal" class="modal hidden">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 id="binding-modal-title">新建绑定</h3>
                        <button class="modal-close" onclick="BindingsManager.closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <form id="binding-form">
                            <input type="hidden" id="binding-id">
                            
                            <div class="form-group">
                                <label for="binding-key">绑定Key *</label>
                                <input type="text" id="binding-key" required 
                                       placeholder="格式: {adapterId}:{externalSessionId}">
                                <small>用于唯一标识一个外部会话绑定</small>
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-channel">渠道 *</label>
                                <select id="binding-channel" required>
                                    <option value="">选择渠道</option>
                                    <option value="dingtalk">钉钉</option>
                                    <option value="wecom">企业微信</option>
                                    <option value="feishu">飞书</option>
                                    <option value="qq">QQ</option>
                                    <option value="wechat">微信</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-external-session">外部会话ID *</label>
                                <input type="text" id="binding-external-session" required
                                       placeholder="外部平台的会话标识">
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-adapter-id">适配器ID *</label>
                                <select id="binding-adapter-id" required>
                                    <option value="">选择适配器</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-agent-id">Agent ID *</label>
                                <input type="text" id="binding-agent-id" required
                                       placeholder="关联的 VCP Agent ID">
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-conversation-id">会话ID</label>
                                <input type="text" id="binding-conversation-id"
                                       placeholder="VCP 内部会话ID（可选）">
                            </div>
                            
                            <div class="form-group">
                                <label for="binding-context">上下文数据</label>
                                <textarea id="binding-context" rows="3"
                                          placeholder='JSON 格式的附加上下文数据'></textarea>
                            </div>
                            
                            <div class="form-group">
                                <label>
                                    <input type="checkbox" id="binding-active" checked>
                                    启用绑定
                                </label>
                            </div>
                        </form>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="BindingsManager.closeModal()">取消</button>
                        <button class="btn btn-primary" onclick="BindingsManager.saveBinding()">保存</button>
                    </div>
                </div>
            </div>
        `;
        
        this.loadBindings();
        this.loadAdaptersForSelect();
    },

    /**
     * 加载绑定列表
     */
    async loadBindings() {
        const tbody = document.getElementById('bindings-tbody');
        const channelFilter = document.getElementById('binding-channel-filter').value;
        
        try {
            const params = new URLSearchParams();
            if (channelFilter) params.append('channel', channelFilter);
            
            const response = await ChannelHubAPI.getBindings(params.toString());
            this.bindings = response.data || [];
            
            this.renderBindingsTable();
            document.getElementById('bindings-total').textContent = this.bindings.length;
        } catch (error) {
            tbody.innerHTML = `<tr><td colspan="7" class="error">加载失败: ${error.message}</td></tr>`;
        }
    },

    /**
     * 渲染绑定表格
     */
    renderBindingsTable() {
        const tbody = document.getElementById('bindings-tbody');
        
        if (this.bindings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无绑定数据</td></tr>';
            return;
        }
        
        tbody.innerHTML = this.bindings.map(binding => `
            <tr data-id="${binding.bindingKey}">
                <td><code>${binding.bindingKey}</code></td>
                <td>
                    <span class="channel-badge ${binding.channel}">
                        ${this.getChannelName(binding.channel)}
                    </span>
                </td>
                <td>${binding.externalSessionKey || '-'}</td>
                <td><code>${binding.agentId || '-'}</code></td>
                <td>
                    <span class="status-badge ${binding.isActive ? 'active' : 'inactive'}">
                        ${binding.isActive ? '已激活' : '未激活'}
                    </span>
                </td>
                <td>${binding.createdAt ? ChannelHubAPI.formatDate(binding.createdAt) : '-'}</td>
                <td class="actions">
                    <button class="btn btn-sm btn-info" onclick="BindingsManager.viewBinding('${binding.bindingKey}')">
                        查看
                    </button>
                    <button class="btn btn-sm btn-warning" onclick="BindingsManager.editBinding('${binding.bindingKey}')">
                        编辑
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="BindingsManager.deleteBinding('${binding.bindingKey}')">
                        删除
                    </button>
                </td>
            </tr>
        `).join('');
    },

    /**
     * 加载适配器列表用于下拉选择
     */
    async loadAdaptersForSelect() {
        try {
            const response = await ChannelHubAPI.getAdapters();
            const adapters = response.data || [];
            const select = document.getElementById('binding-adapter-id');
            
            select.innerHTML = '<option value="">选择适配器</option>' +
                adapters.map(adapter => 
                    `<option value="${adapter.adapterId}">${adapter.name} (${adapter.adapterId})</option>`
                ).join('');
        } catch (error) {
            console.error('加载适配器列表失败:', error);
        }
    },

    /**
     * 搜索绑定
     * @param {string} keyword - 搜索关键词
     */
    searchBindings(keyword) {
        const filtered = this.bindings.filter(binding => 
            binding.bindingKey.toLowerCase().includes(keyword.toLowerCase()) ||
            (binding.agentId && binding.agentId.toLowerCase().includes(keyword.toLowerCase()))
        );
        this.renderFilteredBindings(filtered);
    },

    /**
     * 渲染过滤后的绑定
     * @param {Array} bindings - 过滤后的绑定列表
     */
    renderFilteredBindings(bindings) {
        const tbody = document.getElementById('bindings-tbody');
        // 使用相同的渲染逻辑，只是数据不同
        const originalBindings = this.bindings;
        this.bindings = bindings;
        this.renderBindingsTable();
        this.bindings = originalBindings;
    },

    /**
     * 显示创建绑定模态框
     */
    showCreateModal() {
        document.getElementById('binding-modal-title').textContent = '新建绑定';
        document.getElementById('binding-form').reset();
        document.getElementById('binding-id').value = '';
        document.getElementById('binding-active').checked = true;
        document.getElementById('binding-modal').classList.remove('hidden');
    },

    /**
     * 编辑绑定
     * @param {string} bindingKey - 绑定Key
     */
    async editBinding(bindingKey) {
        const binding = this.bindings.find(b => b.bindingKey === bindingKey);
        if (!binding) return;
        
        document.getElementById('binding-modal-title').textContent = '编辑绑定';
        document.getElementById('binding-id').value = binding.bindingKey;
        document.getElementById('binding-key').value = binding.bindingKey;
        document.getElementById('binding-channel').value = binding.channel;
        document.getElementById('binding-external-session').value = binding.externalSessionKey || '';
        document.getElementById('binding-adapter-id').value = binding.adapterId || '';
        document.getElementById('binding-agent-id').value = binding.agentId || '';
        document.getElementById('binding-conversation-id').value = binding.conversationId || '';
        document.getElementById('binding-context').value = binding.context ? JSON.stringify(binding.context, null, 2) : '';
        document.getElementById('binding-active').checked = binding.isActive !== false;
        
        document.getElementById('binding-modal').classList.remove('hidden');
    },

    /**
     * 查看绑定详情
     * @param {string} bindingKey - 绑定Key
     */
    viewBinding(bindingKey) {
        const binding = this.bindings.find(b => b.bindingKey === bindingKey);
        if (!binding) return;
        
        // 简单的详情展示，可以后续扩展为专门的详情模态框
        alert(`绑定详情:\n\n${JSON.stringify(binding, null, 2)}`);
    },

    /**
     * 保存绑定
     */
    async saveBinding() {
        const form = document.getElementById('binding-form');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        const bindingId = document.getElementById('binding-id').value;
        const bindingData = {
            bindingKey: document.getElementById('binding-key').value,
            channel: document.getElementById('binding-channel').value,
            externalSessionKey: document.getElementById('binding-external-session').value,
            adapterId: document.getElementById('binding-adapter-id').value,
            agentId: document.getElementById('binding-agent-id').value,
            conversationId: document.getElementById('binding-conversation-id').value || null,
            isActive: document.getElementById('binding-active').checked
        };
        
        // 解析上下文数据
        const contextStr = document.getElementById('binding-context').value.trim();
        if (contextStr) {
            try {
                bindingData.context = JSON.parse(contextStr);
            } catch (e) {
                alert('上下文数据格式错误，请输入有效的 JSON');
                return;
            }
        }
        
        try {
            if (bindingId) {
                await ChannelHubAPI.updateBinding(bindingId, bindingData);
            } else {
                await ChannelHubAPI.createBinding(bindingData);
            }
            
            this.closeModal();
            this.loadBindings();
        } catch (error) {
            alert('保存失败: ' + error.message);
        }
    },

    /**
     * 删除绑定
     * @param {string} bindingKey - 绑定Key
     */
    async deleteBinding(bindingKey) {
        if (!confirm(`确定要删除绑定 "${bindingKey}" 吗？`)) {
            return;
        }
        
        try {
            await ChannelHubAPI.deleteBinding(bindingKey);
            this.loadBindings();
        } catch (error) {
            alert('删除失败: ' + error.message);
        }
    },

    /**
     * 关闭模态框
     */
    closeModal() {
        document.getElementById('binding-modal').classList.add('hidden');
    },

    /**
     * 获取渠道名称
     * @param {string} channel - 渠道标识
     * @returns {string} 渠道名称
     */
    getChannelName(channel) {
        const names = {
            dingtalk: '钉钉',
            wecom: '企业微信',
            feishu: '飞书',
            qq: 'QQ',
            wechat: '微信'
        };
        return names[channel] || channel;
    }
};

if (typeof window !== 'undefined') {
    window.BindingsManager = BindingsManager;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BindingsManager;
}

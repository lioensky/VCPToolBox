const vscode = require('vscode');
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // 注册WebView视图
    const provider = new VCPPanelViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.webviewViewProvider.createViewProvider(
            'vcp-panel-view',
            provider
        )
    );

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('vcp-panel.open', () => {
            vscode.commands.executeCommand('workbench.view.extension.vcp-panel-container');
        })
    );

    console.log('VCP Panel 扩展已激活');
}

function deactivate() {}

class VCPPanelViewProvider {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }

    resolveWebviewView(webviewView) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri
            ]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    }

    getHtmlContent(webview) {
        const scriptUri = webview.asWebviewUri(
            path.join(this.extensionUri, 'webview-ui', 'build', 'assets', 'index.js')
        );

        const styleUri = webview.asWebviewUri(
            path.join(this.extensionUri, 'webview-ui', 'build', 'assets', 'index.css')
        );

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src http://localhost:* http://127.0.0.1:*">
    <title>VCP Panel</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 16px;
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            height: 100vh;
            overflow-y: auto;
        }

        h2 {
            font-size: 18px;
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }

        .section {
            margin-bottom: 20px;
            padding: 12px;
            background: var(--vscode-editorWidget-background, #252526);
            border-radius: 6px;
        }

        .section h3 {
            font-size: 14px;
            margin-bottom: 12px;
            font-weight: 500;
        }

        select, input[type="text"] {
            width: 100%;
            padding: 8px 12px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #cccccc);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            font-size: 13px;
            margin-bottom: 8px;
        }

        select:focus, input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder, #007acc);
        }

        button {
            padding: 8px 16px;
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }

        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }

        .status {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #858585);
            margin-top: 8px;
        }
        .status.active { color: #4ec9b0; }

        .results { margin-top: 12px; }
        .result-item {
            padding: 10px;
            background: var(--vscode-editorWidget-background, #252526);
            border-radius: 4px;
            margin-bottom: 8px;
            border-left: 3px solid var(--vscode-focusBorder, #007acc);
        }
        .result-item .rank {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #858585);
        }
        .result-item .score {
            float: right;
            font-size: 11px;
            color: #4ec9b0;
        }
        .result-item .content {
            font-size: 12px;
            line-height: 1.5;
            max-height: 60px;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 4px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
        }
        .stat-item {
            padding: 12px;
            background: var(--vscode-input-background, #3c3c3c);
            border-radius: 4px;
            text-align: center;
        }
        .stat-item .value { font-size: 20px; font-weight: 600; }
        .stat-item .label { font-size: 11px; color: var(--vscode-descriptionForeground, #858585); margin-top: 4px; }

        .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); margin-bottom: 16px; }
        .tab {
            padding: 8px 16px;
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground, #858585);
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
        }
        .tab.active { color: var(--vscode-editor-foreground, #d4d4d4); border-bottom-color: var(--vscode-focusBorder, #007acc); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .loading {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-descriptionForeground, #858585);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 6px;
            vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .error { padding: 8px; background: rgba(255,0,0,0.1); border: 1px solid #f44336; border-radius: 4px; color: #f44336; font-size: 12px; }

        #config-section { display: none; }
        #config-section.show { display: block; }
        .config-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .config-row label { font-size: 12px; min-width: 80px; }
    </style>
</head>
<body>
    <h2>VCP 控制台</h2>

    <div class="tabs">
        <button class="tab active" data-tab="agent">Agent</button>
        <button class="tab" data-tab="knowledge">知识库</button>
        <button class="tab" data-tab="stats">统计</button>
        <button class="tab" data-tab="config">配置</button>
    </div>

    <!-- Agent面板 -->
    <div id="tab-agent" class="tab-content active">
        <div class="section">
            <h3>当前Agent</h3>
            <select id="agent-select"><option value="">加载中...</option></select>
            <div id="agent-status" class="status">加载中...</div>
            <button id="activate-btn" style="margin-top: 12px;">激活Agent</button>
        </div>
    </div>

    <!-- 知识库面板 -->
    <div id="tab-knowledge" class="tab-content">
        <div class="section">
            <h3>搜索知识库</h3>
            <input type="text" id="search-input" placeholder="输入搜索内容...">
            <select id="diary-select"><option value="">全部知识簇</option></select>
            <button id="search-btn">搜索</button>
        </div>
        <div id="search-results" class="results"></div>
    </div>

    <!-- 统计面板 -->
    <div id="tab-stats" class="tab-content">
        <div class="section">
            <h3>知识库概览</h3>
            <div class="stats-grid">
                <div class="stat-item"><div class="value" id="stat-diaries">-</div><div class="label">知识簇</div></div>
                <div class="stat-item"><div class="value" id="stat-chunks">-</div><div class="label">总条目</div></div>
                <div class="stat-item"><div class="value" id="stat-dim">-</div><div class="label">向量维度</div></div>
                <div class="stat-item"><div class="value" id="stat-model">-</div><div class="label">嵌入模型</div></div>
            </div>
            <button id="refresh-btn" style="margin-top: 12px; width: 100%;">刷新</button>
        </div>
    </div>

    <!-- 配置面板 -->
    <div id="tab-config" class="tab-content">
        <div class="section">
            <h3>VCP服务器配置</h3>
            <div class="config-row">
                <label>服务器地址:</label>
                <input type="text" id="vcp-url" value="http://localhost:5050" style="flex:1;">
            </div>
            <button id="save-config-btn">保存配置</button>
            <div id="config-status" class="status"></div>
        </div>
    </div>

    <script>
    (function() {
        // 默认配置
        let config = {
            vcpUrl: 'http://localhost:5050'
        };

        // 加载配置
        try {
            const saved = localStorage.getItem('vcp-panel-config');
            if (saved) config = JSON.parse(saved);
        } catch(e) {}

        document.getElementById('vcp-url').value = config.vcpUrl;

        // API调用
        async function apiCall(endpoint, options = {}) {
            const url = config.vcpUrl + endpoint;
            const res = await fetch(url, {
                ...options,
                headers: { 'Content-Type': 'application/json', ...options.headers }
            });
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        }

        // 标签页切换
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
                if (tab.dataset.tab === 'stats') loadStats();
            });
        });

        // 保存配置
        document.getElementById('save-config-btn').addEventListener('click', () => {
            config.vcpUrl = document.getElementById('vcp-url').value.trim();
            localStorage.setItem('vcp-panel-config', JSON.stringify(config));
            document.getElementById('config-status').textContent = '配置已保存';
            document.getElementById('config-status').className = 'status active';
            loadAgents();
        });

        // 加载Agent列表
        async function loadAgents() {
            try {
                const [active, map] = await Promise.all([
                    apiCall('/api/agents/active').catch(() => ({ active: null, availableAgents: [] })),
                    apiCall('/api/agents/map').catch(() => ({}))
                ]);
                const agents = active.availableAgents || Object.keys(map);
                const select = document.getElementById('agent-select');
                select.innerHTML = agents.map(n => \`<option value="\${n}" \${n === active.active ? 'selected' : ''}>\${n}</option>\`).join('');
                const status = document.getElementById('agent-status');
                status.innerHTML = active.active ? \`<span class="active">●</span> 当前: \${active.active}\` : '未选择';
            } catch(e) {
                document.getElementById('agent-status').textContent = '连接失败: ' + e.message;
            }
        }

        // 激活Agent
        document.getElementById('activate-btn').addEventListener('click', async () => {
            const name = document.getElementById('agent-select').value;
            if (!name) return;
            const btn = document.getElementById('activate-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>激活中...';
            try {
                const r = await apiCall('/api/agents/activate', {
                    method: 'POST',
                    body: JSON.stringify({ name })
                });
                document.getElementById('agent-status').innerHTML = \`<span class="active">●</span> 当前: \${r.active}\`;
            } catch(e) {
                alert('激活失败: ' + e.message);
            }
            btn.disabled = false;
            btn.innerHTML = '激活Agent';
        });

        // 加载知识簇
        async function loadDiaries() {
            try {
                const stats = await apiCall('/api/rag/stats').catch(() => ({}));
                const select = document.getElementById('diary-select');
                if (stats.diaries && stats.diaries.length) {
                    select.innerHTML = '<option value="">全部</option>' +
                        stats.diaries.map(d => \`<option value="\${d.name}">\${d.name} (\${d.chunkCount||0})</option>\`).join('');
                }
            } catch(e) {}
        }

        // 搜索
        document.getElementById('search-btn').addEventListener('click', async () => {
            const query = document.getElementById('search-input').value.trim();
            const diary = document.getElementById('diary-select').value || null;
            if (!query) return;

            const btn = document.getElementById('search-btn');
            const results = document.getElementById('search-results');
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>搜索...';
            results.innerHTML = '';

            try {
                const r = await apiCall('/api/rag/search', {
                    method: 'POST',
                    body: JSON.stringify({ query, k: 10, diaryName: diary })
                });
                if (r.results && r.results.length) {
                    results.innerHTML = r.results.map(item => \`
                        <div class="result-item">
                            <div class="rank">#\${item.rank}<span class="score">\${(item.score*100).toFixed(1)}%</span></div>
                            <div class="content">\${escape(item.content)}</div>
                        </div>
                    \`).join('');
                } else {
                    results.innerHTML = '<div class="error">未找到结果</div>';
                }
            } catch(e) {
                results.innerHTML = '<div class="error">搜索失败: ' + e.message + '</div>';
            }

            btn.disabled = false;
            btn.innerHTML = '搜索';
        });

        document.getElementById('search-input').addEventListener('keypress', e => {
            if (e.key === 'Enter') document.getElementById('search-btn').click();
        });

        // 统计
        async function loadStats() {
            try {
                const stats = await apiCall('/api/rag/stats').catch(() => ({}));
                document.getElementById('stat-diaries').textContent = stats.diaryCount || stats.diaries?.length || '-';
                const chunks = stats.diaries?.reduce((s,d) => s + (d.chunkCount||0), 0) || '-';
                document.getElementById('stat-chunks').textContent = chunks;
                document.getElementById('stat-dim').textContent = stats.config?.dimension || '-';
                document.getElementById('stat-model').textContent = (stats.config?.embeddingModel || '-').substring(0,8);
            } catch(e) {}
        }

        document.getElementById('refresh-btn').addEventListener('click', loadStats);

        function escape(t) {
            const d = document.createElement('div');
            d.textContent = t;
            return d.innerHTML;
        }

        // 初始化
        loadAgents();
        loadDiaries();
    })();
    </script>
</body>
</html>`;
    }
}

module.exports = { activate, deactivate };
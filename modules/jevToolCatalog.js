'use strict';

const fs = require('fs');
const path = require('path');

const normalize = value => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_KEYS = new Set(['tool_name', 'jev', 'skipapproval', 'bypassapproval', 'river_context', 'vref_files']);

function normalizeTerminalBooleans(args) {
    for (const key of Object.keys(args)) {
        if (!/^(requireAdmin|newSession|submit)\d*$/.test(key)) continue;
        const value = args[key];
        if (typeof value === 'boolean') continue;
        if (typeof value !== 'string' || !/^(true|false)$/i.test(value.trim())) throw new Error(`PowerShellExecutor ${key} 必须为 true/false。`);
        args[key] = value.trim().toLowerCase() === 'true';
    }
    return args;
}

function validateMemoArgs(name, args, inherited) {
    if (!['DeepMemo', 'TopicMemo'].includes(name)) return args;
    if (!(args.maid || inherited.maid || inherited.valet)) throw new Error(`${name} 缺少必填参数 maid。`);
    if (name === 'DeepMemo') {
        if (typeof args.keyword !== 'string' || !args.keyword.trim()) throw new Error('DeepMemo 缺少 keyword。');
        if (args.window_size !== undefined && (!/^\d+$/.test(String(args.window_size)) || +args.window_size < 1 || +args.window_size > 20)) throw new Error('DeepMemo window_size 必须为1–20的整数。');
        if (args.rerank !== undefined) {
            if (typeof args.rerank !== 'boolean' && !/^(true|false)$/.test(String(args.rerank))) throw new Error('DeepMemo rerank 必须为true/false。');
            args.rerank = args.rerank === true || args.rerank === 'true';
        }
    } else {
        if (!['ListTopics', 'GetTopicContent'].includes(args.command)) throw new Error('TopicMemo 操作必须为ListTopics或GetTopicContent。');
        if (args.command === 'GetTopicContent' && (typeof args.topic_id !== 'string' || !args.topic_id.trim())) throw new Error('TopicMemo 缺少 topic_id。');
    }
    return args;
}

// These are parameter mappings, not executable templates. Code, paths and prose
// are copied from the caller; Jev never invents them or evaluates them.
const FILE_ACTIONS = {
    ListAllowedDirectories: { verbs: ['允许目录', '可访问目录'], required: [] },
    WebReadFile: { verbs: ['读取网络文件', '阅读网络文件'], primary: 'url', required: ['url'] },
    ReadFile: { verbs: ['读取文件', '阅读文件', '读文件'], primary: 'filePath', required: ['filePath'] },
    WriteFile: { verbs: ['写入文件', '新建文件'], primary: 'content', slots: ['filePath'], required: ['filePath', 'content'] },
    WriteEscapedFile: { verbs: ['转义写入'], primary: 'content', slots: ['filePath'], required: ['filePath', 'content'] },
    AppendFile: { verbs: ['追加文件', '追加内容'], primary: 'content', slots: ['filePath'], required: ['filePath', 'content'] },
    EditFile: { verbs: ['覆盖文件', '覆盖写入', '编辑文件'], primary: 'content', slots: ['filePath'], required: ['filePath', 'content'] },
    ApplyDiff: { verbs: ['差分修改', '局部替换'], primary: 'replaceString', slots: ['filePath', 'searchString'], required: ['filePath', 'searchString', 'replaceString'] },
    ListDirectory: { verbs: ['列出目录', '浏览目录', '查看目录', '目录列表'], primary: 'directoryPath', required: ['directoryPath'] },
    FileInfo: { verbs: ['文件信息', '文件元数据'], primary: 'filePath', required: ['filePath'] },
    CopyFile: { verbs: ['复制文件'], slots: ['sourcePath', 'destinationPath'], required: ['sourcePath', 'destinationPath'] },
    MoveFile: { verbs: ['移动文件'], slots: ['sourcePath', 'destinationPath'], required: ['sourcePath', 'destinationPath'] },
    RenameFile: { verbs: ['重命名文件'], slots: ['sourcePath', 'destinationPath'], required: ['sourcePath', 'destinationPath'] },
    DeleteFile: { verbs: ['删除文件'], primary: 'filePath', required: ['filePath'] },
    CreateDirectory: { verbs: ['创建目录', '新建目录', '创建文件夹'], primary: 'directoryPath', required: ['directoryPath'] },
    SearchFiles: { verbs: ['搜索文件名'], primary: 'pattern', slots: ['searchPath'], required: ['searchPath', 'pattern'] },
    DownloadFile: { verbs: ['下载文件'], primary: 'url', slots: ['downloadDir'], required: ['url'] },
    CreateCanvas: { verbs: ['创建画布', '创建Canvas'], primary: 'content', slots: ['fileName'], required: ['fileName', 'content'] },
    UpdateHistory: { verbs: ['修改聊天历史'], primary: 'replaceString', slots: ['filePath', 'searchString'], required: ['filePath', 'searchString', 'replaceString'] }
};

const BROWSER_ACTIONS = {
    open_chrome: { verbs: ['启动浏览器', '打开浏览器'] },
    close_chrome: { verbs: ['关闭浏览器'] },
    browser_status: { verbs: ['浏览器状态', '连接状态'] },
    keep_chrome_alive: { verbs: ['浏览器保活', '续命'] },
    open_url: { verbs: ['打开网页', '打开网站'], primary: 'url', required: ['url'] },
    get_page_info: { verbs: ['读取页面', '页面信息', '页面快照'] },
    capture_screenshot: { verbs: ['页面截图', '截取页面'] },
    list_tabs: { verbs: ['列出标签页', '标签页列表'] },
    switch_tab: { verbs: ['切换标签页'], primary: 'target', required: ['target'] },
    close_tab: { verbs: ['关闭标签页'] },
    click: { verbs: ['点击'], primary: 'target', required: ['target'] },
    type: { verbs: ['输入文字', '输入文本'], primary: 'text', slots: ['target'], required: ['target', 'text'] },
    scroll: { verbs: ['滚动'], primary: 'direction' },
    wait: { verbs: ['等待'], primary: 'waitMs' },
    execute_script: { verbs: ['执行脚本'], primary: 'text', required: ['text'] },
    execute_saved_script: { verbs: ['执行已保存脚本'], primary: 'scriptName', required: ['scriptName'] },
    page_code_search: { verbs: ['搜索页面源码'], primary: 'query', required: ['query'] }
};

const PROFILES = {
    ServerFileOperator: { aliases: { 旧内容: 'target', 新内容: 'replace', searchString: 'target', replaceString: 'replace' }, actions: {
        ...FILE_ACTIONS,
        ApplyDiff: { verbs: ['差分修改', '局部替换'], primary: 'replace', slots: ['filePath', 'target'], required: ['filePath', 'target', 'replace'] },
        UpdateHistory: { verbs: ['修改聊天历史'], primary: 'replace', slots: ['filePath', 'target'], required: ['filePath', 'target', 'replace'] }
    } },
    FileOperator: { actions: FILE_ACTIONS },
    ChromeBridge: { actions: BROWSER_ACTIONS },
    DailyNote: { aliases: { 日期: 'Date', 索引: 'folder', 标题: 'fileName', 标签: 'Tag' }, actions: {
        create: { verbs: ['记日记', '创建日记', '记录日记'], primary: 'Content', required: ['Content', 'Date', 'maid'] },
        update: { verbs: ['更新日记', '修订日记'], primary: 'replace', slots: ['target'], required: ['target', 'replace', 'maid'] }
    } },
    DailyNoteManager: { aliases: { 日期: 'Date', 索引: 'folder', 起始日期: 'startDate', 结束日期: 'endDate', 数量: 'k', 阈值: 'minScore', 范围: 'range', 标签: 'Tag' }, actions: {
        list: { verbs: ['列出日记', '查询日记列表'], primary: 'folder', required: ['folder'] },
        organize: { verbs: ['整理日记', '归档日记'], primary: 'Content', slots: ['urls'], required: ['urls', 'Content', 'Date', 'maid'] },
        associate: { verbs: ['联想日记', '关联日记'], primary: 'url', required: ['url'] }
    } },
    DailyNoteSearcher: { primary: 'query', required: ['query'], aliases: { 索引: 'folder', 上下文: 'context_lines', 正则: 'is_regex' } },
    LightMemo: { primary: 'query', required: ['query'], defaultVerbs: ['主动回忆', '快速回忆', '检索记忆', '搜索记忆'], fields: ['search_all_knowledge_bases'], aliases: { 索引: 'folder', 数量: 'k', 重排: 'rerank' } },
    ChatTencentcos: { actions: { upload_file: { verbs: ['上传文件', '上传这份文件'], primary: 'local_path', slots: ['cos_folder'], required: ['local_path'] }, download_file: { verbs: ['下载云端文件'], primary: 'cos_key', slots: ['local_path'], required: ['cos_key'] } } },
    AgentAssistant: { primary: 'prompt', slots: ['agent_name'], required: ['prompt', 'agent_name'] },
    SciCalculator: { primary: 'expression', required: ['expression'] },
    DeepMemo: { primary: 'keyword', required: ['keyword', 'maid'] },
    TopicMemo: { actions: {
        ListTopics: { verbs: ['话题列表', '列出话题'], required: ['maid'] },
        GetTopicContent: { verbs: ['读取话题', '回忆话题'], primary: 'topic_id', required: ['topic_id', 'maid'] }
    } },
    DeepWikiVCP: { actions: {
        wiki_ask: { verbs: ['询问仓库', '仓库问答', '分析仓库'], primary: 'question', slots: ['url'], required: ['url', 'question'] },
        wiki_structure: { verbs: ['文档目录', '仓库结构'], primary: 'url', required: ['url'] },
        wiki_content: { verbs: ['完整文档', '文档全文'], primary: 'url', required: ['url'] }
    } },
    CodeSearcher: { primary: 'query', required: ['query'], aliases: { 路径: 'search_path', 上下文: 'context_lines', 区分大小写: 'case_sensitive', 全词: 'whole_word' } },
    ServerCodeSearcher: { primary: 'query', required: ['query'], aliases: { 路径: 'search_path', 上下文: 'context_lines', 区分大小写: 'case_sensitive', 全词: 'whole_word' } },
    LocalSearchController: { fixed: { command: 'search' }, primary: 'query', required: ['query'] },
    ServerSearchController: { fixed: { command: 'search' }, primary: 'query', required: ['query'] },
    ServerPowerShellExecutor: { primary: 'command', required: ['command'] },
    OldPowerShellExecutor: { primary: 'command', required: ['command'] },
    LinuxShellExecutor: { primary: 'command', required: ['command'] },
    PowerShellExecutor: { defaultAction: 'ExecutePowerShell', actions: {
        ExecutePowerShell: { verbs: ['执行命令', '运行命令', '执行PowerShell'], primary: 'powershell', required: ['powershell'] },
        QueryVisible: { verbs: ['查看终端', '终端输出'] },
        StartInteractive: { verbs: ['启动交互程序'], primary: 'powershell', required: ['powershell'] },
        SendInteractiveKey: { verbs: ['发送按键'], primary: 'key', required: ['key'] },
        PasteInteractiveText: { verbs: ['粘贴终端文本'], primary: 'text', required: ['text'] },
        RunInteractiveSequence: { verbs: ['交互序列'] },
        InterruptPowerShell: { verbs: ['中断终端'] },
        EndInteractive: { verbs: ['结束交互模式'] }
    } },
    AgentMessage: { primary: 'message', required: ['message'] },
    FirecrawlDevSearch: { primary: 'query', required: ['query'], aliases: { 数量: 'k', 仓库: 'repos', 类型: 'types', 来源: 'sources' } },
    TimedTaskQuery: { primary: 'task_id', required: ['task_id'] },
    ToolCallRecordQuery: { primary: 'query' },
    MediaRenderer: { actions: {
        RenderImage: { verbs: ['渲染图片', '渲染SVG', '渲染HTML'], primary: 'html', required: ['width', 'height'] },
        RenderAnimation: { verbs: ['渲染动画'], primary: 'html', required: ['html', 'width', 'height'] },
        GenerateAudio: { verbs: ['生成音频'], primary: 'code', required: ['code', 'requireAdmin'] }
    } },
    GitOperator: { actions: {
        Status: { verbs: ['仓库状态', '查看状态'] }, Log: { verbs: ['提交历史'] },
        Diff: { verbs: ['查看差异', '比较差异'] }, BranchList: { verbs: ['列出分支', '分支列表'] },
        ProfileList: { verbs: ['仓库配置列表'] }, RemoteInfo: { verbs: ['远程仓库信息'] },
        Add: { verbs: ['暂存文件'], primary: 'files', required: ['files'] },
        Commit: { verbs: ['提交变更'], primary: 'message', required: ['message'] }
    } },
    LoomController: { actions: {
        ListApps: { verbs: ['应用列表', '列出应用'] }, ListOpenApps: { verbs: ['运行中应用'] },
        OpenApp: { verbs: ['打开应用'], primary: 'appId', required: ['appId'] },
        CloseApp: { verbs: ['关闭应用'], primary: 'appId', required: ['appId'] },
        GetPageInfo: { verbs: ['读取页面', '页面快照'], primary: 'appId', required: ['appId'] },
        GetAppSources: { verbs: ['读取应用源码'], primary: 'appId', required: ['appId'] }
    } }
};

const PARAMETER_ALIASES = {
    路径: 'filePath', 文件路径: 'filePath', 目录: 'directoryPath', 源路径: 'sourcePath', 目标路径: 'destinationPath',
    旧内容: 'searchString', 新内容: 'replaceString', 文件名: 'fileName', 行数: 'lines', 编码: 'encoding',
    目标: 'target', 应用: 'appId', 宽度: 'width', 高度: 'height', 格式: 'format', 质量: 'quality',
    源图: 'sourceImage', 透明: 'transparent', 仓库: 'url', 配置: 'profile', 深度研究: 'deep_research',
    深度: 'window_size', 重排: 'rerank', 数量: 'maxResults'
};

function assertSafeObject(value, trail = '') {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new Error(`JEV 参数包含禁止的键 ${trail}${key}。`);
        assertSafeObject(value[key], `${trail}${key}.`);
    }
}

function readExplicitArgs(inheritedArgs = {}) {
    const keys = Object.keys(inheritedArgs).filter(key => key.toLowerCase() === 'jevargs');
    if (!keys.length) return null;
    if (keys.length > 1) throw new Error('JEVArgs 只能提供一次。');
    let args = inheritedArgs[keys[0]];
    if (typeof args === 'string') {
        if (Buffer.byteLength(args) > 4 * 1024 * 1024) throw new Error('JEVArgs 超过 4 MB。');
        try { args = JSON.parse(args); } catch { throw new Error('JEVArgs 必须是合法 JSON 对象。'); }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('JEVArgs 必须是 JSON 对象，批量步骤使用原插件的数字后缀字段。');
    assertSafeObject(args);
    for (const key of Object.keys(args)) {
        if (CONTROL_KEYS.has(key.toLowerCase()) || /^jev(?:args|steps)$/i.test(key)) {
            throw new Error(`JEVArgs 不能覆盖调用控制字段 ${key}。`);
        }
    }
    return structuredClone(args);
}

class JevToolCatalog {
    constructor(options = {}) {
        this.data = options.data || JSON.parse(fs.readFileSync(options.path || path.join(__dirname, '..', 'ToolConfigs', 'jev_tool_catalog.json'), 'utf8'));
    }

    get(name) {
        const exact = Object.keys(this.data.tools).find(key => normalize(key) === normalize(name));
        return exact ? { name: exact, ...this.data.tools[exact] } : null;
    }

    // Read-only semantic contracts; native implementations remain the execution authority.
    getProfile(name) { return structuredClone(PROFILES[name] || null); }

    getParameterAliases(name) { return { ...PARAMETER_ALIASES, ...(PROFILES[name]?.aliases || {}) }; }

    extendConfig(config) {
        const extended = structuredClone(config);
        for (const [key, category] of Object.entries(this.data.categories)) {
            const target = extended.categories[key] ||= { aliases: [], tools: {} };
            target.aliases = [...new Set([...(target.aliases || []), category.label, ...category.aliases])];
            for (const [name, tool] of Object.entries(this.data.tools)) {
                if (tool.category !== key || Object.values(target.tools).some(t => t.plugin === name)) continue;
                target.tools[name] = { plugin: name, catalog: true };
            }
        }
        extended.categories.all_tools = {
            aliases: ['插件工具', '全部插件'],
            tools: Object.fromEntries(Object.keys(this.data.tools).map(plugin => [plugin, { plugin, catalog: true }]))
        };
        extended.categories.tool_catalog = { aliases: ['工具目录', '工具帮助'], tools: {} };
        return extended;
    }

    help(parsed) {
        if (parsed.categoryKey !== 'tool_catalog') return null;
        const requested = parsed.quotedTools.length ? parsed.quotedTools : parsed.primary.map(value => value.trim()).filter(Boolean);
        const constraints = parsed.allConstraints || parsed.constraints || [];
        const detailed = constraints.some(value => /^(详细|参数|完整说明)$/i.test(value));
        const operation = constraints.map(value => value.match(/^(?:操作|命令)[:：](.+)$/)).find(Boolean)?.[1]?.trim();
        const short = (text, limit = 150) => String(text || '').replace(/\s+/g, ' ').slice(0, limit);
        if (!requested.length) {
            return '# JEV 能力目录\n' + Object.entries(this.data.categories).map(([key, category]) => (
                `{${category.label}}：${Object.values(this.data.tools).filter(tool => tool.category === key).length} 个工具`
            )).join('\n') + '\n查询某类：{工具目录}【能力名】；查询短句：{工具目录} `插件名`；需要原始字段才加 [详细]，可加 [操作:能力标识] 只查一个操作。';
        }
        return requested.map(name => {
            const category = Object.entries(this.data.categories).find(([, item]) => [item.label, ...(item.aliases || [])].some(alias => normalize(alias) === normalize(name)));
            if (category) return `# ${category[1].label}\n` + Object.entries(this.data.tools).filter(([, tool]) => tool.category === category[0]).map(([key, tool]) => `${key}（${tool.distributed ? '分布式' : '服务器'}）：${short(tool.description, 90)}`).join('\n');
            const tool = this.get(name);
            if (!tool) throw new Error(`JEV 当前目录没有插件 "${name}"。`);
            const profile = this.getProfile(tool.name);
            const commands = operation ? tool.commands.filter(command => normalize(command.id) === normalize(operation)) : tool.commands;
            if (!commands.length) throw new Error(`${tool.name} 没有能力 "${operation}"。`);
            const label = this.data.categories[tool.category].label;
            const heading = `# ${tool.name}（${tool.distributed ? '分布式，需节点在线' : '服务器本地'}）\n${short(tool.description)}\n`;
            if (detailed || operation) return heading + '仅供按需核对原始契约；能力标识不一定等于实际 command/action。复杂嵌套或批量可用 JEVArgs 兼容通道，不作为普通调用模板。\n' + commands.map(command => `## ${command.id}\n${command.description}`).join('\n\n');
            const verbs = Object.values(profile?.actions || {}).flatMap(action => action.verbs || []);
            return heading + `短句：{${label}} \`${tool.name}\` ${verbs[0] || '说明要做的事'}【内容】[必要约束]\n` +
                (verbs.length ? `已知动作：${verbs.join('、')}\n` : '由 Jev 在本插件登记的操作与字段中判断，低置信度或必要信息不足时拒绝执行。\n') +
                `能力索引：${commands.map(command => command.id).join('、')}\n不需要在每次调用中输出参数表；查询某个精确操作再加 [操作:能力标识]。`;
        }).join('\n\n');
    }

    buildArgs(pluginName, parsed, inheritedArgs = {}) {
        const tool = this.get(pluginName);
        if (!tool) throw new Error(`插件 "${pluginName}" 未纳入当前 JEV 白名单。`);
        const explicit = readExplicitArgs(inheritedArgs);
        const profile = PROFILES[tool.name] || {};
        const actions = profile.actions || {};
        const constraints = parsed.allConstraints || [...parsed.constraints, ...parsed.imageUrls];
        let requestedOperation = null;
        const remaining = [];
        for (const constraint of constraints) {
            const match = constraint.match(/^(?:操作|命令|command|action)\s*[:：]\s*(.+)$/i);
            const standalone = tool.commands.find(c => normalize(c.id) === normalize(constraint));
            if (match || standalone) {
                if (requestedOperation) throw new Error('一个 JEV 表达式只能指定一个操作；串行批量请用 JEVArgs 的数字后缀字段。');
                requestedOperation = match ? match[1].trim() : standalone.id;
            } else remaining.push(constraint);
        }
        let operation = requestedOperation && tool.commands.find(c => normalize(c.id) === normalize(requestedOperation)
            || (actions[c.id]?.verbs || []).some(verb => normalize(verb) === normalize(requestedOperation)));
        if (requestedOperation && !operation) throw new Error(`${tool.name} 没有能力 "${requestedOperation}"，请查询 {工具目录}。`);
        // Natural-language action routing sees only the sentence, never code or
        // quoted file contents. Exact JSON takes priority over inferred actions.
        if (!operation && explicit === null) {
            const matches = Object.entries(actions).filter(([, action]) => (action.verbs || []).some(verb => parsed.intentText.includes(verb)));
            if (matches.length > 1) throw new Error('JEV 检测到多个动作，请拆成多个调用或提供明确的串行批量参数。');
            if (matches.length === 1) operation = tool.commands.find(c => c.id === matches[0][0]);
        }
        const action = operation ? (actions[operation.id] || {}) : profile;
        if (explicit !== null) {
            if (parsed.primary.length || remaining.length) {
                throw new Error('JEVArgs 是完整插件参数；请将【主要内容】和附加约束一并放入 JSON，避免漏传或冲突。');
            }
            if (requestedOperation) {
                if (!Object.keys(operation.fixedArgs).length) throw new Error(`${operation.id} 是能力标识，请在 JEVArgs 中提供真实 command/action，不要用 [操作:] 猜测。`);
                for (const [key, value] of Object.entries(operation.fixedArgs)) {
                    if (Object.keys(explicit).some(k => new RegExp(`^${key}\\d+$`).test(k))) throw new Error('显式单操作不能与数字后缀批量操作混用。');
                    if (explicit[key] !== undefined && explicit[key] !== value) throw new Error(`JEV 操作与 JEVArgs.${key} 冲突。`);
                }
            }
            const result = { ...(requestedOperation ? operation.fixedArgs : {}), ...explicit };
            validateMemoArgs(tool.name, result, inheritedArgs);
            return tool.name === 'PowerShellExecutor' ? normalizeTerminalBooleans(result) : result;
        }
        if (!operation && profile.actions) throw new Error(`请为 ${tool.name} 指定 [操作:命令]，或查询 {工具目录} 后提供 JEVArgs。`);
        if (!operation && !PROFILES[tool.name]) throw new Error(`${tool.name} 已接入 JEV；请查询 {工具目录} 后通过 JEVArgs 提供精确参数。`);

        const args = { ...(profile.fixed || {}), ...(operation?.fixedArgs || {}) };
        if (operation && !Object.keys(args).length) {
            // Some manifest examples contain only numbered commands (e.g. wait).
            // Only curated profiles may supply the explicit, known command here.
            if (actions[operation.id]) args.command = operation.id;
            else throw new Error(`${operation.id} 需要 JEVArgs 精确参数。`);
        }
        const fields = new Set([...(profile.fields || []), ...(operation ? operation.fields : tool.commands.flatMap(c => c.fields))]);
        const aliases = { ...PARAMETER_ALIASES, ...profile.aliases };
        const positional = [];
        for (const constraint of remaining) {
            const match = constraint.match(/^([^:：]+)[:：]([\s\S]*)$/);
            const key = match && (aliases[match[1].trim()] || match[1].trim());
            if (match && (fields.has(key) || (action.required || []).includes(key))) {
                if (CONTROL_KEYS.has(key.toLowerCase()) || FORBIDDEN_KEYS.has(key)) throw new Error(`不允许参数 ${key}。`);
                if (args[key] !== undefined && args[key] !== match[2]) throw new Error(`JEV 参数 ${key} 重复或冲突。`);
                args[key] = match[2];
            } else positional.push(constraint);
        }
        let primaryField = action.primary;
        if (tool.name === 'MediaRenderer' && operation?.id === 'RenderImage') {
            if (/^\s*<svg\b/i.test(parsed.primary[0] || '')) primaryField = 'svg';
            for (let i = positional.length - 1; i >= 0; i--) {
                const size = positional[i].match(/^(\d+)\s*[x×]\s*(\d+)$/);
                if (size) { args.width = size[1]; args.height = size[2]; positional.splice(i, 1); }
            }
        }
        if (parsed.primary.length && primaryField) {
            if (args[primaryField] !== undefined) throw new Error(`JEV 主负载与参数 ${primaryField} 重复。`);
            args[primaryField] = parsed.primary.join('\n');
        } else if (parsed.primary.length) {
            throw new Error(`该操作的主要参数无法自动确定，请通过 JEVArgs 明确传递。`);
        }
        const slots = action.slots || (primaryField && args[primaryField] === undefined ? [primaryField] : []);
        for (const key of slots) {
            if (positional.length && args[key] === undefined) args[key] = positional.shift();
        }
        if (positional.length) throw new Error(`无法识别约束 [${positional[0]}]，请用 [参数名:值] 或 JEVArgs。`);
        for (const key of action.required || []) {
            const value = key === 'maid' ? (inheritedArgs.maid || inheritedArgs.valet) : args[key];
            if (value === undefined || value === null || value === '') throw new Error(`${tool.name} 缺少必填参数 ${key}。`);
        }
        if (tool.name === 'MediaRenderer' && operation?.id === 'RenderImage' && !args.html && !args.svg) throw new Error('MediaRenderer 需要 HTML 或 SVG 源码。');
        if (tool.name === 'ServerPowerShellExecutor') {
            args.executionType ??= 'blocking';
            if (!['blocking', 'background'].includes(args.executionType)) throw new Error('executionType 只能为 blocking/background。');
        }
        if (tool.name === 'PowerShellExecutor' && args.returnMode && !['delta', 'full'].includes(args.returnMode)) throw new Error('returnMode 只能为 delta/full。');
        validateMemoArgs(tool.name, args, inheritedArgs);
        return tool.name === 'PowerShellExecutor' ? normalizeTerminalBooleans(args) : args;
    }
}

module.exports = { JevToolCatalog, readExplicitArgs };

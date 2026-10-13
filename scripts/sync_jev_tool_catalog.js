'use strict';

// Explicit migration/sync command. The running server never discovers or enables
// new semantic tools on its own. Input is a sanitized, authenticated inventory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser');

const ROOT = path.join(__dirname, '..');
const CATEGORIES = {
    web_search: { label: '联网搜索', aliases: ['搜索'], plugins: 'VSearch TavilySearch AnySearch DoubaoSearch FathomSearch BilibiliFetch UrlFetch BrowserSearch FlashDeepSearch WebSearchHub DigitalOracle ParallelSearch' },
    image_generation: { label: '图片生成', aliases: ['生图'], plugins: 'NanoBananaGen2 GPTImageGen ZImageTurboGen DoubaoGen DMXDoubaoGen AgnesGen FluxGen GeminiImageGen QwenImageGen' },
    daily_tools: { label: '日用工具', aliases: ['日常工具'], plugins: 'ScheduleManager VCPAlarm SciCalculator VCPSleep TableLampRemote TarotDivination SuperDice BladeGame' },
    file_tools: { label: '文件管理', aliases: ['文件系统', '文件工具', '系统命令'], plugins: 'ServerFileOperator FileOperator ServerSearchController LocalSearchController ServerPowerShellExecutor PowerShellExecutor OldPowerShellExecutor PTYShellExecutor LinuxShellExecutor ServerPluginSourceViewer PluginSourceViewer VirusTotalAnalyzer ChatTencentcos' },
    code_tools: { label: '代码仓库', aliases: ['代码工具', '代码检索', '仓库管理'], plugins: 'CodeSearcher ServerCodeSearcher DeepWikiVCP GitSearch GitOperator FirecrawlDevSearch AICodeWorker' },
    browser_tools: { label: '浏览器', aliases: ['浏览器控制', '浏览器工具', 'Loom应用', '桌面控制'], plugins: 'ChromeBridge LoomController ScreenPilot DesktopRemote' },
    memory_tools: { label: '记忆管理', aliases: ['记忆工具', '记忆检索', '日记管理'], plugins: 'LightMemo DeepMemo TopicMemo DailyNote DailyNoteManager DailyNoteSearcher ThoughtClusterManager SemanticGroupEditor AgentDream' },
    media_tools: { label: '媒体处理', aliases: ['多媒体', '媒体工具', '媒体渲染'], plugins: 'MediaRenderer MusicController Music163VCP ChartController AgnesVideoGen Wan2.1VideoGen ArtistMatcher MediaShot MimoDubbing' },
    communication_tools: { label: '通讯协作', aliases: ['通讯工具', '通讯论坛', '消息通知'], plugins: 'AgentAssistant AgentMessage MagiAgent TopicSponsor PromptSponsor WaitingForUrReply VCPForum VCPForumOnline ZhiChaiForum VCPClawMail ScriptoriumCollaborator' },
    system_tools: { label: '系统管理', aliases: ['插件管理', '工具记录'], plugins: 'PluginManager VCPToolBridge TimedTaskQuery ToolCallRecordQuery PlaceholderExplorerCommand OpenHerPersona' }
};

function categoryFor(name) {
    return Object.entries(CATEGORIES).find(([, c]) => c.plugins.split(' ').includes(name))?.[0];
}

function compactDescription(text) {
    return String(text || '').replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '').trim();
}

function buildCatalog(inventory) {
    const tools = {};
    const excluded = [];
    for (const plugin of [...inventory].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const invocations = plugin.capabilities?.invocationCommands || [];
        if (!plugin.enabled || !invocations.length) {
            excluded.push({ name: plugin.name, reason: !plugin.enabled ? 'disabled' : 'no_invocation_commands' });
            continue;
        }
        const category = categoryFor(plugin.name);
        if (!category) throw new Error(`Assign an explicit JEV category before adding ${plugin.name}.`);
        const commands = invocations.map((entry, index) => {
            const id = entry.commandIdentifier || entry.command || entry.name || `capability_${index + 1}`;
            const source = [entry.description, entry.example].filter(Boolean).join('\n');
            const examples = ToolCallParser.parse(source).map(call => call.args);
            const selectors = new Map();
            for (const args of examples) {
                for (const field of ['command', 'action']) {
                    if (args[field]) selectors.set(`${field}:${args[field]}`, { [field]: args[field] });
                }
            }
            // A commandIdentifier is often a documentation label, not a command.
            // Only use selectors actually shown in the native invocation contract.
            const normalize = value => String(value).toLowerCase().replace(/[_\s-]/g, '');
            const matching = [...selectors.values()].filter(selector => Object.values(selector).some(value => normalize(value) === normalize(id)));
            const fixedArgs = matching.length === 1 ? matching[0] : {};
            const fields = new Set();
            for (const args of examples) for (const key of Object.keys(args)) fields.add(key);
            for (const match of source.matchAll(/(?:^|\n)\s*[-*]\s*`?([A-Za-z_][\w]*)`?\s*(?:[（(:：])/g)) fields.add(match[1]);
            return {
                id,
                fixedArgs,
                fields: [...fields].filter(key => !['maid', 'valet', 'tool_password', 'timely_contact'].includes(key)),
                description: compactDescription(entry.description)
            };
        });
        tools[plugin.name] = {
            category,
            distributed: plugin.distributed === true,
            pluginType: plugin.pluginType,
            requiresAdmin: plugin.requiresAdmin === true,
            description: compactDescription(plugin.description),
            manifestHash: crypto.createHash('sha256').update(JSON.stringify(invocations)).digest('hex'),
            commands
        };
    }
    return {
        version: 1,
        categories: Object.fromEntries(Object.entries(CATEGORIES).map(([key, { label, aliases }]) => [key, { label, aliases }])),
        tools,
        excluded
    };
}

if (require.main === module) {
    const index = process.argv.indexOf('--snapshot');
    if (index < 0 || !process.argv[index + 1]) {
        throw new Error('Usage: node scripts/sync_jev_tool_catalog.js --snapshot <sanitized-plugin-inventory.json>');
    }
    const inventory = JSON.parse(fs.readFileSync(path.resolve(process.argv[index + 1]), 'utf8'));
    const catalog = buildCatalog(inventory);
    const target = path.join(ROOT, 'ToolConfigs', 'jev_tool_catalog.json');
    fs.writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n');
    console.log(JSON.stringify({ target, plugins: Object.keys(catalog.tools).length, capabilities: Object.values(catalog.tools).reduce((n, t) => n + t.commands.length, 0) }));
}

module.exports = { buildCatalog, CATEGORIES };

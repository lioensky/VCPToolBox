import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { local } from './store.mjs';

// Shown once per browser before the workspace is used, and any time from the top bar.
// Bump the version when the wording changes materially, so every user sees it again.
const VERSION = 'vtrade-notice-2';
export const DISCLAIMER = Object.freeze([
    ['一、模拟性质', [
        '本模块仅供学习与模拟研究使用，账户资金均为虚拟资金。本模块未接入任何证券公司或交易所的交易系统，不产生真实委托，不涉及用户任何真实资金。',
        '本模块所称“虚拟成交”，系依据预设规则在本地生成的模拟记账结果，不代表任何真实撮合。',
    ]],
    ['二、模拟结果的局限', [
        '模拟结算以日线数据为准，所用价格为事后已知价格，无法反映真实市场中的流动性、委托排队、盘中滑点及成交先后，亦未完整处理分红送转、停牌复牌等事项。',
        '模拟及回测收益不代表真实交易可实现的收益，亦不预示未来表现。依据历史数据调校的规则与参数，其模拟结果存在高估的可能。',
    ]],
    ['三、行情数据', [
        '行情数据由用户自行准备。本模块不对数据的准确性、完整性及时效性作任何保证；如有差异，以交易所及数据提供方正式发布的数据为准。',
        '数据的使用及分发权限由用户向数据提供方自行确认。请勿将真实行情、持仓或运行记录提交至公开代码仓库。',
    ]],
    ['四、AI 与分析结果', [
        'AI 生成的计划与复盘，以及指标、信号与公式的计算结果，仅为本次模拟实验的记录，不构成任何投资建议，不构成对任何证券的推荐，亦不构成收益承诺。',
        '请勿使用本模块向他人提供证券投资建议或代为操作；相关业务依法须取得相应资质。',
    ]],
    ['五、风险提示', ['理财有风险，投资需谨慎。用户进行真实投资时应独立判断，并自行承担相应风险。']],
]);
export const DATA_GUIDE = Object.freeze([
    ['一、通达信日线（推荐，离线）', [
        '在通达信客户端使用“盘后数据下载”功能下载日线数据（多数版本位于“系统”或“选项”菜单）；当日数据请于收盘后下载。',
        '日线文件位于安装目录的 vipdoc 下：上海为 sh/lday，深圳为 sz/lday，北京为 bj/lday，每只证券对应一个 .day 文件。',
        '看盘：在“设置 → 数据 → 看盘数据目录”中填写 vipdoc 目录，即可浏览全部股票、指数与基金；证券名称与拼音简称取自同级 T0002/hq_cache 中的名称文件。',
        '模拟交易：在“设置 → 数据”中添加本机来源并列出所需证券，或由管理员在来源配置文件中列出（模板见 sources.example.json），随后执行“同步”，或由 AI 调用 SyncSource。模拟交易来源仅读取所列文件。',
    ]],
    ['二、公开接口下载（AKShare、baostock）', [
        '在用户自己的 Python 环境中安装 AKShare 或 baostock，运行插件附带的 scripts/vtrade_download.py，即可下载不复权日线及含公告日期的财务摘要，并生成标准 JSON 文件。',
        '日线 JSON 作为 json 来源接入；财务 JSON 配置给 financials 工具，AI 仅能读取模拟日之前已公告的报告期。',
    ]],
    ['三、自有数据', [
        '如数据来自 CSV、数据库或其他接口，可编写一个 market 插槽实现，将其转换为标准日线（价格单位为分，成交量单位为股，不复权）。示例见 SLOTS.md 与 examples/extensions.cjs。',
    ]],
    ['四、注意事项', [
        '仅使用不复权日线。前复权或后复权数据不得混入同一来源。',
        '腾讯分时为可选适配器，所用接口未公开，仅供个人学习，默认不启用。',
        '开源接口库的许可不等同于行情数据的再分发许可，使用前请向数据提供方确认。',
    ]],
]);

function render(sections) {
    const wrap = document.createElement('div');
    wrap.className = 'ws-notice';
    for (const [title, lines] of sections) {
        const section = document.createElement('section'), heading = document.createElement('h3'), list = document.createElement('ul');
        heading.textContent = title;
        for (const line of lines) { const item = document.createElement('li'); item.textContent = line; list.append(item); }
        section.append(heading, list); wrap.append(section);
    }
    return wrap;
}
export function dataGuide() { return render(DATA_GUIDE); }

// tab: 'disclaimer' | 'data'. Resolves after the dialog closes.
export function openNotice({ tab = 'disclaimer', firstRun = false } = {}) {
    return new Promise(resolve => {
        const body = document.createElement('div'), view = document.createElement('div');
        const tabs = VCPUI.create('Tabs', { items: [{ value: 'disclaimer', label: '免责声明' }, { value: 'data', label: '获取数据' }], value: tab });
        const show = value => view.replaceChildren(render(value === 'data' ? DATA_GUIDE : DISCLAIMER));
        tabs.element.addEventListener('change', () => show(tabs.element.querySelector('[aria-selected="true"]')?.dataset.value));
        body.append(tabs.element, view); show(tab);
        const accept = VCPUI.create('Button', { label: firstRun ? '已阅读并知悉' : '关闭', variant: 'primary', size: 'sm' });
        const modal = VCPUI.create('Modal', { title: firstRun ? '使用须知' : 'VTrade 说明', size: 'lg', content: body, actions: [accept],
            closeOnBackdrop: !firstRun, dismissible: !firstRun, onClose: () => { tabs.destroy(); resolve(); } });
        accept.element.addEventListener('click', () => { if (firstRun) local.set(VERSION, new Date().toISOString()); modal.close(true); });
        document.body.append(modal.element);
    });
}
export const needsNotice = () => !local.get(VERSION, null);

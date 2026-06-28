# AdminPanel Visual Design Notes

本文记录 `C:\VCP\Eric\new-api\web\default` 新版界面的视觉规范研究结论, 用于后续 VCPToolBox AdminPanel 的原生 Vue/CSS 改造。目标是参考 new-api 的视觉语言, 但不引入 React、Tailwind、shadcn 或 Base UI 技术栈。

## 设计方向

new-api 新版的核心不是装饰性强的界面, 而是紧凑、清晰、强对齐的后台工作台:

- 页面第一屏直接是可操作界面, 不做 hero 化展示。
- 控件高度、图标尺寸、表单间距非常稳定。
- 使用完整语义 token 驱动主题, 主题不只改变按钮主色, 也影响卡片、输入框、边框、侧栏和表格表面。
- 工具栏和筛选区尽量不额外包卡片, 依靠空白、边框和相邻内容建立层级。
- 卡片边界较轻, 更像结构容器, 不像视觉装饰块。

## Token 体系

new-api 的 token 分三层:

1. 基础语义 token: `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-*`。
2. 预设主题: 通过 `body[data-theme-preset]` 改写颜色, 每个预设同时提供 light/dark 值。
3. 视觉轴: `data-theme-radius`, `data-theme-scale`, `data-theme-font`, `data-theme-content-layout` 独立控制圆角、密度、字体和内容宽度。

对本项目的翻译建议:

- 继续使用项目现有 token, 不直接搬 shadcn token。
- 可以保留语义别名层, 但组件实现必须落到项目原生 token: `--primary-text`, `--secondary-text`, `--button-bg`, `--accent-bg`, `--input-bg`, `--border-color`, `--highlight-text`。
- 主题预设要影响 surface: 卡片、弹层、输入框、边框、侧栏、hover 底色都应随主色轻微派生, 否则切主题时只会看到按钮变色。
- 圆角和密度应独立于颜色预设, 用户选择优先级高于预设默认值。

## 颜色与主题色使用

new-api 的颜色策略不是"主题色铺满页面", 而是先建立稳定的中性 surface, 再把主题色用于少数需要表达状态的地方:

- 页面主背景、卡片、表单容器主要使用 `background/card/muted/border` 这类中性 token。
- 主题色主要用于 primary button、focus ring、选中态、当前导航项、少量强调 icon 和关键状态。
- 表单项本身尽量无色: label、description、input/select/textarea 放在同一个中性面里, 不额外给每一组字段铺明显背景。
- `SettingsSection` 只是标题 + 内容流, 不自带底色。
- `SettingsCard` 是轻量结构容器: `bg-card` 或透明中性面 + 细 ring/border, 不应像大色块。
- `SettingsControlGroup` 这类父子控制组可以使用极淡 `muted` 底色和左侧缩进线, 用于表达隶属关系, 不是为了装饰。
- hover/active 使用 muted/accent 的轻变化, 避免强饱和主题色大面积闪烁。
- 危险操作使用独立 danger token, 不和普通主题色混用。

对本项目的翻译建议:

- 后续复杂设置页优先采用"无色表单"方向: 让字段直接落在白色/透明主面板上, 通过间距、标题、细线和控件边框建立层级。
- 主题色在 AdminPanel 中应优先出现在按钮、焦点、选中列表项、badge 状态和 icon 强调上, 不要给普通设置区铺整块主题色。
- `UiSettingsCard` 在设置页里可以有 `plain/transparent` 使用方式: 背景透明, 只保留轻边框和可选 header divider。
- `UiSettingsGroup` 的默认底色要非常轻, 接近 `color-mix(primary-text 2-3%, transparent)` 或项目等价 token。
- 摘要块、预览结果行、代码标签等辅助信息可用极淡中性色, 不要使用 `secondary-bg/tertiary-bg` 形成一层套一层的灰色块。
- 页面级主白色面板已经提供了最外层 surface 时, 内部设置块就不应再有明显底色, 否则会显得厚重。

new-api 概览页补充观察:

- 可读性不是靠给表单项铺主题色, 而是靠 `border + bg-card + bg-muted/40` 形成稳定结构。
- 一级面板通常有完整边框、轻 shadow 和清楚的 header/content 分区; 二级信息块使用极淡 muted 背景。
- 主题色只出现在 active tab、focus、主按钮、状态点、关键数值或轻量图表中。
- 当页面做"无色表单"后如果发糊, 优先加实中性边框和浅中性底, 不要先把普通字段染成主题色。
- 输入框可以保持克制, 但需要有足够明确的边框和轻微 surface, 否则在白底大面板上会缺少点击目标感。

## 尺寸基准

new-api 的工作台密度基准:

| 元素 | 默认 | 小号 | 大号 |
| --- | --- | --- | --- |
| Button | 32px | 28px / 24px | 36px |
| Icon button | 32px | 28px / 24px | 36px |
| Input | 32px | - | - |
| Select trigger | 32px | 28px | - |
| Textarea | min-height 64px | - | max-height 384px |
| Switch | 32 x 18.4px | 24 x 14px | - |
| Checkbox | 16 x 16px | - | - |
| Badge | 20px | - | - |
| Sidebar item | 32px | 28px | 48px |
| Table header | 40px | - | - |
| Table cell | 8px padding | - | - |

对本项目的翻译建议:

- 新原语默认高度保持 32px。
- 页头主操作按钮可用 36px, 普通表单操作和列表操作仍用 32px 或 28px。
- 图标默认 16px, `sm` 可用 14px, 不要在同一按钮组里混用 18px/20px。
- 触控热区可以通过伪元素扩大, 但视觉盒子不要被撑大。

## 按钮

new-api Button 规范:

- 默认高度 32px, `sm` 28px, `xs` 24px, `lg` 36px。
- 默认图标 16px, `sm` 14px, `xs` 12px。
- 变体包括 primary/default、outline、secondary、ghost、destructive、link。
- outline 按钮是背景透明 + border, hover 进入 muted/accent 背景。
- destructive 不使用满红底, 更常见是浅红底 + 红字。
- active 有轻微 `translate-y` 压下感。
- disabled 使用 opacity 0.5 并禁用 pointer event。

对本项目的翻译建议:

- `UiButton` 保持 `primary / secondary / outline / ghost / danger / link`。
- `danger` 优先做浅危险底色, 除非是强确认动作。
- 标题区右侧的主要操作用 `size="lg"`, 表格行内操作用 `sm`。
- 图标按钮继续归 `UiIconButton`, 文本按钮不要再新增 icon-only 变体。

## 输入框与文本域

new-api Input 规范:

- 高度 32px。
- 圆角 `rounded-lg`, 但受全局 `--radius` 缩放。
- 背景透明或 input token, 暗色下使用 `input/30`。
- padding 横向约 10px, 纵向约 4px。
- placeholder 使用 muted foreground。
- focus 同时改 border 和 ring。
- invalid 使用 destructive border + ring。
- disabled 使用 opacity 0.5, 暗色下 disabled 背景更明显。

Textarea 规范:

- 最小高度 64px。
- 横向 padding 10px, 纵向 padding 8px。
- 内容可滚动, 最大高度约 384px。

对本项目的翻译建议:

- `UiInput` 默认高度 32px, padding `0 10px`。
- `UiTextarea` 默认 min-height 可从 64px 起, 复杂配置页可按 rows 增长。
- 需要补齐 `invalid`、`description`、`error` 的统一展示, 最好通过 `UiField` 完成。

## Select

new-api Select 规范:

- Trigger 默认 32px, sm 28px。
- trigger 内部 `display:flex`, 左侧 value, 右侧 chevron。
- 弹层最小宽度约 144px, 宽度默认跟随触发器。
- 弹层圆角约 8px, ring 1px, shadow 较轻。
- 选项行是 28-32px 的紧凑行高, 左右 padding 小, 右侧 tick 标记选中。

对本项目的翻译建议:

- 应新增 `UiSelect` 或至少统一 native select 样式。
- 当前页面中 native select 和 `UiInput` 容易高度/圆角不一致, 这是原语体系断点。
- 短期可先实现 native select 包装; 长期再考虑自定义弹层。

## 表单结构

new-api Field 规范:

- `FieldGroup` 纵向间距默认 20px。
- `Field` 内 label 与控件间距约 8px。
- label: 14px, medium, leading-snug。
- description: muted, 14px, normal weight。
- error: destructive, 14px。
- `FieldSeparator` 是 1px 细线, 可带居中文案。
- 支持 vertical、horizontal、responsive 三种布局。

对本项目的翻译建议:

- 下一步最值得补的是 `UiField`, 收敛 label/description/error/spacing。
- 页面不应在每个 view 里重复写 `.field`、`.field-hint`、`.form-grid` 的细节。
- 表单分组比按钮本身更决定页面是否像 new-api。

## 卡片

new-api Card 规范:

- `bg-card`, `text-card-foreground`, 轻 ring 或 border。
- 默认圆角 `rounded-xl`, padding 16px, 内部 gap 16px。
- `size="sm"` 时 padding 12px, gap 12px。
- Header 是 grid: 左标题/描述, 右 action。
- 有 description 时 action 跨两行并贴右上。
- Footer 使用 `bg-muted/50`, border-top, padding 16px。
- 卡片不用于包裹整页 section, 主要用于重复项、配置块、弹层内容、列表项卡片视图。

对本项目的翻译建议:

- `UiCard` 应支持 `header / content / footer / action / description` 的稳定结构。
- 避免卡片套卡片; 页面 section 用普通布局, 具体配置块再用卡片。
- `divided` 应是轻分割线, 不应让卡片显得厚重。

## 开关

new-api Switch 规范:

- 默认尺寸 `32 x 18.4px`, 小号 `24 x 14px`。
- thumb 默认 16px, 小号 12px。
- checked 使用 primary 背景。
- unchecked 使用 input 背景, 暗色下略亮。
- focus 使用 ring。
- 通过 `after:-inset-x-3 after:-inset-y-2` 扩大点击区域, 视觉尺寸不变。

对本项目的翻译建议:

- 当前开关如果看起来变形, 应优先锁定 track 宽高和 thumb 尺寸。
- 总开关适合放在 summary/status 区, 不应塞进表单字段流导致上下间距怪。
- 开关旁的文字要垂直居中, 用 flex row + align center。

## 复选框

new-api Checkbox 规范:

- 尺寸 `16 x 16px`。
- 圆角较小, `rounded-sm`。
- checked 使用 primary 背景、primary foreground 图标。
- tick 图标约 14px。
- 同样通过伪元素扩大点击区域。
- disabled opacity 0.5。

对本项目的翻译建议:

- `AppCheckbox` 可继续保留, 但需要确认尺寸、checked 颜色和 label 行高与新原语一致。
- checkbox 列表项的主文字和说明文字应交给 `UiField` 或专用 `CheckField` 处理。

## Badge 与状态标签

new-api Badge 规范:

- 高度 20px。
- 圆角很大, pill 形。
- 横向 padding 8px。
- 字号 12px, medium。
- 变体: default、secondary、destructive、outline、ghost、link。
- 图标约 12px。

对本项目的翻译建议:

- 状态标签不要用普通按钮伪装。
- 成功/警告/危险/信息状态应映射项目 status token。
- Badge 应保持小而稳, 避免和按钮抢层级。

## 表格与列表

new-api Table 规范:

- 外层容器 `overflow-hidden rounded-lg border`。
- 表格文字 14px, 数字使用 tabular-nums。
- 表头高度 40px, padding x 8px, medium。
- 单元格 padding 8px, 垂直居中。
- 行 hover 使用 muted/background 混合色, 不是强色块。
- selected 行使用 muted。
- 最后一行通常无底边框。
- 大表格使用固定 header, 内容区内部滚动。

重复配置项补充观察:

- 对模型映射、用户组倍率、特殊规则这类重复数据, new-api 通常把"列表扫描"和"详情编辑"分开。
- 少字段重复项可直接做紧凑行: 左右输入框 + 行内操作, 不给每行包完整表单卡。
- 多字段重复项适合用"摘要行 + 详情区": 摘要行放名称、状态、数量、常用操作; 详情区再放完整字段。
- 很复杂或数量多的重复项用 collapsible/accordion, 默认只展示可识别摘要, 展开后编辑。
- 行内操作按钮保持 `sm` 或 icon button, 删除等低频危险动作不要抢主操作层级。

对本项目的翻译建议:

- 后续可以补 `UiTable` 或 `DataTable` 结构, 但不要先迁移高风险表格页。
- 列表页工具栏不应包卡片; 工具栏和表格容器之间留 10-12px 即可。
- 行内操作用 `sm` 按钮或 icon button, 避免大按钮撑高行。
- 语义路由项这类"名称/模型/开关/描述"重复结构, 应优先做紧凑规则头 + 描述详情区, 避免每条路由纵向堆成一张完整设置表单。

## 工具栏与搜索

new-api Toolbar 规范:

- 搜索、筛选 chip、额外输入和操作按钮在同一 flex-wrap 行。
- gap 默认 8px, 桌面可到 12px。
- 右侧 action cluster 使用 `margin-left:auto`。
- 搜索输入宽度: 小屏 full, 桌面约 200-240px。
- reset 在实时筛选模式下用 ghost + X, 在表单提交模式下用 outline。
- 不额外包 panel, 不加背景块。

顶部搜索规范:

- 使用 outline button 伪装搜索入口。
- 高度 32px。
- 背景 `muted/25`, hover 到 accent。
- 左侧 search icon 16px, 右侧 kbd 高 20px。
- kbd 常态可见, hover 仅轻微变背景。

对本项目的翻译建议:

- 我们之前搜索栏优化方向与 new-api 一致: 常态显示 Ctrl+K、白色/主文字态稳定、hover 只是轻变化。
- 筛选行文字上下不居中时, 优先统一行高、按钮高度和 `align-items:center`。

## 侧栏

new-api Sidebar 规范:

- 展开宽度 `13rem`。
- 移动端宽度 `17rem`。
- 折叠图标栏宽度 `2.75rem`。
- header/footer padding 8px, gap 8px。
- group padding 8px。
- group label 高 32px, 字号 12px 或 11px uppercase, muted。
- menu item 默认高 32px, padding 8px, gap 8px, 图标 16px。
- menu item sm 高 28px, lg 高 48px。
- 子菜单带左边框, 子项高 28px。
- 折叠态不是重新布局图标, 而是固定图标盒宽, 隐藏文字。
- 折叠态子菜单通过 dropdown/tooltip 访问, 避免空白。

对本项目的翻译建议:

- 折叠侧栏时图标位置必须锁定, 只收起右侧文字。
- 最近访问和搜索图标在折叠态仍应保留, 否则侧栏上半区会空。
- VCPToolBox logo/文字应和列表项左边缘对齐, 不要用单独魔法偏移。

## 页面布局

new-api SectionPageLayout 规范:

- 标题区移动端 padding: `12px 12px 10px`。
- 标题区桌面 padding: `20px 16px 12px`。
- 标题字号 16px, 桌面 18px, bold。
- 标题与 action 同行, flex-wrap, gap x 12-16px, gap y 8px。
- 内容区 padding: 横向 12/16px, 顶部 4-6px, 底部 12/16px。
- 固定 footer 可用于分页或保存栏, 背景跟随 background, border-top。

对本项目的翻译建议:

- 管理页面头部应更像工作台标题, 不要做大标题大留白。
- 页面主间距建议统一到 12/16/20px 阶梯。
- 标题右侧按钮如果是主动作, 使用 36px; 表单内部操作保持 28/32px。

## 复杂设置页信息架构

new-api 的设置页不是把所有控件平铺到一个页面里, 而是建立了一套稳定的信息层级:

1. `SettingsPage`: 页面框架, 负责标题、右上角动作、未保存状态和内容区域。
2. `SettingsSection`: 业务分区, 一个 section 只讲一类事情, 如认证、安全、日志、侧栏模块、计费。
3. `SettingsCard`: 配置卡片, 用标题和说明先解释这组设置的目的, 再放具体表单。
4. `SettingsForm / SettingsFormGrid`: 表单网格, 普通输入项两列排布, 复杂项自动占满整行。
5. `SettingsSwitchItem`: 开关行, 左侧标题 + 说明, 右侧开关, 整行高度和垂直居中固定。
6. `SettingsControlGroup`: 父子控制组, 用浅底色容器和左侧缩进线表达"启用此项后, 下方子设置才有意义"。
7. `FormDirtyIndicator / NavigationGuard`: 未保存状态显示在标题附近, 离开页面时统一提醒。

这套结构解决的不是控件美观问题, 而是复杂配置页的信息架构问题:

- 开关、输入框、危险操作和说明文字不再混在同一级。
- 父开关与子配置有明确视觉隶属关系。
- 保存、重置、未保存状态有统一位置, 不由每个页面临时摆放。
- 常用配置、危险操作、高级配置可以用 section/card/group 拉开层级。
- 页面不会因为功能多就不断增加卡片套卡片。

对本项目的翻译建议:

- 优先补一层"设置页原语", 而不是继续只补 Button/Input。
- `UiField`: 统一 label、description、error、required、help text 和字段间距。
- `UiSettingsForm`: 统一两列表单网格, 普通项两列, textarea/select-list/switch 自动占满整行。
- `UiSettingsSwitchRow`: 专门承载开关设置, 左侧标题说明, 右侧开关。
- `UiSettingsGroup`: 承载父开关 + 子配置, 使用浅底、细边框、左侧缩进线, 避免卡片套卡片。
- `UiPageActions / DirtyIndicator`: 保存、重置、未保存状态统一放到页头动作区。

当前已落地的设置页原语:

- `UiSettingsCard`: 配置卡片, 默认带 divided header, 用于承载一个明确设置分区。
- `UiSettingsForm`: 两列/单列表单网格, 复杂项自动占满整行。
- `UiSettingsGroup`: 父子控制组和参数组, 可使用 inset 表达从属关系。
- `UiSettingsSwitchRow`: 独立开关行, 避免开关和普通输入混排。
- `UiDangerZone`: 危险操作区, 用于删除、重置、清空等不可逆动作。
- `UiPageActions`: 页头动作容器, 承载保存、刷新、未保存提示。

适合本项目的页面拆分节奏:

1. 先补设置页原语, 不大规模动业务逻辑。
2. 继续以 `SemanticModelRouterEditor` 作为试验田, 从"控件换新"升级到"设置页结构换新"。
3. 将总开关和关键状态放入顶部 summary/status 区。
4. 让左侧预设列表只承担导航和选择职责, 不承载太多全局设置。
5. 将自动模型名、默认预设、全局阈值等放入独立设置组。
6. 将每个预设详情放入另一组设置卡片。
7. 路由项作为重复列表, 用小卡片或表格化列表呈现。
8. 高级参数放入"高级设置"组或折叠区。
9. 等试验页稳定后, 再迁移低风险配置页, 如基础配置、插件配置局部、主题编辑器局部。

`SemanticModelRouterEditor` 当前试点结论:

- 全局路由设置从左侧预设列表中拆出, 让左侧只负责导航/选择。
- 页面顶部 summary 只放启用状态、自动模型、预设数量、上游模型数量等摘要, 不承载细项编辑。
- 预设数量较少但单个预设设置很多时, 不使用内容区左侧栏; 参考 new-api 的 OAuth/Ratio 设置, 改用顶部横向 tabs/chips, 让编辑区占满宽度。
- 预设编辑、匹配预览、危险删除分别进入独立区域, 避免普通表单、验证结果和危险操作混在同一层。
- 颜色上采用 new-api 的"无色表单"方向: 设置容器背景透明或极淡中性, 只保留细边框和 header 分割线。
- `UiSettingsGroup` 只用极淡 muted 面和左侧缩进线表达从属参数组, 不再使用明显灰底/色块。
- 主题色只保留在按钮、焦点、选中态和状态提示里, 不给"全局路由设置"整块铺色。
- 这套做法适合作为后续复杂配置页试点模板, 但先不要全局改 `UiCard`; 先在页面级别用局部 class 验证视觉方向。

复杂配置页的最终落地节奏可以再收敛为五层, 用来判断页面是否清楚:

1. 状态总览层: 只放启用状态、关键数量、当前默认值、未保存提示等摘要, 不承载复杂编辑。
2. 导航选择层: 左侧列表/分段控件只负责切换对象, 例如预设列表、配置分组列表、插件列表。
3. 核心编辑层: 当前选中对象的主要字段, 使用 `UiField + UiSettingsForm` 两列排布。
4. 重复项层: 路由、规则、模型链、工具项等重复对象, 用列表卡片或表格, 不混进普通字段网格。
5. 反馈验证层: 预览、测试、匹配结果、错误提示放在编辑流之后或右侧, 用表格/alert/badge 表达结果。

判断是否需要继续拆层的信号:

- 一个表单区同时出现全局设置、当前对象设置和重复项编辑, 说明层级混了。
- 一个标题右侧超过 3 个主要按钮, 应拆成 action group 或把低频操作放入更多菜单。
- 开关控制下方一组字段时, 应使用 `UiSettingsGroup` 或控制组缩进, 而不是普通 field 平铺。
- 列表项既负责选择又负责编辑大量字段时, 应拆成"左侧导航 + 右侧详情"。
- 结果表格和编辑表单混在一个卡片里时, 应拆成独立的预览/验证区。

设置项复杂度分级:

| 类型 | 推荐呈现 | 说明 |
| --- | --- | --- |
| 单个短文本/数字 | `UiField + UiInput` | 可进入两列网格 |
| 长文本/JSON/Prompt | `UiField + UiTextarea` | 占满整行 |
| 单个开关 | `UiSettingsSwitchRow` | 左说明右开关, 占满整行 |
| 父开关 + 子设置 | `UiSettingsGroup` | 子设置缩进, 禁用态跟随父开关 |
| 重复条目 | 小 `UiCard` 或 `UiTable` | 不要混进普通表单网格 |
| 危险操作 | 独立 danger zone | 使用说明 + destructive 按钮 + confirm |
| 高级/低频设置 | 折叠组或单独 section | 默认不打断主流程 |

## 页面滚动与固定标题

new-api 的页面标题不是靠 `position: sticky` 粘住, 而是通过布局结构让标题根本不进入滚动区域:

1. `SidebarInset` 固定右侧主面板高度, 使用 `overflow-hidden` 阻止整个主面板滚动。
2. `Main` 使用 `flex min-h-0 flex-1 flex-col overflow-hidden` 建立纵向布局。
3. `SectionPageLayout` 把页面拆成三块:
   - header: `shrink-0`, 放标题、面包屑和右上角操作。
   - content: `min-h-0 flex-1 overflow-auto`, 只有这里滚动。
   - footer: `shrink-0`, 可用于分页、保存栏或批量操作。

这样上下滚动时标题和操作按钮保持可见, 但不需要处理 sticky 的背景、z-index、滚动条遮挡和透明面板穿透问题。

对本项目的翻译建议:

- 不要先给所有 `.page-header` 加 sticky; 这会和当前半透明主面板、星空背景、滚动条和卡片层级互相影响。
- 当前 AdminPanel 已经有全局 `unified-page-header`, 试点阶段优先复用这层作为固定标题区, 不在页面内部再造第二个固定标题。
- 页面级按钮统一挂到全局标题右侧 action host; 页面内部的标题说明、小字、摘要和编辑区继续按普通内容流滚动。
- 真正需要独立滚动 body 的页面, 再补 `AdminPageLayout` 原语; 不把它作为所有配置页的默认前提。
- 迁移页面时, 先区分"全局页面标题/操作"和"内容解释标题/说明": 前者固定, 后者滚动。
- 列表/表格页可以在 body 内继续使用自己的内部滚动; 不要让外层和表格同时争抢滚动条。

标题区尺寸参考 new-api:

- App 顶栏高度: `3rem`。
- 页面标题区桌面: `padding: 20px 16px 12px`, 标题 `18px / 700 / line-height 1.35`, actions 和标题同一行居中, action gap 8-16px。
- 页面内容滚动区桌面: `padding-top` 约 6px, 左右 16px, 底部 16px。
- 页面标题区移动端: `padding: 12px 12px 10px`, 标题 16px。
- 内容里的解释性标题不要再使用主标题尺寸; 建议 16px / 600, 说明文字 13-14px, 作为滚动内容的一部分。

## 动效与交互

new-api 常见动效:

- transition 主要用于 color、background、border、width/height/padding。
- 侧栏宽度 200ms linear。
- 下拉/弹层用 100ms fade/zoom/slide。
- 按钮 active 有轻微 y 轴压下。
- 动效都应考虑 reduced motion。

对本项目的翻译建议:

- 新增原语必须包含 `@media (prefers-reduced-motion: reduce)`。
- 复杂页面不要加额外装饰动画; 只保留状态反馈和布局过渡。

## 优先级建议

短期最有收益:

1. 补 `UiField`: label、description、error、separator、orientation。
2. 补 `UiSelect`: 先 native 包装, 保持 32px 高度和统一 focus。
3. 微调 `UiCard`: 明确 header/content/footer/action slots。
4. 继续打磨 `SemanticModelRouterEditor`, 作为原语试验页。

中期再做:

1. `UiBadge` 和状态标签。
2. `UiTable` 或轻量 `DataTable` 容器。
3. 统一 Toolbar/Search/Filter 行。
4. 逐页迁移低风险表单页。

暂缓:

- 一次性重写全站页面。
- 引入外部 UI 技术栈。
- 为了像 new-api 而复制 Tailwind class 或 React 组件结构。
- 迁移高复杂表格页作为第一批试点。

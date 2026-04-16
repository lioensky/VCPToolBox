# VCPSkill 架构与工作原理

## 一、项目概述

VCPSkill 是一个**技能（Skill）集合项目**，每个技能是一个独立的、自包含的结构化知识包，旨在为 AI 编码助手提供专业领域的深度指导。项目当前包含 10 个技能，覆盖文档生成、前端开发、移动端开发、着色器编程等多个领域。

| 技能 | 类别 | 核心能力 |
|------|------|---------|
| `minimax-docx` | 文档处理 | Word文档创建/编辑/套模板 |
| `minimax-pdf` | 文档生成 | PDF创建/填写/重排版 |
| `minimax-xlsx` | 文档处理 | Excel创建/编辑/验证 |
| `pptx-generator` | 文档生成 | PowerPoint创建/编辑 |
| `html-ppt-skill` | 文档生成 | HTML演示文稿制作 |
| `frontend-dev` | 开发指导 | 前端页面+AI资产生成 |
| `fullstack-dev` | 开发指导 | 全栈架构与前后端集成 |
| `ios-application-dev` | 开发指导 | iOS应用开发 |
| `android-native-dev` | 开发指导 | Android原生开发 |
| `gif-sticker-maker` | 创意工具 | 照片转GIF表情包 |
| `shader-dev` | 创意工具 | GLSL着色器特效 |

---

## 二、Skill 的目录结构

所有技能遵循统一的目录组织模式：

```
skill-name/
├── SKILL.md                 # 核心技能定义（必需，唯一入口）
├── references/              # 按需加载的深度参考文档
├── scripts/                 # 可执行工具/脚本（可选）
├── templates/               # 模板文件（可选）
└── assets/                  # 静态资源：字体、CSS主题、图片等（可选）
```

### 各目录职责

| 目录 | 职责 | 加载时机 | 典型内容 |
|------|------|---------|---------|
| `SKILL.md` | 核心工作流、路由表、规则 | 始终首先加载 | 工作流步骤、路由决策、关键规则 |
| `references/` | 深度专题知识 | **按需加载** — 仅当任务涉及该专题时 | API参考、设计规范、故障排除 |
| `scripts/` | 可执行工具 | 执行具体操作时调用 | Python/Shell脚本、CLI工具 |
| `templates/` | 起始模板 | 创建新项目/文件时复制 | HTML模板、项目骨架、配置文件 |
| `assets/` | 静态资源 | 构建输出时引用 | 字体文件、CSS主题、图片素材 |

### 按技能类型的结构差异

- **文档生成类**（docx, pdf, xlsx, pptx）：侧重 `scripts/`（CLI工具链）和 `references/`（格式规范），有明确的管道路由
- **开发指导类**（fullstack, ios, android）：侧重 `references/`（技术参考文档），无 `scripts/` 或 `templates/`，纯知识指导
- **创意工具类**（frontend, gif-sticker, html-ppt, shader）：三者兼备，`shader-dev` 还有 `techniques/`（实现指南）与 `reference/`（理论深度）的分层

---

## 三、SKILL.md 核心结构

### 3.1 YAML Frontmatter — 元数据与触发器

```yaml
---
name: minimax-docx
description: >
  Professional DOCX document creation, editing, and formatting...
  MUST use this skill whenever the user wants to produce, modify, or format a Word document...
triggers:
  - Word
  - docx
  - 文档
  - 报告
license: MIT
metadata:
  version: "1.0.0"
  category: document-processing
  sources:
    - "ECMA-376 Office Open XML File Formats"
---
```

关键机制：
- **`description`**：包含触发条件说明，描述何时应激活此技能
- **`triggers`**：关键词列表，用于匹配用户请求
- **`metadata.category`**：技能分类
- **`metadata.sources`**：知识来源，确保可追溯性

### 3.2 触发策略

不同技能使用不同的触发策略：

| 策略 | 示例技能 | 说明 |
|------|---------|------|
| 显式 triggers 列表 | minimax-docx | 列出关键词：`Word`, `docx`, `文档`, `报告` |
| 描述中列举关键词 | html-ppt-skill | 在description中列举：`"presentation", "ppt", "幻灯片"` |
| 双向界定 | fullstack-dev | TRIGGER（何时触发）+ DO NOT TRIGGER（何时不触发） |
| 调用命令 | shader-dev | `/shader-dev <request>` 显式调用 |

### 3.3 正文结构

SKILL.md 正文通常包含以下部分（按需组合）：

1. **路由表（Route Table）**：根据用户意图分发到不同处理管道
2. **强制工作流（Mandatory Workflow）**：必须按顺序执行的步骤
3. **核心规则与约束**：✅/❌ 标记、MUST/NEVER 强调
4. **反模式表（Anti-Patterns）**：明确列出常见错误及替代方案
5. **检查清单（Checklist）**：交付前的验证项
6. **参考文档索引**：指向 `references/` 的按需加载表
7. **快速参考表**：常用命令、参数、配置速查

---

## 四、三种交互模式

### 模式一：读MD + 调CLI脚本（工具驱动型）

**代表技能**：minimax-docx, minimax-xlsx, minimax-pdf, gif-sticker-maker, frontend-dev

```
用户请求 → AI匹配Skill → 读SKILL.md（路由决策）→ 按需读references/ → 调用scripts/中的CLI工具 → 产出文件
```

示例（minimax-xlsx）：
```bash
python3 scripts/xlsx_unpack.py input.xlsx /tmp/work/   # 解包
# AI直接编辑XML
python3 scripts/xlsx_pack.py /tmp/work/ output.xlsx     # 打包
python3 scripts/formula_check.py output.xlsx             # 验证
```

**AI角色**：编排者 — 决定调用哪个脚本、传什么参数、按什么顺序执行。

### 模式二：读MD + 按知识写代码（纯知识指导型）

**代表技能**：fullstack-dev, ios-application-dev, android-native-dev

```
用户请求 → AI匹配Skill → 读SKILL.md（规则+模式）→ 按需读references/ → AI直接生成/修改代码
```

这类技能**没有scripts/目录**，不调用任何CLI工具。Skill提供的是"做什么/不做什么"的约束，AI遵循规范直接编写代码。

**AI角色**：遵循规范的代码生成器。

### 模式三：读MD + 复制模板 + 修改（模板驱动型）

**代表技能**：html-ppt-skill, pptx-generator, shader-dev

```
用户请求 → AI匹配Skill → 读SKILL.md（选择模板/技术）→ 复制templates/中的模板 → AI修改内容 → 产出文件
```

示例（html-ppt-skill）：
```bash
./scripts/new-deck.sh my-talk    # 脚手架：从模板创建新deck
# AI从templates/single-page/复制布局，替换内容
# AI从assets/themes/选择主题CSS
```

**AI角色**：模板组装者 — 从预制的、经过验证的组件中选择并组合。

---

## 五、核心设计机制

### 5.1 按需加载（Lazy Loading）

这是 Skill 架构的**核心设计理念**。SKILL.md 只包含路由决策和核心规则，详细知识存储在 `references/` 中，仅在需要时加载：

```
SKILL.md（始终加载）→ 路由决策 → 按需读取 references/xxx.md → 执行任务
```

好处：
- **Token 效率**：不一次性加载所有知识，只加载当前任务需要的部分
- **上下文聚焦**：AI 只看到与当前任务相关的信息
- **知识模块化**：每个参考文档独立维护，可单独更新

### 5.2 路由表模式

大多数技能采用路由表，根据用户意图分发到不同处理管道：

**minimax-docx 的三管道**：
```
无输入文件 → CREATE（从零创建）
有输入文件 + 修改内容 → FILL-EDIT（编辑填充）
有输入文件 + 重新排版 → FORMAT-APPLY（套用模板）
```

**shader-dev 的技术路由表**：
```
用户想创建3D物体 → ray-marching + sdf-3d + lighting-model
用户想创建流体效果 → fluid-simulation + multipass-buffer
用户想创建海洋 → water-ocean + atmospheric-scattering
```

### 5.3 规则约束系统

技能通过多种语法标记强制规则：

| 标记方式 | 示例 | 用途 |
|---------|------|------|
| ✅/❌ 标记 | `✅ All config via env vars` / `❌ Never hardcode secrets` | 明确推荐与禁止 |
| 优先级标记 | `(CRITICAL)` / `(HIGH)` / `(MEDIUM)` | 标识规则重要程度 |
| MUST/NEVER | `NEVER create a new Workbook() for edit tasks` | 绝对约束 |
| 反模式表 | ❌ 不要 → ✅ 替代方案 | 常见错误及修正 |
| 检查清单 | `- [ ] Touch targets >= 44pt` | 交付前验证 |

### 5.4 验证管道

技能在交付前设置验证检查点：

- **脚本验证**：如 minimax-docx 的 `merge-runs → validate --xsd → validate --business`
- **检查清单**：如 ios-application-dev 的 7 类检查清单
- **质量门控**：如 frontend-dev 的 Design/Motion/General 三类门控
- **反模式扫描**：如 frontend-dev 的 `grep unsplash/picsum/placeholder` 禁止占位符

---

## 六、Skill 的脚本与工具链

### 脚本类型

| 类型 | 技能示例 | 用途 |
|------|---------|------|
| CLI工具链 | minimax-docx, minimax-xlsx | 创建/编辑/验证文档的命令行工具 |
| API调用脚本 | frontend-dev, gif-sticker-maker | 调用MiniMax API生成图片/视频/音频 |
| 构建脚本 | html-ppt-skill | 脚手架创建、渲染输出 |
| 辅助工具 | minimax-xlsx | XML解包/打包、公式检查、行移动 |

### 脚本调用约定

- 文档类技能使用 `SKILL_DIR/scripts/` 前缀引用脚本路径
- 多步骤任务定义了明确的脚本调用链（如 minimax-pdf 的 `palette.py → cover.py → render_cover.js → render_body.py → merge.py`）
- 部分脚本支持并发执行（如 gif-sticker-maker 的4张图片可并行生成）

---

## 七、总结

Skill 是一种为 AI 编码助手设计的**结构化知识包**，其核心工作方式为：

1. **SKILL.md 是唯一入口**：包含触发条件、路由决策、核心规则
2. **按需加载深度知识**：references/ 不预加载，只在路由决策后按需读取
3. **三种交互模式**：工具驱动（调CLI）、知识指导（写代码）、模板驱动（组装模板）
4. **严格规则约束**：通过 ✅/❌、MUST/NEVER、反模式表、检查清单约束AI行为
5. **验证管道保障质量**：交付前必须通过脚本验证、检查清单或质量门控

这种架构让 AI 助手在专业领域内能够：**知道何时触发**（触发器）→ **知道走哪条路**（路由表）→ **知道怎么做**（规则+参考）→ **有工具可用**（脚本+模板）→ **知道做对了没有**（验证管道）。
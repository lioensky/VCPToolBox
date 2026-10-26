# MinerUParser — MinerU PDF 智能解析插件（V4）

VCP 聊天工作流中的论文解析入口：把 PDF 转化为「零污染上下文 + 按需切片 + 图片资产」。
Agent 上下文只收到一张元数据卡片（路径、大纲、图片清单、质检报告），绝不收到全文；
正文通过 `read` 命令按行范围 / 章节 / 关键词读取（也兼容 `UrlFetch(file://…)`），
图片通过 `read` 以 base64 `image_url` 直接交给多模态模型，同时保留 HTTP URL 供气泡渲染。

V4 新增解析前查重（`preflight`）与全库重复检索（`duplicates`），并在 VCPChat 中提供
「MinerU 论文工作台」可视化窗口：选择 PDF / 文件夹、预检去重、并发解析队列、全库查重，
以及 PDF + Markdown（含图片、公式）双栏阅读。

Rust 原生实现（零 tokio、纯同步），经 `MinerUParser.js` 桥接器按平台选择 `bin/` 下二进制。

## 配置

复制 `config.env.example` 为 `config.env`（不会提交 Git），填入：

| 键 | 说明 | 默认 |
|---|---|---|
| `MINERU_TOKEN` | MinerU API Token（https://mineru.net 获取） | 必填 |
| `MODEL_VERSION` | 默认解析模型：`vlm` / `pipeline` | `vlm` |
| `POLL_TIMEOUT_SEC` | parse/query 单次轮询上限（秒），代码上限 1500 | `1500` |
| `BATCH_WORKERS` | batch/query 并发线程数（1-5，`workers` 参数优先） | `3` |

`PROJECT_BASE_PATH`、`SERVER_PORT`、`IMAGESERVER_IMAGE_KEY`、`IMAGESERVER_FILE_KEY`
由 VCP 主进程自动注入，无需配置。

## 命令

### parse — 完整解析（本地文件 / 公开 URL / 超页自动分片）

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」parse「末」,
file_path:「始」D:\papers\demo.pdf「末」,
is_ocr:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
```

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `file_path` | 与 `url` 二选一 | — | PDF 绝对路径（≤200MB） |
| `url` | 与 `file_path` 二选一 | — | 公开 PDF URL（如 arxiv），走 `extract/task` 免上传通道 |
| `model_version` | | `vlm` | `vlm`（视觉大模型）/ `pipeline`（传统管线） |
| `is_ocr` | | `false` | 扫描件（无文字层）设 `true` |
| `language` | | `en` | 内容语言提示 |
| `enable_formula` | | `true` | 公式解析 |
| `enable_table` | | `true` | 表格解析 |
| `title` | | — | 显式覆盖标题（缺省取 content_list 首个标题；同时决定资产目录名） |

- 幂等：同一 PDF（SHA-256 相同）/ 同一 URL 重复 parse 直接返回缓存卡片，不消耗 API 配额；
- **资产目录自动命名**：完成后把工作目录从 `paper_xxx` 改名为 `论文标题__paper_id`，并同步 index/state/URL；改名失败会回退旧目录且不阻断解析；
- `parse` 也接受 `file_paths` / `urls`，多输入时自动转入 `batch` 汇总；
- **V2 分片**：>200 页 PDF 自动按 200 页切分、逐片上传解析、`content_list` 按页偏移合并、
  md 加分片分隔注释后拼接落盘（分片 PDF 与 source.partN.zip 均留档）；
- 轮询每片封顶后返回 `batch_id` + `paper_id`，用 `query` 续查。

### query — 断点续查（支持多篇并发）

`paper_id` 即可续查（batch_id 会从本地 state 自动读取）；也可传 `batch_id`。支持：

| 参数 | 说明 |
|---|---|
| `paper_id` | 单篇；也可传标题关键词自动解析 |
| `paper_ids` | 多篇（数组或逗号/换行分隔），单次最多 10 篇 |
| `batch_id` / `batch_ids` | 批次 ID；`batch_ids` 与 `paper_ids` 按顺序配对，也可单独传（按本地 state 反查论文） |
| `all` | `true` 时续查全部未完成论文 |
| `workers` | 并发数，默认 3，最多 5 |

云端完成后自动完成下载、解压、落盘、路径重写、质检全收尾。单篇返回完整卡片；
多篇返回汇总表（新完成 / 已有 / 待续查 / 失败），不展开大纲图片，避免上下文膨胀。

### status — 多篇进度总览（不访问云端）

一次查看全部或指定多篇论文的状态、分片/页级进度、batch_id 与下一步，
只读本地 `state.json` / `index.json`，不消耗 MinerU 配额。
`paper_ids` 支持标题关键词；`status` 可选过滤、排序与 `limit`（默认 50，最多 200）。
这是「同时查询多个进度」的轻量入口。

### batch — 批量导入（文件 / 目录 / URL，并发）

`file_paths`（文件或文件夹，数组/逗号/换行分隔）与/或 `urls`，单次最多 20 个文件；
文件夹默认递归展开 `.pdf`（`recursive=false` 只取一层）。`workers` 控制并发（默认 3，最多 5）。
逐个完整解析（含分片与缓存复用），返回汇总表：每篇的 paper_id、标题、状态、
页数、图片数与资产目录；失败项给出原因，进行中项给出续查提示。展开后超过 20 个会提示拆分。

### list — 论文库清单（工作区感知）

扫描全部资产并合并 `index.json` + `state.json`，返回总览（✅ 已完成 / ⏳ 进行中 / ⏱️ 待续查 / ❌ 失败）
与每篇的 paper_id、标题、状态、页数、图片数、资产目录、更新时间。支持：

| 参数 | 说明 |
|---|---|
| `status` | `indexed` / `running` / `timeout` / `failed` / `unknown` / `unfinished` / `all`，可逗号分隔 |
| `query` | 标题 / 文件名 / paper_id / 资产目录关键词 |
| `sort` | `recent`（默认）/ `title` / `pages` / `created` |
| `limit` | 默认 20，最多 100 |

### info — 单篇详情

返回标题、paper_id、状态、资产目录、源文件/源目录、页数/字符/图片/表格/公式、batch_id、
目录大纲（前 25 条）、图片清单（前 12 张）与质检结果。`paper_id` 可写完整 ID 或标题关键词；
`paper_ids` 一次最多 5 篇；不带参数时退化为论文库概览。

### migrate — 旧目录整理

把历史遗留的 `paper_xxx` 目录改名为 `标题__paper_id`，同步更新 index/state 与
`full.render.md` 中的图片链接。**默认只预演**，确认后加 `apply=true`；
只处理已有 `index.json` 的论文，未完成项跳过。`paper_id` 不变，旧目录仍可读写。

### locate — 关键词秒级定位（V2）

`paper_id` + `keyword`：在 content_list 中大小写不敏感检索（正文/公式/表格/图注），
返回命中页码、块编号、摘录（关键词加粗）。`paper_id` 也可写标题关键词。定位之后配合 `read find=…` / `read section=…` 读取上下文。

### read — 自由阅读（V2.1）

正文读取（默认 `full.md`，也可 `full.render.md` / `content_list.json` / `index.json` 等）：

| 参数 | 必需 | 说明 |
|---|---|---|
| `paper_id` | ✔ | 论文 ID；也可写标题关键词，自动唯一解析 |
| `path` | | 单个文件；支持 `full.md:100-160`；别名 `md` / `render` / `content_list` / `index` / `state` / `layout` |
| `paths` | | 多个文件（数组或换行/逗号分隔，每项可带 `:M-N`） |
| `glob` | | 相对资产目录通配，如 `images/*.jpg`、`**/*.md` |
| `lines` | | `head:N` / `tail:N` / `M-N` / `M:N` / `N` / `all`；缺省最多 600 行 |
| `section` | | Markdown 章节标题或编号（`3.2`、`3.2 Experimental Setup`、`Results`），读到下一个同级/更高级标题前，包含子节 |
| `find` | | 正文关键词检索，命中行以 `>` 标记并附上下文 |
| `context` | | find 命中前后上下文行数，默认 2，最多 10 |
| `show_line` | | 文本是否带 `N | 内容` 行号，默认 `true` |

图片读取（默认以 base64 data URL 返回 `image_url` content part，多模态模型可直接看图）：

| 参数 | 说明 |
|---|---|
| `images` | 图片序号（1 起，与卡片 `#N` 一致，如 `3` / `3,5`）、`page:4`、`caption:Figure 2`、`images/xxx.jpg` |
| `page` | 读取该页全部图片（1 起，与卡片 `pN` 一致） |
| `caption` | 按图注关键词选图（大小写不敏感） |
| `with_base64` | 默认 `true`；设为 `false` 仅返回图片清单与 HTTP URL |
| `path` / `paths` | 直接写图片相对路径也会按图片读取 |

限制：单次最多 20 个文本文件、12 张图片；单图 ≤10MB、本次内嵌合计 ≤24MB、文本文件 ≤20MB。
超长单行（如紧凑的 content_list.json）会按命中词居中截断到 1000 字符；定位块建议用 `locate`。
`read` 只允许访问该论文解析后的 `file/mineru/{目录}` 与 `image/mineru/{目录}`（新旧命名均可解析），拒绝 `..` 越界。

### preflight — 解析前查重（只读，不调用云端）

在真正提交解析前，先判断所选 PDF 是否已在库中，避免重复消耗 MinerU 配额。
判重依据是 **PDF 内容 SHA-256**（与 `paper_id` 生成规则一致），所以改名、换目录的同一文件也能命中。

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `file_path` / `file_paths` / `paths` | 与 `urls` 二选一 | — | 单个文件、多个文件或文件夹；文件夹递归展开 `.pdf` |
| `url` / `urls` | | — | 公开 URL，按 URL 文本哈希判重 |
| `recursive` | | `true` | 文件夹是否递归；`false` 只取一层 |

返回两类信息：

- `data.counts`：`total` / `new` / `indexed` / `running` / `timeout` / `failed` / `unknown` / `invalid` / `duplicate` / `existing`；
- `data.items[]`：每项的 `path`、`size`、`sha256`、`paper_id`、`status`、`duplicate_in_selection`
  （本次选择内重复，后续项为 `true`）、`duplicate_of`、`name_duplicate_of`（同名不同内容，仅提示）、
  `existing`（库中已有记录的标题/状态/页数/资产目录）。

行为约定：

- 只读 `file/mineru` 下的 `index.json` / `state.json` 与目标 PDF，不写库、不上传；
- 单次最多检查 500 个文件，超出会置 `data.truncated=true` 并只检查前 500 个；
- 单文件 >200MB、非 PDF、无法读取的路径会作为 `status=invalid` 项返回，不中断整批；
- `new` 计数已排除本次选择内的重复项，可直接把 `new` 数量当作本次实际要解析的数量；
- 文本卡片最多展开 100 行，完整结果在 `data.items`。

### duplicates — 全库重复检索（只读）

扫描整个论文库，按四种口径分组找出重复或高度重叠的论文：

| `group_by` | 判据 |
|---|---|
| `asset` | 同一 `paper_id` 存在多份资产目录（如旧目录 + 标题化目录） |
| `text` | `full.md` 去除空白、标点与大小写差异后的正文指纹一致（至少 32 字符） |
| `title` | 标题归一化（字母数字小写，≥12 字符）后一致 |
| `source` | `source_path` 指向同一本地源文件，却被解析成多个版本（排除 URL） |

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `group_by` | `all` | `all` 或 `asset,text,title,source` 的任意组合 |
| `query` | — | 仅检查标题 / 文件名 / paper_id / 资产目录匹配关键词的论文 |
| `limit` | 200 | 返回组数上限（1-200），超出置 `data.truncated=true` |

每组返回 `kind`、`label`、`member_count`、`recommended`（建议保留的资产目录）、`reclaim_bytes`
（清理其余成员 `source*.zip` 可回收的字节数）与 `members[]`；成员按“有 index → 非旧目录 → 更新时间新 → 正文字数多”排序。
顶层 `data.counts` 给出论文总数、组数、涉及论文数与各类组数。

**该命令只做分析与建议，不删除、不移动任何文件**；清理仍需人工确认后在文件系统执行。
`asset` 组中的旧目录可用 `migrate` 合并，`text` / `title` / `source` 组用于发现同一论文的多次解析。

查重示例：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」preflight「末」,
file_paths:「始」E:\pdf\科研相关论文「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」duplicates「末」,
group_by:「始」asset,text「末」,
query:「始」microwave「末」,
limit:「始」50「末」
<<<[END_TOOL_REQUEST]>>>
```

批量与库查询示例：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」batch「末」,
file_paths:「始」E:\pdf\科研相关论文「末」,
workers:「始」3「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」status「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」query「末」,
paper_ids:「始」paper_a1b2c3d4e5f60718, paper_0f9e8d7c6b5a4938「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」list「末」,
status:「始」running,timeout「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」migrate「末」,
apply:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

读取示例：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」read「末」,
paper_id:「始」paper_a1b2c3d4e5f60718「末」,
lines:「始」100-160「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」read「末」,
paper_id:「始」paper_a1b2c3d4e5f60718「末」,
section:「始」3.2 Experimental Setup「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」read「末」,
paper_id:「始」paper_a1b2c3d4e5f60718「末」,
find:「始」microwave absorption「末」,
context:「始」2「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」read「末」,
paper_id:「始」paper_a1b2c3d4e5f60718「末」,
page:「始」4「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」MinerUParser「末」,
command:「始」read「末」,
paper_id:「始」paper_a1b2c3d4e5f60718「末」,
images:「始」3,5「末」
<<<[END_TOOL_REQUEST]>>>
```

## 产物目录布局

```
{PROJECT_BASE_PATH}/
├── file/mineru/{标题}__{paper_id}/     # 新解析使用可读目录名
│   ├── source.zip          # 云端原始 ZIP 留档
│   ├── full.md             # 原始纯净 md（图片相对路径保持原样）
│   ├── full.render.md      # 渲染副本（图片 src = HTTP URL）
│   ├── content_list.json   # MinerU 结构化内容流
│   ├── layout.json         # 版面数据（如有）
│   ├── state.json          # 状态机（uploading/running/…/indexed/failed）
│   └── index.json          # 大纲 + 图片清单 + 统计 + 质检
├── file/mineru/{paper_id}/             # 旧目录（仍兼容，可用 migrate 整理）
└── image/mineru/{标题}__{paper_id}/
    └── images/…            # 论文图片（保持 ZIP 内子结构）
```

URL 对照（由 ImageFileServer 提供）：

| 资产 | HTTP URL |
|---|---|
| 渲染 md | `http://localhost:{port}/pw={FILE_KEY}/files/mineru/{标题}__{paper_id}/full.render.md` |
| 图片 | `http://localhost:{port}/pw={IMAGE_KEY}/images/mineru/{标题}__{paper_id}/images/x.jpg` |

目录名中的空格、中文会做百分号编码；`read` 与卡片 URL 都已适配。

## Agent 使用姿势（卡片中亦含提示）

1. 先感知：`list` 看论文库、`status` 看多篇进度、`info paper_id=...` 看单篇大纲与图片
   （三者除文本卡片外都返回结构化 `data`，便于前端或 Agent 二次消费）；
2. 读正文：`read` + `lines="100-160"` / `section="3.2 Experimental Setup"` / `find="关键词"`；
3. 读图片：`read` + `page=4` / `images=3,5` / `caption="Figure 2"`，图片以 base64 `image_url` 直接返回；
4. 渲染图片：卡片图片清单中的 HTTP URL 仍可在气泡内直接渲染；
5. 定位章节：结合目录大纲、`locate` 结果与 `read` 的 `lines` / `section` 精确读取；
6. 批量：`batch file_paths="整个文件夹"` 导入，`query paper_ids=...` / `query all=true` 同时续查。

## MinerU 论文工作台（VCPChat）

VCPChat 侧提供独立子窗口「论文」，不依赖聊天会话，布局参考 ProjectForge：

- **入口**：VCPChat 托盘菜单「论文」→「MinerU 论文工作台」（`app:open-mineru-window`，
  窗口 1460×900，最小 1080×680）。首次打开会在设置中自动探测 VCPToolBox 根目录与插件二进制。
- **论文库**：搜索、按状态过滤、状态徽章、页数/图片数/更新时间；点击进入阅读器。
- **导入解析**：
  - 「选择 PDF」多选文件，或「选择文件夹」递归导入其中全部 `.pdf`（与 `preflight` 的展开规则一致）；
  - 选完自动执行 `preflight`，列表逐项显示「新文件 / 已解析 / 进行中 / 本次重复 / 无效」，重复项默认不勾选；
  - 解析选项：模型（`vlm` / `pipeline`）、OCR、语言、公式、表格、并发（1-5）；
  - 提交后按队列逐篇调用 `parse`，底部任务坞实时显示进度、页数、失败原因，可取消单个或全部；
  - 已存在 `paper_id` 的文件会直接复用缓存，不重复消耗配额。
- **重复检索**：选择口径（`all` / `asset` / `text` / `title` / `source`）与关键词，调用 `duplicates`
  展示分组、建议保留项与可回收体积；每项可「在文件夹中显示」，只读，不会删除文件。
- **阅读器**：左侧大纲（可折叠），右侧 `分栏 / 仅 MD / 仅 PDF` 三种视图：
  - Markdown 渲染 marked + DOMPurify + KaTeX，本地图片经自定义协议加载，支持点击放大、正文查找（Enter / Shift+Enter）、自动换行；
  - PDF 使用随包分发的 PDF.js 5.x，支持翻页、页码跳转、缩放与适合宽度；工作台内嵌阅读的 PDF
    上限为 128MB，超出时请用「打开 PDF」在系统阅读器中打开；超大页面会自动限制画布像素，避免高倍缩放爆内存；
  - 阅读位置、视图、大纲/换行开关按论文记忆。
- **旧资产关联 PDF**：早期论文的 `state.json` 没有 `source_path`，阅读器会提示「关联本地 PDF」；
  选择后写入 `AppData/MinerU/pdf-map.json`，只记录 `paper_id → 本地路径`，可随时「更换 / 清除」。
- **设置**：显示并修改 VCPToolBox 根目录、插件目录、二进制、`config.env` 状态与 `MINERU_TOKEN` 是否已配置；
  保存后重新探测环境，无需重启 VCP 主服务。浏览器 UI 不读取、不回显 Token 明文。

技术实现（便于排障）：

- `VCPChat/modules/services/minerU/minerUService.js`：定位插件与二进制、读取 `config.env`、以子进程调用
  stdio 插件、合并 `index.json` + `state.json`、维护解析队列与 `pdf-map.json`；
- `VCPChat/modules/ipc/minerUHandlers.js`：IPC 通道与发送方页面白名单（仅 `MinerUmodules/mineru.html`）；
- `VCPChat/modules/services/minerU/minerUProtocol.js`：注册特权协议 `vcp-mineru://image/{paperId}/{rel}`，
  由主进程解析并做目录包含校验后才读取图片，渲染进程不能借协议读取任意文件；
- `VCPChat/preloads/api/minerU.js`：`utility` 角色的 preload API。

## 构建与部署

```bash
cd src
cargo build --release
# Windows 产物复制：
cp target/release/MinerUParser.exe ../bin/MinerUParser-x86_64-pc-windows-msvc.exe
```

`bin/` 命名规范：`MinerUParser-{triple}[.exe]`（见 `bin/README.md`）。
开发期桥接器会自动回退到 `src/target/{triple}/release|debug/` 下的构建产物。

运行测试：`cargo test`（76 个单元测试，覆盖协议双形态与多模态 parts、SHA/paper_id、
PDF 分片与页数、ZIP 三重防御、大纲、分片合并与页偏移、路径重写、质检、
错误码表、Token 掩码、locate 检索、read 的行范围/章节/glob/检索/图片选择/base64/路径越界，
标题化目录/目录扫描/递归 PDF 展开/并发顺序保持/资产目录改名，以及 preflight 的库命中/批内重复/
无效路径与 duplicates 的 asset/text/title/source 分组、归一化与 `group_by` 校验；
另有深目录与目录联接环、2000 文件遍历、500 文件预检上限、超长文本行、病态 `**` glob 等极端用例）。

## 安全设计

- ZIP 解压三重防御：解压总量 ≤2GB、条目数 ≤20000、路径穿越/绝对路径/盘符/符号链接全拒绝；
- Token 只从环境变量读取，任何错误输出前经掩码净化，绝不出现在日志与卡片中；
- 状态与索引全部原子写（临时文件 + rename）；
- read 路径限定在论文资产目录内，拒绝 `..`、盘符与目录外绝对路径；新旧目录名都经同一解析器定位；
- 标题化目录名会清理 Windows 非法字符、控制字符、保留名与超长标题，LaTeX 数学式压缩为可读文本；
- migrate 只重命名已完成论文的目录，先预演；图片改名失败会回滚文件目录改名，paper_id 始终不变；
- preflight / duplicates 严格只读：不写状态、不上传云端、不删除或移动文件，清理建议需人工执行；
- 工作台的图片协议只接受 `paper_` 前缀的 paper_id 与资产目录内相对路径，拒绝 `..`、盘符与绝对路径；
- IPC 通道校验发送方页面，仅工作台窗口可调用；错误信息中的 Token 统一掩码；
- 图片内嵌有单图/总量上限。

## 边界

单文件 ≤200MB（URL 模式受 MinerU 云端限制）；>200 页自动分片；单次 batch ≤20 个文件（目录展开后计数）。
单次 query ≤10 篇；status 单次最多 200 条；list 单次最多 100 条。
preflight 单次最多检查 500 个文件；duplicates 单次最多返回 200 组，`text` 指纹只读取 ≤8MB 的 `full.md`。
工作台内嵌 PDF ≤128MB；论文列表最多渲染 500 条、大纲 2000 条、查重每组 100 份，超出会提示用搜索或关键词缩小范围。
并发默认 3（`BATCH_WORKERS` 或 `workers`，上限 5），避免触发 MinerU 限流。
单次工具调用仍受 manifest 30 分钟总超时约束；大书或多文件批量建议拆批，超时项用 `status` / `query` 续查。
加密 PDF 暂不支持（lopdf 无法加载时返回 FIX 错误）。
read 未指定行范围时默认最多 600 行（`lines=all` 或显式范围可读全文）；单次最多 12 张 base64 图片。
资产目录标题片段最多 100 字符，非法字符替换为空格；重复标题通过 `标题 (2)__paper_id` 去重。
V4 仍未含：paper_study SQLite 资产互通（该插件当前部署中不存在，待其落地后以 paper_id 对接）。

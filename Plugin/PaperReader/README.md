# PaperReader（v0.2）

## 设计目标

将超长 PDF / 文档转为可控的递归阅读流程。适用于学术论文、技术报告、法律文书、书籍章节等各类长文档。

1. **L0 解析层**：MinerU 云端 API 高保真解析（保留公式/表格/图片/多栏排版），自动降级到 pdf-parse
2. **L1 切分层**：章节感知切分 + Meta-Header 注入 + 10-20% overlap
3. **L2 递归逻辑层**：Skeleton 骨架提取 / Rolling Context 深度阅读 / 合并综合
4. **L3 存储交互层**：Obsidian 友好的 Markdown 目录结构

## 命令

| 命令 | 功能 |
|------|------|
| `IngestPDF` | PDF → Markdown → 章节感知 chunks |
| `ReadSkeleton` | 从目录/摘要/关键章节生成 Global Map |
| `ReadDeep` | 带 Rolling Context 的递归摘要 → Round-1 笔记 |
| `Query` | 检索式问答（关键词匹配 + 章节权重） |

## 工件目录

```
workspace/{paperId}/
├── meta.json                    # 元数据（含解析引擎标识）
├── full_text.md                 # 完整 Markdown（L0 输出）
├── figure_map.json              # Figure_ID ↔ Caption 映射
├── assets/
│   └── figures/                 # 提取的图片
├── chunks/
│   ├── manifest.json            # chunk 清单 + 章节映射
│   └── chunk_{i}.md             # 单个 chunk（含 Meta-Header）
└── reading_notes/
    ├── Global_Map.md            # 骨架地图
    ├── Chunk_Summaries.json     # 分块摘要
    └── Round_1_Summary.md       # 深度笔记
```

## 配置

复制 `config.env.example` 为 `config.env` 并填入：
- `MINERU_API_TOKEN`：MinerU 云端 API Token（不填则自动降级）
- `PaperReaderModel`：LLM 模型名称
- 详见 `config.env.example` 中的完整配置项

## 依赖

- `axios`：HTTP 请求
- `pdf-parse`：降级模式 PDF 解析
- `adm-zip`：解压 MinerU 返回的 zip
- `@dqbd/tiktoken`：token 计数
- `dotenv`：环境变量

## 支持的文档类型

MinerU 云端 API 支持解析：
- 学术论文（多栏、公式、引用）
- 技术报告 / 白皮书
- 书籍章节
- 法律文书 / 合同
- 扫描版 PDF（内置 OCR）
- 含复杂表格的文档

## 常见限制

- MinerU 免费额度：每日 2000 页，单文件 200MB/600 页
- Rolling Context 上限 4000 tokens，超出自动压缩
- Query 目前为关键词匹配（向量检索计划在 Phase 2）

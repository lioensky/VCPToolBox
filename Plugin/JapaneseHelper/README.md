# JapaneseHelper 日语学习插件 (VCP)

本插件是面向 VCP 工具链的日语学习增强插件，围绕“**一句话输入 → 解析理解 → 练习测验 → 复习巩固**”构建完整学习闭环。

**核心定位**：无需额外改造调用链，接入 `JapaneseHelper` 后即可获得句子解析、查词消歧、语法讲解、测验、SRS 复习与学习数据管理能力。

## 功能与相比基础查词工具的加强点

- **句子级理解**：支持分词、词性、原形、读音、释义与句法提示（`analyze_sentence`）。
- **假名标注**：支持整句振假名标注，Sudachi 优先并自动 fallback（`add_furigana`）。
- **语法解释**：输出语法点含义、接续、易错点、例句、JLPT 参考等级（`grammar_explain`）。
- **助词与改写**：支持助词启发式检查与文体改写（敬体/简体/书面）（`particle_check` / `rewrite_sentence`）。
- **查词增强**：本地词典 + 在线并联检索，支持 `race/aggregate`、上下文轻量消歧（`lookup_word` / `lookup_word_json`）。
- **JLPT 能力**：整句 JLPT 分级标注与词汇提取优先级建议（`jlpt_tag` / `extract_vocab`）。
- **活用与声调**：支持动词活用还原与重音查询（`conjugate_verb` / `pitch_accent`）。
- **测验系统**：自动出题、单题判题、批量判题、易混项训练与错因解释（`quiz_generate` / `quiz_check` / `quiz_check_batch` / `minimal_pair_quiz` / `error_explain`）。
- **双复习排程**：支持 SM-2 与 FSRS 简化排程并存（`srs_schedule` / `fsrs_schedule`）。
- **学习数据闭环**：错题本、学习会话、进度报告、自定义词典、导入导出、健康检查一体化（`wrongbook_*` / `study_session_*` / `lexicon_*` / `import_export_data` / `health_check`）。

## 安装与使用

1. 将本目录放置于 VCP 的 `Plugin` 目录中（或保持当前目录结构）。
2. 安装依赖：`pip install -r requirements.txt`
3. 在 `config.env` 中按需配置在线查询、缓存与日志参数。
4. 确保 `plugin-manifest.json` 已被 VCP 正确识别并加载。

## 配置说明（config.env 常用项）

```env
REQUEST_TIMEOUT=10
JISHO_API_ENABLED=true
SUDACHI_SPLIT_MODE=C
USER_LEXICON_PATH=./user_lexicon.json
DOMAIN_LEXICON_PATH=./domain_lexicon.json

ONLINE_DICT_MODE=race
ONLINE_DICT_TIMEOUT=1.2
ONLINE_DICT_GLOBAL_TIMEOUT=2.5
ONLINE_DICT_RETRY=1

ONLINE_CACHE_TTL_SEC=86400
ONLINE_CACHE_MAX_ITEMS=2000
ONLINE_CACHE_FLUSH_INTERVAL_SEC=2.0
ONLINE_CACHE_STALE_IF_ERROR_SEC=600

OBSERVABILITY_LOG_PATH=./observability.log
```

## AI 调用工具说明

### 1.1 JapaneseHelper（通用学习入口）

**说明**：通过 `command` 指定具体能力。  
**调用格式**：

```text
tool_name: JapaneseHelper,
command: [具体指令],
text: [可选，句子/文本],
word: [可选，单词],
...其它参数按 command 传入
```

---

### 1.2 句子解析（analyze_sentence）

**说明**：解析句子并给出词项信息。  
**示例**：

```text
tool_name: JapaneseHelper,
command: analyze_sentence,
text: 昨日友達と映画を見に行きました。
```

### 1.3 查词（lookup_word / lookup_word_json）

**说明**：查词并支持并联在线检索与轻量消歧。  
**示例**：

```text
tool_name: JapaneseHelper,
command: lookup_word,
word: 利害関係者,
use_parallel_online: true,
force_online: true,
online_mode: aggregate
```

```text
tool_name: JapaneseHelper,
command: lookup_word_json,
word: 勉強,
context: 私は毎日日本語を勉強しています。
```

### 1.4 语法讲解（grammar_explain）

```text
tool_name: JapaneseHelper,
command: grammar_explain,
text: 私は毎日日本語を勉強しています。
```

### 1.5 批量判题（quiz_check_batch）

**说明**：支持 `answers/user_answers` 与 `expected_answers/correct_answers` 双别名参数。  
**示例**：

```text
tool_name: JapaneseHelper,
command: quiz_check_batch,
answers: 昨日,日本語,行く,
expected_answers: 昨日,日本語,行く,
readings: きのう,にほんご,いく
```

### 1.6 学习会话（study_session_start）

```text
tool_name: JapaneseHelper,
command: study_session_start,
text: 私は毎日日本語を勉強しています。,
count: 5,
adaptive: true
```

## 重要提示

1. `lookup_word_json` 返回结构化结果，更适合前端直接渲染。  
2. 在线查询链路建议结合缓存参数使用，以平衡延迟与稳定性。  
3. 训练场景建议结合：`extract_vocab` → `quiz_generate` → `quiz_check_batch` → `srs_schedule/fsrs_schedule`。

## 一句话总结

**JapaneseHelper = 面向 VCP 的一站式日语学习插件：能拆句、能查词、能讲语法、能出题、能复习，并具备长期学习数据管理能力。**

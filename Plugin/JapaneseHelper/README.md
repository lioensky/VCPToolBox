# JapaneseHelper 日语学习插件 (VCP)

> 版本：v2.14.2  
> 定位：一句话输入→ 解析理解 → 练习测验 → 复习巩固 → 长期追踪  
> 当前运行结构：**Python 统一入口 + Rust 核心能力 + Python NLP 回退层**

JapaneseHelper 现在采用 **混合架构**：
- `JapaneseHelper.py` - 统一插件入口，负责 Python 包装/路由/Rust 回退
- `JapaneseHelper_legacy.py` - 保留原有 Python 大单体，所有强依赖 Python NLP 的能力继续走这里
- `rust_core/` - 负责结构化查询、学习状态、在线缓存/状态等核心能力
- `py_backend/` - 负责桥接、兼容渲染和 fallback
- `_dev/` - 构建脚本、测试脚本、迁移文档

---

## 快速开始

### 安装方式选择

根据你的网络环境和需求，选择合适的安装方式：

#### 方式 A：在线构建（推荐）

**适合场景**：有稳定网络连接，希望获取最新词典数据

**包体积**：约 12MB（不含数据库）

**安装步骤**：

```bash
# 1. 解压插件到 VCP 插件目录
# 放置到: Plugin/JapaneseHelper/

# 2. 安装 Python 依赖
.\install_plugin_requirements.bat
# 或手动执行: pip install -r requirements.txt

# 3. 构建数据库（自动下载源数据）
python.\setup_database.py
# 下载内容: JMdict_e.gz (约10MB) + kanjidic2.xml.gz (约1.4MB)
# 构建时间: 约 3-5 分钟
# 最终数据库大小: 约 141MB

# 4. (可选) 导入Wadoku 德日词典
.\setup_wadoku.bat
# 或手动执行: python .\setup_wadoku.py
# 下载内容: wadoku.xml (约225MB)
# 导入时间: 约 5-10 分钟
# 增加词条: 约 44万条

# 5. 配置插件
copy config.env.example config.env
# 按需修改 config.env 中的配置项

# 6. 重启 VCP 服务器
```

#### 方式 B：离线安装

**适合场景**：网络受限或追求快速部署

**包体积**：约 23MB（含缓存文件）或 220MB（含预构建数据库）

**安装步骤**：

```bash
# 1. 解压插件到 VCP 插件目录

# 2. 安装 Python 依赖
.\install_plugin_requirements.bat

# 3a. 如果包含 data/raw/缓存文件（23MB 版本）
python .\setup_database.py
# 跳过下载，直接构建，约 2 分钟

# 3b. 如果包含 data/db/jdict_full.sqlite（220MB 版本）
# 跳过此步骤，数据库已预构建

# 4. 配置并重启
copy config.env.example config.env
# 重启 VCP 服务器
```

### 验证安装

重启 VCP 后，通过以下命令验证插件是否正常工作：

```
tool_name: JapaneseHelper
command: health_check
```

应返回各组件状态为 OK。

---

## 命令使用指南

### 📚 词典查询

#### 本地词典查询
```
tool_name: JapaneseHelper
command: lookup_word_json
word: 勉強
context: 私は毎日日本語を勉強しています。  # 可选，提供上下文消歧
```

#### 在线词典查询（并联）
```
tool_name: JapaneseHelper
command: lookup_word_json
word: 利害関係者
use_parallel_online: true
force_online: true
online_mode: aggregate# race或 aggregate
```

###🈯 汉字与JLPT

#### 汉字信息查询
```
tool_name: JapaneseHelper
command: kanji_info
word: 勉
```

#### JLPT 等级检查
```
tool_name: JapaneseHelper
command: jlpt_check
word: 勉強
```

### 📖 句子分析

#### 完整句子解析
```
tool_name: JapaneseHelper
command: analyze_sentence
sentence: 彼女は毎朝公園を走っている。
```

#### 阅读辅助（带JLPT 颜色标注）
```
tool_name: JapaneseHelper
command: reading_aid
text: 彼女は毎朝公園を走っている。
target_level: N3# N1-N5
level_color: true# 可选，启用颜色标注
```

### 📝 语法与风格

#### 深度语法解析
```
tool_name: JapaneseHelper
command: grammar_explain_deep
grammar: 〜ている
```

#### 文体转换
```
tool_name: JapaneseHelper
command: style_shift
text: 彼は来る。彼女は来ます。
target: polite  # polite/plain/formal/sonkei/kenjou
```

### 🔤 假名与活用

#### 添加假名标注
```
tool_name: JapaneseHelper
command: add_furigana
text: 私は日本語を勉強しています。
```

#### 动词活用
```
tool_name: JapaneseHelper
command: conjugate_v2
verb: 行く
```

### 📚 错题本系统

#### 添加错题
```
tool_name: JapaneseHelper
command: wrongbook_add
word: 勉強
error_type: reading# reading/meaning/kanji/grammar
note: 混淆了べんきょう和べんきょ的读音
```

#### 查看错题列表
```
tool_name: JapaneseHelper
command: wrongbook_list
```

#### 错题统计
```
tool_name: JapaneseHelper
command: wrongbook_stats
```

### 🔄 复习系统

#### 查看待复习列表
```
tool_name: JapaneseHelper
command: review_due_list
window_days: 1  # 可选，查看未来N天内到期的卡片
```

#### 提交复习结果
```
tool_name: JapaneseHelper
command: review_submit
word: 勉強
result: 记住# 记住/模糊/忘记
```

#### 复习统计
```
tool_name: JapaneseHelper
command: review_stats
```

### 📊 学习进度

#### 学习进度报告
```
tool_name: JapaneseHelper
command: progress_report
days: 30  # 可选，统计窗口（默认30天）
```

###🔧 系统管理

#### 健康检查
```
tool_name: JapaneseHelper
command: health_check
```

#### 资源状态
```
tool_name: JapaneseHelper
command: resource_status
```

#### 能力探针（查看所有结构化命令）
```
tool_name: JapaneseHelper
command: schema_probe
```

---

## 常见问题

### Q: 数据库构建失败怎么办？

**A:** 检查以下几点：
1. 网络连接是否正常（需要访问 ftp.edrdg.org）
2. 磁盘空间是否充足（至少需要 200MB 可用空间）
3. Python 版本是否 >= 3.8
4. 查看错误日志，确认具体失败原因

如果下载失败，可以手动下载源文件：
- JMdict: http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz
- KANJIDIC2: http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz

将文件放置到 `data/raw/` 目录后，重新运行 `setup_database.py`。

### Q: 是否必须安装 Wadoku 词典？

**A:** 不是必需的。Wadoku 是德日词典，提供额外的 44 万条词汇，主要用于：
- 增强词汇覆盖率
- 提供德语释义（适合德语学习者）

如果你只需要日英词典，可以跳过 Wadoku 安装。

### Q: 如何更新词典数据？

**A:** 重新运行构建脚本即可：
```bash
python .\setup_database.py
```
脚本会自动下载最新的源数据并重建数据库。

### Q: 插件占用多少磁盘空间？

**A:** 完整安装后：
- 代码和配置: 约 1MB
- 数据库 (jdict_full.sqlite): 约 141MB
- 缓存文件 (data/raw/): 约 11MB（可删除）
- 总计: 约 153MB

### Q: 支持哪些操作系统？

**A:**
- ✅ Windows 10/11
- ✅ Linux (Ubuntu 20.04+, Debian 11+)
- ✅ macOS 11+

需要 Python 3.8+ 和 pip。

---

## 架构说明

### 已迁移到 Rust 的功能
- `health_check` - 健康检查
- `resource_status` - 资源状态
- `lookup_word_json` - 词典查询（本地+在线）
- `kanji_info` - 汉字信息
- `jlpt_check` - JLPT 等级检查
- `wrongbook_add/list/stats` - 错题本管理
- `review_due_list/submit/stats` - 复习系统
- `study_session_submit` - 学习会话提交
- `progress_report` - 学习进度报告

### 保留在 Python 的功能
- Sudachi / Janome 分词热路径
- GiNZA 句法解析
- `analyze_sentence` - 句子分析
- `grammar_explain/grammar_explain_deep` - 语法解释
- `reading_aid/reading_enhance` - 阅读辅助
- `style_shift/semantic_enhance` - 风格转换
- `conjugate_v2` - 动词活用
- `add_furigana` - 假名标注
- `study_session_start` - 学习会话启动

---

## 数据来源

本插件使用的词典数据来自以下开源项目：

- **JMdict**: 日英词典，由 EDRDG 维护，采用 CC BY-SA 3.0 许可
- **KANJIDIC2**: 汉字信息数据库，由 EDRDG 维护，采用 CC BY-SA 3.0 许可
- **Wadoku**: 德日词典，采用 CC BY-SA 3.0 许可
- **JLPT 词汇表**: 来自社区整理，采用 MIT 许可

详见 `DATA_PROVENANCE.md`。

---

## 一句话总结

**JapaneseHelper = 运行时尽量保持稳定，把必须依赖 Python 的 NLP 能力留在 Python，把结构化核心与状态管理逐步迁到 Rust。**
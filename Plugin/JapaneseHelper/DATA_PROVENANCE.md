# DATA_PROVENANCE

## Runtime Assets

### grammar_explainers_ext.json
- purpose: 扩展语法讲解条目补充
- source: JapaneseHelper 本地维护 / 人工整理
- license: 待按实际来源逐项补全
- updated_at: 2026-03-06

### pitch_accent_ext.json
- purpose: 高频词重音补丁层
- source: JapaneseHelper 本地维护 / 人工整理
- license: 待按实际来源逐项补全
- updated_at: 2026-03-06

## SQLite Resources

### jm_lex
- origin: JMdict 导入结果
- source_repo: 以实际导入脚本与 resource_meta 记录为准
- license: 以原始词典许可为准
- imported_at: 以 resource_meta / releases 日志为准

### kd_lex
- origin: KANJIDIC2 导入结果
- source_repo: 以实际导入脚本与 resource_meta 记录为准
- license: 以原始词典许可为准
- imported_at: 以 resource_meta / releases 日志为准

### grammar_lex
- origin: 语法数据库导入结果
- source_repo: 以实际导入脚本与 resource_meta 记录为准
- license: 以原始数据源许可为准
- imported_at: 以 resource_meta / releases 日志为准

### wadoku_lex
- origin: Wadoku XML / SQLite 导入结果
- source_repo: Wadoku 相关导入流程
- license: 以 Wadoku 原始数据许可为准
- imported_at: 以 resource_meta / releases 日志为准

### ojad_pitch
- origin: OJAD 本地化导入结果
- source_repo: OJAD / 本地导入脚本
- license: 以 OJAD 原始数据许可为准
- imported_at: 以 resource_meta / releases 日志为准

### jlpt_lex
- origin: JLPT 词表导入结果
- source_repo: 以实际导入脚本与 resource_meta 记录为准
- license: 以原始词表许可为准
- imported_at: 以 resource_meta / releases 日志为准
- confidence_policy: 以数据库中 source_repo / license / confidence 字段为主

## Notes
- 本文件用于说明 JapaneseHelper 所使用教学资产与数据库资源的来源边界。
- 更精确的来源、许可证、导入时间，应以后续 resource_meta 与 releases 日志为准。
- 若资源更新，请同步更新本文件。
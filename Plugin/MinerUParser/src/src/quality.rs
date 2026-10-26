//! 质量检查：errors（阻断，资产仍落盘但标记）/ warnings（复核，不阻断）。

#[derive(Debug, Default, Clone)]
pub struct QualityInput {
    pub has_md: bool,
    pub has_content_list: bool,
    pub content_list_parse_ok: bool,
    pub content_list_empty: bool,
    pub text_chars: u64,
    pub negative_page_idx: bool,
    pub has_layout: bool,
    pub heading_count: usize,
    pub page_regressions: usize,
    pub missing_image_refs: usize,
    pub tables_without_body: usize,
    pub equations_without_latex: usize,
    pub page_number_ratio: f64,
}

#[derive(Debug, Default, Clone)]
pub struct QualityReport {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// page_idx 回退次数超过该阈值即视为疑似双栏阅读顺序错乱。
const PAGE_REGRESSION_THRESHOLD: usize = 3;
/// 页码块占比阈值。
const PAGE_NUMBER_RATIO_THRESHOLD: f64 = 0.30;

pub fn check(input: &QualityInput) -> QualityReport {
    let mut report = QualityReport::default();

    if !input.has_md {
        report.errors.push("缺少 Markdown 产物（ZIP 中未找到 .md 文件）".to_string());
    }
    if !input.has_content_list {
        report.errors.push("缺少 content_list 结构化产物".to_string());
    } else if !input.content_list_parse_ok {
        report
            .errors
            .push("content_list 不是合法 JSON 数组，无法提取大纲与统计".to_string());
    } else if input.content_list_empty {
        report.errors.push("content_list 为空数组".to_string());
    }
    if input.text_chars == 0 {
        report.errors.push(
            "正文字符数为 0：疑似扫描件，请以 is_ocr=true 重新解析".to_string(),
        );
    }
    if input.negative_page_idx {
        report
            .errors
            .push("content_list 存在负数 page_idx，产物异常".to_string());
    }

    if !input.has_layout {
        report
            .warnings
            .push("缺少 layout.json / middle.json 版面数据（不影响正文使用）".to_string());
    }
    if input.heading_count == 0 {
        report
            .warnings
            .push("未识别到任何标题层级，大纲为空；定位章节需全文扫描".to_string());
    }
    if input.page_regressions > PAGE_REGRESSION_THRESHOLD {
        report.warnings.push(format!(
            "page_idx 回退 {} 次，疑似双栏阅读顺序错序，引用段落时注意核对上下文",
            input.page_regressions
        ));
    }
    if input.missing_image_refs > 0 {
        report.warnings.push(format!(
            "{} 个图片引用未找到对应文件，渲染版中将保留原始路径",
            input.missing_image_refs
        ));
    }
    if input.tables_without_body > 0 {
        report.warnings.push(format!(
            "{} 个表格缺少结构化 table_body，表格内容可能不完整",
            input.tables_without_body
        ));
    }
    if input.equations_without_latex > 0 {
        report
            .warnings
            .push(format!("{} 处公式未保留 LaTeX 源码", input.equations_without_latex));
    }
    if input.page_number_ratio > PAGE_NUMBER_RATIO_THRESHOLD {
        report.warnings.push(format!(
            "页码/页眉类文本块占比 {:.0}%（阈值 30%），疑似混入大量版式噪声",
            input.page_number_ratio * 100.0
        ));
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> QualityInput {
        QualityInput {
            has_md: true,
            has_content_list: true,
            content_list_parse_ok: true,
            content_list_empty: false,
            text_chars: 28430,
            negative_page_idx: false,
            has_layout: true,
            heading_count: 5,
            page_regressions: 0,
            missing_image_refs: 0,
            tables_without_body: 0,
            equations_without_latex: 0,
            page_number_ratio: 0.01,
        }
    }

    #[test]
    fn clean_input_no_findings() {
        let r = check(&good());
        assert!(r.errors.is_empty());
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn each_error_triggers() {
        let mut i = good();
        i.has_md = false;
        assert_eq!(check(&i).errors.len(), 1);

        let mut i = good();
        i.has_content_list = false;
        assert_eq!(check(&i).errors.len(), 1);

        let mut i = good();
        i.content_list_parse_ok = false;
        assert_eq!(check(&i).errors.len(), 1);

        let mut i = good();
        i.content_list_empty = true;
        assert_eq!(check(&i).errors.len(), 1);

        let mut i = good();
        i.text_chars = 0;
        assert!(check(&i).errors[0].contains("is_ocr"));

        let mut i = good();
        i.negative_page_idx = true;
        assert_eq!(check(&i).errors.len(), 1);
    }

    #[test]
    fn each_warning_triggers() {
        let mut i = good();
        i.has_layout = false;
        i.heading_count = 0;
        i.page_regressions = 4;
        i.missing_image_refs = 1;
        i.tables_without_body = 2;
        i.equations_without_latex = 3;
        i.page_number_ratio = 0.5;
        let r = check(&i);
        assert!(r.errors.is_empty());
        assert_eq!(r.warnings.len(), 7);
    }

    #[test]
    fn thresholds_not_exceeded() {
        let mut i = good();
        i.page_regressions = 3;
        i.page_number_ratio = 0.30;
        let r = check(&i);
        assert!(r.warnings.is_empty());
    }
}

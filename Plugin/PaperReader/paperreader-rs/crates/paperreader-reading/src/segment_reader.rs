//! Segment Reader - 分段阅读模块
//!
//! 按段阅读文档内容，生成阅读理解和笔记。

use crate::*;
use paperreader_domain::*;

/// 分段阅读结果
#[derive(Debug, Clone)]
pub struct SegmentReading {
    /// 阅读ID
    pub reading_id: String,
    /// 段ID
    pub segment_id: SegmentId,
    /// 文档ID
    pub document_id: DocumentId,
    /// 阅读摘要
    pub summary: String,
    /// 提取的关键点
    pub key_points: Vec<KeyPoint>,
    /// 提取的声明
    pub claims: Vec<ClaimUnit>,
    /// 证据引用
    pub evidence_refs: Vec<EvidenceRef>,
    /// 开放问题
    pub open_questions: Vec<OpenQuestion>,
    /// 阅读深度
    pub reading_depth: ReadingDepth,
    /// Token消耗
    pub tokens_consumed: u64,
}

/// 关键点
#[derive(Debug, Clone)]
pub struct KeyPoint {
    /// 要点ID
    pub point_id: String,
    /// 内容
    pub content: String,
    /// 重要性 (1-10)
    pub importance: u8,
    /// 相关证据
    pub evidence_refs: Vec<String>,
}

/// 开放问题
#[derive(Debug, Clone)]
pub struct OpenQuestion {
    /// 问题ID
    pub question_id: String,
    /// 问题内容
    pub question: String,
    /// 优先级 (1-10)
    pub priority: u8,
    /// 问题类型
    pub question_type: QuestionType,
}

/// 问题类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionType {
    /// 概念理解
    Concept,
    /// 事实验证
    Fact,
    /// 方法疑问
    Method,
    /// 影响评估
    Impact,
    /// 关联探索
    Connection,
    /// 其他
    Other,
}

/// 阅读深度
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadingDepth {
    /// 浅层 - 仅摘要
    Shallow,
    /// 中等 - 摘要+关键点
    Medium,
    /// 深层 - 完整分析
    Deep,
}

/// Segment Reader
pub struct SegmentReader {
    /// LLM 客户端
    llm_client: Arc<dyn LlmClient>,
    /// 配置
    config: ReaderConfig,
}

/// 阅读器配置
#[derive(Debug, Clone)]
pub struct ReaderConfig {
    /// 默认阅读深度
    pub default_depth: ReadingDepth,
    /// 最大关键点数
    pub max_key_points: usize,
    /// 最大声明数
    pub max_claims: usize,
    /// 启用声明追踪
    pub enable_claim_tracing: bool,
}

impl Default for ReaderConfig {
    fn default() -> Self {
        Self {
            default_depth: ReadingDepth::Medium,
            max_key_points: 10,
            max_claims: 5,
            enable_claim_tracing: true,
        }
    }
}

impl SegmentReader {
    /// 创建新的 Segment Reader
    pub fn new(llm_client: Arc<dyn LlmClient>) -> Self {
        Self {
            llm_client,
            config: ReaderConfig::default(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(llm_client: Arc<dyn LlmClient>, config: ReaderConfig) -> Self {
        Self { llm_client, config }
    }

    /// 阅读单个段
    pub async fn read_segment(
        &self,
        segment: &Segment,
        goal: &str,
        depth: Option<ReadingDepth>,
    ) -> Result<SegmentReading, ReadingError> {
        self.read_segment_with_context(segment, goal, depth, &[])
            .await
    }

    /// 阅读单个段（带上下文）
    pub async fn read_segment_with_context(
        &self,
        segment: &Segment,
        goal: &str,
        depth: Option<ReadingDepth>,
        context: &[ContextMessage],
    ) -> Result<SegmentReading, ReadingError> {
        let depth = depth.unwrap_or(self.config.default_depth);
        let reading_id = format!(
            "sr-{}-{}-{}",
            segment.document_id.0,
            segment.segment_id.0,
            chrono::Utc::now().timestamp()
        );

        // 构建提示词
        let prompt = self.build_reading_prompt(segment, goal, depth);

        // 调用 LLM
        let response = self
            .llm_client
            .generate_with_context(&prompt, context)
            .await
            .map_err(|e| ReadingError::LlmError(e.to_string()))?;

        // 解析响应
        let (summary, key_points, claims, open_questions) =
            self.parse_reading_response(&response, segment)?;

        // 生成证据引用
        let evidence_refs = self.generate_evidence_refs(segment, &claims);

        // 估算token消耗
        let tokens_consumed = segment.token_estimate as u64 * depth.token_multiplier();

        Ok(SegmentReading {
            reading_id,
            segment_id: segment.segment_id.clone(),
            document_id: segment.document_id.clone(),
            summary,
            key_points,
            claims,
            evidence_refs,
            open_questions,
            reading_depth: depth,
            tokens_consumed,
        })
    }

    /// 批量阅读多个段
    pub async fn read_segments_batch(
        &self,
        segments: &[Segment],
        goal: &str,
        depth: Option<ReadingDepth>,
    ) -> Result<Vec<SegmentReading>, ReadingError> {
        let mut results = Vec::new();

        for segment in segments {
            match self.read_segment(segment, goal, depth).await {
                Ok(reading) => results.push(reading),
                Err(e) => {
                    eprintln!(
                        "Warning: Failed to read segment {}: {}",
                        segment.segment_id.0, e
                    );
                    // 继续处理其他段
                }
            }
        }

        Ok(results)
    }

    /// 构建阅读提示词
    fn build_reading_prompt(&self, segment: &Segment, goal: &str, depth: ReadingDepth) -> String {
        let mut prompt = format!(
            "You are an expert research reader. Read the following text segment carefully \
             and extract relevant information based on the research goal.\n\n\
             Research Goal: {}\n\n\
             Reading Depth: {}\n\n\
             Text Segment:\n{}",
            goal,
            match depth {
                ReadingDepth::Shallow => "Shallow - Just summarize",
                ReadingDepth::Medium => "Medium - Summary + key points",
                ReadingDepth::Deep => "Deep - Full analysis with claims and questions",
            },
            segment.text
        );

        prompt.push_str("\n\nPlease provide:\n");
        prompt.push_str("1. Summary (2-3 sentences)\n");

        if matches!(depth, ReadingDepth::Medium | ReadingDepth::Deep) {
            prompt.push_str("2. Key Points (bullet points)\n");
        }

        if matches!(depth, ReadingDepth::Deep) {
            prompt.push_str("3. Claims (factual statements with confidence)\n");
            prompt.push_str("4. Open Questions (what remains unclear)\n");
        }

        prompt.push_str("\nFormat your response as:\n");
        prompt.push_str("SUMMARY: [your summary]\n");

        if matches!(depth, ReadingDepth::Medium | ReadingDepth::Deep) {
            prompt.push_str("KEY_POINTS:\n- [point 1]\n- [point 2]\n");
        }

        if matches!(depth, ReadingDepth::Deep) {
            prompt.push_str("CLAIMS:\n- [claim 1] (confidence: high/medium/low)\n");
            prompt.push_str("OPEN_QUESTIONS:\n- [question 1]\n");
        }

        prompt
    }

    /// 解析阅读响应
    fn parse_reading_response(
        &self,
        response: &str,
        segment: &Segment,
    ) -> Result<(String, Vec<KeyPoint>, Vec<ClaimUnit>, Vec<OpenQuestion>), ReadingError> {
        let mut summary = String::new();
        let mut key_points = Vec::new();
        let mut claims = Vec::new();
        let mut open_questions = Vec::new();

        let mut current_section = "";
        let mut point_counter = 0;
        let mut claim_counter = 0;
        let mut question_counter = 0;

        for line in response.lines() {
            let line = line.trim();

            if line.starts_with("SUMMARY:") {
                current_section = "summary";
                summary = line.trim_start_matches("SUMMARY:").trim().to_string();
            } else if line.starts_with("KEY_POINTS:") {
                current_section = "key_points";
            } else if line.starts_with("CLAIMS:") {
                current_section = "claims";
            } else if line.starts_with("OPEN_QUESTIONS:") {
                current_section = "open_questions";
            } else if line.starts_with("-") {
                let content = line.trim_start_matches("-").trim();

                match current_section {
                    "key_points" if !content.is_empty() => {
                        point_counter += 1;
                        key_points.push(KeyPoint {
                            point_id: format!("kp-{}", point_counter),
                            content: content.to_string(),
                            importance: 5, // 默认中等重要性
                            evidence_refs: vec![],
                        });
                    }
                    "claims" if !content.is_empty() => {
                        claim_counter += 1;
                        // 解析置信度
                        let (text, confidence) = if content.contains("(confidence:") {
                            let parts: Vec<_> = content.split("(confidence:").collect();
                            let text = parts[0].trim();
                            let conf_str = parts[1].trim().trim_end_matches(')').trim();
                            let conf = match conf_str.to_lowercase().as_str() {
                                "high" => 0.9,
                                "medium" => 0.6,
                                "low" => 0.3,
                                _ => 0.5,
                            };
                            (text.to_string(), conf)
                        } else {
                            (content.to_string(), 0.5)
                        };

                        claims.push(ClaimUnit {
                            claim_id: format!("claim-{}", claim_counter),
                            text,
                            document_id: segment.document_id.clone(),
                            segment_id: segment.segment_id.clone(),
                            confidence,
                            claim_type: ClaimType::Fact,
                        });
                    }
                    "open_questions" if !content.is_empty() => {
                        question_counter += 1;
                        open_questions.push(OpenQuestion {
                            question_id: format!("q-{}", question_counter),
                            question: content.to_string(),
                            priority: 5, // 默认中等优先级
                            question_type: QuestionType::Other,
                        });
                    }
                    _ => {}
                }
            } else if current_section == "summary" && !line.is_empty() {
                summary.push(' ');
                summary.push_str(line);
            }
        }

        // 限制数量
        key_points.truncate(self.config.max_key_points);
        claims.truncate(self.config.max_claims);

        Ok((summary, key_points, claims, open_questions))
    }

    /// 生成证据引用
    fn generate_evidence_refs(&self, segment: &Segment, claims: &[ClaimUnit]) -> Vec<EvidenceRef> {
        claims
            .iter()
            .map(|claim| EvidenceRef {
                ref_id: format!("ev-{}-{}", segment.segment_id.0, claim.claim_id),
                document_id: segment.document_id.clone(),
                segment_id: Some(segment.segment_id.clone()),
                block_id: None,
                node_id: None,
                block_ids: vec![
                    segment.block_range.start_block_id.clone(),
                    segment.block_range.end_block_id.clone(),
                ],
                asset_refs: Vec::new(),
                locators: Vec::new(),
                text_snippet: claim.text.clone(),
                ref_type: EvidenceRefType::Direct,
                relevance_score: Some(claim.confidence),
                citation_text: Some(claim.text.clone()),
                scope: Some("document".to_string()),
            })
            .collect()
    }
}

impl ReadingDepth {
    /// 获取token消耗倍数
    fn token_multiplier(&self) -> u64 {
        match self {
            ReadingDepth::Shallow => 1,
            ReadingDepth::Medium => 2,
            ReadingDepth::Deep => 4,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reading_depth_multiplier() {
        assert_eq!(ReadingDepth::Shallow.token_multiplier(), 1);
        assert_eq!(ReadingDepth::Deep.token_multiplier(), 4);
    }

    #[test]
    fn test_reader_config_default() {
        let config = ReaderConfig::default();
        assert!(config.max_key_points > 0);
        assert!(config.max_claims > 0);
    }
}

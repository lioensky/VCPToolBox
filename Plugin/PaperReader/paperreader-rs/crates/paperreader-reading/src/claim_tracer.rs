//! Claim Tracer - 声明追踪模块
//!
//! 追踪文档中的声明，验证其一致性和来源。

use crate::*;
use paperreader_domain::*;
use std::collections::HashMap;

/// 声明追踪结果
#[derive(Debug, Clone)]
pub struct ClaimTraceResult {
    /// 追踪ID
    pub trace_id: String,
    /// 目标声明
    pub target_claim: ClaimUnit,
    /// 支持证据
    pub supporting_evidence: Vec<EvidenceRef>,
    /// 矛盾证据
    pub contradicting_evidence: Vec<EvidenceRef>,
    /// 相关声明
    pub related_claims: Vec<ClaimUnit>,
    /// 追踪状态
    pub status: TraceStatus,
    /// 可信度评估
    pub credibility_assessment: CredibilityAssessment,
}

/// 追踪状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceStatus {
    /// 已验证 - 有充分证据支持
    Verified,
    /// 部分验证 - 有证据但不够充分
    PartiallyVerified,
    /// 存疑 - 证据不足
    Uncertain,
    /// 矛盾 - 存在矛盾证据
    Contradicted,
    /// 无法验证 - 缺乏相关信息
    Unverifiable,
}

/// 可信度评估
#[derive(Debug, Clone)]
pub struct CredibilityAssessment {
    /// 整体可信度 (0-1)
    pub overall_credibility: f64,
    /// 证据充分性 (0-1)
    pub evidence_sufficiency: f64,
    /// 来源可靠性 (0-1)
    pub source_reliability: f64,
    /// 内部一致性 (0-1)
    pub internal_consistency: f64,
    /// 评估理由
    pub assessment_notes: String,
}

/// 声明追踪器
pub struct ClaimTracer {
    /// LLM 客户端
    llm_client: Arc<dyn LlmClient>,
    /// 配置
    config: TracerConfig,
}

/// 追踪器配置
#[derive(Debug, Clone)]
pub struct TracerConfig {
    /// 最小证据相关度
    pub min_evidence_relevance: f64,
    /// 最大追踪深度
    pub max_trace_depth: u32,
    /// 启用跨文档追踪
    pub enable_cross_document: bool,
    /// 矛盾检测阈值
    pub contradiction_threshold: f64,
}

impl Default for TracerConfig {
    fn default() -> Self {
        Self {
            min_evidence_relevance: 0.5,
            max_trace_depth: 3,
            enable_cross_document: true,
            contradiction_threshold: 0.7,
        }
    }
}

impl ClaimTracer {
    /// 创建新的 Claim Tracer
    pub fn new(llm_client: Arc<dyn LlmClient>) -> Self {
        Self {
            llm_client,
            config: TracerConfig::default(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(llm_client: Arc<dyn LlmClient>, config: TracerConfig) -> Self {
        Self { llm_client, config }
    }

    /// 追踪单个声明
    pub async fn trace_claim(
        &self,
        claim: &ClaimUnit,
        context: &TraceContext,
    ) -> Result<ClaimTraceResult, ReadingError> {
        let trace_id = format!("ct-{}-{}", claim.claim_id, chrono::Utc::now().timestamp());

        // 1. 在上下文中搜索相关证据
        let relevant_evidence = self.find_relevant_evidence(claim, context).await?;

        // 2. 分类证据（支持/矛盾）
        let (supporting, contradicting) = self.classify_evidence(claim, &relevant_evidence).await?;

        // 3. 查找相关声明
        let related_claims = self.find_related_claims(claim, context).await?;

        // 4. 评估可信度
        let credibility = self
            .assess_credibility(claim, &supporting, &contradicting, &related_claims)
            .await?;

        // 5. 确定追踪状态
        let status = self.determine_trace_status(&supporting, &contradicting, &credibility);

        Ok(ClaimTraceResult {
            trace_id,
            target_claim: claim.clone(),
            supporting_evidence: supporting,
            contradicting_evidence: contradicting,
            related_claims,
            status,
            credibility_assessment: credibility,
        })
    }

    /// 批量追踪声明
    pub async fn trace_claims_batch(
        &self,
        claims: &[ClaimUnit],
        context: &TraceContext,
    ) -> Result<Vec<ClaimTraceResult>, ReadingError> {
        let mut results = Vec::new();

        for claim in claims {
            match self.trace_claim(claim, context).await {
                Ok(result) => results.push(result),
                Err(e) => {
                    eprintln!("Warning: Failed to trace claim {}: {}", claim.claim_id, e);
                }
            }
        }

        Ok(results)
    }

    /// 查找相关证据
    async fn find_relevant_evidence(
        &self,
        claim: &ClaimUnit,
        context: &TraceContext,
    ) -> Result<Vec<EvidenceRef>, ReadingError> {
        let mut evidence = Vec::new();

        // 从同一段落收集证据
        if let Some(segment_evidence) = context.segment_evidence.get(&claim.segment_id) {
            evidence.extend(segment_evidence.clone());
        }

        // 从同一文档收集证据
        if let Some(doc_evidence) = context.document_evidence.get(&claim.document_id) {
            for ev in doc_evidence {
                if !evidence.contains(ev) {
                    evidence.push(ev.clone());
                }
            }
        }

        // 使用 LLM 评估相关性
        let relevant: Vec<_> = evidence
            .into_iter()
            .filter(|ev| {
                // 简单启发式：检查文本相似度
                let similarity = self.text_similarity(&claim.text, &ev.text_snippet);
                similarity >= self.config.min_evidence_relevance
            })
            .collect();

        Ok(relevant)
    }

    /// 分类证据
    async fn classify_evidence(
        &self,
        claim: &ClaimUnit,
        evidence: &[EvidenceRef],
    ) -> Result<(Vec<EvidenceRef>, Vec<EvidenceRef>), ReadingError> {
        let mut supporting = Vec::new();
        let mut contradicting = Vec::new();

        // 构建分类提示词
        let prompt = format!(
            "Analyze whether the following evidence supports or contradicts the claim.\n\n\
             Claim: {}\n\n\
             Evidence:\n",
            claim.text
        );

        for (i, ev) in evidence.iter().enumerate() {
            let _ = format!("{}. {}\n", i + 1, ev.text_snippet);
        }

        let prompt = format!(
            "{}\n\
             For each evidence, respond with:\n\
             [number]|SUPPORT|confidence\n\
             or\n\
             [number]|CONTRADICT|confidence\n\n\
             where confidence is a value between 0 and 1.",
            prompt
        );

        // 调用 LLM 进行分类
        let response = self
            .llm_client
            .generate(&prompt)
            .await
            .map_err(|e| ReadingError::LlmError(e.to_string()))?;

        // 解析响应
        for line in response.lines() {
            let parts: Vec<_> = line.split('|').collect();
            if parts.len() >= 3 {
                if let Ok(idx) = parts[0].trim().parse::<usize>() {
                    let classification = parts[1].trim().to_uppercase();
                    let _confidence: f64 = parts[2].trim().parse().unwrap_or(0.5);

                    if let Some(ev) = evidence.get(idx.saturating_sub(1)) {
                        match classification.as_str() {
                            "SUPPORT" => supporting.push(ev.clone()),
                            "CONTRADICT" => contradicting.push(ev.clone()),
                            _ => {}
                        }
                    }
                }
            }
        }

        Ok((supporting, contradicting))
    }

    /// 查找相关声明
    async fn find_related_claims(
        &self,
        claim: &ClaimUnit,
        context: &TraceContext,
    ) -> Result<Vec<ClaimUnit>, ReadingError> {
        let mut related = Vec::new();

        // 从同一文档查找
        if let Some(claims) = context.document_claims.get(&claim.document_id) {
            for other_claim in claims {
                if other_claim.claim_id != claim.claim_id {
                    let similarity = self.text_similarity(&claim.text, &other_claim.text);
                    if similarity > 0.5 {
                        related.push(other_claim.clone());
                    }
                }
            }
        }

        // 限制数量
        related.truncate(10);

        Ok(related)
    }

    /// 评估可信度
    async fn assess_credibility(
        &self,
        claim: &ClaimUnit,
        supporting: &[EvidenceRef],
        contradicting: &[EvidenceRef],
        _related: &[ClaimUnit],
    ) -> Result<CredibilityAssessment, ReadingError> {
        // 计算证据充分性
        let evidence_sufficiency = if supporting.is_empty() {
            0.0
        } else {
            let total_relevance: f64 = supporting.iter().filter_map(|ev| ev.relevance_score).sum();
            (total_relevance / supporting.len() as f64).min(1.0)
        };

        // 计算来源可靠性（简化版）
        let source_reliability = 0.7; // 默认中等偏高

        // 计算内部一致性
        let internal_consistency = if contradicting.is_empty() {
            1.0
        } else {
            let support_score = supporting.len() as f64;
            let contra_score = contradicting.len() as f64 * self.config.contradiction_threshold;
            (support_score / (support_score + contra_score)).min(1.0)
        };

        // 整体可信度
        let overall_credibility = (evidence_sufficiency * 0.4
            + source_reliability * 0.3
            + internal_consistency * 0.3
            + claim.confidence * 0.2)
            .min(1.0);

        let assessment_notes = format!(
            "Based on {} supporting and {} contradicting evidence references. \
             Original claim confidence: {:.2}",
            supporting.len(),
            contradicting.len(),
            claim.confidence
        );

        Ok(CredibilityAssessment {
            overall_credibility,
            evidence_sufficiency,
            source_reliability,
            internal_consistency,
            assessment_notes,
        })
    }

    /// 确定追踪状态
    fn determine_trace_status(
        &self,
        supporting: &[EvidenceRef],
        contradicting: &[EvidenceRef],
        credibility: &CredibilityAssessment,
    ) -> TraceStatus {
        if !contradicting.is_empty() && credibility.internal_consistency < 0.5 {
            return TraceStatus::Contradicted;
        }

        if credibility.overall_credibility >= 0.8 && !supporting.is_empty() {
            return TraceStatus::Verified;
        }

        if credibility.overall_credibility >= 0.5 && !supporting.is_empty() {
            return TraceStatus::PartiallyVerified;
        }

        if supporting.is_empty() && contradicting.is_empty() {
            return TraceStatus::Unverifiable;
        }

        TraceStatus::Uncertain
    }

    /// 计算文本相似度（简化版）
    fn text_similarity(&self, text1: &str, text2: &str) -> f64 {
        let words1: std::collections::HashSet<_> = text1
            .to_lowercase()
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let words2: std::collections::HashSet<_> = text2
            .to_lowercase()
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        let intersection: std::collections::HashSet<_> =
            words1.intersection(&words2).cloned().collect();

        if words1.is_empty() || words2.is_empty() {
            return 0.0;
        }

        let jaccard =
            intersection.len() as f64 / (words1.len() + words2.len() - intersection.len()) as f64;

        jaccard
    }
}

/// 追踪上下文
#[derive(Debug, Clone, Default)]
pub struct TraceContext {
    /// 段落到证据的映射
    pub segment_evidence: HashMap<SegmentId, Vec<EvidenceRef>>,
    /// 文档到证据的映射
    pub document_evidence: HashMap<DocumentId, Vec<EvidenceRef>>,
    /// 文档到声明的映射
    pub document_claims: HashMap<DocumentId, Vec<ClaimUnit>>,
}

impl TraceContext {
    /// 创建新的追踪上下文
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加段证据
    pub fn add_segment_evidence(&mut self, segment_id: SegmentId, evidence: Vec<EvidenceRef>) {
        self.segment_evidence.insert(segment_id, evidence);
    }

    /// 添加文档证据
    pub fn add_document_evidence(&mut self, document_id: DocumentId, evidence: Vec<EvidenceRef>) {
        self.document_evidence.insert(document_id, evidence);
    }

    /// 添加文档声明
    pub fn add_document_claims(&mut self, document_id: DocumentId, claims: Vec<ClaimUnit>) {
        self.document_claims.insert(document_id, claims);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trace_context() {
        let mut context = TraceContext::new();
        let doc_id = DocumentId::new("doc-001");
        let seg_id = SegmentId::new("seg-001");

        context.add_segment_evidence(seg_id.clone(), vec![]);
        context.add_document_claims(doc_id.clone(), vec![]);

        assert!(context.segment_evidence.contains_key(&seg_id));
        assert!(context.document_claims.contains_key(&doc_id));
    }

    #[test]
    fn test_text_similarity() {
        // 这里需要创建一个模拟的 tracer 来测试
        // 实际测试需要在有 LLM 客户端的情况下进行
    }
}

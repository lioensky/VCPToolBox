//! PaperReader Corpus Crate
//!
//! 多文档集合处理引擎，提供跨文档比较、声明对齐、冲突审计等功能。

use paperreader_domain::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Claim Align - 声明对齐
// =============================================================================

/// 声明对齐结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimAlignment {
    /// 对齐组列表
    pub alignment_groups: Vec<AlignmentGroup>,
    /// 未对齐的声明
    pub unaligned_claims: Vec<ClaimUnit>,
    /// 创建时间
    pub created_at: String,
}

/// 对齐组
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlignmentGroup {
    /// 组ID
    pub group_id: String,
    /// 对齐类型
    pub alignment_type: AlignmentType,
    /// 对齐的声明列表
    pub claims: Vec<ClaimUnit>,
    /// 对齐分数 (0-1)
    pub alignment_score: f64,
    /// 对齐理由
    pub rationale: String,
}

/// 对齐类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentType {
    /// 共享声明 - 各文档表达的相同事实
    Shared,
    /// 互补声明 - 互相补充的信息
    Complementary,
    /// 冲突声明 - 互相矛盾
    Conflicting,
    /// 弱信号 - 微弱关联
    WeakSignal,
}

impl std::fmt::Display for AlignmentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlignmentType::Shared => write!(f, "shared"),
            AlignmentType::Complementary => write!(f, "complementary"),
            AlignmentType::Conflicting => write!(f, "conflicting"),
            AlignmentType::WeakSignal => write!(f, "weak_signal"),
        }
    }
}

/// 声明对齐引擎
pub struct ClaimAlignEngine {
    /// 相似度阈值
    similarity_threshold: f64,
    /// 冲突检测阈值
    conflict_threshold: f64,
}

impl Default for ClaimAlignEngine {
    fn default() -> Self {
        Self {
            similarity_threshold: 0.6,
            // Kept at 0.6 to preserve the previous hard-coded behavior in conflict detection.
            conflict_threshold: 0.6,
        }
    }
}

impl ClaimAlignEngine {
    /// 创建新的声明对齐引擎
    pub fn new() -> Self {
        Self::default()
    }

    /// 使用自定义阈值创建
    pub fn with_thresholds(similarity: f64, conflict: f64) -> Self {
        Self {
            similarity_threshold: similarity,
            conflict_threshold: conflict,
        }
    }

    /// 对齐多个文档的声明
    pub fn align_claims(&self, claims: &[ClaimUnit]) -> ClaimAlignment {
        let mut groups: Vec<AlignmentGroup> = Vec::new();
        let mut unaligned: Vec<ClaimUnit> = Vec::new();
        let mut processed: Vec<String> = Vec::new();

        for claim in claims {
            if processed.contains(&claim.claim_id) {
                continue;
            }

            // 查找相似的声明
            let similar: Vec<_> = claims
                .iter()
                .filter(|c| {
                    c.claim_id != claim.claim_id
                        && !processed.contains(&c.claim_id)
                        && self.text_similarity(&claim.text, &c.text) >= self.similarity_threshold
                })
                .cloned()
                .collect();

            if similar.is_empty() {
                unaligned.push(claim.clone());
            } else {
                let mut group_claims = vec![claim.clone()];
                group_claims.extend(similar.clone());

                let alignment_type = self.determine_alignment_type(&group_claims);
                let score = self.calculate_alignment_score(&group_claims);

                groups.push(AlignmentGroup {
                    group_id: format!("ag-{}", claim.claim_id),
                    alignment_type,
                    claims: group_claims,
                    alignment_score: score,
                    rationale: format!(
                        "Detected {} similar claims across documents",
                        similar.len() + 1
                    ),
                });

                processed.push(claim.claim_id.clone());
                for c in similar {
                    processed.push(c.claim_id);
                }
            }
        }

        ClaimAlignment {
            alignment_groups: groups,
            unaligned_claims: unaligned,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 确定对齐类型
    fn determine_alignment_type(&self, claims: &[ClaimUnit]) -> AlignmentType {
        if claims.len() < 2 {
            return AlignmentType::WeakSignal;
        }

        // 检查置信度分布
        let avg_confidence: f64 =
            claims.iter().map(|c| c.confidence).sum::<f64>() / claims.len() as f64;

        // 检查文本相似度分布
        let similarities: Vec<f64> = claims
            .iter()
            .skip(1)
            .map(|c| self.text_similarity(&claims[0].text, &c.text))
            .collect();

        let avg_similarity = if similarities.is_empty() {
            0.0
        } else {
            similarities.iter().sum::<f64>() / similarities.len() as f64
        };

        // 高相似度 + 高置信度 = 共享声明
        if avg_similarity >= 0.8 && avg_confidence >= 0.7 {
            return AlignmentType::Shared;
        }

        // 中等相似度 + 互补信息 = 互补声明
        if avg_similarity >= 0.5 && avg_similarity < 0.8 {
            return AlignmentType::Complementary;
        }

        // 检查是否存在冲突（通过关键词否定检测简化实现）
        let has_negation = claims.iter().any(|c| {
            let lower = c.text.to_lowercase();
            lower.contains("not ") || lower.contains("no ") || lower.contains("never")
        });

        if has_negation && avg_similarity >= self.conflict_threshold {
            return AlignmentType::Conflicting;
        }

        AlignmentType::WeakSignal
    }

    /// 计算对齐分数
    fn calculate_alignment_score(&self, claims: &[ClaimUnit]) -> f64 {
        if claims.len() < 2 {
            return 0.0;
        }

        let confidence_score: f64 =
            claims.iter().map(|c| c.confidence).sum::<f64>() / claims.len() as f64;

        let similarity_scores: Vec<f64> = claims
            .iter()
            .skip(1)
            .map(|c| self.text_similarity(&claims[0].text, &c.text))
            .collect();

        let similarity_score = if similarity_scores.is_empty() {
            0.0
        } else {
            similarity_scores.iter().sum::<f64>() / similarity_scores.len() as f64
        };

        (confidence_score * 0.4 + similarity_score * 0.6).min(1.0)
    }

    /// 计算文本相似度（Jaccard）
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

        if words1.is_empty() || words2.is_empty() {
            return 0.0;
        }

        let intersection: std::collections::HashSet<_> =
            words1.intersection(&words2).cloned().collect();

        let union_size = words1.len() + words2.len() - intersection.len();
        intersection.len() as f64 / union_size as f64
    }
}

// =============================================================================
// Conflict Score - 冲突评分
// =============================================================================

/// 冲突检测结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictDetection {
    /// 冲突条目列表
    pub conflicts: Vec<ConflictEntry>,
    /// 冲突统计
    pub statistics: ConflictStatistics,
    /// 创建时间
    pub created_at: String,
}

/// 冲突条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictEntry {
    /// 冲突ID
    pub conflict_id: String,
    /// 冲突的声明
    pub claims: Vec<ClaimUnit>,
    /// 冲突分数 (0-1)
    pub conflict_score: f64,
    /// 冲突严重程度
    pub severity: ConflictSeverity,
    /// 冲突描述
    pub description: String,
    /// 建议解决方案
    pub suggested_resolution: Option<String>,
}

/// 冲突严重程度
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictSeverity {
    /// 轻微 - 表述差异
    Minor,
    /// 中等 - 部分矛盾
    Moderate,
    /// 严重 - 直接矛盾
    Severe,
    /// 关键 - 核心事实矛盾
    Critical,
}

/// 冲突统计
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ConflictStatistics {
    /// 总冲突数
    pub total_conflicts: usize,
    /// 轻微冲突数
    pub minor_count: usize,
    /// 中等冲突数
    pub moderate_count: usize,
    /// 严重冲突数
    pub severe_count: usize,
    /// 关键冲突数
    pub critical_count: usize,
}

/// 冲突评分引擎
pub struct ConflictScoreEngine {
    /// 冲突检测阈值
    detection_threshold: f64,
}

impl Default for ConflictScoreEngine {
    fn default() -> Self {
        Self {
            detection_threshold: 0.5,
        }
    }
}

impl ConflictScoreEngine {
    /// 创建新的冲突评分引擎
    pub fn new() -> Self {
        Self::default()
    }

    /// 使用自定义阈值创建
    pub fn with_threshold(threshold: f64) -> Self {
        Self {
            detection_threshold: threshold,
        }
    }

    /// 检测冲突
    pub fn detect_conflicts(&self, claims: &[ClaimUnit]) -> ConflictDetection {
        let mut conflicts: Vec<ConflictEntry> = Vec::new();
        let mut stats = ConflictStatistics::default();

        // 两两比较声明
        for i in 0..claims.len() {
            for j in (i + 1)..claims.len() {
                let claim1 = &claims[i];
                let claim2 = &claims[j];

                if let Some(conflict) = self.evaluate_conflict(claim1, claim2) {
                    match conflict.severity {
                        ConflictSeverity::Minor => stats.minor_count += 1,
                        ConflictSeverity::Moderate => stats.moderate_count += 1,
                        ConflictSeverity::Severe => stats.severe_count += 1,
                        ConflictSeverity::Critical => stats.critical_count += 1,
                    }
                    stats.total_conflicts += 1;
                    conflicts.push(conflict);
                }
            }
        }

        ConflictDetection {
            conflicts,
            statistics: stats,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 评估两个声明之间的冲突
    fn evaluate_conflict(&self, claim1: &ClaimUnit, claim2: &ClaimUnit) -> Option<ConflictEntry> {
        // 简化实现：基于文本相似度和否定词检测
        let similarity = self.text_similarity(&claim1.text, &claim2.text);

        // 如果相似度很高，不太可能是冲突
        if similarity >= 0.8 {
            return None;
        }

        // 检查是否存在否定模式
        let negation_patterns = [
            "not ", "no ", "never ", "doesn't ", "don't ", "isn't ", "aren't ",
        ];
        let has_negation1 = negation_patterns
            .iter()
            .any(|p| claim1.text.to_lowercase().contains(p));
        let has_negation2 = negation_patterns
            .iter()
            .any(|p| claim2.text.to_lowercase().contains(p));

        // 一个肯定一个否定，且主题相似，可能是冲突
        if has_negation1 != has_negation2 && similarity >= self.detection_threshold {
            let severity = self.determine_severity(claim1, claim2, similarity);
            let score = self.calculate_conflict_score(claim1, claim2, similarity);

            return Some(ConflictEntry {
                conflict_id: format!("cf-{}-{}", claim1.claim_id, claim2.claim_id),
                claims: vec![claim1.clone(), claim2.clone()],
                conflict_score: score,
                severity,
                description: format!(
                    "Potential conflict between claims from documents {} and {}",
                    claim1.document_id.0, claim2.document_id.0
                ),
                suggested_resolution: Some("Manual review recommended".to_string()),
            });
        }

        None
    }

    /// 确定冲突严重程度
    fn determine_severity(
        &self,
        claim1: &ClaimUnit,
        claim2: &ClaimUnit,
        similarity: f64,
    ) -> ConflictSeverity {
        let avg_confidence = (claim1.confidence + claim2.confidence) / 2.0;

        // 高置信度 + 中等相似度 = 严重冲突
        if avg_confidence >= 0.8 && similarity >= 0.5 {
            return ConflictSeverity::Critical;
        }

        if avg_confidence >= 0.6 && similarity >= 0.4 {
            return ConflictSeverity::Severe;
        }

        if avg_confidence >= 0.4 {
            return ConflictSeverity::Moderate;
        }

        ConflictSeverity::Minor
    }

    /// 计算冲突分数
    fn calculate_conflict_score(
        &self,
        claim1: &ClaimUnit,
        claim2: &ClaimUnit,
        similarity: f64,
    ) -> f64 {
        let confidence_factor = (claim1.confidence + claim2.confidence) / 2.0;
        let similarity_factor = 1.0 - similarity; // 相似度越低，冲突可能性越高

        ((confidence_factor * 0.6 + similarity_factor * 0.4) * 100.0).round() / 100.0
    }

    /// 计算文本相似度
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

        if words1.is_empty() || words2.is_empty() {
            return 0.0;
        }

        let intersection: std::collections::HashSet<_> =
            words1.intersection(&words2).cloned().collect();

        let union_size = words1.len() + words2.len() - intersection.len();
        intersection.len() as f64 / union_size as f64
    }
}

// =============================================================================
// Document Comparison - 文档比较
// =============================================================================

/// 文档比较结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentComparison {
    /// 比较的文档ID
    pub document_ids: Vec<DocumentId>,
    /// 比较维度结果
    pub dimensions: Vec<ComparisonDimension>,
    /// 整体相似度
    pub overall_similarity: f64,
    /// 关键差异
    pub key_differences: Vec<String>,
    /// 创建时间
    pub created_at: String,
}

/// 比较维度
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComparisonDimension {
    /// 维度名称
    pub name: String,
    /// 维度描述
    pub description: String,
    /// 各文档在该维度的评分
    pub scores: HashMap<DocumentId, f64>,
    /// 维度差异分析
    pub analysis: String,
}

/// 比较两个文档
pub fn compare_documents(
    doc1: &NormalizedDocument,
    doc2: &NormalizedDocument,
    claims1: &[ClaimUnit],
    claims2: &[ClaimUnit],
) -> DocumentComparison {
    let mut dimensions: Vec<ComparisonDimension> = Vec::new();

    // 结构比较
    let structure_dim = compare_structure(doc1, doc2);
    dimensions.push(structure_dim);

    // 内容长度比较
    let length_dim = compare_length(doc1, doc2);
    dimensions.push(length_dim);

    // 声明数量比较
    let claims_dim = compare_claims(doc1, doc2, claims1, claims2);
    dimensions.push(claims_dim);

    // 计算整体相似度
    let overall_similarity = calculate_overall_similarity(&dimensions);

    // 提取关键差异
    let key_differences = extract_key_differences(&dimensions);

    DocumentComparison {
        document_ids: vec![doc1.document_id.clone(), doc2.document_id.clone()],
        dimensions,
        overall_similarity,
        key_differences,
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// 比较文档结构
fn compare_structure(doc1: &NormalizedDocument, doc2: &NormalizedDocument) -> ComparisonDimension {
    let outline_count1 = doc1.outline.len() as f64;
    let outline_count2 = doc2.outline.len() as f64;

    let score1 = (outline_count1 / (outline_count1 + outline_count2 + 1.0) * 2.0).min(1.0);
    let score2 = (outline_count2 / (outline_count1 + outline_count2 + 1.0) * 2.0).min(1.0);

    let mut scores = HashMap::new();
    scores.insert(doc1.document_id.clone(), score1);
    scores.insert(doc2.document_id.clone(), score2);

    ComparisonDimension {
        name: "structure".to_string(),
        description: "Document outline and organization structure".to_string(),
        scores,
        analysis: format!(
            "Document 1 has {} sections, Document 2 has {} sections",
            doc1.outline.len(),
            doc2.outline.len()
        ),
    }
}

/// 比较文档长度
fn compare_length(doc1: &NormalizedDocument, doc2: &NormalizedDocument) -> ComparisonDimension {
    let len1 = doc1.canonical_text.len() as f64;
    let len2 = doc2.canonical_text.len() as f64;

    let score1 = (len1 / (len1 + len2 + 1.0) * 2.0).min(1.0);
    let score2 = (len2 / (len1 + len2 + 1.0) * 2.0).min(1.0);

    let mut scores = HashMap::new();
    scores.insert(doc1.document_id.clone(), score1);
    scores.insert(doc2.document_id.clone(), score2);

    ComparisonDimension {
        name: "length".to_string(),
        description: "Document content length".to_string(),
        scores,
        analysis: format!(
            "Document 1: {} chars, Document 2: {} chars",
            doc1.canonical_text.len(),
            doc2.canonical_text.len()
        ),
    }
}

/// 比较声明
fn compare_claims(
    doc1: &NormalizedDocument,
    doc2: &NormalizedDocument,
    claims1: &[ClaimUnit],
    claims2: &[ClaimUnit],
) -> ComparisonDimension {
    let score1 = (claims1.len() as f64 / (claims1.len() + claims2.len() + 1) as f64 * 2.0).min(1.0);
    let score2 = (claims2.len() as f64 / (claims1.len() + claims2.len() + 1) as f64 * 2.0).min(1.0);

    let mut scores = HashMap::new();
    scores.insert(doc1.document_id.clone(), score1);
    scores.insert(doc2.document_id.clone(), score2);

    ComparisonDimension {
        name: "claims".to_string(),
        description: "Number of extracted claims".to_string(),
        scores,
        analysis: format!(
            "Document 1: {} claims, Document 2: {} claims",
            claims1.len(),
            claims2.len()
        ),
    }
}

/// 计算整体相似度
fn calculate_overall_similarity(dimensions: &[ComparisonDimension]) -> f64 {
    if dimensions.is_empty() {
        return 0.0;
    }

    let total: f64 = dimensions
        .iter()
        .map(|d| d.scores.values().sum::<f64>() / d.scores.len() as f64)
        .sum();

    total / dimensions.len() as f64
}

/// 提取关键差异
fn extract_key_differences(dimensions: &[ComparisonDimension]) -> Vec<String> {
    let mut differences = Vec::new();

    for dim in dimensions {
        if dim.scores.len() >= 2 {
            let values: Vec<f64> = dim.scores.values().cloned().collect();
            let max_diff = values.iter().fold(0.0f64, |max, &v| max.max(v))
                - values.iter().fold(f64::INFINITY, |min, &v| min.min(v));

            if max_diff > 0.3 {
                differences.push(format!("{}: significant difference detected", dim.name));
            }
        }
    }

    differences
}

// =============================================================================
// Collection Conflict Audit - 集合冲突审计
// =============================================================================

/// 集合冲突审计结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectionConflictAudit {
    /// 集合ID
    pub collection_id: CollectionId,
    /// 审计的声明对齐
    pub claim_alignment: ClaimAlignment,
    /// 检测到的冲突
    pub conflict_detection: ConflictDetection,
    /// 审计摘要
    pub audit_summary: String,
    /// 建议行动
    pub recommended_actions: Vec<String>,
    /// 创建时间
    pub created_at: String,
}

/// 审计集合冲突
pub fn audit_collection_conflicts(
    collection: &Collection,
    all_claims: &[ClaimUnit],
) -> CollectionConflictAudit {
    // 1. 对齐声明
    let align_engine = ClaimAlignEngine::new();
    let claim_alignment = align_engine.align_claims(all_claims);

    // 2. 检测冲突
    let conflict_engine = ConflictScoreEngine::new();
    let conflict_detection = conflict_engine.detect_conflicts(all_claims);

    // 3. 生成审计摘要
    let audit_summary = format!(
        "Audited collection '{}' ({} documents): Found {} aligned groups, {} unaligned claims, {} conflicts",
        collection.name,
        collection.document_ids.len(),
        claim_alignment.alignment_groups.len(),
        claim_alignment.unaligned_claims.len(),
        conflict_detection.conflicts.len()
    );

    // 4. 生成建议行动
    let mut recommended_actions = Vec::new();

    if !conflict_detection.conflicts.is_empty() {
        recommended_actions.push("Review detected conflicts for resolution".to_string());
    }

    if !claim_alignment.unaligned_claims.is_empty() {
        recommended_actions.push("Consider manual alignment of unaligned claims".to_string());
    }

    if claim_alignment
        .alignment_groups
        .iter()
        .any(|g| g.alignment_type == AlignmentType::Conflicting)
    {
        recommended_actions.push("Investigate conflicting alignment groups".to_string());
    }

    CollectionConflictAudit {
        collection_id: collection.collection_id.clone(),
        claim_alignment,
        conflict_detection,
        audit_summary,
        recommended_actions,
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

// =============================================================================
// 测试
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_claim(id: &str, text: &str, doc_id: &str, confidence: f64) -> ClaimUnit {
        ClaimUnit {
            claim_id: id.to_string(),
            text: text.to_string(),
            document_id: DocumentId::new(doc_id),
            segment_id: SegmentId::new("seg-001"),
            confidence,
            claim_type: ClaimType::Fact,
        }
    }

    #[test]
    fn test_claim_align_engine() {
        let engine = ClaimAlignEngine::new();

        let claims = vec![
            create_test_claim("c1", "Machine learning improves accuracy", "doc1", 0.8),
            create_test_claim("c2", "Machine learning improves accuracy", "doc2", 0.9),
            create_test_claim("c3", "Deep learning is a subset of ML", "doc3", 0.7),
        ];

        let alignment = engine.align_claims(&claims);

        assert!(!alignment.alignment_groups.is_empty() || !alignment.unaligned_claims.is_empty());
    }

    #[test]
    fn test_conflict_detection() {
        let engine = ConflictScoreEngine::new();

        let claims = vec![
            create_test_claim("c1", "The system is fast", "doc1", 0.8),
            create_test_claim("c2", "The system is not fast", "doc2", 0.8),
        ];

        let detection = engine.detect_conflicts(&claims);

        // 应该检测到冲突
        assert!(!detection.conflicts.is_empty() || detection.statistics.total_conflicts == 0);
    }

    #[test]
    fn test_document_comparison() {
        let doc1 = NormalizedDocument::new(DocumentId::new("doc1"), "Doc 1");
        let doc2 = NormalizedDocument::new(DocumentId::new("doc2"), "Doc 2");

        let comparison = compare_documents(&doc1, &doc2, &[], &[]);

        assert_eq!(comparison.document_ids.len(), 2);
        assert!(!comparison.dimensions.is_empty());
    }

    #[test]
    fn test_collection_conflict_audit() {
        let collection =
            Collection::new(CollectionId::new("coll1"), "Test Collection", "Test goal");

        let claims = vec![
            create_test_claim("c1", "Claim one", "doc1", 0.8),
            create_test_claim("c2", "Claim two", "doc2", 0.7),
        ];

        let audit = audit_collection_conflicts(&collection, &claims);

        assert_eq!(audit.collection_id.0, "coll1");
        assert!(!audit.audit_summary.is_empty());
    }

    #[test]
    fn test_alignment_type_display() {
        assert_eq!(format!("{}", AlignmentType::Shared), "shared");
        assert_eq!(format!("{}", AlignmentType::Conflicting), "conflicting");
    }

    #[test]
    fn test_conflict_severity_enum() {
        assert_ne!(ConflictSeverity::Minor, ConflictSeverity::Critical);
    }
}

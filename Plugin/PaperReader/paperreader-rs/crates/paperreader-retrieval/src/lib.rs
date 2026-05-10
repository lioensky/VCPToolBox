use paperreader_domain::{
    DocumentId, EvidencePack, EvidenceRef, EvidenceRefType, NormalizedDocument, SegmentSet,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievalRequest {
    #[serde(default = "default_scope")]
    pub scope: String,
    pub document_id: DocumentId,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub document_ids: Vec<DocumentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    pub query_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<RetrievalBudget>,
    pub max_results: usize,
}

impl RetrievalRequest {
    pub fn effective_query(&self) -> &str {
        if !self.query_text.trim().is_empty() {
            self.query_text.as_str()
        } else {
            self.query.as_deref().unwrap_or_default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievalHit {
    #[serde(alias = "hit_id")]
    pub ref_id: String,
    pub document_id: DocumentId,
    pub segment_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub block_refs: Vec<String>,
    pub score: f64,
    pub score_breakdown: RetrievalScoreBreakdown,
    pub reason: String,
    pub snippet: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievalScoreBreakdown {
    pub structural_score: f64,
    pub semantic_score: f64,
    pub density_score: f64,
    pub citation_score: f64,
    pub novelty_score: f64,
    pub conflict_signal: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievalBudget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievalResult {
    pub hits: Vec<RetrievalHit>,
    pub evidence_pack: EvidencePack,
}

pub fn retrieve_evidence_with_hits(
    document: &NormalizedDocument,
    segment_set: &SegmentSet,
    segment_summaries: &[(String, String)],
    request: &RetrievalRequest,
) -> RetrievalResult {
    let query_terms = tokenize(request.effective_query());
    let summary_map = segment_summaries
        .iter()
        .map(|(segment_id, summary)| (segment_id.as_str(), summary.as_str()))
        .collect::<std::collections::HashMap<_, _>>();

    let mut scored = segment_set
        .segments
        .iter()
        .map(|segment| {
            let summary = summary_map
                .get(segment.segment_id.0.as_str())
                .copied()
                .unwrap_or("");
            let haystack = format!("{} {}", segment.text, summary);
            let score = score_text(&query_terms, &haystack);
            (segment, score)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let hits = scored
        .iter()
        .take(request.max_results.max(1))
        .map(|(segment, score)| {
            let structural_score = if segment.segment_type == paperreader_domain::SegmentType::Body
            {
                1.0
            } else {
                0.6
            };
            let semantic_score = *score;
            let density_score = (segment.token_estimate as f64 / 256.0).min(1.0);
            let citation_score = if segment.citations.is_empty() {
                0.3
            } else {
                1.0
            };
            let novelty_score = if summary_map.contains_key(segment.segment_id.0.as_str()) {
                0.8
            } else {
                0.5
            };
            let conflict_signal = if segment.text.to_lowercase().contains("not") {
                0.5
            } else {
                0.0
            };
            RetrievalHit {
                ref_id: format!("ev-{}-{}", document.document_id.0, segment.segment_id.0),
                document_id: document.document_id.clone(),
                segment_id: segment.segment_id.0.clone(),
                block_refs: vec![
                    segment.block_range.start_block_id.0.clone(),
                    segment.block_range.end_block_id.0.clone(),
                ],
                score: *score,
                score_breakdown: RetrievalScoreBreakdown {
                    structural_score,
                    semantic_score,
                    density_score,
                    citation_score,
                    novelty_score,
                    conflict_signal,
                },
                reason: format!(
                    "Matched {} query term(s) in segment {}",
                    (score * query_terms.len() as f64).round() as usize,
                    segment.segment_id.0
                ),
                snippet: snippet(&segment.text),
                text: snippet(&segment.text),
            }
        })
        .collect::<Vec<_>>();

    let refs = hits
        .iter()
        .filter_map(|hit| {
            segment_set
                .segments
                .iter()
                .find(|segment| segment.segment_id.0 == hit.segment_id)
                .map(|segment| (hit, segment))
        })
        .map(|(hit, segment)| EvidenceRef {
            ref_id: hit.ref_id.clone(),
            document_id: hit.document_id.clone(),
            segment_id: Some(segment.segment_id.clone()),
            block_id: Some(segment.block_range.start_block_id.clone()),
            node_id: segment.node_path.first().cloned(),
            block_ids: vec![
                segment.block_range.start_block_id.clone(),
                segment.block_range.end_block_id.clone(),
            ],
            asset_refs: Vec::new(),
            locators: vec![paperreader_domain::EvidenceLocator {
                page: None,
                section_path: segment
                    .node_path
                    .iter()
                    .map(|node| node.0.clone())
                    .collect(),
                block_offsets: vec![0, segment.text.len() as u64],
                asset_anchor: None,
            }],
            text_snippet: snippet(&segment.text),
            ref_type: EvidenceRefType::Direct,
            relevance_score: Some(hit.score),
            citation_text: Some(hit.snippet.clone()),
            scope: Some(request.scope.clone()),
        })
        .collect();

    let hit_count = hits.len();
    RetrievalResult {
        hits,
        evidence_pack: EvidencePack {
            refs,
            pack_id: format!(
                "ep-{}-{}",
                request.document_id.0,
                chrono::Utc::now().timestamp()
            ),
            goal: request.query_type.clone(),
            query_text: Some(request.effective_query().to_string()),
            scope: request.scope.clone(),
            coverage_notes: vec![format!(
                "Retrieved {} segment(s) across {} document candidate(s)",
                hit_count,
                request.document_ids.len().max(1)
            )],
            omission_risks: if hit_count == 0 {
                vec!["no_matching_segments_found".to_string()]
            } else {
                vec!["results_limited_to_structural_lexical_ranker".to_string()]
            },
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    }
}

fn default_scope() -> String {
    "document".to_string()
}

pub fn retrieve_evidence(
    document: &NormalizedDocument,
    segment_set: &SegmentSet,
    segment_summaries: &[(String, String)],
    request: &RetrievalRequest,
) -> EvidencePack {
    retrieve_evidence_with_hits(document, segment_set, segment_summaries, request).evidence_pack
}

fn score_text(query_terms: &[String], haystack: &str) -> f64 {
    if query_terms.is_empty() {
        return 0.0;
    }

    let normalized = haystack.to_lowercase();
    let matches = query_terms
        .iter()
        .filter(|term| normalized.contains(term.as_str()))
        .count();

    matches as f64 / query_terms.len() as f64
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn snippet(text: &str) -> String {
    const MAX_LEN: usize = 240;
    if text.len() <= MAX_LEN {
        return text.to_string();
    }
    format!("{}...", &text[..MAX_LEN])
}

#[cfg(test)]
mod tests {
    use super::*;
    use paperreader_domain::{
        BlockId, BlockRange, DocumentMetadata, Segment, SegmentId, SegmentType, SourceType,
    };

    #[test]
    fn test_retrieve_evidence_returns_ranked_refs() {
        let document = NormalizedDocument {
            document_id: DocumentId::new("doc-1"),
            title: "Test".to_string(),
            source_type: SourceType::PlainText,
            metadata: DocumentMetadata::default(),
            blocks: Vec::new(),
            outline: Vec::new(),
            references: Vec::new(),
            assets: Vec::new(),
            canonical_text: "alpha beta gamma".to_string(),
            normalized_document_version: "1.0".to_string(),
            schema_version: "1.0".to_string(),
            extensions: Default::default(),
        };
        let segment_set = SegmentSet {
            document_id: document.document_id.clone(),
            version: "1.0".to_string(),
            segments: vec![
                Segment {
                    segment_id: SegmentId::new("seg-1"),
                    document_id: document.document_id.clone(),
                    node_path: Vec::new(),
                    block_range: BlockRange {
                        start_block_id: BlockId::new("b1"),
                        end_block_id: BlockId::new("b1"),
                    },
                    text: "alpha beta".to_string(),
                    token_estimate: 10,
                    segment_type: SegmentType::Body,
                    citations: Vec::new(),
                },
                Segment {
                    segment_id: SegmentId::new("seg-2"),
                    document_id: document.document_id.clone(),
                    node_path: Vec::new(),
                    block_range: BlockRange {
                        start_block_id: BlockId::new("b2"),
                        end_block_id: BlockId::new("b2"),
                    },
                    text: "delta epsilon".to_string(),
                    token_estimate: 10,
                    segment_type: SegmentType::Body,
                    citations: Vec::new(),
                },
            ],
        };

        let pack = retrieve_evidence(
            &document,
            &segment_set,
            &[("seg-1".to_string(), "alpha summary".to_string())],
            &RetrievalRequest {
                scope: "document".to_string(),
                document_id: document.document_id.clone(),
                document_ids: vec![document.document_id.clone()],
                collection_id: None,
                query_text: "alpha".to_string(),
                query: None,
                query_type: Some("keyword".to_string()),
                filters: None,
                budget: None,
                max_results: 3,
            },
        );

        assert_eq!(pack.refs.len(), 1);
        assert_eq!(pack.refs[0].segment_id.as_ref().unwrap().0, "seg-1");
    }

    #[test]
    fn test_retrieval_request_supports_query_alias_and_hits() {
        let document = NormalizedDocument {
            document_id: DocumentId::new("doc-1"),
            title: "Test".to_string(),
            source_type: SourceType::PlainText,
            metadata: DocumentMetadata::default(),
            blocks: Vec::new(),
            outline: Vec::new(),
            references: Vec::new(),
            assets: Vec::new(),
            canonical_text: "alpha beta gamma".to_string(),
            normalized_document_version: "1.0".to_string(),
            schema_version: "1.0".to_string(),
            extensions: Default::default(),
        };
        let segment_set = SegmentSet {
            document_id: document.document_id.clone(),
            version: "1.0".to_string(),
            segments: vec![Segment {
                segment_id: SegmentId::new("seg-1"),
                document_id: document.document_id.clone(),
                node_path: Vec::new(),
                block_range: BlockRange {
                    start_block_id: BlockId::new("b1"),
                    end_block_id: BlockId::new("b1"),
                },
                text: "alpha beta".to_string(),
                token_estimate: 10,
                segment_type: SegmentType::Body,
                citations: Vec::new(),
            }],
        };

        let result = retrieve_evidence_with_hits(
            &document,
            &segment_set,
            &[("seg-1".to_string(), "alpha summary".to_string())],
            &RetrievalRequest {
                scope: "document".to_string(),
                document_id: document.document_id.clone(),
                document_ids: vec![document.document_id.clone()],
                collection_id: None,
                query_text: String::new(),
                query: Some("alpha".to_string()),
                query_type: None,
                filters: None,
                budget: None,
                max_results: 2,
            },
        );

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].segment_id, "seg-1");
        assert_eq!(result.evidence_pack.refs.len(), 1);
    }
}

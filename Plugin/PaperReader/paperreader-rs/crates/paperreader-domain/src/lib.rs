//! PaperReader Domain Crate
//!
//! 本crate定义PaperReader系统的统一领域语言，是整个系统的"物理常数层"。
//! 包含：统一文档中间表示、值对象、聚合根、领域事件等核心类型。
//!
//! 设计原则：
//! - 不依赖任何外部IO或具体实现
//! - 所有类型可序列化
//! - 单文档与多文档共用同一套建模语言

mod checkpoint;
mod collection;
mod command;
mod cross_document;
mod document;
mod events;
mod evidence;
mod normalized_document;
mod prelude;
mod reading_state;
mod research_graph;
mod segment;
mod structure_tree;
mod value_objects;

pub use checkpoint::*;
pub use collection::*;
pub use command::*;
pub use cross_document::*;
pub use document::*;
pub use events::*;
pub use evidence::*;
pub use normalized_document::*;
pub use reading_state::*;
pub use research_graph::*;
pub use segment::*;
pub use structure_tree::*;
pub use value_objects::*;

// =============================================================================
// 外部依赖
// =============================================================================

pub extern crate chrono;
pub extern crate serde;
pub extern crate serde_json;

// =============================================================================
// 业务不变量模块
// =============================================================================

pub mod invariants;
pub use invariants::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_document_id_creation() {
        let doc_id = DocumentId::new("doc-123");
        assert_eq!(doc_id.0, "doc-123");
    }

    #[test]
    fn test_normalized_document_creation() {
        let doc_id = DocumentId::new("doc-456");
        let doc = NormalizedDocument::new(doc_id.clone(), "Test Document");
        assert_eq!(doc.document_id, doc_id);
        assert_eq!(doc.title, "Test Document");
        assert_eq!(doc.normalized_document_version, "1.0");
    }

    #[test]
    fn test_collection_management() {
        let coll_id = CollectionId::new("coll-001");
        let mut coll = Collection::new(coll_id, "Test Collection", "Research goal");

        let doc_id = DocumentId::new("doc-001");
        coll.add_document(doc_id.clone());

        assert_eq!(coll.document_ids.len(), 1);
        assert!(coll.document_ids.contains(&doc_id));
    }

    #[test]
    fn test_command_envelope() {
        let envelope = CommandEnvelope::new("ingest", "req-001")
            .with_payload(serde_json::json!({"path": "/tmp/test.pdf"}));

        assert_eq!(envelope.command, "ingest");
        assert_eq!(envelope.request_id, "req-001");
        assert_eq!(envelope.protocol_version, "1.0");
        assert!(envelope.normalized_client().is_none());
    }

    #[test]
    fn test_evidence_ref_serialization() {
        let evidence = EvidenceRef {
            ref_id: "ev-001".to_string(),
            document_id: DocumentId::new("doc-001"),
            segment_id: Some(SegmentId::new("seg-001")),
            block_id: None,
            node_id: None,
            block_ids: vec![BlockId::new("blk-001")],
            asset_refs: vec!["asset://figure-1".to_string()],
            locators: vec![EvidenceLocator {
                page: Some(1),
                section_path: vec!["Intro".to_string()],
                block_offsets: vec![0, 42],
                asset_anchor: None,
            }],
            text_snippet: "Test snippet".to_string(),
            ref_type: EvidenceRefType::Direct,
            relevance_score: Some(0.95),
            citation_text: Some("Test snippet".to_string()),
            scope: Some("document".to_string()),
        };

        let json = serde_json::to_string(&evidence).unwrap();
        assert!(json.contains("ev-001"));
        assert!(json.contains("doc-001"));
    }
}

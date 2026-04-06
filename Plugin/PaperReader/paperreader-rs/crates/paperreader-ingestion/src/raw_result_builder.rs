use crate::*;
use std::collections::HashMap;

/// Build a minimal `MinerURawResult` from plain text.
///
/// This is used by:
/// - deterministic adapters (offline/smoke mode)
/// - local fallbacks (e.g. pdf-parse extracted text)
/// - gateway bridges that only yield Markdown/text (zip output)
pub fn build_raw_result_from_text(title: &str, text: &str) -> MinerURawResult {
    let parts = text
        .split("\n\n")
        .map(str::trim)
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>();
    let blocks = if parts.is_empty() { vec![text] } else { parts };

    MinerURawResult {
        version: "text-bridge-1.0".to_string(),
        document_info: MinerUDocumentInfo {
            page_count: 1,
            title: Some(title.to_string()),
            authors: None,
            creation_date: None,
        },
        pages: vec![MinerUPage {
            page_number: 1,
            width: 1000.0,
            height: 1400.0,
            block_ids: (0..blocks.len())
                .map(|index| format!("block_{}", index + 1))
                .collect(),
        }],
        blocks: blocks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| MinerUBlock {
                block_id: format!("block_{}", index + 1),
                block_type: if index == 0 {
                    MinerUBlockType::Title
                } else {
                    MinerUBlockType::Paragraph
                },
                text: Some(chunk.to_string()),
                page_number: 1,
                bbox: MinerUBBox {
                    x: 0.0,
                    y: index as f64 * 120.0,
                    width: 800.0,
                    height: 100.0,
                },
                level: 1,
                confidence: Some(0.9),
                attrs: HashMap::new(),
            })
            .collect(),
        images: Vec::new(),
        tables: Vec::new(),
        equations: Vec::new(),
        outline: vec![MinerUOutlineItem {
            title: title.to_string(),
            level: 1,
            page_number: 1,
            block_id: "block_1".to_string(),
        }],
        references: vec![MinerUReference {
            ref_id: "ref-1".to_string(),
            number: "[1]".to_string(),
            text: "Synthetic reference".to_string(),
        }],
        metadata: HashMap::new(),
    }
}

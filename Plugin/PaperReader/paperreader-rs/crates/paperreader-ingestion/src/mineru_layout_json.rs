use crate::*;
use serde::Deserialize;
use std::collections::HashMap;

pub(crate) fn build_raw_result_from_mineru_layout_json(
    title: &str,
    json: &str,
) -> Result<MinerURawResult, IngestionError> {
    build_raw_result_from_mineru_layout_json_at_offset(title, json, 0)
}

pub(crate) fn build_raw_result_from_mineru_layout_json_at_offset(
    title: &str,
    json: &str,
    global_page_offset: u32,
) -> Result<MinerURawResult, IngestionError> {
    let document: MinerULayoutDocument = serde_json::from_str(json)
        .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;

    if document.pdf_info.is_empty() {
        return Err(IngestionError::malformed_mineru_result(
            "MinerU layout JSON did not contain pdf_info pages",
        ));
    }

    let page_count = document.pdf_info.len() as u32;
    let mut pages = Vec::with_capacity(document.pdf_info.len());
    let mut blocks = Vec::new();
    let mut images = Vec::new();
    let mut tables = Vec::new();
    let mut equations = Vec::new();
    let mut outline = Vec::new();

    for (page_position, page) in document.pdf_info.into_iter().enumerate() {
        let local_page_number = page
            .page_idx
            .unwrap_or(page_position as u32)
            .saturating_add(1);
        let page_number = global_page_offset.saturating_add(local_page_number);
        let [width, height] = page.page_size.unwrap_or([0.0, 0.0]);
        let source_blocks = if page.para_blocks.is_empty() {
            page.preproc_blocks
        } else {
            page.para_blocks
        };
        let mut page_block_ids = Vec::new();

        for (block_position, block) in source_blocks.into_iter().enumerate() {
            let block_id = format!(
                "page-{page_number}-block-{}",
                block.index.unwrap_or(block_position)
            );
            let block_type = map_block_type(block.block_type.as_deref());
            let bbox = to_bbox(block.bbox);
            let text = extract_text(&block);
            let level = block.level.unwrap_or(1).clamp(1, u8::MAX as u32) as u8;

            match block.block_type.as_deref() {
                Some("image") => {
                    for image_path in extract_image_paths(&block) {
                        images.push(MinerUImage {
                            image_id: format!("{block_id}-image-{}", images.len() + 1),
                            page_number,
                            bbox: bbox.clone(),
                            caption: text.clone(),
                            storage_path: image_path,
                        });
                    }
                }
                Some("table") => {
                    tables.push(MinerUTable {
                        table_id: format!("{block_id}-table-{}", tables.len() + 1),
                        page_number,
                        bbox: bbox.clone(),
                        html: text.clone().unwrap_or_default(),
                        caption: None,
                    });
                }
                Some("interline_equation") | Some("equation") => {
                    if let Some(latex) = text.clone() {
                        equations.push(MinerUEquation {
                            equation_id: format!("{block_id}-equation-{}", equations.len() + 1),
                            page_number,
                            latex,
                            bbox: bbox.clone(),
                        });
                    }
                }
                _ => {}
            }

            if matches!(
                block_type,
                MinerUBlockType::Title | MinerUBlockType::SectionHeader
            ) {
                if let Some(heading) = text.as_deref().filter(|value| !value.trim().is_empty()) {
                    outline.push(MinerUOutlineItem {
                        title: heading.to_string(),
                        level,
                        page_number,
                        block_id: block_id.clone(),
                    });
                }
            }

            page_block_ids.push(block_id.clone());
            blocks.push(MinerUBlock {
                block_id,
                block_type,
                text,
                page_number,
                bbox,
                level,
                confidence: average_score(&block),
                attrs: HashMap::new(),
            });
        }

        pages.push(MinerUPage {
            page_number,
            width,
            height,
            block_ids: page_block_ids,
        });
    }

    let mut metadata = HashMap::new();
    metadata.insert(
        "mineru_layout_json".to_string(),
        serde_json::Value::Bool(true),
    );
    metadata.insert(
        "mineru_layout_page_count".to_string(),
        serde_json::Value::from(page_count),
    );
    if global_page_offset > 0 {
        metadata.insert(
            "mineru_global_page_offset".to_string(),
            serde_json::Value::from(global_page_offset),
        );
    }

    Ok(MinerURawResult {
        version: "mineru-layout-json-bridge-1.0".to_string(),
        document_info: MinerUDocumentInfo {
            page_count,
            title: Some(title.to_string()),
            authors: None,
            creation_date: None,
        },
        pages,
        blocks,
        images,
        tables,
        equations,
        outline,
        references: Vec::new(),
        metadata,
    })
}

fn map_block_type(value: Option<&str>) -> MinerUBlockType {
    match value.unwrap_or_default() {
        "title" => MinerUBlockType::SectionHeader,
        "text" => MinerUBlockType::Paragraph,
        "list" => MinerUBlockType::ListItem,
        "table" => MinerUBlockType::Table,
        "image" => MinerUBlockType::Figure,
        "interline_equation" | "equation" => MinerUBlockType::Equation,
        "header" => MinerUBlockType::Header,
        "footer" => MinerUBlockType::Footer,
        "footnote" => MinerUBlockType::Footnote,
        "reference" => MinerUBlockType::Reference,
        other => MinerUBlockType::Other(other.to_string()),
    }
}

fn to_bbox(value: Option<[f64; 4]>) -> MinerUBBox {
    let [x0, y0, x1, y1] = value.unwrap_or([0.0, 0.0, 0.0, 0.0]);
    MinerUBBox {
        x: x0,
        y: y0,
        width: (x1 - x0).max(0.0),
        height: (y1 - y0).max(0.0),
    }
}

fn extract_text(block: &MinerULayoutBlock) -> Option<String> {
    let text = block
        .lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .filter_map(|span| span.content.as_deref())
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn extract_image_paths(block: &MinerULayoutBlock) -> Vec<String> {
    block
        .blocks
        .iter()
        .flat_map(|nested| nested.lines.iter())
        .flat_map(|line| line.spans.iter())
        .filter_map(|span| span.image_path.clone())
        .collect()
}

fn average_score(block: &MinerULayoutBlock) -> Option<f64> {
    let scores = block
        .lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .filter_map(|span| span.score)
        .collect::<Vec<_>>();
    (!scores.is_empty()).then(|| scores.iter().sum::<f64>() / scores.len() as f64)
}

#[derive(Debug, Deserialize)]
struct MinerULayoutDocument {
    #[serde(default)]
    pdf_info: Vec<MinerULayoutPage>,
}

#[derive(Debug, Deserialize)]
struct MinerULayoutPage {
    #[serde(default)]
    preproc_blocks: Vec<MinerULayoutBlock>,
    #[serde(default)]
    para_blocks: Vec<MinerULayoutBlock>,
    #[serde(default)]
    page_size: Option<[f64; 2]>,
    #[serde(default)]
    page_idx: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct MinerULayoutBlock {
    #[serde(rename = "type")]
    block_type: Option<String>,
    #[serde(default)]
    bbox: Option<[f64; 4]>,
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    level: Option<u32>,
    #[serde(default)]
    lines: Vec<MinerULayoutLine>,
    #[serde(default)]
    blocks: Vec<MinerULayoutBlock>,
}

#[derive(Debug, Deserialize)]
struct MinerULayoutLine {
    #[serde(default)]
    spans: Vec<MinerULayoutSpan>,
}

#[derive(Debug, Deserialize)]
struct MinerULayoutSpan {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    image_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_page_indices_and_bounding_boxes() {
        let raw = build_raw_result_from_mineru_layout_json(
            "Layout test",
            r#"{
                "pdf_info": [
                    {
                        "page_idx": 0,
                        "page_size": [612, 792],
                        "para_blocks": [
                            {
                                "type": "title",
                                "index": 3,
                                "level": 2,
                                "bbox": [12, 20, 112, 50],
                                "lines": [{"spans": [{"content": "First page", "score": 0.98}]}]
                            }
                        ]
                    },
                    {
                        "page_idx": 1,
                        "page_size": [612, 792],
                        "para_blocks": [
                            {
                                "type": "text",
                                "index": 4,
                                "bbox": [10, 30, 210, 60],
                                "lines": [{"spans": [{"content": "Second page"}]}]
                            }
                        ]
                    }
                ]
            }"#,
        )
        .expect("layout JSON should parse");

        assert_eq!(raw.document_info.page_count, 2);
        assert_eq!(raw.pages.len(), 2);
        assert_eq!(raw.pages[1].page_number, 2);
        assert_eq!(raw.blocks[0].page_number, 1);
        assert_eq!(raw.blocks[0].bbox.width, 100.0);
        assert_eq!(raw.blocks[1].page_number, 2);
        assert_eq!(raw.outline[0].page_number, 1);
    }
}

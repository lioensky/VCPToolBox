use crate::mineru_layout_json::build_raw_result_from_mineru_layout_json_at_offset;
use crate::*;
use lopdf::Document;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

pub const MINERU_MAX_PAGES_PER_PART: u32 = 200;
pub const MINERU_DEFAULT_OVERLAP_PAGES: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MinerUSplitPart {
    pub part_id: String,
    pub upload_page_start: u32,
    pub upload_page_end: u32,
    pub primary_page_start: u32,
    pub primary_page_end: u32,
    #[serde(skip_serializing, skip_deserializing, default)]
    pub local_pdf_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MinerUSplitPlan {
    pub source_pdf: PathBuf,
    pub original_page_count: u32,
    pub max_pages_per_part: u32,
    pub overlap_pages: u32,
    pub parts: Vec<MinerUSplitPart>,
}

#[derive(Debug, Clone)]
pub struct MinerUSplitResult {
    pub part: MinerUSplitPart,
    pub layout_json: String,
    pub raw_result: MinerURawResult,
}
pub fn pdf_page_count(source_pdf: &Path) -> Result<u32, IngestionError> {
    let document = Document::load(source_pdf)
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
    let page_count = document.get_pages().len() as u32;
    if page_count == 0 {
        return Err(IngestionError::parse_request_failed(
            "PDF did not contain any pages",
        ));
    }
    Ok(page_count)
}

pub fn split_pdf(
    source_pdf: &Path,
    output_dir: &Path,
    max_pages_per_part: u32,
    overlap_pages: u32,
) -> Result<MinerUSplitPlan, IngestionError> {
    if max_pages_per_part == 0 {
        return Err(IngestionError::parse_request_failed(
            "max_pages_per_part must be greater than zero",
        ));
    }
    if overlap_pages >= max_pages_per_part {
        return Err(IngestionError::parse_request_failed(
            "overlap_pages must be less than max_pages_per_part",
        ));
    }

    let page_count = pdf_page_count(source_pdf)?;

    std::fs::create_dir_all(output_dir)
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;

    let plan = build_split_plan(
        source_pdf,
        output_dir,
        page_count,
        max_pages_per_part,
        overlap_pages,
    )?;
    for part in &plan.parts {
        write_pdf_range(
            source_pdf,
            &part.local_pdf_path,
            part.upload_page_start,
            part.upload_page_end,
        )?;
    }
    Ok(plan)
}

pub fn build_split_plan(
    source_pdf: &Path,
    output_dir: &Path,
    page_count: u32,
    max_pages_per_part: u32,
    overlap_pages: u32,
) -> Result<MinerUSplitPlan, IngestionError> {
    if page_count == 0 {
        return Err(IngestionError::parse_request_failed(
            "PDF did not contain any pages",
        ));
    }
    if max_pages_per_part == 0 || overlap_pages >= max_pages_per_part {
        return Err(IngestionError::parse_request_failed(
            "invalid MinerU split page limits",
        ));
    }

    let primary_capacity = max_pages_per_part.saturating_sub(overlap_pages);
    let mut parts = Vec::new();
    let mut primary_page_start = 1;
    let mut part_number = 1usize;
    while primary_page_start <= page_count {
        let upload_page_start = if part_number == 1 {
            1
        } else {
            primary_page_start.saturating_sub(overlap_pages)
        };
        let upload_page_end = upload_page_start
            .saturating_add(max_pages_per_part)
            .saturating_sub(1)
            .min(page_count);
        let primary_page_end = if part_number == 1 {
            upload_page_end
        } else {
            primary_page_start
                .saturating_add(primary_capacity)
                .saturating_sub(1)
                .min(page_count)
        };
        let part_id = format!("part-{part_number:02}");
        parts.push(MinerUSplitPart {
            part_id: part_id.clone(),
            upload_page_start,
            upload_page_end,
            primary_page_start,
            primary_page_end,
            local_pdf_path: output_dir.join(format!("{part_id}.pdf")),
        });
        primary_page_start = primary_page_end.saturating_add(1);
        part_number += 1;
    }

    Ok(MinerUSplitPlan {
        source_pdf: source_pdf.to_path_buf(),
        original_page_count: page_count,
        max_pages_per_part,
        overlap_pages,
        parts,
    })
}

pub fn merge_split_results(
    title: &str,
    plan: &MinerUSplitPlan,
    results: Vec<(MinerUSplitPart, String)>,
) -> Result<(MinerURawResult, Vec<MinerUSplitResult>), IngestionError> {
    if results.len() != plan.parts.len() {
        return Err(IngestionError::parse_request_failed(format!(
            "split result count mismatch: expected {}, got {}",
            plan.parts.len(),
            results.len()
        )));
    }

    let mut result_by_id = HashMap::new();
    for (part, layout_json) in results {
        result_by_id.insert(part.part_id.clone(), (part, layout_json));
    }

    let mut per_part_results = Vec::new();
    let mut canonical_pages = BTreeMap::new();
    let mut canonical_blocks = Vec::new();
    let mut canonical_images = Vec::new();
    let mut canonical_tables = Vec::new();
    let mut canonical_equations = Vec::new();
    let mut canonical_outline = Vec::new();

    for expected_part in &plan.parts {
        let (part, layout_json) = result_by_id.remove(&expected_part.part_id).ok_or_else(|| {
            IngestionError::parse_request_failed(format!(
                "missing result for split part {}",
                expected_part.part_id
            ))
        })?;
        if part.upload_page_start != expected_part.upload_page_start
            || part.upload_page_end != expected_part.upload_page_end
            || part.primary_page_start != expected_part.primary_page_start
            || part.primary_page_end != expected_part.primary_page_end
        {
            return Err(IngestionError::parse_request_failed(format!(
                "split part manifest mismatch for {}",
                expected_part.part_id
            )));
        }

        let mut raw = build_raw_result_from_mineru_layout_json_at_offset(
            title,
            &layout_json,
            part.upload_page_start.saturating_sub(1),
        )?;
        annotate_part_origin(&mut raw, &part);

        let primary_page_numbers =
            (part.primary_page_start..=part.primary_page_end).collect::<BTreeSet<_>>();
        canonical_pages.extend(
            raw.pages
                .iter()
                .filter(|page| primary_page_numbers.contains(&page.page_number))
                .cloned()
                .map(|page| (page.page_number, page)),
        );
        canonical_blocks.extend(
            raw.blocks
                .iter()
                .filter(|block| primary_page_numbers.contains(&block.page_number))
                .cloned(),
        );
        canonical_images.extend(
            raw.images
                .iter()
                .filter(|image| primary_page_numbers.contains(&image.page_number))
                .cloned(),
        );
        canonical_tables.extend(
            raw.tables
                .iter()
                .filter(|table| primary_page_numbers.contains(&table.page_number))
                .cloned(),
        );
        canonical_equations.extend(
            raw.equations
                .iter()
                .filter(|equation| primary_page_numbers.contains(&equation.page_number))
                .cloned(),
        );
        canonical_outline.extend(
            raw.outline
                .iter()
                .filter(|item| primary_page_numbers.contains(&item.page_number))
                .cloned(),
        );
        per_part_results.push(MinerUSplitResult {
            part,
            layout_json,
            raw_result: raw,
        });
    }

    if canonical_pages.len() as u32 != plan.original_page_count {
        return Err(IngestionError::parse_request_failed(format!(
            "canonical merged page count mismatch: expected {}, got {}",
            plan.original_page_count,
            canonical_pages.len()
        )));
    }

    let mut metadata = HashMap::new();
    metadata.insert("mineru_split_orchestration".to_string(), json!(true));
    metadata.insert(
        "mineru_split_original_page_count".to_string(),
        json!(plan.original_page_count),
    );
    metadata.insert(
        "mineru_split_part_count".to_string(),
        json!(plan.parts.len()),
    );
    metadata.insert(
        "mineru_split_overlap_pages".to_string(),
        json!(plan.overlap_pages),
    );

    Ok((
        MinerURawResult {
            version: "mineru-split-layout-json-bridge-1.0".to_string(),
            document_info: MinerUDocumentInfo {
                page_count: plan.original_page_count,
                title: Some(title.to_string()),
                authors: None,
                creation_date: None,
            },
            pages: canonical_pages.into_values().collect(),
            blocks: canonical_blocks,
            images: canonical_images,
            tables: canonical_tables,
            equations: canonical_equations,
            outline: canonical_outline,
            references: Vec::new(),
            metadata,
        },
        per_part_results,
    ))
}

pub fn persist_split_artifacts(
    parent_document_dir: &Path,
    plan: &MinerUSplitPlan,
    results: &[MinerUSplitResult],
) -> Result<PathBuf, IngestionError> {
    let manifest_path = parent_document_dir.join("split_manifest.json");
    let parts_dir = parent_document_dir.join("ingestion_parts");
    std::fs::create_dir_all(&parts_dir)
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;

    let split_manifest = json!({
        "parent_source_pdf": plan.source_pdf,
        "original_page_count": plan.original_page_count,
        "max_pages_per_part": plan.max_pages_per_part,
        "overlap_pages": plan.overlap_pages,
        "parts": plan.parts,
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&split_manifest)
            .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?,
    )
    .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;

    for result in results {
        let part_dir = parts_dir.join(&result.part.part_id);
        std::fs::create_dir_all(&part_dir)
            .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
        let part_manifest_path = part_dir.join("source_range.json");
        std::fs::write(
            part_manifest_path,
            serde_json::to_string_pretty(&result.part)
                .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?,
        )
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
        std::fs::write(part_dir.join("mineru_layout_raw.json"), &result.layout_json)
            .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
        std::fs::write(
            part_dir.join("mineru_raw.json"),
            serde_json::to_string_pretty(&result.raw_result)
                .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?,
        )
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
    }

    Ok(manifest_path)
}

fn write_pdf_range(
    source_pdf: &Path,
    output_pdf: &Path,
    first_page: u32,
    last_page: u32,
) -> Result<(), IngestionError> {
    let mut document = Document::load(source_pdf)
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
    let page_numbers = document.get_pages();
    let removable_pages = page_numbers
        .keys()
        .copied()
        .filter(|page_number| *page_number < first_page || *page_number > last_page)
        .collect::<Vec<_>>();
    document.delete_pages(&removable_pages);
    document
        .save(output_pdf)
        .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
    Ok(())
}

fn annotate_part_origin(raw: &mut MinerURawResult, part: &MinerUSplitPart) {
    let value = json!({
        "part_id": part.part_id,
        "upload_page_start": part.upload_page_start,
        "upload_page_end": part.upload_page_end,
        "primary_page_start": part.primary_page_start,
        "primary_page_end": part.primary_page_end,
    });
    raw.metadata
        .insert("mineru_split_part".to_string(), value.clone());
    for block in &mut raw.blocks {
        block
            .attrs
            .insert("mineru_split_part".to_string(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(
        part_id: &str,
        upload_page_start: u32,
        upload_page_end: u32,
        primary_page_start: u32,
        primary_page_end: u32,
    ) -> MinerUSplitPart {
        MinerUSplitPart {
            part_id: part_id.to_string(),
            upload_page_start,
            upload_page_end,
            primary_page_start,
            primary_page_end,
            local_pdf_path: PathBuf::from(format!("{part_id}.pdf")),
        }
    }

    fn layout_json(page_count: u32, prefix: &str) -> String {
        let pages = (0..page_count)
            .map(|page_idx| {
                json!({
                    "page_idx": page_idx,
                    "page_size": [100, 200],
                    "para_blocks": [{
                        "type": "text",
                        "index": 0,
                        "bbox": [1, 2, 30, 40],
                        "lines": [{"spans": [{"content": format!("{prefix}-{page_idx}")}]}]
                    }]
                })
            })
            .collect::<Vec<_>>();
        json!({"pdf_info": pages}).to_string()
    }

    #[test]
    fn plan_uses_bounded_uploads_and_complete_nonoverlapping_primary_ranges() {
        let plan = build_split_plan(
            Path::new("source.pdf"),
            Path::new("parts"),
            1156,
            MINERU_MAX_PAGES_PER_PART,
            MINERU_DEFAULT_OVERLAP_PAGES,
        )
        .expect("split plan should build");

        assert_eq!(plan.parts.len(), 6);
        assert_eq!(plan.parts[0].upload_page_start, 1);
        assert_eq!(plan.parts[0].upload_page_end, 200);
        assert_eq!(plan.parts[1].upload_page_start, 193);
        assert_eq!(plan.parts[1].primary_page_start, 201);
        assert_eq!(plan.parts.last().unwrap().primary_page_end, 1156);
        assert!(plan.parts.iter().all(|part| {
            part.upload_page_end - part.upload_page_start + 1 <= MINERU_MAX_PAGES_PER_PART
        }));
        assert_eq!(
            plan.parts
                .iter()
                .map(|part| part.primary_page_end - part.primary_page_start + 1)
                .sum::<u32>(),
            1156
        );
    }

    #[test]
    fn merge_keeps_one_canonical_copy_for_each_global_page() {
        let first = part("part-01", 1, 4, 1, 3);
        let second = part("part-02", 2, 5, 4, 5);
        let plan = MinerUSplitPlan {
            source_pdf: PathBuf::from("source.pdf"),
            original_page_count: 5,
            max_pages_per_part: 4,
            overlap_pages: 2,
            parts: vec![first.clone(), second.clone()],
        };

        let (merged, results) = merge_split_results(
            "Split test",
            &plan,
            vec![
                (first, layout_json(4, "first")),
                (second, layout_json(4, "second")),
            ],
        )
        .expect("split results should merge");

        assert_eq!(results.len(), 2);
        assert_eq!(merged.document_info.page_count, 5);
        assert_eq!(merged.pages.len(), 5);
        assert_eq!(merged.blocks.len(), 5);
        assert_eq!(merged.blocks[0].page_number, 1);
        assert_eq!(merged.blocks[2].page_number, 3);
        assert_eq!(merged.blocks[3].page_number, 4);
        assert_eq!(merged.blocks[3].text.as_deref(), Some("second-2"));
        assert_eq!(merged.blocks[4].page_number, 5);
    }
}

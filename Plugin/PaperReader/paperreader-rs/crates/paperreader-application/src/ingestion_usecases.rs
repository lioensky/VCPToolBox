use super::*;

impl PaperReaderApplication {
    pub fn ingest_source(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let source_ref = required_string(payload, "source_uri")
            .or_else(|_| required_string(payload, "source_path"))
            .or_else(|_| required_string(payload, "source_text"))?;
        let source_type = parse_source_type(payload);
        let display_name = payload_string(payload, "document_name")
            .or_else(|| payload_string(payload, "display_name"))
            .or_else(|| guess_display_name(&source_ref));
        let raw = self.gateway.generate_raw_result(
            source_type.clone(),
            &source_ref,
            display_name.clone(),
        )?;
        let mut normalized = Normalizer::new().normalize(raw.clone())?;
        if let Some(document_id) =
            payload_string(payload, "document_id").or_else(|| payload_string(payload, "paper_id"))
        {
            normalized.document_id = DocumentId::new(document_id);
        }
        let structure_tree = build_structure_tree(&normalized);
        let segment_set = build_segment_set(&normalized, &self.config);
        let document_paths = repo.document_paths(&normalized.document_id);
        let source_manifest = paperreader_workspace::SourceManifest {
            document_id: normalized.document_id.clone(),
            source_type: normalize_source_type(&source_type),
            source_ref: source_ref.clone(),
            original_filename: display_name,
            file_size_bytes: payload
                .get("source_text")
                .and_then(|v| v.as_str())
                .map(|v| v.len() as u64),
            checksum: None,
            ingested_at: chrono::Utc::now().to_rfc3339(),
        };
        repo.write_json(&document_paths.source_manifest, &source_manifest)?;
        repo.write_json(&document_paths.mineru_raw, &raw)?;
        repo.write_json(&document_paths.normalized_document, &normalized)?;
        repo.write_json(&document_paths.structure_tree, &structure_tree)?;
        repo.write_json(&document_paths.segment_set, &segment_set)?;

        let degrade_mode = if self.config.force_deterministic {
            json!("force_deterministic")
        } else if self.config.mineru_api_token.is_none() {
            json!("pdf_parse_fallback")
        } else {
            Value::Null
        };
        Ok(json!({
            "document_id": normalized.document_id,
            "normalized_document_ref": display_path(&document_paths.normalized_document),
            "manifest_ref": display_path(&document_paths.source_manifest),
            "artifacts": [
                display_path(&document_paths.source_manifest),
                display_path(&document_paths.mineru_raw),
                display_path(&document_paths.normalized_document),
                display_path(&document_paths.structure_tree),
                display_path(&document_paths.segment_set)
            ],
            "degrade_mode": degrade_mode
        }))
    }

    pub fn ingest_collection(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let root = repo.layout.root.clone();
        let collection_id = payload_string(payload, "collection_id")
            .unwrap_or_else(|| format!("coll-{}", uuid::Uuid::new_v4().simple()));
        let name = payload_string(payload, "name")
            .or_else(|| payload_string(payload, "collection_name"))
            .unwrap_or_else(|| format!("collection-{}", collection_id));
        let goal =
            payload_string(payload, "goal").unwrap_or_else(|| "Survey the collection".to_string());

        let mut document_ids: Vec<String> = Vec::new();
        let mut ingest_results: Vec<Value> = Vec::new();

        if let Some(sources) = payload.get("sources").and_then(|value| value.as_array()) {
            for source in sources {
                let mut merged = source
                    .as_object()
                    .cloned()
                    .context("sources must be an array of objects")?;
                merged.insert("workspace_root".to_string(), json!(root.clone()));
                let result = self.ingest_source(&Value::Object(merged))?;
                if let Some(doc_id) = result.get("document_id").and_then(|v| v.as_str()) {
                    document_ids.push(doc_id.to_string());
                }
                ingest_results.push(result);
            }
        } else {
            let ids = required_document_ids(payload, "document_ids")?;
            document_ids = ids.into_iter().map(|id| id.0).collect();
        }

        let survey = self.survey_collection(&json!({
            "workspace_root": root,
            "collection_id": collection_id,
            "name": name,
            "goal": goal,
            "document_ids": document_ids,
        }))?;

        Ok(json!({
            "collection_id": survey["collection_id"].clone(),
            "document_ids": survey["document_ids"].clone(),
            "collection_manifest_ref": survey["collection_manifest_ref"].clone(),
            "member_documents_ref": survey["member_documents_ref"].clone(),
            "collection_map_ref": survey["collection_map_ref"].clone(),
            "artifact_refs": survey["artifact_refs"].clone(),
            "ingest_results": ingest_results,
        }))
    }

    pub fn refresh_ingestion(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let document_id = DocumentId::new(required_string(payload, "document_id")?);
        let document_paths = repo.document_paths(&document_id);
        let mut source_manifest: paperreader_workspace::SourceManifest =
            repo.read_json(&document_paths.source_manifest)?;
        let source_ref = source_manifest.source_ref.clone();

        let import_source_type =
            if source_ref.starts_with("http://") || source_ref.starts_with("https://") {
                ImportSourceType::Url
            } else if Path::new(&source_ref).exists() {
                ImportSourceType::File
            } else {
                ImportSourceType::RawText
            };

        let display_name = payload_string(payload, "document_name")
            .or_else(|| payload_string(payload, "display_name"))
            .or(source_manifest.original_filename.clone())
            .or_else(|| guess_display_name(&source_ref));

        let raw = self.gateway.generate_raw_result(
            import_source_type.clone(),
            &source_ref,
            display_name.clone(),
        )?;
        let normalized = Normalizer::new().normalize(raw.clone())?;
        let structure_tree = build_structure_tree(&normalized);
        let segment_set = build_segment_set(&normalized, &self.config);

        source_manifest.source_type = normalize_source_type(&import_source_type);
        source_manifest.original_filename = display_name;
        source_manifest.ingested_at = chrono::Utc::now().to_rfc3339();

        repo.write_json(&document_paths.source_manifest, &source_manifest)?;
        repo.write_json(&document_paths.mineru_raw, &raw)?;
        repo.write_json(&document_paths.normalized_document, &normalized)?;
        repo.write_json(&document_paths.structure_tree, &structure_tree)?;
        repo.write_json(&document_paths.segment_set, &segment_set)?;

        Ok(json!({
            "document_id": document_id,
            "refreshed": true,
            "artifact_refs": [
                display_path(&document_paths.source_manifest),
                display_path(&document_paths.mineru_raw),
                display_path(&document_paths.normalized_document),
                display_path(&document_paths.structure_tree),
                display_path(&document_paths.segment_set)
            ]
        }))
    }
}

fn parse_source_type(payload: &Value) -> ImportSourceType {
    match payload
        .get("source_type")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_lowercase()
        .as_str()
    {
        "url" => ImportSourceType::Url,
        "raw_text" | "text" => ImportSourceType::RawText,
        "snapshot" => ImportSourceType::Snapshot,
        _ => ImportSourceType::File,
    }
}

fn normalize_source_type(source_type: &ImportSourceType) -> SourceType {
    match source_type {
        ImportSourceType::RawText => SourceType::PlainText,
        ImportSourceType::Url => SourceType::Html,
        _ => SourceType::Pdf,
    }
}

fn build_structure_tree(document: &NormalizedDocument) -> StructureTree {
    if !document.outline.is_empty() {
        if let Some(tree) = build_structure_tree_from_outline(document) {
            return tree;
        }
    }

    let root = StructureNode {
        node_id: NodeId::new(format!("root-{}", document.document_id.0)),
        title: document.title.clone(),
        level: 1,
        parent_id: None,
        children: Vec::new(),
        block_ids: document
            .blocks
            .iter()
            .map(|block| block.block_id.clone())
            .collect(),
        summary: Some(snippet(&document.canonical_text)),
    };
    let mut node_index = HashMap::new();
    node_index.insert(root.node_id.clone(), root.clone());
    StructureTree {
        document_id: document.document_id.clone(),
        root_nodes: vec![root],
        node_index: Some(node_index),
        version: "1.0".to_string(),
    }
}

fn build_structure_tree_from_outline(document: &NormalizedDocument) -> Option<StructureTree> {
    let mut block_index = HashMap::new();
    for (idx, block) in document.blocks.iter().enumerate() {
        block_index.insert(block.block_id.clone(), idx);
    }

    let mut flat_nodes: HashMap<NodeId, StructureNode> = HashMap::new();
    let mut children_map: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    let mut root_ids = Vec::new();

    for outline in &document.outline {
        let start_idx = block_index
            .get(&outline.block_range.start_block_id)
            .copied();
        let end_idx = block_index.get(&outline.block_range.end_block_id).copied();
        let (Some(start_idx), Some(end_idx)) = (start_idx, end_idx) else {
            continue;
        };

        let (range_start, range_end) = if start_idx <= end_idx {
            (start_idx, end_idx)
        } else {
            (end_idx, start_idx)
        };

        let block_ids = document.blocks[range_start..=range_end]
            .iter()
            .map(|block| block.block_id.clone())
            .collect::<Vec<_>>();

        let node = StructureNode {
            node_id: outline.node_id.clone(),
            title: outline.title.clone(),
            level: outline.level,
            parent_id: outline.parent_id.clone(),
            children: Vec::new(),
            block_ids,
            summary: outline
                .summary_hint
                .clone()
                .or_else(|| Some(snippet(&document.canonical_text))),
        };

        flat_nodes.insert(node.node_id.clone(), node);

        if let Some(parent_id) = outline.parent_id.clone() {
            children_map
                .entry(parent_id)
                .or_default()
                .push(outline.node_id.clone());
        } else {
            root_ids.push(outline.node_id.clone());
        }
    }

    if flat_nodes.is_empty() {
        return None;
    }

    let root_nodes = root_ids
        .iter()
        .filter_map(|node_id| materialize_structure_node(node_id, &flat_nodes, &children_map))
        .collect::<Vec<_>>();
    if root_nodes.is_empty() {
        return None;
    }

    Some(StructureTree {
        document_id: document.document_id.clone(),
        root_nodes,
        node_index: Some(flat_nodes),
        version: "1.0".to_string(),
    })
}

fn materialize_structure_node(
    node_id: &NodeId,
    flat_nodes: &HashMap<NodeId, StructureNode>,
    children_map: &HashMap<NodeId, Vec<NodeId>>,
) -> Option<StructureNode> {
    let mut node = flat_nodes.get(node_id)?.clone();
    if let Some(children) = children_map.get(node_id) {
        node.children = children
            .iter()
            .filter_map(|child_id| materialize_structure_node(child_id, flat_nodes, children_map))
            .collect::<Vec<_>>();
    }
    Some(node)
}

fn build_segment_set(document: &NormalizedDocument, config: &RuntimeConfig) -> SegmentSet {
    let target_tokens = config.paperreader_chunk_size_tokens.max(1);
    let overlap_ratio = config.paperreader_overlap_ratio.clamp(0.0, 0.9);

    let mut segments = Vec::new();
    let mut start = 0usize;
    let blocks = &document.blocks;
    let root_node = NodeId::new(format!("root-{}", document.document_id.0));
    let mut segment_index = 1usize;

    while start < blocks.len() {
        let mut end = start;
        let mut tokens = 0usize;

        while end < blocks.len() && tokens < target_tokens {
            let estimate = (blocks[end].text.len() / 4).max(1);
            tokens += estimate;
            end += 1;
        }

        if end <= start {
            end = (start + 1).min(blocks.len());
        }

        let text = blocks[start..end]
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");

        let start_block = blocks[start].block_id.clone();
        let end_block = blocks[end - 1].block_id.clone();

        let segment_type = if end - start == 1 {
            match blocks[start].block_type {
                paperreader_domain::BlockType::Heading { .. } => SegmentType::Heading,
                paperreader_domain::BlockType::List { .. } => SegmentType::List,
                paperreader_domain::BlockType::Table => SegmentType::Table,
                paperreader_domain::BlockType::Figure => SegmentType::FigureCaption,
                paperreader_domain::BlockType::Code { .. } => SegmentType::Code,
                _ => SegmentType::Body,
            }
        } else {
            SegmentType::Body
        };

        segments.push(Segment {
            segment_id: SegmentId::new(format!("seg-{}", segment_index)),
            document_id: document.document_id.clone(),
            node_path: vec![root_node.clone()],
            block_range: BlockRange {
                start_block_id: start_block,
                end_block_id: end_block,
            },
            text,
            token_estimate: (tokens as u32).max(1),
            segment_type,
            citations: Vec::new(),
        });

        segment_index += 1;

        let window_len = end - start;
        let overlap_blocks = ((window_len as f64) * overlap_ratio).ceil() as usize;
        let step = window_len.saturating_sub(overlap_blocks).max(1);
        start = start.saturating_add(step);
    }

    SegmentSet {
        document_id: document.document_id.clone(),
        segments,
        version: "1.0".to_string(),
    }
}

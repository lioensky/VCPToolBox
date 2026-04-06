use super::*;

impl PaperReaderApplication {
    pub fn get_workspace_state(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let mut response = json!({
            "workspace_root": repo.layout.root,
            "documents": list_directory_names(repo.layout.documents_dir())?,
            "collections": list_directory_names(repo.layout.collections_dir())?,
            "runs": list_directory_names(repo.layout.runs_dir())?,
        });

        if let Some(run_id) = payload_string(payload, "run_id") {
            let run_paths = repo.run_paths(&run_id);
            let run_state: RunState = repo.read_json(&run_paths.run_state)?;
            let graph_state: GraphState = repo.read_json(&run_paths.graph_state)?;
            let budget_state: BudgetState = repo.read_json(&run_paths.budget_state)?;
            response["run_id"] = json!(run_id);
            response["run_state_ref"] = json!(display_path(&run_paths.run_state));
            response["graph_state_ref"] = json!(display_path(&run_paths.graph_state));
            response["budget_state_ref"] = json!(display_path(&run_paths.budget_state));
            response["run_state"] = serde_json::to_value(run_state)?;
            response["graph_state"] = serde_json::to_value(graph_state)?;
            response["budget_state"] = serde_json::to_value(budget_state)?;
        }

        Ok(response)
    }

    pub fn list_artifacts(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let prefixes = resolve_workspace_prefixes(&repo, payload)?;
        let mut artifacts = BTreeMap::new();
        for prefix in prefixes.iter() {
            let resolved = resolve_workspace_artifact_path(&repo.layout.root, prefix)?;
            for artifact in repo.list_artifacts(&resolved)? {
                let path = display_path(&artifact.path);
                artifacts.insert(
                    path.clone(),
                    json!({
                        "artifact_id": artifact.artifact_id,
                        "path": path,
                        "artifact_type": artifact.header.artifact_type,
                        "schema_version": artifact.header.schema_version,
                        "protocol_compat": artifact.header.protocol_compat,
                        "size_bytes": artifact.size_bytes,
                        "checksum": artifact.checksum,
                        "entity_id": artifact.entity_id,
                        "probe_result": artifact.probe_result,
                        "has_header": artifact.has_header,
                    }),
                );
            }
        }
        Ok(json!({
            "workspace_root": repo.layout.root,
            "prefix": display_path(prefixes.first().unwrap_or(&repo.layout.root)),
            "prefixes": prefixes.iter().map(|prefix| display_path(prefix)).collect::<Vec<_>>(),
            "artifacts": artifacts.into_values().collect::<Vec<_>>(),
        }))
    }

    pub fn get_artifact(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let artifact_path = required_string(payload, "artifact_path")?;
        let resolved =
            resolve_workspace_artifact_path(&repo.layout.root, Path::new(&artifact_path))?;
        let metadata = std::fs::metadata(&resolved)?;
        let relative = resolved
            .strip_prefix(&repo.layout.root)
            .unwrap_or(&resolved)
            .to_path_buf();
        let (probe, header, data) = repo.read_artifact_value(&resolved)?;
        let kind = if data.is_string() { "text" } else { "json" };
        Ok(json!({
            "artifact_path": display_path(&relative),
            "artifact_type": probe.artifact_type,
            "schema_version": probe.schema_version,
            "schema_probe": probe.migration_result,
            "has_header": probe.has_header,
            "header": header,
            "size_bytes": metadata.len(),
            "kind": kind,
            "data": data,
        }))
    }
}

fn resolve_workspace_prefixes(repo: &WorkspaceRepository, payload: &Value) -> Result<Vec<PathBuf>> {
    if let Some(run_id) = payload_string(payload, "run_id") {
        let run_paths = repo.run_paths(&run_id);
        let mut prefixes = vec![repo.layout.run_dir(&run_id)];
        let mut seen = HashSet::from([prefixes[0].clone()]);

        if run_paths.run_manifest.exists() {
            let run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest)?;
            for document_id in run_manifest.root_entity_refs.document_ids {
                let document_dir = repo.layout.document_dir(&document_id);
                if document_dir.exists() && seen.insert(document_dir.clone()) {
                    prefixes.push(document_dir);
                }
            }
            if let Some(collection_id) = run_manifest.root_entity_refs.collection_id {
                let collection_dir = repo.layout.collection_dir(&collection_id);
                if collection_dir.exists() && seen.insert(collection_dir.clone()) {
                    prefixes.push(collection_dir);
                }
            }
        }

        return Ok(prefixes);
    }
    if let Some(document_id) = payload_string(payload, "document_id") {
        return Ok(vec![repo.layout.document_dir(&DocumentId(document_id))]);
    }
    if let Some(collection_id) = payload_string(payload, "collection_id") {
        return Ok(vec![
            repo.layout.collection_dir(&CollectionId(collection_id)),
        ]);
    }
    if let Some(prefix) = payload_string(payload, "prefix") {
        return Ok(vec![resolve_workspace_artifact_path(
            &repo.layout.root,
            Path::new(&prefix),
        )?]);
    }
    Ok(vec![repo.layout.root.clone()])
}

fn resolve_workspace_artifact_path(workspace_root: &Path, requested: &Path) -> Result<PathBuf> {
    let root = workspace_root.canonicalize().with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let normalized_requested = normalize_requested_artifact_path(requested);
    let candidate = if normalized_requested.is_absolute() {
        normalized_requested
    } else if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(normalized_requested)
    };
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve artifact path {}", candidate.display()))?;
    if !resolved.starts_with(&root) {
        anyhow::bail!("artifact path escapes workspace root");
    }
    Ok(resolved)
}

fn normalize_requested_artifact_path(requested: &Path) -> PathBuf {
    if requested.is_absolute() {
        return requested.to_path_buf();
    }
    let normalized = requested.to_string_lossy().replace('\\', "/");
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    let start = parts
        .iter()
        .rposition(|part| *part == "workspace-rs")
        .map(|index| index + 1)
        .unwrap_or(0);
    let normalized = parts[start..].join("/");
    PathBuf::from(normalized)
}

fn list_directory_names(path: PathBuf) -> Result<Vec<String>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut names = std::fs::read_dir(path)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

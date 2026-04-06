use crate::prelude::*;
use crate::*;

// =============================================================================
// Workspace Repository
// =============================================================================

/// 工作空间仓库
pub struct WorkspaceRepository {
    pub layout: WorkspaceLayout,
    pub migration_registry: MigrationRegistry,
}

impl WorkspaceRepository {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            layout: WorkspaceLayout::new(root),
            migration_registry: MigrationRegistry::new(),
        }
    }

    pub fn with_migration_registry(root: impl Into<PathBuf>, registry: MigrationRegistry) -> Self {
        Self {
            layout: WorkspaceLayout::new(root),
            migration_registry: registry,
        }
    }

    /// 初始化工作空间
    pub fn bootstrap(&self) -> anyhow::Result<()> {
        self.layout.create_directories()?;
        Ok(())
    }

    /// 检查工作空间是否存在
    pub fn exists(&self) -> bool {
        self.layout.root.exists()
    }

    /// 获取文档工件路径
    pub fn document_paths(&self, document_id: &DocumentId) -> DocumentArtifactPaths {
        DocumentArtifactPaths::new(&self.layout.document_dir(document_id))
    }

    /// 获取集合工件路径
    pub fn collection_paths(&self, collection_id: &CollectionId) -> CollectionArtifactPaths {
        CollectionArtifactPaths::new(&self.layout.collection_dir(collection_id))
    }

    /// 获取Run工件路径
    pub fn run_paths(&self, run_id: &str) -> RunArtifactPaths {
        RunArtifactPaths::new(&self.layout.run_dir(run_id))
    }

    /// 获取节点工件路径
    pub fn node_paths(&self, run_id: &str, node_id: &str) -> NodeArtifactPaths {
        NodeArtifactPaths::new(&self.run_paths(run_id).nodes_dir, node_id)
    }

    pub fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = if path.extension().and_then(|value| value.to_str()) == Some("json") {
            let payload = serde_json::to_value(value)?;
            let artifact = Artifact::new(
                infer_artifact_type(path),
                expected_schema_version(path),
                payload,
            );
            serde_json::to_string_pretty(&artifact)?
        } else {
            serde_json::to_string_pretty(value)?
        };
        std::fs::write(path, json)?;
        Ok(())
    }

    pub fn write_markdown(&self, path: &Path, value: &str) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, value)?;
        self.write_text_artifact_sidecar(path, "text/markdown")?;
        Ok(())
    }

    pub fn read_json<T: for<'de> Deserialize<'de>>(&self, path: &Path) -> anyhow::Result<T> {
        let json = std::fs::read_to_string(path)?;
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            return Ok(serde_json::from_str(&json)?);
        }
        let value: serde_json::Value = serde_json::from_str(&json)?;
        if has_artifact_header(&value) {
            let probe = self.probe_artifact(path)?;
            if probe.migration_result == MigrationResult::RequiresRebuild {
                anyhow::bail!(
                    "artifact {} requires rebuild for schema {}",
                    path.display(),
                    probe.schema_version
                );
            }
            let payload = strip_artifact_header(value);
            return Ok(serde_json::from_value(payload)?);
        }
        Ok(serde_json::from_value(value)?)
    }

    pub fn probe_artifact(&self, path: &Path) -> anyhow::Result<ArtifactProbe> {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            return self.probe_non_json_artifact(path);
        }
        let bytes = std::fs::read_to_string(path)?;
        let value: serde_json::Value = serde_json::from_str(&bytes)?;
        let artifact_type = infer_artifact_type(path);
        let expected_schema = expected_schema_version(path);
        if !has_artifact_header(&value) {
            return Ok(ArtifactProbe {
                artifact_type,
                schema_version: "legacy".to_string(),
                has_header: false,
                migration_result: MigrationResult::CanUpgradeInPlace,
            });
        }

        let header: ArtifactHeader = serde_json::from_value(
            value
                .get("header")
                .cloned()
                .context("artifact header missing header field")?,
        )?;
        let migration_result = if header.schema_version == expected_schema {
            MigrationResult::CanReadDirectly
        } else if self
            .migration_registry
            .can_migrate(&header.schema_version, &expected_schema)
        {
            MigrationResult::CanUpgradeInPlace
        } else {
            MigrationResult::RequiresRebuild
        };

        Ok(ArtifactProbe {
            artifact_type: header.artifact_type,
            schema_version: header.schema_version,
            has_header: true,
            migration_result,
        })
    }

    pub fn read_artifact_value(
        &self,
        path: &Path,
    ) -> anyhow::Result<(ArtifactProbe, Option<ArtifactHeader>, serde_json::Value)> {
        let raw = std::fs::read_to_string(path)?;
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            let probe = self.probe_artifact(path)?;
            let header = if probe.has_header {
                Some(self.read_artifact_header(path)?)
            } else {
                Some(ArtifactHeader::new(
                    infer_artifact_type(path),
                    expected_schema_version(path),
                ))
            };
            return Ok((probe, header, serde_json::Value::String(raw)));
        }
        let value: serde_json::Value = serde_json::from_str(&raw)?;
        if has_artifact_header(&value) {
            let probe = self.probe_artifact(path)?;
            let header = self.read_artifact_header(path)?;
            return Ok((probe, Some(header), strip_artifact_header(value)));
        }
        let artifact_type = infer_artifact_type(path);
        Ok((
            ArtifactProbe {
                artifact_type: artifact_type.clone(),
                schema_version: if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    "legacy".to_string()
                } else {
                    "plain-text".to_string()
                },
                has_header: false,
                migration_result: if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    MigrationResult::CanUpgradeInPlace
                } else {
                    MigrationResult::CanReadDirectly
                },
            },
            Some(ArtifactHeader::new(
                artifact_type,
                expected_schema_version(path),
            )),
            value,
        ))
    }

    pub fn list_artifacts(&self, prefix: &Path) -> anyhow::Result<Vec<ArtifactMeta>> {
        let canonical_root = self
            .layout
            .root
            .canonicalize()
            .unwrap_or(self.layout.root.clone());
        let canonical_prefix = if prefix.is_absolute() {
            prefix.to_path_buf()
        } else {
            canonical_root.join(prefix)
        };
        let mut stack = vec![canonical_prefix];
        let mut artifacts = Vec::new();
        while let Some(path) = stack.pop() {
            if path.is_dir() {
                for entry in std::fs::read_dir(&path)? {
                    stack.push(entry?.path());
                }
                continue;
            }
            if is_artifact_sidecar(&path) {
                continue;
            }
            let metadata = std::fs::metadata(&path)?;
            let relative = path
                .strip_prefix(&canonical_root)
                .unwrap_or(&path)
                .to_path_buf();
            let checksum = Some(simple_checksum(&std::fs::read(&path)?));
            let (probe, header) = if path.extension().and_then(|ext| ext.to_str()) == Some("json")
                || is_markdown_artifact(&path)
            {
                let probe = self.probe_artifact(&path)?;
                let header = if probe.has_header {
                    Some(self.read_artifact_header(&path)?)
                } else {
                    Some(ArtifactHeader::new(
                        infer_artifact_type(&path),
                        expected_schema_version(&path),
                    ))
                };
                (probe, header)
            } else {
                (
                    ArtifactProbe {
                        artifact_type: infer_artifact_type(&path),
                        schema_version: "plain-text".to_string(),
                        has_header: false,
                        migration_result: MigrationResult::CanReadDirectly,
                    },
                    Some(ArtifactHeader::new(
                        infer_artifact_type(&path),
                        expected_schema_version(&path),
                    )),
                )
            };
            artifacts.push(ArtifactMeta {
                artifact_id: path_string(&relative),
                path: relative,
                header: header.unwrap_or_else(|| {
                    ArtifactHeader::new(infer_artifact_type(&path), expected_schema_version(&path))
                }),
                entity_id: infer_entity_id(&path),
                size_bytes: metadata.len(),
                checksum,
                probe_result: probe.migration_result,
                has_header: probe.has_header,
            });
        }
        artifacts.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(artifacts)
    }

    fn write_text_artifact_sidecar(&self, path: &Path, media_type: &str) -> anyhow::Result<()> {
        let Some(sidecar_path) = artifact_sidecar_path(path) else {
            return Ok(());
        };
        let relative_path = path
            .strip_prefix(&self.layout.root)
            .unwrap_or(path)
            .to_path_buf();
        let artifact = Artifact::new(
            infer_artifact_type(path),
            expected_schema_version(path),
            TextArtifactPayload {
                artifact_path: relative_path,
                media_type: media_type.to_string(),
                encoding: "utf-8".to_string(),
            },
        );
        let json = serde_json::to_string_pretty(&artifact)?;
        std::fs::write(sidecar_path, json)?;
        Ok(())
    }

    fn probe_non_json_artifact(&self, path: &Path) -> anyhow::Result<ArtifactProbe> {
        let artifact_type = infer_artifact_type(path);
        if let Some(sidecar_path) = artifact_sidecar_path(path) {
            if sidecar_path.exists() {
                let header = read_header_from_artifact_file(&sidecar_path)?;
                return Ok(probe_from_header(header, path));
            }
        }
        Ok(ArtifactProbe {
            artifact_type,
            schema_version: if is_markdown_artifact(path) {
                "legacy".to_string()
            } else {
                "plain-text".to_string()
            },
            has_header: false,
            migration_result: if is_markdown_artifact(path) {
                MigrationResult::CanUpgradeInPlace
            } else {
                MigrationResult::CanReadDirectly
            },
        })
    }

    fn read_artifact_header(&self, path: &Path) -> anyhow::Result<ArtifactHeader> {
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            return read_header_from_artifact_file(path);
        }
        if let Some(sidecar_path) = artifact_sidecar_path(path) {
            if sidecar_path.exists() {
                return read_header_from_artifact_file(&sidecar_path);
            }
        }
        Ok(ArtifactHeader::new(
            infer_artifact_type(path),
            expected_schema_version(path),
        ))
    }
}

fn has_artifact_header(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .map(|object| {
            object.contains_key("header")
                && object.contains_key("payload")
                && object
                    .get("header")
                    .and_then(|header| header.as_object())
                    .map(|header| {
                        header.contains_key("artifact_type")
                            && header.contains_key("schema_version")
                            && header.contains_key("created_by")
                            && header.contains_key("created_at")
                            && header.contains_key("protocol_compat")
                    })
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn read_header_from_artifact_file(path: &Path) -> anyhow::Result<ArtifactHeader> {
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    serde_json::from_value(
        value
            .get("header")
            .cloned()
            .context("artifact header missing header field")?,
    )
    .map_err(Into::into)
}

fn probe_from_header(header: ArtifactHeader, path: &Path) -> ArtifactProbe {
    let expected_schema = expected_schema_version(path);
    let migration_result = if header.schema_version == expected_schema {
        MigrationResult::CanReadDirectly
    } else {
        MigrationResult::RequiresRebuild
    };
    ArtifactProbe {
        artifact_type: header.artifact_type,
        schema_version: header.schema_version,
        has_header: true,
        migration_result,
    }
}

fn strip_artifact_header(value: serde_json::Value) -> serde_json::Value {
    value
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn artifact_sidecar_path(path: &Path) -> Option<PathBuf> {
    if !is_markdown_artifact(path) {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    Some(path.with_extension(format!("{extension}.meta.json")))
}

fn is_markdown_artifact(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("md")
}

fn is_artifact_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.ends_with(".md.meta.json"))
        .unwrap_or(false)
}

fn infer_artifact_type(path: &Path) -> String {
    match path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "run_manifest.json" => "run_manifest".to_string(),
        "run_state.json" => "run_state".to_string(),
        "graph.json" => "research_graph".to_string(),
        "graph_state.json" => "graph_state".to_string(),
        "budget_state.json" => "budget_state".to_string(),
        "checkpoint.json" => "node_checkpoint".to_string(),
        "node.json" => "research_node".to_string(),
        "input_manifest.json" => "node_input_manifest".to_string(),
        "output_manifest.json" => "node_output_manifest".to_string(),
        other if other.ends_with(".json") => other.trim_end_matches(".json").replace('.', "_"),
        other if other.ends_with(".md") => other.trim_end_matches(".md").replace('.', "_"),
        other if other.ends_with(".jsonl") => other.trim_end_matches(".jsonl").replace('.', "_"),
        _ => "artifact".to_string(),
    }
}

fn expected_schema_version(_path: &Path) -> String {
    "1.0".to_string()
}

fn infer_entity_id(path: &Path) -> Option<String> {
    path.parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn simple_checksum(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

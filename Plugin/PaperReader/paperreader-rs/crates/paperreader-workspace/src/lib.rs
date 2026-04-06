//! PaperReader Workspace Crate
//!
//! 本crate实现PaperReader系统的运行时外存系统（long-lived cognitive external memory）。
//! 负责：工件持久化、检查点管理、迁移注册表、工作空间初始化。
//!
//! 设计原则：
//! - 工件优先于内存态
//! - 节点优先于整图
//! - 恢复优先于整洁
//! - 追溯优先于美观

mod artifact;
mod bootstrap;
mod layout;
mod migration;
mod models;
mod paths;
mod prelude;
mod repository;
mod trace;

pub use artifact::*;
pub use bootstrap::*;
pub use layout::*;
pub use migration::*;
pub use models::*;
pub use paths::*;
pub use repository::*;
pub use trace::*;

// =============================================================================
// 业务不变量模块
// =============================================================================

pub mod invariants;
pub use invariants::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prelude::*;

    fn temp_trace_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperreader-workspace-test-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn test_workspace_layout() {
        let layout = WorkspaceLayout::new("/tmp/workspace");
        assert_eq!(
            layout.documents_dir(),
            PathBuf::from("/tmp/workspace/documents")
        );
        assert_eq!(
            layout.document_dir(&DocumentId::new("doc-001")),
            PathBuf::from("/tmp/workspace/documents/doc-001")
        );
    }

    #[test]
    fn test_run_artifact_paths() {
        let paths = RunArtifactPaths::new(Path::new("/tmp/run-001"));
        assert_eq!(
            paths.run_manifest,
            PathBuf::from("/tmp/run-001/run_manifest.json")
        );
        assert_eq!(paths.nodes_dir, PathBuf::from("/tmp/run-001/nodes"));
    }

    #[test]
    fn test_node_artifact_paths() {
        let paths = NodeArtifactPaths::new(Path::new("/tmp/nodes"), "n_read_01");
        assert_eq!(
            paths.node_json,
            PathBuf::from("/tmp/nodes/n_read_01/node.json")
        );
        assert_eq!(
            paths.handoff_out,
            PathBuf::from("/tmp/nodes/n_read_01/handoff_out.json")
        );
    }

    #[test]
    fn test_artifact_header() {
        let header = ArtifactHeader::new("run_manifest", "1.0");
        assert_eq!(header.artifact_type, "run_manifest");
        assert_eq!(header.schema_version, "1.0");
        assert_eq!(header.protocol_compat.min_protocol, "1.0");
    }

    #[test]
    fn test_migration_registry() {
        let registry = MigrationRegistry::new();
        assert!(!registry.can_migrate("1.0", "2.0"));

        // Note: In real usage, you would register actual migrations
        // For this test, we just verify the API works
    }

    #[test]
    fn test_markdown_artifact_sidecar_provides_header_and_probe() {
        let root = temp_trace_root();
        let repo = WorkspaceRepository::new(root.clone());
        repo.bootstrap().unwrap();

        let markdown_path = root.join("documents/doc-1/reading/synthesis.latest.md");
        repo.write_markdown(&markdown_path, "# Heading\n\ncontent")
            .unwrap();

        let probe = repo.probe_artifact(&markdown_path).unwrap();
        assert_eq!(probe.artifact_type, "synthesis_latest");
        assert_eq!(probe.schema_version, "1.0");
        assert!(probe.has_header);
        assert_eq!(probe.migration_result, MigrationResult::CanReadDirectly);

        let (probe_from_read, header, data) = repo.read_artifact_value(&markdown_path).unwrap();
        assert_eq!(probe_from_read, probe);
        assert_eq!(
            header.unwrap().artifact_type,
            "synthesis_latest".to_string()
        );
        assert_eq!(
            data,
            serde_json::Value::String("# Heading\n\ncontent".to_string())
        );

        let artifacts = repo.list_artifacts(&root).unwrap();
        let markdown_entry = artifacts
            .iter()
            .find(|artifact| {
                artifact
                    .path
                    .to_string_lossy()
                    .replace('\\', "/")
                    .ends_with("documents/doc-1/reading/synthesis.latest.md")
            })
            .expect("markdown artifact should be listed");
        assert!(markdown_entry.has_header);
        assert_eq!(markdown_entry.header.artifact_type, "synthesis_latest");
        assert!(
            artifacts
                .iter()
                .all(|artifact| !artifact.path.to_string_lossy().ends_with(".md.meta.json"))
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_trace_store_persists_jsonl_and_reads_with_cursor() {
        let root = temp_trace_root();
        let store = TraceStore::new(root.clone());
        let event_one = TraceEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            run_id: "run-1".to_string(),
            node_id: None,
            event_type: "run_started".to_string(),
            input_refs: Vec::new(),
            output_refs: Vec::new(),
            budget_delta: None,
            note: None,
        };
        let event_two = TraceEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            run_id: "run-1".to_string(),
            node_id: Some("read".to_string()),
            event_type: "node_completed".to_string(),
            input_refs: vec![PathBuf::from("documents/doc-1/reading/reading_state.json")],
            output_refs: vec![PathBuf::from("runs/run-1/nodes/read/result.json")],
            budget_delta: Some(BudgetConsumed {
                tokens: 10,
                llm_calls: 1,
                elapsed_seconds: 2,
            }),
            note: Some("done".to_string()),
        };

        store.append_event("run-1", &event_one).unwrap();
        store.append_event("run-1", &event_two).unwrap();

        let raw = std::fs::read_to_string(store.trace_path("run-1")).unwrap();
        assert_eq!(raw.lines().count(), 2);

        let (first_page, next_cursor, end_of_stream) = store.read_events("run-1", 0, 1).unwrap();
        assert_eq!(first_page.len(), 1);
        assert_eq!(first_page[0].event_type, "run_started");
        assert_eq!(next_cursor, 1);
        assert!(!end_of_stream);

        let (second_page, next_cursor, end_of_stream) =
            store.read_events("run-1", next_cursor, 10).unwrap();
        assert_eq!(second_page.len(), 1);
        assert_eq!(second_page[0].event_type, "node_completed");
        assert_eq!(next_cursor, 2);
        assert!(end_of_stream);

        std::fs::remove_dir_all(root).unwrap();
    }
}

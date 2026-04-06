use super::*;

impl PaperReaderApplication {
    pub fn bootstrap_workspace(&self, payload: &Value) -> Result<Value> {
        let root = self.resolve_workspace_root(payload);
        let created = !root.exists();
        let repo = BootstrapWorkspace::ensure(root.clone())?;
        let snapshot = self.build_health_snapshot();
        let health_path = repo.layout.shared_dir().join("health_snapshot.json");
        repo.write_json(&health_path, &snapshot)?;
        Ok(json!({
            "workspace_root": root,
            "created": created,
            "health_snapshot_ref": display_path(&health_path),
        }))
    }

    pub fn describe_runtime(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let snapshot = self.build_health_snapshot();
        let health_path = repo.layout.shared_dir().join("health_snapshot.json");
        repo.write_json(&health_path, &snapshot)?;
        Ok(json!({
            "protocol_version": self.config.protocol_version,
            "supported_commands": supported_commands(),
            "capabilities": self.config.capabilities(),
            "feature_flags": ["collection-scope-research-graph", "background-async-worker"],
            "index_backends": ["structural-lexical"],
            "policy_backends": ["deterministic-fallback"],
            "health_snapshot_ref": display_path(&health_path),
        }))
    }

    pub fn get_health_snapshot_value(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let snapshot = self.build_health_snapshot();
        let health_path = repo.layout.shared_dir().join("health_snapshot.json");
        repo.write_json(&health_path, &snapshot)?;
        Ok(serde_json::to_value(snapshot)?)
    }

    fn build_health_snapshot(&self) -> HealthSnapshot {
        let mut component_status = HashMap::new();
        component_status.insert(
            "runtime".to_string(),
            if self.config.api_key_present {
                HealthStatus::Healthy
            } else {
                HealthStatus::Degraded
            },
        );
        component_status.insert(
            "mineru".to_string(),
            if self.config.mineru_api_token_present {
                HealthStatus::Healthy
            } else {
                HealthStatus::Degraded
            },
        );
        HealthSnapshot {
            snapshot_id: format!("hs-{}", chrono::Utc::now().timestamp()),
            overall_status: if self.config.api_key_present || self.config.mineru_api_token_present {
                HealthStatus::Healthy
            } else {
                HealthStatus::Degraded
            },
            component_status,
            timestamp: chrono::Utc::now().to_rfc3339(),
            metrics: Some(HealthMetrics {
                memory_usage_mb: 0,
                cpu_percent: 0.0,
                pending_requests: 0,
            }),
        }
    }
}

fn supported_commands() -> Vec<String> {
    vec![
        "bootstrap_workspace".to_string(),
        "describe_runtime".to_string(),
        "get_health_snapshot".to_string(),
        "ingest_source".to_string(),
        "ingest_collection".to_string(),
        "refresh_ingestion".to_string(),
        "read_document".to_string(),
        "resume_read".to_string(),
        "audit_document".to_string(),
        "trace_claim_in_document".to_string(),
        "survey_collection".to_string(),
        "synthesize_collection".to_string(),
        "compare_documents".to_string(),
        "audit_collection_conflicts".to_string(),
        "retrieve_evidence".to_string(),
        "build_evidence_pack".to_string(),
        "plan_research".to_string(),
        "run_research_graph".to_string(),
        "resume_research_graph".to_string(),
        "stream_run_events".to_string(),
        "get_run_state".to_string(),
        "cancel_run".to_string(),
        "get_workspace_state".to_string(),
        "list_artifacts".to_string(),
        "get_artifact".to_string(),
        "reset_run".to_string(),
        "IngestPDF".to_string(),
        "Read".to_string(),
        "ReadSkeleton".to_string(),
        "ReadDeep".to_string(),
        "Query".to_string(),
    ]
}

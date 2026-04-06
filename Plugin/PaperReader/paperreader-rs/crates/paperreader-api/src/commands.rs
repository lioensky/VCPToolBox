use crate::*;
use paperreader_application::PaperReaderApplication;
use paperreader_domain::CommandEnvelope;
use std::sync::Arc;

pub struct RoutedCommandHandler {
    command_name: String,
    app: Arc<PaperReaderApplication>,
}

impl RoutedCommandHandler {
    pub fn new(command_name: impl Into<String>, app: Arc<PaperReaderApplication>) -> Self {
        Self {
            command_name: command_name.into(),
            app,
        }
    }
}

impl CommandProcessor for RoutedCommandHandler {
    fn process(
        &self,
        envelope: CommandEnvelope,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CommandResponse, ApiError>> + Send + '_>,
    > {
        let app = self.app.clone();
        Box::pin(async move {
            let response = crate::process_envelope(envelope, &app).await;
            Ok(CommandResponse::from_response_envelope(response))
        })
    }

    fn command_name(&self) -> &str {
        &self.command_name
    }
}

pub fn canonical_command_name(command: &str) -> String {
    match command {
        "IngestPDF" => "ingest_source".to_string(),
        "Read" => "read_document".to_string(),
        "ReadSkeleton" => "read_document".to_string(),
        "ReadDeep" => "read_document".to_string(),
        "Query" => "retrieve_evidence".to_string(),
        "ingest" => "ingest_source".to_string(),
        "ingest_coll" => "ingest_collection".to_string(),
        "read" => "read_document".to_string(),
        "query" => "retrieve_evidence".to_string(),
        "build_pack" => "build_evidence_pack".to_string(),
        "audit" => "audit_document".to_string(),
        "trace" => "trace_claim_in_document".to_string(),
        "trace_claim" => "trace_claim_in_document".to_string(),
        "survey" => "survey_collection".to_string(),
        "synthesize" => "synthesize_collection".to_string(),
        "compare" => "compare_documents".to_string(),
        "conflict_audit" => "audit_collection_conflicts".to_string(),
        "audit_conflicts" => "audit_collection_conflicts".to_string(),
        "refresh" => "refresh_ingestion".to_string(),
        "reset" => "reset_run".to_string(),
        "resume" => "resume_research_graph".to_string(),
        "status" => "get_workspace_state".to_string(),
        "health" => "get_health_snapshot".to_string(),
        other => match other {
            "bootstrap_workspace" => "bootstrap_workspace".to_string(),
            "describe_runtime" => "describe_runtime".to_string(),
            "get_health_snapshot" => "get_health_snapshot".to_string(),
            "ingest_source" => "ingest_source".to_string(),
            "ingest_collection" => "ingest_collection".to_string(),
            "refresh_ingestion" => "refresh_ingestion".to_string(),
            "read_document" => "read_document".to_string(),
            "resume_read" => "resume_read".to_string(),
            "audit_document" => "audit_document".to_string(),
            "trace_claim_in_document" => "trace_claim_in_document".to_string(),
            "survey_collection" => "survey_collection".to_string(),
            "synthesize_collection" => "synthesize_collection".to_string(),
            "compare_documents" => "compare_documents".to_string(),
            "audit_collection_conflicts" => "audit_collection_conflicts".to_string(),
            "retrieve_evidence" => "retrieve_evidence".to_string(),
            "build_evidence_pack" => "build_evidence_pack".to_string(),
            "plan_research" => "plan_research".to_string(),
            "run_research_graph" => "run_research_graph".to_string(),
            "resume_research_graph" => "resume_research_graph".to_string(),
            "stream_run_events" => "stream_run_events".to_string(),
            "get_run_state" => "get_run_state".to_string(),
            "cancel_run" => "cancel_run".to_string(),
            "get_workspace_state" => "get_workspace_state".to_string(),
            "list_artifacts" => "list_artifacts".to_string(),
            "get_artifact" => "get_artifact".to_string(),
            "reset_run" => "reset_run".to_string(),
            _ => other.to_string(),
        },
    }
}

pub fn register_all_handlers(interface: &mut StdioInterface) {
    let app = Arc::new(PaperReaderApplication::from_env().unwrap_or_else(|_| {
        PaperReaderApplication::new(paperreader_application::RuntimeConfig::from_env())
    }));

    for command in [
        "bootstrap_workspace",
        "describe_runtime",
        "get_health_snapshot",
        "ingest_source",
        "ingest_collection",
        "refresh_ingestion",
        "read_document",
        "resume_read",
        "audit_document",
        "trace_claim_in_document",
        "survey_collection",
        "synthesize_collection",
        "compare_documents",
        "audit_collection_conflicts",
        "retrieve_evidence",
        "build_evidence_pack",
        "plan_research",
        "run_research_graph",
        "resume_research_graph",
        "stream_run_events",
        "get_run_state",
        "cancel_run",
        "get_workspace_state",
        "list_artifacts",
        "get_artifact",
        "reset_run",
        "ingest",
        "ingest_coll",
        "read",
        "IngestPDF",
        "Read",
        "ReadSkeleton",
        "ReadDeep",
        "Query",
        "query",
        "build_pack",
        "audit",
        "trace",
        "trace_claim",
        "survey",
        "synthesize",
        "compare",
        "conflict_audit",
        "audit_conflicts",
        "refresh",
        "reset",
        "resume",
        "status",
        "health",
    ] {
        let canonical = canonical_command_name(command);
        interface.register_handler(Box::new(RoutedCommandHandler::new(canonical, app.clone())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alias_mapping() {
        assert_eq!(canonical_command_name("IngestPDF"), "ingest_source");
        assert_eq!(canonical_command_name("Read"), "read_document");
        assert_eq!(canonical_command_name("ReadSkeleton"), "read_document");
        assert_eq!(canonical_command_name("ReadDeep"), "read_document");
        assert_eq!(canonical_command_name("Query"), "retrieve_evidence");
        assert_eq!(canonical_command_name("ingest"), "ingest_source");
        assert_eq!(canonical_command_name("ingest_coll"), "ingest_collection");
        assert_eq!(canonical_command_name("read"), "read_document");
        assert_eq!(canonical_command_name("health"), "get_health_snapshot");
        assert_eq!(canonical_command_name("audit"), "audit_document");
        assert_eq!(
            canonical_command_name("trace_claim"),
            "trace_claim_in_document"
        );
        assert_eq!(canonical_command_name("survey"), "survey_collection");
        assert_eq!(
            canonical_command_name("synthesize"),
            "synthesize_collection"
        );
        assert_eq!(canonical_command_name("compare"), "compare_documents");
        assert_eq!(
            canonical_command_name("conflict_audit"),
            "audit_collection_conflicts"
        );
        assert_eq!(canonical_command_name("build_pack"), "build_evidence_pack");
        assert_eq!(canonical_command_name("reset"), "reset_run");
        assert_eq!(
            canonical_command_name("stream_run_events"),
            "stream_run_events"
        );
    }
}

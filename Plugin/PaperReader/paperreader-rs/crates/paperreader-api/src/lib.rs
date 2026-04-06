//! PaperReader API Module
//!
//! 提供 MCP stdio 接口和命令处理功能。

// 模块导出
pub mod commands;
pub mod stdio_interface;

// 重新导出主要类型
pub use commands::*;
pub use stdio_interface::*;

use paperreader_application::{PaperReaderApplication, validate_envelope};
use paperreader_domain::CommandEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// 响应信封
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    /// 请求ID
    pub request_id: String,
    /// 状态
    pub status: String,
    /// 命令
    pub command: String,
    /// 接受的能力
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_capabilities: Vec<String>,
    /// 拒绝的能力
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected_capabilities: Vec<String>,
    /// 降级模式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degrade_mode: Option<String>,
    /// 数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// 工件
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    /// 警告
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// 错误
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ApiError>,
}

/// 处理请求
pub fn handle_request(raw: &str) -> Result<ResponseEnvelope, String> {
    let envelope: CommandEnvelope = match serde_json::from_str(raw) {
        Ok(envelope) => envelope,
        Err(err) => {
            return Ok(ResponseEnvelope::error(
                "unknown",
                "unknown",
                "TransportError.InvalidJson",
                format!("Failed to parse request: {err}"),
            ));
        }
    };
    let runtime = tokio::runtime::Runtime::new().map_err(|err| err.to_string())?;
    let app = PaperReaderApplication::from_env().map_err(|err| err.to_string())?;
    Ok(runtime.block_on(async { process_envelope(envelope, &app).await }))
}

/// 创建 API 服务器
pub fn create_server() -> StdioInterface {
    let mut interface = StdioInterface::new();
    register_all_handlers(&mut interface);
    interface
}

pub async fn process_envelope(
    envelope: CommandEnvelope,
    app: &PaperReaderApplication,
) -> ResponseEnvelope {
    let canonical = canonical_command_name(&envelope.command);
    let request_id = envelope.request_id.clone();
    let negotiation = match negotiate_request(&envelope, app, &canonical) {
        Ok(negotiation) => negotiation,
        Err(response) => return response,
    };
    let payload = merge_envelope_payload(&envelope, &canonical);
    match app.dispatch(&canonical, &payload).await {
        Ok(data) => finalize_response(request_id, canonical, negotiation, data),
        Err(err) => ResponseEnvelope::error_with_negotiation(
            envelope.request_id,
            canonical,
            negotiation,
            "ApplicationError.DispatchFailed",
            err.to_string(),
        ),
    }
}

#[derive(Debug, Clone)]
pub struct NegotiationOutcome {
    pub accepted_capabilities: Vec<String>,
    pub rejected_capabilities: Vec<String>,
    pub degrade_mode: Option<String>,
    pub warnings: Vec<String>,
}

impl ResponseEnvelope {
    pub fn success(
        request_id: impl Into<String>,
        command: impl Into<String>,
        negotiation: NegotiationOutcome,
        data: Value,
    ) -> Self {
        let artifacts = extract_artifacts(&data);
        let status = extract_status(&data, negotiation.degrade_mode.as_ref(), false);
        Self {
            request_id: request_id.into(),
            status,
            command: command.into(),
            accepted_capabilities: negotiation.accepted_capabilities,
            rejected_capabilities: negotiation.rejected_capabilities,
            degrade_mode: negotiation.degrade_mode,
            data: Some(data),
            artifacts,
            warnings: negotiation.warnings,
            errors: Vec::new(),
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        command: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            status: "error".to_string(),
            command: command.into(),
            accepted_capabilities: Vec::new(),
            rejected_capabilities: Vec::new(),
            degrade_mode: None,
            data: None,
            artifacts: Vec::new(),
            warnings: Vec::new(),
            errors: vec![ApiError {
                code: code.into(),
                message: message.into(),
                details: None,
            }],
        }
    }

    pub fn error_with_negotiation(
        request_id: impl Into<String>,
        command: impl Into<String>,
        negotiation: NegotiationOutcome,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            status: "error".to_string(),
            command: command.into(),
            accepted_capabilities: negotiation.accepted_capabilities,
            rejected_capabilities: negotiation.rejected_capabilities,
            degrade_mode: negotiation.degrade_mode,
            data: None,
            artifacts: Vec::new(),
            warnings: negotiation.warnings,
            errors: vec![ApiError {
                code: code.into(),
                message: message.into(),
                details: None,
            }],
        }
    }
}

fn negotiate_request(
    envelope: &CommandEnvelope,
    app: &PaperReaderApplication,
    canonical: &str,
) -> Result<NegotiationOutcome, ResponseEnvelope> {
    validate_envelope(envelope).map_err(|err| {
        ResponseEnvelope::error(
            envelope.request_id.clone(),
            canonical.to_string(),
            "ValidationError.InvalidEnvelope",
            err.to_string(),
        )
    })?;
    if !envelope.protocol_version.starts_with("1.") {
        return Err(ResponseEnvelope::error(
            envelope.request_id.clone(),
            canonical.to_string(),
            "ProtocolError.IncompatibleProtocol",
            format!("Unsupported protocol_version {}", envelope.protocol_version),
        ));
    }
    if let Some(schema_version) = envelope
        .payload
        .get("schema_version")
        .and_then(|value| value.as_str())
        .filter(|version| *version != "1.0")
    {
        return Err(ResponseEnvelope::error(
            envelope.request_id.clone(),
            canonical.to_string(),
            "SchemaError.IncompatibleRequestSchema",
            format!("Unsupported schema_version {schema_version}"),
        ));
    }

    let runtime_capabilities = app.config().capabilities();
    let requested_capabilities = envelope.requested_capabilities();
    let accepted_capabilities = requested_capabilities
        .iter()
        .filter(|capability| runtime_capabilities.contains(capability))
        .cloned()
        .collect::<Vec<_>>();
    let rejected_capabilities = requested_capabilities
        .iter()
        .filter(|capability| !runtime_capabilities.contains(capability))
        .cloned()
        .collect::<Vec<_>>();
    let execution = envelope.normalized_execution();
    let strict = execution
        .as_ref()
        .map(|ctx| ctx.strict_capability_match)
        .unwrap_or(false);
    if strict && !rejected_capabilities.is_empty() {
        return Err(ResponseEnvelope::error(
            envelope.request_id.clone(),
            canonical.to_string(),
            "CapabilityError.UnsupportedCapability",
            format!(
                "Unsupported capabilities: {}",
                rejected_capabilities.join(", ")
            ),
        ));
    }
    let degrade_mode = if execution.as_ref().map(|ctx| ctx.mode.clone())
        == Some(paperreader_domain::ExecutionMode::Stream)
        && !accepted_capabilities.contains(&"streaming-ready".to_string())
    {
        Some("polling_stream_bridge".to_string())
    } else if execution.as_ref().map(|ctx| ctx.mode.clone())
        == Some(paperreader_domain::ExecutionMode::Async)
        && !accepted_capabilities.contains(&"accepted-response".to_string())
    {
        Some("sync_fallback".to_string())
    } else {
        None
    };
    let mut warnings = Vec::new();
    if !rejected_capabilities.is_empty() {
        warnings.push(format!(
            "Rejected capabilities: {}",
            rejected_capabilities.join(", ")
        ));
    }
    Ok(NegotiationOutcome {
        accepted_capabilities,
        rejected_capabilities,
        degrade_mode,
        warnings,
    })
}

fn merge_envelope_payload(envelope: &CommandEnvelope, canonical: &str) -> Value {
    let mut payload = envelope.payload.clone();
    let object = payload.as_object_mut();
    if let Some(map) = object {
        if let Some(workspace) = &envelope.workspace {
            map.entry("workspace_root".to_string())
                .or_insert_with(|| json!(workspace.root));
            if let Some(run_id) = &workspace.run_id {
                map.entry("run_id".to_string())
                    .or_insert_with(|| json!(run_id));
            }
        }
        if let Some(execution) = envelope.normalized_execution() {
            map.entry("execution".to_string())
                .or_insert_with(|| serde_json::to_value(execution).unwrap_or_else(|_| json!({})));
        }
        if let Some(idempotency_key) = &envelope.idempotency_key {
            map.entry("idempotency_key".to_string())
                .or_insert_with(|| json!(idempotency_key));
        }
        map.entry("legacy_command".to_string())
            .or_insert_with(|| json!(envelope.command.clone()));
        normalize_legacy_payload_fields(canonical, map);
    }
    payload
}

fn normalize_legacy_payload_fields(
    canonical: &str,
    map: &mut serde_json::Map<String, serde_json::Value>,
) {
    move_payload_alias(map, "paperId", "document_id");
    move_payload_alias(map, "paper_id", "document_id");
    move_payload_alias(map, "filePath", "source_path");
    move_payload_alias(map, "file_path", "source_path");
    move_payload_alias(map, "question", "query_text");
    move_payload_alias(map, "focus", "goal");
    move_payload_alias(map, "artifactRef", "artifact_path");
    move_payload_alias(map, "artifact_ref", "artifact_path");

    match canonical {
        "ingest_source" => {
            move_payload_alias(map, "document_id", "document_id");
            if let Some(document_name) = map.get("document_name").cloned() {
                map.entry("display_name".to_string())
                    .or_insert(document_name);
            }
        }
        "read_document" => {
            if let Some(force_reread) = map.get("forceReread").and_then(|value| value.as_bool()) {
                if force_reread {
                    map.insert("force_reread".to_string(), json!(true));
                } else {
                    map.entry("resume_from_state".to_string())
                        .or_insert_with(|| json!(true));
                }
            }
            let original_command = map
                .get("legacy_command")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if original_command == "ReadSkeleton" {
                map.entry("mode".to_string())
                    .or_insert_with(|| json!("survey_only"));
            } else if original_command == "ReadDeep" {
                map.entry("mode".to_string())
                    .or_insert_with(|| json!("deep_focus"));
            } else if original_command == "Read" {
                map.entry("mode".to_string())
                    .or_insert_with(|| json!("auto"));
            }
        }
        "retrieve_evidence" | "build_evidence_pack" => {
            if !map.contains_key("query_text") {
                move_payload_alias(map, "claim", "query_text");
            }
        }
        "trace_claim_in_document" => {
            move_payload_alias(map, "question", "claim_text");
            move_payload_alias(map, "query_text", "claim_text");
        }
        _ => {}
    }
}

fn move_payload_alias(map: &mut serde_json::Map<String, serde_json::Value>, from: &str, to: &str) {
    if from == to {
        return;
    }
    if map.contains_key(to) {
        return;
    }
    if let Some(value) = map.remove(from) {
        map.insert(to.to_string(), value);
    }
}

fn finalize_response(
    request_id: String,
    canonical: String,
    negotiation: NegotiationOutcome,
    data: Value,
) -> ResponseEnvelope {
    ResponseEnvelope::success(request_id, canonical, negotiation, data)
}

fn extract_status(data: &Value, degrade_mode: Option<&String>, has_errors: bool) -> String {
    if let Some(status) = data.get("status").and_then(|value| value.as_str()) {
        return status.to_string();
    }
    if has_errors {
        return "error".to_string();
    }
    if degrade_mode.is_some() {
        return "partial".to_string();
    }
    "ok".to_string()
}

fn extract_artifacts(data: &Value) -> Vec<String> {
    let mut artifacts = data
        .get("artifact_refs")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (key, value) in data
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
    {
        if key.ends_with("_ref") {
            if let Some(path) = value.as_str() {
                artifacts.push(path.to_string());
            }
        }
    }
    artifacts.sort();
    artifacts.dedup();
    artifacts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> String {
        let root = std::env::temp_dir().join(format!(
            "paperreader-api-test-{}",
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_else(|| chrono::Utc::now().timestamp_micros() * 1_000)
        ));
        std::fs::create_dir_all(&root).unwrap();
        root.to_string_lossy().to_string()
    }

    #[test]
    fn test_handle_request() {
        let request = r#"{
            "protocol_version": "1.0",
            "command": "health",
            "request_id": "req-001",
            "payload": {}
        }"#;

        let response = handle_request(request);
        assert!(response.is_ok());

        let envelope = response.unwrap();
        assert_eq!(envelope.request_id, "req-001");
        assert_eq!(envelope.command, "get_health_snapshot");
        assert!(envelope.data.is_some());
    }

    #[test]
    fn test_handle_request_stream_execution_negotiates_poll_bridge() {
        let request = serde_json::json!({
            "protocol_version": "1.0",
            "command": "health",
            "request_id": "req-stream",
            "workspace": {
                "root": temp_root()
            },
            "execution": {
                "mode": "stream"
            },
            "payload": {}
        });

        let response = handle_request(&request.to_string()).unwrap();

        assert_eq!(response.status, "partial");
        assert_eq!(response.command, "get_health_snapshot");
        assert_eq!(
            response.degrade_mode.as_deref(),
            Some("polling_stream_bridge")
        );
        assert!(response.errors.is_empty());
    }

    #[test]
    fn test_handle_request_strict_capability_mismatch_errors() {
        let request = serde_json::json!({
            "protocol_version": "1.0",
            "command": "health",
            "request_id": "req-strict",
            "client": {
                "name": "vcp-host",
                "version": "1.0",
                "capabilities": ["unsupported-capability"]
            },
            "execution": {
                "mode": "sync",
                "strict_capability_match": true
            },
            "payload": {}
        });

        let response = handle_request(&request.to_string()).unwrap();

        assert_eq!(response.status, "error");
        assert_eq!(response.command, "get_health_snapshot");
        assert_eq!(response.errors.len(), 1);
        assert_eq!(
            response.errors[0].code,
            "CapabilityError.UnsupportedCapability"
        );
    }

    #[test]
    fn test_merge_envelope_payload_normalizes_legacy_vcp_fields() {
        let envelope: CommandEnvelope = serde_json::from_value(serde_json::json!({
            "protocol_version": "1.0",
            "command": "ReadDeep",
            "request_id": "req-legacy",
            "payload": {
                "paperId": "doc-123",
                "goal": "understand methods",
                "forceReread": false
            }
        }))
        .unwrap();

        let payload = merge_envelope_payload(&envelope, "read_document");

        assert_eq!(payload["document_id"], "doc-123");
        assert_eq!(payload["mode"], "deep_focus");
        assert_eq!(payload["resume_from_state"], true);
        assert_eq!(payload["legacy_command"], "ReadDeep");
    }

    #[test]
    fn test_create_server() {
        let server = create_server();
        // 服务器创建成功
        assert!(!server.is_running());
    }
}

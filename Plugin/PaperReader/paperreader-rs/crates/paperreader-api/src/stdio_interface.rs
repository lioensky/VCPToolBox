//! Stdio Interface - 标准输入输出接口
//!
//! 实现 MCP stdio 协议，处理命令请求和响应。

use crate::*;
use paperreader_domain::*;
use serde_json::Value;
use std::io::{self, BufRead, Write};

/// Stdio 接口
pub struct StdioInterface {
    /// 命令处理器
    handler: CommandHandler,
    /// 运行状态
    running: bool,
}

/// 命令处理器
pub struct CommandHandler {
    /// 处理器注册表
    handlers: std::collections::HashMap<String, Box<dyn CommandProcessor>>,
}

/// 命令处理器 trait
pub trait CommandProcessor: Send + Sync {
    /// 处理命令
    fn process(
        &self,
        envelope: CommandEnvelope,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CommandResponse, ApiError>> + Send + '_>,
    >;

    /// 获取命令名称
    fn command_name(&self) -> &str;
}

/// 命令响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResponse {
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
    pub data: Option<Value>,
    /// 工件
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    /// 警告
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// 错误信息
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ApiError>,
    /// 元数据
    pub metadata: Option<ResponseMetadata>,
}

/// 响应元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseMetadata {
    /// 处理时间（毫秒）
    pub processing_time_ms: u64,
    /// Token消耗
    pub tokens_consumed: Option<u64>,
    /// 警告信息
    pub warnings: Vec<String>,
}

/// API 错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    /// 错误代码
    pub code: String,
    /// 错误消息
    pub message: String,
    /// 错误详情
    pub details: Option<Value>,
}

impl StdioInterface {
    /// 创建新的 Stdio 接口
    pub fn new() -> Self {
        Self {
            handler: CommandHandler::new(),
            running: false,
        }
    }

    /// 注册命令处理器
    pub fn register_handler(&mut self, processor: Box<dyn CommandProcessor>) {
        self.handler.register(processor);
    }

    /// 运行接口（阻塞）
    pub async fn run(&mut self) -> Result<(), ApiError> {
        self.running = true;

        let stdin = io::stdin();
        let mut stdout = io::stdout();

        writeln!(
            stdout,
            "{{\"status\": \"ready\", \"protocol_version\": \"1.0\"}}"
        )
        .map_err(|e| ApiError {
            code: "IO_ERROR".to_string(),
            message: e.to_string(),
            details: None,
        })?;
        stdout.flush().map_err(|e| ApiError {
            code: "IO_ERROR".to_string(),
            message: e.to_string(),
            details: None,
        })?;

        for line in stdin.lock().lines() {
            if !self.running {
                break;
            }

            match line {
                Ok(input) => {
                    if input.trim().is_empty() {
                        continue;
                    }

                    match self.process_input(&input).await {
                        Ok(response) => {
                            let json = serde_json::to_string(&response).unwrap_or_else(|_| {
                                "{\"error\": \"serialization failed\"}".to_string()
                            });
                            writeln!(stdout, "{}", json).ok();
                            stdout.flush().ok();
                        }
                        Err(e) => {
                            let error_response = serde_json::json!({
                                "status": "error",
                                "error": {
                                    "code": e.code,
                                    "message": e.message
                                }
                            });
                            writeln!(stdout, "{}", error_response).ok();
                            stdout.flush().ok();
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error reading input: {}", e);
                    break;
                }
            }
        }

        Ok(())
    }

    /// 处理输入
    async fn process_input(&self, input: &str) -> Result<CommandResponse, ApiError> {
        let start_time = std::time::Instant::now();

        // 解析命令信封
        let envelope: CommandEnvelope = match serde_json::from_str(input) {
            Ok(envelope) => envelope,
            Err(e) => {
                return Ok(CommandResponse::error(
                    "unknown",
                    "unknown",
                    "TransportError.InvalidJson",
                    format!("Failed to parse request: {}", e),
                ));
            }
        };

        // 处理命令
        let result = self.handler.handle(&envelope).await;

        let processing_time_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(mut response) => {
                // 添加元数据
                if response.metadata.is_none() {
                    response.metadata = Some(ResponseMetadata {
                        processing_time_ms,
                        tokens_consumed: None,
                        warnings: vec![],
                    });
                }
                Ok(response)
            }
            Err(e) => Err(e),
        }
    }

    /// 停止接口
    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn is_running(&self) -> bool {
        self.running
    }
}

impl Default for StdioInterface {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandHandler {
    /// 创建新的命令处理器
    pub fn new() -> Self {
        Self {
            handlers: std::collections::HashMap::new(),
        }
    }

    /// 注册处理器
    pub fn register(&mut self, processor: Box<dyn CommandProcessor>) {
        let command_name = processor.command_name().to_string();
        self.handlers.insert(command_name, processor);
    }

    /// 处理命令
    pub async fn handle(&self, envelope: &CommandEnvelope) -> Result<CommandResponse, ApiError> {
        let canonical = crate::commands::canonical_command_name(&envelope.command);
        let handler = self.handlers.get(&canonical).ok_or_else(|| ApiError {
            code: "UNKNOWN_COMMAND".to_string(),
            message: format!("Unknown command: {}", envelope.command),
            details: None,
        })?;

        handler.process(envelope.clone()).await
    }
}

impl Default for CommandHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandResponse {
    pub fn from_response_envelope(response: ResponseEnvelope) -> Self {
        Self {
            request_id: response.request_id,
            status: response.status,
            command: response.command,
            accepted_capabilities: response.accepted_capabilities,
            rejected_capabilities: response.rejected_capabilities,
            degrade_mode: response.degrade_mode,
            data: response.data,
            artifacts: response.artifacts,
            warnings: response.warnings,
            errors: response.errors,
            metadata: None,
        }
    }

    /// 创建成功响应
    pub fn success(request_id: impl Into<String>, command: impl Into<String>, data: Value) -> Self {
        Self {
            request_id: request_id.into(),
            status: "ok".to_string(),
            command: command.into(),
            accepted_capabilities: Vec::new(),
            rejected_capabilities: Vec::new(),
            degrade_mode: None,
            data: Some(data),
            artifacts: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
            metadata: None,
        }
    }

    /// 创建错误响应
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
            metadata: None,
        }
    }

    /// 创建部分成功响应
    pub fn partial(
        request_id: impl Into<String>,
        command: impl Into<String>,
        data: Value,
        warnings: Vec<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            status: "partial".to_string(),
            command: command.into(),
            accepted_capabilities: Vec::new(),
            rejected_capabilities: Vec::new(),
            degrade_mode: None,
            data: Some(data),
            artifacts: Vec::new(),
            warnings,
            errors: Vec::new(),
            metadata: Some(ResponseMetadata {
                processing_time_ms: 0,
                tokens_consumed: None,
                warnings: Vec::new(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::register_all_handlers;
    use paperreader_domain::CommandEnvelope;

    #[test]
    fn test_command_response_success() {
        let response =
            CommandResponse::success("req-001", "health", serde_json::json!({"result": "ok"}));
        assert_eq!(response.status, "ok");
        assert!(response.errors.is_empty());
    }

    #[test]
    fn test_command_response_error() {
        let response =
            CommandResponse::error("req-001", "health", "ERROR_CODE", "Something went wrong");
        assert_eq!(response.status, "error");
        assert!(!response.errors.is_empty());
    }

    #[test]
    fn test_api_error_creation() {
        let error = ApiError {
            code: "TEST_ERROR".to_string(),
            message: "Test error message".to_string(),
            details: Some(serde_json::json!({"field": "value"})),
        };
        assert_eq!(error.code, "TEST_ERROR");
    }

    #[tokio::test]
    async fn test_alias_command_routes_through_stdio_handler() {
        let mut interface = StdioInterface::new();
        register_all_handlers(&mut interface);

        let envelope = CommandEnvelope::new("health", "req-alias");
        let response = interface.handler.handle(&envelope).await.unwrap();

        assert_eq!(response.status, "ok");
        assert!(response.data.is_some());
    }
}

//! PaperReader Reading Module
//!
//! 单文档阅读引擎，提供注意力规划、分段阅读、深度分析和声明追踪功能。

use std::sync::Arc;

// 模块导出
pub mod attention_triage;
pub mod claim_tracer;
pub mod segment_reader;

// 重新导出主要类型
pub use attention_triage::*;
pub use claim_tracer::*;
pub use segment_reader::*;

/// LLM 客户端 trait
pub trait LlmClient: Send + Sync {
    /// 生成文本
    fn generate(
        &self,
        prompt: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, LlmError>> + Send + '_>>;

    /// 生成带上下文的文本
    fn generate_with_context(
        &self,
        prompt: &str,
        context: &[ContextMessage],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, LlmError>> + Send + '_>>;
}

/// 上下文消息
#[derive(Debug, Clone)]
pub struct ContextMessage {
    /// 角色
    pub role: MessageRole,
    /// 内容
    pub content: String,
}

/// 消息角色
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

/// LLM 错误
#[derive(Debug, Clone)]
pub enum LlmError {
    /// 网络错误
    Network(String),
    /// 速率限制
    RateLimited,
    /// 内容过滤
    ContentFiltered,
    /// 上下文过长
    ContextTooLong,
    /// 其他错误
    Other(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Network(msg) => write!(f, "Network error: {}", msg),
            LlmError::RateLimited => write!(f, "Rate limited"),
            LlmError::ContentFiltered => write!(f, "Content filtered"),
            LlmError::ContextTooLong => write!(f, "Context too long"),
            LlmError::Other(msg) => write!(f, "Error: {}", msg),
        }
    }
}

impl std::error::Error for LlmError {}

/// 阅读错误
#[derive(Debug, Clone)]
pub enum ReadingError {
    /// LLM 错误
    LlmError(String),
    /// 解析错误
    ParseError(String),
    /// 验证错误
    ValidationError(String),
    /// 配置错误
    ConfigError(String),
    /// 其他错误
    Other(String),
}

impl std::fmt::Display for ReadingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadingError::LlmError(msg) => write!(f, "LLM error: {}", msg),
            ReadingError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            ReadingError::ValidationError(msg) => write!(f, "Validation error: {}", msg),
            ReadingError::ConfigError(msg) => write!(f, "Config error: {}", msg),
            ReadingError::Other(msg) => write!(f, "Error: {}", msg),
        }
    }
}

impl std::error::Error for ReadingError {}

/// 阅读引擎 - 整合所有阅读功能
pub struct ReadingEngine {
    /// Attention Triage 引擎
    pub attention_triage: AttentionTriageEngine,
    /// Segment Reader
    pub segment_reader: SegmentReader,
    /// Claim Tracer
    pub claim_tracer: ClaimTracer,
}

impl ReadingEngine {
    /// 创建新的阅读引擎
    pub fn new(llm_client: Arc<dyn LlmClient>) -> Self {
        Self {
            attention_triage: AttentionTriageEngine::new(llm_client.clone()),
            segment_reader: SegmentReader::new(llm_client.clone()),
            claim_tracer: ClaimTracer::new(llm_client),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(
        llm_client: Arc<dyn LlmClient>,
        triage_config: TriageConfig,
        reader_config: ReaderConfig,
        tracer_config: TracerConfig,
    ) -> Self {
        Self {
            attention_triage: AttentionTriageEngine::with_config(llm_client.clone(), triage_config),
            segment_reader: SegmentReader::with_config(llm_client.clone(), reader_config),
            claim_tracer: ClaimTracer::with_config(llm_client, tracer_config),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 模拟 LLM 客户端用于测试
    pub struct MockLlmClient;

    impl LlmClient for MockLlmClient {
        fn generate(
            &self,
            _prompt: &str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<String, LlmError>> + Send + '_>,
        > {
            Box::pin(async { Ok("Mock response".to_string()) })
        }

        fn generate_with_context(
            &self,
            _prompt: &str,
            _context: &[ContextMessage],
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<String, LlmError>> + Send + '_>,
        > {
            Box::pin(async { Ok("Mock response".to_string()) })
        }
    }

    #[test]
    fn test_reading_engine_creation() {
        let llm_client: Arc<dyn LlmClient> = Arc::new(MockLlmClient);
        let engine = ReadingEngine::new(llm_client);

        // 验证引擎创建成功
        assert_eq!(
            engine.attention_triage.config().min_relevance_threshold,
            0.3
        );
    }

    #[test]
    fn test_error_display() {
        let err = ReadingError::LlmError("test".to_string());
        assert_eq!(format!("{}", err), "LLM error: test");
    }
}

use crate::prelude::*;
use crate::*;

// =============================================================================
// CommandEnvelope - 命令信封（已存在，扩展）
// =============================================================================

/// 命令信封 - 顶层请求结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandEnvelope {
    /// 协议版本
    pub protocol_version: String,
    /// 命令名称
    pub command: String,
    /// 请求ID
    pub request_id: String,
    /// 客户端信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientDescriptor>,
    /// 工作空间上下文
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceContext>,
    /// 执行上下文
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<RequestExecutionContext>,
    /// 幂等键
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// 载荷
    pub payload: serde_json::Value,
    /// 旧执行模式兼容字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ExecutionMode>,
    /// 旧客户端字段兼容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_info: Option<ClientInfo>,
}

impl CommandEnvelope {
    pub fn new(command: impl Into<String>, request_id: impl Into<String>) -> Self {
        Self {
            protocol_version: "1.0".to_string(),
            command: command.into(),
            request_id: request_id.into(),
            client: None,
            workspace: None,
            execution: None,
            idempotency_key: None,
            payload: serde_json::json!({}),
            execution_mode: None,
            client_info: None,
        }
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = payload;
        self
    }

    pub fn normalized_client(&self) -> Option<ClientDescriptor> {
        self.client.clone().or_else(|| {
            self.client_info.as_ref().map(|legacy| ClientDescriptor {
                name: legacy.client_name.clone(),
                version: legacy.client_version.clone(),
                capabilities: legacy.capabilities.clone(),
            })
        })
    }

    pub fn normalized_execution(&self) -> Option<RequestExecutionContext> {
        self.execution.clone().or_else(|| {
            self.execution_mode
                .as_ref()
                .map(|mode| RequestExecutionContext {
                    mode: mode.clone(),
                    timeout_ms: None,
                    priority: ExecutionPriority::Normal,
                    feature_flags: Vec::new(),
                    strict_capability_match: false,
                })
        })
    }

    pub fn requested_capabilities(&self) -> Vec<String> {
        self.normalized_client()
            .map(|client| client.capabilities)
            .unwrap_or_default()
    }
}

/// 执行模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// 同步执行
    Sync,
    /// 异步执行
    Async,
    /// 流式执行
    Stream,
}

/// 客户端信息
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientInfo {
    /// 客户端名称
    pub client_name: String,
    /// 客户端版本
    pub client_version: String,
    /// 能力集合
    pub capabilities: Vec<String>,
}

/// 客户端描述（PRD）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientDescriptor {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

/// 工作空间上下文
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceContext {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// 执行上下文
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestExecutionContext {
    pub mode: ExecutionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub priority: ExecutionPriority,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feature_flags: Vec<String>,
    #[serde(default)]
    pub strict_capability_match: bool,
}

/// 执行优先级
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPriority {
    Low,
    #[default]
    Normal,
    High,
}

/// 策略决策
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyDecision {
    /// 决策ID
    pub decision_id: String,
    /// 决策类型
    pub decision_type: String,
    /// 是否允许
    pub allowed: bool,
    /// 理由
    pub reason: String,
    /// 约束条件
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
}

/// 健康快照
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HealthSnapshot {
    /// 快照ID
    pub snapshot_id: String,
    /// 整体状态
    pub overall_status: HealthStatus,
    /// 组件状态
    pub component_status: HashMap<String, HealthStatus>,
    /// 时间戳
    pub timestamp: String,
    /// 指标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<HealthMetrics>,
}

/// 健康状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    /// 健康
    Healthy,
    /// 降级
    Degraded,
    /// 不健康
    Unhealthy,
    /// 未知
    Unknown,
}

/// 健康指标
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HealthMetrics {
    /// 内存使用（MB）
    pub memory_usage_mb: u64,
    /// CPU使用率
    pub cpu_percent: f64,
    /// 待处理请求数
    pub pending_requests: u32,
}

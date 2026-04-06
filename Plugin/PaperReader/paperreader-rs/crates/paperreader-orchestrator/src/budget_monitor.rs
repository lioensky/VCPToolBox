//! Budget Monitor - 预算监控模块
//!
//! 监控资源使用情况，实现预算熔断机制。

use paperreader_domain::*;
use paperreader_workspace::*;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 预算监控器
pub struct BudgetMonitor {
    /// 预算状态
    state: Arc<RwLock<BudgetState>>,
    /// 配置
    config: BudgetConfig,
    /// 告警回调
    alert_callbacks: Vec<Box<dyn Fn(BudgetAlert) + Send + Sync>>,
}

/// 预算配置
#[derive(Debug, Clone)]
pub struct BudgetConfig {
    /// Token 警告阈值（占总预算的比例）
    pub token_warning_threshold: f64,
    /// Token 熔断阈值（占总预算的比例）
    pub token_fuse_threshold: f64,
    /// LLM 调用警告阈值
    pub llm_call_warning_threshold: f64,
    /// LLM 调用熔断阈值
    pub llm_call_fuse_threshold: f64,
    /// 时间警告阈值
    pub time_warning_threshold: f64,
    /// 时间熔断阈值
    pub time_fuse_threshold: f64,
    /// 上下文压力警告阈值
    pub context_pressure_warning: f64,
    /// 上下文压力熔断阈值
    pub context_pressure_fuse: f64,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            token_warning_threshold: 0.7,
            token_fuse_threshold: 0.95,
            llm_call_warning_threshold: 0.7,
            llm_call_fuse_threshold: 0.95,
            time_warning_threshold: 0.7,
            time_fuse_threshold: 0.95,
            context_pressure_warning: 0.7,
            context_pressure_fuse: 0.9,
        }
    }
}

/// 预算告警
#[derive(Debug, Clone)]
pub struct BudgetAlert {
    /// 告警级别
    pub level: AlertLevel,
    /// 告警类型
    pub alert_type: AlertType,
    /// 当前使用量
    pub current_usage: f64,
    /// 阈值
    pub threshold: f64,
    /// 消息
    pub message: String,
    /// 时间戳
    pub timestamp: String,
}

/// 告警级别
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertLevel {
    /// 信息
    Info,
    /// 警告
    Warning,
    /// 严重
    Critical,
    /// 熔断
    Fuse,
}

/// 告警类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertType {
    /// Token 预算
    TokenBudget,
    /// LLM 调用预算
    LlmCallBudget,
    /// 时间预算
    TimeBudget,
    /// 上下文压力
    ContextPressure,
    /// 工件体积
    ArtifactVolume,
}

/// 预算决策
#[derive(Debug, Clone)]
pub struct BudgetDecision {
    /// 是否允许继续
    pub allow_continue: bool,
    /// 决策原因
    pub reason: String,
    /// 建议操作
    pub suggested_action: SuggestedAction,
}

/// 建议操作
#[derive(Debug, Clone)]
pub enum SuggestedAction {
    /// 继续
    Continue,
    /// 降低质量
    ReduceQuality,
    /// 跳过非关键节点
    SkipNonCritical,
    /// 停止
    Stop,
    /// 熔断
    Fuse,
}

impl BudgetMonitor {
    /// 创建新的预算监控器
    pub fn new(initial_state: BudgetState) -> Self {
        Self {
            state: Arc::new(RwLock::new(initial_state)),
            config: BudgetConfig::default(),
            alert_callbacks: Vec::new(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(initial_state: BudgetState, config: BudgetConfig) -> Self {
        Self {
            state: Arc::new(RwLock::new(initial_state)),
            config,
            alert_callbacks: Vec::new(),
        }
    }

    /// 注册告警回调
    pub fn on_alert(&mut self, callback: Box<dyn Fn(BudgetAlert) + Send + Sync>) {
        self.alert_callbacks.push(callback);
    }

    /// 记录 Token 使用
    pub async fn record_token_usage(&self, tokens: u64) -> BudgetDecision {
        let mut state = self.state.write().await;
        state.token_budget_used += tokens;
        state.updated_at = chrono::Utc::now().to_rfc3339();

        let usage_ratio = state.token_budget_used as f64 / state.token_budget_total as f64;

        drop(state);

        // 检查阈值
        if usage_ratio >= self.config.token_fuse_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Fuse,
                alert_type: AlertType::TokenBudget,
                current_usage: usage_ratio,
                threshold: self.config.token_fuse_threshold,
                message: format!(
                    "Token budget fuse triggered: {}/{} ({:.1}%)",
                    self.get_state().await.token_budget_used,
                    self.get_state().await.token_budget_total,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            return BudgetDecision {
                allow_continue: false,
                reason: "Token budget fuse triggered".to_string(),
                suggested_action: SuggestedAction::Fuse,
            };
        }

        if usage_ratio >= self.config.token_warning_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Warning,
                alert_type: AlertType::TokenBudget,
                current_usage: usage_ratio,
                threshold: self.config.token_warning_threshold,
                message: format!(
                    "Token budget warning: {}/{} ({:.1}%)",
                    self.get_state().await.token_budget_used,
                    self.get_state().await.token_budget_total,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            if usage_ratio > 0.85 {
                return BudgetDecision {
                    allow_continue: true,
                    reason: "Token budget high but within limits".to_string(),
                    suggested_action: SuggestedAction::ReduceQuality,
                };
            }
        }

        BudgetDecision {
            allow_continue: true,
            reason: "Token budget OK".to_string(),
            suggested_action: SuggestedAction::Continue,
        }
    }

    /// 记录 LLM 调用
    pub async fn record_llm_call(&self, calls: u32) -> BudgetDecision {
        let mut state = self.state.write().await;
        state.llm_call_budget_used += calls;
        state.updated_at = chrono::Utc::now().to_rfc3339();

        let usage_ratio = state.llm_call_budget_used as f64 / state.llm_call_budget_total as f64;

        drop(state);

        if usage_ratio >= self.config.llm_call_fuse_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Fuse,
                alert_type: AlertType::LlmCallBudget,
                current_usage: usage_ratio,
                threshold: self.config.llm_call_fuse_threshold,
                message: format!(
                    "LLM call budget fuse triggered: {}/{} ({:.1}%)",
                    self.get_state().await.llm_call_budget_used,
                    self.get_state().await.llm_call_budget_total,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            return BudgetDecision {
                allow_continue: false,
                reason: "LLM call budget fuse triggered".to_string(),
                suggested_action: SuggestedAction::Fuse,
            };
        }

        if usage_ratio >= self.config.llm_call_warning_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Warning,
                alert_type: AlertType::LlmCallBudget,
                current_usage: usage_ratio,
                threshold: self.config.llm_call_warning_threshold,
                message: format!(
                    "LLM call budget warning: {}/{} ({:.1}%)",
                    self.get_state().await.llm_call_budget_used,
                    self.get_state().await.llm_call_budget_total,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);
        }

        BudgetDecision {
            allow_continue: true,
            reason: "LLM call budget OK".to_string(),
            suggested_action: SuggestedAction::Continue,
        }
    }

    /// 记录时间使用
    pub async fn record_time_usage(&self, seconds: u64) -> BudgetDecision {
        let mut state = self.state.write().await;
        state.wall_clock_budget_used_seconds += seconds;
        state.updated_at = chrono::Utc::now().to_rfc3339();

        let usage_ratio = state.wall_clock_budget_used_seconds as f64
            / state.wall_clock_budget_total_seconds as f64;

        drop(state);

        if usage_ratio >= self.config.time_fuse_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Fuse,
                alert_type: AlertType::TimeBudget,
                current_usage: usage_ratio,
                threshold: self.config.time_fuse_threshold,
                message: format!(
                    "Time budget fuse triggered: {}/{}s ({:.1}%)",
                    self.get_state().await.wall_clock_budget_used_seconds,
                    self.get_state().await.wall_clock_budget_total_seconds,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            return BudgetDecision {
                allow_continue: false,
                reason: "Time budget fuse triggered".to_string(),
                suggested_action: SuggestedAction::Fuse,
            };
        }

        if usage_ratio >= self.config.time_warning_threshold {
            let alert = BudgetAlert {
                level: AlertLevel::Warning,
                alert_type: AlertType::TimeBudget,
                current_usage: usage_ratio,
                threshold: self.config.time_warning_threshold,
                message: format!(
                    "Time budget warning: {}/{}s ({:.1}%)",
                    self.get_state().await.wall_clock_budget_used_seconds,
                    self.get_state().await.wall_clock_budget_total_seconds,
                    usage_ratio * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);
        }

        BudgetDecision {
            allow_continue: true,
            reason: "Time budget OK".to_string(),
            suggested_action: SuggestedAction::Continue,
        }
    }

    /// 更新上下文压力
    pub async fn update_context_pressure(&self, pressure: f64) -> BudgetDecision {
        let mut state = self.state.write().await;
        state.context_pressure_score = pressure.clamp(0.0, 1.0);
        state.updated_at = chrono::Utc::now().to_rfc3339();

        let current_pressure = state.context_pressure_score;

        drop(state);

        if current_pressure >= self.config.context_pressure_fuse {
            let alert = BudgetAlert {
                level: AlertLevel::Fuse,
                alert_type: AlertType::ContextPressure,
                current_usage: current_pressure,
                threshold: self.config.context_pressure_fuse,
                message: format!(
                    "Context pressure fuse triggered: {:.1}%",
                    current_pressure * 100.0
                ),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            return BudgetDecision {
                allow_continue: false,
                reason: "Context pressure fuse triggered".to_string(),
                suggested_action: SuggestedAction::Fuse,
            };
        }

        if current_pressure >= self.config.context_pressure_warning {
            let alert = BudgetAlert {
                level: AlertLevel::Warning,
                alert_type: AlertType::ContextPressure,
                current_usage: current_pressure,
                threshold: self.config.context_pressure_warning,
                message: format!("Context pressure warning: {:.1}%", current_pressure * 100.0),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            self.trigger_alert(alert);

            return BudgetDecision {
                allow_continue: true,
                reason: "Context pressure high".to_string(),
                suggested_action: SuggestedAction::ReduceQuality,
            };
        }

        BudgetDecision {
            allow_continue: true,
            reason: "Context pressure OK".to_string(),
            suggested_action: SuggestedAction::Continue,
        }
    }

    /// 获取当前状态
    pub async fn get_state(&self) -> BudgetState {
        self.state.read().await.clone()
    }

    /// 获取状态快照（同步版本，用于非 async 上下文）
    pub fn get_state_blocking(&self) -> Option<BudgetState> {
        // 注意：这个方法是同步的，只能在已经有锁的情况下使用
        // 实际使用时需要通过 async runtime 来调用
        None
    }

    /// 检查是否应该熔断
    pub async fn should_fuse(&self) -> bool {
        let state = self.state.read().await;

        let token_ratio = state.token_budget_used as f64 / state.token_budget_total as f64;
        let llm_ratio = state.llm_call_budget_used as f64 / state.llm_call_budget_total as f64;
        let time_ratio = state.wall_clock_budget_used_seconds as f64
            / state.wall_clock_budget_total_seconds as f64;

        token_ratio >= self.config.token_fuse_threshold
            || llm_ratio >= self.config.llm_call_fuse_threshold
            || time_ratio >= self.config.time_fuse_threshold
            || state.context_pressure_score >= self.config.context_pressure_fuse
    }

    /// 获取预算摘要
    pub async fn get_budget_summary(&self) -> BudgetSummary {
        let state = self.state.read().await.clone();

        BudgetSummary {
            token_usage_percent: (state.token_budget_used as f64 / state.token_budget_total as f64
                * 100.0) as u8,
            llm_call_usage_percent: (state.llm_call_budget_used as f64
                / state.llm_call_budget_total as f64
                * 100.0) as u8,
            time_usage_percent: (state.wall_clock_budget_used_seconds as f64
                / state.wall_clock_budget_total_seconds as f64
                * 100.0) as u8,
            context_pressure_percent: (state.context_pressure_score * 100.0) as u8,
            artifact_volume_percent: (state.artifact_volume_score * 100.0) as u8,
            should_fuse: self.should_fuse().await,
        }
    }

    /// 触发告警
    fn trigger_alert(&self, alert: BudgetAlert) {
        for callback in &self.alert_callbacks {
            callback(alert.clone());
        }
    }
}

/// 预算摘要
#[derive(Debug, Clone)]
pub struct BudgetSummary {
    /// Token 使用百分比
    pub token_usage_percent: u8,
    /// LLM 调用使用百分比
    pub llm_call_usage_percent: u8,
    /// 时间使用百分比
    pub time_usage_percent: u8,
    /// 上下文压力百分比
    pub context_pressure_percent: u8,
    /// 工件体积百分比
    pub artifact_volume_percent: u8,
    /// 是否应该熔断
    pub should_fuse: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_budget_state() -> BudgetState {
        BudgetState {
            run_id: "run-001".to_string(),
            token_budget_total: 10000,
            token_budget_used: 0,
            llm_call_budget_total: 100,
            llm_call_budget_used: 0,
            wall_clock_budget_total_seconds: 3600,
            wall_clock_budget_used_seconds: 0,
            context_pressure_score: 0.0,
            artifact_volume_score: 0.0,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    #[tokio::test]
    async fn test_budget_monitor_creation() {
        let state = create_test_budget_state();
        let monitor = BudgetMonitor::new(state);

        let current_state = monitor.get_state().await;
        assert_eq!(current_state.token_budget_total, 10000);
    }

    #[tokio::test]
    async fn test_token_usage_tracking() {
        let state = create_test_budget_state();
        let monitor = BudgetMonitor::new(state);

        let decision = monitor.record_token_usage(5000).await;
        assert!(decision.allow_continue);

        let state = monitor.get_state().await;
        assert_eq!(state.token_budget_used, 5000);
    }

    #[tokio::test]
    async fn test_budget_config_default() {
        let config = BudgetConfig::default();
        assert!(config.token_warning_threshold < config.token_fuse_threshold);
        assert!(config.token_fuse_threshold <= 1.0);
    }
}

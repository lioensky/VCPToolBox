//! PaperReader Orchestrator Module
//!
//! 研究图执行引擎，提供图执行、检查点管理和预算监控功能。

// 模块导出
pub mod budget_monitor;
pub mod checkpoint;
pub mod graph_executor;

// 重新导出主要类型
pub use budget_monitor::*;
pub use checkpoint::*;
pub use graph_executor::*;

use paperreader_domain::*;
use paperreader_workspace::*;

/// 编排器 - 整合所有编排功能
pub struct Orchestrator {
    /// 图执行器
    pub executor: GraphExecutor,
    /// 检查点管理器
    pub checkpoint_manager: Option<CheckpointManager>,
    /// 预算监控器
    pub budget_monitor: Option<BudgetMonitor>,
}

impl Orchestrator {
    /// 创建新的编排器
    pub fn new() -> Self {
        Self {
            executor: GraphExecutor::new(),
            checkpoint_manager: None,
            budget_monitor: None,
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(
        executor_config: ExecutorConfig,
        checkpoint_manager: Option<CheckpointManager>,
        budget_monitor: Option<BudgetMonitor>,
    ) -> Self {
        Self {
            executor: GraphExecutor::with_config(executor_config),
            checkpoint_manager,
            budget_monitor,
        }
    }

    /// 设置检查点管理器
    pub fn with_checkpoint_manager(mut self, checkpoint_manager: CheckpointManager) -> Self {
        self.checkpoint_manager = Some(checkpoint_manager);
        self
    }

    /// 设置预算监控器
    pub fn with_budget_monitor(mut self, budget_monitor: BudgetMonitor) -> Self {
        self.budget_monitor = Some(budget_monitor);
        self
    }

    /// 注册节点处理器
    pub fn register_handler(&mut self, handler: Box<dyn NodeHandler>) {
        self.executor.register_handler(handler);
    }

    /// 执行研究图
    pub async fn execute(
        &mut self,
        graph: &ResearchGraph,
        context: &ExecutionContext,
    ) -> Result<ExecutionResult, OrchestratorError> {
        // 检查预算
        if let Some(ref monitor) = self.budget_monitor {
            if monitor.should_fuse().await {
                return Err(OrchestratorError::ExecutionError(
                    "Budget fuse triggered before execution".to_string(),
                ));
            }
        }

        // 执行图
        let result = self.executor.execute_graph(graph, context).await?;

        // 创建检查点
        if let Some(ref checkpoint_manager) = self.checkpoint_manager {
            if result.success {
                checkpoint_manager
                    .create_checkpoint(&context.run_id, graph, &context.budget_state)
                    .await
                    .map_err(|e| OrchestratorError::CheckpointError(e.to_string()))?;
            }
        }

        Ok(result)
    }

    /// 从检查点恢复
    pub async fn resume(
        &self,
        checkpoint_id: &str,
        graph: &mut ResearchGraph,
    ) -> Result<ResumeResult, OrchestratorError> {
        let checkpoint_manager = self.checkpoint_manager.as_ref().ok_or_else(|| {
            OrchestratorError::CheckpointError("Checkpoint manager not configured".to_string())
        })?;

        checkpoint_manager
            .resume_from_checkpoint(checkpoint_id, graph)
            .await
            .map_err(|e| OrchestratorError::CheckpointError(e.to_string()))
    }

    /// 获取预算摘要
    pub async fn get_budget_summary(&self) -> Option<BudgetSummary> {
        if let Some(ref monitor) = self.budget_monitor {
            Some(monitor.get_budget_summary().await)
        } else {
            None
        }
    }
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}

/// 运行上下文构建器
pub struct RunContextBuilder {
    run_id: String,
    graph_id: String,
    budget_state: BudgetState,
    artifact_paths: RunArtifactPaths,
}

impl RunContextBuilder {
    /// 创建新的构建器
    pub fn new(run_id: impl Into<String>, graph_id: impl Into<String>) -> Self {
        let run_id = run_id.into();
        Self {
            run_id: run_id.clone(),
            graph_id: graph_id.into(),
            budget_state: BudgetState {
                run_id: run_id.clone(),
                token_budget_total: 100000,
                token_budget_used: 0,
                llm_call_budget_total: 1000,
                llm_call_budget_used: 0,
                wall_clock_budget_total_seconds: 7200,
                wall_clock_budget_used_seconds: 0,
                context_pressure_score: 0.0,
                artifact_volume_score: 0.0,
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
            artifact_paths: RunArtifactPaths::new(std::path::Path::new(&format!(
                "./runs/{}",
                run_id
            ))),
        }
    }

    /// 设置 Token 预算
    pub fn with_token_budget(mut self, total: u64) -> Self {
        self.budget_state.token_budget_total = total;
        self
    }

    /// 设置 LLM 调用预算
    pub fn with_llm_call_budget(mut self, total: u32) -> Self {
        self.budget_state.llm_call_budget_total = total;
        self
    }

    /// 设置时间预算
    pub fn with_time_budget(mut self, seconds: u64) -> Self {
        self.budget_state.wall_clock_budget_total_seconds = seconds;
        self
    }

    /// 设置工件路径
    pub fn with_artifact_paths(mut self, paths: RunArtifactPaths) -> Self {
        self.artifact_paths = paths;
        self
    }

    /// 构建执行上下文
    pub fn build(self) -> ExecutionContext {
        ExecutionContext {
            run_id: self.run_id,
            graph_id: self.graph_id,
            budget_state: self.budget_state,
            artifact_paths: self.artifact_paths,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orchestrator_creation() {
        let orchestrator = Orchestrator::new();
        assert!(orchestrator.checkpoint_manager.is_none());
        assert!(orchestrator.budget_monitor.is_none());
    }

    #[test]
    fn test_run_context_builder() {
        let context = RunContextBuilder::new("run-001", "graph-001")
            .with_token_budget(50000)
            .with_llm_call_budget(500)
            .build();

        assert_eq!(context.run_id, "run-001");
        assert_eq!(context.graph_id, "graph-001");
        assert_eq!(context.budget_state.token_budget_total, 50000);
        assert_eq!(context.budget_state.llm_call_budget_total, 500);
    }

    #[test]
    fn test_alert_level() {
        assert_ne!(AlertLevel::Warning, AlertLevel::Critical);
        assert_eq!(AlertLevel::Fuse, AlertLevel::Fuse);
    }
}

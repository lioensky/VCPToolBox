//! Graph Executor - 研究图执行引擎
//!
//! 执行研究图中的节点，管理执行流程和状态转换。

use paperreader_domain::*;
use paperreader_workspace::*;
use std::collections::HashMap;

/// 图执行器
pub struct GraphExecutor {
    /// 执行配置
    config: ExecutorConfig,
    /// 节点处理器注册表
    node_handlers: HashMap<NodeType, Box<dyn NodeHandler>>,
    /// 执行状态
    state: ExecutorState,
}

/// 执行配置
#[derive(Debug, Clone)]
pub struct ExecutorConfig {
    /// 最大并发节点数
    pub max_concurrent_nodes: usize,
    /// 节点超时时间（秒）
    pub node_timeout_seconds: u64,
    /// 启用检查点
    pub enable_checkpoints: bool,
    /// 检查点间隔（节点数）
    pub checkpoint_interval: usize,
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        Self {
            max_concurrent_nodes: 3,
            node_timeout_seconds: 300,
            enable_checkpoints: true,
            checkpoint_interval: 5,
        }
    }
}

/// 执行器状态
#[derive(Debug, Clone)]
struct ExecutorState {
    /// 当前运行的图
    current_graph: Option<ResearchGraph>,
    /// 已执行节点数
    executed_nodes: usize,
    /// 最后检查点位置
    last_checkpoint: usize,
}

impl Default for ExecutorState {
    fn default() -> Self {
        Self {
            current_graph: None,
            executed_nodes: 0,
            last_checkpoint: 0,
        }
    }
}

/// 节点处理器 trait
pub trait NodeHandler: Send + Sync {
    /// 处理节点
    fn handle(
        &self,
        node: &ResearchNode,
        context: &NodeContext,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<NodeOutput, NodeError>> + Send + '_>,
    >;

    /// 获取处理的节点类型
    fn node_type(&self) -> NodeType;
}

/// 节点上下文
#[derive(Debug, Clone)]
pub struct NodeContext {
    /// 运行ID
    pub run_id: String,
    /// 图ID
    pub graph_id: String,
    /// 父节点输出
    pub parent_outputs: Vec<NodeOutput>,
    /// 预算状态
    pub budget_state: BudgetState,
    /// 工件路径
    pub artifact_paths: RunArtifactPaths,
}

/// 节点输出
#[derive(Debug, Clone)]
pub struct NodeOutput {
    /// 节点ID
    pub node_id: String,
    /// 输出工件ID
    pub output_artifact_id: Option<String>,
    /// 输出数据
    pub data: serde_json::Value,
    /// Token消耗
    pub tokens_consumed: u64,
    /// 执行时间（秒）
    pub execution_seconds: u64,
}

/// 节点错误
#[derive(Debug, Clone)]
pub enum NodeError {
    /// 执行失败
    ExecutionFailed(String),
    /// 超时
    Timeout,
    /// 预算不足
    BudgetExceeded,
    /// 依赖缺失
    MissingDependency(String),
    /// 其他错误
    Other(String),
}

impl std::fmt::Display for NodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeError::ExecutionFailed(msg) => write!(f, "Execution failed: {}", msg),
            NodeError::Timeout => write!(f, "Node execution timed out"),
            NodeError::BudgetExceeded => write!(f, "Budget exceeded"),
            NodeError::MissingDependency(dep) => write!(f, "Missing dependency: {}", dep),
            NodeError::Other(msg) => write!(f, "Error: {}", msg),
        }
    }
}

impl std::error::Error for NodeError {}

/// 执行结果
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    /// 是否成功
    pub success: bool,
    /// 完成的节点数
    pub completed_nodes: usize,
    /// 失败的节点数
    pub failed_nodes: usize,
    /// 跳过的节点数
    pub skipped_nodes: usize,
    /// 总Token消耗
    pub total_tokens: u64,
    /// 总执行时间（秒）
    pub total_seconds: u64,
    /// 最终输出
    pub final_output: Option<NodeOutput>,
    /// 错误信息
    pub errors: Vec<String>,
}

impl GraphExecutor {
    /// 创建新的图执行器
    pub fn new() -> Self {
        Self {
            config: ExecutorConfig::default(),
            node_handlers: HashMap::new(),
            state: ExecutorState::default(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(config: ExecutorConfig) -> Self {
        Self {
            config,
            node_handlers: HashMap::new(),
            state: ExecutorState::default(),
        }
    }

    /// 注册节点处理器
    pub fn register_handler(&mut self, handler: Box<dyn NodeHandler>) {
        let node_type = handler.node_type();
        self.node_handlers.insert(node_type, handler);
    }

    /// 执行研究图
    pub async fn execute_graph(
        &mut self,
        graph: &ResearchGraph,
        context: &ExecutionContext,
    ) -> Result<ExecutionResult, OrchestratorError> {
        self.state.current_graph = Some(graph.clone());

        let mut result = ExecutionResult {
            success: true,
            completed_nodes: 0,
            failed_nodes: 0,
            skipped_nodes: 0,
            total_tokens: 0,
            total_seconds: 0,
            final_output: None,
            errors: Vec::new(),
        };

        // 获取执行顺序（拓扑排序）
        let execution_order = self.compute_execution_order(graph)?;

        // 执行每个节点
        for node_id in execution_order {
            let node = graph
                .nodes
                .get(&node_id)
                .ok_or_else(|| OrchestratorError::NodeNotFound(node_id.clone()))?;

            // 检查预算
            if self.is_budget_exceeded(context) {
                result.errors.push("Budget exceeded".to_string());
                result.success = false;
                break;
            }

            // 执行节点
            match self.execute_node(node, context).await {
                Ok(output) => {
                    result.completed_nodes += 1;
                    result.total_tokens += output.tokens_consumed;
                    result.total_seconds += output.execution_seconds;
                    result.final_output = Some(output);

                    self.state.executed_nodes += 1;

                    // 检查是否需要创建检查点
                    if self.should_create_checkpoint() {
                        self.create_checkpoint(graph, context).await?;
                    }
                }
                Err(NodeError::BudgetExceeded) => {
                    result.failed_nodes += 1;
                    result
                        .errors
                        .push(format!("Node {} failed: budget exceeded", node_id));
                    result.success = false;
                    break;
                }
                Err(e) => {
                    result.failed_nodes += 1;
                    result
                        .errors
                        .push(format!("Node {} failed: {}", node_id, e));

                    // 根据节点失败策略决定是否继续
                    if self.should_stop_on_failure(node) {
                        result.success = false;
                        break;
                    }
                }
            }
        }

        // 最终检查点
        if self.config.enable_checkpoints && result.success {
            self.create_checkpoint(graph, context).await?;
        }

        Ok(result)
    }

    /// 计算执行顺序（拓扑排序）
    fn compute_execution_order(
        &self,
        graph: &ResearchGraph,
    ) -> Result<Vec<String>, OrchestratorError> {
        let mut order = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut temp_mark = std::collections::HashSet::new();

        // 从根节点开始DFS
        self.dfs_visit(
            &graph.root_node_id,
            graph,
            &mut visited,
            &mut temp_mark,
            &mut order,
        )?;

        // 反转得到正确的执行顺序
        order.reverse();

        Ok(order)
    }

    /// DFS访问节点
    fn dfs_visit(
        &self,
        node_id: &str,
        graph: &ResearchGraph,
        visited: &mut std::collections::HashSet<String>,
        temp_mark: &mut std::collections::HashSet<String>,
        order: &mut Vec<String>,
    ) -> Result<(), OrchestratorError> {
        if temp_mark.contains(node_id) {
            return Err(OrchestratorError::CycleDetected);
        }

        if visited.contains(node_id) {
            return Ok(());
        }

        temp_mark.insert(node_id.to_string());

        // 访问子节点
        let node = graph
            .nodes
            .get(node_id)
            .ok_or_else(|| OrchestratorError::NodeNotFound(node_id.to_string()))?;

        for child_id in &node.child_ids {
            self.dfs_visit(child_id, graph, visited, temp_mark, order)?;
        }

        temp_mark.remove(node_id);
        visited.insert(node_id.to_string());
        order.push(node_id.to_string());

        Ok(())
    }

    /// 执行单个节点
    async fn execute_node(
        &self,
        node: &ResearchNode,
        context: &ExecutionContext,
    ) -> Result<NodeOutput, NodeError> {
        // 获取节点处理器
        let handler = self.node_handlers.get(&node.node_type).ok_or_else(|| {
            NodeError::ExecutionFailed(format!("No handler for node type {:?}", node.node_type))
        })?;

        // 构建节点上下文
        let node_context = NodeContext {
            run_id: context.run_id.clone(),
            graph_id: context.graph_id.clone(),
            parent_outputs: vec![], // TODO: 从父节点获取
            budget_state: context.budget_state.clone(),
            artifact_paths: context.artifact_paths.clone(),
        };

        // 执行节点
        let start_time = std::time::Instant::now();

        let output = tokio::time::timeout(
            tokio::time::Duration::from_secs(self.config.node_timeout_seconds),
            handler.handle(node, &node_context),
        )
        .await
        .map_err(|_| NodeError::Timeout)??;

        let execution_seconds = start_time.elapsed().as_secs();

        // 更新输出中的执行时间
        let output = NodeOutput {
            execution_seconds,
            ..output
        };

        Ok(output)
    }

    /// 检查预算是否超限
    fn is_budget_exceeded(&self, context: &ExecutionContext) -> bool {
        context.budget_state.token_budget_used >= context.budget_state.token_budget_total
            || context.budget_state.llm_call_budget_used
                >= context.budget_state.llm_call_budget_total
    }

    /// 失败时是否停止
    fn should_stop_on_failure(&self, _node: &ResearchNode) -> bool {
        // 默认策略：关键节点失败时停止
        // TODO: 根据节点类型和配置决定
        true
    }

    /// 是否应该创建检查点
    fn should_create_checkpoint(&self) -> bool {
        if !self.config.enable_checkpoints {
            return false;
        }

        self.state.executed_nodes - self.state.last_checkpoint >= self.config.checkpoint_interval
    }

    /// 创建检查点
    async fn create_checkpoint(
        &mut self,
        _graph: &ResearchGraph,
        _context: &ExecutionContext,
    ) -> Result<(), OrchestratorError> {
        // TODO: 实现检查点创建逻辑
        self.state.last_checkpoint = self.state.executed_nodes;
        Ok(())
    }
}

impl Default for GraphExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// 执行上下文
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    /// 运行ID
    pub run_id: String,
    /// 图ID
    pub graph_id: String,
    /// 预算状态
    pub budget_state: BudgetState,
    /// 工件路径
    pub artifact_paths: RunArtifactPaths,
}

/// Orchestrator 错误
#[derive(Debug, Clone)]
pub enum OrchestratorError {
    /// 节点未找到
    NodeNotFound(String),
    /// 图中存在环
    CycleDetected,
    /// 执行错误
    ExecutionError(String),
    /// 检查点错误
    CheckpointError(String),
}

impl std::fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrchestratorError::NodeNotFound(id) => write!(f, "Node not found: {}", id),
            OrchestratorError::CycleDetected => write!(f, "Cycle detected in graph"),
            OrchestratorError::ExecutionError(msg) => write!(f, "Execution error: {}", msg),
            OrchestratorError::CheckpointError(msg) => write!(f, "Checkpoint error: {}", msg),
        }
    }
}

impl std::error::Error for OrchestratorError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_executor_config_default() {
        let config = ExecutorConfig::default();
        assert!(config.max_concurrent_nodes > 0);
        assert!(config.node_timeout_seconds > 0);
        assert!(config.enable_checkpoints);
    }

    #[test]
    fn test_execution_result() {
        let result = ExecutionResult {
            success: true,
            completed_nodes: 5,
            failed_nodes: 0,
            skipped_nodes: 1,
            total_tokens: 10000,
            total_seconds: 120,
            final_output: None,
            errors: vec![],
        };

        assert!(result.success);
        assert_eq!(result.completed_nodes, 5);
    }

    #[test]
    fn test_node_error_display() {
        let err = NodeError::Timeout;
        assert_eq!(format!("{}", err), "Node execution timed out");
    }
}

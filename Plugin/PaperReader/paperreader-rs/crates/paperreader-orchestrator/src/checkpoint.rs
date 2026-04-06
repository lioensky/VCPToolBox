//! Checkpoint Manager - 检查点管理模块
//!
//! 保存和恢复研究图执行状态，支持断点续作。

use paperreader_domain::{BudgetConsumed, NodeExecutionState, ResearchGraph};
use paperreader_workspace::BudgetState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 检查点管理器
pub struct CheckpointManager {
    /// 检查点存储目录
    checkpoints_dir: PathBuf,
    /// 配置
    config: CheckpointConfig,
}

/// 检查点配置
#[derive(Debug, Clone)]
pub struct CheckpointConfig {
    /// 最大检查点数量
    pub max_checkpoints: usize,
    /// 自动清理旧检查点
    pub auto_cleanup: bool,
}

impl Default for CheckpointConfig {
    fn default() -> Self {
        Self {
            max_checkpoints: 10,
            auto_cleanup: true,
        }
    }
}

/// 检查点数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    /// 检查点ID
    pub checkpoint_id: String,
    /// 运行ID
    pub run_id: String,
    /// 图ID
    pub graph_id: String,
    /// 创建时间
    pub created_at: String,
    /// 节点状态
    pub node_states: HashMap<String, NodeStateSnapshot>,
    /// 预算状态
    pub budget_state: BudgetStateSnapshot,
    /// 工件引用
    pub artifact_refs: Vec<String>,
    /// 元数据
    pub metadata: HashMap<String, serde_json::Value>,
}

/// 节点状态快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStateSnapshot {
    /// 节点ID
    pub node_id: String,
    /// 执行状态
    pub execution_state: String,
    /// 输出工件ID
    pub output_artifact_id: Option<String>,
    /// Token消耗
    pub tokens_consumed: u64,
    /// 执行时间
    pub execution_seconds: u64,
    /// 重试次数
    pub retry_count: u32,
}

/// 预算状态快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetStateSnapshot {
    /// Token已使用
    pub token_used: u64,
    /// Token总数
    pub token_total: u64,
    /// LLM调用已使用
    pub llm_call_used: u32,
    /// LLM调用总数
    pub llm_call_total: u32,
    /// 时间已使用（秒）
    pub time_used_seconds: u64,
    /// 时间总数（秒）
    pub time_total_seconds: u64,
}

/// 恢复结果
#[derive(Debug, Clone)]
pub struct ResumeResult {
    /// 是否成功
    pub success: bool,
    /// 恢复的图
    pub graph: Option<ResearchGraph>,
    /// 恢复的节点状态
    pub node_states: HashMap<String, NodeStateSnapshot>,
    /// 恢复的预算状态
    pub budget_state: Option<BudgetStateSnapshot>,
    /// 从哪个节点继续
    pub resume_from_node: Option<String>,
    /// 错误信息
    pub error: Option<String>,
}

impl CheckpointManager {
    /// 创建新的检查点管理器
    pub fn new(checkpoints_dir: impl AsRef<Path>) -> Self {
        Self {
            checkpoints_dir: checkpoints_dir.as_ref().to_path_buf(),
            config: CheckpointConfig::default(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(checkpoints_dir: impl AsRef<Path>, config: CheckpointConfig) -> Self {
        Self {
            checkpoints_dir: checkpoints_dir.as_ref().to_path_buf(),
            config,
        }
    }

    /// 创建检查点
    pub async fn create_checkpoint(
        &self,
        run_id: &str,
        graph: &ResearchGraph,
        budget_state: &BudgetState,
    ) -> Result<Checkpoint, CheckpointError> {
        let checkpoint_id = format!(
            "ckpt-{}-{}",
            run_id,
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ")
        );

        let mut node_states = HashMap::new();
        for (node_id, node) in &graph.nodes {
            let consumed = node.budget_consumed.clone().unwrap_or_default();
            node_states.insert(
                node_id.clone(),
                NodeStateSnapshot {
                    node_id: node_id.clone(),
                    execution_state: Self::serialize_state(&node.execution_state),
                    output_artifact_id: node.output_artifact.clone(),
                    tokens_consumed: consumed.tokens,
                    execution_seconds: consumed.elapsed_seconds,
                    retry_count: 0,
                },
            );
        }

        let checkpoint = Checkpoint {
            checkpoint_id: checkpoint_id.clone(),
            run_id: run_id.to_string(),
            graph_id: graph.graph_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            node_states,
            budget_state: BudgetStateSnapshot {
                token_used: budget_state.token_budget_used,
                token_total: budget_state.token_budget_total,
                llm_call_used: budget_state.llm_call_budget_used,
                llm_call_total: budget_state.llm_call_budget_total,
                time_used_seconds: budget_state.wall_clock_budget_used_seconds,
                time_total_seconds: budget_state.wall_clock_budget_total_seconds,
            },
            artifact_refs: self.collect_artifact_refs(graph),
            metadata: HashMap::new(),
        };

        self.save_checkpoint(&checkpoint)?;
        if self.config.auto_cleanup {
            self.cleanup_old_checkpoints(run_id).await?;
        }

        Ok(checkpoint)
    }

    fn save_checkpoint(&self, checkpoint: &Checkpoint) -> Result<(), CheckpointError> {
        std::fs::create_dir_all(&self.checkpoints_dir)
            .map_err(|err| CheckpointError::IoError(err.to_string()))?;
        let checkpoint_path = self
            .checkpoints_dir
            .join(format!("{}.json", checkpoint.checkpoint_id));
        let json = serde_json::to_string_pretty(checkpoint)
            .map_err(|err| CheckpointError::SerializationError(err.to_string()))?;
        std::fs::write(&checkpoint_path, json)
            .map_err(|err| CheckpointError::IoError(err.to_string()))?;
        Ok(())
    }

    /// 加载检查点
    pub async fn load_checkpoint(
        &self,
        checkpoint_id: &str,
    ) -> Result<Checkpoint, CheckpointError> {
        let checkpoint_path = self.checkpoints_dir.join(format!("{}.json", checkpoint_id));
        let json = std::fs::read_to_string(&checkpoint_path)
            .map_err(|err| CheckpointError::IoError(err.to_string()))?;
        serde_json::from_str(&json)
            .map_err(|err| CheckpointError::DeserializationError(err.to_string()))
    }

    /// 列出所有检查点
    pub async fn list_checkpoints(
        &self,
        run_id: Option<&str>,
    ) -> Result<Vec<Checkpoint>, CheckpointError> {
        if !self.checkpoints_dir.exists() {
            return Ok(Vec::new());
        }

        let mut checkpoints = Vec::new();
        for entry in std::fs::read_dir(&self.checkpoints_dir)
            .map_err(|err| CheckpointError::IoError(err.to_string()))?
        {
            let entry = entry.map_err(|err| CheckpointError::IoError(err.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }

            let json = match std::fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let checkpoint = match serde_json::from_str::<Checkpoint>(&json) {
                Ok(value) => value,
                Err(_) => continue,
            };

            if run_id
                .map(|expected| checkpoint.run_id == expected)
                .unwrap_or(true)
            {
                checkpoints.push(checkpoint);
            }
        }

        checkpoints.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(checkpoints)
    }

    /// 恢复执行状态
    pub async fn resume_from_checkpoint(
        &self,
        checkpoint_id: &str,
        graph: &mut ResearchGraph,
    ) -> Result<ResumeResult, CheckpointError> {
        let checkpoint = self.load_checkpoint(checkpoint_id).await?;
        if checkpoint.graph_id != graph.graph_id {
            return Ok(ResumeResult {
                success: false,
                graph: None,
                node_states: HashMap::new(),
                budget_state: None,
                resume_from_node: None,
                error: Some(format!(
                    "Graph ID mismatch: checkpoint has {}, current is {}",
                    checkpoint.graph_id, graph.graph_id
                )),
            });
        }

        let mut resume_from_node = None;
        for (node_id, snapshot) in &checkpoint.node_states {
            if let Some(node) = graph.nodes.get_mut(node_id) {
                node.execution_state = Self::deserialize_state(&snapshot.execution_state);
                node.output_artifact = snapshot.output_artifact_id.clone();
                node.budget_consumed = Some(BudgetConsumed {
                    tokens: snapshot.tokens_consumed,
                    llm_calls: 0,
                    elapsed_seconds: snapshot.execution_seconds,
                });

                if resume_from_node.is_none()
                    && !matches!(node.execution_state, NodeExecutionState::Completed)
                {
                    resume_from_node = Some(node_id.clone());
                }
            }
        }

        Ok(ResumeResult {
            success: true,
            graph: Some(graph.clone()),
            node_states: checkpoint.node_states.clone(),
            budget_state: Some(checkpoint.budget_state.clone()),
            resume_from_node,
            error: None,
        })
    }

    /// 删除检查点
    pub async fn delete_checkpoint(&self, checkpoint_id: &str) -> Result<(), CheckpointError> {
        let checkpoint_path = self.checkpoints_dir.join(format!("{}.json", checkpoint_id));
        if checkpoint_path.exists() {
            std::fs::remove_file(&checkpoint_path)
                .map_err(|err| CheckpointError::IoError(err.to_string()))?;
        }
        Ok(())
    }

    /// 清理旧检查点
    async fn cleanup_old_checkpoints(&self, run_id: &str) -> Result<(), CheckpointError> {
        let checkpoints = self.list_checkpoints(Some(run_id)).await?;
        if checkpoints.len() <= self.config.max_checkpoints {
            return Ok(());
        }

        for checkpoint in checkpoints.iter().skip(self.config.max_checkpoints) {
            self.delete_checkpoint(&checkpoint.checkpoint_id).await?;
        }
        Ok(())
    }

    fn collect_artifact_refs(&self, graph: &ResearchGraph) -> Vec<String> {
        let mut refs = Vec::new();
        for node in graph.nodes.values() {
            if let Some(output) = &node.output_artifact {
                refs.push(output.clone());
            }
            refs.extend(node.input_artifacts.iter().cloned());
        }
        refs
    }

    fn serialize_state(state: &NodeExecutionState) -> String {
        match state {
            NodeExecutionState::Pending => "pending".to_string(),
            NodeExecutionState::Running => "running".to_string(),
            NodeExecutionState::Completed => "completed".to_string(),
            NodeExecutionState::Skipped => "skipped".to_string(),
            NodeExecutionState::Failed(reason) => format!("failed:{reason}"),
        }
    }

    fn deserialize_state(raw: &str) -> NodeExecutionState {
        if raw == "pending" {
            NodeExecutionState::Pending
        } else if raw == "running" {
            NodeExecutionState::Running
        } else if raw == "completed" {
            NodeExecutionState::Completed
        } else if raw == "skipped" {
            NodeExecutionState::Skipped
        } else if let Some(reason) = raw.strip_prefix("failed:") {
            NodeExecutionState::Failed(reason.to_string())
        } else {
            NodeExecutionState::Pending
        }
    }

    /// 获取最新的检查点
    pub async fn get_latest_checkpoint(
        &self,
        run_id: &str,
    ) -> Result<Option<Checkpoint>, CheckpointError> {
        Ok(self
            .list_checkpoints(Some(run_id))
            .await?
            .into_iter()
            .next())
    }
}

/// 检查点错误
#[derive(Debug, Clone)]
pub enum CheckpointError {
    /// IO错误
    IoError(String),
    /// 序列化错误
    SerializationError(String),
    /// 反序列化错误
    DeserializationError(String),
    /// 其他错误
    Other(String),
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckpointError::IoError(msg) => write!(f, "I/O error: {msg}"),
            CheckpointError::SerializationError(msg) => write!(f, "Serialization error: {msg}"),
            CheckpointError::DeserializationError(msg) => {
                write!(f, "Deserialization error: {msg}")
            }
            CheckpointError::Other(msg) => write!(f, "Checkpoint error: {msg}"),
        }
    }
}

impl std::error::Error for CheckpointError {}

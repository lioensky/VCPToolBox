//! Attention Triage - 注意力规划模块
//!
//! 根据研究目标规划阅读重点，决定哪些部分值得深入阅读。

use crate::*;
use paperreader_domain::*;

/// 注意力规划结果
#[derive(Debug, Clone)]
pub struct AttentionPlan {
    /// 计划ID
    pub plan_id: String,
    /// 研究目标
    pub goal: String,
    /// 注意力分配
    pub allocations: Vec<AttentionAllocation>,
    /// 阅读策略
    pub strategy: ReadingStrategy,
    /// 预计token消耗
    pub estimated_tokens: u64,
}

/// 注意力分配
#[derive(Debug, Clone)]
pub struct AttentionAllocation {
    /// 目标区块ID
    pub block_id: BlockId,
    /// 注意力级别
    pub level: AttentionLevel,
    /// 分配理由
    pub rationale: String,
    /// 相关度评分 (0-1)
    pub relevance_score: f64,
}

/// 注意力级别
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionLevel {
    /// 跳过 - 不阅读
    Skip,
    /// 浏览 - 快速扫过
    Skim,
    /// 正常阅读
    Normal,
    /// 深度阅读
    Deep,
    /// 精读 - 逐字分析
    Intensive,
}

impl AttentionLevel {
    /// 获取对应的阅读深度系数
    pub fn depth_factor(&self) -> f64 {
        match self {
            AttentionLevel::Skip => 0.0,
            AttentionLevel::Skim => 0.25,
            AttentionLevel::Normal => 0.5,
            AttentionLevel::Deep => 0.75,
            AttentionLevel::Intensive => 1.0,
        }
    }

    /// 获取预计token消耗系数
    pub fn token_factor(&self) -> f64 {
        match self {
            AttentionLevel::Skip => 0.0,
            AttentionLevel::Skim => 0.3,
            AttentionLevel::Normal => 1.0,
            AttentionLevel::Deep => 2.5,
            AttentionLevel::Intensive => 5.0,
        }
    }
}

/// 阅读策略
#[derive(Debug, Clone)]
pub enum ReadingStrategy {
    /// 顺序阅读
    Sequential,
    /// 优先阅读高相关度部分
    PriorityBased,
    /// 广度优先 - 先了解全貌
    BreadthFirst,
    /// 深度优先 - 深入关键部分
    DepthFirst,
}

/// Attention Triage 引擎
pub struct AttentionTriageEngine {
    /// LLM 客户端
    llm_client: Arc<dyn LlmClient>,
    /// 配置
    config: TriageConfig,
}

/// Triage 配置
#[derive(Debug, Clone)]
pub struct TriageConfig {
    /// 默认阅读策略
    pub default_strategy: ReadingStrategy,
    /// 最小相关度阈值
    pub min_relevance_threshold: f64,
    /// 最大深度阅读区块数
    pub max_deep_read_blocks: usize,
    /// 是否启用智能重排序
    pub enable_smart_reordering: bool,
}

impl Default for TriageConfig {
    fn default() -> Self {
        Self {
            default_strategy: ReadingStrategy::PriorityBased,
            min_relevance_threshold: 0.3,
            max_deep_read_blocks: 5,
            enable_smart_reordering: true,
        }
    }
}

impl AttentionTriageEngine {
    /// 创建新的 Attention Triage 引擎
    pub fn new(llm_client: Arc<dyn LlmClient>) -> Self {
        Self {
            llm_client,
            config: TriageConfig::default(),
        }
    }

    /// 使用自定义配置创建
    pub fn with_config(llm_client: Arc<dyn LlmClient>, config: TriageConfig) -> Self {
        Self { llm_client, config }
    }

    pub fn config(&self) -> &TriageConfig {
        &self.config
    }

    /// 规划注意力分配
    pub async fn plan_attention(
        &self,
        document: &NormalizedDocument,
        goal: &str,
    ) -> Result<AttentionPlan, ReadingError> {
        let plan_id = format!(
            "at-{}-{}",
            document.document_id.0,
            chrono::Utc::now().timestamp()
        );

        // 构建提示词
        let prompt = self.build_triage_prompt(document, goal);

        // 调用 LLM 进行注意力规划
        let response = self
            .llm_client
            .generate(&prompt)
            .await
            .map_err(|e| ReadingError::LlmError(e.to_string()))?;

        // 解析响应
        let allocations = self.parse_triage_response(&response, document)?;

        // 计算预计token消耗
        let estimated_tokens = self.estimate_tokens(&allocations, document);

        // 应用后处理策略
        let allocations = self.apply_strategy(allocations);

        Ok(AttentionPlan {
            plan_id,
            goal: goal.to_string(),
            allocations,
            strategy: self.config.default_strategy.clone(),
            estimated_tokens,
        })
    }

    /// 构建 triage 提示词
    fn build_triage_prompt(&self, document: &NormalizedDocument, goal: &str) -> String {
        let mut prompt = format!(
            "You are an expert research assistant. Given a document and a research goal, \
             analyze which sections deserve different levels of attention.\n\n\
             Research Goal: {}\n\n\
             Document Title: {}\n\
             Document Outline:\n",
            goal, document.title
        );

        // 添加大纲信息
        for node in &document.outline {
            let indent = "  ".repeat(node.level as usize);
            prompt.push_str(&format!(
                "{}{} (level: {}, id: {})\n",
                indent, node.title, node.level, node.node_id.0
            ));
        }

        prompt.push_str("\nFor each section, provide:\n");
        prompt.push_str("1. Block ID\n");
        prompt.push_str("2. Attention Level (skip/skim/normal/deep/intensive)\n");
        prompt.push_str("3. Relevance Score (0.0-1.0)\n");
        prompt.push_str("4. Brief rationale\n\n");
        prompt.push_str("Format: block_id|level|score|rationale\n");

        prompt
    }

    /// 解析 triage 响应
    fn parse_triage_response(
        &self,
        response: &str,
        document: &NormalizedDocument,
    ) -> Result<Vec<AttentionAllocation>, ReadingError> {
        let mut allocations = Vec::new();
        let block_map: std::collections::HashMap<_, _> = document
            .blocks
            .iter()
            .map(|b| (b.block_id.0.clone(), b))
            .collect();

        for line in response.lines() {
            let parts: Vec<_> = line.split('|').collect();
            if parts.len() >= 3 {
                let block_id = parts[0].trim();
                let level_str = parts[1].trim().to_lowercase();
                let score: f64 = parts[2].trim().parse().unwrap_or(0.5);
                let rationale = parts.get(3).unwrap_or(&"").to_string();

                let level = match level_str.as_str() {
                    "skip" => AttentionLevel::Skip,
                    "skim" => AttentionLevel::Skim,
                    "normal" => AttentionLevel::Normal,
                    "deep" => AttentionLevel::Deep,
                    "intensive" => AttentionLevel::Intensive,
                    _ => AttentionLevel::Normal,
                };

                if let Some(_) = block_map.get(block_id) {
                    allocations.push(AttentionAllocation {
                        block_id: BlockId(block_id.to_string()),
                        level,
                        rationale,
                        relevance_score: score.clamp(0.0, 1.0),
                    });
                }
            }
        }

        // 确保所有区块都有分配
        for block in &document.blocks {
            if !allocations.iter().any(|a| a.block_id == block.block_id) {
                allocations.push(AttentionAllocation {
                    block_id: block.block_id.clone(),
                    level: AttentionLevel::Normal,
                    rationale: "Default allocation".to_string(),
                    relevance_score: 0.5,
                });
            }
        }

        Ok(allocations)
    }

    /// 估计token消耗
    fn estimate_tokens(
        &self,
        allocations: &[AttentionAllocation],
        document: &NormalizedDocument,
    ) -> u64 {
        let block_map: std::collections::HashMap<_, _> =
            document.blocks.iter().map(|b| (&b.block_id, b)).collect();

        allocations
            .iter()
            .map(|alloc| {
                let block = block_map.get(&alloc.block_id);
                let base_tokens = block.map(|b| b.text.len() / 4).unwrap_or(100) as f64;
                (base_tokens * alloc.level.token_factor()) as u64
            })
            .sum()
    }

    /// 应用阅读策略
    fn apply_strategy(
        &self,
        mut allocations: Vec<AttentionAllocation>,
    ) -> Vec<AttentionAllocation> {
        match self.config.default_strategy {
            ReadingStrategy::PriorityBased => {
                // 按相关度排序
                allocations.sort_by(|a, b| {
                    b.relevance_score
                        .partial_cmp(&a.relevance_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            ReadingStrategy::BreadthFirst => {
                // 保持原有顺序，但提升高相关度的为至少 Normal
                for alloc in &mut allocations {
                    if alloc.relevance_score > 0.7
                        && matches!(alloc.level, AttentionLevel::Skip | AttentionLevel::Skim)
                    {
                        alloc.level = AttentionLevel::Normal;
                    }
                }
            }
            ReadingStrategy::DepthFirst => {
                // 限制深度阅读的数量
                let deep_count = allocations
                    .iter()
                    .filter(|a| matches!(a.level, AttentionLevel::Deep | AttentionLevel::Intensive))
                    .count();

                if deep_count > self.config.max_deep_read_blocks {
                    // 降级一些深度阅读为普通阅读
                    let mut count = 0;
                    for alloc in &mut allocations {
                        if matches!(
                            alloc.level,
                            AttentionLevel::Deep | AttentionLevel::Intensive
                        ) {
                            count += 1;
                            if count > self.config.max_deep_read_blocks {
                                alloc.level = AttentionLevel::Normal;
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        allocations
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_attention_level_factors() {
        assert_eq!(AttentionLevel::Skip.depth_factor(), 0.0);
        assert_eq!(AttentionLevel::Intensive.depth_factor(), 1.0);
        assert!(AttentionLevel::Deep.token_factor() > AttentionLevel::Normal.token_factor());
    }

    #[test]
    fn test_triage_config_default() {
        let config = TriageConfig::default();
        assert!(config.min_relevance_threshold > 0.0);
        assert!(config.max_deep_read_blocks > 0);
    }
}

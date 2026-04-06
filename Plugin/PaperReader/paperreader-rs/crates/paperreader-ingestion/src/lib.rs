//! PaperReader Ingestion Crate
//!
//! 本crate实现MinerU统一接入层，负责文档导入、解析任务提交、结果获取。
//!
//! 设计原则：
//! - 解析以 MinerU 为主路径：当 MinerU 可用时优先走云端解析（MinerU v4）
//! - 本 crate 不做 PDF 本地解析，但提供 `build_raw_result_from_text` 作为降级链路的桥接（例如上层用 pdf-parse 提取纯文本）
//! - 失败时显式返回结构化错误，不伪装成功
//! - 保留原始结果用于审计和问题排查

use paperreader_domain::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

mod http_gateway;
mod raw_result_builder;

pub use http_gateway::MinerUHttpGateway;
pub use raw_result_builder::build_raw_result_from_text;

// =============================================================================
// 导入请求模型
// =============================================================================

/// 导入文档请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportDocumentRequest {
    /// 源类型
    pub source_type: ImportSourceType,
    /// 源引用（文件路径/URL/原始文本）
    pub source_ref: String,
    /// 显示名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 所属集合ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<CollectionId>,
    /// 标签
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// 研究目标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// 元数据
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// 导入源类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportSourceType {
    /// 本地文件
    File,
    /// 远程URL
    Url,
    /// 原始文本
    RawText,
    /// 快照
    Snapshot,
}

/// 导入文档响应
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportDocumentResponse {
    /// 文档ID
    pub document_id: DocumentId,
    /// 导入任务ID
    pub job_id: String,
    /// 导入状态
    pub status: ImportStatus,
    /// 创建时间
    pub created_at: String,
}

/// 导入状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    /// 已提交
    Submitted,
    /// 上传中或提交中
    UploadingOrSubmitting,
    /// 解析已请求
    ParseRequested,
    /// 解析中
    Parsing,
    /// 已解析
    Parsed,
    /// 规范化中
    Normalizing,
    /// 就绪
    Ready,
    /// 失败
    Failed(String),
}

// =============================================================================
// MinerU Gateway
// =============================================================================

/// MinerU Gateway配置
#[derive(Debug, Clone)]
pub struct MinerUGatewayConfig {
    /// API基础URL
    pub base_url: String,
    /// API Token
    pub token: String,
    /// 请求超时（秒）
    pub timeout_seconds: u64,
    /// 最大重试次数
    pub max_retries: u32,
}

impl Default for MinerUGatewayConfig {
    fn default() -> Self {
        Self {
            base_url: "https://mineru.net/api/v4".to_string(),
            token: String::new(),
            timeout_seconds: 300,
            max_retries: 3,
        }
    }
}

/// MinerU Gateway trait
pub trait MinerUGateway {
    /// 统一入口：根据输入类型生成可规范化的 `MinerURawResult`。
    ///
    /// 说明：
    /// - 真实 MinerU 模式可以通过 API 上传/解析并把结果桥接成 `MinerURawResult`
    /// - 无 Token 时允许实现本地降级（例如 pdf-parse 纯文本提取）
    fn generate_raw_result(
        &self,
        source_type: ImportSourceType,
        source_ref: &str,
        display_name: Option<String>,
    ) -> Result<MinerURawResult, IngestionError>;

    /// 提交单文档URL解析任务
    fn submit_url_task(
        &self,
        url: &str,
        model_version: ModelVersion,
    ) -> Result<String, IngestionError>;

    /// 获取任务状态
    fn get_task_status(&self, task_id: &str) -> Result<MinerUTaskStatus, IngestionError>;

    /// 批量提交URL任务
    fn submit_batch_url_tasks(
        &self,
        urls: &[&str],
        model_version: ModelVersion,
    ) -> Result<String, IngestionError>;

    /// 获取批量任务结果
    fn get_batch_results(&self, batch_id: &str) -> Result<Vec<MinerUTaskResult>, IngestionError>;

    /// 下载解析结果
    fn download_result(&self, result_url: &str) -> Result<MinerURawResult, IngestionError>;
}

/// 模型版本
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelVersion {
    /// Pipeline模式
    Pipeline,
    /// VLM模式（推荐）
    Vlm,
    /// MinerU-HTML（专用于HTML输入）
    MinerUHtml,
}

impl ModelVersion {
    /// 根据源类型选择默认模型版本
    pub fn default_for_source(source_type: &ImportSourceType) -> Self {
        match source_type {
            ImportSourceType::File | ImportSourceType::Url => ModelVersion::Vlm,
            ImportSourceType::RawText | ImportSourceType::Snapshot => ModelVersion::Pipeline,
        }
    }
}

// =============================================================================
// MinerU 任务状态
// =============================================================================

/// MinerU任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MinerUTaskState {
    /// 等待文件
    WaitingFile,
    /// 上传中
    Uploading,
    /// 待处理
    Pending,
    /// 转换中
    Converting,
    /// 运行中
    Running,
    /// 完成
    Done,
    /// 失败
    Failed,
}

/// MinerU任务状态详情
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUTaskStatus {
    /// 任务ID
    pub task_id: String,
    /// 状态
    pub state: MinerUTaskState,
    /// 进度百分比
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<u8>,
    /// 错误信息（如果失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 结果URL（如果完成）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_url: Option<String>,
    /// 完整ZIP包URL（如果完成）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_zip_url: Option<String>,
}

/// MinerU任务结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUTaskResult {
    /// 任务ID
    pub task_id: String,
    /// 状态
    pub state: MinerUTaskState,
    /// 原始结果
    pub raw_result: MinerURawResult,
}

// =============================================================================
// MinerU 原始结果
// =============================================================================

/// MinerU原始解析结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerURawResult {
    /// 结果版本
    pub version: String,
    /// 文档基本信息
    pub document_info: MinerUDocumentInfo,
    /// 解析的页面
    pub pages: Vec<MinerUPage>,
    /// 提取的文本块
    pub blocks: Vec<MinerUBlock>,
    /// 提取的图片
    #[serde(default)]
    pub images: Vec<MinerUImage>,
    /// 提取的表格
    #[serde(default)]
    pub tables: Vec<MinerUTable>,
    /// 提取的公式
    #[serde(default)]
    pub equations: Vec<MinerUEquation>,
    /// 目录结构
    #[serde(default)]
    pub outline: Vec<MinerUOutlineItem>,
    /// 引用信息
    #[serde(default)]
    pub references: Vec<MinerUReference>,
    /// 元数据
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// MinerU文档信息
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUDocumentInfo {
    /// 页数
    pub page_count: u32,
    /// 标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 作者
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    /// 创建日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
}

/// MinerU页面
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUPage {
    /// 页码
    pub page_number: u32,
    /// 页面宽度
    pub width: f64,
    /// 页面高度
    pub height: f64,
    /// 页面上的块ID
    pub block_ids: Vec<String>,
}

/// MinerU块
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUBlock {
    /// 块ID
    pub block_id: String,
    /// 块类型
    pub block_type: MinerUBlockType,
    /// 文本内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 页码
    pub page_number: u32,
    /// 边界框
    pub bbox: MinerUBBox,
    /// 层级
    pub level: u8,
    /// 置信度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// 额外属性
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub attrs: HashMap<String, serde_json::Value>,
}

/// MinerU块类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MinerUBlockType {
    /// 标题
    Title,
    /// 副标题
    SubTitle,
    /// 章节标题
    SectionHeader,
    /// 段落
    Paragraph,
    /// 列表项
    ListItem,
    /// 表格
    Table,
    /// 图片
    Figure,
    /// 公式
    Equation,
    /// 页眉
    Header,
    /// 页脚
    Footer,
    /// 脚注
    Footnote,
    /// 引用
    Reference,
    /// 代码
    Code,
    /// 其他
    Other(String),
}

/// MinerU边界框
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUBBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// MinerU图片
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUImage {
    /// 图片ID
    pub image_id: String,
    /// 页码
    pub page_number: u32,
    /// 边界框
    pub bbox: MinerUBBox,
    /// 说明文字
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// 存储路径
    pub storage_path: String,
}

/// MinerU表格
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUTable {
    /// 表格ID
    pub table_id: String,
    /// 页码
    pub page_number: u32,
    /// 边界框
    pub bbox: MinerUBBox,
    /// HTML表示
    pub html: String,
    /// 说明文字
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

/// MinerU公式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUEquation {
    /// 公式ID
    pub equation_id: String,
    /// 页码
    pub page_number: u32,
    /// LaTeX表示
    pub latex: String,
    /// 边界框
    pub bbox: MinerUBBox,
}

/// MinerU目录项
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUOutlineItem {
    /// 标题
    pub title: String,
    /// 层级
    pub level: u8,
    /// 页码
    pub page_number: u32,
    /// 关联的块ID
    pub block_id: String,
}

/// MinerU引用
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinerUReference {
    /// 引用ID
    pub ref_id: String,
    /// 引用文本
    pub text: String,
    /// 引用编号
    pub number: String,
}

// =============================================================================
// 错误模型
// =============================================================================

/// 导入错误
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IngestionError {
    /// 错误代码
    pub error_code: String,
    /// 错误消息
    pub message: String,
    /// 阶段
    pub stage: IngestionStage,
    /// 是否可重试
    pub retryable: bool,
    /// 关联的文档ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<DocumentId>,
    /// 原始错误详情
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error: Option<String>,
}

impl std::fmt::Display for IngestionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {} (stage: {:?}, retryable: {})",
            self.error_code, self.message, self.stage, self.retryable
        )
    }
}

impl std::error::Error for IngestionError {}

/// 导入阶段
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IngestionStage {
    /// 上传
    Upload,
    /// 解析请求
    ParseRequest,
    /// 解析
    Parsing,
    /// 结果下载
    ResultDownload,
    /// 规范化
    Normalization,
    /// 验证
    Validation,
}

impl IngestionError {
    /// 上传失败
    pub fn upload_failed(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            error_code: "UPLOAD_FAILED".to_string(),
            message: message.into(),
            stage: IngestionStage::Upload,
            retryable,
            document_id: None,
            source_error: None,
        }
    }

    /// 本地解析失败（降级链路）
    pub fn local_parse_failed(reason: impl Into<String>) -> Self {
        Self {
            error_code: "LOCAL_PARSE_FAILED".to_string(),
            message: reason.into(),
            stage: IngestionStage::Parsing,
            retryable: false,
            document_id: None,
            source_error: None,
        }
    }

    /// 解析请求失败
    pub fn parse_request_failed(message: impl Into<String>) -> Self {
        Self {
            error_code: "PARSE_REQUEST_FAILED".to_string(),
            message: message.into(),
            stage: IngestionStage::ParseRequest,
            retryable: true,
            document_id: None,
            source_error: None,
        }
    }

    /// 解析超时
    pub fn parse_timeout(task_id: impl Into<String>) -> Self {
        Self {
            error_code: "PARSE_TIMEOUT".to_string(),
            message: format!("Task {} timed out", task_id.into()),
            stage: IngestionStage::Parsing,
            retryable: true,
            document_id: None,
            source_error: None,
        }
    }

    /// 解析失败
    pub fn parse_failed(task_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            error_code: "PARSE_FAILED".to_string(),
            message: format!("Task {} failed: {}", task_id.into(), reason.into()),
            stage: IngestionStage::Parsing,
            retryable: false,
            document_id: None,
            source_error: None,
        }
    }

    /// MinerU不支持
    pub fn unsupported_by_mineru(file_type: impl Into<String>) -> Self {
        Self {
            error_code: "UNSUPPORTED_BY_MINERU".to_string(),
            message: format!(
                "File type '{}' is not supported by MinerU",
                file_type.into()
            ),
            stage: IngestionStage::Validation,
            retryable: false,
            document_id: None,
            source_error: None,
        }
    }

    /// MinerU结果格式错误
    pub fn malformed_mineru_result(reason: impl Into<String>) -> Self {
        Self {
            error_code: "MALFORMED_MINERU_RESULT".to_string(),
            message: reason.into(),
            stage: IngestionStage::ResultDownload,
            retryable: false,
            document_id: None,
            source_error: None,
        }
    }

    /// 规范化失败
    pub fn normalization_failed(reason: impl Into<String>) -> Self {
        Self {
            error_code: "NORMALIZATION_FAILED".to_string(),
            message: reason.into(),
            stage: IngestionStage::Normalization,
            retryable: false,
            document_id: None,
            source_error: None,
        }
    }
}

// =============================================================================
// Normalizer - MinerU结果到NormalizedDocument的转换
// =============================================================================

/// 规范化器
pub struct Normalizer;

impl Normalizer {
    pub fn new() -> Self {
        Self
    }

    /// 将MinerU原始结果转换为NormalizedDocument
    pub fn normalize(&self, raw: MinerURawResult) -> Result<NormalizedDocument, IngestionError> {
        let document_id = DocumentId::new(uuid::Uuid::new_v4().to_string());

        // 转换blocks
        let blocks: Vec<Block> = raw
            .blocks
            .into_iter()
            .map(|b| self.convert_block(b))
            .collect();

        // 转换outline
        let outline: Vec<OutlineNode> = raw
            .outline
            .into_iter()
            .enumerate()
            .map(|(i, o)| self.convert_outline_item(o, i))
            .collect();

        // 转换references
        let references: Vec<ReferenceEntry> = raw
            .references
            .into_iter()
            .map(|r| self.convert_reference(r))
            .collect();

        // 转换assets（图片、表格、公式）
        let mut assets: Vec<AssetRef> = Vec::new();

        for img in raw.images {
            assets.push(AssetRef {
                asset_id: img.image_id.clone(),
                asset_type: AssetType::Figure,
                caption: img.caption.unwrap_or_default(),
                source_block_id: BlockId::new(format!("block_img_{}", img.image_id)),
                storage_ref: img.storage_path,
            });
        }

        // 构建canonical text
        let canonical_text = blocks
            .iter()
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n\n");

        let title = raw
            .document_info
            .title
            .unwrap_or_else(|| "Untitled".to_string());

        Ok(NormalizedDocument {
            document_id,
            title,
            source_type: SourceType::Pdf,
            metadata: DocumentMetadata {
                authors: raw.document_info.authors,
                page_count: Some(raw.document_info.page_count),
                ..Default::default()
            },
            blocks,
            outline,
            references,
            assets,
            canonical_text,
            normalized_document_version: "1.0".to_string(),
            schema_version: "1.0".to_string(),
            extensions: HashMap::new(),
        })
    }

    fn convert_block(&self, block: MinerUBlock) -> Block {
        let block_type = match block.block_type {
            MinerUBlockType::Title | MinerUBlockType::SubTitle => BlockType::Heading { level: 1 },
            MinerUBlockType::SectionHeader => BlockType::Heading { level: block.level },
            MinerUBlockType::Paragraph => BlockType::Paragraph,
            MinerUBlockType::ListItem => BlockType::List { ordered: false },
            MinerUBlockType::Table => BlockType::Table,
            MinerUBlockType::Figure => BlockType::Figure,
            MinerUBlockType::Equation => BlockType::Equation,
            MinerUBlockType::Code => BlockType::Code { language: None },
            MinerUBlockType::Header | MinerUBlockType::Footer | MinerUBlockType::Footnote => {
                BlockType::Metadata
            }
            MinerUBlockType::Reference => BlockType::Reference,
            MinerUBlockType::Other(_) => BlockType::Paragraph,
        };

        Block {
            block_id: BlockId::new(block.block_id),
            block_type,
            text: block.text.unwrap_or_default(),
            source_span: Some(SourceSpan {
                start_page: block.page_number,
                end_page: block.page_number,
                bbox: Some(BoundingBox {
                    x: block.bbox.x,
                    y: block.bbox.y,
                    width: block.bbox.width,
                    height: block.bbox.height,
                }),
            }),
            asset_refs: Vec::new(),
            citation_refs: Vec::new(),
            attrs: block.attrs,
        }
    }

    fn convert_outline_item(&self, item: MinerUOutlineItem, index: usize) -> OutlineNode {
        OutlineNode {
            node_id: NodeId::new(format!("node_{}_{}", index, item.block_id)),
            title: item.title,
            level: item.level,
            parent_id: None, // 需要后续根据层级关系计算
            block_range: BlockRange {
                start_block_id: BlockId::new(item.block_id.clone()),
                end_block_id: BlockId::new(item.block_id),
            },
            summary_hint: None,
            node_type: "heading".to_string(),
        }
    }

    fn convert_reference(&self, ref_entry: MinerUReference) -> ReferenceEntry {
        ReferenceEntry {
            ref_id: ref_entry.ref_id,
            label: ref_entry.number,
            text: ref_entry.text,
            normalized_key: None,
            linked_blocks: Vec::new(),
        }
    }
}

// =============================================================================
// 外部依赖
// =============================================================================

pub extern crate chrono;
pub extern crate serde;
pub extern crate serde_json;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_import_request_creation() {
        let request = ImportDocumentRequest {
            source_type: ImportSourceType::Url,
            source_ref: "https://example.com/paper.pdf".to_string(),
            display_name: Some("Test Paper".to_string()),
            collection_id: None,
            tags: vec!["test".to_string()],
            goal: Some("Analyze methodology".to_string()),
            metadata: HashMap::new(),
        };

        assert_eq!(request.source_type, ImportSourceType::Url);
        assert_eq!(request.source_ref, "https://example.com/paper.pdf");
    }

    #[test]
    fn test_model_version_default() {
        let version = ModelVersion::default_for_source(&ImportSourceType::Url);
        assert!(matches!(version, ModelVersion::Vlm));

        let version = ModelVersion::default_for_source(&ImportSourceType::RawText);
        assert!(matches!(version, ModelVersion::Pipeline));
    }

    #[test]
    fn test_ingestion_error_creation() {
        let error = IngestionError::upload_failed("Network error", true);
        assert_eq!(error.error_code, "UPLOAD_FAILED");
        assert!(error.retryable);
        assert!(matches!(error.stage, IngestionStage::Upload));
    }

    #[test]
    fn test_mineru_task_state_mapping() {
        // 测试状态映射
        let status = MinerUTaskStatus {
            task_id: "task-001".to_string(),
            state: MinerUTaskState::Running,
            progress_percent: Some(50),
            error_message: None,
            result_url: None,
            full_zip_url: None,
        };

        assert!(matches!(status.state, MinerUTaskState::Running));
        assert_eq!(status.progress_percent, Some(50));
    }

    #[test]
    fn test_normalizer_block_conversion() {
        let mineru_block = MinerUBlock {
            block_id: "block_001".to_string(),
            block_type: MinerUBlockType::Title,
            text: Some("Introduction".to_string()),
            page_number: 1,
            bbox: MinerUBBox {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 20.0,
            },
            level: 1,
            confidence: Some(0.95),
            attrs: HashMap::new(),
        };

        let normalizer = Normalizer::new();
        let block = normalizer.convert_block(mineru_block);

        assert!(matches!(block.block_type, BlockType::Heading { level: 1 }));
        assert_eq!(block.text, "Introduction");
    }
}

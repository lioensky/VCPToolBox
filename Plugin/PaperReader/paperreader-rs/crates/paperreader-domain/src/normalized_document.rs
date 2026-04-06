use crate::prelude::*;
use crate::*;

// =============================================================================
// NormalizedDocument - 统一文档中间表示
// =============================================================================

/// 统一文档中间表示 - 系统的核心资产
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedDocument {
    /// 文档ID
    pub document_id: DocumentId,
    /// 标题
    pub title: String,
    /// 源类型
    pub source_type: SourceType,
    /// 元数据
    pub metadata: DocumentMetadata,
    /// 块列表
    pub blocks: Vec<Block>,
    /// 大纲节点
    pub outline: Vec<OutlineNode>,
    /// 引用条目
    pub references: Vec<ReferenceEntry>,
    /// 资产引用
    pub assets: Vec<AssetRef>,
    /// 规范文本（全文线性视图）
    pub canonical_text: String,
    /// 规范化文档版本
    pub normalized_document_version: String,
    /// Schema版本
    pub schema_version: String,
    /// 扩展字段
    #[serde(default)]
    pub extensions: HashMap<String, serde_json::Value>,
}

impl NormalizedDocument {
    pub fn new(document_id: DocumentId, title: impl Into<String>) -> Self {
        Self {
            document_id,
            title: title.into(),
            source_type: SourceType::Pdf,
            metadata: DocumentMetadata::default(),
            blocks: Vec::new(),
            outline: Vec::new(),
            references: Vec::new(),
            assets: Vec::new(),
            canonical_text: String::new(),
            normalized_document_version: "1.0".to_string(),
            schema_version: "1.0".to_string(),
            extensions: HashMap::new(),
        }
    }
}

/// 文档元数据
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DocumentMetadata {
    /// 作者
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    /// 创建日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_date: Option<String>,
    /// 页数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    /// 语言
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// 关键词
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    /// 额外元数据
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Block类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum BlockType {
    /// 标题
    Heading { level: u8 },
    /// 段落
    Paragraph,
    /// 列表
    List { ordered: bool },
    /// 引用
    Quote,
    /// 表格
    Table,
    /// 图片
    Figure,
    /// 公式
    Equation,
    /// 代码
    Code { language: Option<String> },
    /// 引用块
    Reference,
    /// 元数据块
    Metadata,
}

/// 文档块 - 统一语义单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    /// 块ID
    pub block_id: BlockId,
    /// 块类型
    #[serde(flatten)]
    pub block_type: BlockType,
    /// 文本内容
    pub text: String,
    /// 源位置信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_span: Option<SourceSpan>,
    /// 引用的资产
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_refs: Vec<String>,
    /// 引用的引用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citation_refs: Vec<String>,
    /// 额外属性
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub attrs: HashMap<String, serde_json::Value>,
}

/// 源位置信息
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceSpan {
    /// 起始页
    pub start_page: u32,
    /// 结束页
    pub end_page: u32,
    /// 页内坐标（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<BoundingBox>,
}

/// 边界框
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 大纲节点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlineNode {
    /// 节点ID
    pub node_id: NodeId,
    /// 标题
    pub title: String,
    /// 层级
    pub level: u8,
    /// 父节点ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<NodeId>,
    /// 包含的block范围
    pub block_range: BlockRange,
    /// 摘要提示
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_hint: Option<String>,
    /// 节点类型
    pub node_type: String,
}

/// Block范围
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockRange {
    pub start_block_id: BlockId,
    pub end_block_id: BlockId,
}

/// 引用条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReferenceEntry {
    /// 引用ID
    pub ref_id: String,
    /// 标签
    pub label: String,
    /// 文本内容
    pub text: String,
    /// 规范化键
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_key: Option<String>,
    /// 关联的blocks
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked_blocks: Vec<BlockId>,
}

/// 资产引用
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetRef {
    /// 资产ID
    pub asset_id: String,
    /// 资产类型
    pub asset_type: AssetType,
    /// 标题/说明
    pub caption: String,
    /// 源block ID
    pub source_block_id: BlockId,
    /// 存储引用（文件路径/URL）
    pub storage_ref: String,
}

/// 资产类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetType {
    /// 图片
    Figure,
    /// 表格图片
    TableImage,
    /// 附件
    Attachment,
}

use crate::prelude::*;
use crate::*;

// =============================================================================
// Collection - 集合聚合根
// =============================================================================

/// 文档集合
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Collection {
    /// 集合ID
    pub collection_id: CollectionId,
    /// 名称
    pub name: String,
    /// 研究目标
    pub goal: String,
    /// 包含的文档ID列表
    pub document_ids: Vec<DocumentId>,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

impl Collection {
    pub fn new(
        collection_id: CollectionId,
        name: impl Into<String>,
        goal: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            collection_id,
            name: name.into(),
            goal: goal.into(),
            document_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn add_document(&mut self, document_id: DocumentId) {
        if !self.document_ids.contains(&document_id) {
            self.document_ids.push(document_id);
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }
}

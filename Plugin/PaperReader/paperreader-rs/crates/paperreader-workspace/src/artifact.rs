use crate::MigrationResult;
use crate::prelude::*;

// =============================================================================
// Artifact 工件系统
// =============================================================================

/// 工件头部 - 所有正式工件必须包含的统一头部
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtifactHeader {
    /// 工件类型
    pub artifact_type: String,
    /// Schema版本
    pub schema_version: String,
    /// 创建者
    pub created_by: String,
    /// 创建时间
    pub created_at: String,
    /// 协议兼容性
    pub protocol_compat: ProtocolCompat,
}

impl ArtifactHeader {
    pub fn new(artifact_type: impl Into<String>, schema_version: impl Into<String>) -> Self {
        Self {
            artifact_type: artifact_type.into(),
            schema_version: schema_version.into(),
            created_by: "paperreader".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            protocol_compat: ProtocolCompat::default(),
        }
    }
}

/// 协议兼容性
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProtocolCompat {
    /// 最小协议版本
    pub min_protocol: String,
    /// 最大协议版本
    pub max_protocol: String,
}

impl Default for ProtocolCompat {
    fn default() -> Self {
        Self {
            min_protocol: "1.0".to_string(),
            max_protocol: "1.x".to_string(),
        }
    }
}

/// 工件元数据
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtifactMeta {
    /// 工件ID
    pub artifact_id: String,
    /// 工件路径（相对workspace根目录）
    pub path: PathBuf,
    /// 头部信息
    pub header: ArtifactHeader,
    /// 关联的实体ID
    pub entity_id: Option<String>,
    /// 工件大小（字节）
    pub size_bytes: u64,
    /// 校验和
    pub checksum: Option<String>,
    /// schema probe 结果
    pub probe_result: MigrationResult,
    /// 是否包含正式头部
    pub has_header: bool,
}

/// 工件 schema probe 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtifactProbe {
    pub artifact_type: String,
    pub schema_version: String,
    pub has_header: bool,
    pub migration_result: MigrationResult,
}

/// 工件仓库 trait
pub trait ArtifactRepository {
    /// 保存工件
    fn save_artifact<T: Serialize>(
        &self,
        artifact: &Artifact<T>,
        path: &Path,
    ) -> anyhow::Result<()>;

    /// 读取工件
    fn load_artifact<T: for<'de> Deserialize<'de>>(
        &self,
        path: &Path,
    ) -> anyhow::Result<Artifact<T>>;

    /// 检查工件是否存在
    fn exists(&self, path: &Path) -> bool;

    /// 列出工件
    fn list_artifacts(&self, prefix: &Path) -> anyhow::Result<Vec<ArtifactMeta>>;
}

/// 带头部的工件包装
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Artifact<T> {
    /// 头部
    pub header: ArtifactHeader,
    /// 载荷
    pub payload: T,
}

impl<T> Artifact<T> {
    pub fn new(
        artifact_type: impl Into<String>,
        schema_version: impl Into<String>,
        payload: T,
    ) -> Self {
        Self {
            header: ArtifactHeader::new(artifact_type, schema_version),
            payload,
        }
    }
}

/// 文本工件 sidecar 载荷
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextArtifactPayload {
    pub artifact_path: PathBuf,
    pub media_type: String,
    pub encoding: String,
}

use crate::prelude::*;

// =============================================================================
// Workspace 布局
// =============================================================================

/// 工作空间布局
#[derive(Debug, Clone)]
pub struct WorkspaceLayout {
    /// 工作空间根目录
    pub root: PathBuf,
}

impl WorkspaceLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// documents目录
    pub fn documents_dir(&self) -> PathBuf {
        self.root.join("documents")
    }

    /// 特定document目录
    pub fn document_dir(&self, document_id: &DocumentId) -> PathBuf {
        self.documents_dir().join(&document_id.0)
    }

    /// collections目录
    pub fn collections_dir(&self) -> PathBuf {
        self.root.join("collections")
    }

    /// 特定collection目录
    pub fn collection_dir(&self, collection_id: &CollectionId) -> PathBuf {
        self.collections_dir().join(&collection_id.0)
    }

    /// runs目录
    pub fn runs_dir(&self) -> PathBuf {
        self.root.join("runs")
    }

    /// 特定run目录
    pub fn run_dir(&self, run_id: &str) -> PathBuf {
        self.runs_dir().join(run_id)
    }

    /// shared目录
    pub fn shared_dir(&self) -> PathBuf {
        self.root.join("shared")
    }

    /// indexes目录
    pub fn indexes_dir(&self) -> PathBuf {
        self.root.join("indexes")
    }

    /// 创建所有目录
    pub fn create_directories(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(self.documents_dir())?;
        std::fs::create_dir_all(self.collections_dir())?;
        std::fs::create_dir_all(self.runs_dir())?;
        std::fs::create_dir_all(self.shared_dir())?;
        std::fs::create_dir_all(self.indexes_dir())?;
        Ok(())
    }
}

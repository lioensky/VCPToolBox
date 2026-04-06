use crate::prelude::*;
use crate::*;

// =============================================================================
// Bootstrap
// =============================================================================

/// 工作空间引导
pub struct BootstrapWorkspace;

impl BootstrapWorkspace {
    /// 执行引导
    pub fn execute(root: impl Into<PathBuf>) -> anyhow::Result<WorkspaceRepository> {
        let repo = WorkspaceRepository::new(root);
        repo.bootstrap()?;
        Ok(repo)
    }

    /// 检查并引导（如果不存在）
    pub fn ensure(root: impl Into<PathBuf>) -> anyhow::Result<WorkspaceRepository> {
        let repo = WorkspaceRepository::new(root);
        if !repo.exists() {
            repo.bootstrap()?;
        }
        Ok(repo)
    }
}

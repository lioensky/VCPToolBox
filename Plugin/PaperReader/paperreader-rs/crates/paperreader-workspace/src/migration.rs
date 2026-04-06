use crate::prelude::*;

// =============================================================================
// Migration Registry
// =============================================================================

/// 迁移注册表
pub struct MigrationRegistry {
    migrations: HashMap<(String, String), Box<dyn ArtifactMigration>>,
}

impl Default for MigrationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MigrationRegistry {
    pub fn new() -> Self {
        Self {
            migrations: HashMap::new(),
        }
    }

    pub fn register<M: ArtifactMigration + 'static>(
        &mut self,
        from_version: impl Into<String>,
        to_version: impl Into<String>,
        migration: M,
    ) {
        self.migrations.insert(
            (from_version.into(), to_version.into()),
            Box::new(migration),
        );
    }

    pub fn can_migrate(&self, from_version: &str, to_version: &str) -> bool {
        self.migrations
            .contains_key(&(from_version.to_string(), to_version.to_string()))
    }

    pub fn get_migration_result(&self, from_version: &str, to_version: &str) -> MigrationResult {
        if self.can_migrate(from_version, to_version) {
            MigrationResult::CanUpgradeInPlace
        } else {
            MigrationResult::RequiresRebuild
        }
    }
}

/// 工件迁移 trait
pub trait ArtifactMigration: Send + Sync {
    fn migrate(&self, data: serde_json::Value) -> anyhow::Result<serde_json::Value>;
}

/// 迁移结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationResult {
    CanReadDirectly,
    CanUpgradeInPlace,
    RequiresRebuild,
}

/// 迁移报告
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MigrationReport {
    pub artifact_path: PathBuf,
    pub from_version: String,
    pub to_version: String,
    pub result: MigrationResult,
    pub applied_at: String,
    pub details: Option<String>,
}

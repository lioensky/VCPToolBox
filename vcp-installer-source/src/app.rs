use std::path::PathBuf;
use tokio::sync::mpsc;

// ==========================================
//  TUI 页面状态枚举
// ==========================================

#[derive(Debug, Clone, PartialEq)]
pub enum AppState {
    Welcome,
    EnvCheck,
    ComponentSelect,
    ConfigForm,
    Installing,
    Complete,
}

// ==========================================
//  组件定义
// ==========================================

#[derive(Debug, Clone, PartialEq)]
pub enum Component {
    VCPToolBox,
    VCPChat,
    NewAPI,
}

impl Component {
    pub fn all() -> [Self; 3] {
        [Self::VCPToolBox, Self::VCPChat, Self::NewAPI]
    }

    pub fn from_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(Self::VCPToolBox),
            1 => Some(Self::VCPChat),
            2 => Some(Self::NewAPI),
            _ => None,
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            Self::VCPToolBox => "VCPToolBox (后端)",
            Self::VCPChat => "VCPChat (前端)",
            Self::NewAPI => "NewAPI (API管理)",
        }
    }

    pub fn description(&self) -> &str {
        match self {
            Self::VCPToolBox => "AI智能体增强后端服务 — 必选",
            Self::VCPChat => "桌面客户端 — 推荐",
            Self::NewAPI => "API密钥聚合管理 — 可选",
        }
    }

    pub fn is_required(&self) -> bool {
        matches!(self, Self::VCPToolBox)
    }

    pub fn git_repo_url(&self) -> Option<&str> {
        match self {
            Self::VCPToolBox => Some("https://github.com/lioensky/VCPToolBox.git"),
            Self::VCPChat => Some("https://github.com/lioensky/VCPChat.git"),
            Self::NewAPI => None,
        }
    }
}

// ==========================================
//  环境检测结果
// ==========================================

#[derive(Debug, Clone)]
pub enum DependencyStatus {
    Installed(String),
    NotFound,
    Checking,
    WillUsePortable,
}

#[derive(Debug, Clone)]
pub struct EnvCheckResult {
    pub git: DependencyStatus,
    pub node: DependencyStatus,
    pub python: DependencyStatus,
    pub msvc: DependencyStatus,
    pub disk_space_gb: f64,
    pub disk_space_ok: bool,
    pub network_github: bool,
    pub network_npm: bool,
    pub os_version: String,
}

impl Default for EnvCheckResult {
    fn default() -> Self {
        Self {
            git: DependencyStatus::Checking,
            node: DependencyStatus::Checking,
            python: DependencyStatus::Checking,
            msvc: DependencyStatus::Checking,
            disk_space_gb: 0.0,
            disk_space_ok: false,
            network_github: false,
            network_npm: false,
            os_version: String::new(),
        }
    }
}

// ==========================================
//  GitHub镜像配置
// ==========================================

#[derive(Debug, Clone, PartialEq)]
pub enum GithubMirror {
    Direct,
    GhProxy,
    Custom(String),
}

impl GithubMirror {
    pub fn prefix(&self) -> String {
        match self {
            Self::Direct => "https://github.com/".to_string(),
            Self::GhProxy => "https://ghfast.top/https://github.com/".to_string(),
            Self::Custom(url) => url.clone(),
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            Self::Direct => "直连 GitHub",
            Self::GhProxy => "ghproxy.com 加速",
            Self::Custom(_) => "自定义镜像",
        }
    }
}

// ==========================================
//  安装配置
// ==========================================

#[derive(Debug, Clone)]
pub struct InstallConfig {
    pub install_path: PathBuf,
    pub components: Vec<Component>,
    pub mirror: GithubMirror,
    pub use_npm_mirror: bool,
    pub use_pip_mirror: bool,
    pub api_endpoint: String,
    pub api_key: String,
    pub admin_password: String,
    pub tool_auth_code: String,
    pub server_port: u16,
}

impl Default for InstallConfig {
    fn default() -> Self {
        Self {
            install_path: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            components: vec![Component::VCPToolBox, Component::VCPChat],
            mirror: GithubMirror::Direct,
            use_npm_mirror: false,
            use_pip_mirror: false,
            api_endpoint: "http://localhost:3000/v1".to_string(),
            api_key: String::new(),
            admin_password: String::new(),
            tool_auth_code: String::new(),
            server_port: 6005,
        }
    }
}

// ==========================================
//  安装进度
// ==========================================

#[derive(Debug, Clone)]
pub struct InstallStep {
    pub name: String,
    pub status: StepStatus,
    pub download_progress: Option<DownloadProgress>,
}

impl InstallStep {
    pub fn pending(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: StepStatus::Pending,
            download_progress: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StepStatus {
    Pending,
    Running,
    Completed,
    Failed(String),
    Skipped,
}

#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

impl DownloadProgress {
    pub fn percentage(&self) -> f64 {
        if self.total_bytes == 0 {
            0.0
        } else {
            (self.downloaded_bytes as f64 / self.total_bytes as f64) * 100.0
        }
    }

    pub fn downloaded_mb(&self) -> f64 {
        self.downloaded_bytes as f64 / 1_048_576.0
    }

    pub fn total_mb(&self) -> f64 {
        self.total_bytes as f64 / 1_048_576.0
    }
}

#[derive(Debug, Clone)]
pub struct InstallProgress {
    pub steps: Vec<InstallStep>,
    pub current_step_index: usize,
    pub overall_percentage: f64,
}

impl InstallProgress {
    pub fn recalculate_overall_percentage(&mut self) {
        let total = self.steps.len();
        if total == 0 {
            self.overall_percentage = 0.0;
            return;
        }

        let completed = self
            .steps
            .iter()
            .filter(|step| matches!(step.status, StepStatus::Completed | StepStatus::Skipped))
            .count();

        self.overall_percentage = (completed as f64 / total as f64) * 100.0;
    }
}

// ==========================================
//  安装结果
// ==========================================

#[derive(Debug, Clone)]
pub struct InstallResult {
    pub success: bool,
    pub installed_components: Vec<Component>,
    pub install_path: PathBuf,
    pub backend_start_script: Option<PathBuf>,
    pub frontend_start_script: Option<PathBuf>,
    pub errors: Vec<String>,
}

// ==========================================
//  后台任务 -> TUI 消息
// ==========================================

/// 环境检测后台任务发送给TUI的事件
#[derive(Debug, Clone)]
pub enum EnvCheckEvent {
    Completed {
        result: EnvCheckResult,
        mirror: GithubMirror,
        use_npm_mirror: bool,
        use_pip_mirror: bool,
        pip_source_ok: bool,
        error: Option<String>,
    },
}

pub enum ProgressEvent {
    StepStarted { step_index: usize },
    DownloadProgress {
        step_index: usize,
        downloaded: u64,
        total: u64,
    },
    StepCompleted { step_index: usize },
    StepFailed { step_index: usize, error: String },
    StepSkipped { step_index: usize },
    AllCompleted(InstallResult),
    Log(String),
}

// ==========================================
//  主应用结构体
// ==========================================

pub struct App {
    pub state: AppState,
    pub should_quit: bool,
    pub env_check: EnvCheckResult,
    pub env_check_done: bool,
    pub env_check_error: Option<String>,
    pub pip_source_ok: bool,
    pub env_check_rx: Option<mpsc::Receiver<EnvCheckEvent>>,
    pub config: InstallConfig,
    pub component_cursor: usize,
    pub config_form_cursor: usize,
    pub config_form_buffers: Vec<String>,
    pub install_progress: Option<InstallProgress>,
    pub install_result: Option<InstallResult>,
    pub log_messages: Vec<String>,
    pub log_scroll: usize,
    pub complete_scroll: usize,
    pub progress_rx: Option<mpsc::Receiver<ProgressEvent>>,
    /// 各组件是否已在安装目录中存在 [VCPToolBox, VCPChat, NewAPI]
    pub pre_installed: [bool; 3],
}

impl App {
    pub fn new() -> Self {
        let config = InstallConfig::default();
        let config_form_buffers = vec![
            config.install_path.display().to_string(),
        ];

        Self {
            state: AppState::Welcome,
            should_quit: false,
            env_check: EnvCheckResult::default(),
            env_check_done: false,
            env_check_error: None,
            pip_source_ok: false,
            env_check_rx: None,
            config,
            component_cursor: 0,
            config_form_cursor: 0,
            config_form_buffers,
            install_progress: None,
            install_result: None,
            log_messages: Vec::new(),
            log_scroll: 0,
            complete_scroll: 0,
            progress_rx: None,
            pre_installed: [false; 3],
        }
    }

    /// 检测安装目录下已存在的组件
    pub fn detect_pre_installed(&mut self) {
        let base = &self.config.install_path;
        self.pre_installed = [
            base.join("VCPToolBox").is_dir(),
            base.join("VCPChat").is_dir(),
            base.join("new-api.exe").exists() || base.join("NewAPI").is_dir(),
        ];
    }

    /// 查询指定组件是否已安装
    pub fn is_component_pre_installed(&self, component: &Component) -> bool {
        match component {
            Component::VCPToolBox => self.pre_installed[0],
            Component::VCPChat => self.pre_installed[1],
            Component::NewAPI => self.pre_installed[2],
        }
    }

    pub fn next_page(&mut self) {
        self.state = match self.state {
            AppState::Welcome => AppState::EnvCheck,
            AppState::EnvCheck => {
                self.detect_pre_installed();
                AppState::ComponentSelect
            }
            AppState::ComponentSelect => AppState::ConfigForm,
            AppState::ConfigForm => AppState::Installing,
            AppState::Installing => AppState::Complete,
            AppState::Complete => AppState::Complete,
        };
    }

    pub fn prev_page(&mut self) {
        self.state = match self.state {
            AppState::Welcome => AppState::Welcome,
            AppState::EnvCheck => AppState::Welcome,
            AppState::ComponentSelect => AppState::EnvCheck,
            AppState::ConfigForm => AppState::ComponentSelect,
            AppState::Installing => AppState::Installing,
            AppState::Complete => AppState::Complete,
        };
    }

    pub fn is_component_selected(&self, component: &Component) -> bool {
        self.config.components.contains(component)
    }

    pub fn toggle_component_at_cursor(&mut self) {
        let Some(component) = Component::from_index(self.component_cursor) else {
            return;
        };

        if component.is_required() {
            return;
        }

        if self.is_component_selected(&component) {
            self.config.components.retain(|item| item != &component);
        } else {
            self.config.components.push(component);
        }
    }

    pub fn set_mock_env_check(&mut self, os_version: String, disk_space_gb: f64) {
        self.env_check = EnvCheckResult {
            git: DependencyStatus::WillUsePortable,
            node: DependencyStatus::WillUsePortable,
            python: DependencyStatus::WillUsePortable,
            msvc: DependencyStatus::NotFound,
            disk_space_gb,
            disk_space_ok: disk_space_gb >= 3.0,
            network_github: true,
            network_npm: true,
            os_version,
        };
    }

    pub fn build_mock_install_progress(&self) -> InstallProgress {
        let mut steps = vec![
            InstallStep::pending("检查安装目录"),
            InstallStep::pending("准备 Portable 运行时"),
        ];

        if self.is_component_selected(&Component::VCPToolBox) {
            steps.push(InstallStep::pending("克隆 VCPToolBox"));
        }

        if self.is_component_selected(&Component::VCPChat) {
            steps.push(InstallStep::pending("克隆 VCPChat"));
        }

        if self.is_component_selected(&Component::NewAPI) {
            steps.push(InstallStep::pending("下载 NewAPI"));
        }

        steps.push(InstallStep::pending("生成配置文件"));
        steps.push(InstallStep::pending("生成启动脚本"));

        InstallProgress {
            steps,
            current_step_index: 0,
            overall_percentage: 0.0,
        }
    }

    pub fn init_config_form(&mut self) {
        self.config_form_buffers = vec![
            self.config.install_path.to_string_lossy().to_string(),
        ];
        self.config_form_cursor = 0;

        // 自动生成管理密码和工具授权码（写入config.env用）
        if self.config.admin_password.trim().is_empty() {
            self.config.admin_password = generate_random_password(16);
        }
        if self.config.tool_auth_code.trim().is_empty() {
            self.config.tool_auth_code = generate_random_password(16);
        }
    }

    pub fn apply_config_form(&mut self) {
        let install_path = self.config_form_buffers[0].trim();
        if !install_path.is_empty() {
            self.config.install_path = PathBuf::from(install_path);
        }
    }

    pub fn config_form_field_count(&self) -> usize {
        4
    }

    pub fn build_mock_install_result(&self, success: bool) -> InstallResult {
        let install_path = self.config.install_path.clone();

        InstallResult {
            success,
            installed_components: self.config.components.clone(),
            backend_start_script: if self.is_component_selected(&Component::VCPToolBox) {
                Some(install_path.join("start-backend.bat"))
            } else {
                None
            },
            frontend_start_script: if self.is_component_selected(&Component::VCPChat) {
                Some(install_path.join("start-frontend.bat"))
            } else {
                None
            },
            install_path,
            errors: if success {
                Vec::new()
            } else {
                vec!["P0 模拟安装失败".to_string()]
            },
        }
    }
}fn generate_random_password(len: usize) -> String {
    use rand::Rng;

    const CHARSET: &[u8] =
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let mut rng = rand::thread_rng();

    (0..len)
        .map(|_| {
            let index = rng.gen_range(0..CHARSET.len());
            CHARSET[index] as char
        })
        .collect()
}
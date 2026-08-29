use std::path::PathBuf;
use tokio::sync::mpsc;
use crate::mirrors::{MirrorConfig, MirrorResult};

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
    ConfigGuide,
}

// ==========================================
//  组件定义
// ==========================================

/// 运行时环境组件
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeComponent {
    Git,
    NodeJs,
    Python,
    Msvc,
}

impl RuntimeComponent {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Git => "Git",
            Self::NodeJs => "Node.js",
            Self::Python => "Python",
            Self::Msvc => "MSVC Build Tools",
        }
    }

    /// 是否通过 Portable 方式安装到 runtimes/ 目录
    pub fn is_portable(&self) -> bool {
        !matches!(self, Self::Msvc)
    }
}

/// 应用组件（用户可选安装）
#[derive(Debug, Clone, PartialEq)]
pub enum AppComponent {
    VCPToolBox,
    VCPChat,
    VCPBackUpDEV,
    VCPDistributedServer,
    NewAPI,
    MSVCBuildTools,  // 必需运行时组件（npm 原生模块编译依赖），默认勾选
}

impl AppComponent {
    pub fn all() -> [Self; 6] {
        [
            Self::VCPToolBox,
            Self::VCPChat,
            Self::VCPBackUpDEV,
            Self::VCPDistributedServer,
            Self::NewAPI,
            Self::MSVCBuildTools,
        ]
    }

    pub fn from_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(Self::VCPToolBox),
            1 => Some(Self::VCPChat),
            2 => Some(Self::VCPBackUpDEV),
            3 => Some(Self::VCPDistributedServer),
            4 => Some(Self::NewAPI),
            5 => Some(Self::MSVCBuildTools),
            _ => None,
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::VCPToolBox => "VCPToolBox (后端) [必选]",
            Self::VCPChat => "VCPChat (前端) [必选]",
            Self::VCPBackUpDEV => "VCPBackUpDEV [推荐]",
            Self::VCPDistributedServer => "VCPDistributedServer [可选]",
            Self::NewAPI => "NewAPI (API管理) [推荐]",
            Self::MSVCBuildTools => "MSVC Build Tools [必需]",
        }
    }

    pub fn short_name(&self) -> &'static str {
        match self {
            Self::VCPToolBox => "VCPToolBox",
            Self::VCPChat => "VCPChat",
            Self::VCPBackUpDEV => "VCPBackUpDEV",
            Self::VCPDistributedServer => "VCPDistributedServer",
            Self::NewAPI => "NewAPI",
            Self::MSVCBuildTools => "MSVC Build Tools",
        }
    }

    pub fn description(&self) -> &str {
        match self {
            Self::VCPToolBox => "部署在 AI 模型 API 与前端应用之间，是面向 AGI OS 开发和探索的工业级基建示范项目",
            Self::VCPChat => "原生分布式引擎终端项目，一个 AGI-OS 桌面级交互系统，语义级垂直联通 AI-UI/UX-APP",
            Self::VCPBackUpDEV => "VCP 全家桶一键备份项目",
            Self::VCPDistributedServer => "分布式微服务器 + VCP 插件商店官方仓库，让你的任何设备都成为 VCPToolBox 的算力中心",
            Self::NewAPI => "API密钥聚合管理 (单 exe 文件，自动下载最新 release)",
            Self::MSVCBuildTools => "C++ 编译器（VCP 原生模块编译必需，未安装时自动安装）",
        }
    }

    pub fn is_required(&self) -> bool {
        matches!(self, Self::VCPToolBox | Self::VCPChat | Self::MSVCBuildTools)
    }

    pub fn git_repo_url(&self) -> Option<&str> {
        match self {
            Self::VCPToolBox => Some("https://github.com/lioensky/VCPToolBox.git"),
            Self::VCPChat => Some("https://github.com/lioensky/VCPChat.git"),
            Self::VCPBackUpDEV => Some("https://github.com/lioensky/VCPBackUpDEV.git"),
            Self::VCPDistributedServer => Some("https://github.com/lioensky/VCPDistributedServer.git"),
            Self::NewAPI => None,
            Self::MSVCBuildTools => None,
        }
    }
}

/// 兼容别名（保留旧代码中的 Component 引用）
pub type Component = AppComponent;

/// 安装方式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InstallMethod {
GitClone,     // git clone（浅克隆）
TarballGit,   // tarball 快速部署 + 尽力初始化 git 仓库（失败不阻断）
}

impl Default for InstallMethod {
    fn default() -> Self {
        Self::TarballGit
    }
}

impl InstallMethod {
pub fn display_name(&self) -> &'static str {
    match self {
        Self::GitClone => "[Git Clone]",
        Self::TarballGit => "[Tarball+Git]",
    }
}

pub fn toggle(&mut self) {
    *self = match *self {
        Self::GitClone => Self::TarballGit,
        Self::TarballGit => Self::GitClone,
    };
}

pub fn description_short(&self) -> &'static str {
    match self {
        Self::GitClone => "浅克隆，支持git pull更新",
        Self::TarballGit => "tarball必成部署 + 尽力初始化git，支持git pull更新",
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
    pub total_memory_gb: f64,
    pub cpu_name: String,
    pub gpu_name: String,
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
            total_memory_gb: 0.0,
            cpu_name: String::new(),
            gpu_name: String::new(),
        }
    }
}

// ==========================================
//  GitHub镜像配置（改为动态支持）
// ==========================================

/// GitHub 镜像选项（用于选择：直连 or 某个镜像站）
#[derive(Debug, Clone)]
pub enum GithubMirror {
    Direct,                                    // 直连
    Mirror(usize),                             // 使用 [github] 备用列表的镜像站
    Preferred(usize),                          // 使用 [preferred_github] 优选列表的镜像站
}

impl Default for GithubMirror {
    fn default() -> Self {
        Self::Direct
    }
}

impl GithubMirror {
    /// 根据 MirrorConfig 获取实际的前缀URL
    pub fn prefix(&self, mirror_config: &MirrorConfig) -> String {
        match self {
            Self::Direct => "https://github.com/".to_string(),
            Self::Mirror(idx) => mirror_config
                .github
                .get(*idx)
                .map(|e| e.url.clone())
                .unwrap_or_else(|| "https://github.com/".to_string()),
            Self::Preferred(idx) => mirror_config
                .preferred_github
                .get(*idx)
                .map(|e| e.url.clone())
                .unwrap_or_else(|| "https://github.com/".to_string()),
        }
    }

    /// 根据 MirrorConfig 获取显示名称
    pub fn display_name(&self, mirror_config: &MirrorConfig) -> String {
        match self {
            Self::Direct => "直连 GitHub".to_string(),
            Self::Mirror(idx) => mirror_config
                .github
                .get(*idx)
                .map(|e| e.name.clone())
                .unwrap_or_else(|| format!("镜像 #{}", idx)),
            Self::Preferred(idx) => mirror_config
                .preferred_github
                .get(*idx)
                .map(|e| e.name.clone())
                .unwrap_or_else(|| format!("优选镜像 #{}", idx)),
        }
    }

    /// 判断当前镜像是否可用（基于检测结果）
    pub fn is_available(&self, results: &[MirrorResult]) -> bool {
        match self {
            Self::Direct => false,
            Self::Mirror(idx) => results.get(*idx).map_or(false, |r| r.is_reachable()),
            Self::Preferred(_) => true, // 优选镜像来自完整下载测试，直接认为可用
        }
    }
}

/// npm 镜像选项
#[derive(Debug, Clone)]
pub struct NpmMirrorChoice {
    pub use_mirror: bool,
    /// 选中的镜像索引（当 use_mirror = true 时有效）
    pub mirror_index: usize,
}

impl Default for NpmMirrorChoice {
    fn default() -> Self {
        Self {
            use_mirror: false,
            mirror_index: 0,
        }
    }
}

impl NpmMirrorChoice {
    pub fn registry_url(&self, mirror_config: &MirrorConfig) -> String {
        if !self.use_mirror {
            return "https://registry.npmjs.org/".to_string();
        }
        mirror_config
            .npm
            .get(self.mirror_index)
            .map(|e| e.url.clone())
            .unwrap_or_else(|| "https://registry.npmmirror.com/".to_string())
    }

    pub fn display_name(&self, mirror_config: &MirrorConfig) -> String {
        if !self.use_mirror {
            return "官方源".to_string();
        }
        mirror_config
            .npm
            .get(self.mirror_index)
            .map(|e| e.name.clone())
            .unwrap_or_else(|| "镜像".to_string())
    }
}

/// pip 镜像选项
#[derive(Debug, Clone)]
pub struct PipMirrorChoice {
    pub use_mirror: bool,
    pub mirror_index: usize,
}

impl Default for PipMirrorChoice {
    fn default() -> Self {
        Self {
            use_mirror: false,
            mirror_index: 0,
        }
    }
}

impl PipMirrorChoice {
    pub fn simple_url(&self, mirror_config: &MirrorConfig) -> String {
        if !self.use_mirror {
            return "https://pypi.org/simple/".to_string();
        }
        mirror_config
            .pip
            .get(self.mirror_index)
            .map(|e| e.url.clone())
            .unwrap_or_else(|| "https://mirrors.aliyun.com/pypi/simple/".to_string())
    }

    pub fn display_name(&self, mirror_config: &MirrorConfig) -> String {
        if !self.use_mirror {
            return "官方源".to_string();
        }
        mirror_config
            .pip
            .get(self.mirror_index)
            .map(|e| e.name.clone())
            .unwrap_or_else(|| "镜像".to_string())
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
    pub npm_mirror: NpmMirrorChoice,
    pub pip_mirror: PipMirrorChoice,
    pub api_endpoint: String,
    pub api_key: String,
    pub admin_password: String,
    pub tool_auth_code: String,
    pub server_port: u16,
    /// 安装方式：Git Clone or Tarball
    pub install_method: InstallMethod,
}

impl Default for InstallConfig {
    fn default() -> Self {
        Self {
            install_path: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            components: vec![
                Component::VCPToolBox,
                Component::VCPChat,
                Component::VCPBackUpDEV,
                Component::NewAPI,
                Component::MSVCBuildTools,
            ],
            mirror: GithubMirror::Direct,
            npm_mirror: NpmMirrorChoice::default(),
            pip_mirror: PipMirrorChoice::default(),
            api_endpoint: "http://localhost:3000/v1".to_string(),
            api_key: String::new(),
            admin_password: String::new(),
            tool_auth_code: String::new(),
            server_port: 6005,
            install_method: InstallMethod::default(),
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
    /// 已安装的运行时组件（Git/Node.js/Python/MSVC）
    pub installed_runtimes: Vec<RuntimeComponent>,
    /// 已安装的应用组件（VCPToolBox/VCPChat/NewAPI）
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
        npm_mirror: NpmMirrorChoice,
        pip_mirror: PipMirrorChoice,
        // 排序后的镜像检测结果（按速度）
        github_results: Vec<MirrorResult>,
        npm_results: Vec<MirrorResult>,
        pip_results: Vec<MirrorResult>,
        pip_source_ok: bool,
        /// MSVC 下载源是否可达（真实网络探测，区别于 msvc 字段的安装状态）
        msvc_source_ok: bool,
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
    /// MSVC 下载源是否可达（真实网络探测，区别于 env_check.msvc 的安装状态）
    pub msvc_source_ok: bool,
    pub env_check_rx: Option<mpsc::Receiver<EnvCheckEvent>>,
    /// 镜像配置（从 vcp-mirrors.ini 加载）
    pub mirror_config: MirrorConfig,
    pub config: InstallConfig,
    pub component_cursor: usize,
    pub config_form_cursor: usize,
    pub config_form_buffers: Vec<String>,
    /// 排序后的镜像检测结果
    pub github_results: Vec<MirrorResult>,
    pub npm_results: Vec<MirrorResult>,
    pub pip_results: Vec<MirrorResult>,
    pub install_progress: Option<InstallProgress>,
    pub install_result: Option<InstallResult>,
    pub log_messages: Vec<String>,
    pub log_scroll: usize,
    pub complete_scroll: usize,
    pub progress_rx: Option<mpsc::Receiver<ProgressEvent>>,
    /// 各组件是否已在安装目录中存在 [VCPToolBox, VCPChat, VCPBackUpDEV, VCPDistributedServer, NewAPI, MSVCBuildTools]
    pub pre_installed: [bool; 6],
    /// 全局安装方式（对 Git clone 组件统一生效）
    pub install_method: InstallMethod,
}

impl App {
    pub fn new(mirror_config: MirrorConfig) -> Self {
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
            msvc_source_ok: false,
            env_check_rx: None,
            mirror_config,
            config,
            component_cursor: 0,
            config_form_cursor: 0,
            config_form_buffers,
            github_results: Vec::new(),
            npm_results: Vec::new(),
            pip_results: Vec::new(),
            install_progress: None,
            install_result: None,
            log_messages: Vec::new(),
            log_scroll: 0,
            complete_scroll: 0,
            progress_rx: None,
            pre_installed: [false; 6],
            install_method: InstallMethod::default(),
        }
    }

    /// 检测安装目录下已存在的组件
    pub fn detect_pre_installed(&mut self) {
        let base = &self.config.install_path;
        self.pre_installed = [
            base.join("VCPToolBox").is_dir(),
            base.join("VCPChat").is_dir(),
            base.join("VCPBackUpDEV").is_dir(),
            base.join("VCPDistributedServer").is_dir(),
            base.join("runtimes/new-api.exe").exists() || base.join("NewAPI").is_dir(),
            false, // MSVCBuildTools: 暂不检测（需要检查系统环境）
        ];
    }

    /// 查询指定组件是否已安装
    pub fn is_component_pre_installed(&self, component: &Component) -> bool {
        match component {
            Component::VCPToolBox => self.pre_installed[0],
            Component::VCPChat => self.pre_installed[1],
            Component::VCPBackUpDEV => self.pre_installed[2],
            Component::VCPDistributedServer => self.pre_installed[3],
            Component::NewAPI => self.pre_installed[4],
            Component::MSVCBuildTools => self.pre_installed[5],
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
            AppState::Complete => AppState::ConfigGuide,
            AppState::ConfigGuide => AppState::ConfigGuide,
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
            AppState::ConfigGuide => AppState::Complete,
        };
    }

    pub fn is_component_selected(&self, component: &Component) -> bool {
        self.config.components.contains(component)
    }

    /// 切换全局安装方式（Git Clone <-> Tarball）
    pub fn toggle_install_method(&mut self) {
        self.install_method.toggle();
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
            total_memory_gb: 0.0,
            cpu_name: String::new(),
            gpu_name: String::new(),
        };
        // 推荐最快的镜像（如果有的话）
        if !self.github_results.is_empty() && self.github_results[0].is_reachable() {
            self.config.mirror = GithubMirror::Mirror(0);
        }
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

        // 同步用户在组件选择页选中的全局安装方式到 InstallConfig
        // （TUI 的 app.install_method 与安装逻辑读取的 config.install_method 保持一致）
        self.config.install_method = self.install_method;

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
            // 2026-08-23 路径分隔符统一：TUI 用户输入可能混用 `/` 和 `\`，
            // 统一为 `\` 保证全链（日志、拼接、显示）一致。
            self.config.install_path = PathBuf::from(crate::utils::normalize_path_display(install_path));
        }
    }

    pub fn config_form_field_count(&self) -> usize {
        4
    }

    pub fn build_mock_install_result(&self, success: bool) -> InstallResult {
        let install_path = self.config.install_path.clone();

        InstallResult {
            success,
            installed_runtimes: vec![],
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
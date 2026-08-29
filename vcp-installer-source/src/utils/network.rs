use crate::mirrors::{MirrorEntry, MirrorResult};
use reqwest::{Client, StatusCode};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);
const TEST_URL: &str = "https://github.com/lioensky/VCPToolBox.git/info/refs?service=git-upload-pack";

fn build_client() -> Option<Client> {
    Client::builder()
        .timeout(TIMEOUT)
        .user_agent("vcp-installer/1.0")
        .build()
        .ok()
}

async fn measure_head(url: &str) -> Option<Duration> {
    let client = build_client()?;
    let start = Instant::now();

    let resp = client.head(url).send().await.ok()?;
    let status = resp.status();

    if status.is_success() || status.is_redirection() || status == StatusCode::METHOD_NOT_ALLOWED {
        Some(start.elapsed())
    } else {
        None
    }
}

async fn measure_get(url: &str) -> Option<Duration> {
    let client = build_client()?;
    let start = Instant::now();

    let resp = client.get(url).send().await.ok()?;
    let status = resp.status();

    if status.is_success() || status.is_redirection() {
        Some(start.elapsed())
    } else {
        None
    }
}

async fn check_get(url: &str) -> bool {
    let Some(client) = build_client() else {
        return false;
    };

    match client.get(url).send().await {
        Ok(resp) => resp.status().is_success() || resp.status().is_redirection(),
        Err(_) => false,
    }
}

// ==========================================
// GitHub 镜像检测
// ==========================================

/// 测试 GitHub 直连速度
pub async fn test_github_direct() -> Option<Duration> {
    measure_head("https://github.com/lioensky/VCPToolBox").await
}

/// 测试 GitHub 直连是否可达（用于环境检测页面显示）
pub async fn test_github_direct_reachable() -> bool {
    test_github_direct().await.is_some()
}

/// 测试单个 GitHub 镜像站的速度
async fn test_github_mirror_entry(entry: MirrorEntry) -> MirrorResult {
    // 镜像站前缀 + TEST_URL
    let url = format!("{}{}", entry.url.trim_end_matches('/'), TEST_URL);
    let latency = measure_get(&url).await;
    MirrorResult {
        entry: entry.clone(),
        latency,
    }
}

/// 并发测试所有 GitHub 镜像站，返回按延迟排序的结果
pub async fn test_all_github_mirrors(entries: &[MirrorEntry]) -> Vec<MirrorResult> {
    let mut handles = Vec::new();
    for entry in entries {
        let entry = entry.clone();
        handles.push(tokio::spawn(test_github_mirror_entry(entry)));
    }

    let mut results: Vec<MirrorResult> = futures_util::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(|res| res.ok())
        .collect();

    // 按延迟排序：可达的排在前面，不可达的排在后面；可达的按延迟从低到高
    results.sort_by(|a, b| {
        match (a.is_reachable(), b.is_reachable()) {
            (true, true) => a.latency.unwrap().cmp(&b.latency.unwrap()),
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => std::cmp::Ordering::Equal,
        }
    });

    results
}

// ==========================================
// npm 镜像检测
// ==========================================

async fn test_npm_mirror_entry(entry: MirrorEntry) -> MirrorResult {
    let url = format!("{}-/ping", entry.url.trim_end_matches('/'));
    let latency = measure_get(&url).await;
    MirrorResult {
        entry: entry.clone(),
        latency,
    }
}

pub async fn test_all_npm_mirrors(entries: &[MirrorEntry]) -> Vec<MirrorResult> {
    let mut handles = Vec::new();
    for entry in entries {
        let entry = entry.clone();
        handles.push(tokio::spawn(test_npm_mirror_entry(entry)));
    }

    let mut results: Vec<MirrorResult> = futures_util::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(|res| res.ok())
        .collect();

    results.sort_by(|a, b| match (a.is_reachable(), b.is_reachable()) {
        (true, true) => a.latency.unwrap().cmp(&b.latency.unwrap()),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    });

    results
}

pub async fn recommend_npm_mirror(entries: &[MirrorEntry]) -> (Option<usize>, Vec<MirrorResult>) {
    let results = test_all_npm_mirrors(entries).await;
    // 2026-08-23 修复：返回「配置顺序」中的下标，而不是排序后列表的位置。
    // 之前直接取 sorted 里的 position，调用方却拿它查配置顺序，
    // 导致选中的镜像（如华为 sorted[0]）被错映射成配置里的清华(config[0])。
    let recommended = results
        .iter()
        .find(|r| r.is_reachable())
        .and_then(|r| entries.iter().position(|e| e.url == r.entry.url));
    (recommended, results)
}

/// 测试 npm 官方源是否可达（保持向后兼容）
pub async fn test_npm_registry_official() -> bool {
    check_get("https://registry.npmjs.org/-/ping").await
}

/// 测试 npm registry 可达性（保持向后兼容）
pub async fn test_npm_registry(use_mirror: bool) -> bool {
    let url = if use_mirror {
        "https://registry.npmmirror.com/-/ping"
    } else {
        "https://registry.npmjs.org/-/ping"
    };
    check_get(url).await
}

// ==========================================
// pip 镜像检测
// ==========================================

async fn test_pip_mirror_entry(entry: MirrorEntry) -> MirrorResult {
    let url = format!("{}/pip/", entry.url.trim_end_matches('/'));
    let latency = measure_get(&url).await;
    MirrorResult {
        entry: entry.clone(),
        latency,
    }
}

/// A3 Phase2: 校验 pip 源的 simple 页是否「真的能装包」。
///
/// 实测（2026-08-23）三类故障：
/// - 清华：403（Cloudflare 按 IP 限流）→ 状态码直接暴露
/// - 华为：301 → 200，但返回 CDN 的 HTML 错误页（非 simple 索引）→ pip 报
///   "No matching distribution"，仅看状态码会误判可用
/// - 正常源（阿里云/腾讯云）：200 + 含 `pypi:repository-version` 元数据
///
/// 判定：GET 成功（跟随重定向）且 body 含 simple 索引特征，两者缺一不可。
async fn verify_pip_simple_page(url: &str) -> bool {
    let Some(client) = build_client() else {
        return false;
    };
    match client.get(url).send().await {
        Ok(resp) => {
            let ok_status = resp.status().is_success() || resp.status().is_redirection();
            if !ok_status {
                return false;
            }
            match resp.text().await {
                Ok(body) => body.contains("pypi:repository-version")
                    || (body.contains(".whl") && body.contains("<a")),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

pub async fn test_all_pip_mirrors(entries: &[MirrorEntry]) -> Vec<MirrorResult> {
    let mut handles = Vec::new();
    for entry in entries {
        let entry = entry.clone();
        handles.push(tokio::spawn(test_pip_mirror_entry(entry)));
    }

    let mut results: Vec<MirrorResult> = futures_util::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(|res| res.ok())
        .collect();

    results.sort_by(|a, b| match (a.is_reachable(), b.is_reachable()) {
        (true, true) => a.latency.unwrap().cmp(&b.latency.unwrap()),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    });

    results
}

pub async fn recommend_pip_mirror(entries: &[MirrorEntry]) -> (Option<usize>, Vec<MirrorResult>) {
    // Phase1: simple 页测速（simple/pip/，reqwest 默认跟随 301 重定向，与 pip 行为一致）
    let results = test_all_pip_mirrors(entries).await;

    // Phase2（2026-08-23 A3，仿 GitHub 站点测试三步法）：
    // 对 Phase1 可达者并发校验「simple 页是否真能装包」（verify_pip_simple_page）。
    // 实测（2026-08-23）两类假可达：
    //   - 清华：403（Cloudflare 按 IP 限流）
    //   - 华为：301 → 200 但返回 CDN HTML 错误页（无 simple 索引内容），
    //     pip 报 "No matching distribution"，仅看状态码会误判可用
    // Phase1 只看状态码 + 延迟，抓不到这两类；Phase2 看 body 内容才抓得住。
    // 不增加网络往返：Phase1 已 GET 过 simple/pip/，Phase2 用其 body 判断。
    let mut handles = Vec::new();
    for r in results.iter().filter(|r| r.is_reachable()) {
        let test_url = format!("{}/pip/", r.entry.url.trim_end_matches('/'));
        let base_url = r.entry.url.clone();
        let p1_latency = r.latency.unwrap();
        handles.push(tokio::spawn(async move {
            if verify_pip_simple_page(&test_url).await {
                Some((base_url, p1_latency))
            } else {
                None
            }
        }));
    }
    let mut phase2: Vec<(String, Duration)> = Vec::new(); // (配置url, 延迟)
    for h in handles {
        if let Ok(Some(pair)) = h.await {
            phase2.push(pair);
        }
    }

    // 选中：Phase2 通过者里最快；Phase2 全挂回退 Phase1 最快（尽力而为，
    // pip_ops 多源韧性会兜底切换）。返回「配置顺序」下标（2026-08-23 索引修复保留）。
    let recommended = if phase2.is_empty() {
        results
            .iter()
            .find(|r| r.is_reachable())
            .and_then(|r| entries.iter().position(|e| e.url == r.entry.url))
    } else {
        phase2.sort_by(|a, b| a.1.cmp(&b.1));
        entries.iter().position(|e| e.url == phase2[0].0)
    };
    (recommended, results)
}

/// 测试 pip 官方源是否可达（保持向后兼容）
pub async fn test_pip_source_official() -> bool {
    check_get("https://pypi.org/simple/pip/").await
}

/// 测试 pip 源可达性（保持向后兼容）
pub async fn test_pip_source(use_mirror: bool) -> bool {
    let url = if use_mirror {
        "https://mirrors.aliyun.com/pypi/simple/pip/"
    } else {
        "https://pypi.org/simple/pip/"
    };
    check_get(url).await
}

// ==========================================
// MSVC 下载源检测
// ==========================================

/// 测试 MSVC Build Tools 官方下载源是否可达（用于环境检测页面显示）。
///
/// 注意：这里测的是「下载源是否可达」（网络连通性），
/// 不是「MSVC 是否已安装」。安装状态由 env_check.msvc（vswhere 检测）单独报告。
/// 这样拔线时即使本机已装 MSVC，下载源也会如实显示「不可达」。
///
/// 探测 vs_BuildTools.exe 引导包所在地址（HEAD 即可，不必真正下载 4MB+）。
pub async fn test_msvc_source_reachable(entries: &[MirrorEntry]) -> bool {
    if entries.is_empty() {
        return false;
    }
    let mut handles = Vec::new();
    for entry in entries {
        let entry = entry.clone();
        handles.push(tokio::spawn(async move {
            measure_head(&entry.url).await.is_some()
        }));
    }
    for h in handles {
        if let Ok(true) = h.await {
            return true;
        }
    }
    false
}

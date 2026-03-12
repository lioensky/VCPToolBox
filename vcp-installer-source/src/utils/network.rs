use crate::app::GithubMirror;
use reqwest::{Client, StatusCode};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);

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

/// 测试GitHub直连速度
pub async fn test_github_direct() -> Option<Duration> {
    measure_head("https://github.com/lioensky/VCPToolBox").await
}

/// 测试ghproxy镜像速度
pub async fn test_github_mirror() -> Option<Duration> {
    measure_get("https://ghfast.top/https://github.com/lioensky/VCPToolBox.git/info/refs?service=git-upload-pack").await
}

/// 自动推荐最佳镜像
pub async fn recommend_mirror() -> GithubMirror {
    let (direct, mirror) = tokio::join!(test_github_direct(), test_github_mirror());

    match (direct, mirror) {
        (Some(d), Some(m)) => {
            if d <= m {
                GithubMirror::Direct
            } else {
                GithubMirror::GhProxy
            }
        }
        (Some(_), None) => GithubMirror::Direct,
        (None, Some(_)) => GithubMirror::GhProxy,
        (None, None) => GithubMirror::Direct,  // 都不通时默认直连，用户可能有自己的代理
    }
}

/// 测试npm源可达性
pub async fn test_npm_registry(use_mirror: bool) -> bool {
    let url = if use_mirror {
        "https://registry.npmmirror.com/-/ping"
    } else {
        "https://registry.npmjs.org/-/ping"
    };

    check_get(url).await
}

/// 测试pip源可达性
pub async fn test_pip_source(use_mirror: bool) -> bool {
    let url = if use_mirror {
        "https://pypi.tuna.tsinghua.edu.cn/simple/pip/"
    } else {
        "https://pypi.org/simple/pip/"
    };

    check_get(url).await
}
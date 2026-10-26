//! 统一错误类型与 MinerU 错误码映射（施工图 §11）。

use std::fmt;

/// 错误处置策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorPolicy {
    /// 参数/凭证问题：不重试，错误信息直接给出修复建议。
    Fix,
    /// 服务端瞬态问题：指数退避重试（1s/2s/4s，最多 3 次）。
    Retry,
    /// 致命：不重试，携带 trace_id 与 err_msg 落盘 failed 状态。
    Fatal,
}

/// 应用统一错误类型。
#[derive(Debug)]
pub enum AppError {
    Fix(String),
    Retry(String),
    Fatal(String),
}

impl AppError {
    pub fn fix(msg: impl Into<String>) -> Self {
        AppError::Fix(msg.into())
    }

    pub fn retry(msg: impl Into<String>) -> Self {
        AppError::Retry(msg.into())
    }

    pub fn fatal(msg: impl Into<String>) -> Self {
        AppError::Fatal(msg.into())
    }

    pub fn policy(&self) -> ErrorPolicy {
        match self {
            AppError::Fix(_) => ErrorPolicy::Fix,
            AppError::Retry(_) => ErrorPolicy::Retry,
            AppError::Fatal(_) => ErrorPolicy::Fatal,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            AppError::Fix(m) | AppError::Retry(m) | AppError::Fatal(m) => m,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let tag = match self.policy() {
            ErrorPolicy::Fix => "FIX",
            ErrorPolicy::Retry => "RETRY",
            ErrorPolicy::Fatal => "FATAL",
        };
        write!(f, "[{}] {}", tag, self.message())
    }
}

// ---------------------------------------------------------------------------
// MinerU 错误码策略表
// ---------------------------------------------------------------------------

pub struct CodeInfo {
    pub policy: ErrorPolicy,
    pub description: &'static str,
}

/// 按错误码返回处置策略与中文说明；未知错误码默认按可重试处理。
pub fn classify_code(code: &str) -> CodeInfo {
    let (policy, description) = match code {
        "A0202" => (ErrorPolicy::Fix, "Token 错误，请检查 Bearer 格式"),
        "A0211" => (ErrorPolicy::Fix, "Token 已过期，请到 mineru.net 重新创建"),
        "-500" => (ErrorPolicy::Fix, "参数或 Content-Type 错误"),
        "-10001" => (ErrorPolicy::Retry, "服务异常，请稍后重试"),
        "-60002" => (ErrorPolicy::Fix, "文件格式识别失败"),
        "-60003" => (ErrorPolicy::Fix, "文件读取失败或文件已损坏"),
        "-60004" => (ErrorPolicy::Fix, "空文件"),
        "-60005" => (ErrorPolicy::Fix, "文件超过 200MB 限制"),
        "-60006" => (ErrorPolicy::Fix, "文件超过页数限制（V1 上限 200 页）"),
        "-60007" => (ErrorPolicy::Retry, "模型暂不可用，请稍后重试"),
        "-60008" => (ErrorPolicy::Fix, "URL 读取超时，请改用签名上传方式"),
        "-60009" => (ErrorPolicy::Retry, "任务队列已满，请稍后重试"),
        "-60010" => (ErrorPolicy::Fatal, "解析失败（请保留 trace_id 以便追溯）"),
        "-60011" => (ErrorPolicy::Fix, "没有有效的上传文件"),
        "-60012" => (ErrorPolicy::Fix, "找不到任务（batch_id 可能无效）"),
        "-60013" => (ErrorPolicy::Fix, "无权限"),
        "-60018" => (ErrorPolicy::Retry, "当日任务数已达上限，请明天再试"),
        _ => (ErrorPolicy::Retry, "未知错误码（默认按可重试处理）"),
    };
    CodeInfo { policy, description }
}

// ---------------------------------------------------------------------------
// Token 安全
// ---------------------------------------------------------------------------

/// Token 掩码：仅保留前 4 与后 2 个字符；过短则整体打码。
pub fn mask_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    let n = chars.len();
    if n <= 8 {
        "*".repeat(n.max(4))
    } else {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[n - 2..].iter().collect();
        format!("{}...{}", head, tail)
    }
}

/// 消息输出前的净化：将其中出现的完整 token 替换为掩码，
/// 确保凭证不出现在日志、错误信息或结果卡片中。
pub fn sanitize_message(msg: &str, token: &str) -> String {
    if token.trim().is_empty() {
        msg.to_string()
    } else {
        msg.replace(token, &mask_token(token))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_table() {
        assert_eq!(classify_code("A0202").policy, ErrorPolicy::Fix);
        assert_eq!(classify_code("A0211").policy, ErrorPolicy::Fix);
        assert_eq!(classify_code("-500").policy, ErrorPolicy::Fix);
        assert_eq!(classify_code("-10001").policy, ErrorPolicy::Retry);
        assert_eq!(classify_code("-60010").policy, ErrorPolicy::Fatal);
        assert_eq!(classify_code("-60018").policy, ErrorPolicy::Retry);
        // 未知错误码默认 RETRY
        assert_eq!(classify_code("???").policy, ErrorPolicy::Retry);
        assert!(classify_code("A0211").description.contains("过期"));
        assert!(classify_code("-60010").description.contains("trace_id"));
    }

    #[test]
    fn token_masking_and_sanitize() {
        assert_eq!(mask_token("short"), "*****");
        let t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token";
        let masked = mask_token(t);
        assert!(masked.starts_with("eyJh") && masked.ends_with("en") && masked.contains("..."));
        assert!(!masked.contains(t));

        let msg = format!("请求失败，Bearer {} 无效", t);
        let sanitized = sanitize_message(&msg, t);
        assert!(!sanitized.contains(t), "token 不得泄露");
        assert!(sanitized.contains(&mask_token(t)));
        assert_eq!(sanitize_message("无 token 信息", t), "无 token 信息");
        assert_eq!(sanitize_message("空 token", "  "), "空 token");
    }
}

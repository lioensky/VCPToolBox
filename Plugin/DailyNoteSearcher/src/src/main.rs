use chrono::{DateTime, Utc};
use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use serde::{
    de::{self, Deserializer, Unexpected},
    Deserialize, Serialize,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB
const DEFAULT_MAX_RESULTS: usize = 200;

// --- Serde Deserialization Helpers ---

fn deserialize_bool_from_string_or_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoolVisitor;
    impl<'de> de::Visitor<'de> for BoolVisitor {
        type Value = bool;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a boolean or a string representing a boolean")
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            match value.to_lowercase().as_str() {
                "true" | "1" => Ok(true),
                "false" | "0" => Ok(false),
                other => Err(de::Error::invalid_value(
                    Unexpected::Str(other),
                    &"true, false, 1, 0",
                )),
            }
        }
    }
    deserializer.deserialize_any(BoolVisitor)
}

fn deserialize_usize_from_string_or_number<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    struct UsizeVisitor;
    impl<'de> de::Visitor<'de> for UsizeVisitor {
        type Value = usize;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an unsigned integer or a string representing an unsigned integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value as usize)
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value >= 0 {
                Ok(value as usize)
            } else {
                Err(de::Error::custom("negative integer not allowed for usize"))
            }
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            value.parse::<usize>().map_err(|_| {
                de::Error::invalid_value(Unexpected::Str(value), &"an unsigned integer string")
            })
        }
    }
    deserializer.deserialize_any(UsizeVisitor)
}

fn deserialize_option_usize_from_string_or_number<'de, D>(
    deserializer: D,
) -> Result<Option<usize>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalUsizeVisitor;
    impl<'de> de::Visitor<'de> for OptionalUsizeVisitor {
        type Value = Option<usize>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str(
                "null, an unsigned integer, or a string representing an unsigned integer",
            )
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserialize_usize_from_string_or_number(deserializer).map(Some)
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(Some(value as usize))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value >= 0 {
                Ok(Some(value as usize))
            } else {
                Err(de::Error::custom("negative integer not allowed for usize"))
            }
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            trimmed.parse::<usize>().map(Some).map_err(|_| {
                de::Error::invalid_value(Unexpected::Str(value), &"an unsigned integer string")
            })
        }
    }

    deserializer.deserialize_option(OptionalUsizeVisitor)
}

#[derive(Deserialize, Debug)]
struct InputArgs {
    #[serde(default)]
    query: String,
    // 支持传入多个关键词进行 AND 匹配，避免 Rust regex 不支持 look-around (look-ahead) 的限制
    queries: Option<Vec<String>>,
    // mode=bm25 时执行日记 BM25 排序召回；默认保持原文本/正则搜索行为。
    mode: Option<String>,
    folder: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    case_sensitive: bool,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    whole_word: bool,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    is_regex: bool,
    #[serde(
        default = "default_context",
        deserialize_with = "deserialize_usize_from_string_or_number"
    )]
    context_lines: usize,
    #[serde(
        default = "default_preview_length",
        deserialize_with = "deserialize_usize_from_string_or_number"
    )]
    preview_length: usize,
    // 允许 API 调用时直接传入覆盖配置
    // root_path 可指向 dailynote/ 或 knowledge/ 等不同知识源根目录
    root_path: Option<String>,
    ignored_folders: Option<String>,
    allowed_extensions: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_usize_from_string_or_number")]
    max_results: Option<usize>,
    #[serde(default, deserialize_with = "deserialize_option_usize_from_string_or_number")]
    bm25_limit: Option<usize>,
    bm25_search_mode: Option<String>,
    query_tokens: Option<Vec<String>>,
    tag_blacklist: Option<String>,
}

fn default_context() -> usize {
    2
}
fn default_preview_length() -> usize {
    100
}

#[derive(Serialize, Debug)]
struct SearchResult {
    name: String,
    folder_name: String,
    last_modified: String,
    preview: String,
    // 包含匹配的详细行信息，供 AI 插件调用时使用
    #[serde(skip_serializing_if = "Option::is_none")]
    matches: Option<Vec<MatchLine>>,
    // 完整日记内容，供 AI 插件调用时使用
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Serialize, Debug)]
struct MatchLine {
    line_number: usize,
    line_content: String,
    context_before: Vec<String>,
    context_after: Vec<String>,
    match_column: usize,
}

#[derive(Serialize, Debug)]
struct Output {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    notes: Option<Vec<SearchResult>>,
    total: usize,
    limited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    error: Option<String>,
}

struct AppConfig {
    root_path: PathBuf,
    max_results: usize,
    ignored_folders: HashSet<String>,
    allowed_extensions: HashSet<String>,
}

impl AppConfig {
    fn new(args: &InputArgs) -> Self {
        // 1. 确定日记本根目录
        let root_str = args
            .root_path
            .clone()
            .or_else(|| env::var("DAILY_NOTE_ROOT").ok())
            .unwrap_or_else(|| "dailynote".to_string());

        let project_root = find_project_root();
        let root_path = if Path::new(&root_str).is_absolute() {
            PathBuf::from(&root_str)
        } else {
            project_root.join(&root_str)
        };

        // 2. 最大结果数
        let max_results = args
            .max_results
            .or_else(|| env::var("MAX_RESULTS").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(DEFAULT_MAX_RESULTS);

        // 3. 忽略文件夹
        let ignored_str = args
            .ignored_folders
            .clone()
            .or_else(|| env::var("IGNORED_FOLDERS").ok())
            .unwrap_or_else(|| "VectorStore,DebugLog".to_string());
        let ignored_folders = ignored_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // 4. 允许的扩展名
        // 默认同时覆盖日记与知识库常见的文本型资料格式。
        let ext_str = args
            .allowed_extensions
            .clone()
            .or_else(|| env::var("ALLOWED_EXTENSIONS").ok())
            .unwrap_or_else(|| "md,txt,json,html".to_string());
        let allowed_extensions = ext_str
            .split(',')
            .map(|s| s.trim().replace(".", ""))
            .filter(|s| !s.is_empty())
            .collect();

        AppConfig {
            root_path,
            max_results,
            ignored_folders,
            allowed_extensions,
        }
    }
}

fn find_project_root() -> PathBuf {
    if let Ok(mut path) = env::current_dir() {
        for _ in 0..5 {
            if path.join(".git").is_dir()
                || path.join("package.json").is_file()
                || path.join("Cargo.toml").is_file()
            {
                return path;
            }
            if !path.pop() {
                break;
            }
        }
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() {
    if env::args().any(|arg| arg == "--serve") {
        start_http_server();
        return;
    }

    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        print_error(format!("Failed to read stdin: {}", e));
        return;
    }

    match handle_json_request(&buffer) {
        Ok(output) => print_output(output),
        Err(message) => print_error(message),
    }
}

fn handle_json_request(buffer: &str) -> Result<Output, String> {
    let args: InputArgs = serde_json::from_str(buffer)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let config = AppConfig::new(&args);

    // 检查根目录是否存在
    if !config.root_path.exists() {
        return Err(format!(
            "Daily note root path does not exist: {:?}",
            config.root_path
        ));
    }

    handle_args(&config, &args)
}

fn handle_args(config: &AppConfig, args: &InputArgs) -> Result<Output, String> {
    if args.mode.as_deref() == Some("bm25") {
        return search_bm25(config, args).map_err(|e| format!("BM25 search failed: {}", e));
    }

    // 编译所有正则表达式。API 侧可通过 queries 传入多关键词，由 Rust 内部执行 AND 匹配，
    // 避免使用 (?=...) look-ahead，因为 Rust regex crate 不支持 look-around。
    // 搜索器可通过 root_path 切换到 knowledge/ 等其他资料根目录。
    let mut regexes = Vec::new();
    if let Some(queries) = &args.queries {
        for query in queries {
            let re = build_single_regex(query, args)
                .map_err(|e| format!("Invalid regex in queries: {}", e))?;
            regexes.push(re);
        }
    } else {
        let re = build_single_regex(&args.query, args)
            .map_err(|e| format!("Invalid regex: {}", e))?;
        regexes.push(re);
    }

    // 确定搜索子目录
    let search_root = match &args.folder {
        Some(f) => {
            let sub_path = config.root_path.join(f);
            // 安全检查：防止路径穿越
            if !is_path_safe(&sub_path, &config.root_path) {
                return Err("Path traversal detected in folder parameter".to_string());
            }
            sub_path
        }
        None => config.root_path.clone(),
    };

    let (mut results, total, limited) = search_in_directory(&search_root, &regexes, config, args)
        .map_err(|e| format!("Search failed: {}", e))?;

    // 按最后修改时间倒序排序
    results.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    let output_content = build_output_content(&results, total, limited);
    let result_payload = json!({
        "notes": results,
        "total": total,
        "limited": limited,
        "content": output_content
    });

    Ok(Output {
        status: "success".to_string(),
        result: Some(result_payload),
        notes: None,
        total,
        limited,
        content: None,
        error: None,
    })
}

fn print_output(output: Output) {
    if let Ok(json) = serde_json::to_string(&output) {
        println!("{}", json);
    }
}

fn start_http_server() {
    let host = env::var("DAILY_NOTE_SEARCHER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("DAILY_NOTE_SEARCHER_PORT").unwrap_or_else(|_| "38765".to_string());
    let address = format!("{}:{}", host, port);

    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[DailyNoteSearcher] Failed to bind HTTP server at {}: {}", address, e);
            std::process::exit(1);
        }
    };

    eprintln!("[DailyNoteSearcher] HTTP server listening on http://{}", address);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(|| {
                    if let Err(e) = handle_http_connection(stream) {
                        eprintln!("[DailyNoteSearcher] HTTP request failed: {}", e);
                    }
                });
            }
            Err(e) => eprintln!("[DailyNoteSearcher] HTTP connection error: {}", e),
        }
    }
}

fn handle_http_connection(mut stream: TcpStream) -> Result<(), String> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    let mut headers_end = None;
    let mut content_length = 0_usize;

    loop {
        let read_count = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read_count == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read_count]);

        if headers_end.is_none() {
            if let Some(pos) = find_header_end(&buffer) {
                headers_end = Some(pos);
                let headers = String::from_utf8_lossy(&buffer[..pos]);
                content_length = parse_content_length(&headers).unwrap_or(0);
            }
        }

        if let Some(pos) = headers_end {
            if buffer.len() >= pos + 4 + content_length {
                break;
            }
        }

        if buffer.len() > 128 * 1024 * 1024 {
            return Err("HTTP request exceeded 128MB".to_string());
        }
    }

    let headers_end = headers_end.ok_or_else(|| "Invalid HTTP request: missing headers".to_string())?;
    let request_line_end = buffer[..headers_end]
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(headers_end);
    let request_line = String::from_utf8_lossy(&buffer[..request_line_end]);

    if !request_line.starts_with("POST ") {
        write_http_json(&mut stream, 405, r#"{"status":"error","error":"Only POST is supported"}"#)?;
        return Ok(());
    }

    if !request_line.starts_with("POST /search ") && !request_line.starts_with("POST / ") {
        write_http_json(&mut stream, 404, r#"{"status":"error","error":"Not found"}"#)?;
        return Ok(());
    }

    let body_start = headers_end + 4;
    let body_end = body_start + content_length;
    let body = String::from_utf8_lossy(&buffer[body_start..body_end]).to_string();

    let (status_code, response_body) = match handle_json_request(&body) {
        Ok(output) => (200, serde_json::to_string(&output).unwrap_or_else(|_| r#"{"status":"error","error":"serialization failed"}"#.to_string())),
        Err(message) => {
            let output = Output {
                status: "error".to_string(),
                result: None,
                notes: None,
                total: 0,
                limited: false,
                content: None,
                error: Some(message),
            };
            (200, serde_json::to_string(&output).unwrap_or_else(|_| r#"{"status":"error","error":"serialization failed"}"#.to_string()))
        }
    };

    write_http_json(&mut stream, status_code, &response_body)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> Option<usize> {
    headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
}

fn write_http_json(stream: &mut TcpStream, status_code: u16, body: &str) -> Result<(), String> {
    let reason = match status_code {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code,
        reason,
        body.as_bytes().len(),
        body
    );
    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())
}

fn is_path_safe(target: &Path, root: &Path) -> bool {
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let target_canon = if target.exists() {
        fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf())
    } else if let Some(parent) = target.parent() {
        match fs::canonicalize(parent) {
            Ok(parent_canon) => parent_canon.join(target.file_name().unwrap_or_default()),
            Err(_) => target.to_path_buf(),
        }
    } else {
        target.to_path_buf()
    };

    if target_canon.starts_with(&root_canon) {
        return true;
    }

    // Windows 上 fs::canonicalize 可能返回 \\?\ 前缀路径，而未存在的 target fallback
    // 可能是普通绝对路径；转为字符串后去掉扩展前缀再做一次大小写不敏感判断。
    #[cfg(windows)]
    {
        let normalize = |path: &Path| {
            path.to_string_lossy()
                .replace("\\\\?\\", "")
                .replace('/', "\\")
                .to_lowercase()
        };
        let root_text = normalize(&root_canon);
        let target_text = normalize(&target_canon);
        target_text == root_text || target_text.starts_with(&(root_text + "\\"))
    }

    #[cfg(not(windows))]
    {
        false
    }
}

fn build_single_regex(query: &str, args: &InputArgs) -> Result<Regex, regex::Error> {
    let mut pattern = if args.is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    if args.whole_word {
        pattern = format!(r"\b{}\b", pattern);
    }

    let pattern = if args.case_sensitive {
        pattern
    } else {
        format!("(?i){}", pattern)
    };

    Regex::new(&pattern)
}

fn search_in_directory(
    path: &Path,
    regexes: &[Regex],
    config: &AppConfig,
    args: &InputArgs,
) -> Result<(Vec<SearchResult>, usize, bool), io::Error> {
    let mut walk_builder = WalkBuilder::new(path);
    walk_builder
        .hidden(false)
        .git_ignore(true)
        .max_filesize(Some(MAX_FILE_SIZE));

    for ignored in &config.ignored_folders {
        walk_builder.add_ignore(ignored);
    }

    let (tx, rx) = mpsc::channel();
    let regexes = regexes.to_vec();
    let root_path_buf = config.root_path.to_path_buf();
    let allowed_extensions = config.allowed_extensions.clone();
    let context_lines = args.context_lines;
    let preview_length = args.preview_length;

    walk_builder.build_parallel().run(move || {
        let tx = tx.clone();
        let regexes = regexes.clone();
        let root_path = root_path_buf.clone();
        let allowed_extensions = allowed_extensions.clone();

        Box::new(move |entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };

            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }

            let file_path = entry.path();
            if !allowed_extensions.is_empty() {
                if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) {
                    if !allowed_extensions.contains(ext) {
                        return WalkState::Continue;
                    }
                } else {
                    return WalkState::Continue;
                }
            }

            if let Ok(content) = fs::read_to_string(file_path) {
                // 检查是否包含所有匹配项（AND 逻辑）
                let all_match = regexes.iter().all(|re| re.is_match(&content));
                if all_match {
                    let metadata = fs::metadata(file_path);
                    let last_modified = metadata
                        .and_then(|m| m.modified())
                        .map(|t| {
                            let datetime: DateTime<Utc> = t.into();
                            datetime.to_rfc3339()
                        })
                        .unwrap_or_else(|_| "".to_string());

                    let file_name = file_path
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();

                    // 提取所属文件夹名称（相对于日记本根目录）
                    let relative_path = pathdiff::diff_paths(file_path, &root_path)
                        .unwrap_or_else(|| file_path.to_path_buf());

                    let folder_name = relative_path
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned().replace("\\", "/"))
                        .unwrap_or_default();

                    // 提取预览
                    let preview = content
                        .chars()
                        .take(preview_length)
                        .collect::<String>()
                        .replace("\n", " ");
                    let preview = if content.chars().count() > preview_length {
                        format!("{}...", preview)
                    } else {
                        preview
                    };

                    // 提取详细匹配行（使用第一个正则表达式提取匹配行）
                    let matches = if !regexes.is_empty() {
                        extract_matches(&content, &regexes[0], context_lines)
                    } else {
                        Vec::new()
                    };

                    let result = SearchResult {
                        name: file_name,
                        folder_name,
                        last_modified,
                        preview,
                        matches: Some(matches),
                        content: Some(content), // 返回完整日记内容
                    };

                    let _ = tx.send(result);
                }
            }
            WalkState::Continue
        })
    });

    let mut results: Vec<SearchResult> = rx.into_iter().collect();
    let total = results.len();
    let mut limited = false;

    if results.len() > config.max_results {
        results.truncate(config.max_results);
        limited = true;
    }

    Ok((results, total, limited))
}

fn extract_matches(content: &str, regex: &Regex, context_lines: usize) -> Vec<MatchLine> {
    let lines: Vec<&str> = content.lines().collect();
    let mut matches = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        if let Some(mat) = regex.find(line) {
            let context_before = if i >= context_lines {
                lines[i.saturating_sub(context_lines)..i]
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            } else {
                lines[0..i].iter().map(|s| s.to_string()).collect()
            };

            let end = std::cmp::min(i + 1 + context_lines, lines.len());
            let context_after = lines[i + 1..end].iter().map(|s| s.to_string()).collect();

            matches.push(MatchLine {
                line_number: i + 1,
                line_content: line.trim().to_string(),
                context_before,
                context_after,
                match_column: mat.start(),
            });
        }
    }

    matches
}

fn build_output_content(results: &[SearchResult], total: usize, limited: bool) -> String {
    if results.is_empty() {
        return format!("未找到匹配内容。总结果数：{}。", total);
    }

    let mut parts = Vec::new();
    parts.push(format!(
        "共找到 {} 条匹配结果{}。",
        total,
        if limited { "（已截断显示）" } else { "" }
    ));

    for (idx, note) in results.iter().enumerate() {
        parts.push(format!(
            "\n===== 结果 {} =====\n文件: {}/{}\n最后修改: {}\n预览: {}\n\n{}\n",
            idx + 1,
            note.folder_name,
            note.name,
            note.last_modified,
            note.preview,
            note.content.as_deref().unwrap_or("")
        ));
    }

    parts.join("\n")
}

#[derive(Serialize, Debug)]
struct BM25Note {
    name: String,
    folder_name: String,
    last_modified: String,
    content: String,
    score: f64,
}

fn is_bm25_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ('\u{4e00}'..='\u{9fff}').contains(&ch)
}

fn tokenize_for_bm25(text: &str, blacklist: &HashSet<String>) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let stop_words: HashSet<&str> = [
        "的", "了", "在", "是", "我", "你", "他", "她", "它", "这", "那", "有", "个", "就", "不",
        "人", "都", "一", "上", "也", "很", "到", "说", "要", "去", "能", "会", "和", "与", "或",
        "及", "吗", "呢", "啊", "吧", "被", "把", "给", "对", "从", "为", "以", "并", "但",
    ]
    .iter()
    .copied()
    .collect();

    for ch in text.to_lowercase().chars() {
        if is_bm25_token_char(ch) {
            current.push(ch);
        } else if !current.is_empty() {
            if !stop_words.contains(current.as_str()) && !blacklist.contains(&current) {
                tokens.push(current.clone());
            }
            current.clear();
        }
    }

    if !current.is_empty()
        && !stop_words.contains(current.as_str())
        && !blacklist.contains(&current)
    {
        tokens.push(current);
    }

    tokens
}

fn extract_tag_line(content: &str) -> String {
    for line in content.lines().rev() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if lower.starts_with("tags:") || trimmed.starts_with("tags：") {
            return trimmed
                .trim_start_matches("tags:")
                .trim_start_matches("tags：")
                .trim()
                .to_string();
        }
        if trimmed.starts_with("标签:") || trimmed.starts_with("标签：") {
            return trimmed
                .trim_start_matches("标签:")
                .trim_start_matches("标签：")
                .trim()
                .to_string();
        }
    }
    String::new()
}

fn extract_body_for_bm25(content: &str) -> String {
    content
        .lines()
        .skip(1)
        .filter(|line| {
            let trimmed = line.trim();
            let lower = trimmed.to_lowercase();
            !(lower.starts_with("tags:")
                || trimmed.starts_with("tags：")
                || trimmed.starts_with("标签:")
                || trimmed.starts_with("标签："))
        })
        .collect::<Vec<&str>>()
        .join("\n")
        .trim()
        .to_string()
}

fn parse_blacklist(input: Option<&String>) -> HashSet<String> {
    input
        .map(|value| {
            value
                .split(|ch| matches!(ch, ',' | '，' | '、' | '|' | '｜' | '\n' | '\r' | '\t'))
                .map(|word| word.trim().to_lowercase())
                .filter(|word| !word.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn score_bm25(
    query_tokens: &[String],
    doc_tokens: &[String],
    avg_doc_length: f64,
    idf_scores: &HashMap<String, f64>,
) -> f64 {
    if query_tokens.is_empty() || doc_tokens.is_empty() || avg_doc_length <= 0.0 {
        return 0.0;
    }

    let k1 = 1.5;
    let b = 0.75;
    let mut term_frequency: HashMap<&String, usize> = HashMap::new();
    for token in doc_tokens {
        *term_frequency.entry(token).or_insert(0) += 1;
    }

    query_tokens.iter().fold(0.0, |score, token| {
        let tf = *term_frequency.get(token).unwrap_or(&0) as f64;
        if tf <= 0.0 {
            return score;
        }

        let idf = *idf_scores.get(token).unwrap_or(&0.0);
        let numerator = tf * (k1 + 1.0);
        let denominator = tf + k1 * (1.0 - b + b * (doc_tokens.len() as f64 / avg_doc_length));
        score + idf * (numerator / denominator)
    })
}

fn search_bm25(config: &AppConfig, args: &InputArgs) -> Result<Output, io::Error> {
    let folder = args.folder.as_deref().unwrap_or("");
    let search_root = config.root_path.join(folder);
    if !is_path_safe(&search_root, &config.root_path) {
        return Ok(Output {
            status: "error".to_string(),
            result: None,
            notes: None,
            total: 0,
            limited: false,
            content: None,
            error: Some("Path traversal detected in folder parameter".to_string()),
        });
    }

    let blacklist = parse_blacklist(args.tag_blacklist.as_ref());
    let query_tokens = args
        .query_tokens
        .clone()
        .unwrap_or_else(|| tokenize_for_bm25(&args.query, &blacklist));
    let limit = args.bm25_limit.or(args.max_results).unwrap_or(10).max(1);
    let mode = args.bm25_search_mode.as_deref().unwrap_or("body");

    if query_tokens.is_empty() {
        return Ok(Output {
            status: "success".to_string(),
            result: Some(json!({
                "notes": [],
                "total": 0,
                "limited": false,
                "content": "",
                "query_tokens": query_tokens
            })),
            notes: None,
            total: 0,
            limited: false,
            content: None,
            error: None,
        });
    }

    let mut file_entries = Vec::new();
    if search_root.exists() {
        for entry in fs::read_dir(&search_root)? {
            let entry = entry?;
            let file_path = entry.path();
            if !file_path.is_file() {
                continue;
            }
            let ext = file_path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if ext != "txt" && ext != "md" {
                continue;
            }

            let metadata = fs::metadata(&file_path)?;
            let modified = metadata.modified().ok();
            let modified_ms = modified
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u128)
                .unwrap_or(0);
            let last_modified = modified
                .map(|time| {
                    let datetime: DateTime<Utc> = time.into();
                    datetime.to_rfc3339()
                })
                .unwrap_or_default();

            file_entries.push((file_path, modified_ms, last_modified));
        }
    }

    file_entries.sort_by(|a, b| b.1.cmp(&a.1));
    let limited_entries: Vec<_> = file_entries.into_iter().take(limit).collect();

    let mut candidates: Vec<(BM25Note, Vec<String>, u128)> = Vec::new();
    for (file_path, modified_ms, last_modified) in limited_entries {
        let content = fs::read_to_string(&file_path)?;
        let match_text = if mode == "body" {
            extract_body_for_bm25(&content)
        } else {
            extract_tag_line(&content)
        };
        let mut tokens = tokenize_for_bm25(&match_text, &blacklist);
        let normalized_match_text = match_text.to_lowercase();
        for query_token in &query_tokens {
            let normalized_query_token = query_token.to_lowercase();
            if !normalized_query_token.is_empty()
                && normalized_query_token.chars().any(is_bm25_token_char)
                && normalized_match_text.contains(&normalized_query_token)
            {
                tokens.push(query_token.clone());
            }
        }

        if tokens.is_empty() {
            continue;
        }

        let file_name = file_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folder_name = pathdiff::diff_paths(
            file_path.parent().unwrap_or(&search_root),
            &config.root_path,
        )
        .unwrap_or_default()
        .to_string_lossy()
        .replace("\\", "/");

        candidates.push((
            BM25Note {
                name: file_name,
                folder_name,
                last_modified,
                content,
                score: 0.0,
            },
            tokens,
            modified_ms,
        ));
    }

    if candidates.is_empty() {
        return Ok(Output {
            status: "success".to_string(),
            result: Some(json!({
                "notes": [],
                "total": 0,
                "limited": false,
                "content": "",
                "query_tokens": query_tokens
            })),
            notes: None,
            total: 0,
            limited: false,
            content: None,
            error: None,
        });
    }

    let total_docs = candidates.len() as f64;
    let avg_doc_length = candidates
        .iter()
        .map(|(_, tokens, _)| tokens.len() as f64)
        .sum::<f64>()
        / total_docs;
    let mut document_frequency: HashMap<String, usize> = HashMap::new();
    for (_, tokens, _) in &candidates {
        let unique_tokens: HashSet<String> = tokens.iter().cloned().collect();
        for token in unique_tokens {
            *document_frequency.entry(token).or_insert(0) += 1;
        }
    }

    let idf_scores: HashMap<String, f64> = document_frequency
        .into_iter()
        .map(|(token, df)| {
            let df = df as f64;
            let idf = ((total_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
            (token, idf)
        })
        .collect();

    let mut ranked_notes: Vec<(BM25Note, u128)> = candidates
        .into_iter()
        .filter_map(|(mut note, tokens, modified_ms)| {
            let score = score_bm25(&query_tokens, &tokens, avg_doc_length, &idf_scores);
            if score > 0.0 {
                note.score = score;
                Some((note, modified_ms))
            } else {
                None
            }
        })
        .collect();

    ranked_notes.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.cmp(&a.1))
    });

    let notes: Vec<BM25Note> = ranked_notes.into_iter().map(|(note, _)| note).collect();
    let total = notes.len();
    let content = notes
        .iter()
        .map(|note| note.content.as_str())
        .collect::<Vec<&str>>()
        .join("\n\n---\n\n");

    Ok(Output {
        status: "success".to_string(),
        result: Some(json!({
            "notes": notes,
            "total": total,
            "limited": false,
            "content": content,
            "query_tokens": query_tokens
        })),
        notes: None,
        total,
        limited: false,
        content: None,
        error: None,
    })
}

fn print_error(message: String) {
    let output = Output {
        status: "error".to_string(),
        result: None,
        notes: None,
        total: 0,
        limited: false,
        content: None,
        error: Some(message),
    };
    if let Ok(json) = serde_json::to_string(&output) {
        println!("{}", json);
    }
}

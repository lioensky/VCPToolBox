use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use serde::{de::{self, Deserializer, Unexpected}, Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use chrono::{DateTime, Utc};

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

#[derive(Deserialize, Debug)]
struct InputArgs {
    query: String,
    // 支持传入多个关键词进行 AND 匹配，避免 Rust regex 不支持 look-around (look-ahead) 的限制
    queries: Option<Vec<String>>,
    folder: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    case_sensitive: bool,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    whole_word: bool,
    #[serde(default, deserialize_with = "deserialize_bool_from_string_or_bool")]
    is_regex: bool,
    #[serde(default = "default_context", deserialize_with = "deserialize_usize_from_string_or_number")]
    context_lines: usize,
    #[serde(default = "default_preview_length", deserialize_with = "deserialize_usize_from_string_or_number")]
    preview_length: usize,
    // 允许 API 调用时直接传入覆盖配置
    root_path: Option<String>,
    ignored_folders: Option<String>,
    allowed_extensions: Option<String>,
    max_results: Option<usize>,
}

fn default_context() -> usize { 2 }
fn default_preview_length() -> usize { 100 }

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
        let root_str = args.root_path.clone()
            .or_else(|| env::var("DAILY_NOTE_ROOT").ok())
            .unwrap_or_else(|| "dailynote".to_string());
        
        let project_root = find_project_root();
        let root_path = if Path::new(&root_str).is_absolute() {
            PathBuf::from(&root_str)
        } else {
            project_root.join(&root_str)
        };

        // 2. 最大结果数
        let max_results = args.max_results
            .or_else(|| env::var("MAX_RESULTS").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(DEFAULT_MAX_RESULTS);

        // 3. 忽略文件夹
        let ignored_str = args.ignored_folders.clone()
            .or_else(|| env::var("IGNORED_FOLDERS").ok())
            .unwrap_or_else(|| "VectorStore,DebugLog".to_string());
        let ignored_folders = ignored_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // 4. 允许的扩展名
        let ext_str = args.allowed_extensions.clone()
            .or_else(|| env::var("ALLOWED_EXTENSIONS").ok())
            .unwrap_or_else(|| "md,txt".to_string());
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
    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        print_error(format!("Failed to read stdin: {}", e));
        return;
    }

    let args: InputArgs = match serde_json::from_str(&buffer) {
        Ok(args) => args,
        Err(e) => {
            print_error(format!("Invalid JSON: {}", e));
            return;
        }
    };

    let config = AppConfig::new(&args);

    // 检查根目录是否存在
    if !config.root_path.exists() {
        print_error(format!("Daily note root path does not exist: {:?}", config.root_path));
        return;
    }

    // 编译所有正则表达式。API 侧可通过 queries 传入多关键词，由 Rust 内部执行 AND 匹配，
    // 避免使用 (?=...) look-ahead，因为 Rust regex crate 不支持 look-around。
    let mut regexes = Vec::new();
    if let Some(queries) = &args.queries {
        for query in queries {
            match build_single_regex(query, &args) {
                Ok(re) => regexes.push(re),
                Err(e) => {
                    print_error(format!("Invalid regex in queries: {}", e));
                    return;
                }
            }
        }
    } else {
        match build_single_regex(&args.query, &args) {
            Ok(re) => regexes.push(re),
            Err(e) => {
                print_error(format!("Invalid regex: {}", e));
                return;
            }
        }
    }

    // 确定搜索子目录
    let search_root = match &args.folder {
        Some(f) => {
            let sub_path = config.root_path.join(f);
            // 安全检查：防止路径穿越
            if !is_path_safe(&sub_path, &config.root_path) {
                print_error("Path traversal detected in folder parameter".to_string());
                return;
            }
            sub_path
        }
        None => config.root_path.clone(),
    };

    match search_in_directory(&search_root, &regexes, &config, &args) {
        Ok((mut results, total, limited)) => {
            // 按最后修改时间倒序排序
            results.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

            let output_content = build_output_content(&results, total, limited);
            let result_payload = json!({
                "notes": results,
                "total": total,
                "limited": limited,
                "content": output_content
            });

            let output = Output {
                status: "success".to_string(),
                result: Some(result_payload),
                notes: None,
                total,
                limited,
                content: None,
                error: None,
            };
            if let Ok(json) = serde_json::to_string(&output) {
                println!("{}", json);
            }
        }
        Err(e) => print_error(format!("Search failed: {}", e)),
    }
}

fn is_path_safe(target: &Path, root: &Path) -> bool {
    let target_canon = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    target_canon.starts_with(root_canon)
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
    walk_builder.hidden(false).git_ignore(true).max_filesize(Some(MAX_FILE_SIZE));

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

                    let file_name = file_path.file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();

                    // 提取所属文件夹名称（相对于日记本根目录）
                    let relative_path = pathdiff::diff_paths(file_path, &root_path)
                        .unwrap_or_else(|| file_path.to_path_buf());
                    
                    let folder_name = relative_path.parent()
                        .map(|p| p.to_string_lossy().into_owned().replace("\\", "/"))
                        .unwrap_or_default();

                    // 提取预览
                    let preview = content.chars().take(preview_length).collect::<String>()
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
            let context_after = lines[i + 1..end]
                .iter()
                .map(|s| s.to_string())
                .collect();

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
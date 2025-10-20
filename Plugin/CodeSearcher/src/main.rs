use ignore::WalkBuilder;
use regex::Regex;
use serde::{de::{self, Deserializer, Unexpected}, Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB
const DEFAULT_MAX_RESULTS: usize = 100;

// --- Serde Deserialization Helpers ---

fn deserialize_bool_from_string<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    match String::deserialize(deserializer)?.to_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(de::Error::invalid_value(
            Unexpected::Str(other),
            &"a boolean string (true, false, 1, 0)",
        )),
    }
}

fn deserialize_usize_from_string<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    s.parse::<usize>().map_err(|_| {
        de::Error::invalid_value(Unexpected::Str(&s), &"an unsigned integer string")
    })
}


#[derive(Deserialize, Debug)]
struct InputArgs {
    query: String,
    search_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_from_string")]
    case_sensitive: bool,
    #[serde(default, deserialize_with = "deserialize_bool_from_string")]
    whole_word: bool,
    #[serde(default = "default_context", deserialize_with = "deserialize_usize_from_string")]
    context_lines: usize,
}

fn default_context() -> usize { 2 }

#[derive(Serialize, Debug)]
struct SearchResult {
    file_path: String,
    line_number: usize,
    line_content: String,
    context_before: Vec<String>,
    context_after: Vec<String>,
    match_column: usize,
}

#[derive(Serialize, Debug)]
struct Output {
    status: String,
    result: Option<Vec<SearchResult>>,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,  // 是否被截断
}

struct AppConfig {
    max_results: usize,
    ignored_folders: HashSet<String>,
    allowed_extensions: HashSet<String>,
}

impl AppConfig {
    fn from_env() -> Self {
        let max_results = env::var("MAX_RESULTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_MAX_RESULTS);

        let ignored_folders = env::var("IGNORED_FOLDERS")
            .unwrap_or_else(|_| "target,.git,node_modules,dist,build".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let allowed_extensions = env::var("ALLOWED_EXTENSIONS")
            .unwrap_or_else(|_| "rs,toml,md,txt,js,ts,py,java,go,yml,yaml,json".to_string())
            .split(',')
            .map(|s| s.trim().replace(".", ""))
            .filter(|s| !s.is_empty())
            .collect();

        AppConfig {
            max_results,
            ignored_folders,
            allowed_extensions,
        }
    }
}

fn find_project_root() -> PathBuf {
    // Start from the current working directory
    if let Ok(mut path) = env::current_dir() {
        for _ in 0..3 {
            if path.join("package.json").is_file() {
                return path;
            }
            if !path.pop() {
                // We've reached the root and can't go up further
                break;
            }
        }
    }
    // Fallback to "." if not found or if getting current_dir failed
    PathBuf::from(".")
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

    let config = AppConfig::from_env();
    
    let regex = match build_regex(&args) {
        Ok(re) => re,
        Err(e) => {
            print_error(format!("Invalid regex: {}", e));
            return;
        }
    };

    let base_path = match env::var("PROJECT_BASE_PATH") {
        Ok(path) => PathBuf::from(path),
        Err(_) => find_project_root(),
    };
    
    let search_root = match args.search_path.as_ref() {
        Some(p) => base_path.join(p),
        None => base_path.clone(),
    };

    match search_in_directory(&search_root, &regex, &config, &args, &base_path) {
        Ok((results, truncated)) => {
            let output = Output {
                status: "success".to_string(),
                result: Some(results),
                error: None,
                truncated: if truncated { Some(true) } else { None },
            };
            if let Ok(json) = serde_json::to_string(&output) {
                println!("{}", json);
            }
        }
        Err(e) => print_error(format!("Search failed: {}", e)),
    }
}

fn build_regex(args: &InputArgs) -> Result<Regex, regex::Error> {
    let mut pattern = args.query.clone();
    
    if args.whole_word {
        pattern = format!(r"\b{}\b", regex::escape(&pattern));
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
    query_regex: &Regex,
    config: &AppConfig,
    args: &InputArgs,
    project_base: &Path,
) -> Result<(Vec<SearchResult>, bool), io::Error> {
    let mut results = Vec::new();

    let mut walk_builder = WalkBuilder::new(path);
    walk_builder.hidden(false).git_ignore(true).max_filesize(Some(MAX_FILE_SIZE));

    for ignored in &config.ignored_folders {
        walk_builder.add_ignore(ignored);
    }

    for entry in walk_builder.build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|ft| ft.is_file()).unwrap_or(false))
    {
        let file_path = entry.path();

        // 检查扩展名
        if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) {
            if !config.allowed_extensions.is_empty() 
                && !config.allowed_extensions.contains(ext) {
                continue;
            }
        }

        // 读取并搜索
        if let Ok(content) = fs::read_to_string(file_path) {
            let file_results = search_in_content(
                &content,
                query_regex,
                file_path,
                &project_base,
                args.context_lines,
            );

            for result in file_results {
                results.push(result);
                if results.len() >= config.max_results {
                    return Ok((results, true)); // truncated = true
                }
            }
        }
    }

    Ok((results, false))
}

fn search_in_content(
    content: &str,
    regex: &Regex,
    file_path: &Path,
    project_base: &Path,
    context_lines: usize,
) -> Vec<SearchResult> {
    let lines: Vec<&str> = content.lines().collect();
    let mut results = Vec::new();
    
    let relative_path = pathdiff::diff_paths(file_path, project_base)
        .unwrap_or_else(|| file_path.to_path_buf());

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

            results.push(SearchResult {
                file_path: relative_path.to_string_lossy().into_owned(),
                line_number: i + 1,
                line_content: line.trim().to_string(),
                context_before,
                context_after,
                match_column: mat.start(),
            });
        }
    }

    results
}

fn print_error(message: String) {
    let output = Output {
        status: "error".to_string(),
        result: None,
        error: Some(message),
        truncated: None,
    };
    if let Ok(json) = serde_json::to_string(&output) {
        println!("{}", json);
    }
}
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{DirEntry, WalkBuilder, WalkState};
use regex::Regex;
use serde::de::{self, Deserializer};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB
const DEFAULT_MAX_RESULTS: usize = 50;
const HARD_MAX_RESULTS: usize = 500;
const DEFAULT_CONTEXT_LINES: usize = 2;
const MAX_CONTEXT_LINES: usize = 20;
const MAX_LINE_CHARS: usize = 300; // 单行展示上限（字符）
const LONG_LINE_LEAD_CHARS: usize = 80; // 长行截取时，匹配点之前保留的字符数
const MAX_UNSHOWN_FILES_LISTED: usize = 30;
const MAX_SAMPLES: usize = 5;
const BINARY_PROBE_BYTES: usize = 8192;
// 白名单模式下，允许无扩展名的常见构建/配置文件
const EXTENSIONLESS_ALLOWED: &[&str] = &[
    "dockerfile",
    "makefile",
    "procfile",
    "jenkinsfile",
    "vagrantfile",
    "gemfile",
    "rakefile",
];

// ---------------------------------------------------------------------------
// 参数反序列化：同时兼容字符串 ("true"/"3") 与 JSON 原生值 (true/3)；
// null 或空字符串视为"未提供"，回落默认值。
// ---------------------------------------------------------------------------

fn parse_bool_value(v: &Value) -> Result<Option<bool>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Bool(b) => Ok(Some(*b)),
        Value::Number(n) => match n.as_u64() {
            Some(0) => Ok(Some(false)),
            Some(1) => Ok(Some(true)),
            _ => Err(format!("无效的布尔值: {}", n)),
        },
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "" => Ok(None),
            "true" | "1" | "yes" => Ok(Some(true)),
            "false" | "0" | "no" => Ok(Some(false)),
            other => Err(format!("无效的布尔值: {}", other)),
        },
        other => Err(format!("无效的布尔值: {}", other)),
    }
}

fn parse_usize_value(v: &Value) -> Result<Option<usize>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_u64()
            .map(|x| Some(x as usize))
            .ok_or_else(|| format!("无效的非负整数: {}", n)),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Ok(None)
            } else {
                t.parse::<usize>()
                    .map(Some)
                    .map_err(|_| format!("无效的非负整数: {}", t))
            }
        }
        other => Err(format!("无效的非负整数: {}", other)),
    }
}

fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        other => Some(other.to_string()),
    })
}

fn de_bool_false<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let v = Value::deserialize(d)?;
    parse_bool_value(&v)
        .map(|o| o.unwrap_or(false))
        .map_err(de::Error::custom)
}

fn de_bool_true<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let v = Value::deserialize(d)?;
    parse_bool_value(&v)
        .map(|o| o.unwrap_or(true))
        .map_err(de::Error::custom)
}

fn de_context_lines<'de, D: Deserializer<'de>>(d: D) -> Result<usize, D::Error> {
    let v = Value::deserialize(d)?;
    parse_usize_value(&v)
        .map(|o| o.unwrap_or(DEFAULT_CONTEXT_LINES))
        .map_err(de::Error::custom)
}

fn de_opt_usize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<usize>, D::Error> {
    let v = Value::deserialize(d)?;
    parse_usize_value(&v).map_err(de::Error::custom)
}

fn default_context() -> usize {
    DEFAULT_CONTEXT_LINES
}
fn default_true() -> bool {
    true
}

#[derive(Deserialize, Debug)]
struct InputArgs {
    #[serde(deserialize_with = "de_string")]
    query: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    search_path: Option<String>,
    // 逗号分隔的 gitignore 风格通配符，例如 "*.rs,*.toml" 或 "src/**/*.js,!*.min.js"
    #[serde(default, deserialize_with = "de_opt_string")]
    include: Option<String>,
    #[serde(default, deserialize_with = "de_bool_false")]
    case_sensitive: bool,
    #[serde(default, deserialize_with = "de_bool_false")]
    whole_word: bool,
    #[serde(default = "default_context", deserialize_with = "de_context_lines")]
    context_lines: usize,
    // 默认按正则解析；正则非法时自动回落为字面量搜索
    #[serde(default = "default_true", deserialize_with = "de_bool_true")]
    is_regex: bool,
    #[serde(default, deserialize_with = "de_opt_usize")]
    max_results: Option<usize>,
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

struct AppConfig {
    max_results: usize,
    ignored_folders: HashSet<String>,
    allowed_extensions: HashSet<String>,
}

impl AppConfig {
    fn from_env() -> Self {
        let max_results = env::var("MAX_RESULTS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, HARD_MAX_RESULTS);

        // 统一小写存储，匹配时按目录名大小写不敏感比较（兼容 Windows）
        let ignored_folders = env::var("IGNORED_FOLDERS")
            .unwrap_or_else(|_| "target,.git,node_modules,dist,build".to_string())
            .split(',')
            .map(|s| s.trim().trim_matches(|c| c == '/' || c == '\\').to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        // 扩展名统一小写、去掉前导点；"*" 表示不限制
        let allowed_extensions = env::var("ALLOWED_EXTENSIONS")
            .unwrap_or_else(|_| "rs,toml,md,txt,js,ts,py,java,go,yml,yaml,json".to_string())
            .split(',')
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        AppConfig {
            max_results,
            ignored_folders,
            allowed_extensions,
        }
    }

    fn all_extensions_allowed(&self) -> bool {
        self.allowed_extensions.is_empty() || self.allowed_extensions.contains("*")
    }
}

// ---------------------------------------------------------------------------
// 搜索数据结构
// ---------------------------------------------------------------------------

struct LineMatch {
    line_idx: usize, // 0-based
    col: usize,      // 1-based，按字符计
    count: usize,    // 该行命中次数
}

struct FileHit {
    rel: String,
    abs: PathBuf,
    matches: Vec<LineMatch>,
}

#[derive(Default)]
struct Stats {
    scanned: AtomicUsize,
    binary: AtomicUsize,
    large: AtomicUsize,
    lossy: AtomicUsize,
    errors: AtomicUsize,
    large_samples: Mutex<Vec<String>>,
    lossy_samples: Mutex<Vec<String>>,
}

fn push_sample(m: &Mutex<Vec<String>>, s: String) {
    if let Ok(mut v) = m.lock() {
        if v.len() < MAX_SAMPLES {
            v.push(s);
        }
    }
}

enum Loaded {
    Text { text: String, lossy: bool },
    Binary,
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

fn main() {
    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        print_error(format!("读取 stdin 失败: {}", e));
        return;
    }

    let args: InputArgs = match serde_json::from_str(&buffer) {
        Ok(a) => a,
        Err(e) => {
            print_error(format!("参数解析失败: {}", e));
            return;
        }
    };

    match run(&args) {
        Ok(text) => print_success(text),
        Err(msg) => print_error(msg),
    }
}

fn run(args: &InputArgs) -> Result<String, String> {
    if args.query.is_empty() {
        return Err("query 不能为空。".to_string());
    }

    let config = AppConfig::from_env();
    let mut notices: Vec<String> = Vec::new();

    let max_results = match args.max_results {
        Some(n) if n > HARD_MAX_RESULTS => {
            notices.push(format!("max_results 超过上限，已按 {} 处理。", HARD_MAX_RESULTS));
            HARD_MAX_RESULTS
        }
        Some(0) => config.max_results,
        Some(n) => n,
        None => config.max_results,
    };

    let context_lines = if args.context_lines > MAX_CONTEXT_LINES {
        notices.push(format!("context_lines 超过上限，已按 {} 处理。", MAX_CONTEXT_LINES));
        MAX_CONTEXT_LINES
    } else {
        args.context_lines
    };

    let (regex, effective_regex, regex_notice) = build_regex(args)?;
    if let Some(n) = regex_notice {
        notices.push(n);
    }
    if regex.is_match("") {
        notices.push(
            "当前表达式可以匹配空字符串（例如末尾多了 `|`，或整体形如 `x*`），几乎每一行都会命中，请检查 query。"
                .to_string(),
        );
    }

    let base = fs::canonicalize(find_project_root())
        .map_err(|e| format!("无法定位项目根目录: {}", e))?;
    let search_root = resolve_search_root(&base, args.search_path.as_deref())?;
    if search_root.is_file() && is_sensitive(&search_root) {
        return Err("出于安全原因，不支持搜索 .env 类配置文件。".to_string());
    }
    let include = build_include(&search_root, args.include.as_deref())?;

    let (hits, stats) = search(&search_root, &regex, &config, include.as_ref(), &base);

    let filter_desc = if let Some(inc) = args.include.as_deref().filter(|_| include.is_some()) {
        format!("include {}", inline_code(inc))
    } else if config.all_extensions_allowed() {
        "全部扩展名".to_string()
    } else {
        let mut exts: Vec<&str> = config.allowed_extensions.iter().map(|s| s.as_str()).collect();
        exts.sort_unstable();
        format!("扩展名白名单 {}", inline_code(&exts.join(",")))
    };

    let mut ignored: Vec<&str> = config.ignored_folders.iter().map(|s| s.as_str()).collect();
    ignored.sort_unstable();

    let input = RenderInput {
        args,
        effective_regex,
        scope: rel_display(&search_root, &base),
        filter_desc,
        ignored_desc: ignored.join(","),
        context_lines,
        max_results,
        notices,
    };

    Ok(render(&input, &hits, &stats))
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

/// 解析 search_path：必须存在，且规范化后位于项目根目录之下。
fn resolve_search_root(base: &Path, search_path: Option<&str>) -> Result<PathBuf, String> {
    let raw = match search_path {
        Some(p) => p,
        None => return Ok(base.to_path_buf()),
    };

    let p = Path::new(raw);
    if p.is_absolute() {
        if let Ok(c) = fs::canonicalize(p) {
            if c.starts_with(base) {
                return Ok(c);
            }
        }
    }

    // 兼容 "/modules"、"./modules"、"modules\\sub" 等写法，一律按项目根目录解析
    let rel = raw.trim_start_matches(|c| c == '/' || c == '\\');
    let joined = base.join(rel);
    let canon = fs::canonicalize(&joined).map_err(|_| {
        format!(
            "search_path 不存在: {}（按项目根目录解析）。请确认路径拼写，或不传 search_path 以搜索整个项目。",
            raw
        )
    })?;
    if !canon.starts_with(base) {
        return Err(format!("search_path 超出项目根目录，已拒绝: {}", raw));
    }
    Ok(canon)
}

fn build_include(root: &Path, include: Option<&str>) -> Result<Option<Override>, String> {
    let raw = match include {
        Some(r) => r,
        None => return Ok(None),
    };
    let dir = if root.is_file() {
        root.parent().unwrap_or(root)
    } else {
        root
    };
    let mut builder = OverrideBuilder::new(dir);
    let mut count = 0;
    for g in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        builder
            .add(g)
            .map_err(|e| format!("include 通配符无效 {}: {}", inline_code(g), e))?;
        count += 1;
    }
    if count == 0 {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| format!("include 通配符无效: {}", e))
}

// ---------------------------------------------------------------------------
// 正则构建
// ---------------------------------------------------------------------------

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn compile_pattern(raw: &str, literal: bool, args: &InputArgs) -> Result<Regex, regex::Error> {
    let mut pattern = if literal {
        regex::escape(raw)
    } else {
        raw.to_string()
    };

    if args.whole_word {
        if literal {
            // 字面量：只在首/尾是单词字符的一侧加 \b，避免 `foo(` 这类片段永远匹配不到
            let pre = raw.chars().next().map_or(false, is_word_char);
            let suf = raw.chars().last().map_or(false, is_word_char);
            pattern = format!(
                "{}{}{}",
                if pre { r"\b" } else { "" },
                pattern,
                if suf { r"\b" } else { "" }
            );
        } else {
            // 正则：用非捕获组包裹，避免 `a|b` 被解析成 `\ba` 或 `b\b`
            pattern = format!(r"\b(?:{})\b", pattern);
        }
    }

    if !args.case_sensitive {
        pattern = format!("(?i){}", pattern);
    }

    Regex::new(&pattern)
}

/// 返回 (正则, 是否实际按正则解析, 提示信息)
fn build_regex(args: &InputArgs) -> Result<(Regex, bool, Option<String>), String> {
    if args.is_regex {
        match compile_pattern(&args.query, false, args) {
            Ok(re) => return Ok((re, true, None)),
            Err(e) => {
                let re = compile_pattern(&args.query, true, args)
                    .map_err(|e2| format!("无法构建搜索表达式: {}", e2))?;
                let msg = e.to_string();
                let reason = msg
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .last()
                    .unwrap_or("未知错误")
                    .to_string();
                return Ok((
                    re,
                    false,
                    Some(format!(
                        "query 不是合法的正则表达式，已自动按字面量搜索。正则错误：{}",
                        reason
                    )),
                ));
            }
        }
    }
    let re = compile_pattern(&args.query, true, args)
        .map_err(|e| format!("无法构建搜索表达式: {}", e))?;
    Ok((re, false, None))
}

// ---------------------------------------------------------------------------
// 文件过滤与读取
// ---------------------------------------------------------------------------

/// .env 类文件可能包含密钥，始终不参与搜索（*.example / *.sample / *.template 除外）
fn is_sensitive(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.ends_with(".example") || name.ends_with(".sample") || name.ends_with(".template") {
        return false;
    }
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

fn ext_allowed(path: &Path, exts: &HashSet<String>) -> bool {
    if exts.is_empty() || exts.contains("*") {
        return true;
    }
    match path.extension().and_then(|s| s.to_str()) {
        Some(e) => exts.contains(&e.to_lowercase()),
        None => path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| EXTENSIONLESS_ALLOWED.contains(&n.to_lowercase().as_str()))
            .unwrap_or(false),
    }
}

fn load_text(path: &Path) -> io::Result<Loaded> {
    let bytes = fs::read(path)?;
    let probe = &bytes[..bytes.len().min(BINARY_PROBE_BYTES)];
    if probe.contains(&0) {
        return Ok(Loaded::Binary);
    }
    let (mut text, lossy) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    };
    // 去掉 UTF-8 BOM，保证首行 ^ 锚点与列号正确
    if text.starts_with('\u{FEFF}') {
        text.remove(0);
    }
    Ok(Loaded::Text { text, lossy })
}

fn rel_display(path: &Path, base: &Path) -> String {
    let rel = match path.strip_prefix(base) {
        Ok(r) => r.to_path_buf(),
        Err(_) => pathdiff::diff_paths(path, base).unwrap_or_else(|| path.to_path_buf()),
    };
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        ".".to_string()
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

fn scan_text(text: &str, regex: &Regex) -> Vec<LineMatch> {
    let mut out = Vec::new();
    // lines() 同时处理 \n 与 \r\n，行号与编辑器一致
    for (i, line) in text.lines().enumerate() {
        let mut it = regex.find_iter(line);
        if let Some(first) = it.next() {
            let count = 1 + it.count();
            let col = line[..first.start()].chars().count() + 1;
            out.push(LineMatch {
                line_idx: i,
                col,
                count,
            });
        }
    }
    out
}

fn process_entry(
    entry: Result<DirEntry, ignore::Error>,
    tx: &mpsc::Sender<FileHit>,
    stats: &Stats,
    regex: &Regex,
    base: &Path,
    exts: &HashSet<String>,
    include: Option<&Override>,
) -> WalkState {
    let entry = match entry {
        Ok(e) => e,
        Err(_) => {
            stats.errors.fetch_add(1, Ordering::Relaxed);
            return WalkState::Continue;
        }
    };

    if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
        return WalkState::Continue;
    }

    let path = entry.path();
    if is_sensitive(path) {
        return WalkState::Continue;
    }

    // depth 0 表示 search_path 直接指向该文件：显式指定时不做扩展名/include 过滤
    if entry.depth() > 0 {
        let allowed = match include.map(|o| o.matched(path, false)) {
            Some(m) if m.is_whitelist() => true,
            Some(m) if m.is_ignore() => false,
            _ => ext_allowed(path, exts),
        };
        if !allowed {
            return WalkState::Continue;
        }
    }

    let rel = rel_display(path, base);

    if let Ok(md) = entry.metadata() {
        if md.len() > MAX_FILE_SIZE {
            stats.large.fetch_add(1, Ordering::Relaxed);
            push_sample(&stats.large_samples, rel);
            return WalkState::Continue;
        }
    }

    stats.scanned.fetch_add(1, Ordering::Relaxed);

    match load_text(path) {
        Ok(Loaded::Binary) => {
            stats.binary.fetch_add(1, Ordering::Relaxed);
        }
        Ok(Loaded::Text { text, lossy }) => {
            if lossy {
                stats.lossy.fetch_add(1, Ordering::Relaxed);
                push_sample(&stats.lossy_samples, rel.clone());
            }
            let matches = scan_text(&text, regex);
            if !matches.is_empty() {
                let _ = tx.send(FileHit {
                    rel,
                    abs: path.to_path_buf(),
                    matches,
                });
            }
        }
        Err(_) => {
            stats.errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    WalkState::Continue
}

fn search(
    root: &Path,
    regex: &Regex,
    config: &AppConfig,
    include: Option<&Override>,
    base: &Path,
) -> (Vec<FileHit>, Arc<Stats>) {
    let mut walk_builder = WalkBuilder::new(root);
    walk_builder.hidden(false).git_ignore(true);

    // 注意：WalkBuilder::add_ignore() 的参数是"忽略规则文件路径"，不是目录名。
    // 这里按目录名在任意深度剪枝；根目录（depth 0）不过滤，
    // 以便显式指定 search_path 指向被忽略目录时仍允许搜索。
    let ignored_folders = config.ignored_folders.clone();
    walk_builder.filter_entry(move |entry| {
        if entry.depth() == 0 {
            return true;
        }
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                return !ignored_folders.contains(&name.to_lowercase());
            }
        }
        true
    });

    let stats = Arc::new(Stats::default());
    let (tx, rx) = mpsc::channel::<FileHit>();

    {
        let stats = Arc::clone(&stats);
        let regex = regex.clone();
        let base = base.to_path_buf();
        let exts = config.allowed_extensions.clone();
        let include = include.cloned();

        walk_builder.build_parallel().run(move || {
            let tx = tx.clone();
            let stats = Arc::clone(&stats);
            let regex = regex.clone();
            let base = base.clone();
            let exts = exts.clone();
            let include = include.clone();
            Box::new(move |entry| {
                process_entry(entry, &tx, &stats, &regex, &base, &exts, include.as_ref())
            })
        });
    }

    let mut hits: Vec<FileHit> = rx.into_iter().collect();
    // 并行遍历顺序不稳定，统一按路径排序，保证截断结果可复现
    hits.sort_by(|a, b| {
        a.rel
            .to_lowercase()
            .cmp(&b.rel.to_lowercase())
            .then_with(|| a.rel.cmp(&b.rel))
    });

    (hits, stats)
}

// ---------------------------------------------------------------------------
// Markdown 渲染
// ---------------------------------------------------------------------------

struct RenderInput<'a> {
    args: &'a InputArgs,
    effective_regex: bool,
    scope: String,
    filter_desc: String,
    ignored_desc: String,
    context_lines: usize,
    max_results: usize,
    notices: Vec<String>,
}

fn yn(b: bool) -> &'static str {
    if b {
        "是"
    } else {
        "否"
    }
}

fn max_backtick_run(s: &str) -> usize {
    let mut max = 0;
    let mut cur = 0;
    for c in s.chars() {
        if c == '`' {
            cur += 1;
            max = max.max(cur);
        } else {
            cur = 0;
        }
    }
    max
}

fn inline_code(s: &str) -> String {
    let run = max_backtick_run(s);
    if run == 0 {
        format!("`{}`", s)
    } else {
        let ticks = "`".repeat(run + 1);
        format!("{} {} {}", ticks, s, ticks)
    }
}

fn display_query(q: &str) -> String {
    q.replace('\r', "\\r").replace('\n', "\\n")
}

fn display_line(line: &str, col: Option<usize>) -> String {
    let n = line.chars().count();
    if n <= MAX_LINE_CHARS {
        return line.to_string();
    }
    let start = match col {
        Some(c) => c
            .saturating_sub(1)
            .saturating_sub(LONG_LINE_LEAD_CHARS)
            .min(n.saturating_sub(MAX_LINE_CHARS)),
        None => 0,
    };
    let end = (start + MAX_LINE_CHARS).min(n);
    let body: String = line.chars().skip(start).take(end - start).collect();
    format!(
        "{}{}{} ⟪整行 {} 字符，仅截取第 {}-{} 字符⟫",
        if start > 0 { "…" } else { "" },
        body,
        if end < n { "…" } else { "" },
        n,
        start + 1,
        end
    )
}

fn render_file(hit: &FileHit, take: usize, context_lines: usize) -> String {
    let mut s = String::new();
    let hidden = hit.matches.len() - take;
    s.push_str(&format!("### {}\n", inline_code(&hit.rel)));
    if hidden > 0 {
        s.push_str(&format!(
            "{} 行匹配（此处展示前 {} 行，另有 {} 行未展示）\n\n",
            hit.matches.len(),
            take,
            hidden
        ));
    } else {
        s.push_str(&format!("{} 行匹配\n\n", hit.matches.len()));
    }

    let text = match load_text(&hit.abs) {
        Ok(Loaded::Text { text, .. }) => text,
        _ => {
            s.push_str("> 重新读取文件失败，无法展示内容。\n\n");
            return s;
        }
    };
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return s;
    }

    let by_line: HashMap<usize, &LineMatch> =
        hit.matches.iter().map(|m| (m.line_idx, m)).collect();

    // 合并相邻/重叠的上下文窗口，避免重复输出
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for m in &hit.matches[..take] {
        if m.line_idx >= lines.len() {
            continue;
        }
        let start = m.line_idx.saturating_sub(context_lines);
        let end = (m.line_idx + context_lines).min(lines.len() - 1);
        if let Some(last) = groups.last_mut() {
            if start <= last.1 + 1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        groups.push((start, end));
    }

    let mut rendered: Vec<String> = Vec::new();
    for (gi, (start, end)) in groups.iter().enumerate() {
        if gi > 0 {
            rendered.push("--".to_string());
        }
        for i in *start..=*end {
            let ln = i + 1;
            match by_line.get(&i) {
                Some(m) => rendered.push(format!(
                    "{}:{}:{}",
                    ln,
                    m.col,
                    display_line(lines[i], Some(m.col))
                )),
                None => rendered.push(format!("{}-{}", ln, display_line(lines[i], None))),
            }
        }
    }

    let run = rendered.iter().map(|l| max_backtick_run(l)).max().unwrap_or(0);
    let fence = "`".repeat((run + 1).max(3));
    s.push_str(&fence);
    s.push('\n');
    for l in &rendered {
        s.push_str(l);
        s.push('\n');
    }
    s.push_str(&fence);
    s.push_str("\n\n");
    s
}

fn samples_text(m: &Mutex<Vec<String>>) -> String {
    match m.lock() {
        Ok(v) if !v.is_empty() => {
            let list: Vec<String> = v.iter().map(|s| inline_code(s)).collect();
            format!("（如 {}）", list.join("、"))
        }
        _ => String::new(),
    }
}

fn render(input: &RenderInput, hits: &[FileHit], stats: &Stats) -> String {
    let args = input.args;
    let total_files = hits.len();
    let total_lines: usize = hits.iter().map(|h| h.matches.len()).sum();
    let total_occ: usize = hits
        .iter()
        .flat_map(|h| h.matches.iter())
        .map(|m| m.count)
        .sum();

    // 先渲染正文，才能知道实际展示了多少
    let mut body = String::new();
    let mut remaining = input.max_results;
    let mut shown_lines = 0;
    let mut unshown: Vec<&FileHit> = Vec::new();
    for hit in hits {
        if remaining == 0 {
            unshown.push(hit);
            continue;
        }
        let take = remaining.min(hit.matches.len());
        body.push_str(&render_file(hit, take, input.context_lines));
        remaining -= take;
        shown_lines += take;
    }

    let mode = if input.effective_regex {
        "正则"
    } else if args.is_regex {
        "字面量（正则无效，已回落）"
    } else {
        "字面量"
    };

    let mut out = String::new();
    out.push_str("## 代码搜索结果\n\n");
    out.push_str(&format!(
        "- 查询：{}（{}；区分大小写：{}；全词匹配：{}）\n",
        inline_code(&display_query(&args.query)),
        mode,
        yn(args.case_sensitive),
        yn(args.whole_word)
    ));
    out.push_str(&format!(
        "- 范围：{}；文件过滤：{}\n",
        inline_code(&input.scope),
        input.filter_desc
    ));
    out.push_str(&format!(
        "- 统计：扫描 {} 个文件，命中 {} 个文件，共 {} 行匹配（{} 处）\n",
        stats.scanned.load(Ordering::Relaxed),
        total_files,
        total_lines,
        total_occ
    ));

    if shown_lines < total_lines {
        out.push_str(&format!(
            "- ⚠️ 结果已截断：按文件路径排序后仅展示前 {} 行（max_results={}）。可缩小 search_path、用 include 限定文件类型、写更精确的 query，或提高 max_results（上限 {}）。\n",
            shown_lines, input.max_results, HARD_MAX_RESULTS
        ));
    }

    for n in &input.notices {
        out.push_str(&format!("- ⚠️ {}\n", n));
    }

    let large = stats.large.load(Ordering::Relaxed);
    let binary = stats.binary.load(Ordering::Relaxed);
    let lossy = stats.lossy.load(Ordering::Relaxed);
    let errors = stats.errors.load(Ordering::Relaxed);
    if large > 0 {
        out.push_str(&format!(
            "- 已跳过 {} 个超过 1MB 的文件{}\n",
            large,
            samples_text(&stats.large_samples)
        ));
    }
    if binary > 0 {
        out.push_str(&format!("- 已跳过 {} 个二进制或 UTF-16 编码文件\n", binary));
    }
    if lossy > 0 {
        out.push_str(&format!(
            "- {} 个非 UTF-8 文件（如 GBK）已按有损解码搜索，其中的非 ASCII 内容可能无法匹配{}\n",
            lossy,
            samples_text(&stats.lossy_samples)
        ));
    }
    if errors > 0 {
        out.push_str(&format!("- {} 个路径因权限等原因读取失败\n", errors));
    }
    out.push('\n');

    if total_lines == 0 {
        out.push_str("未找到匹配。可检查：\n");
        if input.effective_regex {
            out.push_str("- query 按正则解析，`. ( ) [ ] { } * + ? | ^ $ \\` 都是元字符；搜索含这些符号的代码片段时，请设 is_regex 为 false 或自行转义。\n");
        }
        if args.case_sensitive {
            out.push_str("- 当前区分大小写，可尝试设 case_sensitive 为 false。\n");
        }
        if args.whole_word {
            out.push_str("- 当前为全词匹配，可尝试设 whole_word 为 false。\n");
        }
        out.push_str(&format!(
            "- 搜索范围为 {}，文件过滤为 {}；已忽略目录 {}，并遵循 .gitignore。\n",
            inline_code(&input.scope),
            input.filter_desc,
            inline_code(&input.ignored_desc)
        ));
        out.push_str("- 匹配按行进行，不支持跨行、环视 `(?=` `(?!` `(?<=` `(?<!` 和反向引用 `\\1`。\n");
        return out;
    }

    out.push_str("> 格式：`行号:列号:内容` 为匹配行，`行号-内容` 为上下文行，`--` 分隔不相邻片段。行号、列号均从 1 开始，列号按字符计；内容保留原始缩进，未做 trim。\n\n");
    out.push_str(&body);

    if !unshown.is_empty() {
        out.push_str("### 其余命中文件（未展开）\n\n");
        for hit in unshown.iter().take(MAX_UNSHOWN_FILES_LISTED) {
            out.push_str(&format!(
                "- {}：{} 行\n",
                inline_code(&hit.rel),
                hit.matches.len()
            ));
        }
        if unshown.len() > MAX_UNSHOWN_FILES_LISTED {
            out.push_str(&format!(
                "- ……另有 {} 个文件\n",
                unshown.len() - MAX_UNSHOWN_FILES_LISTED
            ));
        }
        out.push('\n');
    }

    out
}

// ---------------------------------------------------------------------------
// 输出（VCP 标准：result.content[].text 承载 Markdown）
// ---------------------------------------------------------------------------

fn print_success(text: String) {
    let output = json!({
        "status": "success",
        "result": {
            "content": [ { "type": "text", "text": text } ]
        }
    });
    println!("{}", output);
}

fn print_error(message: String) {
    let output = json!({
        "status": "error",
        "error": message
    });
    println!("{}", output);
}
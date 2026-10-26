//! 输入/输出 JSON 契约与双形态反序列化。
//!
//! VCP 工具参数经 stdin 到达时，所有值可能以字符串形态出现（如 `"true"`、`"3"`），
//! 也可能是 JSON 原生值或 null；本模块统一兼容三种形态（复刻 CodeSearcher 的
//! parse_bool_value 模式）。

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;

// ---------------------------------------------------------------------------
// 双形态反序列化辅助
// ---------------------------------------------------------------------------

/// 兼容 bool / "true" / 1 / "1" / null / "" 形态；None 表示未提供。
fn parse_bool_value(v: &Value) -> Result<Option<bool>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Bool(b) => Ok(Some(*b)),
        Value::Number(n) => match n.as_i64() {
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

/// 兼容非负整数的原生值与字符串形态；None 表示未提供。
fn parse_opt_u64(v: &Value) -> Result<Option<u64>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("无效的非负整数: {}", n)),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Ok(None)
            } else {
                t.parse::<u64>()
                    .map(Some)
                    .map_err(|_| format!("无效的非负整数: {}", t))
            }
        }
        other => Err(format!("无效的非负整数: {}", other)),
    }
}

/// 字符串/数字/null → Option<String>；空字符串视为未提供。
fn parse_opt_string(v: &Value) -> Option<String> {
    match v {
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
    }
}

fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(parse_opt_string(&Value::deserialize(d)?))
}

fn de_bool_false<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    parse_bool_value(&Value::deserialize(d)?)
        .map(|o| o.unwrap_or(false))
        .map_err(de::Error::custom)
}

fn de_bool_true<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    parse_bool_value(&Value::deserialize(d)?)
        .map(|o| o.unwrap_or(true))
        .map_err(de::Error::custom)
}

fn de_opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    parse_opt_u64(&Value::deserialize(d)?).map_err(de::Error::custom)
}

/// 列表参数兼容：JSON 数组（["a","b"]）或分隔字符串（逗号/换行/分号）。
fn de_opt_string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Null => None,
        Value::Array(arr) => {
            let items: Vec<String> = arr
                .iter()
                .map(|item| match item {
                    Value::String(s) => s.trim().to_string(),
                    other => other.to_string(),
                })
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() { None } else { Some(items) }
        }
        Value::String(s) => {
            let items: Vec<String> = s
                .split(|c| c == ',' || c == '\n' || c == ';')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect();
            if items.is_empty() { None } else { Some(items) }
        }
        other => Some(vec![other.to_string()]),
    })
}

/// 字段可能为 null（如 extract_result 轮询早期），null 时回落默认值。
fn null_to_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    let v = Value::deserialize(d)?;
    if v.is_null() {
        Ok(T::default())
    } else {
        T::deserialize(v).map_err(de::Error::custom)
    }
}

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// 工具请求（stdin 输入）
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
pub struct Request {
    #[serde(deserialize_with = "de_command")]
    pub command: String,
    #[serde(default, alias = "filePath", deserialize_with = "de_opt_string")]
    pub file_path: Option<String>,
    #[serde(default, alias = "modelVersion", deserialize_with = "de_opt_string")]
    pub model_version: Option<String>,
    #[serde(default, alias = "isOcr", deserialize_with = "de_bool_false")]
    pub is_ocr: bool,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub language: Option<String>,
    #[serde(default = "default_true", alias = "enableFormula", deserialize_with = "de_bool_true")]
    pub enable_formula: bool,
    #[serde(default = "default_true", alias = "enableTable", deserialize_with = "de_bool_true")]
    pub enable_table: bool,
    #[serde(default, alias = "batchId", deserialize_with = "de_opt_string")]
    pub batch_id: Option<String>,
    #[serde(default, alias = "paperId", deserialize_with = "de_opt_string")]
    pub paper_id: Option<String>,
    /// 批量续查：多个 paper_id（数组或分隔字符串；支持 all）
    #[serde(default, alias = "paperIds", deserialize_with = "de_opt_string_list")]
    pub paper_ids: Option<Vec<String>>,
    /// 批量续查：多个 batch_id，与 paper_ids 按顺序配对（可选）
    #[serde(default, alias = "batchIds", deserialize_with = "de_opt_string_list")]
    pub batch_ids: Option<Vec<String>>,
    /// query/status/migrate：作用于全部可续查/未完成论文
    #[serde(default, alias = "queryAll", alias = "allPapers", deserialize_with = "de_bool_false")]
    pub all: bool,
    /// 显式覆盖论文标题（缺省时由 content_list 首标题推导）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    /// list/status：状态过滤（indexed/running/timeout/failed/unknown，逗号分隔或 all）
    #[serde(default, deserialize_with = "de_opt_string_list")]
    pub status: Option<Vec<String>>,
    /// list：标题 / 文件名 / paper_id / 资产目录关键词
    #[serde(default, deserialize_with = "de_opt_string")]
    pub query: Option<String>,
    /// list/status：返回条数上限（默认 20 / 50，最大 100 / 200）
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub limit: Option<u64>,
    /// list：排序方式 recent（默认）/ title / pages
    #[serde(default, deserialize_with = "de_opt_string")]
    pub sort: Option<String>,
    /// duplicates：重复分组维度 all / asset / text / title / source（逗号分隔）
    #[serde(default, alias = "groupBy", alias = "dedupeBy", deserialize_with = "de_opt_string")]
    pub group_by: Option<String>,
    /// batch/query：并发工作线程数（1-5，默认 3）
    #[serde(default, alias = "concurrency", deserialize_with = "de_opt_u64")]
    pub workers: Option<u64>,
    /// batch：递归展开目录（默认 true）
    #[serde(default = "default_true", deserialize_with = "de_bool_true")]
    pub recursive: bool,
    /// migrate：实际执行目录改名（默认 false，仅预演）
    #[serde(default, deserialize_with = "de_bool_false")]
    pub apply: bool,
    /// 公开 URL 提交（与 file_path 二选一）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub url: Option<String>,
    /// batch 命令：批量文件路径（数组或分隔字符串）
    #[serde(default, alias = "filePaths", deserialize_with = "de_opt_string_list")]
    pub file_paths: Option<Vec<String>>,
    /// batch 命令：批量公开 URL
    #[serde(default, deserialize_with = "de_opt_string_list")]
    pub urls: Option<Vec<String>>,
    /// locate 命令：检索关键词
    #[serde(default, deserialize_with = "de_opt_string")]
    pub keyword: Option<String>,
    /// read 命令：单个资产路径（可写 full.md:100-160）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub path: Option<String>,
    /// read 命令：多个资产路径（数组或换行/逗号分隔，每项可带 :行范围）
    #[serde(default, deserialize_with = "de_opt_string_list")]
    pub paths: Option<Vec<String>>,
    /// read 命令：行范围（head:N / tail:N / M-N / M:N / N / all）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub lines: Option<String>,
    /// read 命令：相对论文资产目录的 glob（如 images/*.jpg）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub glob: Option<String>,
    /// read 命令：在文本中检索关键词
    #[serde(default, deserialize_with = "de_opt_string")]
    pub find: Option<String>,
    /// read 命令：按 Markdown 章节标题读取（含子节）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub section: Option<String>,
    /// read 命令：图片选择器（序号 / page:N / caption:关键词 / 路径，数组或分隔字符串）
    #[serde(
        default,
        alias = "image",
        alias = "image_index",
        alias = "imageIndex",
        deserialize_with = "de_opt_string_list"
    )]
    pub images: Option<Vec<String>>,
    /// read 命令：按页码选图（1 起，与卡片 pN 一致）
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub page: Option<u64>,
    /// read 命令：按图注关键词选图（大小写不敏感）
    #[serde(default, deserialize_with = "de_opt_string")]
    pub caption: Option<String>,
    /// read 命令：find 命中行前后各展示的上下文行数
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub context: Option<u64>,
    /// read 命令：文本是否带行号（默认 true）
    #[serde(default = "default_true", alias = "showLine", deserialize_with = "de_bool_true")]
    pub show_line: bool,
    /// read 命令：图片是否以 base64 data URL 返回（默认 true）
    #[serde(
        default = "default_true",
        alias = "base64",
        alias = "withBase64",
        deserialize_with = "de_bool_true"
    )]
    pub with_base64: bool,
}

fn de_command<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    let s = match &v {
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if s.is_empty() {
        Err(de::Error::custom(
            "command 不能为空（可选值: parse / query / status / list / info / batch / migrate / locate / read / preflight / duplicates）",
        ))
    } else {
        Ok(s)
    }
}

impl Request {
    /// 解析模型：显式参数 > 环境变量 MODEL_VERSION > 默认 vlm。
    pub fn effective_model_version(&self) -> String {
        self.model_version
            .clone()
            .or_else(|| {
                env::var("MODEL_VERSION")
                    .ok()
                    .and_then(|s| {
                        let t = s.trim().to_string();
                        if t.is_empty() {
                            None
                        } else {
                            Some(t)
                        }
                    })
            })
            .unwrap_or_else(|| "vlm".to_string())
    }

    pub fn effective_language(&self) -> String {
        self.language.clone().unwrap_or_else(|| "en".to_string())
    }

    pub fn validate_model_version(&self) -> Result<(), String> {
        match self.effective_model_version().as_str() {
            "vlm" | "pipeline" => Ok(()),
            other => Err(format!(
                "model_version 仅支持 vlm 或 pipeline，收到: {}",
                other
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// MinerU v4 API 响应结构
// ---------------------------------------------------------------------------

/// MinerU 的 code 字段可能是数字（0 / -500）或字符串（"A0202"），统一转字符串比较。
pub fn code_to_string(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 实测线上错误信封为 {"msgCode":"A0211","msg":"...","traceId":"...","success":false}，
/// 而成功信封为 {"code":0,"data":{...},"msg":"success"}；两种形态都兼容。
#[derive(Deserialize, Debug)]
pub struct BatchApiResponse {
    #[serde(default)]
    pub code: Value,
    #[serde(default, rename = "msgCode")]
    pub msg_code: Option<Value>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default, rename = "traceId")]
    pub trace_id_camel: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub data: Option<BatchData>,
}

impl BatchApiResponse {
    /// 错误码：code 优先，缺失时回落 msgCode。
    pub fn code_string(&self) -> String {
        let c = code_to_string(&self.code);
        if !c.is_empty() {
            return c;
        }
        self.msg_code
            .as_ref()
            .map(code_to_string)
            .unwrap_or_default()
    }

    pub fn is_ok(&self) -> bool {
        if self.success == Some(false) {
            return false;
        }
        let c = self.code_string();
        if c == "0" {
            return true;
        }
        // 信封既无 code 也无 msgCode 时，以 success 布尔判定
        c.is_empty() && self.success == Some(true)
    }

    /// 追踪 ID：trace_id 与 traceId 双形态。
    pub fn trace(&self) -> Option<&str> {
        self.trace_id
            .as_deref()
            .or(self.trace_id_camel.as_deref())
    }
}

#[derive(Deserialize, Debug)]
pub struct BatchData {
    #[serde(default, deserialize_with = "null_to_default")]
    pub batch_id: Option<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    pub file_urls: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    pub extract_result: Vec<ExtractItem>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ExtractItem {
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub data_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub full_zip_url: Option<String>,
    #[serde(default)]
    pub err_msg: Option<String>,
    #[serde(default)]
    pub extract_progress: Option<ExtractProgress>,
}

/// URL 提取任务（POST /api/v4/extract/task + GET /api/v4/extract/task/{task_id}）。
/// 实测信封（2026-10-21）：成功 code:0；错误可能为 code 或 msgCode 双形态。
#[derive(Deserialize, Debug)]
pub struct ExtractTaskResponse {
    #[serde(default)]
    pub code: Value,
    #[serde(default, rename = "msgCode")]
    pub msg_code: Option<Value>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default, rename = "traceId")]
    pub trace_id_camel: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub data: Option<ExtractTaskData>,
}

impl ExtractTaskResponse {
    pub fn code_string(&self) -> String {
        let c = code_to_string(&self.code);
        if !c.is_empty() {
            return c;
        }
        self.msg_code
            .as_ref()
            .map(code_to_string)
            .unwrap_or_default()
    }

    pub fn is_ok(&self) -> bool {
        if self.success == Some(false) {
            return false;
        }
        let c = self.code_string();
        if c == "0" {
            return true;
        }
        c.is_empty() && self.success == Some(true)
    }

    pub fn trace(&self) -> Option<&str> {
        self.trace_id
            .as_deref()
            .or(self.trace_id_camel.as_deref())
    }
}

#[derive(Deserialize, Debug, Default, Clone)]
pub struct ExtractTaskData {
    #[serde(default, alias = "batch_id")]
    pub task_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub full_zip_url: Option<String>,
    #[serde(default)]
    pub err_msg: Option<String>,
    #[serde(default)]
    pub extract_progress: Option<ExtractProgress>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ExtractProgress {
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub extracted_pages: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub total_pages: Option<u64>,
}

// ---------------------------------------------------------------------------
// 结果卡片数据结构（P5 渲染为 Markdown，此处先定契约）
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct OutlineNode {
    pub level: u32,
    pub text: String,
    pub page_idx: u64,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ImageEntry {
    /// 相对资产目录的图片路径（POSIX 风格）
    pub rel: String,
    /// 可直接在气泡内渲染的 HTTP URL
    pub url: String,
    pub caption: Option<String>,
    pub page_idx: Option<u64>,
}

// ---------------------------------------------------------------------------
// 输出（stdout 仅一次 println，VCP 标准 content 数组契约）
// ---------------------------------------------------------------------------

/// 多模态 content part（OpenAI 风格）：文本或 base64 data URL 图片。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlPart },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageUrlPart {
    pub url: String,
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        ContentPart::Text { text: text.into() }
    }

    pub fn image_url(url: impl Into<String>) -> Self {
        ContentPart::ImageUrl {
            image_url: ImageUrlPart { url: url.into() },
        }
    }
}

pub fn print_error(message: String) {
    let output = json!({
        "status": "error",
        "error": message
    });
    println!("{}", output);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_dual_form_deserialization() {
        // 字符串形态
        let r: Request = serde_json::from_str(
            r#"{"command":"parse","file_path":"D:/a.pdf","is_ocr":"true","language":"ch","enable_formula":"false","enable_table":"yes"}"#,
        )
        .unwrap();
        assert_eq!(r.command, "parse");
        assert_eq!(r.file_path.as_deref(), Some("D:/a.pdf"));
        assert!(r.is_ocr);
        assert!(!r.enable_formula);
        assert!(r.enable_table);
        assert_eq!(r.effective_language(), "ch");

        // 原生值 / null / 数字形态
        let r: Request = serde_json::from_str(
            r#"{"command":"query","batch_id":12345,"paper_id":null}"#,
        )
        .unwrap();
        assert_eq!(r.batch_id.as_deref(), Some("12345"));
        assert_eq!(r.paper_id, None);

        // 未提供字段回落默认值
        let r: Request = serde_json::from_str(r#"{"command":"parse","file_path":"x.pdf"}"#).unwrap();
        assert!(!r.is_ocr);
        assert!(r.enable_formula);
        assert!(r.enable_table);
        assert_eq!(r.effective_language(), "en");
        assert_eq!(r.effective_model_version(), "vlm");

        // 非法值
        assert!(serde_json::from_str::<Request>(r#"{"command":""}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"parse","is_ocr":"maybe"}"#).is_err());

        // 批量/库查询参数：别名、数组/分隔字符串、布尔双形态
        let r: Request = serde_json::from_str(
            r#"{"command":"query","paperIds":"paper_a, paper_b","batchIds":["b1","b2"],"all":"true","workers":"4"}"#,
        )
        .unwrap();
        assert_eq!(r.paper_ids.unwrap(), vec!["paper_a", "paper_b"]);
        assert_eq!(r.batch_ids.unwrap(), vec!["b1", "b2"]);
        assert!(r.all);
        assert_eq!(r.workers, Some(4));
        let r: Request = serde_json::from_str(
            r#"{"command":"list","status":"indexed,running","query":"吸收","limit":5,"sort":"title"}"#,
        )
        .unwrap();
        assert_eq!(r.status.unwrap(), vec!["indexed", "running"]);
        assert_eq!(r.query.as_deref(), Some("吸收"));
        assert_eq!(r.limit, Some(5));
        assert_eq!(r.sort.as_deref(), Some("title"));
        let r: Request =
            serde_json::from_str(r#"{"command":"migrate","apply":"false","recursive":"false"}"#)
                .unwrap();
        assert!(!r.apply);
        assert!(!r.recursive);

        // model_version 校验
        let r: Request =
            serde_json::from_str(r#"{"command":"parse","file_path":"x.pdf","model_version":"pipeline"}"#)
                .unwrap();
        assert!(r.validate_model_version().is_ok());
        let r: Request =
            serde_json::from_str(r#"{"command":"parse","file_path":"x.pdf","model_version":"gpt"}"#)
                .unwrap();
        assert!(r.validate_model_version().is_err());
    }

    #[test]
    fn read_request_aliases_and_content_parts() {
        let r: Request = serde_json::from_str(
            r#"{"command":"read","paperId":"paper_x","lines":"10-20","image_index":"1,3","showLine":"false","base64":"true","page":4}"#,
        )
        .unwrap();
        assert_eq!(r.paper_id.as_deref(), Some("paper_x"));
        assert_eq!(r.lines.as_deref(), Some("10-20"));
        assert_eq!(r.images.unwrap(), vec!["1", "3"]);
        assert!(!r.show_line);
        assert!(r.with_base64);
        assert_eq!(r.page, Some(4));

        let parts = vec![
            ContentPart::text("hello"),
            ContentPart::image_url("data:image/png;base64,AA=="),
        ];
        let value = json!({ "content": parts });
        assert_eq!(value["content"][0]["type"], "text");
        assert_eq!(value["content"][0]["text"], "hello");
        assert_eq!(value["content"][1]["type"], "image_url");
        assert_eq!(
            value["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA=="
        );
    }

    #[test]
    fn api_code_dual_form() {        assert_eq!(code_to_string(&json!(0)), "0");
        assert_eq!(code_to_string(&json!(-500)), "-500");
        assert_eq!(code_to_string(&json!("A0202")), "A0202");
        assert_eq!(code_to_string(&json!(null)), "");

        let resp: BatchApiResponse = serde_json::from_str(
            r#"{"code":0,"data":{"batch_id":"b1","file_urls":["u"],"extract_result":null}}"#,
        )
        .unwrap();
        assert!(resp.is_ok());
        let data = resp.data.unwrap();
        assert_eq!(data.batch_id.as_deref(), Some("b1"));
        assert_eq!(data.file_urls.len(), 1);
        assert!(data.extract_result.is_empty()); // null 容忍

        let resp: BatchApiResponse =
            serde_json::from_str(r#"{"code":-10001,"msg":"busy","trace_id":"t1"}"#).unwrap();
        assert!(!resp.is_ok());
        assert_eq!(resp.code_string(), "-10001");
        assert_eq!(resp.trace(), Some("t1"));

        // 实测线上错误信封（2026-10-21）：msgCode / traceId / success
        let resp: BatchApiResponse = serde_json::from_str(
            r#"{"traceId":"fd26c3610f5c","msgCode":"A0211","msg":"user token expired","data":null,"success":false,"total":0}"#,
        )
        .unwrap();
        assert!(!resp.is_ok());
        assert_eq!(resp.code_string(), "A0211");
        assert_eq!(resp.trace(), Some("fd26c3610f5c"));
        assert_eq!(resp.msg.as_deref(), Some("user token expired"));

        // 仅 success 布尔的信封
        let resp: BatchApiResponse =
            serde_json::from_str(r#"{"success":true,"data":{"batch_id":"b"}}"#).unwrap();
        assert!(resp.is_ok());
        let resp: BatchApiResponse =
            serde_json::from_str(r#"{"success":false,"msg":"bad"}"#).unwrap();
        assert!(!resp.is_ok());
    }
}

/// main 汇总的成功输出载荷（多模态 content parts + 可选结构化 data）。
pub struct SuccessPayload {
    pub parts: Vec<ContentPart>,
    pub data: Option<Value>,
}

pub fn print_payload(payload: SuccessPayload) {
    let mut result = json!({ "content": payload.parts });
    if let Some(d) = payload.data {
        result["data"] = d;
    }
    let output = json!({
        "status": "success",
        "result": result
    });
    println!("{}", output);
}

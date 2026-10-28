//! Native HTTP ranking. Candidate bodies never need a JavaScript round trip.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
static KEY_CURSOR: AtomicUsize = AtomicUsize::new(0);
static HTTP_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
static CLIENTS: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct Ranker {
    client: Client,
    url: Url,
    keys: Vec<String>,
    model: String,
    jev: bool,
    provider: String,
    prompt: String,
    referer: String,
    title: String,
    batch_size: usize,
    concurrency: usize,
    max_tokens: usize,
    max_chars: usize,
    max_choices: usize,
    timeout: Duration,
}

fn bounded(env: &HashMap<String, String>, key: &str, default: usize, min: usize, max: usize) -> usize {
    env.get(key).and_then(|v| v.parse::<usize>().ok()).unwrap_or(default).clamp(min, max)
}

impl Ranker {
    /// Read without mutating the process environment. Process values retain dotenv's
    /// default precedence. The caller supplies a trusted plugin configuration path.
    pub(crate) fn load(path: &Path, force_jev: Option<bool>) -> Result<Self, String> {
        let mut values = HashMap::new();
        match dotenvy::from_path_iter(path) {
            Ok(entries) => {
                for entry in entries {
                    let (key, value) = entry.map_err(|_| "RERANK_INVALID_ENV")?;
                    values.insert(key, value);
                }
            }
            Err(error) if error.not_found() => {}
            Err(_) => return Err("RERANK_ENV_UNREADABLE".into()),
        }
        values.extend(std::env::vars());
        Self::from_values(&values, force_jev)
    }

    fn from_values(values: &HashMap<String, String>, force_jev: Option<bool>) -> Result<Self, String> {
        let get = |key: &str| values.get(key).map(String::as_str).unwrap_or("").trim();
        let jev = force_jev.unwrap_or_else(|| get("JevAdvancedRerank").eq_ignore_ascii_case("true"));
        let provider = get("JEV_PROVIDER").to_lowercase();
        let openrouter = provider == "openrouter";
        let raw_url = if jev {
            if !get("JEV_API_URL").is_empty() { get("JEV_API_URL") }
            else if openrouter { "https://openrouter.ai/api/alpha/decisions" }
            else { "https://api.typesafe.ai/v1/systemone" }
        } else { get("RerankUrl") };
        let mut url = Url::parse(raw_url).map_err(|_| "RERANK_INVALID_URL")?;
        if !["https", "http"].contains(&url.scheme()) || !url.username().is_empty()
            || url.password().is_some() {
            return Err("RERANK_INVALID_URL".into());
        }
        if !jev {
            url = url.join("v1/rerank").map_err(|_| "RERANK_INVALID_URL")?;
        }
        let model = if jev {
            if !get("JEV_MODEL").is_empty() { get("JEV_MODEL") }
            else if openrouter { "~typesafe/jev-latest" } else { "jev-latest" }
        } else { get("RerankModel") }.to_string();
        let raw_keys = get(if jev { "JEV_API_KEY" } else { "RerankApi" });
        let keys: Vec<String> = if jev {
            let mut seen = HashSet::new();
            raw_keys.split([',', '，', '|']).map(str::trim)
                .filter(|key| !key.is_empty() && seen.insert(*key)).map(str::to_string).collect()
        } else { vec![raw_keys.to_string()] };
        if model.is_empty() || keys.is_empty() || keys.iter().any(String::is_empty) {
            return Err("RERANK_NOT_CONFIGURED".into());
        }
        let timeout = Duration::from_millis(bounded(values, "NativeRerankTimeoutMs",
            bounded(values, "JEV_TIMEOUT_MS", 30000, 100, 300000), 100, 300000) as u64);
        let mut builder = Client::builder().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5)).timeout(timeout);
        if jev && !get("JEV_PROXY_URL").is_empty() {
            let proxy = Url::parse(get("JEV_PROXY_URL")).map_err(|_| "JEV_INVALID_PROXY_URL")?;
            if !["http", "https"].contains(&proxy.scheme()) {
                return Err("JEV_INVALID_PROXY_URL".into());
            }
            builder = builder.proxy(reqwest::Proxy::all(proxy.as_str())
                .map_err(|_| "JEV_INVALID_PROXY_URL")?);
        }
        let transport_key = format!("{}:{}", timeout.as_millis(),
            if jev { get("JEV_PROXY_URL") } else { "" });
        let client = {
            let mut clients = CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
                .lock().map_err(|_| "RERANK_CLIENT_CACHE_FAILED")?;
            if let Some(client) = clients.get(&transport_key) { client.clone() }
            else {
                let client = builder.build().map_err(|_| "RERANK_CLIENT_FAILED")?;
                if clients.len() >= 8 { clients.clear(); }
                clients.insert(transport_key, client.clone());
                client
            }
        };
        Ok(Self {
            client,
            url, keys, model, jev, provider,
            prompt: if get("JevRerankPrompt").is_empty() {
                "请选择最值得用于回答当前查询的记忆。请从逻辑关联、记忆叙事连续性、信息解释力三个层面综合判断；优先保留能直接解释当前问题、补足关键背景或维持人物与事件连续性的内容，压低仅有表面词汇重合、重复、跑题或缺乏上下文价值的内容。".into()
            } else { get("JevRerankPrompt").into() },
            referer: get("JEV_HTTP_REFERER").into(),
            title: if get("JEV_APP_TITLE").is_empty() { "VCPToolBox".into() } else { get("JEV_APP_TITLE").into() },
            batch_size: bounded(values, "RerankMaxDocumentsPerRequest", 25, 1, 25),
            concurrency: bounded(values, "RerankMaxConcurrentRequests", 3, 1, 10),
            max_tokens: bounded(values, "RerankMaxTokensPerBatch", 30000, 512, 1000000),
            max_chars: bounded(values, "JevRerankMaxDocumentChars", 6000, 200, 50000),
            max_choices: bounded(values, "JevRerankMaxChoices", 255, 2, 255),
            timeout,
        })
    }

    /// Per-query override; never mutates process configuration or another ranker.
    pub(crate) fn with_jev_prompt(mut self, prompt: Option<String>) -> Self {
        if self.jev {
            if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
                self.prompt = prompt;
            }
        }
        self
    }

    pub(crate) fn backend(&self) -> &'static str {
        if self.jev { "jev" } else { "rerank" }
    }

    async fn post(&self, body: Value) -> Result<Value, String> {
        let limit = HTTP_LIMIT.get_or_init(|| Arc::new(Semaphore::new(10))).clone();
        let _permit = limit.acquire_owned().await.map_err(|_| "RERANK_CLOSED")?;
        let key = &self.keys[KEY_CURSOR.fetch_add(1, Ordering::Relaxed) % self.keys.len()];
        let mut request = self.client.post(self.url.clone()).bearer_auth(key).json(&body);
        if self.jev && jev_long_context(&body)? {
            if !self.provider.is_empty() && self.provider != "typesafe" {
                return Err("JEV_LONG_CONTEXT_UNSUPPORTED".into());
            }
            request = request.header("TypeSafe-Danger-Zone-Long-Context", "true");
        }
        if self.jev && self.provider == "openrouter" {
            request = request.header("X-OpenRouter-Title", &self.title);
            if !self.referer.is_empty() { request = request.header("HTTP-Referer", &self.referer); }
        }
        // Do not expose URLs, response bodies, credentials or candidate text in errors.
        let mut response = request.send().await.map_err(|_| "RERANK_NETWORK_ERROR")?;
        if !response.status().is_success() {
            return Err(format!("RERANK_HTTP_{}", response.status().as_u16()));
        }
        if response.content_length().is_some_and(|size| size > RESPONSE_LIMIT as u64) {
            return Err("RERANK_RESPONSE_TOO_LARGE".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "RERANK_RESPONSE_READ")? {
            if bytes.len() + chunk.len() > RESPONSE_LIMIT { return Err("RERANK_RESPONSE_TOO_LARGE".into()); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "RERANK_INVALID_RESPONSE".into())
    }

    pub(crate) async fn rank(&self, query: &str, documents: &[Value]) -> Result<Vec<(i64, f64)>, String> {
        tokio::time::timeout(self.timeout, self.rank_inner(query, documents)).await
            .map_err(|_| "RERANK_DEADLINE".to_string())?
    }

    async fn rank_inner(&self, query: &str, documents: &[Value]) -> Result<Vec<(i64, f64)>, String> {
        if documents.len() > 2000 { return Err("RERANK_CANDIDATE_LIMIT".into()); }
        if self.jev {
            let selected = &documents[..documents.len().min(self.max_choices)];
            if selected.len() < 2 { return Ok(Vec::new()); }
            let mut criteria = serde_json::Map::new();
            for (index, doc) in selected.iter().enumerate() {
                criteria.insert(format!("doc_{index:03}"), json!(format!("候选记忆 {}\n内容:\n{}",
                    index + 1, doc["text"].as_str().unwrap_or("").chars().take(self.max_chars).collect::<String>())));
            }
            let response = self.post(json!({
                "model": self.model,
                "state": {"task":"rag_memory_rerank","query":query,"candidate_count":selected.len()},
                "questions": {"best_memory":{"type":"choice","instructions":self.prompt,"criteria":criteria}}
            })).await?;
            return parse_jev(&response, selected);
        }
        let query: String = query.chars().take(self.max_tokens / 5).collect();
        let query_tokens = estimate_tokens(&query);
        let mut batches: Vec<Vec<Value>> = Vec::new();
        let mut current = Vec::new();
        let mut tokens = query_tokens;
        for doc in documents {
            let size = estimate_tokens(doc["text"].as_str().unwrap_or(""));
            if size + query_tokens + 128 > self.max_tokens { continue; }
            if !current.is_empty() && (current.len() >= self.batch_size || tokens + size + 128 > self.max_tokens) {
                batches.push(std::mem::take(&mut current));
                tokens = query_tokens;
            }
            current.push(doc.clone());
            tokens += size;
        }
        if !current.is_empty() { batches.push(current); }
        let mut output = Vec::new();
        // Bounded concurrent waves; deadline includes semaphore queueing and all waves.
        for wave in batches.chunks(self.concurrency) {
            let mut pending = tokio::task::JoinSet::new();
            for batch in wave {
                let this = self.clone();
                let batch = batch.clone();
                let query = query.clone();
                pending.spawn(async move {
                    let texts: Vec<&str> = batch.iter().map(|doc| doc["text"].as_str().unwrap_or("")).collect();
                    let response = this.post(json!({"model":this.model,"query":query,
                        "documents":texts,"top_n":texts.len()})).await?;
                    parse_rerank(&response, &batch)
                });
            }
            while let Some(result) = pending.join_next().await {
                match result {
                    Ok(Ok(mut scores)) => output.append(&mut scores),
                    _ => return Err("RERANK_BATCH_FAILED".into()),
                }
            }
        }
        output.sort_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(output)
    }
}

fn jev_long_context(body: &Value) -> Result<bool, String> {
    // Same local cl100k estimate as JS; not an official tokenizer guarantee.
    let count = |value: Value| tiktoken_rs::cl100k_base_singleton()
        .encode_ordinary(&value.to_string()).len();
    let state = &body["state"];
    let questions = body["questions"].as_object().ok_or("JEV_INVALID_QUESTIONS")?;
    let total = count(json!({"state":state,"questions":questions}));
    let mut largest = 0;
    for (key, question) in questions {
        let single = serde_json::Map::from_iter([(key.clone(), question.clone())]);
        largest = largest.max(count(json!({"state":state,"questions":single})));
    }
    if total > 240000 || largest > 240000 {
        return Err("JEV_CONTEXT_TOO_LARGE".into());
    }
    Ok(largest > 32000 || total > 64000)
}

fn estimate_tokens(text: &str) -> usize {
    text.chars().map(|c| if ('\u{4e00}'..='\u{9fff}').contains(&c) { 6 } else { 1 }).sum::<usize>().div_ceil(4)
}

fn doc_id(doc: &Value) -> Result<i64, String> {
    doc["chunkId"].as_i64().or_else(|| doc["id"].as_i64())
        .filter(|id| *id > 0).ok_or_else(|| "RERANK_INVALID_ID".into())
}

fn parse_rerank(response: &Value, docs: &[Value]) -> Result<Vec<(i64, f64)>, String> {
    let rows = response["results"].as_array().ok_or("RERANK_INVALID_RESPONSE")?;
    let mut seen = HashSet::new();
    let mut scores = Vec::new();
    for row in rows {
        let index = row["index"].as_u64().ok_or("RERANK_INVALID_INDEX")? as usize;
        let doc = docs.get(index).ok_or("RERANK_INVALID_INDEX")?;
        let score = row["relevance_score"].as_f64().filter(|v| v.is_finite())
            .ok_or("RERANK_INVALID_SCORE")?;
        if !seen.insert(index) { return Err("RERANK_DUPLICATE_INDEX".into()); }
        scores.push((doc_id(doc)?, score));
    }
    if seen.len() != docs.len() { return Err("RERANK_INCOMPLETE_RESPONSE".into()); }
    Ok(scores)
}

fn parse_jev(response: &Value, docs: &[Value]) -> Result<Vec<(i64, f64)>, String> {
    let answer = &response["answers"]["best_memory"];
    if answer["type"] != "choice" { return Err("JEV_INVALID_RESPONSE".into()); }
    let mut scores = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        let key = format!("doc_{index:03}");
        let score = answer["probabilities"][&key].as_f64()
            .filter(|v| v.is_finite() && (0.0..=1.0).contains(v)).ok_or("JEV_INVALID_PROBABILITY")?;
        scores.push((doc_id(doc)?, score));
    }
    scores.sort_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(scores)
}

/// External RRF weight; keep this mapping aligned with RAGDiaryPlugin.
pub(crate) fn omega_rrf_alpha(omega: Option<f64>) -> f64 {
    match omega.filter(|v| v.is_finite() && (0.0..=1.0).contains(v)) {
        Some(value) => 1.0 - (0.5 + 0.8 * (value - 0.65)).clamp(0.3, 0.7),
        None => 0.5,
    }
}

/// Missing ranks contribute zero. Failed HTTP calls must not be supplied as ranks.
pub(crate) fn fuse(mut river: Vec<Value>, external: &[(i64, f64)], alpha: f64) -> Vec<Value> {
    let mut scores = external.to_vec();
    scores.sort_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let ranks: HashMap<i64, (usize, f64)> = scores.into_iter().enumerate()
        .map(|(i,(id,score))| (id,(i+1,score))).collect();
    for (index, doc) in river.iter_mut().enumerate() {
        let external = doc_id(doc).ok().and_then(|id| ranks.get(&id));
        doc["retrieval_rank"] = json!(index + 1);
        if let Some((rank, score)) = external {
            doc["rerank_rank"] = json!(rank);
            doc["rerank_score"] = json!(score);
        }
        doc["rrf_score"] = json!((1.0-alpha)/(61.0+index as f64)
            + external.map_or(0.0, |(rank,_)| alpha/(60.0+*rank as f64)));
    }
    river.sort_by(|a,b| b["rrf_score"].as_f64().unwrap_or(0.0)
        .total_cmp(&a["rrf_score"].as_f64().unwrap_or(0.0))
        .then_with(|| a["retrieval_rank"].as_u64().cmp(&b["retrieval_rank"].as_u64())));
    river
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_context_budget_checks_single_questions_and_request_total() {
        let question = |text: String| json!({"type":"noul","instructions":text});
        let body = |questions: Value| json!({"state":"query","questions":questions});
        assert!(!jev_long_context(&body(json!({"q":question("hello".into())}))).unwrap());
        assert!(jev_long_context(&body(json!({"q":question(" hello".repeat(33000))}))).unwrap());
        // Each question fits 32k, but the complete request exceeds 64k.
        assert!(jev_long_context(&body(json!({
            "a":question(" hello".repeat(22000)),
            "b":question(" hello".repeat(22000)),
            "c":question(" hello".repeat(22000))
        }))).unwrap());
        assert_eq!(jev_long_context(&body(json!({
            "q":question(" hello".repeat(241000))
        }))).unwrap_err(), "JEV_CONTEXT_TOO_LARGE");
    }
    #[tokio::test]
    async fn local_http_protocols() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for jev in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(position) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..position]).to_lowercase();
                        let length: usize = headers.lines().find_map(|line|
                            line.strip_prefix("content-length:").map(str::trim)).unwrap().parse().unwrap();
                        if bytes.len() >= position + 4 + length {
                            let body: Value = serde_json::from_slice(&bytes[position+4..]).unwrap();
                            assert!(headers.contains("authorization: bearer fixture"));
                            if jev {
                                assert_eq!(body["questions"]["best_memory"]["type"], "choice");
                            } else { assert_eq!(body["documents"].as_array().unwrap().len(), 2); }
                            break;
                        }
                    }
                }
                let body = if jev {
                    json!({"answers":{"best_memory":{"type":"choice","probabilities":{"doc_000":0.2,"doc_001":0.8}}}})
                } else {
                    json!({"results":[{"index":0,"relevance_score":0.2},{"index":1,"relevance_score":0.8}]})
                }.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            });
            let values = HashMap::from([
                ("RerankUrl".into(),format!("http://{address}/")),
                ("RerankApi".into(),"fixture".into()),
                ("RerankModel".into(),"fixture".into()),
                ("JEV_API_URL".into(),format!("http://{address}/jev")),
                ("JEV_API_KEY".into(),"fixture".into()),
            ]);
            let ranker = Ranker::from_values(&values, Some(jev)).unwrap();
            let scores = ranker.rank("query", &[
                json!({"id":1,"text":"one"}),json!({"id":2,"text":"two"})
            ]).await.unwrap();
            assert_eq!(scores[0], (2,0.8));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_errors_redirects_and_deadlines_are_not_rankings() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for status in [302, 503, 0] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let _ = socket.read(&mut bytes).await;
                if status == 0 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                } else {
                    let response = format!("HTTP/1.1 {status} Fixture\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            });
            let values = HashMap::from([
                ("RerankUrl".into(), format!("http://{address}/")),
                ("RerankApi".into(), "fixture".into()),
                ("RerankModel".into(), "fixture".into()),
                ("NativeRerankTimeoutMs".into(), "100".into()),
            ]);
            let ranker = Ranker::from_values(&values, Some(false)).unwrap();
            assert!(ranker.rank("query", &[json!({"id":1,"text":"one"})]).await.is_err());
            server.abort();
        }
    }

    #[test]
    fn prompt_override_is_local_and_preserves_legacy_default() {
        let values = HashMap::from([
            ("JEV_API_KEY".into(), "fixture".into()),
            ("JevAdvancedRerank".into(), "true".into()),
            ("JevRerankPrompt".into(), "legacy default".into()),
        ]);
        let legacy = Ranker::from_values(&values, None).unwrap();
        assert_eq!(legacy.backend(), "jev");
        let numbered = legacy.clone().with_jev_prompt(Some("preset two".into()));
        assert_eq!(numbered.prompt, "preset two");
        assert_eq!(legacy.prompt, "legacy default");
        assert_eq!(legacy.clone().with_jev_prompt(None).prompt, "legacy default");
        assert_eq!(legacy.with_jev_prompt(Some("  ".into())).prompt, "legacy default");
    }

    #[test]
    fn validates_complete_unique_external_scores() {
        let docs = vec![json!({"id":1}), json!({"id":2})];
        assert!(parse_rerank(&json!({"results":[{"index":0,"relevance_score":0.8}]}), &docs).is_err());
        assert!(parse_rerank(&json!({"results":[{"index":0,"relevance_score":0.8},{"index":0,"relevance_score":0.7}]}), &docs).is_err());
        assert!(parse_rerank(&json!({"results":[{"index":99,"relevance_score":0.8}]}), &docs).is_err());
        assert_eq!(parse_rerank(&json!({"results":[{"index":1,"relevance_score":0.8},{"index":0,"relevance_score":0.2}]}), &docs).unwrap(), vec![(2,0.8),(1,0.2)]);
    }
    #[test]
    fn missing_probability_is_not_a_zero_score() {
        assert!(parse_jev(&json!({"answers":{"best_memory":{"type":"choice","probabilities":{}}}}),
            &[json!({"id":1})]).is_err());
    }
    #[test]
    fn omega_weights_are_bounded_and_missing_values_are_neutral() {
        for (omega, expected) in [(0.0, 0.7), (0.4, 0.7), (0.65, 0.5), (0.9, 0.3), (1.0, 0.3)] {
            assert!((omega_rrf_alpha(Some(omega)) - expected).abs() < 1e-12);
        }
        for omega in [None, Some(f64::NAN), Some(f64::INFINITY), Some(-0.1), Some(1.1)] {
            assert_eq!(omega_rrf_alpha(omega), 0.5);
        }
    }

    #[test]
    fn fusion_uses_both_orders() {
        let docs = vec![json!({"id":1}),json!({"id":2})];
        assert_eq!(fuse(docs.clone(), &[(2,1.0),(1,0.0)], 1.0)[0]["id"],2);
        assert_eq!(fuse(docs, &[(2,1.0),(1,0.0)], 0.0)[0]["id"],1);
    }
}
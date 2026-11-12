//! LightMemo query data plane; no Chunk vectors cross N-API.
use crate::global_chunks::GlobalChunks;
use crate::rivermemo_topology_v3::MemoRuntime;
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Scope {
    search_all: bool,
    folders: Vec<String>,
    maid: String,
    excluded_folders: Vec<String>,
    include_music: bool,
    time_range: Option<TimeRange>,
}

#[derive(Deserialize)]
struct TimeRange { start: u32, end: u32 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    scope: Scope,
    model_sig: String,
    engine_mode: String,
    k: usize,
    #[serde(default)]
    ab_mode: bool,
    #[serde(default = "default_pool")]
    candidate_k: usize,
    #[serde(default)]
    query_tokens: Vec<String>,
    /// Semantic-group expansions, one inner list per activated group. Each group is scored as a
    /// single keyword (any member counts as a hit), so a large group cannot outweigh the query.
    #[serde(default)]
    query_token_groups: Vec<Vec<String>>,
    #[serde(default)]
    use_bm25: bool,
    #[serde(default)]
    artifact_sig: String,
    #[serde(default)]
    river_input: Value,
}

fn default_pool() -> usize { 256 }

const MAX_QUERY_TOKENS: usize = 256;
const MAX_TOKEN_GROUPS: usize = 64;
const MAX_GROUP_WORDS: usize = 4096;
const MAX_TOKEN_BYTES: usize = 1024;

/// The first reason a plan is rejected, named by field so the caller can see what to fix.
fn plan_problem(plan: &Plan, query: &[f32], dimension: usize) -> Option<String> {
    if plan.k == 0 || plan.k > 1000 { return Some(format!("k={} (1..=1000)", plan.k)); }
    if plan.candidate_k == 0 || plan.candidate_k > 2000 {
        return Some(format!("candidateK={} (1..=2000)", plan.candidate_k));
    }
    if plan.model_sig.trim().is_empty() { return Some("modelSig is empty".into()); }
    if !matches!(plan.engine_mode.as_str(), "knn" | "rivermemo") {
        return Some(format!("engineMode={} (knn|rivermemo)", plan.engine_mode));
    }
    if plan.query_tokens.len() > MAX_QUERY_TOKENS {
        return Some(format!("queryTokens={} (max {MAX_QUERY_TOKENS})", plan.query_tokens.len()));
    }
    if plan.query_token_groups.len() > MAX_TOKEN_GROUPS {
        return Some(format!("queryTokenGroups={} (max {MAX_TOKEN_GROUPS})", plan.query_token_groups.len()));
    }
    let group_words = plan.query_token_groups.iter().map(Vec::len).sum::<usize>();
    if group_words > MAX_GROUP_WORDS {
        return Some(format!("queryTokenGroups words={group_words} (max {MAX_GROUP_WORDS})"));
    }
    if plan.query_tokens.iter().chain(plan.query_token_groups.iter().flatten())
        .any(|token| token.len() > MAX_TOKEN_BYTES) {
        return Some(format!("a query token is longer than {MAX_TOKEN_BYTES} bytes"));
    }
    if query.len() != dimension { return Some(format!("query dimension={} (expected {dimension})", query.len())); }
    if query.iter().any(|v| !v.is_finite()) { return Some("query vector has a non-finite value".into()); }
    None
}

pub struct LightMemoTask {
    pub(crate) db_path: String,
    pub(crate) dimension: usize,
    pub(crate) query: Vec<f32>,
    pub(crate) plan_json: String,
    pub(crate) table: Arc<Mutex<Option<GlobalChunks>>>,
    pub(crate) runtime: Arc<MemoRuntime>,
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut aa, mut bb) = (0., 0., 0.);
    for (&a, &b) in a.iter().zip(b) {
        dot += a as f64 * b as f64;
        aa += (a as f64).powi(2);
        bb += (b as f64).powi(2);
    }
    if aa > 0. && bb > 0. { dot / (aa * bb).sqrt() } else { 0. }
}

impl Scope {
    fn admits(&self, row: &crate::global_chunks::ChunkHeader, diaries: &HashSet<String>) -> bool {
        diaries.contains(&row.diary)
            && (self.time_range.as_ref().is_none_or(|range|
                row.date != 0 && row.date >= range.start && row.date <= range.end))
            && (self.search_all || !self.folders.is_empty() || self.maid.is_empty()
                || row.first_line.contains(&self.maid))
    }

    fn diaries(&self, connection: &rusqlite::Connection) -> std::result::Result<HashSet<String>, String> {
        let mut statement = connection.prepare("SELECT DISTINCT diary_name FROM files")
            .map_err(|e| e.to_string())?;
        let names = statement.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        let mut allowed = HashSet::new();
        for name in names {
            if name.starts_with("已整理") || name.ends_with('簇')
                || self.excluded_folders.contains(&name)
                    && !(self.include_music && name == "MusicDiary") { continue; }
            // Delegate LIKE semantics (ASCII case folding and wildcards) to SQLite.
            let patterns = if self.search_all { Vec::new() }
                else if !self.folders.is_empty() { self.folders.clone() }
                else if !self.maid.is_empty() { vec![self.maid.clone()] }
                else { return Err("LIGHTMEMO_EMPTY_SCOPE".into()); };
            let mut matches = self.search_all;
            for pattern in patterns {
                matches |= connection.query_row("SELECT ?1 LIKE ?2",
                    rusqlite::params![name, format!("%{pattern}%")], |row| row.get::<_, bool>(0))
                    .map_err(|e| e.to_string())?;
            }
            if matches { allowed.insert(name); }
        }
        Ok(allowed)
    }
}

impl Task for LightMemoTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let started = std::time::Instant::now();
        let plan: Plan = serde_json::from_str(&self.plan_json)
            .map_err(|e| Error::from_reason(format!("Invalid LightMemo plan: {e}")))?;
        if let Some(problem) = plan_problem(&plan, &self.query, self.dimension) {
            return Err(Error::from_reason(format!("LIGHTMEMO_INVALID_PLAN: {problem}")));
        }
        let _gate = crate::publication_gate::acquire_read(&self.db_path, &["*".into()])
            .map_err(Error::from_reason)?;
        let mut resident = self.table.lock()
            .map_err(|_| Error::from_reason("Global Chunk table lock poisoned"))?;
        let directory = std::path::Path::new(&self.db_path).parent().unwrap();
        let mut output = crate::storage::with_registered_read_transaction(
            &self.db_path, |connection| {
                let generation = crate::storage::read_generation(connection)?;
                if resident.as_ref().is_some_and(|table|
                    !table.matches_model(self.dimension, &plan.model_sig)) {
                    *resident = None;
                }
                if resident.is_none() {
                    *resident = Some(GlobalChunks::load(connection, directory,
                        self.dimension, &plan.model_sig)?);
                }
                let table = resident.as_mut().unwrap();
                let synchronized = table.synchronize(connection)?;
                table.compact_if_needed(connection)?;
                let diaries = plan.scope.diaries(connection)?;
                let allowed = table.rows.values().filter(|row| plan.scope.admits(row, &diaries))
                    .map(|row| row.id).collect::<HashSet<_>>();
                let ids = table.search(&self.query, plan.candidate_k.max(plan.k), &allowed)?;
                let vectors = crate::storage::load_vectors_by_ids(connection, "chunks", &ids, self.dimension)?;
                let mut candidates = ids.into_iter().filter_map(|id| {
                    vectors.get(&id).map(|vector| json!({
                        "id":id,"label":id,"chunkId":id,"vectorScore":cosine(&self.query, vector),
                        "bm25Score":0.0
                    }))
                }).collect::<Vec<_>>();
                candidates.sort_by(|a,b| b["vectorScore"].as_f64().unwrap()
                    .total_cmp(&a["vectorScore"].as_f64().unwrap())
                    .then(a["id"].as_i64().cmp(&b["id"].as_i64())));
                let mut hydrate = connection.prepare(
                    "SELECT c.content,f.path,f.diary_name,c.file_id FROM chunks c
                     JOIN files f ON f.id=c.file_id WHERE c.id=?1"
                ).map_err(|e| e.to_string())?;
                // Bounded candidate text only, never the full corpus.
                for candidate in &mut candidates {
                    let id = candidate["id"].as_i64().unwrap();
                    let row: Option<(String,String,String,i64)> = hydrate.query_row([id],
                        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
                        .optional().map_err(|e| e.to_string())?;
                    if let Some((text,path,diary,file_id)) = row {
                        candidate["text"] = json!(text);
                        candidate["sourceFile"] = json!(path);
                        candidate["dbName"] = json!(diary);
                        candidate["fileId"] = json!(file_id);
                    }
                    candidate["score"] = candidate["vectorScore"].clone();
                    candidate["hybridScore"] = candidate["vectorScore"].clone();
                    candidate["retrievalEngine"] = json!("tdb");
                }
                if plan.use_bm25 && (!plan.query_tokens.is_empty() || !plan.query_token_groups.is_empty()) {
                    score_keywords(&mut candidates, &plan.query_tokens, &plan.query_token_groups);
                }
                // A/B uses exactly this bounded pool; baseline remains pure cosine.
                let tdb = candidates.iter().take(plan.k).cloned().collect::<Vec<_>>();
                let mut river = Value::Null;
                if (plan.engine_mode == "rivermemo" || plan.ab_mode) && !candidates.is_empty() {
                    let mut input = plan.river_input.clone();
                    if !input.is_object() || plan.artifact_sig.is_empty()
                        || !input["observationHandle"].is_string() {
                        return Err("LIGHTMEMO_RIVER_OBSERVATION_UNAVAILABLE".into());
                    }
                    input["includeTrace"] = json!(plan.ab_mode);
                    input["dimension"] = json!(self.dimension);
                    input["topK"] = json!(if plan.ab_mode { candidates.len() } else { plan.k });
                    input["candidates"] = json!(candidates);
                    input["allowedFileIds"] = json!(candidates.iter()
                        .filter_map(|c| c["fileId"].as_i64()).collect::<HashSet<_>>());
                    river = serde_json::from_str(&crate::rivermemo_topology_v3::run_native_with_connection(
                        &self.runtime, connection, &plan.artifact_sig, &input.to_string(),
                    )?).map_err(|e| e.to_string())?;
                    if plan.ab_mode {
                        // Export a bounded read-only view of this exact observation, never
                        // truncate the graph used by propagation or topology scoring.
                        let cached = self.runtime.get_query_observation(
                            input["observationHandle"].as_str().unwrap(), &plan.artifact_sig)?;
                        let observation = &cached.observation;
                        let nodes = observation.nodes.iter().take(128).collect::<Vec<_>>();
                        let node_ids = nodes.iter().map(|node| node.id).collect::<HashSet<_>>();
                        let edges = observation.edges.iter()
                            .filter(|edge| node_ids.contains(&edge.source_id)
                                && node_ids.contains(&edge.target_id))
                            .take(256).collect::<Vec<_>>();
                        let mut names = connection.prepare("SELECT name FROM tags WHERE id=?1")
                            .map_err(|e| e.to_string())?;
                        let nodes = nodes.iter().map(|node| {
                            let mut value = serde_json::to_value(node).map_err(|e| e.to_string())?;
                            let name: Option<String> = names.query_row([node.id], |row| row.get(0))
                                .optional().map_err(|e| e.to_string())?;
                            value["name"] = json!(name);
                            Ok(value)
                        }).collect::<std::result::Result<Vec<Value>, String>>()?;
                        river["queryRiverGraph"] = json!({
                            "nodes": nodes, "edges": edges,
                            "totalNodes": observation.nodes.len(),
                            "totalEdges": observation.edges.len(),
                            "truncated": nodes.len() < observation.nodes.len()
                                || edges.len() < observation.edges.len(),
                            "diagnostics": observation.diagnostics
                        });
                        river["requestedParameters"] = input["config"].clone();
                    }
                    let originals = candidates.iter().map(|c| (c["id"].as_i64().unwrap(), c))
                        .collect::<std::collections::HashMap<_,_>>();
                    if let Some(results) = river["results"].as_array_mut() {
                        for item in results {
                            let id = item["chunkId"].as_i64().ok_or("Invalid River Chunk identity")?;
                            let original = originals.get(&id).ok_or("River candidate escaped LightMemo scope")?;
                            for key in ["text","sourceFile","dbName","fileId","label","vectorScore"] {
                                item[key] = original[key].clone();
                            }
                            item["hybridScore"] = item["score"].clone();
                            item["riverMemo"] = json!({
                                "omega":item["omega"],"role":item["role"],
                                "regime":item["riverRegime"],"topologyBonus":item["topologyBonus"],
                                "anchorBonus":item["anchorBonus"]
                            });
                        }
                    }
                    if plan.ab_mode {
                        river["candidateDiagnostics"] = river["results"].clone();
                        if let Some(results) = river["results"].as_array_mut() {
                            results.truncate(plan.k);
                        }
                        river["diagnostics"]["returnedCandidates"] = json!(
                            river["results"].as_array().map_or(0, Vec::len));
                    }
                }
                let results = if plan.engine_mode == "rivermemo" {
                    river["results"].as_array().cloned().unwrap_or_default()
                } else { tdb.clone() };
                Ok(json!({
                    "schema":"vcp-lightmemo-result-v1","results":results,
                    "tdbTopK":tdb,"river":river,
                    "comparisonPool":if plan.ab_mode { candidates } else { Vec::new() },
                    "diagnostics":{"scopeChunks":allowed.len(),"candidateCount":vectors.len(),
                        "synchronizedRows":synchronized,"databaseGeneration":generation,
                        "bm25Mode":"candidate-substring-tf-v1","bm25Groups":plan.query_token_groups.len(),
                        "ffiTrips":1}
                }))
            },
        ).map_err(Error::from_reason)?;
        // Queries only synchronize memory routing. Snapshot publication belongs
        // to the independently scheduled, policy-gated checkpoint task.
        resident.as_mut().unwrap().last_used = std::time::Instant::now();
        output["diagnostics"]["totalMs"] = json!(started.elapsed().as_secs_f64()*1000.);
        Ok(output.to_string())
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
}

pub struct GlobalChunkCheckpointTask {
    pub(crate) db_path: String,
    pub(crate) dimension: usize,
    pub(crate) model: String,
    pub(crate) threshold: f64,
    pub(crate) allow_initial: bool,
    pub(crate) table: Arc<Mutex<Option<GlobalChunks>>>,
}

impl Task for GlobalChunkCheckpointTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let _gate = crate::publication_gate::acquire_read(&self.db_path, &["*".into()])
            .map_err(Error::from_reason)?;
        let mut resident = self.table.lock()
            .map_err(|_| Error::from_reason("Global Chunk table lock poisoned"))?;
        // Do not rebuild an evicted table just to persist it.
        let Some(table) = resident.as_mut() else {
            return Ok(json!({"published":false,"factsCommitted":false}).to_string());
        };
        if !table.matches_model(self.dimension, &self.model) {
            return Err(Error::from_reason("Global Chunk checkpoint model mismatch"));
        }
        let last_used = table.last_used;
        let synchronized = crate::storage::with_registered_read_transaction(&self.db_path, |connection| {
            let generation = crate::storage::read_generation(connection)?;
            table.synchronize(connection)?;
            table.compact_if_needed(connection)?;
            Ok(generation)
        });
        // Background checkpoint work is not retrieval activity, including
        // failed synchronization and memory compaction.
        table.last_used = last_used;
        let generation = synchronized.map_err(Error::from_reason)?;
        let directory = std::path::Path::new(&self.db_path).parent()
            .ok_or_else(|| Error::from_reason("Invalid global Chunk database directory"))?;
        let published = table.checkpoint(&self.db_path, directory, generation,
            self.threshold, self.allow_initial).map_err(Error::from_reason)?;
        Ok(json!({"published":published,"factsCommitted":false}).to_string())
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
}

/// Transitional bounded lexical evidence, not an independent global BM25 recall route.
/// Candidate-local BM25 over substring term frequency. Each plain token is one term. Each group is
/// also one term whose frequency is the sum over its members, with one idf from the documents that
/// contain any member (like Lucene's SynonymQuery): a 285-word group adds as much as one keyword,
/// not 285 keywords. Members that are already plain tokens are left to the plain term.
fn score_keywords(candidates: &mut [Value], tokens: &[String], groups: &[Vec<String>]) {
    let texts = candidates.iter().map(|c| c["text"].as_str().unwrap_or("").to_lowercase())
        .collect::<Vec<_>>();
    let lengths = texts.iter().map(|t| t.chars().count().max(1) as f64).collect::<Vec<_>>();
    let avg = lengths.iter().sum::<f64>() / lengths.len().max(1) as f64;
    let mut scores = vec![0.; texts.len()];
    let mut add_term = |frequencies: Vec<f64>| {
        let df = frequencies.iter().filter(|&&tf| tf > 0.).count() as f64;
        let idf = ((texts.len() as f64-df+0.5)/(df+0.5)+1.).ln();
        for (i, tf) in frequencies.into_iter().enumerate() {
            if tf > 0. { scores[i] += idf*tf*2.5/(tf+1.5*(0.25+0.75*lengths[i]/avg)); }
        }
    };
    let plain = tokens.iter().filter(|t| !t.is_empty()).collect::<HashSet<_>>();
    for token in &plain {
        add_term(texts.iter().map(|text| text.matches(token.as_str()).count() as f64).collect());
    }
    for group in groups {
        let members = group.iter().map(|word| word.to_lowercase())
            .filter(|word| !word.is_empty() && !plain.contains(word))
            .collect::<HashSet<_>>();
        if members.is_empty() { continue; }
        add_term(texts.iter().map(|text| members.iter()
            .map(|word| text.matches(word.as_str()).count() as f64).sum()).collect());
    }
    for (candidate, score) in candidates.iter_mut().zip(scores) {
        candidate["bm25Score"] = json!(score);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(list: &[&str]) -> Vec<Value> {
        list.iter().map(|text| json!({ "text": text })).collect()
    }

    fn scores(candidates: &[Value]) -> Vec<f64> {
        candidates.iter().map(|c| c["bm25Score"].as_f64().unwrap()).collect()
    }

    #[test]
    fn a_large_semantic_group_counts_as_one_keyword() {
        let mut slang = vec!["wireguard", "vps", "cn2", "gia", "bgp", "回程", "落地", "中转", "节点", "探针"]
            .into_iter().map(String::from).collect::<Vec<_>>();
        slang.extend((0..275).map(|i| format!("黑话{i}")));
        let mut candidates = texts(&[
            "把 WireGuard 隧道改到 10.8.2 网段，组网后三台机器互通。",
            "这台机器 cn2 gia 回程不错，落地机房 bgp，中转节点换了，探针装好。",
            "周末整理书架，顺手把 vps 账单续了。",
            "读书笔记，天气晴。",
        ]);
        let query = ["wireguard", "10.8.2", "组网"].map(String::from);
        score_keywords(&mut candidates, &query, &[slang.clone()]);
        let grouped = scores(&candidates);
        assert!(grouped[0] > grouped[1], "the note with the query words stays first: {grouped:?}");
        assert!(grouped[1] > 0. && grouped[2] > 0., "group members still count: {grouped:?}");
        assert_eq!(grouped[3], 0.);

        // The old way, every member as its own keyword: the slang-heavy note wins.
        let mut flat = texts(&[
            "把 WireGuard 隧道改到 10.8.2 网段，组网后三台机器互通。",
            "这台机器 cn2 gia 回程不错，落地机房 bgp，中转节点换了，探针装好。",
            "周末整理书架，顺手把 vps 账单续了。",
            "读书笔记，天气晴。",
        ]);
        let all = query.iter().cloned().chain(slang).collect::<Vec<_>>();
        score_keywords(&mut flat, &all, &[]);
        let flat = scores(&flat);
        assert!(flat[1] > flat[0], "baseline check: flat expansion lets the group dominate: {flat:?}");
    }

    #[test]
    fn plain_tokens_score_as_before_and_groups_do_not_double_count_them() {
        let mut before = texts(&["alpha beta beta", "gamma"]);
        let mut after = before.clone();
        let tokens = ["beta", "gamma"].map(String::from);
        score_keywords(&mut before, &tokens, &[]);
        // a group whose only other member is absent adds nothing; its copy of "beta" is the plain term
        score_keywords(&mut after, &tokens, &[vec!["beta".into(), "delta".into()]]);
        assert_eq!(scores(&before), scores(&after));
    }

    #[test]
    fn a_plan_with_a_285_word_group_runs_end_to_end() {
        let root = std::env::temp_dir().join(format!("lightmemo-groups-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES
                (1,'a.txt','运维日记','a',0,0);").map_err(|e|e.to_string())?;
            for (id, text) in [
                (1, "把 WireGuard 隧道改到 10.8.2 网段，组网后三台机器互通。"),
                (2, "这台机器 cn2 gia 回程不错，落地机房 bgp，中转节点换了，探针装好。"),
                (3, "周末整理书架，顺手把 vps 账单续了。"),
                (4, "读书笔记，天气晴。"),
            ] {
                let bytes = [1_f32, 0.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
                tx.execute("INSERT INTO chunks(id,file_id,chunk_index,content,vector)
                    VALUES (?1,1,0,?2,?3)", rusqlite::params![id, text, bytes]).map_err(|e|e.to_string())?;
            }
            Ok(crate::storage::WriteReceipt{
                operation:"fixture".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        let mut slang = vec!["vps", "cn2", "gia", "bgp", "回程", "落地", "中转", "节点", "探针"]
            .into_iter().map(String::from).collect::<Vec<_>>();
        slang.extend((0..276).map(|i| format!("黑话{i}")));
        let mut task = LightMemoTask {
            db_path: db.clone(), dimension: 2, query: vec![1., 0.], plan_json: json!({
                "scope": {"searchAll": true}, "modelSig": "test", "engineMode": "knn", "k": 4, "candidateK": 4,
                "useBm25": true, "queryTokens": ["wireguard", "10.8.2", "组网"], "queryTokenGroups": [slang],
            }).to_string(), table: Arc::new(Mutex::new(None)), runtime: Arc::new(MemoRuntime::new()),
        };
        let output = serde_json::from_str::<Value>(&task.compute().unwrap()).unwrap();
        let bm25 = |id: i64| output["tdbTopK"].as_array().unwrap().iter()
            .find(|c| c["id"] == id).unwrap()["bm25Score"].as_f64().unwrap();
        assert!(bm25(1) > bm25(2), "query words first: {} vs {}", bm25(1), bm25(2));
        assert!(bm25(2) > 0. && bm25(3) > 0., "group members still count");
        assert_eq!(bm25(4), 0.);
        assert_eq!(output["diagnostics"]["bm25Groups"], 1);
        drop(task);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_plans_name_the_field() {
        let plan = |extra: Value| {
            let mut value = json!({ "scope": {}, "modelSig": "m", "engineMode": "rivermemo", "k": 5 });
            for (key, item) in extra.as_object().unwrap() { value[key] = item.clone(); }
            serde_json::from_value::<Plan>(value).unwrap()
        };
        let query = [0.1_f32; 4];
        assert_eq!(plan_problem(&plan(json!({})), &query, 4), None);
        let many = (0..257).map(|i| format!("t{i}")).collect::<Vec<_>>();
        assert_eq!(plan_problem(&plan(json!({ "queryTokens": many })), &query, 4).unwrap(),
            "queryTokens=257 (max 256)");
        let group = (0..285).map(|i| format!("w{i}")).collect::<Vec<_>>();
        assert_eq!(plan_problem(&plan(json!({ "queryTokens": ["vps"], "queryTokenGroups": [group] })), &query, 4), None,
            "a 285-word group is fine as a group");
        assert!(plan_problem(&plan(json!({ "k": 0 })), &query, 4).unwrap().starts_with("k=0"));
        assert!(plan_problem(&plan(json!({})), &[0.1_f32; 3], 4).unwrap().starts_with("query dimension=3"));
    }

    #[test]
    fn native_filters_preserve_signature_dates_music_and_negative_cosine() {
        let root = std::env::temp_dir().join(format!("lightmemo-query-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES
                 (1,'a.txt','AliceDiary','a',0,0),(2,'m.txt','MusicDiary','m',0,0),
                 (3,'x.txt','已整理Alice','x',0,0),(4,'c.txt','Alice簇','c',0,0);"
            ).map_err(|e|e.to_string())?;
            for (id,file,text,value) in [
                (1,1,format!("{} Alice [2026-10-19]\nbody","前".repeat(30)),1_f32),
                (2,1,"[2025-01] Bob\nAlice body".into(),-1.),
                (3,2,"[2026-10-19] song".into(),1.),
                (4,3,"[2026-10-19] Alice".into(),1.),
                (5,4,"[2026-10-19] Alice".into(),1.),
            ] {
                let bytes = [value,0.].iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>();
                tx.execute("INSERT INTO chunks(id,file_id,chunk_index,content,vector)
                    VALUES (?1,?2,0,?3,?4)",rusqlite::params![id,file,text,bytes])
                    .map_err(|e|e.to_string())?;
            }
            Ok(crate::storage::WriteReceipt{
                operation:"fixture".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        let mut task = LightMemoTask {
            db_path:db.clone(),dimension:2,query:vec![1.,0.],
            plan_json:String::new(),table:Arc::new(Mutex::new(None)),
            runtime:Arc::new(MemoRuntime::new()),
        };
        let run = |task:&mut LightMemoTask,scope:Value| {
            task.plan_json=json!({"scope":scope,"modelSig":"test","engineMode":"knn",
                "k":10,"candidateK":20}).to_string();
            serde_json::from_str::<Value>(&task.compute().unwrap()).unwrap()
        };
        let signature=run(&mut task,json!({"maid":"Alice","excludedFolders":["MusicDiary"]}));
        assert_eq!(signature["results"].as_array().unwrap().len(),1);
        assert_eq!(signature["results"][0]["id"],1);
        let folder=run(&mut task,json!({"folders":["Alice"],"timeRange":{"start":20250101,"end":20250131}}));
        assert_eq!(folder["results"][0]["id"],2);
        assert_eq!(folder["results"][0]["vectorScore"],-1.);
        let music=run(&mut task,json!({"folders":["MusicDiary"],"includeMusic":true,
            "excludedFolders":["MusicDiary"]}));
        assert_eq!(music["results"][0]["id"],3);
        let excluded=run(&mut task,json!({"searchAll":true,"excludedFolders":["MusicDiary"]}));
        assert_eq!(excluded["results"].as_array().unwrap().len(),2);
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry|
            entry.unwrap().file_name().to_string_lossy().contains(".vec")));
        crate::storage::with_registered_read_transaction(&db, |connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM global_chunk_index_baselines",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        }).unwrap();
        let idle_since = std::time::Instant::now() - std::time::Duration::from_secs(120);
        task.table.lock().unwrap().as_mut().unwrap().last_used = idle_since;
        let mut checkpoint = GlobalChunkCheckpointTask {
            db_path: db.clone(), dimension: 2, model: "test".into(),
            threshold: 0.05, allow_initial: false, table: task.table.clone(),
        };
        let receipt: Value = serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(receipt["published"], false);
        assert_eq!(task.table.lock().unwrap().as_ref().unwrap().last_used, idle_since);
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry|
            entry.unwrap().file_name().to_string_lossy().contains(".vec")));
        drop(checkpoint);
        drop(task);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
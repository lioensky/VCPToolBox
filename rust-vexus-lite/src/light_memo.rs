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
    #[serde(default)]
    use_bm25: bool,
    #[serde(default)]
    artifact_sig: String,
    #[serde(default)]
    river_input: Value,
}

fn default_pool() -> usize { 256 }

pub struct LightMemoTask {
    pub(crate) db_path: String,
    pub(crate) dimension: usize,
    pub(crate) query: Vec<f32>,
    pub(crate) plan_json: String,
    pub(crate) table: Arc<Mutex<Option<GlobalChunks>>>,
    pub(crate) runtime: Arc<MemoRuntime>,
    pub(crate) observation: Option<Arc<crate::rivermemo_topology_v3::MemoQueryObservation>>,
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
        if plan.query_tokens.len() > 256 {
            return Err(Error::from_reason(format!(
                "LIGHTMEMO_INVALID_PLAN: field=queryTokens.length actual={} max=256",
                plan.query_tokens.len()
            )));
        }
        if let Some((index, token)) = plan.query_tokens.iter().enumerate().find(|(_, t)| t.len() > 1024) {
            return Err(Error::from_reason(format!(
                "LIGHTMEMO_INVALID_PLAN: field=queryTokens[{index}].bytes actual={} max=1024",
                token.len()
            )));
        }
        let invalid = if plan.k == 0 || plan.k > 1000 {
            Some(format!("field=k actual={} min=1 max=1000", plan.k))
        } else if plan.candidate_k == 0 || plan.candidate_k > 2000 {
            Some(format!("field=candidateK actual={} min=1 max=2000", plan.candidate_k))
        } else if plan.model_sig.trim().is_empty() {
            Some("field=modelSig reason=empty".into())
        } else if !matches!(plan.engine_mode.as_str(), "knn" | "rivermemo") {
            Some("field=engineMode reason=unsupported".into())
        } else if self.query.len() != self.dimension {
            Some(format!("field=query.length actual={} expected={}", self.query.len(), self.dimension))
        } else if self.query.iter().any(|v| !v.is_finite()) {
            Some("field=query reason=nonfinite".into())
        } else { None };
        if let Some(detail) = invalid {
            return Err(Error::from_reason(format!("LIGHTMEMO_INVALID_PLAN: {detail}")));
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
                // Count admitted rows during the scan instead of materializing a scope set.
                let mut scope_chunks = 0usize;
                let ids = table.search(&self.query, plan.candidate_k.max(plan.k), |row| {
                    let admitted = plan.scope.admits(row, &diaries);
                    scope_chunks += usize::from(admitted);
                    admitted
                })?;
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
                // Plain knn returns only the first k and nothing reads the rest of
                // the pool (keyword scores would, through idf and average length).
                if plan.engine_mode == "knn" && !plan.ab_mode
                    && !(plan.use_bm25 && !plan.query_tokens.is_empty()) {
                    candidates.truncate(plan.k);
                }
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
                if plan.use_bm25 && !plan.query_tokens.is_empty() {
                    score_keywords(&mut candidates, &plan.query_tokens);
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
                    river = serde_json::from_str(&crate::rivermemo_topology_v3::run_native_with_observation(
                        &self.runtime, connection, &plan.artifact_sig, &input.to_string(),
                        self.observation.as_ref(),
                    )?).map_err(|e| e.to_string())?;
                    if plan.ab_mode {
                        // Export a bounded read-only view of this exact observation, never
                        // truncate the graph used by propagation or topology scoring.
                        let cached = match self.observation.as_ref() {
                            Some(value) => value.clone(),
                            None => self.runtime.get_query_observation(
                                input["observationHandle"].as_str().unwrap(), &plan.artifact_sig)?,
                        };
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
                    "diagnostics":{"scopeChunks":scope_chunks,"candidateCount":vectors.len(),
                        "synchronizedRows":synchronized,"databaseGeneration":generation,
                        "bm25Mode":"candidate-substring-tf-v1","ffiTrips":1}
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
fn score_keywords(candidates: &mut [Value], tokens: &[String]) {
    let texts = candidates.iter().map(|c| c["text"].as_str().unwrap_or("").to_lowercase())
        .collect::<Vec<_>>();
    let lengths = texts.iter().map(|t| t.chars().count().max(1) as f64).collect::<Vec<_>>();
    let avg = lengths.iter().sum::<f64>() / lengths.len().max(1) as f64;
    let mut scores = vec![0.; texts.len()];
    // Input order, first occurrence: a fixed summation order makes scores reproducible.
    let mut seen = HashSet::new();
    let mut counts = vec![0usize; texts.len()];
    for token in tokens.iter().filter(|t| !t.is_empty()) {
        if !seen.insert(token.as_str()) { continue; }
        for (count, text) in counts.iter_mut().zip(&texts) {
            *count = text.matches(token.as_str()).count();
        }
        let df = counts.iter().filter(|count| **count > 0).count() as f64;
        let idf = ((texts.len() as f64-df+0.5)/(df+0.5)+1.).ln();
        for (i,&count) in counts.iter().enumerate() {
            let tf = count as f64;
            if tf > 0. { scores[i] += idf*tf*2.5/(tf+1.5*(0.25+0.75*lengths[i]/avg)); }
        }
    }
    for (candidate, score) in candidates.iter_mut().zip(scores) {
        candidate["bm25Score"] = json!(score);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_plan_boundaries_report_actual_field_before_database_access() {
        let mut task = LightMemoTask {
            db_path: "unregistered-lightmemo-test.sqlite".into(),
            dimension: 2, query: vec![1., 0.], plan_json: String::new(),
            table: Arc::new(Mutex::new(None)),
            runtime: Arc::new(MemoRuntime::new()),
            observation: None,
        };
        for count in [256, 257] {
            task.plan_json = json!({
                "scope": {"searchAll": true}, "modelSig": "test",
                "engineMode": "knn", "k": 1, "candidateK": 256,
                "queryTokens": (0..count).map(|i| format!("word_{i}")).collect::<Vec<_>>()
            }).to_string();
            let error = task.compute().unwrap_err().reason;
            if count == 257 {
                assert!(error.contains("field=queryTokens.length actual=257 max=256"), "{error}");
            } else {
                assert!(!error.contains("LIGHTMEMO_INVALID_PLAN"), "{error}");
            }
        }
        task.plan_json = json!({
            "scope": {"searchAll": true}, "modelSig": "test",
            "engineMode": "knn", "k": 1, "candidateK": 256,
            "queryTokens": ["汉".repeat(342)]
        }).to_string();
        let error = task.compute().unwrap_err().reason;
        assert!(error.contains("field=queryTokens[0].bytes actual=1026 max=1024"), "{error}");
    }

    #[test]
    fn keyword_scores_sum_in_token_order_and_repeat_bit_for_bit() {
        let texts: Vec<String> = (0..48).map(|i| (0..80)
            .map(|j| format!("W{} ", (i * 7 + j * 13) % 97)).collect()).collect();
        // Includes a duplicate and an empty token; both must be ignored.
        let tokens: Vec<String> = (0..96).map(|t| format!("w{t}"))
            .chain(["w5".to_string(), String::new()]).collect();
        let lowered = texts.iter().map(|t| t.to_lowercase()).collect::<Vec<_>>();
        let lengths = lowered.iter().map(|t| t.chars().count().max(1) as f64).collect::<Vec<_>>();
        let avg = lengths.iter().sum::<f64>() / lengths.len() as f64;
        let mut expected = vec![0.0_f64; lowered.len()];
        let mut seen = HashSet::new();
        for token in tokens.iter().filter(|t| !t.is_empty()) {
            if !seen.insert(token) { continue; }
            let df = lowered.iter().filter(|text| text.contains(token.as_str())).count() as f64;
            let idf = ((lowered.len() as f64-df+0.5)/(df+0.5)+1.).ln();
            for (i, text) in lowered.iter().enumerate() {
                let tf = text.matches(token.as_str()).count() as f64;
                if tf > 0. { expected[i] += idf*tf*2.5/(tf+1.5*(0.25+0.75*lengths[i]/avg)); }
            }
        }
        for _ in 0..8 {
            let mut candidates = texts.iter().map(|t| json!({"text": t})).collect::<Vec<_>>();
            score_keywords(&mut candidates, &tokens);
            for (candidate, expected) in candidates.iter().zip(&expected) {
                assert_eq!(candidate["bm25Score"].as_f64().unwrap().to_bits(), expected.to_bits());
            }
        }
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
            observation:None,
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
        // Scope size counts admitted rows, independent of the candidate limit.
        assert_eq!(signature["diagnostics"]["scopeChunks"],1);
        assert_eq!(folder["diagnostics"]["scopeChunks"],1);
        assert_eq!(excluded["diagnostics"]["scopeChunks"],2);
        // knn with k below the pool returns the same leading rows, fully hydrated.
        task.plan_json=json!({"scope":{"searchAll":true,"excludedFolders":["MusicDiary"]},
            "modelSig":"test","engineMode":"knn","k":1,"candidateK":20}).to_string();
        let top=serde_json::from_str::<Value>(&task.compute().unwrap()).unwrap();
        assert_eq!(top["results"],json!([excluded["results"][0].clone()]));
        assert_eq!(top["tdbTopK"],top["results"]);
        assert_eq!(top["diagnostics"]["candidateCount"],2);
        assert_eq!(top["diagnostics"]["scopeChunks"],2);
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
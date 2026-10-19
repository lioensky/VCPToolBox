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
        if plan.k == 0 || plan.k > 1000 || plan.candidate_k == 0 || plan.candidate_k > 2000
            || plan.model_sig.trim().is_empty()
            || !matches!(plan.engine_mode.as_str(), "knn" | "rivermemo")
            || plan.query_tokens.len() > 256
            || plan.query_tokens.iter().any(|t| t.len() > 1024)
            || self.query.len() != self.dimension || self.query.iter().any(|v| !v.is_finite()) {
            return Err(Error::from_reason("LIGHTMEMO_INVALID_PLAN"));
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
                    input["dimension"] = json!(self.dimension);
                    input["topK"] = json!(plan.k);
                    input["candidates"] = json!(candidates);
                    input["allowedFileIds"] = json!(candidates.iter()
                        .filter_map(|c| c["fileId"].as_i64()).collect::<HashSet<_>>());
                    river = serde_json::from_str(&crate::rivermemo_topology_v3::run_native_with_connection(
                        &self.runtime, connection, &plan.artifact_sig, &input.to_string(),
                    )?).map_err(|e| e.to_string())?;
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
    for token in tokens.iter().filter(|t| !t.is_empty()).collect::<HashSet<_>>() {
        let df = texts.iter().filter(|text| text.contains(token.as_str())).count() as f64;
        let idf = ((texts.len() as f64-df+0.5)/(df+0.5)+1.).ln();
        for (i,text) in texts.iter().enumerate() {
            let tf = text.matches(token.as_str()).count() as f64;
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
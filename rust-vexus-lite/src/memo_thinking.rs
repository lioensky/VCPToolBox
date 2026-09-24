#![allow(dead_code)]

//! Read-only method-module planning over one existing Sense observation.
//! This is a propagation-supported scaffold, not a formal proof.
use crate::memo_sensing::ObservationTransition;
use crate::rivermemo_topology_v3::{load_artifact_from_runtime, MemoRuntime};
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    diary_name: String,
    k: usize,
    candidate_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    observation_handle: String,
    stages: Vec<Stage>,
    #[serde(default = "default_closure")]
    min_closure: f64,
}

fn default_closure() -> f64 { 0.2 }

#[derive(Clone)]
struct Module {
    id: i64,
    file_id: i64,
    relevance: f64,
    tags: HashMap<i64, (usize, f64)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    chunk_id: i64,
    score: f64,
    parents: Vec<i64>,
    relation: &'static str,
    route: Option<ObservationTransition>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageOutput {
    diary_name: String,
    k: usize,
    results: Vec<Selection>,
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum();
    let aa: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum();
    let bb: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum();
    let value = dot / (aa * bb).sqrt();
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 }
}

fn decode(bytes: Vec<u8>, dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension * 4 { return None; }
    let values: Vec<f32> = bytes.chunks_exact(4)
        .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]])).collect();
    values.iter().all(|v| v.is_finite()).then_some(values)
}

/// Adjacency requires the actual time-expanded predecessor state, not Tag
/// reachability in the aggregated river. Immediate return is never progression.
fn follows(left: &ObservationTransition, right: &ObservationTransition) -> bool {
    !right.immediate_return
        && left.hop + 1 == right.hop
        && left.target_id == right.source_id
        && right.previous_id == Some(left.source_id)
}

pub(crate) fn plan(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let input: Input = serde_json::from_str(input_json).map_err(|e| e.to_string())?;
    if input.stages.is_empty() || input.stages.len() > 32
        || !input.min_closure.is_finite()
        || !(0.0..=1.0).contains(&input.min_closure)
        || input.stages.iter().any(|s| s.k > 32 || s.candidate_ids.len() > 256
            || s.diary_name.trim().is_empty())
    {
        return Err("invalid or oversized method planning request".into());
    }
    let cached = runtime.get_query_observation(&input.observation_handle, artifact_sig)?;
    let observation = &cached.observation;
    if observation.transitions.is_empty() || observation.transitions_truncated {
        return Err("Sense transitions unavailable or truncated".into());
    }
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let connection = crate::open_sqlite_readonly(db_path).map_err(|e| e.to_string())?;
    let dimension = cached.original_query_vector.len();
    let mut chunk_statement = connection.prepare(
        "SELECT c.file_id, c.vector FROM chunks c JOIN files f ON f.id=c.file_id
         WHERE c.id=?1 AND f.diary_name=?2"
    ).map_err(|e| e.to_string())?;
    let mut tag_statement = connection.prepare(
        "SELECT ft.tag_id, t.vector FROM file_tags ft JOIN tags t ON t.id=ft.tag_id
         WHERE ft.file_id=?1 ORDER BY ft.position, ft.tag_id LIMIT 128"
    ).map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut selected: Vec<Selection> = Vec::new();
    let mut used_files = HashSet::new();
    let mut used_edges = HashSet::new();
    let maximum_flow = observation.transitions.iter().map(|e| e.flow).fold(0.0, f64::max);
    for stage in input.stages {
        let mut modules = Vec::new();
        let mut seen = HashSet::new();
        for id in stage.candidate_ids {
            if id <= 0 || !seen.insert(id) { continue; }
            let row = chunk_statement.query_row(
                rusqlite::params![id, stage.diary_name],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
            );
            let (file_id, bytes) = match row {
                Ok(row) => row,
                Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                Err(error) => return Err(error.to_string()),
            };
            let Some(vector) = decode(bytes, dimension) else { continue; };
            let rows = tag_statement.query_map([file_id], |r|
                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
            ).map_err(|e| e.to_string())?;
            let mut tags = HashMap::new();
            for (position, row) in rows.enumerate() {
                let (tag_id, bytes) = row.map_err(|e| e.to_string())?;
                if let Some(tag_vector) = decode(bytes, dimension) {
                    tags.insert(tag_id, (position, cosine(&vector, &tag_vector)));
                }
            }
            modules.push(Module {
                id, file_id, tags,
                relevance: cosine(&vector, &cached.original_query_vector),
            });
        }
        let mut results = Vec::new();
        for _ in 0..stage.k {
            let mut offers = Vec::new();
            for module in &modules {
                if used_files.contains(&module.file_id) { continue; }
                let mut best_route = None;
                let mut best_parents = Vec::new();
                let mut best_route_score = 0.0;
                for edge in &observation.transitions {
                    if edge.immediate_return { continue; }
                    let (Some((a_pos, a_closure)), Some((b_pos, b_closure))) =
                        (module.tags.get(&edge.source_id), module.tags.get(&edge.target_id))
                    else { continue; };
                    if *a_pos >= *b_pos || *a_closure < input.min_closure
                        || *b_closure < input.min_closure { continue; }
                    let parents: Vec<i64> = selected.iter().filter(|s|
                        s.route.as_ref().is_some_and(|previous| follows(previous, edge))
                    ).map(|s| s.chunk_id).collect();
                    // Start only at an observed root or continue an accepted route.
                    if edge.hop != 1 && parents.is_empty() { continue; }
                    let edge_key = (edge.hop, edge.previous_id, edge.source_id, edge.target_id);
                    let novelty = if used_edges.contains(&edge_key) { 0.2 } else { 1.0 };
                    let independent = artifact.independent_fraction(
                        edge.source_id, edge.target_id, module.file_id);
                    let score = (edge.flow / maximum_flow.max(1e-12))
                        * (a_closure * b_closure).sqrt() * independent * novelty;
                    let score = score * if parents.is_empty() { 0.8 } else { 1.0 };
                    if score > best_route_score {
                        best_route_score = score;
                        best_route = Some(edge.clone());
                        best_parents = parents;
                    }
                }
                let relation = match &best_route {
                    Some(edge) if edge.wormhole => "analogy",
                    Some(_) if !best_parents.is_empty() => "continuation",
                    Some(_) => "root",
                    None => "supplement",
                };
                offers.push((module.file_id, Selection {
                    chunk_id: module.id,
                    score: 0.35 * module.relevance + 0.65 * best_route_score,
                    parents: best_parents, relation, route: best_route,
                }));
            }
            offers.sort_by(|a, b| {
                b.1.route.is_some().cmp(&a.1.route.is_some())
                    .then_with(|| b.1.score.total_cmp(&a.1.score))
                    .then_with(|| a.1.chunk_id.cmp(&b.1.chunk_id))
            });
            let Some((file_id, choice)) = offers.into_iter().next() else { break; };
            used_files.insert(file_id);
            if let Some(edge) = &choice.route {
                used_edges.insert((edge.hop, edge.previous_id, edge.source_id, edge.target_id));
            }
            selected.push(choice.clone());
            results.push(choice);
        }
        output.push(StageOutput { diary_name: stage.diary_name, k: stage.k, results });
    }
    if !selected.iter().any(|s| s.route.is_some()) {
        return Err("no grounded method route; use legacy chain".into());
    }
    serde_json::to_string(&serde_json::json!({
        "schema": "vcp-river-thinking-plan-v1",
        "artifactSig": artifact_sig,
        "observationHandle": input.observation_handle,
        "stages": output
    })).map_err(|e| e.to_string())
}

pub struct ThinkingTask {
    pub(crate) runtime: Arc<MemoRuntime>,
    pub(crate) db_path: String,
    pub(crate) artifact_sig: String,
    pub(crate) input_json: String,
}

impl Task for ThinkingTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        plan(&self.runtime, &self.db_path, &self.artifact_sig, &self.input_json)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_sensing::{sense_typed, SenseConfig, SenseInput, SenseSeed};
    use crate::rivermemo_topology_v3::NativeArtifact;

    fn artifact() -> NativeArtifact {
        NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 1, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.9, 0.9],
            inbound: HashMap::new(),
            max_inbound: 0.0,
            anchor_gain: HashMap::new(),
            wormhole_edges: HashSet::new(),
            provenance: HashMap::new(),
        }
    }

    fn observation(graph: &NativeArtifact, limit: usize) -> crate::memo_sensing::SenseOutput {
        sense_typed(graph, "fixture", SenseInput {
            query_id: Some("test".into()),
            seeds: vec![SenseSeed { id: 1, energy: 1.0, source_type: "seed".into() }],
            config: SenseConfig {
                max_transition_records: limit,
                max_safe_hops: 3,
                base_decay: 0.9,
                firing_threshold: 0.001,
                minimum_injected_current: 0.001,
                ..SenseConfig::default()
            },
        }).unwrap()
    }

    #[test]
    fn accepted_routes_preserve_propagation_and_reject_wrong_predecessor() {
        let graph = artifact();
        let plain = observation(&graph, 0);
        let recorded = observation(&graph, 100);
        assert!(plain.transitions.is_empty());
        assert_eq!(plain.source_field, recorded.source_field);
        assert_eq!(recorded.transitions.len(), 2);
        assert!(follows(&recorded.transitions[0], &recorded.transitions[1]));
        let mut wrong = recorded.transitions[1].clone();
        wrong.previous_id = Some(99);
        assert!(!follows(&recorded.transitions[0], &wrong));
        wrong = recorded.transitions[1].clone();
        wrong.immediate_return = true;
        assert!(!follows(&recorded.transitions[0], &wrong));
        let bounded = observation(&graph, 1);
        assert!(bounded.transitions_truncated);
        assert_eq!(bounded.transitions.len(), 1);
        assert_eq!(plain.source_field, bounded.source_field);
    }

    #[test]
    fn planning_uses_routes_and_scope_not_just_relevance() {
        let graph = Arc::new(artifact());
        let runtime = MemoRuntime::new();
        runtime.publish("fixture", graph.clone()).unwrap();
        let sensed = observation(&graph, 100);
        let handle = runtime.store_query_observation(
            "fixture", sensed, vec![1.0, 0.0], vec![1.0, 0.0],
            vec![1.0, 0.0], vec![1.0, 0.0], vec![], vec![], vec![], vec![],
        ).unwrap();
        let path = std::env::temp_dir().join(format!(
            "vcp-thinking-{}-{}.sqlite", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db_path = path.to_str().unwrap();
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE files(id INTEGER PRIMARY KEY, diary_name TEXT);
                 CREATE TABLE chunks(id INTEGER PRIMARY KEY, file_id INTEGER, vector BLOB);
                 CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);
                 CREATE TABLE file_tags(file_id INTEGER, tag_id INTEGER, position INTEGER);"
            ).unwrap();
            let bytes = |v: [f32; 2]| v.into_iter().flat_map(f32::to_ne_bytes).collect::<Vec<_>>();
            for id in 1..=3 {
                db.execute("INSERT INTO tags VALUES(?1,?2)",
                    rusqlite::params![id, bytes([1.0, 0.0])]).unwrap();
            }
            for (id, diary, vector) in [
                (10, "A", [0.8, 0.6]),
                (20, "B", [0.8, 0.6]),
                (21, "B", [1.0, 0.0]),
                (22, "Other", [1.0, 0.0]),
            ] {
                db.execute("INSERT INTO files VALUES(?1,?2)", rusqlite::params![id, diary]).unwrap();
                db.execute("INSERT INTO chunks VALUES(?1,?1,?2)", rusqlite::params![id, bytes(vector)]).unwrap();
            }
            for (file, tags) in [(10, [1, 2]), (20, [2, 3]), (21, [3, 2]), (22, [2, 3])] {
                for (pos, tag) in tags.into_iter().enumerate() {
                    db.execute("INSERT INTO file_tags VALUES(?1,?2,?3)",
                        rusqlite::params![file, tag, pos as i64]).unwrap();
                }
            }
        }
        let input = serde_json::json!({
            "observationHandle": handle,
            "stages": [
                {"diaryName":"A","k":1,"candidateIds":[10]},
                {"diaryName":"B","k":1,"candidateIds":[21,22,20]},
                {"diaryName":"A","k":0,"candidateIds":[10]}
            ]
        });
        let output: serde_json::Value = serde_json::from_str(
            &plan(&runtime, db_path, "fixture", &input.to_string()).unwrap()
        ).unwrap();
        assert_eq!(output["stages"][0]["results"][0]["chunkId"], 10);
        assert_eq!(output["stages"][1]["results"][0]["chunkId"], 20);
        assert_eq!(output["stages"][1]["results"][0]["parents"], serde_json::json!([10]));
        assert_eq!(output["stages"][1]["results"][0]["relation"], "continuation");
        assert_eq!(output["stages"][2]["results"], serde_json::json!([]));
        runtime.clear().unwrap();
        assert!(plan(&runtime, db_path, "fixture", &input.to_string()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
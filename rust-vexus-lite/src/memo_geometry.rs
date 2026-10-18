
//! Unified anchored greedy Gram-Schmidt geometry.
//! All floating-point reductions use ID order, never Rayon reduction order.
use rayon::prelude::*;

pub(crate) enum AgsTarget<'a> {
    Explain(&'a [f64]),
    Span,
}

pub(crate) struct AgsCandidate {
    pub id: i64,
    pub prior: f64,
}

pub(crate) struct AgsTrace {
    pub picked: Vec<(i64, f64)>,
    pub basis: Vec<Vec<f64>>,
    pub residual_norm: Option<f64>,
}

pub(crate) fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn normalize(vector: &mut [f64]) -> bool {
    let norm = dot(vector, vector).sqrt();
    if !norm.is_finite() || norm <= 1e-12 {
        return false;
    }
    for value in vector {
        *value /= norm;
    }
    true
}

/// Incremental Gram-space GS: projections cost O(K*n²), not O(K*n²*dim).
/// Coefficients describe each selected axis in the original candidate basis.
fn gram_gs(
    candidates: &[AgsCandidate],
    gram: &[Vec<f64>],
    target: Option<(&[f64], f64)>,
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    let n = candidates.len();
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut projections: Vec<Vec<f64>> = Vec::new();
    let mut target_coefficients: Vec<f64> = Vec::new();
    let mut used = vec![false; n];
    let mut picked = Vec::new();
    for _ in 0..max_basis.min(n) {
        let mut best: Option<(usize, f64, f64, f64)> = None;
        for i in 0..n {
            if used[i] || !candidates[i].prior.is_finite() || candidates[i].prior <= 0.0 {
                continue;
            }
            let norm_sq = gram[i][i] - projections.iter().map(|p| p[i] * p[i]).sum::<f64>();
            let orth = norm_sq.max(0.0).sqrt();
            if orth <= 1e-6 {
                continue;
            }
            let signed = target.map(|(correlations, _)| {
                (correlations[i] - projections.iter().zip(&target_coefficients)
                    .map(|(p, c)| p[i] * c).sum::<f64>()) / orth
            }).unwrap_or(orth);
            let gain = signed.abs();
            let score = gain * orth * candidates[i].prior;
            if best.as_ref().is_none_or(|(j, old, _, _)| {
                score > *old || (score == *old && candidates[i].id < candidates[*j].id)
            }) {
                best = Some((i, score, gain, orth));
            }
        }
        let Some((i, _, gain, orth)) = best else { break };
        if gain < min_gain { break; }
        used[i] = true;
        let mut coefficients = vec![0.0; n];
        coefficients[i] = 1.0;
        for (axis, p) in basis.iter().zip(&projections) {
            for (value, coefficient) in coefficients.iter_mut().zip(axis) {
                *value -= p[i] * coefficient;
            }
        }
        for value in &mut coefficients { *value /= orth; }
        let row: Vec<f64> = (0..n).map(|j| dot(&coefficients, &gram[j])).collect();
        if let Some((correlations, _)) = target {
            target_coefficients.push(dot(&coefficients, correlations));
        }
        picked.push((candidates[i].id, gain));
        basis.push(coefficients);
        projections.push(row);
    }
    let residual_norm = target.map(|(_, energy)| {
        let residual = (energy - target_coefficients.iter().map(|c| c * c).sum::<f64>()).max(0.0);
        if residual < 1e-14 * energy { 0.0 } else { residual.sqrt() }
    });
    AgsTrace { picked, basis, residual_norm }
}

pub(crate) fn anchored_gs(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    let gram: Vec<Vec<f64>> = vectors.iter()
        .map(|a| vectors.iter().map(|b| dot(a, b)).collect()).collect();
    let correlations: Vec<f64> = match target {
        AgsTarget::Explain(t) => vectors.iter().map(|v| dot(t, v)).collect(),
        AgsTarget::Span => Vec::new(),
    };
    let target_data = match target {
        AgsTarget::Explain(t) => Some((correlations.as_slice(), dot(t, t))),
        AgsTarget::Span => None,
    };
    let mut trace = gram_gs(candidates, &gram, target_data, max_basis, min_gain);
    let dim = vectors.first().map_or(0, |v| v.len());
    trace.basis = trace.basis.iter().map(|coefficients| {
        let mut axis = vec![0.0; dim];
        for (c, vector) in coefficients.iter().zip(vectors) {
            for (value, source) in axis.iter_mut().zip(*vector) { *value += c * source; }
        }
        axis
    }).collect();
    trace
}

fn effective_k(coverage: &[f64], k_sem: usize, epsilon: f64, delta: f64) -> usize {
    let minimum = k_sem.min(coverage.len());
    for k in minimum.max(1)..=coverage.len() {
        let previous = if k > 1 { coverage[k - 2] } else { 0.0 };
        if 1.0 - coverage[k - 1] <= epsilon || coverage[k - 1] - previous < delta {
            return k;
        }
    }
    coverage.len()
}

use crate::storage::{self, with_registered_read_transaction, with_registered_write};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const ALGORITHM: &str = "unified_geometry_ags_v2";

fn semantic_weight(sim: f64, enabled: bool, peak: f64, sigma: f64, floor: f64, hard_floor: f64) -> f64 {
    if !enabled { 1.0 } else if sim < hard_floor { 0.0 }
    else if sim <= 0.0 { floor }
    else { (0.5+0.8*(-(sim-peak).powi(2)/(2.0*sigma*sigma)).exp()).max(floor) }
}

/// A bounded mixture, not an unbounded sum of raw cooccurrence counts.
/// Both target and neighbors are centered in the same unit-vector coordinate system.
fn star_direction(target: &[f64], mean: &[f64], neighbors: &[(&[f64], f64)], mix: f64) -> Vec<f64> {
    let weight_sum: f64 = neighbors.iter().map(|(_, w)| *w).sum();
    let mix = if weight_sum > 1e-12 { mix } else { 0.0 };
    let mut direction: Vec<f64> = target.iter().zip(mean).map(|(v,m)| (1.0-mix)*(v-m)).collect();
    if mix > 0.0 {
        for (vector, weight) in neighbors {
            for ((out, v), m) in direction.iter_mut().zip(*vector).zip(mean) {
                *out += mix * weight / weight_sum * (v-m);
            }
        }
    }
    if !normalize(&mut direction) {
        direction = target.iter().zip(mean).map(|(v,m)| v-m).collect();
        normalize(&mut direction);
    }
    direction
}

fn number(v: &Value, key: &str, default: f64, min: f64, max: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).filter(|x| x.is_finite())
        .unwrap_or(default).clamp(min, max)
}

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// Unique IDs in sorted order. SQLite is only touched by this caller thread.
/// Invalid/zero vectors remain absent, never enter Gram matrices or the mean.
pub(crate) fn read_unit_vectors(
    connection: &Connection,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<(HashMap<i64, Vec<f64>>, usize), String> {
    let mut output = HashMap::new();
    // Bound the transient SQL f32 table; never overlap a full f32 table with
    // the normalized f64 workspace. Per-row arithmetic is deliberately unchanged.
    for batch in ids.chunks(128) {
        let rows = storage::load_vectors_by_ids(connection, "tags", batch, dimension)?;
        for (id, vector) in rows {
            let mut vector: Vec<f64> = vector.into_iter().map(|value| value as f64).collect();
            if normalize(&mut vector) {
                output.insert(id, vector);
            }
        }
    }
    // ABI compatibility: this historical counter now counts authoritative SQL rows.
    let sql_rows = output.len();
    Ok((output, sql_rows))
}

/// Build-only immutable f64 rows. The SQL snapshot is copied in bounded batches;
/// Rayon readers borrow mapped slices instead of retaining N heap vectors.
/// This is not a durable asset: no signature or mathematical precision changes.
struct UnitVectorWorkspace {
    map: Option<memmap2::Mmap>,
    path: std::path::PathBuf,
    slots: HashMap<i64, usize>,
    dimension: usize,
}

impl UnitVectorWorkspace {
    fn empty(dimension: usize) -> Self {
        Self { map: None, path: Default::default(), slots: HashMap::new(), dimension }
    }

    fn build(connection: &Connection, ids: &[i64], dimension: usize)
        -> std::result::Result<Self, String>
    {
        use std::io::Write;
        dimension.checked_mul(8).filter(|_| dimension > 0)
            .ok_or_else(|| "invalid geometry workspace dimension".to_string())?;
        let path = crate::unique_index_sidecar_path(
            &std::env::temp_dir().join("vcp-geometry"), "workspace",
        );
        let file = std::fs::OpenOptions::new().read(true).write(true)
            .create_new(true).open(&path).map_err(|e| e.to_string())?;
        // Own cleanup immediately after successful create_new, including all errors.
        let mut workspace = Self::empty(dimension);
        workspace.path = path;
        let result = (|| -> std::result::Result<(), String> {
        {
            let mut writer = std::io::BufWriter::new(&file);
            let mut unique = ids.to_vec();
            unique.sort_unstable();
            unique.dedup();
            for batch in unique.chunks(128) {
                let (rows, _) = read_unit_vectors(connection, batch, dimension)?;
                // Stable slots; byte values are unchanged normalized f64 values.
                for id in batch {
                    if let Some(vector) = rows.get(id) {
                        writer.write_all(bytemuck::cast_slice(vector.as_slice()))
                            .map_err(|e| e.to_string())?;
                        workspace.slots.insert(*id, workspace.slots.len());
                    }
                }
            }
            writer.flush().map_err(|e| e.to_string())?;
        }
        if !workspace.slots.is_empty() {
            // SAFETY: this unique private file has no writers after construction.
            // The mapping is released before deleting the file, also on Windows.
            let map = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| e.to_string())?;
            bytemuck::try_cast_slice::<u8, f64>(&map)
                .map_err(|e| format!("unaligned geometry workspace: {e}"))?;
            workspace.map = Some(map);
        }
        Ok(())
        })();
        drop(file);
        result?;
        Ok(workspace)
    }

    fn get(&self, id: &i64) -> Option<&[f64]> {
        let slot = *self.slots.get(id)?;
        let values: &[f64] = bytemuck::cast_slice(self.map.as_ref()?.as_ref());
        let start = slot * self.dimension;
        values.get(start..start + self.dimension)
    }

    fn contains_key(&self, id: &i64) -> bool { self.slots.contains_key(id) }
    fn len(&self) -> usize { self.slots.len() }
    fn is_empty(&self) -> bool { self.slots.is_empty() }
}

impl std::ops::Index<&i64> for UnitVectorWorkspace {
    type Output = [f64];
    fn index(&self, id: &i64) -> &Self::Output {
        self.get(id).expect("geometry vector ID has been validated")
    }
}

impl Drop for UnitVectorWorkspace {
    fn drop(&mut self) {
        drop(self.map.take());
        if !self.path.as_os_str().is_empty() {
            if let Err(error) = std::fs::remove_file(&self.path) {
                eprintln!("[KBM] Geometry workspace cleanup failed '{}': {error}", self.path.display());
            }
        }
    }
}

#[napi(object)]
pub struct GeometryResult {
    pub success: bool,
    pub artifact_sig: String,
    pub config_hash: String,
    pub algorithm_version: String,
    pub tag_count: u32,
    pub computed_count: u32,
    pub skipped_count: u32,
    pub vector_fallback_count: u32,
    pub k_eff: u32,
    pub coverage: Vec<f64>,
    pub elapsed_ms: f64,
    pub phase_summary: String,
}

pub struct GeometryTask {
    pub(crate) index: Arc<crate::index_handle::IndexHandle>,
    pub(crate) content_revision: Arc<AtomicU64>,
    pub(crate) dimensions: usize,
    pub(crate) db_path: String,
    pub(crate) model_sig: String,
    pub(crate) config_json: String,
}

struct LocalResult { id: i64, status: &'static str, count: usize, residual: f64 }

fn encode_vector(v: &[f64]) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = v.iter().flat_map(|x| (*x as f32).to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl GeometryTask {
    fn run(&self) -> std::result::Result<GeometryResult, String> {
        self.run_with_hook(|| {})
    }

    fn run_with_hook(&self, before_publish: impl FnOnce()) -> std::result::Result<GeometryResult, String> {
        if self.model_sig.trim().is_empty() { return Err("geometry requires modelSig".into()); }
        let started = Instant::now();
        let config: Value = serde_json::from_str(&self.config_json).map_err(|e| e.to_string())?;
        let local = config.get("local").unwrap_or(&config);
        let global = config.get("global").unwrap_or(&Value::Null);
        let max_neighbors = number(local,"maxNeighbors",48.0,1.0,256.0) as usize;
        let min_neighbors = number(local,"minNeighbors",3.0,1.0,256.0) as usize;
        let max_basis = number(local,"maxBasis",4.0,1.0,32.0) as usize;
        let min_gain = number(local,"minGain",0.015,0.0,1.0);
        let decay = number(local,"positionDecay",0.15,0.0,4.0);
        let k_max = number(global,"kMax",32.0,1.0,128.0) as usize;
        let k_sem = number(global,"kSem",8.0,1.0,k_max as f64) as usize;
        let mut signature_config = config.clone();
        if let Some(object) = signature_config.as_object_mut() { object.remove("forceRecompute"); }
        let config_hash = hash(signature_config.to_string().as_bytes());
        // Freeze facts/index publication only while acquiring the input snapshot.
        let snapshot_gate = crate::publication_gate::acquire_read(&self.db_path, &["*".into()])?;
        let rev0 = self.content_revision.load(Ordering::Acquire);
        let mut digest = Sha256::new();
        let mut adjacency: BTreeMap<i64, BTreeMap<i64,f64>> = BTreeMap::new();
        let mut ids = Vec::new();
        let mut names = HashMap::new();
        let mut signature = String::new();
        let mut graph_generation = String::new();
        let mut cached: Option<Value> = None;
        let force = config.get("forceRecompute").and_then(Value::as_bool).unwrap_or(false);
        let (generation, dependencies, vectors, fallback) =
            with_registered_read_transaction(&self.db_path, |conn| {
                let generation = storage::read_generation(conn)?;
                let dependencies = storage::DerivedDependencies::capture(conn, &["memo_tag_facts"])?;
                let facts: String = conn.query_row(
                    "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'", [], |row| row.get(0),
                ).map_err(|e| e.to_string())?;
                graph_generation = format!("facts:{facts}");
                let mut stmt = conn.prepare("SELECT id,name,vector_version FROM tags ORDER BY id")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (id,name,version) = row.map_err(|e| e.to_string())?;
                    digest.update(id.to_le_bytes()); digest.update(version.to_le_bytes());
                    digest.update((name.len() as u64).to_le_bytes()); digest.update(name.as_bytes());
                    ids.push(id); names.insert(id,name);
                }
                let flush = |tags: &[(i64,i64)], graph: &mut BTreeMap<i64,BTreeMap<i64,f64>>| {
                    if !(2..=100).contains(&tags.len()) { return; }
                    for i in 0..tags.len() {
                        for j in i+1..tags.len() {
                            let (a,p) = tags[i]; let (b,q) = tags[j];
                            if a == b { continue; }
                            let delta = if p > 0 && q > 0 { (p-q).abs().max(1) as f64 } else { 1.0 };
                            let weight = (-decay * (delta-1.0)).exp();
                            *graph.entry(a).or_default().entry(b).or_default() += weight;
                            *graph.entry(b).or_default().entry(a).or_default() += weight;
                        }
                    }
                };
                let mut stmt = conn.prepare(
                    "SELECT file_id,tag_id,COALESCE(position,0) FROM file_tags ORDER BY file_id,position,tag_id"
                ).map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                let mut file = None; let mut tags = Vec::new();
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let fid: i64 = row.get(0).map_err(|e| e.to_string())?;
                    let id: i64 = row.get(1).map_err(|e| e.to_string())?;
                    let pos: i64 = row.get(2).map_err(|e| e.to_string())?;
                    digest.update(fid.to_le_bytes()); digest.update(id.to_le_bytes()); digest.update(pos.to_le_bytes());
                    if file != Some(fid) { flush(&tags,&mut adjacency); tags.clear(); file=Some(fid); }
                    // Retain at most 101 entries: oversized files are skipped without unbounded memory.
                    if tags.len() <= 100 { tags.push((id,pos)); }
                }
                flush(&tags,&mut adjacency);
                let content = format!("{:x}",digest.clone().finalize());
                signature = hash(format!("{}|{}|{}|{}|{}",ALGORITHM,self.dimensions,self.model_sig,config_hash,content).as_bytes());
                if !force {
                    let raw: Option<String> = conn.query_row(
                        "SELECT k.value FROM tagmemo_artifacts a JOIN kv_store k ON k.key='epa_basis_cache'
                         WHERE a.asset_type='unified_geometry' AND a.artifact_sig=?1
                         AND a.graph_generation=?2 AND a.status='ready'",
                        params![signature, graph_generation], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                    cached = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .filter(|v| v["artifactSig"].as_str() == Some(signature.as_str()));
                }
                let vectors = if cached.is_some() { UnitVectorWorkspace::empty(self.dimensions) }
                    else { UnitVectorWorkspace::build(conn, &ids, self.dimensions)? };
                let fallback = vectors.len();
                Ok((generation,dependencies,vectors,fallback))
            })?;
        drop(snapshot_gate);
        let load_ms = started.elapsed().as_secs_f64()*1000.0;
        if let Some(cache) = cached {
            if self.content_revision.load(Ordering::Acquire) != rev0 { return Err("revision_conflict".into()); }
            return Ok(GeometryResult {
                success:true, artifact_sig:signature,config_hash,algorithm_version:ALGORITHM.into(),
                tag_count:ids.len() as u32,computed_count:0,skipped_count:ids.len() as u32,
                vector_fallback_count:0,k_eff:cache["basis"].as_array().map_or(0,|b| b.len()) as u32,
                coverage:serde_json::from_value(cache["coverage"].clone()).unwrap_or_default(),
                elapsed_ms:load_ms,phase_summary:format!("cache_hit;load={load_ms:.3}ms"),
            });
        }
        // Compact sorted CSR, released construction maps before parallel computation.
        let mut offsets = vec![0]; let mut edges = Vec::new(); let mut support = Vec::new();
        for id in &ids {
            let neighbors = adjacency.remove(id).unwrap_or_default();
            support.push(neighbors.values().sum::<f64>());
            edges.extend(neighbors); offsets.push(edges.len());
        }
        drop(adjacency);
        let gate = local.get("semanticGate").unwrap_or(local);
        let gate_enabled = gate.get("enabled").or_else(|| gate.get("semanticEnabled"))
            .and_then(Value::as_bool).unwrap_or(true);
        let peak = number(gate,"peak",number(local,"semanticPeak",0.65,-1.0,1.0),-1.0,1.0);
        let sigma = number(gate,"sigma",number(local,"semanticSigma",0.25,0.02,2.0),0.02,2.0);
        let floor = number(gate,"floor",number(local,"semanticFloor",0.35,0.0,1.0),0.0,1.0);
        let hard_floor = number(gate,"hardFloor",number(local,"semanticHardFloor",-1.0,-1.0,1.0),-1.0,1.0);
        let results: Vec<LocalResult> = ids.par_iter().enumerate().map(|(i,id)| {
            let mut result = LocalResult { id:*id,status:"failed",count:0,residual:1.0 };
            let Some(target) = vectors.get(id) else { return result };
            let mut neighbors: Vec<_> = edges[offsets[i]..offsets[i+1]].iter()
                .filter(|(id,_)| vectors.contains_key(id)).copied().collect();
            neighbors.sort_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            neighbors.truncate(max_neighbors);
            let mut candidates = Vec::new(); let mut refs = Vec::new();
            for (nid,w) in neighbors {
                let v = &vectors[&nid];
                let sim = dot(target,v).clamp(-1.0,1.0);
                let semantic = semantic_weight(sim,gate_enabled,peak,sigma,floor,hard_floor);
                if semantic > 0.0 {
                    candidates.push(AgsCandidate { id:nid,prior:w.ln_1p()*semantic }); refs.push(v);
                }
            }
            result.count = candidates.len();
            if result.count < min_neighbors { result.status="insufficient_neighbors"; return result; }
            let trace = anchored_gs(AgsTarget::Explain(target),&candidates,&refs,max_basis,min_gain);
            result.residual=trace.residual_norm.unwrap_or(1.0).clamp(0.0,1.0);
            // Orthogonal targets correctly have residual=1, not a failed status.
            result.status="computed"; result
        }).collect();
        let local_ms = started.elapsed().as_secs_f64()*1000.0-load_ms;
        let mut mean = vec![0.0;self.dimensions];
        for id in &ids { if let Some(v)=vectors.get(id) {
            for (m,x) in mean.iter_mut().zip(v) { *m += x; }
        }}
        if !vectors.is_empty() { for m in &mut mean { *m /= vectors.len() as f64; } }
        let min_support=number(global,"minSupport",3.0,0.0,1e12);
        let a=number(global,"supportExponent",0.65,0.0,4.0);
        let b=number(global,"residualExponent",0.35,0.0,4.0);
        let prior_mode=global.get("priorMode").and_then(Value::as_str).unwrap_or("support");
        if !["support","explained","residual"].contains(&prior_mode) {
            return Err("geometry global.priorMode must be support, explained or residual".into());
        }
        let candidate_mode=global.get("candidateMode").and_then(Value::as_str).unwrap_or("star");
        if !["star","anchor"].contains(&candidate_mode) {
            return Err("geometry global.candidateMode must be star or anchor".into());
        }
        let mut pool: Vec<_> = results.iter().enumerate().filter(|(i,r)| r.status=="computed" && support[*i]>=min_support)
            .map(|(i,r)| {
                let factor=match prior_mode {
                    "explained" => (1.0-r.residual*r.residual).max(0.0).powf(b),
                    "residual" => r.residual.powf(b),
                    _ => 1.0,
                };
                AgsCandidate { id:r.id,prior:support[i].powf(a)*factor }
            }).collect();
        pool.sort_by(|a,b| b.prior.total_cmp(&a.prior).then(a.id.cmp(&b.id)));
        pool.truncate(number(global,"candidatePool",512.0,1.0,4096.0) as usize);
        let star_neighbors=number(global,"starNeighbors",max_neighbors as f64,1.0,256.0) as usize;
        let mix=number(global,"starMix",0.8,0.0,1.0);
        let centered: Vec<Vec<f64>> = pool.par_iter().map(|c| {
            let target=&vectors[&c.id];
            let i=ids.binary_search(&c.id).unwrap();
            let mut neighbors:Vec<_>=edges[offsets[i]..offsets[i+1]].iter()
                .filter(|(id,_)|vectors.contains_key(id)).copied().collect();
            neighbors.sort_by(|a,b|b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            neighbors.truncate(star_neighbors);
            let weighted:Vec<_>=neighbors.iter().filter_map(|(id,w)| {
                let v=&vectors[id];
                let weight=w.ln_1p()*semantic_weight(dot(target,v).clamp(-1.0,1.0),gate_enabled,peak,sigma,floor,hard_floor);
                (weight>0.0).then_some((v,weight))
            }).collect();
            star_direction(target,&mean,&weighted,if candidate_mode=="star" {mix} else {0.0})
        }).collect();
        let refs:Vec<_>=centered.iter().map(Vec::as_slice).collect();
        let mut trace=anchored_gs(AgsTarget::Span,&pool,&refs,k_max,number(global,"minGain",0.02,0.0,1.0));
        // Global axes own their vectors; candidate construction and adjacency
        // are no longer needed during coverage or SQL publication.
        drop(refs);
        drop(centered);
        drop(pool);
        drop(edges);
        drop(offsets);
        drop(support);
        let global_ms=started.elapsed().as_secs_f64()*1000.0-load_ms-local_ms;
        // Fixed-size chunks + indexed collect + serial reduction = thread-count-independent bits.
        let partial:Vec<_>=ids.par_chunks(128).map(|batch| {
            let mut energy=0.0; let mut captured=vec![0.0;trace.basis.len()];
            for id in batch { if let Some(v)=vectors.get(id) {
                let x:Vec<_>=v.iter().zip(&mean).map(|(v,m)|v-m).collect();
                energy+=dot(&x,&x);
                for (c,axis) in captured.iter_mut().zip(&trace.basis) { *c+=dot(&x,axis).powi(2); }
            }}
            (energy,captured)
        }).collect();
        drop(vectors);
        let mut total=0.0; let mut energies=vec![0.0;trace.basis.len()];
        for (energy,values) in partial { total+=energy; for (e,v) in energies.iter_mut().zip(values) { *e+=v; }}
        let mut cumulative=0.0;
        let mut coverage:Vec<_>=energies.iter().map(|e| { cumulative+=e; if total>1e-12 { (cumulative/total).clamp(0.0,1.0) } else { 0.0 } }).collect();
        let full_coverage=coverage.clone();
        let k=effective_k(&coverage,k_sem,number(global,"epsilon",0.1,0.0,1.0),number(global,"kneeDelta",0.0,0.0,1.0));
        trace.basis.truncate(k); trace.picked.truncate(k); energies.truncate(k); coverage.truncate(k);
        let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        let cache=json!({
            "basis":trace.basis.iter().map(|v|encode_vector(v)).collect::<Vec<_>>(),
            "mean":encode_vector(&mean),"energies":energies,"coverage":coverage,
            "labels":trace.picked.iter().map(|(id,_)|names[id].clone()).collect::<Vec<_>>(),
            "anchorTagIds":trace.picked.iter().map(|(id,_)|*id).collect::<Vec<_>>(),
            "totalEnergy":total,"kSem":k_sem,"kMax":k_max,"epaAlgorithm":"ags-global-star-v2",
            "candidateMode":candidate_mode,"priorMode":prior_mode,"fullCoverage":full_coverage,
            "artifactSig":signature,"tagCount":ids.len(),"timestamp":now
        }).to_string();
        let coverage_ms=started.elapsed().as_secs_f64()*1000.0-load_ms-local_ms-global_ms;
        let computed=results.iter().filter(|r|r.status=="computed").count();
        let anchor=local.get("anchorGain").unwrap_or(local);
        let base=number(anchor,"base",number(local,"v9AnchorBase",0.75,0.0,4.0),0.0,4.0);
        let scale=number(anchor,"scale",number(local,"v9AnchorScale",1.25,0.0,4.0),0.0,4.0);
        let gamma=number(anchor,"gamma",number(local,"v9AnchorGamma",1.0,0.1,8.0),0.1,8.0);
        let low=number(anchor,"min",number(local,"v9AnchorMin",0.5,0.0,4.0),0.0,4.0);
        let high=number(anchor,"max",number(local,"v9AnchorMax",2.0,0.0,8.0),0.0,8.0);
        before_publish();
        let publication_started=Instant::now();
        let _gate=crate::publication_gate::acquire(&self.db_path,&["*".into()])?;
        // Keep index readers held through writer commit, excluding direct index mutations.
        let _index_guard=self.index.read().map_err(|e|e.to_string())?;
        if self.content_revision.load(Ordering::Acquire)!=rev0 { return Err("revision_conflict".into()); }
        let sig=signature.clone(); let model=self.model_sig.clone(); let cfg=self.config_json.clone();
        let cfg_hash=config_hash.clone(); let revision=self.content_revision.clone();
        let gate_ms=publication_started.elapsed().as_secs_f64()*1000.0;
        let timings=Arc::new(std::sync::Mutex::new([0.0f64;3]));
        let write_timings=timings.clone();
        with_registered_write(&self.db_path,move |tx| {
            if revision.load(Ordering::Acquire)!=rev0 { return Err("revision_conflict".into()); }
            storage::ensure_generation(tx,generation)?; dependencies.ensure_current(tx)?;
            let delete_started=Instant::now();
            tx.execute_batch("DELETE FROM tag_intrinsic_residuals; DELETE FROM tag_intrinsic_residual_status;")
                .map_err(|e|e.to_string())?;
            let delete_ms=delete_started.elapsed().as_secs_f64()*1000.0;
            let insert_started=Instant::now();
            {
                let mut values=tx.prepare_cached("INSERT INTO tag_intrinsic_residuals
                    (tag_id,residual_energy,neighbor_count,raw_residual_ratio,v8_3_compat_gain,v9_anchor_gain,model_sig,artifact_sig,algorithm_version,config_hash,status)
                    VALUES (?1,?2,?3,?4,NULL,?2,?5,?6,?7,?8,'computed')").map_err(|e|e.to_string())?;
                let mut status=tx.prepare_cached("INSERT INTO tag_intrinsic_residual_status
                    (tag_id,artifact_sig,status,neighbor_count,error_message,computed_at) VALUES (?1,?2,?3,?4,NULL,?5)")
                    .map_err(|e|e.to_string())?;
                for r in results {
                    if r.status=="computed" {
                        let gain=(base+scale*r.residual.powf(gamma)).clamp(low.min(high),low.max(high));
                        values.execute(params![r.id,gain,r.count as i64,r.residual,model,sig,ALGORITHM,cfg_hash])
                            .map_err(|e|e.to_string())?;
                    } else {
                        // Success is represented by the value row; status contains exceptions only.
                        status.execute(params![r.id,sig,r.status,r.count as i64,now]).map_err(|e|e.to_string())?;
                    }
                }
            }
            let insert_ms=insert_started.elapsed().as_secs_f64()*1000.0;
            let metadata_started=Instant::now();
            tx.execute("INSERT OR REPLACE INTO kv_store(key,value) VALUES ('epa_basis_cache',?1)",[cache]).map_err(|e|e.to_string())?;
            tx.execute("INSERT OR REPLACE INTO tagmemo_artifacts
                (artifact_sig,asset_type,model_sig,graph_generation,algorithm_version,config_hash,effective_config,status,created_at,updated_at)
                VALUES (?1,'unified_geometry',?2,?7,?3,?4,?5,'ready',?6,?6)",
                params![sig,model,ALGORITHM,cfg_hash,cfg,now,graph_generation]).map_err(|e|e.to_string())?;
            tx.execute("DELETE FROM tagmemo_artifacts WHERE asset_type='unified_geometry' AND artifact_sig!=?1",[sig]).map_err(|e|e.to_string())?;
            *write_timings.lock().map_err(|e|e.to_string())?=[
                delete_ms,insert_ms,metadata_started.elapsed().as_secs_f64()*1000.0];
            Ok(storage::WriteReceipt { operation:"publish_memo_geometry".into(),database_generation:0,facts_changed:false })
        })?;
        let elapsed=started.elapsed().as_secs_f64()*1000.0;
        let [delete_ms,insert_ms,metadata_ms]=*timings.lock().map_err(|e|e.to_string())?;
        let publication_ms=publication_started.elapsed().as_secs_f64()*1000.0;
        let commit_queue_ms=(publication_ms-gate_ms-delete_ms-insert_ms-metadata_ms).max(0.0);
        Ok(GeometryResult {
            success:true,artifact_sig:signature,config_hash,algorithm_version:ALGORITHM.into(),
            tag_count:ids.len() as u32,computed_count:computed as u32,skipped_count:(ids.len()-computed) as u32,
            vector_fallback_count:fallback as u32,k_eff:k as u32,coverage,elapsed_ms:elapsed,
            phase_summary:format!("load={load_ms:.3};local={local_ms:.3};global={global_ms:.3};coverage={coverage_ms:.3};publish={publication_ms:.3};gate={gate_ms:.3};delete={delete_ms:.3};insert={insert_ms:.3};metadata={metadata_ms:.3};commit_queue={commit_queue_ms:.3}"),
        })
    }
}

impl Task for GeometryTask {
    type Output=GeometryResult;
    type JsValue=GeometryResult;
    fn compute(&mut self)->Result<Self::Output> { self.run().map_err(Error::from_reason) }
    fn resolve(&mut self,_env:Env,output:Self::Output)->Result<Self::JsValue> { Ok(output) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapped_workspace_preserves_bits_and_releases_file() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB)").unwrap();
        let ids: Vec<i64> = (1..=300).collect();
        for id in &ids {
            let x = *id as f32 * 0.013;
            let bytes: Vec<u8> = [x.cos(), x.sin(), -0.0, f32::from_bits(1)]
                .iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2)", params![id, bytes]).unwrap();
        }
        connection.execute("UPDATE tags SET vector=zeroblob(16) WHERE id=7", []).unwrap();
        let (expected, _) = read_unit_vectors(&connection, &ids, 4).unwrap();
        let workspace = UnitVectorWorkspace::build(&connection, &ids, 4).unwrap();
        assert_eq!(workspace.len(), expected.len());
        assert!(!workspace.contains_key(&7));
        for (id, vector) in expected {
            assert!(workspace.get(&id).unwrap().iter().zip(vector)
                .all(|(a, b)| a.to_bits() == b.to_bits()));
        }
        let path = workspace.path.clone();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), workspace.len() as u64 * 4 * 8);
        drop(workspace);
        assert!(!path.exists());
        let empty = UnitVectorWorkspace::build(&connection, &[], 4).unwrap();
        assert!(empty.is_empty());
        assert!(empty.map.is_none());
        let path = empty.path.clone();
        drop(empty);
        assert!(!path.exists());
    }

    #[test]
    fn prefix_nested_and_orthogonal() {
        let vectors: Vec<Vec<f64>> = (0..32).map(|i| {
            let mut v = vec![0.0; 32]; v[i] = 1.0; v
        }).collect();
        let refs: Vec<_> = vectors.iter().map(Vec::as_slice).collect();
        let candidates: Vec<_> = (0..32).map(|i| AgsCandidate { id: i, prior: 1.0 }).collect();
        let short = anchored_gs(AgsTarget::Span, &candidates, &refs, 8, 0.0);
        let long = anchored_gs(AgsTarget::Span, &candidates, &refs, 32, 0.0);
        assert_eq!(short.basis, long.basis[..8]);
        assert_eq!(short.picked, long.picked[..8]);
        for (i, a) in long.basis.iter().enumerate() {
            for (j, b) in long.basis.iter().enumerate() {
                assert!((dot(a, b) - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn gram_matches_direct_residual_and_local_semantics() {
        let candidates = [AgsCandidate { id: 2, prior: 1.0 }, AgsCandidate { id: 1, prior: 1.0 }];
        let a = [1.0, 0.0, 0.0];
        let b = [0.6, 0.8, 0.0];
        for target in [[0.6, 0.8, 0.0], [0.0, 0.0, 1.0], [0.3, 0.4, 0.8660254037844386]] {
            let trace = anchored_gs(AgsTarget::Explain(&target), &candidates, &[&a, &b], 2, 0.0);
            let mut residual = target;
            for axis in &trace.basis {
                let c = dot(&target, axis);
                for (r, x) in residual.iter_mut().zip(axis) { *r -= c * x; }
            }
            assert!((trace.residual_norm.unwrap() - dot(&residual, &residual).sqrt()).abs() < 1e-9);
        }
    }

    #[test]
    fn star_mixture_is_count_scale_invariant_and_cancels_neighbor_noise() {
        let target=[1.0,0.0,0.0];
        let a=[0.8,0.6,0.0];
        let b=[0.8,-0.6,0.0];
        let mean=[0.0;3];
        let first=star_direction(&target,&mean,&[(&a,2.0),(&b,2.0)],0.75);
        let second=star_direction(&target,&mean,&[(&a,200.0),(&b,200.0)],0.75);
        assert_eq!(first,second);
        assert!((first[0]-1.0).abs()<1e-12);
        assert!(first[1].abs()<1e-12);
        assert_eq!(star_direction(&target,&mean,&[],1.0),target);
        assert_eq!(star_direction(&target,&mean,&[(&[-1.0,0.0,0.0],1.0)],0.5),target);
    }

    #[test]
    fn epsilon_and_knee_respect_semantic_prefix() {
        assert_eq!(effective_k(&[0.4, 0.8, 1.0, 1.0], 2, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[0.99, 0.991, 0.992], 3, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[], 8, 0.1, 0.005), 0);
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;

    #[test]
    fn fallback_cache_and_thread_count_determinism() {
        let root = std::env::temp_dir().join(format!("ags-task-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (store, _) = storage::SqliteStorageEngine::open_and_init(&db, storage::StorageOptions::default()).unwrap();
        store.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'a','test','x',0,0);"
            ).map_err(|e|e.to_string())?;
            for i in 0..6 {
                let angle = i as f32 * 0.5;
                let bytes:Vec<u8> = [angle.cos(),angle.sin(),0.2].iter().flat_map(|x| x.to_le_bytes()).collect();
                tx.execute("INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",params![i+1,format!("tag-{i}"),bytes]).map_err(|e|e.to_string())?;
                tx.execute("INSERT INTO file_tags VALUES (1,?1,?1)",[i+1]).map_err(|e|e.to_string())?;
            }
            Ok(storage::WriteReceipt { operation:"fixture".into(),database_generation:0,facts_changed:true })
        }).unwrap();
        let index=crate::VexusIndex::new(3,16).unwrap();
        let mut task=GeometryTask {
            index:index.index.clone(),content_revision:index.content_revision.clone(),
            dimensions:3,db_path:db.clone(),model_sig:"test".into(),
            config_json:r#"{"forceRecompute":true,"global":{"minSupport":0,"residualExponent":0,"kSem":2}}"#.into(),
        };
        let snapshot=|| storage::with_registered_read(&db,|c| {
            let raw:String=c.query_row("SELECT value FROM kv_store WHERE key='epa_basis_cache'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
            serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string())
        }).unwrap();
        let first=rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap().install(||task.run()).unwrap();
        let mut a=snapshot(); a.as_object_mut().unwrap().remove("timestamp");
        let second=rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap().install(||task.run()).unwrap();
        let mut b=snapshot(); b.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(first.artifact_sig,second.artifact_sig);
        assert_eq!(a,b);
        // Retrieval originals must have no influence on mathematical assets.
        // Start from the empty-index SQL result, poison every indexed original,
        // then restore exact SQL originals; all published geometry stays equal.
        {
            let mut guard = index.index.write().unwrap();
            for id in 1..=6 {
                guard.add(id, &[-9.0, 3.0, 7.0]).unwrap();
            }
            index.content_revision.fetch_add(1, Ordering::AcqRel);
        }
        let poisoned = task.run().unwrap();
        let mut poisoned_cache = snapshot();
        poisoned_cache.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(poisoned.artifact_sig, first.artifact_sig);
        assert_eq!(poisoned_cache, a);
        {
            let mut guard = index.index.write().unwrap();
            for i in 0..6 {
                let angle = i as f32 * 0.5;
                guard.add(i + 1, &[angle.cos(), angle.sin(), 0.2]).unwrap();
            }
            index.content_revision.fetch_add(1, Ordering::AcqRel);
        }
        let exact = task.run().unwrap();
        let mut exact_cache = snapshot();
        exact_cache.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(exact.artifact_sig, first.artifact_sig);
        assert_eq!(exact_cache, a);
        assert_eq!(first.vector_fallback_count,6);
        assert!(first.k_eff>0);
        assert!(first.coverage.windows(2).all(|w|w[0]<=w[1]));
        assert!(first.coverage.iter().all(|c|*c<=1.0));
        task.config_json=r#"{"global":{"minSupport":0,"residualExponent":0,"kSem":2}}"#.into();
        task.run().unwrap();
        let version=|| storage::with_registered_read(&db,|c|c.query_row(
            "SELECT value FROM kbm_runtime_meta WHERE key='derived_geometry'",[],|r|r.get::<_,String>(0)
        ).map_err(|e|e.to_string())).unwrap();
        let before=version();
        assert_eq!(task.run().unwrap().skipped_count,6);
        assert_eq!(version(),before);
        task.config_json=r#"{"forceRecompute":true,"global":{"minSupport":0,"residualExponent":0,"kSem":2}}"#.into();
        let error=task.run_with_hook(|| {
            task.content_revision.fetch_add(1,Ordering::AcqRel);
        }).err().unwrap();
        assert!(error.contains("revision_conflict"));
        assert_eq!(version(),before);
        let error=task.run_with_hook(|| {
            store.submit_write(|tx| {
                tx.execute("UPDATE tags SET name='renamed' WHERE id=1",[]).map_err(|e|e.to_string())?;
                Ok(storage::WriteReceipt { operation:"conflict".into(),database_generation:0,facts_changed:true })
            }).unwrap();
        }).err().unwrap();
        assert!(error.contains("GENERATION_CONFLICT"));
        assert_eq!(version(),before);
        store.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
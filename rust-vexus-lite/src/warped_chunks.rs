//! Experimental global Chunk geometry. Scope views never recompute coordinates.
use super::*;
use std::io::Read;
use std::sync::Mutex;
use vcp_tdb_index::index::quiver::hyperbolic::{
    HyperbolicSearchConfig, WarpedFieldConfig, WarpedFieldIndex, warped_size_budget,
};
use vcp_tdb_index::index::quiver::hyperbolic::warped_geometry::WarpedProfile;

const LEGACY_RULE: &str = "chunk-axis-residual-v1";
const RULE: &str = "chunk-axis-alignment-quantiles-v2";
const MAGIC: &[u8; 8] = b"VCPWC001";
const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;
const CONVERTED_MAGIC: &[u8; 8] = b"VCPWI001";
/// In-scope deltas beyond this count are converted into the frozen coordinates of the
/// trained generation instead of being read and scored exactly on every query.
const CONVERT_ABOVE: usize = 32;
/// Conversions performed by one query; the remainder keeps exact delta scoring.
const CONVERT_BATCH: usize = 1024;
/// Size limit of the converted sidecar. Deltas that no longer fit keep exact scoring.
const CONVERTED_MAX_BYTES: usize = if cfg!(test) { 256 * 1024 } else { MAX_BYTES };
static SNAPSHOT_IO: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, PartialEq)]
struct Identity {
    database: String,
    model: String,
    facts: String,
    dimension: usize,
    rule: String,
}

#[derive(Serialize, Deserialize)]
struct Header {
    identity: Identity,
    mean: Vec<f64>,
    #[serde(default)]
    alignment_quantiles: Vec<f64>,
    // Legacy snapshots have no baseline: conservatively score all live rows
    // as deltas until the next training, without silently rebuilding geometry.
    #[serde(default)]
    versions: std::collections::BTreeMap<i64, (i64, i64)>,
}

/// Sidecar of one trained snapshot: the converted tail of its index plus the version
/// of the tail node that represents each converted Chunk.
#[derive(Serialize, Deserialize)]
struct ConvertedHeader {
    base: String,
    versions: std::collections::BTreeMap<i64, (i64, i64)>,
}

pub(super) struct WarpedChunks {
    identity: Identity,
    mean: Vec<f64>,
    versions: std::collections::BTreeMap<i64, (i64, i64)>,
    alignment_quantiles: Vec<f64>,
    index: WarpedFieldIndex,
    // Converted since training. The trained fields above never change within a generation.
    converted: std::collections::BTreeMap<i64, (i64, i64)>,
    // Digest of the trained snapshot file, which binds the converted sidecar to it.
    base: String,
}

fn configuration() -> WarpedFieldConfig {
    WarpedFieldConfig {
        profile: WarpedProfile::Softening { alpha: 0.15 },
        radius_max: 0.65, mean_subtract_beta: 0.7,
        throat_phi0: 1.5, angular_scale_kappa: 2.0, adaptive_compass: true,
        ..Default::default()
    }
}

fn norm(row: &[f32]) -> Result<f64, String> {
    let n = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
    if row.iter().any(|v| !v.is_finite()) || !n.is_finite() || n <= 1e-12 {
        return Err("WARPED_CHUNK_INVALID_VECTOR".into());
    }
    Ok(n)
}

/// Residual from the global mean axis; experimental centrality, not Tag inbound mass.
fn radius(row: &[f32], mean: &[f64]) -> Result<f32, String> {
    let n = norm(row)?;
    let mn = mean.iter().map(|v| v * v).sum::<f64>().sqrt();
    let alignment = if mn > 1e-12 {
        row.iter().zip(mean).map(|(&v, &m)| v as f64 / n * m / mn).sum::<f64>()
    } else { 0.0 };
    Ok((0.35 + 0.30 * (1.0 - alignment.clamp(-1.0, 1.0).powi(2)).max(0.0).sqrt()) as f32)
}

fn alignment(row: &[f32], mean: &[f64]) -> Result<f64, String> {
    if row.len() != mean.len() { return Err("WARPED_CHUNK_DIMENSION".into()); }
    let n = norm(row)?;
    let mn = mean.iter().map(|v| v * v).sum::<f64>().sqrt();
    Ok(if mn > 1e-12 {
        row.iter().zip(mean).map(|(&v,&m)| v as f64 / n * m / mn)
            .sum::<f64>().abs().clamp(0.0, 1.0)
    } else { 0.0 })
}

fn quantile_knots(values: &[f64]) -> Vec<f64> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    (0..64).map(|i| {
        let position = i as f64 * sorted.len().saturating_sub(1) as f64 / 63.0;
        let lo = position.floor() as usize;
        let hi = position.ceil() as usize;
        sorted[lo] + (sorted[hi] - sorted[lo]) * position.fract()
    }).collect()
}

/// Piecewise empirical CDF; ties share the midpoint, never arbitrary ID ranks.
fn alignment_percentile(value: f64, knots: &[f64]) -> f64 {
    let lo = knots.partition_point(|&v| v < value);
    let hi = knots.partition_point(|&v| v <= value);
    if lo != hi { return (lo + hi - 1) as f64 / (2.0 * (knots.len() - 1) as f64); }
    if lo == 0 { return 0.0; }
    if lo == knots.len() { return 1.0; }
    ((lo - 1) as f64 + (value - knots[lo - 1]) / (knots[lo] - knots[lo - 1]))
        / (knots.len() - 1) as f64
}

fn quantile_radius(value: f64, knots: &[f64]) -> f32 {
    (0.35 + 0.30 * (1.0 - alignment_percentile(value, knots)).powf(1.10)) as f32
}

fn rerank_budget(limit: usize) -> usize {
    limit.saturating_mul(2).clamp(64, 256).max(limit)
}

fn read_vector(connection: &Connection, id: u64, dimension: usize) -> Result<Vec<f32>, String> {
    let mut vector = Vec::with_capacity(dimension);
    let valid = connection.prepare_cached("SELECT vector FROM chunks WHERE id=?1")
        .map_err(|e| e.to_string())?
        .query_row([id as i64], |row|
            crate::index_source::decode_column_into(row, 0, dimension, &mut vector))
        .map_err(|e| e.to_string())?;
    if !valid { return Err(format!("WARPED_CHUNK_INVALID_VECTOR: {id}")); }
    norm(&vector)?;
    Ok(vector)
}

fn rule_radius(rule: &str, mean: &[f64], quantiles: &[f64], row: &[f32]) -> Result<f32, String> {
    if rule == LEGACY_RULE { return radius(row, mean); }
    Ok(quantile_radius(alignment(row, mean)?, quantiles))
}

fn read_limited(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::File::open(path) {
        Ok(file) => {
            if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 {
                return Err("warped Chunk snapshot exceeds size limit".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            Ok(Some(bytes))
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn publish(path: &Path, bytes: Vec<u8>) -> Result<(), String> {
    let staging = crate::CheckpointStaging::new(path).map_err(|e| e.to_string())?;
    std::fs::write(staging.path(), bytes).map_err(|e| e.to_string())?;
    crate::sync_index_file(staging.path()).map_err(|e| e.to_string())?;
    crate::publish_index_file(staging.path(), path).map_err(|e| e.to_string())
}

/// A trained snapshot ends with the SHA-256 of its content; that digest names it.
fn snapshot_digest(bytes: &[u8]) -> String {
    bytes[bytes.len().saturating_sub(32)..].iter().map(|byte| format!("{byte:02x}")).collect()
}

impl WarpedChunks {
    fn radius(&self, row: &[f32]) -> Result<f32, String> {
        rule_radius(&self.identity.rule, &self.mean, &self.alignment_quantiles, row)
    }

    /// Version of the node that represents a Chunk: its converted tail node if any,
    /// otherwise the trained baseline.
    fn version(&self, id: i64) -> Option<&(i64, i64)> {
        self.converted.get(&id).or_else(|| self.versions.get(&id))
    }

    fn converted_path(identity: &Identity) -> Option<PathBuf> {
        Self::path(identity).map(|path| path.with_extension("vcpwi"))
    }

    /// Tail nodes the sidecar can still take: payload per node plus a bound for its
    /// version entry. Checked before converting, so a full sidecar never fails a query.
    fn conversion_room(&self) -> usize {
        let node = 48 + 16 * self.identity.dimension.div_ceil(64) + 72;
        ((CONVERTED_MAX_BYTES - 4096) / node)
            .saturating_sub(self.index.ids().len() - self.index.trained_len())
    }

    /// Converts live deltas into the frozen coordinates of this trained generation:
    /// same mean axis, radius rule and hot code as the trained nodes. Each original is
    /// read once. An invalid original fails the query exactly as exact delta scoring
    /// does, and a failed batch leaves the field unchanged.
    fn convert(&mut self, connection: &Connection, rows: &HashMap<i64, ChunkHeader>, ids: &[u64])
        -> Result<(), String> {
        let Self { identity, mean, alignment_quantiles, index, converted, .. } = self;
        let first = index.ids().len();
        let slots: Vec<_> = (first..first + ids.len()).collect();
        let mut failure = None;
        index.convert_batch(ids, &slots, |slot, output| {
            let loaded = read_vector(connection, ids[slot - first], identity.dimension)
                .and_then(|row| Ok((rule_radius(&identity.rule, mean, alignment_quantiles, &row)?, row)));
            match loaded {
                Ok((radius, row)) => { output.extend(row); Some(radius) },
                Err(error) => { failure = Some(error); None },
            }
        }).map_err(|e| failure.unwrap_or_else(|| e.to_string()))?;
        for &id in ids {
            let row = &rows[&(id as i64)];
            converted.insert(row.id, (row.vector_version, row.file_id));
        }
        Ok(())
    }

    /// The tail goes to its own file; the trained snapshot is never rewritten.
    fn publish_converted(&self) -> Result<(), String> {
        let Some(path) = Self::converted_path(&self.identity) else { return Ok(()); };
        let header = serde_json::to_vec(&ConvertedHeader {
            base: self.base.clone(), versions: self.converted.clone(),
        }).map_err(|e| e.to_string())?;
        let mut bytes = CONVERTED_MAGIC.to_vec();
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&self.index.converted_bytes());
        let digest = Sha256::digest(&bytes);
        bytes.extend_from_slice(&digest);
        if header.len() > MAX_HEADER_BYTES || bytes.len() > CONVERTED_MAX_BYTES {
            return Err("warped Chunk converted tail exceeds size limit".into());
        }
        let _io = SNAPSHOT_IO.lock().map_err(|e| e.to_string())?;
        publish(&path, bytes)
    }

    /// Replays the tail published for exactly this trained snapshot. A sidecar of another
    /// generation is stale and ignored; damage to a matching one is explicit.
    fn restore_converted(&mut self) -> Result<(), String> {
        let Some(bytes) = Self::converted_path(&self.identity)
            .map(|path| read_limited(&path)).transpose()?.flatten() else { return Ok(()); };
        if bytes.len() < 48 || &bytes[..8] != CONVERTED_MAGIC {
            return Err("warped Chunk converted tail magic/length".into());
        }
        let end = bytes.len() - 32;
        if Sha256::digest(&bytes[..end])[..] != bytes[end..] {
            return Err("warped Chunk converted tail digest mismatch".into());
        }
        let h = usize::try_from(u64::from_le_bytes(bytes[8..16].try_into().unwrap()))
            .ok().filter(|&h| h <= end - 16 && h <= MAX_HEADER_BYTES)
            .ok_or("warped Chunk converted tail header length")?;
        let header: ConvertedHeader = serde_json::from_slice(&bytes[16..16+h]).map_err(|e| e.to_string())?;
        if header.base != self.base { return Ok(()); }
        self.index.restore_converted(&bytes[16+h..end]).map_err(|e| e.to_string())?;
        let tail: HashSet<_> = self.index.ids()[self.index.trained_len()..].iter().copied().collect();
        // Originals are read at ids()[slot], so every cold slot must be its node number.
        if self.versions.is_empty() || !self.index.identity_slots() || tail.len() != header.versions.len()
            || tail.iter().any(|&id| id > i64::MAX as u64 || !header.versions.contains_key(&(id as i64))) {
            return Err("warped Chunk converted tail identity mismatch".into());
        }
        self.converted = header.versions;
        Ok(())
    }

    // Managed payload only; excludes BTree allocator/node bookkeeping and RSS.
    fn hot_bytes(&self) -> usize {
        self.index.hot_bytes() + self.mean.capacity() * std::mem::size_of::<f64>()
            + (self.versions.len() + self.converted.len()) * std::mem::size_of::<(i64, (i64, i64))>()
            + self.alignment_quantiles.capacity() * std::mem::size_of::<f64>()
    }

    fn path(identity: &Identity) -> Option<PathBuf> {
        if identity.database.is_empty() { return None; }
        let db = Path::new(&identity.database);
        let name = db.file_name()?.to_str()?;
        let digest = format!("{:x}", Sha256::digest(identity.model.as_bytes()));
        Some(db.with_file_name(format!("{name}.chunks-warped-{digest}.vcpwc")))
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let header = serde_json::to_vec(&Header {
            identity: Identity {
                database: self.identity.database.clone(), model: self.identity.model.clone(),
                facts: self.identity.facts.clone(), dimension: self.identity.dimension,
                rule: self.identity.rule.clone(),
            },
            mean: self.mean.clone(),
            versions: self.versions.clone(),
            alignment_quantiles: self.alignment_quantiles.clone(),
        }).map_err(|e| e.to_string())?;
        if header.len() > MAX_HEADER_BYTES {
            return Err("warped Chunk snapshot header exceeds size limit".into());
        }
        let payload = self.index.snapshot_bytes();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&payload);
        let digest = Sha256::digest(&bytes);
        bytes.extend_from_slice(&digest);
        if bytes.len() > MAX_BYTES { return Err("warped Chunk snapshot exceeds size limit".into()); }
        Ok(bytes)
    }

    fn decode(bytes: &[u8], expected: &Identity) -> Result<Option<Self>, String> {
        if bytes.len() < 48 || bytes.len() > MAX_BYTES || &bytes[..8] != MAGIC {
            return Err("warped Chunk snapshot magic/length".into());
        }
        let end = bytes.len() - 32;
        if Sha256::digest(&bytes[..end])[..] != bytes[end..] {
            return Err("warped Chunk snapshot digest mismatch".into());
        }
        let h = usize::try_from(u64::from_le_bytes(bytes[8..16].try_into().unwrap()))
            .map_err(|_| "warped Chunk header overflow")?;
        if h > MAX_HEADER_BYTES || h > end - 16 {
            return Err("warped Chunk snapshot header length".into());
        }
        let header: Header = serde_json::from_slice(&bytes[16..16+h]).map_err(|e| e.to_string())?;
        // Facts identify the TRAINING baseline, not the current live membership.
        // Daily writes must not turn a valid trained generation into a cache miss.
        if header.identity.database != expected.database || header.identity.model != expected.model
            || header.identity.dimension != expected.dimension
            || (header.identity.rule != expected.rule && header.identity.rule != LEGACY_RULE) {
            return Ok(None);
        }
        let index = WarpedFieldIndex::from_snapshot_bytes(&bytes[16+h..end])
            .map_err(|e| e.to_string())?;
        let valid_quantiles = if header.identity.rule == LEGACY_RULE {
            header.alignment_quantiles.is_empty()
        } else {
            header.alignment_quantiles.len() == 64
                && header.alignment_quantiles.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                && header.alignment_quantiles.windows(2).all(|w| w[0] <= w[1])
        };
        if !valid_quantiles || header.mean.len() != expected.dimension || header.mean.iter().any(|v| !v.is_finite())
            || index.dimension() != expected.dimension
            || index.ids().iter().any(|&id| id == 0 || id > i64::MAX as u64)
            || index.ids().windows(2).any(|w| w[0] >= w[1])
            || (!header.versions.is_empty() && (header.versions.len() != index.ids().len()
                || index.ids().iter().any(|&id| !header.versions.contains_key(&(id as i64)))))
            || index.configuration() != configuration() || index.shell_landmark_count() == 0 {
            return Err("warped Chunk snapshot identity/configuration mismatch".into());
        }
        Ok(Some(Self { identity: header.identity, mean: header.mean, versions: header.versions,
            alignment_quantiles: header.alignment_quantiles, index,
            converted: Default::default(), base: String::new() }))
    }

    fn load_or_build(connection: &Connection, identity: Identity, ids: &[u64], force: bool)
        -> Result<(Self, &'static str), String> {
        // Per-table lock is held by LightMemo. This also serializes sidecar publication
        // across independent runtime instances in this process (not across processes).
        let _io = SNAPSHOT_IO.lock().map_err(|e| e.to_string())?;
        let path = Self::path(&identity);
        if let Some(bytes) = path.as_ref().filter(|_| !force)
            .map(|path| read_limited(path)).transpose()?.flatten() {
            if let Some(mut field) = Self::decode(&bytes, &identity)? {
                field.base = snapshot_digest(&bytes);
                field.restore_converted()?;
                return Ok((field, "snapshot"));
            }
        }
        let mut mean = vec![0.0; identity.dimension];
        for &id in ids {
            let row = read_vector(connection, id, identity.dimension)?;
            let n = norm(&row)?;
            for (m, &v) in mean.iter_mut().zip(&row) { *m += v as f64 / n; }
        }
        for m in &mut mean { *m /= ids.len().max(1) as f64; }
        let alignments = ids.iter().map(|&id|
            alignment(&read_vector(connection, id, identity.dimension)?, &mean))
            .collect::<Result<Vec<_>, _>>()?;
        let alignment_quantiles = quantile_knots(&alignments);
        let radii: Vec<_> = alignments.iter()
            .map(|&a| quantile_radius(a, &alignment_quantiles)).collect();
        let slots: Vec<_> = (0..ids.len()).collect();
        let mut error = None;
        let mut index = WarpedFieldIndex::build(identity.dimension, ids, &slots, &radii,
            &mean, configuration(), |slot, output| {
                match read_vector(connection, ids[slot], identity.dimension) {
                    Ok(row) => { output.extend(row); true },
                    Err(e) => { error = Some(e); false },
                }
            }).map_err(|e| error.unwrap_or_else(|| e.to_string()))?;
        index.build_shell_landmarks();
        let mut versions = std::collections::BTreeMap::new();
        let mut statement = connection.prepare_cached(
            "SELECT vector_version,file_id FROM chunks WHERE id=?1").map_err(|e|e.to_string())?;
        for &id in ids {
            let version = statement.query_row([id as i64], |r| Ok((r.get(0)?,r.get(1)?)))
                .map_err(|e|e.to_string())?;
            versions.insert(id as i64, version);
        }
        let mut field = Self { identity, mean, versions, alignment_quantiles, index,
            converted: Default::default(), base: String::new() };
        if let Some(path) = path {
            let bytes = field.encode()?;
            field.base = snapshot_digest(&bytes);
            publish(&path, bytes)?;
            // A new trained generation supersedes the tail converted for the previous one.
            // Its digest already makes a leftover sidecar stale, so removal is best effort
            // and cannot turn a published training into a failure.
            let _ = std::fs::remove_file(path.with_extension("vcpwi"));
        }
        Ok((field, "built"))
    }
}

impl GlobalChunks {
    pub(crate) fn search_warped<P>(&mut self, connection: &Connection, query: &[f32],
        limit: usize, mut admits: P) -> Result<(Vec<(i64, f64)>, serde_json::Value), String>
    where P: FnMut(&ChunkHeader) -> bool {
        if connection.is_autocommit() || query.len() != self.dimension || limit == 0 || limit > 2000 {
            return Err("Invalid warped Chunk query contract".into());
        }
        norm(query)?;
        let started = Instant::now();
        let mut ids: Vec<_> = self.rows.keys().map(|&id| id as u64).collect();
        ids.sort_unstable();
        let allowed: HashSet<_> = self.rows.values().filter(|row| admits(row))
            .map(|row| row.id as u64).collect();
        if ids.is_empty() || allowed.is_empty() {
            return Ok((Vec::new(), serde_json::json!({
                "used":"warped_chunks","source":"empty","scopeChunks":allowed.len(),"rule":RULE,
                "nodes":ids.len(),"executed":false,
                "reason":if ids.is_empty() {"no_valid_global_chunks"} else {"scope_filter_empty"}
            })));
        }
        let prepared = self.prepare_warped(connection, false)?;
        let source = prepared["source"].as_str().unwrap_or("memory");
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        let field = self.warped.as_mut().unwrap();
        let mut delta: HashSet<_> = allowed.iter().copied().filter(|&id| {
            let row = &self.rows[&(id as i64)];
            field.version(row.id) != Some(&(row.vector_version, row.file_id))
        }).collect();
        // Bound the exact delta work of a query: beyond the buffer, the oldest in-scope
        // deltas are converted once and from then on scored from their hot codes. A
        // legacy snapshot has no version baseline and keeps conservative exact scoring.
        let converting = Instant::now();
        let mut converted_now = 0;
        if allowed.len() > 128 && delta.len() > CONVERT_ABOVE && !field.versions.is_empty() {
            let mut batch: Vec<_> = delta.iter().copied().collect();
            batch.sort_unstable();
            batch.truncate(CONVERT_BATCH.min(field.conversion_room()));
            if !batch.is_empty() {
                field.convert(connection, &self.rows, &batch)?;
                if let Err(error) = field.publish_converted() {
                    // Memory must not run ahead of the published tail: reload on the next query.
                    self.warped = None;
                    return Err(error);
                }
                for id in &batch { delta.remove(id); }
                converted_now = batch.len();
            }
        }
        let convert_ms = converting.elapsed().as_secs_f64() * 1000.0;
        let field = self.warped.as_ref().unwrap();
        let qr = field.radius(query)?;
        let (max_visits, max_expansions) = warped_size_budget(field.index.trained_len());
        let mut diagnostics = serde_json::json!({
            "used":"warped_chunks","source":source,"rule":field.identity.rule,"nodes":field.index.trained_len(),
            "convertedNodes":field.index.ids().len() - field.index.trained_len(),
            "retiredNodes":field.index.retired_count(),"convertedNow":converted_now,"convertMs":convert_ms,
            "rerankBudget":rerank_budget(limit),
            "liveNodes":ids.len(),"deltaChunks":delta.len(),"geometryFacts":field.identity.facts,
            "scopeChunks":allowed.len(),"queryRadius":qr,"geometryCheckMs":load_ms,
            "candidateBudget":limit,"hotBytes":field.hot_bytes(),
            "facts":self.facts,"fallback":false
        });
        // A tiny scope is cheaper and more reliable than walking a mostly excluded graph.
        let hits = if allowed.len() <= 128 {
            let mut hits = Vec::with_capacity(allowed.len());
            for &id in &allowed {
                let row = read_vector(connection, id, self.dimension)?;
                let distance = field.index.exact_distance_at_radius(query, qr, &row,
                    field.radius(&row)?).map_err(|e| e.to_string())?;
                hits.push((id, distance));
            }
            hits.sort_by(|a,b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            hits.truncate(limit);
            diagnostics["path"] = serde_json::json!("scope-exact-warped");
            diagnostics["coldReads"] = serde_json::json!(allowed.len());
            hits
        } else {
            let mut error = None;
            let output = field.index.search_chunks(query, qr, HyperbolicSearchConfig {
                top_k: limit, width: 128.max(limit * 2), rerank_limit: rerank_budget(limit),
                max_visits: max_visits.max(limit * 4),
                max_expansions: max_expansions.max(limit * 2), radial_bound: true,
            }, None, |id| !allowed.contains(&id) || delta.contains(&id), |slot, output| {
                match read_vector(connection, field.index.ids()[slot], self.dimension) {
                    Ok(row) => { output.extend(row); true },
                    Err(e) => { error = Some(e); false },
                }
            }).map_err(|e| e.to_string())?;
            if let Some(error) = error { return Err(error); }
            diagnostics["path"] = serde_json::json!("global-warped-ann");
            diagnostics["visited"] = serde_json::json!(output.stats.visited);
            diagnostics["expanded"] = serde_json::json!(output.stats.expanded);
            diagnostics["convertedScored"] = serde_json::json!(output.stats.converted_scored);
            diagnostics["coldReads"] = serde_json::json!(output.stats.cold_reads + delta.len() + converted_now);
            // Only live vector deltas read originals here. Memory stays bounded
            // by the candidate budget; no FP32 corpus and no per-write graph build.
            let mut hits = output.neighbors;
            for &id in &delta {
                let row = read_vector(connection, id, self.dimension)?;
                let distance = field.index.exact_distance_at_radius(query, qr, &row,
                    field.radius(&row)?).map_err(|e|e.to_string())?;
                let hit = (id, distance);
                let position = hits.binary_search_by(|other|
                    other.1.total_cmp(&distance).then(other.0.cmp(&id))).unwrap_or_else(|p|p);
                if position < limit {
                    hits.insert(position, hit);
                    hits.truncate(limit);
                }
            }
            hits
        };
        diagnostics["totalMs"] = serde_json::json!(started.elapsed().as_secs_f64() * 1000.0);
        diagnostics["returned"] = serde_json::json!(hits.len());
        Ok((hits.into_iter().map(|(id,d)| (id as i64,d)).collect(), diagnostics))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantile_radius_spreads_narrow_alignment_and_handles_ties() {
        let values: Vec<_> = (0..1000).map(|i| 0.35 + 0.2 * i as f64 / 999.0).collect();
        let knots = quantile_knots(&values);
        let radii: Vec<_> = values.iter().map(|&v| quantile_radius(v, &knots)).collect();
        assert!((radii[0] - 0.65).abs() < 1e-6);
        assert!((radii[999] - 0.35).abs() < 1e-6);
        assert!(radii.windows(2).all(|w| w[0] >= w[1]));
        assert_eq!(alignment_percentile(0.0, &knots), 0.0);
        assert_eq!(alignment_percentile(1.0, &knots), 1.0);
        for count in [1, 10] {
            let tied = quantile_knots(&vec![0.5; count]);
            assert_eq!(alignment_percentile(0.5, &tied), 0.5);
            assert!(quantile_radius(0.5, &tied).is_finite());
        }
        for limit in 1..=2000 {
            let budget = rerank_budget(limit);
            assert!(budget >= limit && budget <= 2000);
        }
        assert_eq!(rerank_budget(30), 64);
        assert_eq!(rerank_budget(100), 200);
        assert_eq!(rerank_budget(200), 256);
    }

    #[test]
    fn quantiles_persist_validate_and_legacy_geometry_is_not_rebuilt() {
        let db = fixture(160);
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let field = table.warped.as_mut().unwrap();
        let original = field.encode().unwrap();
        let restored = WarpedChunks::decode(&original, &field.identity).unwrap().unwrap();
        for id in 1..=160 {
            let row = vector(id);
            assert_eq!(field.radius(&row).unwrap(), restored.radius(&row).unwrap());
        }
        field.alignment_quantiles.swap(0, 63);
        assert!(WarpedChunks::decode(&field.encode().unwrap(), &field.identity).is_err());
        field.alignment_quantiles = restored.alignment_quantiles;
        field.identity.rule = LEGACY_RULE.into();
        field.alignment_quantiles.clear();
        let ids = field.index.ids().to_vec();
        let radii: Vec<_> = ids.iter().map(|&id| radius(&vector(id as usize), &field.mean).unwrap()).collect();
        field.index = WarpedFieldIndex::build(8, &ids, &(0..ids.len()).collect::<Vec<_>>(),
            &radii, &field.mean, configuration(), |slot, out| {
                out.extend(vector(ids[slot] as usize)); true
            }).unwrap();
        field.index.build_shell_landmarks();
        let expected = Identity { database: field.identity.database.clone(), model: "test".into(),
            facts: "99".into(), dimension: 8, rule: RULE.into() };
        let legacy = WarpedChunks::decode(&field.encode().unwrap(), &expected).unwrap().unwrap();
        assert_eq!(legacy.identity.rule, LEGACY_RULE);
        assert_eq!(legacy.radius(&vector(997)).unwrap(), radius(&vector(997), &legacy.mean).unwrap());
        table.warped = Some(legacy);
        assert_eq!(table.prepare_warped(&db, false).unwrap()["rule"], LEGACY_RULE);
        assert_eq!(table.prepare_warped(&db, true).unwrap()["rule"], RULE);
    }

    fn fixture(count: usize) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES('global_chunk_facts','1');
             CREATE TABLE files(id INTEGER PRIMARY KEY,diary_name TEXT,metadata_version INTEGER);
             INSERT INTO files VALUES(1,'A',1),(2,'B',1);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,content TEXT,vector BLOB,
                 vector_version INTEGER,metadata_version INTEGER);"
        ).unwrap();
        for id in 1..=count {
            let row = vector(id);
            let bytes: Vec<_> = row.iter().flat_map(|v|v.to_le_bytes()).collect();
            db.execute("INSERT INTO chunks VALUES(?1,?2,'[2026-11-17] Alice',?3,1,1)",
                rusqlite::params![id as i64, if id % 2 == 0 {1} else {2}, bytes]).unwrap();
        }
        db.execute_batch("BEGIN").unwrap();
        db
    }

    fn vector(id: usize) -> Vec<f32> {
        (0..8).map(|j| ((id * 71 + j * 17 + 1) as f64 * 0.37).sin() as f32).collect()
    }

    #[test]
    fn global_geometry_scope_ann_large_budget_snapshot_and_mutations() {
        let db = fixture(160);
        let mut table = GlobalChunks::empty(8,"test").unwrap();
        table.synchronize(&db).unwrap();
        let query = vector(137);
        let (all, stats) = table.search_warped(&db,&query,100,|_|true).unwrap();
        assert_eq!(stats["path"],"global-warped-ann");
        assert_eq!(stats["source"],"built");
        assert_eq!(all.len(),100);
        assert!(all.windows(2).all(|w|w[0].1 <= w[1].1));
        let (scoped, stats) = table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap();
        assert_eq!(stats["path"],"scope-exact-warped");
        assert_eq!(stats["source"],"memory");
        assert_eq!(scoped.len(),80);
        assert!(scoped.iter().all(|h|h.0 % 2 == 0));
        let field = table.warped.as_ref().unwrap();
        let bytes = field.encode().unwrap();
        let restored = WarpedChunks::decode(&bytes,&field.identity).unwrap().unwrap();
        assert_eq!(bytes,restored.encode().unwrap());
        let mut damaged = bytes.clone();
        damaged[32] ^= 1;
        assert!(WarpedChunks::decode(&damaged,&field.identity).is_err());
        table.warped = Some(restored);
        assert_eq!(scoped, table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap().0);
        db.execute_batch(
            "DELETE FROM chunks WHERE id=2;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        assert_eq!(table.synchronize(&db).unwrap(),1);
        assert!(table.warped.is_some());
        let (updated,stats) = table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap();
        assert_eq!(stats["source"],"memory");
        assert_eq!(stats["geometryFacts"],"1");
        assert_eq!(updated.len(),79);
        assert!(updated.iter().all(|h|h.0!=2));
        assert!(table.search_warped(&db,&[f32::NAN;8],10,|_|true).is_err());
        assert!(table.search_warped(&db,&query,2001,|_|true).is_err());
    }

    #[test]
    fn daily_deltas_restart_and_compaction_preserve_trained_geometry_until_training() {
        let root = std::env::temp_dir().join(format!("warped-generation-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source = fixture(160);
        source.execute_batch("COMMIT").unwrap();
        let path = root.join("test.sqlite");
        source.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let field = table.warped.as_ref().unwrap();
        let sidecar = WarpedChunks::path(&field.identity).unwrap();
        let original = std::fs::read(&sidecar).unwrap();
        let modified = std::fs::metadata(&sidecar).unwrap().modified().unwrap();
        let frozen = field.encode().unwrap();
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        db.execute_batch("DELETE FROM chunks WHERE id=2").unwrap();
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        db.execute("INSERT INTO chunks VALUES(161,2,'[2026-11-17] new',?1,1,1)", [&bytes]).unwrap();
        db.execute_batch(
            "UPDATE chunks SET content='metadata only',metadata_version=2 WHERE id=4;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (expected, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["path"], "global-warped-ann");
        assert_eq!(stats["deltaChunks"], 2);
        assert_eq!(stats["geometryFacts"], "1");
        assert_eq!(stats["facts"], "2");
        assert!(expected.iter().any(|h|h.0==3));
        assert!(expected.iter().any(|h|h.0==161));
        assert!(!expected.iter().any(|h|h.0==2));
        assert_eq!(expected[0].0, 3);
        assert_eq!(expected[1].0, 161);
        assert_eq!(table.warped.as_ref().unwrap().encode().unwrap(), frozen);
        let (scoped, stats) = table.search_warped(&db, &query, 100, |r|r.diary=="B").unwrap();
        assert_eq!(stats["path"], "scope-exact-warped");
        assert!(scoped.iter().any(|h|h.0==161));
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);
        assert_eq!(std::fs::metadata(&sidecar).unwrap().modified().unwrap(), modified);

        db.execute_batch("COMMIT").unwrap();
        drop(table);
        drop(db);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut restored = GlobalChunks::empty(8, "test").unwrap();
        restored.synchronize(&db).unwrap();
        let (actual, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "snapshot");
        assert_eq!(expected, actual);
        assert_eq!(restored.warped.as_ref().unwrap().encode().unwrap(), frozen);
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);
        assert_eq!(std::fs::metadata(&sidecar).unwrap().modified().unwrap(), modified);

        // Routing compaction must not reset the field or its baseline.
        db.execute_batch(
            "UPDATE chunks SET vector_version=vector_version+1 WHERE id<=100;
             UPDATE kbm_runtime_meta SET value='3' WHERE key='global_chunk_facts';"
        ).unwrap();
        restored.synchronize(&db).unwrap();
        let before = restored.routing.len();
        restored.compact_if_needed(&db).unwrap();
        assert!(restored.routing.len() < before);
        assert_eq!(restored.warped.as_ref().unwrap().encode().unwrap(), frozen);
        let (_, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["geometryFacts"], "1");
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);

        let trained = restored.prepare_warped(&db, true).unwrap();
        assert_eq!(trained["source"], "built");
        assert_eq!(trained["geometryFacts"], "3");
        assert_ne!(std::fs::read(&sidecar).unwrap(), original);
        let (_, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["deltaChunks"], 0);
        drop(restored);
        drop(db);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_baseline_is_conservative_and_invalid_version_coverage_is_rejected() {
        let db = fixture(160);
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let field = table.warped.as_ref().unwrap();
        let original = field.encode().unwrap();
        let h = u64::from_le_bytes(original[8..16].try_into().unwrap()) as usize;
        let mut header: serde_json::Value = serde_json::from_slice(&original[16..16+h]).unwrap();
        header.as_object_mut().unwrap().remove("versions");
        let header = serde_json::to_vec(&header).unwrap();
        let mut legacy = MAGIC.to_vec();
        legacy.extend_from_slice(&(header.len() as u64).to_le_bytes());
        legacy.extend_from_slice(&header);
        legacy.extend_from_slice(&original[16+h..original.len()-32]);
        let digest = Sha256::digest(&legacy);
        legacy.extend_from_slice(&digest);
        let restored = WarpedChunks::decode(&legacy, &field.identity).unwrap().unwrap();
        assert!(restored.versions.is_empty());
        assert_eq!(restored.mean, field.mean);
        table.warped = Some(restored);
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        db.execute_batch(
            "DELETE FROM chunks WHERE id=2;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["deltaChunks"], 159);
        assert_eq!(hits[0].0, 3);
        assert!(!hits.iter().any(|h|h.0==2));
        table.prepare_warped(&db, true).unwrap();
        let field = table.warped.as_mut().unwrap();
        field.versions.pop_first();
        assert!(WarpedChunks::decode(&field.encode().unwrap(), &field.identity).is_err());
    }

    #[test]
    fn empty_singleton_and_file_snapshot_restore() {
        for count in [0,1] {
            let db=fixture(count);
            let mut table=GlobalChunks::empty(8,"test").unwrap();
            table.synchronize(&db).unwrap();
            assert_eq!(table.search_warped(&db,&vector(1),5,|_|true).unwrap().0.len(),count);
        }
        let root=std::env::temp_dir().join(format!("warped-chunks-{}-{}",
            std::process::id(),std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source=fixture(24);
        source.execute_batch("COMMIT").unwrap();
        let path=root.join("test.sqlite");
        source.execute("VACUUM INTO ?1",[path.to_str().unwrap()]).unwrap();
        let db=Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let run=|table:&mut GlobalChunks| {
            table.synchronize(&db).unwrap();
            table.search_warped(&db,&vector(3),10,|_|true).unwrap()
        };
        let mut first=GlobalChunks::empty(8,"test").unwrap();
        let (expected,stats)=run(&mut first);
        assert_eq!(stats["source"],"built");
        let mut second=GlobalChunks::empty(8,"test").unwrap();
        let (actual,stats)=run(&mut second);
        assert_eq!(stats["source"],"snapshot");
        assert_eq!(expected,actual);
        assert_eq!(second.prepare_warped(&db,false).unwrap()["source"],"memory");
        assert_eq!(second.prepare_warped(&db,true).unwrap()["source"],"built");
        let sidecar = WarpedChunks::path(&second.warped.as_ref().unwrap().identity).unwrap();
        std::fs::write(&sidecar,b"damaged-derived-file").unwrap();
        let mut repair = GlobalChunks::empty(8,"test").unwrap();
        repair.synchronize(&db).unwrap();
        assert!(repair.prepare_warped(&db,false).is_err());
        assert_eq!(repair.prepare_warped(&db,true).unwrap()["source"],"built");
        assert_eq!(repair.search_warped(&db,&vector(3),10,|_|true).unwrap().0,expected);
        db.execute_batch(
            "UPDATE chunks SET metadata_version=2 WHERE id=3;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        assert_eq!(run(&mut second).1["source"],"memory");
        drop(first);drop(second);drop(db);drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn add(db: &Connection, ids: std::ops::RangeInclusive<usize>, facts: &str) {
        for id in ids {
            let bytes: Vec<_> = vector(id).iter().flat_map(|v|v.to_le_bytes()).collect();
            db.execute("INSERT INTO chunks VALUES(?1,?2,'[2026-11-17] new',?3,1,1)",
                rusqlite::params![id as i64, if id % 2 == 0 {1} else {2}, bytes]).unwrap();
        }
        db.execute("UPDATE kbm_runtime_meta SET value=?1 WHERE key='global_chunk_facts'", [facts]).unwrap();
    }

    /// Independent truth: every live original scored exactly in the frozen coordinates.
    fn exact(table: &GlobalChunks, db: &Connection, query: &[f32]) -> Vec<(i64, f64)> {
        let field = table.warped.as_ref().unwrap();
        let qr = field.radius(query).unwrap();
        let mut all: Vec<_> = table.rows.keys().map(|&id| {
            let row = read_vector(db, id as u64, 8).unwrap();
            (id, field.index.exact_distance_at_radius(query, qr, &row, field.radius(&row).unwrap()).unwrap())
        }).collect();
        all.sort_by(|a,b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        all
    }

    fn numbers(stats: &serde_json::Value, keys: &[&str]) -> Vec<u64> {
        keys.iter().map(|key| stats[key].as_u64().unwrap()).collect()
    }

    /// Every hit carries the exact score of its current original, in ascending order.
    fn assert_exact(table: &GlobalChunks, db: &Connection, query: &[f32], hits: &[(i64, f64)], live: usize) {
        let truth = exact(table, db, query);
        assert_eq!(truth.len(), live);
        for hit in hits {
            let expected = truth.iter().find(|row| row.0 == hit.0).unwrap();
            assert_eq!(hit.1.to_bits(), expected.1.to_bits());
        }
        assert!(hits.windows(2).all(|w| w[0].1 <= w[1].1));
    }

    #[test]
    fn deltas_beyond_the_buffer_are_converted_once_and_keep_their_exact_scores() {
        let db = fixture(200);
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let frozen = table.warped.as_ref().unwrap().encode().unwrap();
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        add(&db, 201..=1300, "2");
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        db.execute_batch("DELETE FROM chunks WHERE id=2").unwrap();
        table.synchronize(&db).unwrap();
        let keys = ["deltaChunks", "convertedNow", "convertedNodes", "retiredNodes", "nodes"];
        // A tiny scope, and a scope whose deltas fit the buffer, keep exact delta scoring.
        let (_, stats) = table.search_warped(&db, &query, 10,
            |r| r.id <= 60 || (201..=260).contains(&r.id)).unwrap();
        assert_eq!(stats["path"], "scope-exact-warped");
        assert_eq!(numbers(&stats, &keys), [61, 0, 0, 0, 200]);
        let (_, stats) = table.search_warped(&db, &query, 10,
            |r| r.id <= 180 || (201..=231).contains(&r.id)).unwrap();
        assert_eq!(stats["path"], "global-warped-ann");
        assert_eq!(numbers(&stats, &keys), [CONVERT_ABOVE as u64, 0, 0, 0, 200]);
        // 1101 global deltas: one query converts the oldest CONVERT_BATCH, the next the rest.
        let (_, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [77, CONVERT_BATCH as u64, CONVERT_BATCH as u64, 1, 200]);
        let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [0, 77, 1101, 1, 200]);
        let (again, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [0, 0, 1101, 1, 200]);
        assert_eq!(stats["source"], "memory");
        // No per-query delta reads remain: originals are touched only inside the rerank
        // budget, while every converted node is still scored from its hot code.
        assert!(stats["coldReads"].as_u64().unwrap() <= rerank_budget(100) as u64);
        assert_eq!(stats["convertedScored"], 1101);
        assert_eq!(hits, again);
        // Converted nodes return exactly the score that exact delta scoring gave them.
        assert_exact(&table, &db, &query, &hits, 1299);
        assert_eq!((hits[0].0, hits.iter().filter(|hit| hit.0 == 3).count()), (3, 1));
        assert!(!hits.iter().any(|hit| hit.0 == 2));
        assert!(hits.iter().any(|hit| hit.0 > 200));
        // A converted Chunk that changes again is a delta once more: its tail node stops
        // answering and the new original is scored exactly. A deleted one disappears.
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=250", [&bytes]).unwrap();
        db.execute_batch(
            "DELETE FROM chunks WHERE id=251;
             UPDATE kbm_runtime_meta SET value='3' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [1, 0, 1101, 1, 200]);
        assert_exact(&table, &db, &query, &hits, 1298);
        assert_eq!((hits[0].0, hits[1].0, hits.iter().filter(|hit| hit.0 == 250).count()), (3, 250, 1));
        assert!(!hits.iter().any(|hit| hit.0 == 251));
        // Beyond the buffer the changed Chunks are converted again and their older tail
        // nodes retire, so each identity is still answered by exactly one node.
        db.execute_batch(
            "UPDATE chunks SET vector_version=vector_version+1 WHERE id BETWEEN 300 AND 339;
             UPDATE kbm_runtime_meta SET value='4' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [0, 41, 1142, 42, 200]);
        assert_exact(&table, &db, &query, &hits, 1298);
        assert_eq!((hits[0].0, hits[1].0), (3, 250));
        let mut returned: Vec<_> = hits.iter().map(|hit| hit.0).collect();
        returned.sort_unstable();
        returned.dedup();
        assert_eq!(returned.len(), hits.len());
        // The trained generation, and therefore its snapshot, is still byte-identical.
        assert_eq!(table.warped.as_ref().unwrap().encode().unwrap(), frozen);
        // Explicit training folds every converted node into a fresh generation.
        assert_eq!(table.prepare_warped(&db, true).unwrap()["nodes"], 1298);
        let (_, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &keys), [0, 0, 0, 0, 1298]);
    }

    #[test]
    fn a_full_sidecar_stops_conversion_and_exact_scoring_takes_over() {
        let root = std::env::temp_dir().join(format!("warped-converted-full-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source = fixture(200);
        source.execute_batch("COMMIT").unwrap();
        let path = root.join("test.sqlite");
        source.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let room = table.warped.as_ref().unwrap().conversion_room();
        assert!(room > CONVERT_BATCH && room < 2 * CONVERT_BATCH);
        add(&db, 201..=2400, "2");
        table.synchronize(&db).unwrap();
        let query = vector(997);
        let keys = ["deltaChunks", "convertedNow", "convertedNodes"];
        let mut last = Vec::new();
        // Two queries fill the sidecar; later ones convert nothing, still succeed and
        // still score the 2200 - room deltas that did not fit exactly.
        for (round, expected) in [[2200 - CONVERT_BATCH, CONVERT_BATCH, CONVERT_BATCH],
            [2200 - room, room - CONVERT_BATCH, room], [2200 - room, 0, room], [2200 - room, 0, room]]
            .into_iter().enumerate() {
            let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
            assert_eq!(numbers(&stats, &keys), expected.map(|v| v as u64), "round {round}");
            assert_exact(&table, &db, &query, &hits, 2400);
            if round == 3 { assert_eq!(hits, last); }
            last = hits;
        }
        let identity = &table.warped.as_ref().unwrap().identity;
        let sidecar = WarpedChunks::converted_path(identity).unwrap();
        assert!(std::fs::metadata(&sidecar).unwrap().len() as usize <= CONVERTED_MAX_BYTES);
        db.execute_batch("COMMIT").unwrap();
        drop(table);
        drop(db);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut restored = GlobalChunks::empty(8, "test").unwrap();
        restored.synchronize(&db).unwrap();
        let (hits, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "snapshot");
        assert_eq!(numbers(&stats, &keys), [2200 - room, 0, room].map(|v| v as u64));
        assert_eq!(hits, last);
        drop(restored);drop(db);drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn converted_tail_survives_restart_and_never_rewrites_the_trained_snapshot() {
        let root = std::env::temp_dir().join(format!("warped-converted-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source = fixture(200);
        source.execute_batch("COMMIT").unwrap();
        let path = root.join("test.sqlite");
        source.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let open = |db: &Connection| {
            let mut table = GlobalChunks::empty(8, "test").unwrap();
            table.synchronize(db).unwrap();
            table
        };
        let mut table = open(&db);
        table.prepare_warped(&db, false).unwrap();
        let identity = &table.warped.as_ref().unwrap().identity;
        let (trained_path, converted_path) =
            (WarpedChunks::path(identity).unwrap(), WarpedChunks::converted_path(identity).unwrap());
        let identity = Identity { database: identity.database.clone(), model: "test".into(),
            facts: "2".into(), dimension: 8, rule: RULE.into() };
        let trained = std::fs::read(&trained_path).unwrap();
        let modified = std::fs::metadata(&trained_path).unwrap().modified().unwrap();
        assert!(!converted_path.exists());
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        add(&db, 201..=240, "2");
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        table.synchronize(&db).unwrap();
        let (expected, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(numbers(&stats, &["convertedNow", "retiredNodes", "deltaChunks"]), [41, 1, 0]);
        assert_eq!(stats["geometryFacts"], "1");
        assert!(converted_path.exists());
        assert_eq!(std::fs::read(&trained_path).unwrap(), trained);
        assert_eq!(std::fs::metadata(&trained_path).unwrap().modified().unwrap(), modified);
        // A release that only knows the trained snapshot still loads the same generation.
        assert_eq!(WarpedChunks::decode(&trained, &identity).unwrap().unwrap().index.ids().len(), 200);
        db.execute_batch("COMMIT").unwrap();
        drop(table);
        drop(db);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut restored = open(&db);
        let (actual, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "snapshot");
        assert_eq!(numbers(&stats, &["deltaChunks", "convertedNow", "convertedNodes", "retiredNodes"]), [0, 0, 41, 1]);
        assert_eq!(expected, actual);
        let sidecar = std::fs::read(&converted_path).unwrap();
        // Originals are read at ids()[slot]: a sidecar whose cold slots are not the node
        // numbers is rejected even though its digest is valid.
        let header = u64::from_le_bytes(sidecar[8..16].try_into().unwrap()) as usize;
        let mut remapped = sidecar[..sidecar.len() - 32].to_vec();
        remapped[16 + header + 16..16 + header + 24].copy_from_slice(&9999u64.to_le_bytes());
        let digest = Sha256::digest(&remapped);
        remapped.extend_from_slice(&digest);
        std::fs::write(&converted_path, remapped).unwrap();
        assert!(open(&db).prepare_warped(&db, false).is_err());
        // Damage to the sidecar of the current generation is explicit; training repairs it.
        let mut damaged = sidecar.clone();
        damaged[40] ^= 1;
        std::fs::write(&converted_path, damaged).unwrap();
        let mut broken = open(&db);
        assert!(broken.prepare_warped(&db, false).is_err());
        assert_eq!(broken.prepare_warped(&db, true).unwrap()["source"], "built");
        assert!(!converted_path.exists());
        assert_ne!(std::fs::read(&trained_path).unwrap(), trained);
        // A sidecar left by an earlier generation is stale: ignored, never an error.
        std::fs::write(&converted_path, sidecar).unwrap();
        let mut stale = open(&db);
        let prepared = stale.prepare_warped(&db, false).unwrap();
        assert_eq!((&prepared["source"], &prepared["nodes"]),
            (&serde_json::json!("snapshot"), &serde_json::json!(240)));
        assert_eq!(stale.warped_stats()["convertedNodes"], 0);
        drop(stale);drop(broken);drop(restored);drop(db);drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}

impl GlobalChunks {
    pub(crate) fn prepare_warped(&mut self, connection: &Connection, force: bool)
        -> Result<serde_json::Value, String> {
        if connection.is_autocommit() { return Err("warped preparation requires a read transaction".into()); }
        let started = Instant::now();
        let mut ids: Vec<_> = self.rows.keys().map(|&id|id as u64).collect();
        ids.sort_unstable();
        if ids.is_empty() {
            // An empty live scope does not retire the mathematical generation.
            return Ok(serde_json::json!({
                "ready":false,"source":"empty","nodes":0,"reason":"no_valid_global_chunks","forced":force
            }));
        }
        let source = if self.warped.is_some() && !force { "memory" } else {
            let database = connection.query_row("PRAGMA database_list", [], |r|r.get(2))
                .map_err(|e|e.to_string())?;
            let identity = Identity { database, model:self.model.clone(),facts:self.facts.clone(),
                dimension:self.dimension,rule:RULE.into() };
            let (field,source) = WarpedChunks::load_or_build(connection,identity,&ids,force)?;
            self.warped = Some(field);
            source
        };
        Ok(serde_json::json!({
            "ready":true,"source":source,"nodes":self.warped.as_ref().unwrap().index.trained_len(),
            "liveNodes":ids.len(),"rule":self.warped.as_ref().unwrap().identity.rule,"forced":force,
            "facts":self.facts,"geometryFacts":self.warped.as_ref().unwrap().identity.facts,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.,
            "hotBytes":self.warped.as_ref().unwrap().hot_bytes()
        }))
    }

    pub(crate) fn warped_stats(&self) -> serde_json::Value {
        match self.warped.as_ref() {
            Some(field) => serde_json::json!({
                "resident":true,"nodes":field.index.trained_len(),"rule":field.identity.rule,
                "convertedNodes":field.index.ids().len() - field.index.trained_len(),
                "retiredNodes":field.index.retired_count(),
                "hotBytes":field.hot_bytes(),
                "facts":field.identity.facts
            }),
            None => serde_json::json!({"resident":false,"nodes":0,"hotBytes":0,"rule":RULE}),
        }
    }
}
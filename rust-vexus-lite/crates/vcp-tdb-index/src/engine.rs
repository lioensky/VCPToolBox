//! VCP-PATCH: retrieval-only index. Mathematical consumers must read SQL.
use crate::asset::{self, AssetIdentity, VectorAsset};
use crate::{QuIVer, QuIVerConfig, QuIVerSearchConfig};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io;
use std::path::Path;

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

pub const QUIVER_MIN_NODES: usize = 2048;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub struct TdbIndex {
    dimension: usize,
    base: Option<VectorAsset>,
    ids: Vec<u64>,
    positions: HashMap<u64, usize>,
    // Overrides also cover updated base slots. Removed rows are reclaimed.
    delta: HashMap<usize, Vec<f32>>,
    free: Vec<usize>,
    graph: Option<QuIVer>,
    random: u64,
}

impl TdbIndex {
    pub fn empty(dimension: usize) -> io::Result<Self> {
        if dimension == 0 || dimension > crate::index::bq::MAX_BQ_DIM {
            return Err(invalid(&format!(
                "index dimension must be within 1..={}", crate::index::bq::MAX_BQ_DIM
            )));
        }
        Ok(Self {
            dimension, base: None, ids: Vec::new(), positions: HashMap::new(),
            delta: HashMap::new(), free: Vec::new(), graph: None, random: 12345,
        })
    }

    /// Stream SQL originals into a new private staging asset, then build routing.
    /// No full f32 matrix is retained in the heap. Publication remains host-owned.
    /// The staging path must remain immutable for the returned index's lifetime.
    pub fn rebuild_from_source<F>(
        path: &Path,
        identity: &AssetIdentity,
        ids: &[u64],
        fill: F,
    ) -> io::Result<Self>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        asset::write_staging(path, identity, ids, &[], &[], fill)?;
        let result = (|| {
            let mut index = Self::load_snapshot(path, identity)?;
            index.rebuild_graph()?;
            Ok(index)
        })();
        // On error, the closure has already dropped any mmap before cleanup.
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    /// Build only in-memory routing from a frozen authoritative source.
    /// Originals remain owned by the host; this method performs no file I/O.
    pub fn routing_from_source<F>(
        dimension: usize,
        ids: &[u64],
        mut fill: F,
    ) -> io::Result<Self>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        let mut index = Self::empty(dimension)?;
        if ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64)
            || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(invalid("invalid routing source identities"));
        }
        index.reserve(ids.len())?;
        index.ids.extend_from_slice(ids);
        index.positions.extend(ids.iter().enumerate().map(|(slot, id)| (*id, slot)));
        if ids.len() >= QUIVER_MIN_NODES {
            let slots: Vec<usize> = (0..ids.len()).collect();
            let config = QuIVerConfig::default();
            let mut graph = QuIVer::new(dimension, &config);
            graph.rebuild_from_cold_slots(ids, &slots, &config, &mut fill)?;
            index.graph = Some(graph);
        }
        Ok(index)
    }

    /// Keep restored routing, but release snapshot originals and mutable rows.
    /// Subsequent queries must use search_with_source.
    pub fn release_originals(&mut self) {
        self.base = None;
        self.delta.clear();
        self.delta.shrink_to_fit();
    }

    pub fn dimension(&self) -> usize { self.dimension }
    pub fn len(&self) -> usize { self.positions.len() }
    pub fn is_empty(&self) -> bool { self.positions.is_empty() }
    pub fn contains(&self, id: u64) -> bool { self.positions.contains_key(&id) }
    pub fn mapped_bytes(&self) -> usize { self.base.as_ref().map_or(0, VectorAsset::mapped_bytes) }
    pub fn delta_bytes(&self) -> usize {
        self.delta.values().map(|row| row.capacity() * 4).sum()
    }
    pub fn hot_bytes(&self) -> usize {
        self.delta_bytes() + self.ids.capacity() * 8 + self.free.capacity() * 8
            + self.positions.capacity() * 24 + self.delta.capacity() * 40
            + self.graph.as_ref().map_or(0, |graph| graph.stats().hot_bytes)
    }
    pub fn tombstones(&self) -> usize {
        self.graph.as_ref().map_or(self.free.len(), |graph| graph.stats().tombstone_count)
    }
    pub fn needs_graph_rebuild(&self) -> bool {
        // Existing graphs still need compaction after mass deletion drops
        // the live scope below the graph threshold; rebuilding then uses flat.
        self.graph.as_ref().map_or(
            self.len() >= QUIVER_MIN_NODES,
            QuIVer::needs_rebuild,
        )
    }
    pub fn reserve(&mut self, additional: usize) -> io::Result<()> {
        self.ids.try_reserve(additional).map_err(io::Error::other)?;
        self.positions.try_reserve(additional).map_err(io::Error::other)?;
        self.delta.try_reserve(additional).map_err(io::Error::other)?;
        self.free.try_reserve(additional).map_err(io::Error::other)?;
        Ok(())
    }

    fn fill_slot(&self, slot: usize, output: &mut Vec<f32>) -> bool {
        if self.ids.get(slot).copied().unwrap_or(0) == 0 { return false; }
        if let Some(row) = self.delta.get(&slot) {
            output.clear();
            output.extend_from_slice(row);
            true
        } else {
            self.base.as_ref().is_some_and(|base| base.fill_slot(slot, output))
        }
    }

    /// Validate deletes and upserts together before the first mutation.
    /// Readers are excluded by the host's scope write guard.
    pub fn apply_delta(
        &mut self,
        remove_ids: &[u64],
        upsert_ids: &[u64],
        vectors: &[f32],
    ) -> io::Result<usize> {
        if remove_ids.iter().chain(upsert_ids).any(|id| *id == 0 || *id > i64::MAX as u64)
            || upsert_ids.len().checked_mul(self.dimension) != Some(vectors.len())
            || upsert_ids.iter().copied().collect::<HashSet<_>>().len() != upsert_ids.len()
            || vectors.iter().any(|value| !value.is_finite())
        {
            return Err(invalid("invalid index delta"));
        }
        self.reserve(upsert_ids.len())?;
        self.free.try_reserve(remove_ids.len()).map_err(io::Error::other)?;
        let removed = self.remove_batch(remove_ids)?;
        self.upsert_batch(upsert_ids, vectors)?;
        Ok(removed)
    }

    /// Validate the entire batch before any structural change.
    /// Host holds its single scope write lock across this method.
    pub fn upsert_batch(&mut self, ids: &[u64], vectors: &[f32]) -> io::Result<()> {
        if ids.len().checked_mul(self.dimension) != Some(vectors.len())
            || ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64)
            || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
            || vectors.iter().any(|value| !value.is_finite())
        {
            return Err(invalid("invalid upsert batch"));
        }
        self.reserve(ids.len())?;
        for (&id, row) in ids.iter().zip(vectors.chunks_exact(self.dimension)) {
            let slot = if let Some(&slot) = self.positions.get(&id) {
                if let Some(graph) = &mut self.graph { graph.soft_delete(id); }
                slot
            } else if let Some(slot) = self.free.pop() {
                slot
            } else {
                self.ids.push(0);
                self.ids.len() - 1
            };
            self.delta.insert(slot, row.to_vec());
            self.ids[slot] = id;
            self.positions.insert(id, slot);
            if let Some(graph) = &mut self.graph {
                graph.insert(row, id, slot, &mut self.random);
                graph.dirty_count_inc();
            }
        }
        Ok(())
    }

    pub fn remove_batch(&mut self, ids: &[u64]) -> io::Result<usize> {
        if ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64) {
            return Err(invalid("invalid removal ID"));
        }
        self.free.try_reserve(ids.len()).map_err(io::Error::other)?;
        let mut removed = 0;
        for id in ids {
            if let Some(slot) = self.positions.remove(id) {
                if let Some(graph) = &mut self.graph { graph.soft_delete(*id); }
                self.ids[slot] = 0;
                self.delta.remove(&slot);
                self.free.push(slot);
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Builds compact routing from immutable rows, never a full f32 matrix.
    /// The host may build a replacement off-lock and generation-check publication.
    pub fn rebuild_graph(&mut self) -> io::Result<()> {
        if self.len() < QUIVER_MIN_NODES {
            self.graph = None;
            return Ok(());
        }
        let slots: Vec<usize> = self.ids.iter().enumerate()
            .filter_map(|(slot, id)| (*id != 0).then_some(slot)).collect();
        let ids: Vec<u64> = slots.iter().map(|slot| self.ids[*slot]).collect();
        let config = QuIVerConfig::default();
        let mut graph = QuIVer::new(self.dimension, &config);
        graph.rebuild_from_cold_slots(&ids, &slots, &config,
            |slot, output| self.fill_slot(slot, output))?;
        self.graph = Some(graph);
        Ok(())
    }

    /// Scores are exact cosine on original candidate rows, never reconstructed SM.
    pub fn search(&self, query: &[f32], k: usize, ef: Option<usize>) -> io::Result<Vec<(u64, f32)>> {
        self.search_with_source(query, k, ef, |id, output| {
            self.positions.get(&id).is_some_and(|slot| self.fill_slot(*slot, output))
        })
    }

    /// Query routing using authoritative host originals, not snapshot vectors.
    /// The caller must freeze the source for the duration of this query.
    pub fn search_with_source<F>(
        &self, query: &[f32], k: usize, ef: Option<usize>, mut fill: F,
    ) -> io::Result<Vec<(u64, f32)>>
    where
        F: FnMut(u64, &mut Vec<f32>) -> bool,
    {
        if query.len() != self.dimension || query.iter().any(|v| !v.is_finite()) {
            return Err(invalid("invalid search vector"));
        }
        let k = k.min(self.len());
        if k == 0 { return Ok(Vec::new()); }
        let mut output: Vec<(u64, f32)> = if let Some(graph) = &self.graph {
            let config = QuIVerSearchConfig {
                top_k: k, ef_search: ef.unwrap_or(128).max(k),
                rerank_limit: Some(64_usize.max(k)),
            };
            let candidates = graph.search(query, |slot, output| {
                self.ids.get(slot).is_some_and(|id| *id != 0 && fill(*id, output))
            }, &config);
            let mut row = Vec::with_capacity(self.dimension);
            candidates.into_iter().filter_map(|(id, _)| {
                if !self.contains(id) { return None; }
                row.clear();
                fill(id, &mut row).then(|| (id, cosine(query, &row)))
            }).collect()
        } else {
            // VCP-PATCH: bounded Top-K storage, including deterministic ID ties.
            let mut heap = BinaryHeap::with_capacity(k);
            let mut row = Vec::with_capacity(self.dimension);
            for &id in &self.ids {
                row.clear();
                if id != 0 && fill(id, &mut row) {
                    let candidate = RankedRow { id, score: cosine(query, &row) };
                    if heap.len() < k {
                        heap.push(candidate);
                    } else if heap.peek().is_some_and(|worst| candidate < *worst) {
                        heap.pop();
                        heap.push(candidate);
                    }
                }
            }
            heap.into_iter().map(|row| (row.id, row.score)).collect()
        };
        output.retain(|(id, score)| self.contains(*id) && score.is_finite());
        output.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        output.truncate(k);
        Ok(output)
    }

    /// Compact snapshot slots; graph slots are rebuilt against the compact order.
    /// The caller publishes the staging file using its rollback-safe protocol.
    pub fn write_staging(&self, path: &Path, identity: &AssetIdentity) -> io::Result<()> {
        self.write_staging_with_source(path, identity, |id, row| {
            self.positions.get(&id).is_some_and(|slot| self.fill_slot(*slot, row))
        })
    }

    /// Write directly from frozen host originals, without an intermediate asset.
    pub fn write_staging_with_source<F>(
        &self, path: &Path, identity: &AssetIdentity, mut fill: F,
    ) -> io::Result<()>
    where
        F: FnMut(u64, &mut Vec<f32>) -> bool,
    {
        if identity.dimension != self.dimension { return Err(invalid("snapshot dimension mismatch")); }
        let slots: Vec<usize> = self.ids.iter().enumerate()
            .filter_map(|(slot, id)| (*id != 0).then_some(slot)).collect();
        let ids: Vec<u64> = slots.iter().map(|slot| self.ids[*slot]).collect();
        let mut graph_bytes = Vec::new();
        let mut sm_bytes = Vec::new();
        if ids.len() >= QUIVER_MIN_NODES {
            // SQL checkpoint builds already have compact routing. Reuse it
            // rather than reading the source and constructing the graph twice.
            // Mutable/tombstoned standalone indices still rebuild as needed.
            if let Some(graph) = self.graph.as_ref().filter(|graph|
                graph.default_sm_ready()
                    && graph.validate_compact_slots(self.dimension, &ids).is_ok()
            ) {
                graph.write_to(&mut graph_bytes)?;
                sm_bytes = graph.default_sm_snapshot_bytes()?;
            } else {
                let compact: Vec<usize> = (0..ids.len()).collect();
                let config = QuIVerConfig::default();
                let mut graph = QuIVer::new(self.dimension, &config);
                graph.rebuild_from_cold_slots(&ids, &compact, &config,
                    |slot, row| fill(ids[slot], row))?;
                graph.write_to(&mut graph_bytes)?;
                sm_bytes = graph.default_sm_snapshot_bytes()?;
            }
        }
        asset::write_staging(path, identity, &ids, &graph_bytes, &sm_bytes,
            |slot, row| fill(ids[slot], row))
    }

    pub fn load_snapshot(path: &Path, expected: &AssetIdentity) -> io::Result<Self> {
        Self::from_validated_asset(VectorAsset::open(path, expected)?)
    }

    /// Consume the same CRC-validated mapping that the host endorsed.
    /// No pathname reopen or second full-file scan.
    pub fn from_validated_asset(base: VectorAsset) -> io::Result<Self> {
        let dimension = base.identity().dimension;
        let mut index = Self::empty(dimension)?;
        index.reserve(base.len())?;
        for slot in 0..base.len() {
            let id = base.id_for_slot(slot).unwrap();
            index.positions.insert(id, slot);
            index.ids.push(id);
        }
        if !base.graph_bytes().is_empty() {
            let mut graph = QuIVer::load_from_bytes(base.graph_bytes())?;
            graph.validate_compact_slots(dimension, &index.ids)?;
            graph.restore_default_sm_snapshot(base.sm_bytes())?;
            if graph.active_count() != index.len() || graph.total_count() != index.len() {
                return Err(invalid("snapshot graph count mismatch"));
            }
            index.graph = Some(graph);
        }
        index.base = Some(base);
        Ok(index)
    }
}

#[derive(Clone, Copy)]
struct RankedRow {
    id: u64,
    score: f32,
}
impl PartialEq for RankedRow {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && self.score.total_cmp(&other.score).is_eq()
    }
}
impl Eq for RankedRow {}
impl PartialOrd for RankedRow {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RankedRow {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // BinaryHeap keeps the worst retained row at the root.
        other.score.total_cmp(&self.score).then_with(|| self.id.cmp(&other.id))
    }
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    let (mut dot, mut a, mut b) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (&x, &y) in left.iter().zip(right) {
        let (x, y) = (x as f64, y as f64);
        dot += x * y; a += x * x; b += y * y;
    }
    if a == 0.0 || b == 0.0 { 0.0 } else { (dot / (a.sqrt() * b.sqrt())).clamp(-1.0, 1.0) as f32 }
}
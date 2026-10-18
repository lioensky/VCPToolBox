//! VCP-PATCH: embedded routing-only snapshots, independent of cold FP32 storage.
use super::*;

const ROUTING_MAGIC: &[u8; 8] = b"VCPSM001";

impl CorrectedSmIndex {
    pub fn routing_snapshot_bytes(&self) -> io::Result<Vec<u8>> {
        if self.scoring != SmScoring::ReconstructedL2 {
            return Err(invalid("routing snapshot requires default SM-L2"));
        }
        let dim = self.dimension();
        let words = dim.div_ceil(64);
        let mut out = Vec::new();
        out.extend_from_slice(ROUTING_MAGIC);
        out.extend_from_slice(&(dim as u32).to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&(self.len() as u64).to_le_bytes());
        out.extend_from_slice(&self.entry.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for id in 0..self.len() {
            out.extend_from_slice(&self.ids[id].to_le_bytes());
            let (pos, strong, weak, delta, coefficient, norm, count) =
                if let Some(model) = &self.dynamic {
                    let row = model.row(id);
                    let (w, d, c, n, count) = model.metadata(id);
                    (&row[..words], &row[words..words * 2], w, d, c, n, count)
                } else {
                    let row = &self.rows[id];
                    (&row.pos[..], &row.strong[..], row.weak, row.delta,
                     row.coefficient, row.reconstructed_norm, row.strong_count as u32)
                };
            for value in pos.iter().chain(strong) {
                out.extend_from_slice(&value.to_le_bytes());
            }
            for value in [weak, delta, coefficient, norm,
                self.exact_scales.get(id).copied().unwrap_or(1.)] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&count.to_le_bytes());
        }
        out.extend_from_slice(&crc32fast::hash(&out).to_le_bytes());
        Ok(out)
    }

    pub fn from_routing_snapshot_bytes(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() < 36 || &bytes[..8] != ROUTING_MAGIC {
            return Err(corrupt("SM routing header missing"));
        }
        let dim = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        dynamic::check_dimension(dim).map_err(|_| corrupt("SM routing dimension invalid"))?;
        let mode = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        let n = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let entry = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let words = dim.div_ceil(64);
        let row_bytes = words * 16 + 32;
        let expected = usize::try_from(n).ok()
            .and_then(|n| n.checked_mul(row_bytes))
            .and_then(|length| length.checked_add(36));
        if mode != 1 || n > u32::MAX as u64 || expected != Some(bytes.len())
            || (n > 0 && entry as u64 >= n)
            || (n == 0 && entry != 0)
            || bytes[28..32] != [0; 4]
        {
            return Err(corrupt("SM routing shape invalid"));
        }
        let tail = bytes.len() - 4;
        let crc = u32::from_le_bytes(bytes[tail..].try_into().unwrap());
        if crc32fast::hash(&bytes[..tail]) != crc {
            return Err(corrupt("SM routing CRC mismatch"));
        }
        let mut result = Self::empty_routing(dim)?;
        result.reserve_routing(n as usize);
        // Allocate only after exact byte length and CRC validation.
        let mut dynamic = DynamicSm::empty(dim, n as usize)?;
        let mut input = &bytes[32..tail];
        let mask = if dim % 64 == 0 { u64::MAX } else { (1u64 << (dim % 64)) - 1 };
        for id in 0..n as usize {
            let external = read_u64(&mut input)?;
            let row = dynamic.row_mut(id);
            for value in &mut row[..words * 2] {
                *value = read_u64(&mut input)?;
            }
            let weak = f32::from_bits(read_u32(&mut input)?);
            let delta = f32::from_bits(read_u32(&mut input)?);
            let coefficient = f32::from_bits(read_u32(&mut input)?);
            let norm = f32::from_bits(read_u32(&mut input)?);
            let scale = f32::from_bits(read_u32(&mut input)?);
            let count = read_u32(&mut input)?;
            if ![weak, delta, coefficient, norm].iter().all(|v| v.is_finite())
                || weak < 0. || norm < 0. || scale.is_nan() || scale <= 0.
                || count > dim as u32
                || row[words..words * 2].iter().map(|x| x.count_ones()).sum::<u32>() != count
                || row[words - 1] & !mask != 0
                || row[words * 2 - 1] & !mask != 0
            {
                return Err(corrupt("SM routing row invalid"));
            }
            if dim == DIM {
                result.rows.push(SmRow {
                    pos: row[..12].try_into().unwrap(),
                    strong: row[words..words * 2].try_into().unwrap(),
                    weak, delta, coefficient, reconstructed_norm: norm,
                    strong_count: count as u16,
                });
            }
            dynamic.write_metadata(id, weak, delta, coefficient, norm, count);
            result.ids.push(external);
            result.exact_scales.push(scale);
        }
        result.entry = entry;
        if dim != DIM {
            result.dynamic = Some(dynamic);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::QuIVerConfig;

    #[test]
    fn graph_free_filtered_scan_roundtrips_and_keeps_bounded_stable_top() {
        for dim in [65, 768, 3072] {
            let mut index = CorrectedSmIndex::empty_flat(dim).unwrap();
            let query = vec![1.; dim];
            for id in [9, 3, 7, 1] {
                index.push_flat_vector(&query, id).unwrap();
            }
            let hits = index.search_flat_filtered(&query, 2, |_, id| id != 1).unwrap();
            assert_eq!(hits.iter().map(|x| x.0).collect::<Vec<_>>(), vec![3, 7]);
            let restored = CorrectedSmIndex::from_routing_snapshot_bytes(
                &index.routing_snapshot_bytes().unwrap(),
            ).unwrap();
            assert_eq!(hits, restored.search_flat_filtered(&query, 2, |_, id| id != 1).unwrap());
            assert!(restored.search_flat_filtered(&query, 2, |_, _| false).unwrap().is_empty());
            assert!(restored.search_flat_filtered(&[f32::NAN], 2, |_, _| true).is_err());
            assert!(restored.memory_components()["graph_bytes"].as_u64().unwrap() == 0);
        }
    }

    #[test]
    fn embedded_graph_and_sm_roundtrip_preserves_updates_and_score_bits() {
        for dim in [65, 768, 3072] {
            let n = 40;
            let base = (0..n * dim)
                .map(|i| ((i * 7919 % 997) as f32 - 498.) / 137.)
                .collect::<Vec<_>>();
            let mut index = QuIVer::new(dim, &QuIVerConfig {
                m: 8, ef_construction: 32, alpha: 1.2,
            });
            index.batch_build_experimental_v2(
                &base, &(1..=n as u64).collect::<Vec<_>>(),
                &(0..n).collect::<Vec<_>>(),
            );
            assert!(index.soft_delete(7));
            let mut seed = 42;
            index.insert(&base[6 * dim..7 * dim], 7, 6, &mut seed);
            let cfg = QuIVerSearchConfig {
                top_k: 10, ef_search: n + 1, rerank_limit: Some(n + 1),
            };
            let expected = index.search_flat(&base[6 * dim..7 * dim], &base, &cfg);
            let sm = index.default_sm.as_ref().unwrap().routing_snapshot_bytes().unwrap();
            let mut graph = Vec::new();
            index.write_to(&mut graph).unwrap();
            let mut restored = QuIVer::load_from_bytes(&graph).unwrap();
            assert!(!restored.default_sm_ready());
            let model = CorrectedSmIndex::from_routing_snapshot_bytes(&sm).unwrap();
            assert_eq!(model.routing_snapshot_bytes().unwrap(), sm);
            restored.set_default_sm(model);
            assert!(restored.default_sm_ready());
            let actual = restored.search_flat(&base[6 * dim..7 * dim], &base, &cfg);
            let bits = |hits: Vec<(u64, f32)>| hits.into_iter()
                .map(|(id, score)| (id, score.to_bits())).collect::<Vec<_>>();
            assert_eq!(bits(actual), bits(expected));
            assert_eq!(restored.active_count(), n);
            assert!(restored.soft_delete(7));
            assert_eq!(restored.active_count(), n - 1);
            for length in [0, 7, 31, sm.len() - 1] {
                assert!(CorrectedSmIndex::from_routing_snapshot_bytes(&sm[..length]).is_err());
            }
            let mut bad = sm.clone();
            bad[40] ^= 1;
            assert!(CorrectedSmIndex::from_routing_snapshot_bytes(&bad).is_err());
            graph.push(0);
            assert!(QuIVer::load_from_bytes(&graph).is_err());
        }
    }
}
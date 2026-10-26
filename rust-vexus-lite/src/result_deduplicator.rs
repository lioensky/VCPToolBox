use std::cmp::Ordering;
use std::collections::HashMap;

const SQLITE_BATCH_SIZE: usize = 500;

pub(crate) struct DedupCandidate {
    pub(crate) id: i64,
    pub(crate) score: f64,
    pub(crate) original_index: usize,
}

struct VectorDescriptor {
    vector: Vec<f32>,
    inverse_magnitude: f64,
    suffix_norms: std::cell::OnceCell<Vec<f64>>,
}

struct RankedCandidate {
    candidate: DedupCandidate,
    descriptor: Option<VectorDescriptor>,
    query_similarity: Option<f64>,
}

pub(crate) struct SemanticDedupOutput {
    pub(crate) candidates: Vec<DedupCandidate>,
    pub(crate) sql_batches: usize,
    pub(crate) hydrated_vectors: usize,
    pub(crate) missing_vectors: usize,
    pub(crate) comparison_count: usize,
    pub(crate) suppressed: usize,
}

fn descriptor_from_bytes(bytes: &[u8], dimension: usize) -> Option<VectorDescriptor> {
    if bytes.len() != dimension.checked_mul(4)? {
        return None;
    }
    let mut vector = Vec::with_capacity(dimension);
    let mut magnitude_squared = 0.0f64;
    for chunk in bytes.chunks_exact(4) {
        let value = f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if !value.is_finite() {
            return None;
        }
        magnitude_squared += (value as f64) * (value as f64);
        vector.push(value);
    }
    if magnitude_squared <= 1e-12 {
        return None;
    }
    Some(VectorDescriptor {
        suffix_norms: std::cell::OnceCell::new(),
        vector,
        inverse_magnitude: 1.0 / magnitude_squared.sqrt(),
    })
}

fn descriptor_from_query(query: &[f32], dimension: usize) -> Option<VectorDescriptor> {
    if query.len() != dimension {
        return None;
    }
    let mut magnitude_squared = 0.0f64;
    for value in query {
        if !value.is_finite() {
            return None;
        }
        magnitude_squared += (*value as f64) * (*value as f64);
    }
    if magnitude_squared <= 1e-12 {
        return None;
    }
    Some(VectorDescriptor {
        suffix_norms: std::cell::OnceCell::new(),
        vector: query.to_vec(),
        inverse_magnitude: 1.0 / magnitude_squared.sqrt(),
    })
}

fn cosine(left: &VectorDescriptor, right: &VectorDescriptor) -> f64 {
    if left.vector.len() != right.vector.len() {
        return -1.0;
    }
    let mut dot = 0.0f64;
    let mut offset = 0usize;
    let unrolled = left.vector.len() - left.vector.len() % 4;
    while offset < unrolled {
        dot += (left.vector[offset] as f64) * (right.vector[offset] as f64)
            + (left.vector[offset + 1] as f64) * (right.vector[offset + 1] as f64)
            + (left.vector[offset + 2] as f64) * (right.vector[offset + 2] as f64)
            + (left.vector[offset + 3] as f64) * (right.vector[offset + 3] as f64);
        offset += 4;
    }
    while offset < left.vector.len() {
        dot += (left.vector[offset] as f64) * (right.vector[offset] as f64);
        offset += 1;
    }
    dot * left.inverse_magnitude * right.inverse_magnitude
}

const BOUND_BLOCK: usize = 256;

// Store suffix norms at group boundaries. A negative certificate never changes
// ranking scores: those still use cosine(), with its original summation order.
fn suffix_norms(vector: &[f32]) -> Vec<f64> {
    if vector.len() < BOUND_BLOCK * 2 || vector.len() > 1_000_000 {
        return Vec::new();
    }
    let mut norms = vec![0.; vector.len() / BOUND_BLOCK + 1];
    let mut sum = 0.;
    for (i, &value) in vector.iter().enumerate().rev() {
        sum += (value as f64) * (value as f64);
        if i % BOUND_BLOCK == 0 { norms[i / BOUND_BLOCK] = sum; }
    }
    norms
}

fn cosine_at_least_with_budget(left: &VectorDescriptor, right: &VectorDescriptor,
    threshold: f64, slow_budget: &mut usize) -> bool {
    let n = left.vector.len();
    if n != right.vector.len() || n < BOUND_BLOCK * 2 || n > 1_000_000 {
        return cosine(left, right) >= threshold;
    }
    let left_suffix = left.suffix_norms.get_or_init(|| suffix_norms(&left.vector));
    let right_suffix = right.suffix_norms.get_or_init(|| suffix_norms(&right.vector));
    let x = &left.vector;
    let y = &right.vector;
    let end = n - n % 4;
    let mut dot = 0.;
    let mut offset = 0;
    // FP32 products are exact in FP64. This guard exceeds the accumulation,
    // norm and bound-rounding errors for the bounded dimension range. Ambiguous
    // cases complete the original sum; this is not a statistical stopping rule.
    let roundoff_guard = 64. * f64::EPSILON * n as f64;
    while offset < end {
        let block_end = (offset + BOUND_BLOCK).min(end);
        while offset < block_end {
            dot += (x[offset] as f64) * (y[offset] as f64)
                + (x[offset+1] as f64) * (y[offset+1] as f64)
                + (x[offset+2] as f64) * (y[offset+2] as f64)
                + (x[offset+3] as f64) * (y[offset+3] as f64);
            offset += 4;
        }
        if offset < n && offset % BOUND_BLOCK == 0 {
            let residual = (left_suffix[offset / BOUND_BLOCK]
                * right_suffix[offset / BOUND_BLOCK]).sqrt();
            let upper = (dot + residual) * left.inverse_magnitude * right.inverse_magnitude;
            if upper + roundoff_guard < threshold {
                // Bound costly unsuccessful probes per request. Falling back
                // changes work only, never candidate or suppression semantics.
                if n - offset < n / 8 { *slow_budget = slow_budget.saturating_sub(1); }
                return false;
            }
        }
    }
    while offset < n {
        dot += (x[offset] as f64) * (y[offset] as f64);
        offset += 1;
    }
    let duplicate = dot * left.inverse_magnitude * right.inverse_magnitude >= threshold;
    // A positive match ends this candidate's loop, so these full scans are
    // linear in the candidate count and must not disable useful negative bounds.
    if !duplicate { *slow_budget = slow_budget.saturating_sub(1); }
    duplicate
}

#[cfg(test)]
fn cosine_at_least(left: &VectorDescriptor, right: &VectorDescriptor, threshold: f64) -> bool {
    cosine_at_least_with_budget(left, right, threshold, &mut 8)
}

#[cfg(test)]
mod bound_tests {
    use super::*;

    #[test]
    fn bounded_predicate_preserves_threshold_boundaries_and_tail_dimensions() {
        let mut seed = 971u64;
        for n in [1, 255, 256, 511, 512, 513, 767, 768, 769, 1536, 3071, 3072, 4096] {
            let x: Vec<f32> = (0..n).map(|_| {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                (seed % 2001) as f32 / 1000. - 1.
            }).collect();
            for mode in 0..5 {
                let y: Vec<f32> = x.iter().enumerate().map(|(i,&v)| match mode {
                    0 => v,
                    1 => -v,
                    2 => if i % 3 == 0 { -v } else { v },
                    3 => v + ((i % 7) as f32 - 3.) * 0.001,
                    _ => x[(i + n/2) % n],
                }).collect();
                let a = descriptor_from_query(&x, n).unwrap();
                let b = descriptor_from_query(&y, n).unwrap();
                let exact = cosine(&a, &b);
                for threshold in [-1., 0., 0.88, 0.92, 0.97, 1., exact,
                    exact.next_up(), exact.next_down()] {
                    assert_eq!(cosine_at_least(&a,&b,threshold),exact >= threshold,
                        "dimension={n}, mode={mode}, threshold={threshold}");
                }
            }
        }
    }

    #[test]
    fn bounded_predicate_preserves_extreme_f32_magnitudes() {
        for scale in [1e-6f32, 1., 1e30, f32::MAX/2.] {
            let x: Vec<_> = (0..3073).map(|i| if i%2==0 { scale } else { -scale }).collect();
            let mut y = x.clone();
            for v in y.iter_mut().step_by(5) { *v = -*v; }
            let a = descriptor_from_query(&x,x.len()).unwrap();
            let b = descriptor_from_query(&y,y.len()).unwrap();
            let exact = cosine(&a,&b);
            for threshold in [0.92,exact,exact.next_up(),exact.next_down()] {
                assert_eq!(cosine_at_least(&a,&b,threshold),exact >= threshold);
            }
        }
    }

    #[test]
    fn bounded_predicate_respects_budget_and_dimension_limit() {
        for n in [3_072, 999_999, 1_000_000, 1_000_001] {
            let x = vec![1.0f32; n];
            let mut y = x.clone();
            y[n - 1] = -1.0;
            let a = descriptor_from_query(&x, n).unwrap();
            let b = descriptor_from_query(&y, n).unwrap();
            let exact = cosine(&a, &b);
            let mut budget = 1;
            for threshold in [exact.next_down(), exact, exact.next_up(), 1.0] {
                assert_eq!(
                    cosine_at_least_with_budget(&a, &b, threshold, &mut budget),
                    exact >= threshold,
                    "dimension={n}, threshold={threshold}"
                );
            }
            if n == 3_072 {
                assert_eq!(budget, 0, "full negative scan must spend the budget");
            }
        }
    }
}

fn load_descriptors(
    connection: &rusqlite::Connection,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<(HashMap<i64, VectorDescriptor>, usize), String> {
        let mut descriptors = HashMap::with_capacity(ids.len());
        let mut sql_batches = 0usize;

        for batch in ids.chunks(SQLITE_BATCH_SIZE) {
            if batch.is_empty() {
                continue;
            }
            sql_batches += 1;
            let placeholders = std::iter::repeat("?")
                .take(batch.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT id, vector FROM chunks WHERE id IN ({})",
                placeholders
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("prepare batched semantic vectors failed: {}", error))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
                })
                .map_err(|error| format!("query batched semantic vectors failed: {}", error))?;
            for row in rows {
                let (id, bytes) =
                    row.map_err(|error| format!("decode semantic vector row failed: {}", error))?;
                if let Some(descriptor) = bytes.as_deref()
                    .and_then(|bytes| descriptor_from_bytes(bytes, dimension)) {
                    descriptors.insert(id, descriptor);
                }
            }
        }

        Ok((descriptors, sql_batches))
}

/// 调用方传入固定读事务连接，避免跨查询阶段重新借用连接池。
pub(crate) fn deduplicate_with_connection(
    connection: &rusqlite::Connection,
    candidates: Vec<DedupCandidate>,
    query: &[f32],
    dimension: usize,
    threshold: f64,
    max_results: usize,
) -> std::result::Result<SemanticDedupOutput, String> {
    if candidates.is_empty() {
        return Ok(SemanticDedupOutput {
            candidates,
            sql_batches: 0,
            hydrated_vectors: 0,
            missing_vectors: 0,
            comparison_count: 0,
            suppressed: 0,
        });
    }

    let ids: Vec<i64> = candidates.iter().map(|candidate| candidate.id).collect();
    let (mut descriptors, sql_batches) = load_descriptors(connection, &ids, dimension)?;
    let hydrated_vectors = descriptors.len();
    let missing_vectors = candidates.len().saturating_sub(hydrated_vectors);
    let query_descriptor = descriptor_from_query(query, dimension);
    let mut ranked: Vec<RankedCandidate> = candidates
        .into_iter()
        .map(|candidate| {
            let descriptor = descriptors.remove(&candidate.id);
            let query_similarity = query_descriptor
                .as_ref()
                .zip(descriptor.as_ref())
                .map(|(query, vector)| cosine(vector, query));
            RankedCandidate {
                candidate,
                descriptor,
                query_similarity,
            }
        })
        .collect();

    // 与 JS 参考实现一致：有效 Query 相似度优先，其次候选分数，最后原始位置。
    ranked.sort_by(
        |left, right| match (left.query_similarity, right.query_similarity) {
            (Some(left_value), Some(right_value)) if left_value != right_value => right_value
                .partial_cmp(&left_value)
                .unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            _ => right
                .candidate
                .score
                .partial_cmp(&left.candidate.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    left.candidate
                        .original_index
                        .cmp(&right.candidate.original_index)
                }),
        },
    );

    let threshold = if threshold.is_finite() {
        threshold.clamp(-1.0, 1.0)
    } else {
        0.92
    };
    let max_results = max_results.max(1);
    let mut selected: Vec<RankedCandidate> = Vec::new();
    let mut selected_descriptors: Vec<VectorDescriptor> = Vec::new();
    let mut comparison_count = 0usize;
    let mut suppressed = 0usize;
    let mut bound_slow_budget = 8usize;

    for mut entry in ranked {
        if selected.len() >= max_results {
            break;
        }
        let Some(descriptor) = entry.descriptor.take() else {
            // 无有效向量的候选无法可靠判重，保持 JS 的安全保留语义。
            selected.push(entry);
            continue;
        };

        let mut redundant = false;
        for existing in &selected_descriptors {
            comparison_count += 1;
            // Amortize suffix preparation only once pair comparisons can dominate.
            // This affects cost only; both predicates have identical semantics.
            let is_duplicate = if selected_descriptors.len() >= 8 && bound_slow_budget > 0 {
                cosine_at_least_with_budget(&descriptor, existing, threshold, &mut bound_slow_budget)
            } else {
                cosine(&descriptor, existing) >= threshold
            };
            if is_duplicate {
                redundant = true;
                suppressed += 1;
                break;
            }
        }
        if !redundant {
            selected_descriptors.push(descriptor);
            selected.push(entry);
        }
    }

    // ANN 路所有来源优先级相同；恢复分数降序和原始位置稳定顺序。
    selected.sort_by(|left, right| {
        right
            .candidate
            .score
            .partial_cmp(&left.candidate.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                left.candidate
                    .original_index
                    .cmp(&right.candidate.original_index)
            })
    });

    Ok(SemanticDedupOutput {
        candidates: selected.into_iter().map(|entry| entry.candidate).collect(),
        sql_batches,
        hydrated_vectors,
        missing_vectors,
        comparison_count,
        suppressed,
    })
}

#[cfg(test)]
mod tests {
    use super::{cosine, descriptor_from_query};

    #[test]
    fn null_vectors_keep_candidates_without_aborting_deduplication() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE chunks(id INTEGER PRIMARY KEY, vector BLOB);
             INSERT INTO chunks VALUES (1,NULL),(2,X'0000');"
        ).unwrap();
        let output = super::deduplicate_with_connection(
            &connection,
            vec![
                super::DedupCandidate { id: 1, score: 1.0, original_index: 0 },
                super::DedupCandidate { id: 2, score: 0.5, original_index: 1 },
            ],
            &[1.0,0.0], 2, 0.92, 10,
        ).unwrap();
        assert_eq!(output.missing_vectors, 2);
        assert_eq!(output.candidates.len(), 2);
    }

    #[test]
    fn prepared_cosine_uses_f64_accumulation() {
        let left = descriptor_from_query(&[1.0, 0.0, 0.0, 0.0], 4).unwrap();
        let right = descriptor_from_query(&[0.8, 0.6, 0.0, 0.0], 4).unwrap();
        assert!((cosine(&left, &right) - 0.8).abs() < 1e-6);
    }
}

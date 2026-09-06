use rusqlite::{Connection, OpenFlags};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::Duration;

const SQLITE_BATCH_SIZE: usize = 500;

pub(crate) struct DedupCandidate {
    pub(crate) id: i64,
    pub(crate) score: f64,
    pub(crate) original_index: usize,
}

struct VectorDescriptor {
    vector: Vec<f32>,
    inverse_magnitude: f64,
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

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open semantic dedup SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure semantic dedup timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure semantic dedup query_only failed: {}", error))?;
    Ok(connection)
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

fn load_descriptors(
    db_path: &str,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<(HashMap<i64, VectorDescriptor>, usize), String> {
    let connection = open_readonly(db_path)?;
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
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| format!("query batched semantic vectors failed: {}", error))?;
        for row in rows {
            let (id, bytes) =
                row.map_err(|error| format!("decode semantic vector row failed: {}", error))?;
            if let Some(descriptor) = descriptor_from_bytes(&bytes, dimension) {
                descriptors.insert(id, descriptor);
            }
        }
    }

    Ok((descriptors, sql_batches))
}

pub(crate) fn deduplicate(
    db_path: &str,
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
    let (mut descriptors, sql_batches) = load_descriptors(db_path, &ids, dimension)?;
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
    ranked.sort_by(|left, right| {
        match (left.query_similarity, right.query_similarity) {
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
        }
    });

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
            if cosine(&descriptor, existing) >= threshold {
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
        candidates: selected
            .into_iter()
            .map(|entry| entry.candidate)
            .collect(),
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
    fn prepared_cosine_uses_f64_accumulation() {
        let left = descriptor_from_query(&[1.0, 0.0, 0.0, 0.0], 4).unwrap();
        let right = descriptor_from_query(&[0.8, 0.6, 0.0, 0.0], 4).unwrap();
        assert!((cosine(&left, &right) - 0.8).abs() < 1e-6);
    }
}
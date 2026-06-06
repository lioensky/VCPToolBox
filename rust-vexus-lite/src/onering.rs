use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use rusqlite::params;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use crate::{open_sqlite_readonly, open_sqlite_readwrite};

#[napi(object)]
pub struct OneRingLoadResult {
    pub success: bool,
    pub loaded_count: u32,
    pub elapsed_ms: f64,
    pub message: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct OneRingPostBlock {
    pub role: String,
    pub text: String,
    pub sender_name: Option<String>,
    pub frontend_source: Option<String>,
    pub index: i32,
}

#[napi(object)]
pub struct OneRingDiffInput {
    pub db_path: String,
    pub agent_name: String,
    pub frontend_source: String,
    pub post_blocks: Vec<OneRingPostBlock>,
    pub threshold: f64,
    pub limit: u32,
}

#[napi(object)]
pub struct OneRingEditedBlock {
    pub post_index: i32,
    pub db_id: i64,
    pub old_content: String,
    pub new_text: String,
    pub similarity: f64,
}

#[napi(object)]
pub struct OneRingNewBlock {
    pub post_index: i32,
    pub role: String,
    pub text: String,
    pub sender_name: Option<String>,
    pub index: i32,
}

#[napi(object)]
pub struct OneRingDiffResult {
    pub matched_count: u32,
    pub unknown_count: u32,
    pub edited_blocks: Vec<OneRingEditedBlock>,
    pub new_blocks: Vec<OneRingNewBlock>,
    pub reliable: bool,
    pub elapsed_ms: f64,
    pub phase_summary: String,
}

#[napi(object)]
pub struct OneRingMessageInput {
    pub db_path: String,
    pub agent_name: String,
    pub role: String,
    pub sender_name: Option<String>,
    pub frontend_source: Option<String>,
    pub content: String,
    pub timestamp: String,
    pub max_records: Option<u32>,
}

#[napi(object)]
pub struct OneRingUpdateInput {
    pub db_path: String,
    pub agent_name: String,
    pub id: i64,
    pub content: String,
}

#[napi(object)]
pub struct OneRingWriteResult {
    pub success: bool,
    pub id: i64,
    pub elapsed_ms: f64,
    pub message: String,
}

#[napi(object)]
pub struct OneRingEngineStats {
    pub agents: u32,
    pub records: u32,
    pub frontends: u32,
}

#[derive(Clone)]
struct CachedRecord {
    id: i64,
    role: String,
    frontend_source: Option<String>,
    content: String,
    normalized: String,
    hash: u64,
    prefix_hash: u64,
    suffix_hash: u64,
    len: usize,
    token_bits: u64,
}

#[derive(Clone)]
struct AgentCache {
    db_path: String,
    records: VecDeque<CachedRecord>,
    max_records: usize,
}

#[derive(Default)]
struct OneRingState {
    agents: HashMap<String, AgentCache>,
}

#[napi]
pub struct OneRingEngine {
    state: Arc<RwLock<OneRingState>>,
}

#[napi]
impl OneRingEngine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(RwLock::new(OneRingState::default())),
        }
    }

    #[napi]
    pub fn load_agent(
        &self,
        db_path: String,
        agent_name: String,
        max_records: Option<u32>,
    ) -> Result<OneRingLoadResult> {
        let started = Instant::now();
        let limit = max_records.unwrap_or(256).max(1) as usize;
        let records = load_agent_records(&db_path, &agent_name, limit)?;

        let loaded_count = records.len() as u32;
        let mut state = self
            .state
            .write()
            .map_err(|e| Error::from_reason(format!("OneRingEngine state write lock failed: {}", e)))?;
        state.agents.insert(agent_name.clone(), AgentCache {
            db_path,
            records: VecDeque::from(records),
            max_records: limit,
        });

        Ok(OneRingLoadResult {
            success: true,
            loaded_count,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            message: format!("loaded agent {}", agent_name),
        })
    }

    #[napi]
    pub fn diff_frontend_context(&self, input: OneRingDiffInput) -> Result<OneRingDiffResult> {
        let started = Instant::now();
        let limit = input.limit.max(1) as usize;
        ensure_agent_loaded(
            &self.state,
            &input.db_path,
            &input.agent_name,
            limit.max(input.post_blocks.len() * 3).max(64),
        )?;

        let db_blocks = {
            let state = self
                .state
                .read()
                .map_err(|e| Error::from_reason(format!("OneRingEngine state read lock failed: {}", e)))?;
            let cache = state
                .agents
                .get(&input.agent_name)
                .ok_or_else(|| Error::from_reason("agent cache missing after load".to_string()))?;
            cache
                .records
                .iter()
                .filter(|record| record.frontend_source.as_deref() == Some(input.frontend_source.as_str()))
                .rev()
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
        };

        let diff_started = Instant::now();
        let result = diff_context_native(&input.post_blocks, &db_blocks, input.threshold);
        let diff_ms = diff_started.elapsed().as_secs_f64() * 1000.0;

        Ok(OneRingDiffResult {
            matched_count: result.matched_count,
            unknown_count: result.unknown_count,
            edited_blocks: result.edited_blocks,
            new_blocks: result.new_blocks,
            reliable: result.reliable,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            phase_summary: format!(
                "dbRows={};postBlocks={};diff={:.2}ms;total={:.2}ms",
                db_blocks.len(),
                input.post_blocks.len(),
                diff_ms,
                started.elapsed().as_secs_f64() * 1000.0
            ),
        })
    }

    #[napi]
    pub fn insert_message(&self, input: OneRingMessageInput) -> Result<OneRingWriteResult> {
        let started = Instant::now();
        let conn = open_sqlite_readwrite(&input.db_path)
            .map_err(|e| Error::from_reason(format!("OneRing insert open DB failed: {}", e)))?;
        let result = conn
            .execute(
                "INSERT INTO messages (agentName, role, senderName, frontendSource, content, timestamp, postContextHash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                params![
                    input.agent_name,
                    input.role,
                    input.sender_name,
                    input.frontend_source,
                    input.content,
                    input.timestamp
                ],
            )
            .map_err(|e| Error::from_reason(format!("OneRing insert failed: {}", e)))?;
        let id = conn.last_insert_rowid();

        if let Some(max_records) = input.max_records {
            prune_agent_messages_sqlite(&conn, &input.agent_name, max_records as usize)
                .map_err(|e| Error::from_reason(format!("OneRing prune after insert failed: {}", e)))?;
        }

        if result > 0 {
            let row = CachedRecord::new(
                id,
                input.role,
                input.frontend_source,
                input.content,
            );
            upsert_cache_record(&self.state, input.db_path, input.agent_name, row, input.max_records.unwrap_or(256) as usize)?;
        }

        Ok(OneRingWriteResult {
            success: result > 0,
            id,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            message: "inserted".to_string(),
        })
    }

    #[napi]
    pub fn update_message_by_id(&self, input: OneRingUpdateInput) -> Result<OneRingWriteResult> {
        let started = Instant::now();
        let conn = open_sqlite_readwrite(&input.db_path)
            .map_err(|e| Error::from_reason(format!("OneRing update open DB failed: {}", e)))?;
        let changed = conn
            .execute(
                "UPDATE messages SET content=?1 WHERE agentName=?2 AND id=?3",
                params![input.content, input.agent_name, input.id],
            )
            .map_err(|e| Error::from_reason(format!("OneRing update failed: {}", e)))?;

        {
            let mut state = self
                .state
                .write()
                .map_err(|e| Error::from_reason(format!("OneRingEngine state write lock failed: {}", e)))?;
            if let Some(cache) = state.agents.get_mut(&input.agent_name) {
                for record in cache.records.iter_mut() {
                    if record.id == input.id {
                        record.content = input.content.clone();
                        let prepared = prepare_text(&input.content);
                        record.normalized = prepared.normalized;
                        record.hash = prepared.hash;
                        record.prefix_hash = prepared.prefix_hash;
                        record.suffix_hash = prepared.suffix_hash;
                        record.len = prepared.len;
                        record.token_bits = prepared.token_bits;
                        break;
                    }
                }
            }
        }

        Ok(OneRingWriteResult {
            success: changed > 0,
            id: input.id,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            message: "updated".to_string(),
        })
    }

    #[napi]
    pub fn stats(&self) -> Result<OneRingEngineStats> {
        let state = self
            .state
            .read()
            .map_err(|e| Error::from_reason(format!("OneRingEngine state read lock failed: {}", e)))?;
        let agents = state.agents.len() as u32;
        let records = state.agents.values().map(|cache| cache.records.len() as u32).sum();
        let frontends = state
            .agents
            .values()
            .map(|cache| {
                cache
                    .records
                    .iter()
                    .filter_map(|record| record.frontend_source.as_ref())
                    .collect::<std::collections::HashSet<_>>()
                    .len() as u32
            })
            .sum();

        Ok(OneRingEngineStats {
            agents,
            records,
            frontends,
        })
    }
}

struct PreparedText {
    normalized: String,
    hash: u64,
    prefix_hash: u64,
    suffix_hash: u64,
    len: usize,
    token_bits: u64,
}

impl CachedRecord {
    fn new(
        id: i64,
        role: String,
        frontend_source: Option<String>,
        content: String,
    ) -> Self {
        let prepared = prepare_text(&content);
        Self {
            id,
            role,
            frontend_source,
            content,
            normalized: prepared.normalized,
            hash: prepared.hash,
            prefix_hash: prepared.prefix_hash,
            suffix_hash: prepared.suffix_hash,
            len: prepared.len,
            token_bits: prepared.token_bits,
        }
    }
}

#[derive(Clone)]
struct PreparedPostBlock {
    role: String,
    text: String,
    sender_name: Option<String>,
    index: i32,
    normalized: String,
    hash: u64,
    prefix_hash: u64,
    suffix_hash: u64,
    len: usize,
    token_bits: u64,
}

struct NativeDiffResult {
    matched_count: u32,
    unknown_count: u32,
    edited_blocks: Vec<OneRingEditedBlock>,
    new_blocks: Vec<OneRingNewBlock>,
    reliable: bool,
}

fn ensure_agent_loaded(
    state: &Arc<RwLock<OneRingState>>,
    db_path: &str,
    agent_name: &str,
    max_records: usize,
) -> Result<()> {
    {
        let state_guard = state
            .read()
            .map_err(|e| Error::from_reason(format!("OneRingEngine state read lock failed: {}", e)))?;
        if let Some(cache) = state_guard.agents.get(agent_name) {
            if cache.db_path == db_path && cache.records.len() >= max_records.min(cache.max_records) / 2 {
                return Ok(());
            }
        }
    }

    let records = load_agent_records(db_path, agent_name, max_records)?;
    let mut state_guard = state
        .write()
        .map_err(|e| Error::from_reason(format!("OneRingEngine state write lock failed: {}", e)))?;
    state_guard.agents.insert(agent_name.to_string(), AgentCache {
        db_path: db_path.to_string(),
        records: VecDeque::from(records),
        max_records,
    });
    Ok(())
}

fn load_agent_records(db_path: &str, agent_name: &str, limit: usize) -> Result<Vec<CachedRecord>> {
    let conn = open_sqlite_readonly(db_path)
        .map_err(|e| Error::from_reason(format!("OneRing readonly open DB failed: {}", e)))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, agentName, role, senderName, frontendSource, content, timestamp
             FROM (
               SELECT id, agentName, role, senderName, frontendSource, content, timestamp
               FROM messages
               WHERE agentName=?1
               ORDER BY timestamp DESC, id DESC
               LIMIT ?2
             )
             ORDER BY timestamp ASC, id ASC",
        )
        .map_err(|e| Error::from_reason(format!("OneRing load prepare failed: {}", e)))?;
    let rows = stmt
        .query_map(params![agent_name, limit as i64], |row| {
            Ok(CachedRecord::new(
                row.get::<_, i64>(0)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| Error::from_reason(format!("OneRing load query failed: {}", e)))?;

    let mut records = Vec::new();
    for record in rows.flatten() {
        records.push(record);
    }
    Ok(records)
}

fn upsert_cache_record(
    state: &Arc<RwLock<OneRingState>>,
    db_path: String,
    agent_name: String,
    row: CachedRecord,
    max_records: usize,
) -> Result<()> {
    let mut guard = state
        .write()
        .map_err(|e| Error::from_reason(format!("OneRingEngine state write lock failed: {}", e)))?;
    let cache = guard.agents.entry(agent_name).or_insert_with(|| AgentCache {
        db_path,
        records: VecDeque::new(),
        max_records: max_records.max(1),
    });
    cache.records.retain(|record| record.id != row.id);
    cache.records.push_back(row);
    while cache.records.len() > cache.max_records.max(max_records).max(1) {
        cache.records.pop_front();
    }
    Ok(())
}

fn prune_agent_messages_sqlite(conn: &rusqlite::Connection, agent_name: &str, max_records: usize) -> rusqlite::Result<()> {
    if max_records == 0 {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM messages
         WHERE agentName=?1
           AND id NOT IN (
             SELECT id FROM messages
             WHERE agentName=?2
             ORDER BY timestamp DESC, id DESC
             LIMIT ?3
           )",
        params![agent_name, agent_name, max_records as i64],
    )?;
    Ok(())
}

fn prepare_text(text: &str) -> PreparedText {
    let normalized = normalize_text(text);
    let len = normalized.chars().count();
    let prefix: String = normalized.chars().take(256).collect();
    let suffix: String = normalized
        .chars()
        .rev()
        .take(256)
        .collect::<String>()
        .chars()
        .rev()
        .collect();

    PreparedText {
        hash: hash_str(&normalized),
        prefix_hash: hash_str(&prefix),
        suffix_hash: hash_str(&suffix),
        token_bits: token_sketch(&normalized),
        normalized,
        len,
    }
}

fn normalize_text(text: &str) -> String {
    let without_system_notice = strip_between_markers(text, "[系统通知]", "[系统通知结束]");
    let without_tail = strip_onering_tail(without_system_notice.trim());
    let without_group_head = strip_groupchat_head(without_tail);
    without_group_head
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_between_markers(text: &str, start: &str, end: &str) -> String {
    let mut rest = text;
    let mut out = String::with_capacity(text.len());
    loop {
        let Some(start_idx) = rest.find(start) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start_idx]);
        let after_start = &rest[start_idx + start.len()..];
        if let Some(end_idx) = after_start.find(end) {
            rest = &after_start[end_idx + end.len()..];
        } else {
            break;
        }
    }
    out
}

fn strip_onering_tail(text: &str) -> &str {
    let mut current = text.trim_end();
    loop {
        let Some(start) = current.rfind("[OneRing通知:") else {
            return current.trim();
        };
        let tail = &current[start..];
        if tail.contains(']') && tail.trim_end().ends_with(']') {
            current = current[..start].trim_end();
        } else {
            return current.trim();
        }
    }
}

fn strip_groupchat_head(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('[') {
        return trimmed;
    }
    if let Some(end) = trimmed.find("的发言]") {
        let after = &trimmed[end + "的发言]".len()..];
        return after.trim_start_matches([' ', ':', '：', '\t']);
    }
    trimmed
}

fn hash_str(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn token_sketch(value: &str) -> u64 {
    let mut bits = 0u64;
    for token in value.split_whitespace().take(256) {
        let h = hash_str(token);
        bits |= 1u64 << (h & 63);
    }
    bits
}

fn sketch_overlap(a: u64, b: u64) -> f64 {
    let inter = (a & b).count_ones() as f64;
    let union = (a | b).count_ones() as f64;
    if union <= 0.0 {
        1.0
    } else {
        inter / union
    }
}

fn diff_context_native(
    post_blocks: &[OneRingPostBlock],
    db_blocks: &[CachedRecord],
    threshold: f64,
) -> NativeDiffResult {
    let mut result = NativeDiffResult {
        matched_count: 0,
        unknown_count: 0,
        edited_blocks: Vec::new(),
        new_blocks: Vec::new(),
        reliable: true,
    };

    if post_blocks.is_empty() {
        return result;
    }

    if db_blocks.is_empty() {
        result.new_blocks = post_blocks
            .iter()
            .enumerate()
            .map(|(idx, block)| OneRingNewBlock {
                post_index: idx as i32,
                role: block.role.clone(),
                text: block.text.clone(),
                sender_name: block.sender_name.clone(),
                index: block.index,
            })
            .collect();
        return result;
    }

    let prepared_post = post_blocks
        .iter()
        .map(|block| {
            let prepared = prepare_text(&block.text);
            PreparedPostBlock {
                role: block.role.clone(),
                text: block.text.clone(),
                sender_name: block.sender_name.clone(),
                index: block.index,
                normalized: prepared.normalized,
                hash: prepared.hash,
                prefix_hash: prepared.prefix_hash,
                suffix_hash: prepared.suffix_hash,
                len: prepared.len,
                token_bits: prepared.token_bits,
            }
        })
        .collect::<Vec<_>>();

    let edit_floor = (threshold - 0.25).max(0.55);
    let max_start = db_blocks.len().saturating_sub(1);

    let best_start = (0..=max_start)
        .into_par_iter()
        .map(|start| {
            let mut score = 0.0f64;
            let mut exact = 0usize;
            for (pi, pb) in prepared_post.iter().enumerate() {
                let Some(db_item) = db_blocks.get(start + pi) else {
                    score -= 0.25;
                    continue;
                };
                if db_item.role != pb.role {
                    score -= 1.0;
                    continue;
                }
                if db_item.hash == pb.hash {
                    score += 1.0;
                    exact += 1;
                } else {
                    score += fast_similarity_prepared(pb, db_item, false);
                }
            }
            (start, score, exact)
        })
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        })
        .map(|(start, _, _)| start)
        .unwrap_or(0);

    let mut di = best_start;
    for (pi, pb) in prepared_post.iter().enumerate() {
        if di >= db_blocks.len() {
            result.new_blocks.push(OneRingNewBlock {
                post_index: pi as i32,
                role: pb.role.clone(),
                text: pb.text.clone(),
                sender_name: pb.sender_name.clone(),
                index: pb.index,
            });
            continue;
        }

        let db_item = &db_blocks[di];
        if db_item.role != pb.role {
            result.unknown_count += 1;
            result.reliable = false;
            di += 1;
            continue;
        }

        let sim = if db_item.hash == pb.hash {
            1.0
        } else {
            fast_similarity_prepared(pb, db_item, true)
        };

        if sim >= threshold {
            result.matched_count += 1;
        } else if sim >= edit_floor {
            result.edited_blocks.push(OneRingEditedBlock {
                post_index: pi as i32,
                db_id: db_item.id,
                old_content: db_item.content.clone(),
                new_text: pb.text.clone(),
                similarity: sim,
            });
        } else {
            result.unknown_count += 1;
            result.reliable = false;
        }

        di += 1;
    }

    result
}

fn fast_similarity_prepared(a: &PreparedPostBlock, b: &CachedRecord, strict: bool) -> f64 {
    if a.hash == b.hash {
        return 1.0;
    }

    let max_len = a.len.max(b.len);
    if max_len == 0 {
        return 1.0;
    }
    let min_len = a.len.min(b.len);
    let len_ratio = min_len as f64 / max_len as f64;
    if len_ratio < 0.5 {
        return len_ratio;
    }

    let prefix_match = a.prefix_hash == b.prefix_hash;
    let suffix_match = a.suffix_hash == b.suffix_hash;
    let sketch = sketch_overlap(a.token_bits, b.token_bits);

    if !strict {
        if prefix_match && suffix_match {
            return 0.96 * len_ratio.max(0.8);
        }
        if sketch < 0.18 && !prefix_match && !suffix_match {
            return len_ratio.min(0.35);
        }
        if max_len > 512 {
            return (0.55 * sketch + 0.45 * len_ratio).min(0.89);
        }
    }

    if max_len > 4096 {
        let boundary = match (prefix_match, suffix_match) {
            (true, true) => 1.0,
            (true, false) | (false, true) => 0.72,
            (false, false) => 0.0,
        };
        return (0.45 * sketch + 0.35 * len_ratio + 0.20 * boundary).min(0.98);
    }

    let dist = levenshtein(&a.normalized, &b.normalized);
    1.0 - (dist as f64 / max_len as f64)
}

fn levenshtein(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }

    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();

    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }

    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];

    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[n]
}
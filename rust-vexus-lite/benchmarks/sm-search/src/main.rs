// Run production SQL-host code without loading a Node-API test host.
#![allow(dead_code)]
#[path = "../../../src/index_source.rs"]
mod index_source;
#[path = "../../../src/retrieval_index.rs"]
mod retrieval_index;
use retrieval_index::{RetrievalIndex, RetrievalSearchOptions};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
static READS: AtomicUsize = AtomicUsize::new(0);
fn env(name: &str) -> String { std::env::var(name).unwrap() }
fn trace(sql: &str) {
    if sql.starts_with("SELECT vector FROM tags WHERE id=") { READS.fetch_add(1, Ordering::Relaxed); }
}
fn rows(path: &str, count: usize) -> Vec<Vec<f32>> {
    std::fs::read(path).unwrap().chunks_exact(3072 * 4).take(count).map(|row|
        row.chunks_exact(4).map(|v| f32::from_le_bytes(v.try_into().unwrap())).collect()).collect()
}
fn main() {
    let db = env("BENCH_DB");
    assert!(!std::path::Path::new(&db).exists(), "BENCH_DB must be a new file");
    let mut connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536; PRAGMA mmap_size=0; CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB); BEGIN;").unwrap();
    let library = rows(&env("BENCH_LIB"), 97464);
    {
        let mut statement = connection.prepare("INSERT INTO tags VALUES (?1,?2)").unwrap();
        for (i, row) in library.iter().enumerate() {
            let bytes: Vec<u8> = row.iter().flat_map(|v| v.to_le_bytes()).collect();
            statement.execute(rusqlite::params![(i + 1) as i64, bytes]).unwrap();
        }
    }
    connection.execute_batch("COMMIT; BEGIN;").unwrap();
    let index = RetrievalIndex::from_sql(index_source::build_memory_from_connection(
        &connection, None, 3072, "gemini-embedding-2-preview").unwrap());
    eprintln!("Built {} rows", index.size());
    let queries = rows(&env("BENCH_QUERIES"), 500);
    let truth_bytes = std::fs::read(env("BENCH_REAL_TRUTH")).unwrap();
    let truth: Vec<Vec<u64>> = truth_bytes.chunks_exact(300 * 8).map(|row|
        row.chunks_exact(8).map(|v| u64::from_le_bytes(v.try_into().unwrap())).collect()).collect();
    assert_eq!(truth.len(), queries.len());
    connection.trace(Some(trace));
    let mut results = Vec::new();
    for excluded_top in [0usize, 32, 64, 128] {
        for (mode, ef, requested_k, pushdown) in [
            ("post_filter_128", 128, 64, false),
            ("expanded_post_filter", 128 + excluded_top, 64 + excluded_top, false),
            ("pushdown_128", 128, 10, true),
            ("pushdown_256", 256, 10, true),
        ] {
            let mut records = Vec::new();
            let mut total_reads = 0usize;
            let mut total_hits = 0usize;
            for (qi, query) in queries.iter().enumerate() {
                let excluded: HashSet<_> = truth[qi][..excluded_top].iter().copied().collect();
                let options = RetrievalSearchOptions {
                    ef_search: Some(ef), exclude_ids: if pushdown { excluded.clone() } else { HashSet::new() },
                };
                READS.store(0, Ordering::Relaxed);
                let found = index.search_sql_options(&connection, None, query, requested_k, &options).unwrap();
                let valid: Vec<_> = found.iter().map(|p| p.0).filter(|id| !excluded.contains(id)).take(10).collect();
                let expected = &truth[qi][excluded_top..excluded_top + 10];
                let hits = expected.iter().filter(|id| valid.contains(id)).count();
                let reads = READS.load(Ordering::Relaxed);
                total_hits += hits; total_reads += reads;
                assert!(valid.iter().all(|id| !excluded.contains(id)));
                records.push(serde_json::json!({"query":qi,"found":valid,"truth":expected,"sql_reads":reads}));
            }
            eprintln!("M={excluded_top} {mode}: recall10={:.4}, sql_reads={:.2}", total_hits as f64/(queries.len()*10) as f64, total_reads as f64/queries.len() as f64);
            results.push(serde_json::json!({"excluded_top":excluded_top,"mode":mode,"ef":ef,
                "requested_k":requested_k,"recall10":total_hits as f64/(queries.len()*10) as f64,
                "mean_sql_vector_reads":total_reads as f64/queries.len() as f64,"query_records":records}));
        }
    }
    connection.trace(None);
    let output = serde_json::json!({"library_rows":index.size(),"queries":queries.len(),"dimension":3072,
        "rayon_threads":rayon::current_num_threads(),"sqlite_version":rusqlite::version(),"results":results,
        "scope":"actual SQL function; counts include final vector rereads; adversarial true-top-M exclusions; no latency claim",
        "post_filter_contract":"request 64 (or 64+M) results, filter IDs, take ten; pushdown requests ten with the unchanged max(64,k) rerank budget"});
    std::fs::write(env("BENCH_OUT"), serde_json::to_vec_pretty(&output).unwrap()).unwrap();
}

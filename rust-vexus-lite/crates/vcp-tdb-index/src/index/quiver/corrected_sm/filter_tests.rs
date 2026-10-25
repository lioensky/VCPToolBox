use super::*;

fn fixture(dim: usize) -> (CorrectedSmIndex, Vec<Vec<f32>>) {
    let rows = (0..96).map(|i| {
        let mut row = (0..dim).map(|j| ((i * 37 + j * 19 + i * j * 7) % 211) as f32 - 105.)
            .collect::<Vec<_>>();
        let norm = row.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        for x in &mut row { *x = (*x as f64 / norm) as f32; }
        row
    }).collect::<Vec<_>>();
    let graph = (0..96).map(|i| vec![((i + 1) % 96) as u32]).collect();
    let ids = (0..96).map(|i| 1001 + i * 3).collect();
    let index = CorrectedSmIndex::from_vectors_and_graph(dim, &rows.concat(), graph, ids, 0).unwrap();
    (index, rows)
}

#[test]
fn excluded_entry_and_hubs_route_without_entering_the_result_pool() {
    for dim in [65, 768, 1536] {
        let (index, rows) = fixture(dim);
        let cfg = QuIVerSearchConfig { top_k: 10, ef_search: 80, rerank_limit: Some(64) };
        let mut reads = Vec::new();
        let result = index.search_routed_filtered(&rows[80], &index.graph, &cfg,
            &|id| id < 1001 + 64 * 3, |slot, out| {
                reads.push(slot); out.extend_from_slice(&rows[slot]); true
            }).unwrap();
        assert_eq!(result.neighbors.len(), 10);
        assert_eq!(reads.len(), 32);
        assert!(reads.iter().all(|slot| *slot >= 64));
        assert!(result.neighbors.iter().all(|(id, _)| *id >= 1001 + 64 * 3));
        let mut reads = 0;
        let empty = index.search_routed_filtered(&rows[80], &index.graph, &cfg,
            &|_| true, |_, _| { reads += 1; false }).unwrap();
        assert!(empty.neighbors.is_empty());
        assert_eq!(reads, 0);
    }
}

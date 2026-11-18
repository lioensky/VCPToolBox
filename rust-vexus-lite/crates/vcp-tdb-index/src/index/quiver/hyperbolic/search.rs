//! Query budgets and diagnostics shared by production warped-field searches.

#[derive(Clone, Copy, Debug)]
pub struct HyperbolicSearchConfig {
    pub top_k: usize,
    pub width: usize,
    pub rerank_limit: usize,
    pub max_visits: usize,
    pub max_expansions: usize,
    pub radial_bound: bool,
}

#[derive(Default, Debug)]
pub struct HyperbolicSearchStats {
    pub visited: usize,
    pub expanded: usize,
    pub excluded_expanded: usize,
    pub visit_limit_reached: bool,
    pub expansion_limit_reached: bool,
    pub valid_candidates: usize,
    pub asymmetric_evals: usize,
    pub cold_reads: usize,
    pub radial_rejections: usize,
    pub exact_quad_skips: usize,
    pub exact_distance_evals: usize,
    /// Converted-tail nodes scored flat by the stage-0.5 proxy, without navigation.
    pub converted_scored: usize,
    pub seeds: usize,
    pub converged: bool,
}

#[derive(Debug)]
pub struct HyperbolicOutput {
    /// Original-vector warped distances, ordered from nearest to farthest.
    pub neighbors: Vec<(u64, f64)>,
    pub stats: HyperbolicSearchStats,
}
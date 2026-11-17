//! Compact direction scoring shared by warped-field construction and navigation.
//! Adapted from Pelorus (Apache-2.0), Copyright 2024 TriviumDB Authors.
use super::*;
use crate::index::bq::{sm_counts, Bq2Store};

pub(crate) fn planes(store: &Bq2Store, node: usize) -> (&[u64], &[u64]) {
    let start = node * store.chunks();
    let end = start + store.chunks();
    (&store.pos_data()[start..end], &store.strong_data()[start..end])
}
pub(crate) fn pair_cosine(store: &Bq2Store, meta: &[PolarNodeMeta], a: usize, b: usize, dim: usize) -> f64 {
    if a == b { return 1.0; }
    let (ap, ah) = planes(store, a);
    let (bp, bh) = planes(store, b);
    meta[a].sm().calibrated_cosine(meta[b].sm(), sm_counts::counts(ap, ah, bp, bh, dim), dim)
}
pub(crate) fn query_cosine(
    store: &Bq2Store, meta: &[PolarNodeMeta], node: usize,
    signature: &Bq2Signature, sm: SmCodeParams, dim: usize,
) -> f64 {
    let (p, h) = planes(store, node);
    sm.calibrated_cosine(meta[node].sm(),
        sm_counts::counts(&signature.pos[..store.chunks()], &signature.strong[..store.chunks()], p, h, dim), dim)
}
//! Production warped-field geometry and compact direction encoding.
//! Geometry references: Pelorus, Apache-2.0, Copyright 2024 TriviumDB Authors.
mod beam;
mod connectivity;
mod routing;
mod search;
pub mod warped_geometry;
mod warped_graph;
mod warped;
pub use warped::{WarpedFieldConfig, WarpedFieldIndex, WarpedSearchTrace, WarpedSeedMode,
    WarpedNavigationOptions, WarpedRerankOptions, warped_size_budget};
pub use search::{HyperbolicOutput, HyperbolicSearchConfig, HyperbolicSearchStats};
use super::asymmetric::SmCodeParams;
use crate::index::bq::Bq2Signature;
use std::io;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Stable snapshot layout: radial coordinates plus compact direction amplitudes.
#[repr(C, align(32))]
#[derive(Clone, Copy, Debug)]
pub struct PolarNodeMeta {
    pub radius: f32,
    pub boundary_factor: f32,
    pub depth: f32,
    sm_weak: f32,
    sm_delta: f32,
    sm_sigma: f32,
    packed_strong_cone: u32,
    cone_alpha: f32,
}
const _: () = assert!(std::mem::size_of::<PolarNodeMeta>() == 32);

impl PolarNodeMeta {
    /// Encode direction only. The field builder supplies its trained radius.
    pub(crate) fn encode(vector: &[f32]) -> io::Result<(Self, Bq2Signature)> {
        let norm = checked_norm(vector)?;
        let unit: Vec<f32> = vector.iter().map(|&v| (v as f64 / norm) as f32).collect();
        let signature = Bq2Signature::from_vector(&unit);
        let mut sums = [0.0; 2];
        let mut counts = [0u32; 2];
        for (j, &v) in unit.iter().enumerate() {
            let group = ((signature.strong[j / 64] >> (j % 64)) & 1) as usize;
            sums[group] += v.abs() as f64;
            counts[group] += 1;
        }
        let mean = |g: usize| if counts[g] == 0 { 0.0 } else { sums[g] / counts[g] as f64 };
        let weak = mean(0) as f32;
        let delta = mean(1) as f32 - weak;
        let sigma = (counts[0] as f64 * (weak as f64).powi(2)
            + counts[1] as f64 * ((weak + delta) as f64).powi(2)).sqrt() as f32;
        Ok((Self {
            radius: 0.0,
            boundary_factor: 1.0,
            depth: 0.0,
            sm_weak: weak, sm_delta: delta, sm_sigma: sigma,
            packed_strong_cone: (0xfff << 20) | counts[1],
            cone_alpha: 0.0,
        }, signature))
    }

    pub(crate) fn sm(self) -> SmCodeParams {
        SmCodeParams { weak: self.sm_weak, delta: self.sm_delta,
            sigma: self.sm_sigma, strong_ones: self.packed_strong_cone & 0xfffff }
    }
}

fn checked_norm(vector: &[f32]) -> io::Result<f64> {
    if vector.is_empty() || vector.iter().any(|v| !v.is_finite()) {
        return Err(invalid("invalid original direction"));
    }
    let norm = crate::metric_math::norm_squared_f64(vector).sqrt();
    if norm <= 0.0 { return Err(invalid("zero vector has no polar direction")); }
    Ok(norm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_encoding_preserves_snapshot_layout_and_bit_counts() {
        assert_eq!(std::mem::size_of::<PolarNodeMeta>(), 32);
        assert_eq!(std::mem::align_of::<PolarNodeMeta>(), 32);
        for dim in [65, 384, 768, 1536, 3072] {
            let vector: Vec<f32> = (0..dim).map(|j| ((j * 13 + 1) as f32).sin()).collect();
            let (meta, signature) = PolarNodeMeta::encode(&vector).unwrap();
            assert_eq!(meta.radius, 0.0);
            assert_eq!(meta.boundary_factor, 1.0);
            assert_eq!(meta.depth, 0.0);
            assert!(meta.sm().sigma.is_finite() && meta.sm().sigma > 0.0);
            assert_eq!(meta.sm().strong_ones,
                signature.strong.iter().map(|word| word.count_ones()).sum::<u32>());
        }
    }

    #[test]
    fn direction_encoding_is_invariant_under_power_of_two_scaling() {
        let vector = [1.0, -2.0, 0.5, -0.25];
        let scaled = vector.map(|v| v * 8.0);
        let (a, sa) = PolarNodeMeta::encode(&vector).unwrap();
        let (b, sb) = PolarNodeMeta::encode(&scaled).unwrap();
        assert_eq!(sa.pos, sb.pos);
        assert_eq!(sa.strong, sb.strong);
        assert_eq!(a.sm_weak.to_bits(), b.sm_weak.to_bits());
        assert_eq!(a.sm_delta.to_bits(), b.sm_delta.to_bits());
        assert_eq!(a.sm_sigma.to_bits(), b.sm_sigma.to_bits());
    }

    #[test]
    fn direction_encoding_rejects_empty_zero_and_nonfinite_vectors() {
        for vector in [&[][..], &[0.0][..], &[f32::NAN][..], &[f32::INFINITY][..]] {
            assert!(PolarNodeMeta::encode(vector).is_err());
        }
    }
}
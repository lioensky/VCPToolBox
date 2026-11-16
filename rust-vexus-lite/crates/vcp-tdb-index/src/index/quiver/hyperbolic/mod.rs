//! Isolated warped-product geometry; original FP32 rows remain authoritative.
//! Geometry references: Pelorus, Apache-2.0, Copyright 2024 TriviumDB Authors.
//! No process-global experiment controls and no persistent format changes.
mod beam;
mod routing;
mod construction;
mod index;
pub use index::{HyperbolicConfig, HyperbolicIndex, HyperbolicOutput, HyperbolicSearchConfig, HyperbolicSearchStats};
use super::asymmetric::SmCodeParams;
use crate::index::bq::Bq2Signature;
use std::io;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum IndexMetric {
    #[default]
    Cosine,
    Poincare { curvature: f64 },
}

impl IndexMetric {
    pub fn validate(self) -> io::Result<()> {
        match self {
            Self::Cosine => Ok(()),
            Self::Poincare { curvature } if curvature.is_finite() && curvature > 0.0 => Ok(()),
            _ => Err(invalid("curvature must be finite and positive")),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DepthConfig {
    pub min: f64,
    pub max: f64,
}
impl Default for DepthConfig {
    fn default() -> Self { Self { min: 0.35, max: 3.20 } }
}
impl DepthConfig {
    pub fn validate(self) -> io::Result<()> {
        if !self.min.is_finite() || !self.max.is_finite()
            || self.min < 0.0 || self.max < self.min || self.max > 16.0
        { return Err(invalid("invalid dimensionless depth support")); }
        Ok(())
    }
    pub fn map(self, specificity: f64) -> io::Result<f64> {
        self.validate()?;
        if !specificity.is_finite() { return Err(invalid("nonfinite specificity")); }
        Ok(self.min + (self.max - self.min) * specificity.clamp(0.0, 1.0))
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Derived only: radius and factor in the original source are NOT overwritten.
#[derive(Clone, Copy, Debug)]
pub struct PolarPoint {
    pub(crate) radius: f64,
    pub(crate) factor: f64,
    pub(crate) depth: f64,
}
impl PolarPoint {
    pub fn new(depth: f64, curvature: f64) -> io::Result<Self> {
        IndexMetric::Poincare { curvature }.validate()?;
        if !depth.is_finite() || !(0.0..=16.0).contains(&depth) {
            return Err(invalid("depth must be within 0..=16"));
        }
        let point = Self {
            radius: (depth / 2.0).tanh() / curvature.sqrt(),
            factor: (depth / 2.0).cosh().powi(2),
            depth,
        };
        if !point.radius.is_finite() || !point.factor.is_finite()
            || (point.radius > 0.0 && point.radius as f32 == 0.0)
            || point.radius > f32::MAX as f64
        { return Err(invalid("geometry cannot be represented by sidecar")); }
        Ok(point)
    }
    pub fn proxy(self, other: Self, cosine: f64) -> f64 {
        let radial = self.radius - other.radius;
        (radial * radial + 2.0 * self.radius * other.radius
            * (1.0 - cosine.clamp(-1.0, 1.0))) * self.factor * other.factor
    }
}

/// Same 32B sidecar shape as Pelorus; residual encoding remains disabled.
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
    pub(crate) fn encode(vector: &[f32], point: PolarPoint) -> io::Result<(Self, Bq2Signature)> {
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
            radius: point.radius as f32,
            boundary_factor: point.factor as f32,
            depth: point.depth as f32,
            sm_weak: weak, sm_delta: delta, sm_sigma: sigma,
            packed_strong_cone: (0xfff << 20) | counts[1],
            cone_alpha: 0.0,
        }, signature))
    }

    pub fn exact_point(self, curvature: f64) -> io::Result<PolarPoint> {
        PolarPoint::new(self.depth as f64, curvature)
    }

    pub(crate) fn sm(self) -> SmCodeParams {
        SmCodeParams { weak: self.sm_weak, delta: self.sm_delta,
            sigma: self.sm_sigma, strong_ones: self.packed_strong_cone & 0xfffff }
    }

    /// Conservative radial bound; never a navigation bridge eligibility gate.
    pub fn radial_lower_bound(self, query: PolarPoint) -> f64 {
        let radius = self.radius as f64;
        let factor = self.boundary_factor as f64;
        let margin = 1e-6 * (query.radius + radius) + f32::from_bits(1) as f64;
        let gap = ((query.radius - radius).abs() - margin).max(0.0);
        let lower = gap * gap * query.factor * factor * (1.0 - 1e-5);
        if lower.is_finite() { lower.max(0.0) } else { 0.0 }
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

/// Exact original-direction distance; O(D) scratch-free, never norm-minus-dot.
/// Even near-coincident directions retain their FP64 coordinate differences.
pub fn exact_proxy(a: &[f32], pa: PolarPoint, b: &[f32], pb: PolarPoint) -> io::Result<f64> {
    if a.len() != b.len() { return Err(invalid("direction dimension mismatch")); }
    let (na, nb) = (checked_norm(a)?, checked_norm(b)?);
    let mut angular_delta = 0.0;
    for (&x, &y) in a.iter().zip(b) {
        let d = x as f64 / na - y as f64 / nb;
        angular_delta += d * d;
    }
    let radial = pa.radius - pb.radius;
    Ok((radial * radial + pa.radius * pb.radius * angular_delta) * pa.factor * pb.factor)
}

pub fn geodesic_distance(proxy: f64, curvature: f64) -> f64 {
    2.0 / curvature.sqrt() * (curvature * proxy.max(0.0)).sqrt().asinh()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polar_router_is_deterministic_and_seeds_are_unique() {
        let dim = 65;
        let mut store = crate::index::bq::Bq2Store::new(dim);
        let mut meta = Vec::new();
        for node in 0..128 {
            let row: Vec<f32> = (0..dim).map(|j| ((node * 79 + j * 13) as f32).sin()).collect();
            let depth = (0.35 + 2.85 * node as f64 / 127.0) as f32 as f64;
            let (header, sig) = PolarNodeMeta::encode(&row, PolarPoint::new(depth, 1.0).unwrap()).unwrap();
            meta.push(header);
            store.push_sig(&sig);
        }
        let first = routing::PolarRouter::build(&store, meta.clone(), dim);
        let second = routing::PolarRouter::build(&store, meta, dim);
        assert_eq!(first.landmarks, second.landmarks);
        assert_eq!(first.edges, second.edges);
        assert_eq!(first.hubs[0], 0);
        assert!(first.edges.windows(2).all(|p| p[0] <= p[1]));
        let sig = store.get_sig(100);
        let seeds = first.query_seeds(&store, &sig, first.meta[100].sm(), 2.5, dim, 32);
        assert!(!seeds.is_empty());
        assert!(seeds.len() <= 128);
        let unique: std::collections::HashSet<_> = seeds.iter().copied().collect();
        assert_eq!(seeds.len(), unique.len());
        assert!(seeds.iter().all(|&node| node < 128));
    }
    #[test]
    fn geometry_curvature_scaling_and_near_neighbor_precision() {
        for dim in [384, 768, 3072] {
            let a = vec![1.0f32; dim];
            let mut b = a.clone();
            b[dim - 1] = f32::from_bits(1.0f32.to_bits() + 1);
            for depth in [1.80, 2.50, 3.20] {
                let p = PolarPoint::new(depth, 1.0).unwrap();
                let delta = exact_proxy(&a, p, &b, p).unwrap();
                assert!(delta > 0.0);
                assert_eq!(exact_proxy(&a, p, &a, p).unwrap(), 0.0);
                let scaled = PolarPoint::new(depth, 4.0).unwrap();
                let other = exact_proxy(&a, scaled, &b, scaled).unwrap();
                assert!((other * 4.0 - delta).abs() <= delta * 1e-12);
                let (meta, _) = PolarNodeMeta::encode(&a, p).unwrap();
                assert!(meta.sm().sigma > 0.0);
                assert_eq!(meta.radial_lower_bound(p), 0.0);
            }
        }
    }
    #[test]
    fn geometry_rejects_invalid_sources_and_configuration() {
        assert!(IndexMetric::Poincare { curvature: f64::NAN }.validate().is_err());
        assert!(PolarPoint::new(3.2, 0.0).is_err());
        assert!(DepthConfig { min: 2.0, max: 1.0 }.validate().is_err());
        let p = PolarPoint::new(1.0, 1.0).unwrap();
        assert!(exact_proxy(&[0.0], p, &[1.0], p).is_err());
        assert!(PolarNodeMeta::encode(&[f32::NAN], p).is_err());
    }
}
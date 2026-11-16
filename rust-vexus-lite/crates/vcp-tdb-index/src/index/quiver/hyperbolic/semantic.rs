//! Query-local semantic score, NOT the original Poincare metric.
//! Frozen v1 rule; no query labels, oracle scores, layer number or mutable globals.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SemanticBackground {
    Mean,
    LandmarkMedian,
}
#[derive(Clone, Copy, Debug)]
pub struct SemanticConeConfig {
    pub background: SemanticBackground,
    pub noise_z: f64,
    pub residual_width: f64,
    pub anisotropic_width_gain: f64,
    pub alignment_reference: f64,
}
impl Default for SemanticConeConfig {
    fn default() -> Self {
        Self { background: SemanticBackground::Mean, noise_z: 4.0,
            residual_width: 0.25, anisotropic_width_gain: 0.05,
            alignment_reference: 0.45 }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct SemanticCone {
    pub mean_alignment: f64,
    pub baseline: f64,
    pub sigma_reference: f64,
    pub background: f64,
    pub top: f64,
    pub landmark_evals: usize,
}
impl SemanticConeConfig {
    pub fn validate(self) -> io::Result<()> {
        if !self.noise_z.is_finite() || self.noise_z < 0.0
            || !self.residual_width.is_finite() || self.residual_width <= 0.0
            || !self.anisotropic_width_gain.is_finite() || self.anisotropic_width_gain < 0.0
            || !self.alignment_reference.is_finite() || self.alignment_reference <= 0.0 {
            return Err(invalid("invalid adaptive semantic cone"));
        }
        Ok(())
    }
    pub fn resolve(self, dim: usize, mean_alignment: f64, baseline: f64,
        landmark_evals: usize) -> io::Result<SemanticCone> {
        self.validate()?;
        if dim == 0 || !mean_alignment.is_finite() || !baseline.is_finite() {
            return Err(invalid("invalid cone input statistics"));
        }
        let b = baseline.clamp(0.0, 0.95);
        let sigma = 1.0 / (dim as f64).sqrt();
        let background = (b + self.noise_z * sigma).min(0.98);
        let width = self.residual_width + self.anisotropic_width_gain
            * (b / self.alignment_reference).clamp(0.0, 1.0);
        let top = (b + width).max(background + 0.001).min(0.999);
        Ok(SemanticCone { mean_alignment, baseline: b, sigma_reference: sigma,
            background, top, landmark_evals })
    }
}
impl SemanticCone {
    pub fn effective(self, cosine: f64) -> f64 {
        ((cosine - self.background) / (self.top - self.background)).clamp(0.0, 1.0)
    }
    pub fn admits(self, exact_cosine: f64) -> bool { exact_cosine > self.background }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rule_scales_with_background_not_layer_or_labels() {
        let cfg = SemanticConeConfig::default();
        let raw = cfg.resolve(3072, 0.45, 0.45, 0).unwrap();
        let residual = cfg.resolve(3072, 0.0, 0.0, 0).unwrap();
        assert!(raw.background > 0.5 && raw.top >= 0.7);
        assert!(residual.background > 0.07 && residual.background < 0.08);
        assert_eq!(residual.top, 0.25);
        assert!(!raw.admits(0.486));
        assert!(residual.admits(0.18));
        assert!(!residual.admits(0.016));
        assert_eq!(raw.effective(raw.background), 0.0);
        assert_eq!(raw.effective(raw.top), 1.0);
    }
    #[test]
    fn invalid_and_small_dimension_statistics_are_safe() {
        for dim in [65, 384, 768, 1536, 3072] {
            for b in [-1.0, 0.0, 0.45, 1.0] {
                let c = SemanticConeConfig::default().resolve(dim, b, b, 0).unwrap();
                assert!(c.top > c.background && c.top < 1.0);
            }
        }
        assert!(SemanticConeConfig::default().resolve(0, 0.0, 0.0, 0).is_err());
        assert!(SemanticConeConfig { noise_z: f64::NAN, ..Default::default() }.validate().is_err());
    }
}
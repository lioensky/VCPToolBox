//! Immutable streamed Tier-3 experiment. No original-vector ownership.
//! Geometry/graph adapted from Pelorus, Apache-2.0, Copyright 2024 TriviumDB Authors.
use super::*;
use super::beam::{bounded_beam, BeamBudget};
use super::routing::{planes, pair_cosine, query_cosine};
use super::super::asymmetric::{AsymQuerySm, AsymKernel};
use super::warped_geometry::{clairaut_distance, WarpedProfile, WarpedProxyTable};
use super::warped_graph::{VarGraph, QuadriPruneSpec};
use crate::index::bq::Bq2Store;

#[derive(Clone, Copy, Debug)]
pub struct WarpedFieldConfig {
    pub profile: WarpedProfile,
    pub radius_max: f64,
    pub mean_subtract_beta: f64,
    pub angular_tau: f64,
    pub angular_eta: f64,
    pub degree: usize,
    pub construction_width: usize,
    pub alpha: f64,
}
impl Default for WarpedFieldConfig {
    fn default() -> Self {
        Self { profile: WarpedProfile::Softening { alpha: 0.35 }, radius_max: 1.8,
            mean_subtract_beta: 0.7, angular_tau: 0.0, angular_eta: 1.0,
            degree: 32, construction_width: 128, alpha: 1.2 }
    }
}
impl WarpedFieldConfig {
    fn validate(self) -> io::Result<()> {
        self.profile.validate(self.radius_max)?;
        if !self.mean_subtract_beta.is_finite() || !(0.0..=1.0).contains(&self.mean_subtract_beta)
            || !self.angular_tau.is_finite() || !(0.0..=0.2).contains(&self.angular_tau)
            || !self.angular_eta.is_finite() || !(0.5..=1.0).contains(&self.angular_eta)
            || self.degree < 2 || self.construction_width == 0
            || !self.alpha.is_finite() || self.alpha < 1.0
        { return Err(invalid("invalid warped field configuration")); }
        Ok(())
    }
    /// Endpoint-preserving strictly monotone calibration; nonidentity is an
    /// experimental pair score, NOT automatically an embeddable angular metric.
    pub fn effective_cosine(self, cosine: f64) -> f64 {
        let c = cosine.clamp(-1.0, 1.0);
        let shifted = (c - self.angular_tau) / (1.0 - self.angular_tau * c);
        if self.angular_eta == 1.0 { shifted }
        else { shifted.signum() * shifted.abs().powf(self.angular_eta) }
    }
}

pub struct WarpedFieldIndex {
    dim: usize,
    ids: Vec<u64>,
    slots: Vec<usize>,
    meta: Vec<PolarNodeMeta>,
    store: Bq2Store,
    mean_axis: Vec<f64>,
    table: WarpedProxyTable,
    graph: Vec<u32>,
    offsets: Vec<usize>,
    entries: Vec<u32>,
    config: WarpedFieldConfig,
}
impl WarpedFieldIndex {
    fn transform(raw: &[f32], axis: &[f64], beta: f64) -> io::Result<Vec<f32>> {
        if raw.len() != axis.len() { return Err(invalid("warped direction dimension")); }
        let norm = checked_norm(raw)?;
        let alignment = raw.iter().zip(axis).map(|(&x,&m)| x as f64 / norm * m).sum::<f64>();
        let mut unit: Vec<f64> = raw.iter().zip(axis)
            .map(|(&x,&m)| x as f64 / norm - beta * alignment * m).collect();
        let length = unit.iter().map(|x| x*x).sum::<f64>().sqrt();
        if !length.is_finite() || length <= 1e-12 {
            return Err(invalid("mean subtraction annihilates direction"));
        }
        for x in &mut unit { *x /= length; }
        Ok(unit.into_iter().map(|x| x as f32).collect())
    }
    /// Mean is supplied from a frozen AGS generation or an explicitly separate
    /// streaming mean pass. Each indexed original is read exactly once here.
    pub fn build<F>(
        dim: usize, ids: &[u64], slots: &[usize], radii: &[f32], mean: &[f64],
        config: WarpedFieldConfig, mut fill: F,
    ) -> io::Result<Self>
    where F: FnMut(usize, &mut Vec<f32>) -> bool {
        config.validate()?;
        if dim == 0 || dim > crate::index::bq::MAX_BQ_DIM || mean.len() != dim
            || ids.len() != slots.len() || ids.len() != radii.len()
            || ids.len() > u32::MAX as usize || ids.contains(&0)
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
            || slots.iter().collect::<std::collections::HashSet<_>>().len() != slots.len()
            || mean.iter().any(|x| !x.is_finite())
            || radii.iter().any(|&r| !r.is_finite() || r < 0.0 || r as f64 > config.radius_max)
        { return Err(invalid("invalid streamed warped build contract")); }
        let mean_norm = mean.iter().map(|x| x*x).sum::<f64>().sqrt();
        let mean_axis = if mean_norm > 1e-12 {
            mean.iter().map(|x| x/mean_norm).collect::<Vec<_>>()
        } else { vec![0.0; dim] };
        let mut store = Bq2Store::new(dim);
        store.reserve(ids.len());
        let mut meta = Vec::with_capacity(ids.len());
        let mut row = Vec::with_capacity(dim);
        for (&slot,&radius) in slots.iter().zip(radii) {
            row.clear();
            if !fill(slot,&mut row) { return Err(invalid("warped build cold read failed")); }
            let unit = Self::transform(&row,&mean_axis,config.mean_subtract_beta)?;
            let (mut header,sig) = PolarNodeMeta::encode(&unit,PolarPoint::new(0.0,1.0)?)?;
            // Tier-3 radius is directly geodesic; no Poincare denominator.
            header.depth = radius;
            store.push_sig(&sig);
            meta.push(header);
        }
        let table = WarpedProxyTable::try_build(config.profile,config.radius_max,64,65)?;
        let mut order: Vec<u32> = (0..ids.len() as u32).collect();
        order.sort_unstable_by(|&a,&b| radii[a as usize].total_cmp(&radii[b as usize]).then(a.cmp(&b)));
        let entries: Vec<u32> = order.iter().take(8).copied().collect();
        let cosine = |a: usize,b: usize| pair_cosine(&store,&meta,a,b,dim);
        let distance = |a: usize,b: usize| {
            if a == b { 0.0 } else {
                table.eval(radii[a] as f64,radii[b] as f64,config.effective_cosine(cosine(a,b)))
            }
        };
        let radial = |a: usize,b: usize| (radii[a] as f64-radii[b] as f64).abs();
        let angular = |a: usize,b: usize| 1.0-config.effective_cosine(cosine(a,b));
        let depths: Vec<_> = radii.iter().map(|&r| r as f64).collect();
        let compass = QuadriPruneSpec {
            depths: &depths, radial_dist_fn: &radial, angular_loss_fn: &angular,
            iso_tol:0.60, elev_min:0.18, elev_step:0.65, geo_fraction:0.375,
            ang_guard_delta:0.45, elev_ang_delta:0.50,
            iso_score_uses_geodesic:false, bridge_cap:0,
        };
        let built = VarGraph::build_with_quadri(ids.len(),config.degree,
            config.construction_width,config.alpha,entries.clone(),distance,Some(&compass))?;
        let mut offsets = Vec::with_capacity(ids.len()+1);
        let mut graph = Vec::new();
        offsets.push(0);
        for neighbors in built.neighbors { graph.extend(neighbors); offsets.push(graph.len()); }
        Ok(Self {dim,ids:ids.to_vec(),slots:slots.to_vec(),meta,store,mean_axis,table,
            graph,offsets,entries,config})
    }
    pub fn exact_distance(&self, query: &[f32], radius: f32, row: &[f32], node: usize) -> io::Result<f64> {
        if node >= self.ids.len() || !radius.is_finite() || radius < 0.0 || radius as f64 > self.config.radius_max {
            return Err(invalid("invalid warped exact endpoint"));
        }
        let q = Self::transform(query,&self.mean_axis,self.config.mean_subtract_beta)?;
        let v = Self::transform(row,&self.mean_axis,self.config.mean_subtract_beta)?;
        let (qn,vn) = (checked_norm(&q)?,checked_norm(&v)?);
        let cosine = q.iter().zip(&v).map(|(&a,&b)| a as f64*b as f64).sum::<f64>()/qn/vn;
        Ok(clairaut_distance(self.config.profile,radius as f64,self.meta[node].depth as f64,
            self.config.effective_cosine(cosine)))
    }
    pub fn hot_bytes(&self) -> usize {
        self.store.hot_bytes()+self.meta.capacity()*std::mem::size_of::<PolarNodeMeta>()
            +self.mean_axis.capacity()*8+self.table.hot_bytes()+self.ids.capacity()*8
            +self.slots.capacity()*std::mem::size_of::<usize>()+self.graph.capacity()*4
            +self.offsets.capacity()*std::mem::size_of::<usize>()+self.entries.capacity()*4
    }
    pub fn connectivity(&self) -> (usize,usize) {
        let n = self.ids.len();
        if n == 0 { return (0,0); }
        let mut seen = vec![false;n];
        let mut incoming = vec![0usize;n];
        for &v in &self.graph { incoming[v as usize]+=1; }
        let mut queue = std::collections::VecDeque::from([self.entries[0]]);
        seen[self.entries[0] as usize]=true;
        while let Some(u)=queue.pop_front() {
            for &v in &self.graph[self.offsets[u as usize]..self.offsets[u as usize+1]] {
                if !seen[v as usize] {seen[v as usize]=true;queue.push_back(v);}
            }
        }
        (seen.iter().filter(|&&x|x).count(),incoming.iter().filter(|&&x|x==0).count())
    }
    pub fn search<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        exclude:E, mut fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        if config.width==0 || config.rerank_limit>64 || config.rerank_limit<config.top_k {
            return Err(invalid("warped query requires top_k <= cold budget <= 64"));
        }
        let slice=self.table.checked_slice(radius as f64)?;
        let unit=Self::transform(query,&self.mean_axis,self.config.mean_subtract_beta)?;
        let (qmeta,sig)=PolarNodeMeta::encode(&unit,PolarPoint::new(0.0,1.0)?)?;
        if config.top_k==0 || self.ids.is_empty() {
            return Ok(HyperbolicOutput {neighbors:Vec::new(),stats:Default::default()});
        }
        let evaluate=|node:u32| {
            let cosine=query_cosine(&self.store,&self.meta,node as usize,&sig,qmeta.sm(),self.dim);
            let c=self.config.effective_cosine(cosine);
            let r=self.meta[node as usize].depth;
            (slice.eval(r,c),1.0-c+0.20*(radius as f64-r as f64).abs())
        };
        let seed_cap=(config.width/2).min(config.max_visits/4);
        let mut seeds=self.entries.clone();
        // Bounded deterministic all-shell coverage, scored under the SAME table.
        for i in 0..64.min(self.ids.len()) {
            seeds.push((i*self.ids.len()/64.min(self.ids.len())) as u32);
        }
        seeds.sort_unstable();seeds.dedup();
        seeds.sort_unstable_by(|&a,&b|evaluate(a).0.total_cmp(&evaluate(b).0).then(a.cmp(&b)));
        seeds.truncate(seed_cap);
        let beam=bounded_beam(self.ids.len(),&seeds,BeamBudget {
            width:config.width,max_visits:config.max_visits,max_expansions:config.max_expansions},
            |n| &self.graph[self.offsets[n as usize]..self.offsets[n as usize+1]],
            evaluate,|n|!exclude(self.ids[n as usize]));
        let asym=AsymQuerySm::encode(&unit)?;
        let mut pool:Vec<_>=beam.candidates.iter().map(|&node| {
            let (p,h)=planes(&self.store,node as usize);
            let c=asym.calibrated_cosine(p,h,self.meta[node as usize].sm(),AsymKernel::Auto);
            (slice.eval(self.meta[node as usize].depth,self.config.effective_cosine(c)),node)
        }).collect();
        pool.sort_unstable_by(|a,b|a.0.total_cmp(&b.0).then(self.ids[a.1 as usize].cmp(&self.ids[b.1 as usize])));
        let mut stats=HyperbolicSearchStats {
            visited:beam.stats.visited,expanded:beam.stats.expanded,excluded_expanded:beam.stats.excluded_expanded,
            visit_limit_reached:beam.stats.visit_limit_reached,expansion_limit_reached:beam.stats.expansion_limit_reached,
            converged:beam.stats.converged,seeds:seeds.len(),valid_candidates:pool.len(),
            asymmetric_evals:pool.len(),..Default::default()
        };
        let mut row=Vec::with_capacity(self.dim);
        let mut exact:Vec<(u64,f64)>=Vec::new();
        for (_,node) in pool.into_iter().take(config.rerank_limit) {
            if config.radial_bound && exact.len()>=config.top_k
                && (radius as f64-self.meta[node as usize].depth as f64).abs()-1e-10>exact.last().unwrap().1 {
                stats.radial_rejections+=1;continue;
            }
            row.clear();stats.cold_reads+=1;
            if !fill(self.slots[node as usize],&mut row) {continue;}
            let d=self.exact_distance(query,radius,&row,node as usize)?;
            exact.push((self.ids[node as usize],d));
            exact.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            exact.truncate(config.top_k);
        }
        Ok(HyperbolicOutput {neighbors:exact,stats})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(node:usize,dim:usize)->Vec<f32> {
        (0..dim).map(|j| ((node*71+j*17+1) as f64*0.37).sin() as f32).collect()
    }
    #[test]
    fn streamed_field_cold_budget_exclusions_truth_and_connectivity() {
        for dim in [65,384,768,1536,3072] {
            let n=40;
            let ids:Vec<_>=(1..=n as u64).collect();
            let slots:Vec<_>=(0..n).map(|i|10+3*i).collect();
            let radii:Vec<_>=(0..n).map(|i|0.35+1.4*i as f32/(n-1) as f32).collect();
            let mut build_reads=0;
            let index=WarpedFieldIndex::build(dim,&ids,&slots,&radii,&vec![0.1;dim],
                WarpedFieldConfig {degree:12,construction_width:48,..Default::default()},
                |s,o| {build_reads+=1;*o=row((s-10)/3,dim);true}).unwrap();
            assert_eq!(build_reads,n);
            assert_eq!(index.connectivity(),(n,0));
            assert!(index.offsets.windows(2).all(|w|w[1]-w[0]<=12));
            let q=row(33,dim);
            let config=HyperbolicSearchConfig {top_k:10,width:64,rerank_limit:64,
                max_visits:n,max_expansions:n,radial_bound:false};
            let mut reads=std::collections::HashSet::new();
            let out=index.search(&q,radii[33],config,|id|id<=10,|s,o| {
                assert!(s>=slots[10]);
                assert!(reads.insert(s));*o=row((s-10)/3,dim);true
            }).unwrap();
            assert_eq!(reads.len(),out.stats.cold_reads);
            assert_eq!(reads.len(),30);
            let mut truth:Vec<_>=(10..n).map(|i| (ids[i],
                index.exact_distance(&q,radii[33],&row(i,dim),i).unwrap())).collect();
            truth.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            truth.truncate(10);
            assert_eq!(out.neighbors,truth);
            let filtered=index.search(&q,radii[33],
                HyperbolicSearchConfig {radial_bound:true,..config},|id|id<=10,
                |s,o|{*o=row((s-10)/3,dim);true}).unwrap();
            assert_eq!(out.neighbors,filtered.neighbors);
            assert!(filtered.stats.cold_reads<=out.stats.cold_reads);
            let empty=index.search(&q,1.0,config,|_|true,|_,_|panic!("excluded cold read")).unwrap();
            assert_eq!(empty.stats.cold_reads,0);
            assert_eq!(empty.stats.visited,n);
            assert!(index.search(&q,1.0,HyperbolicSearchConfig {rerank_limit:65,..config},
                |_|false,|_,_|panic!("invalid budget must fail before reads")).is_err());
            assert!(index.search(&q,2.0,config,|_|false,|_,_|panic!("outside support")).is_err());
        }
    }
    #[test]
    fn projection_and_angular_mapping_have_no_silent_dead_zone() {
        for beta in [0.0,0.7,1.0] {
            let q=WarpedFieldIndex::transform(&[1.0,2.0,3.0],&[1.0,0.0,0.0],beta).unwrap();
            assert!((checked_norm(&q).unwrap()-1.0).abs()<1e-7);
        }
        assert!(WarpedFieldIndex::transform(&[1.0,0.0],&[1.0,0.0],1.0).is_err());
        for tau in [0.0,0.1,0.2] {
            for eta in [0.5,0.75,1.0] {
                let cfg=WarpedFieldConfig {angular_tau:tau,angular_eta:eta,..Default::default()};
                let values:Vec<_>=(0..=1000).map(|i|cfg.effective_cosine(-1.0+i as f64/500.0)).collect();
                assert_eq!(values[0],-1.0);assert_eq!(values[1000],1.0);
                assert!(values.windows(2).all(|p|p[0]<p[1]));
            }
        }
    }
}
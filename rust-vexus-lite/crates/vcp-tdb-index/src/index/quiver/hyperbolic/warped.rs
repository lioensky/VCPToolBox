//! Immutable streamed production warped field. Originals remain SQL-owned.
//! Geometry/graph adapted from Pelorus, Apache-2.0, Copyright 2024 TriviumDB Authors.
use super::*;
use super::beam::{bounded_beam, reusable_beam, BeamBudget};
use super::routing::{planes, pair_cosine, query_cosine};
use super::super::asymmetric::{AsymQuerySm, AsymKernel};
use super::warped_geometry::{clairaut_distance, WarpedProfile, WarpedProxyTable};
use super::warped_graph::{VarGraph, QuadriPruneSpec};
use crate::index::bq::Bq2Store;

#[path = "warped_snapshot.rs"]
mod snapshot;
#[cfg(test)]
#[path = "warped_convert_tests.rs"]
mod convert_tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WarpedFieldConfig {
    pub profile: WarpedProfile,
    pub radius_max: f64,
    pub mean_subtract_beta: f64,
    pub throat_phi0: f64,
    pub angular_scale_kappa: f64,
    pub angular_tau: f64,
    pub angular_eta: f64,
    pub degree: usize,
    pub construction_width: usize,
    pub alpha: f64,
    pub adaptive_compass: bool,
}
impl Default for WarpedFieldConfig {
    fn default() -> Self {
        Self { profile: WarpedProfile::Softening { alpha: 0.35 }, radius_max: 1.8,
            mean_subtract_beta: 0.7, throat_phi0: 0.0, angular_scale_kappa: 1.0,
            angular_tau: 0.0, angular_eta: 1.0,
            degree: 32, construction_width: 128, alpha: 1.2, adaptive_compass: false }
    }
}
impl WarpedFieldConfig {
    fn validate(self) -> io::Result<()> {
        self.geometry_profile()?.validate(self.radius_max)?;
        if !self.mean_subtract_beta.is_finite() || !(0.0..=1.0).contains(&self.mean_subtract_beta)
            || !self.angular_tau.is_finite() || !(0.0..=0.2).contains(&self.angular_tau)
            || !self.angular_eta.is_finite() || !(0.5..=1.0).contains(&self.angular_eta)
            || self.degree < 2 || self.construction_width == 0
            || !self.alpha.is_finite() || self.alpha < 1.0
        { return Err(invalid("invalid warped field configuration")); }
        Ok(())
    }
    fn geometry_profile(self) -> io::Result<WarpedProfile> {
        if !self.throat_phi0.is_finite() || self.throat_phi0 < 0.0
            || !self.angular_scale_kappa.is_finite()
            || self.angular_scale_kappa <= 0.0 || self.angular_scale_kappa > 2.0 {
            return Err(invalid("invalid throat or angular metric scale"));
        }
        if self.throat_phi0 == 0.0 && self.angular_scale_kappa == 1.0 {
            return Ok(self.profile);
        }
        match self.profile {
            WarpedProfile::Softening {alpha} => Ok(WarpedProfile::ThroatSoftening {
                alpha, phi0:self.throat_phi0, kappa:self.angular_scale_kappa}),
            _ => Err(invalid("throat controls require base Softening profile")),
        }
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WarpedSeedMode {
    #[default]
    LegacySample,
    InnerOnly,
    DirectionLandmarks,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct WarpedNavigationOptions {
    pub asymmetric: bool,
    pub compact_seeds: bool,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct WarpedRerankOptions {
    pub reuse_transform: bool,
    pub envelope_bound: bool,
}

/// Experimental size policy; never silently overrides caller search controls.
pub fn warped_size_budget(nodes: usize) -> (usize, usize) {
    if nodes <= 4096 { (1024,256) }
    else if nodes <= 16384 { (1536,384) }
    else { (2048,512) }
}

#[derive(Default, Debug)]
pub struct WarpedSearchTrace {
    pub seed_evaluations: usize,
    pub navigation_evaluations: usize,
    pub first_visit_rejection_expansion: Option<usize>,
    pub rejected_discoveries: usize,
    pub expansions_after_visit_limit: usize,
    pub workspace_bytes: usize,
    pub stage05_evaluations: usize,
    pub seed_ms: f64,
    pub beam_ms: f64,
    pub stage05_ms: f64,
    pub directory_candidates: usize,
    pub nms_comparisons: usize,
    pub nms_rejections: usize,
    pub nms_fills: usize,
    pub direction_seeds: Vec<u64>,
    pub direction_pairs: Vec<(u64,u64,f64)>,
    pub seeds: Vec<u64>,
    pub visited: Vec<u64>,
    pub retained: Vec<u64>,
    pub stage05_top64: Vec<u64>,
}

fn select_direction_seeds<P>(entries:&[u32],scored:&[(f64,u32)],cap:usize,
    inner:usize,threshold:Option<f64>,mut pair:P)
    -> (Vec<u32>,Vec<u32>,usize,usize,usize)
where P:FnMut(u32,u32)->f64 {
    let mut seeds:Vec<_>=entries.iter().copied().take(cap.min(inner)).collect();
    let mut directions=Vec::new();
    let (mut comparisons,mut rejections,mut fills)=(0,0,0);
    for &(_,node) in scored {
        if seeds.len()>=cap {break;}
        if seeds.contains(&node) {continue;}
        let accept=threshold.is_none_or(|limit|directions.iter().all(|&other| {
            comparisons+=1;
            pair(node,other)<limit
        }));
        if accept {seeds.push(node);directions.push(node);}
        else {rejections+=1;}
    }
    for &(_,node) in scored {
        if seeds.len()>=cap {break;}
        if !seeds.contains(&node) {
            seeds.push(node);directions.push(node);fills+=1;
        }
    }
    (seeds,directions,comparisons,rejections,fills)
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
    offsets: Vec<u32>,
    entries: Vec<u32>,
    config: WarpedFieldConfig,
    direction_landmarks: Vec<u32>,
    shell_landmarks: Vec<u32>,
    /// Bitmap of superseded nodes. They stay graph bridges and never enter results.
    retired: Vec<u64>,
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
    /// Identical operation order and f32 rounding to transform(), but buffers
    /// are allocated once per query, not per cold candidate.
    fn transform_into(raw: &[f32], axis: &[f64], beta: f64,
        scratch: &mut [f64], output: &mut [f32]) -> io::Result<()> {
        if raw.len()!=axis.len() || scratch.len()!=raw.len() || output.len()!=raw.len() {
            return Err(invalid("warped scratch dimension"));
        }
        let norm=checked_norm(raw)?;
        let alignment=raw.iter().zip(axis).map(|(&x,&m)|x as f64/norm*m).sum::<f64>();
        for ((s,&x),&m) in scratch.iter_mut().zip(raw).zip(axis) {
            *s=x as f64/norm-beta*alignment*m;
        }
        let length=scratch.iter().map(|x|x*x).sum::<f64>().sqrt();
        if !length.is_finite() || length<=1e-12 {
            return Err(invalid("mean subtraction annihilates direction"));
        }
        for (s,o) in scratch.iter_mut().zip(output) {
            *s/=length; *o=*s as f32;
        }
        Ok(())
    }
    fn prepared_cosine(&self, unit:&[f32], query_norm:f64, row:&[f32],
        scratch:&mut [f64], candidate:&mut [f32]) -> io::Result<f64> {
        Self::transform_into(row,&self.mean_axis,self.config.mean_subtract_beta,scratch,candidate)?;
        let vn=checked_norm(candidate)?;
        Ok(unit.iter().zip(candidate.iter())
            .map(|(&a,&b)|a as f64*b as f64).sum::<f64>()/query_norm/vn)
    }
    /// Mean is supplied from a frozen AGS generation or an explicitly separate
    /// streaming mean pass. Each indexed original is read exactly once here.
    pub fn build<F>(
        dim: usize, ids: &[u64], slots: &[usize], radii: &[f32], mean: &[f64],
        config: WarpedFieldConfig, fill: F,
    ) -> io::Result<Self>
    where F: FnMut(usize, &mut Vec<f32>) -> bool {
        Self::build_with_table(dim, ids, slots, radii, mean, config, fill,
            |profile, max_radius| WarpedProxyTable::try_build(profile, max_radius, 64, 65))
    }

    fn build_with_table<F, T>(
        dim: usize, ids: &[u64], slots: &[usize], radii: &[f32], mean: &[f64],
        config: WarpedFieldConfig, mut fill: F, build_table: T,
    ) -> io::Result<Self>
    where F: FnMut(usize, &mut Vec<f32>) -> bool,
          T: FnOnce(WarpedProfile, f64) -> io::Result<WarpedProxyTable> {
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
            let (mut header,sig) = PolarNodeMeta::encode(&unit)?;
            // Tier-3 radius is directly geodesic; no Poincare denominator.
            header.depth = radius;
            store.push_sig(&sig);
            meta.push(header);
        }
        let table = build_table(config.geometry_profile()?, config.radius_max)?;
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
        let span = (config.radius_max - 0.35).max(0.10);
        let (iso_tol,elev_min,elev_step) = if config.adaptive_compass {
            (0.35*span,0.12*span,0.42*span)
        } else { (0.60,0.18,0.65) };
        let compass = QuadriPruneSpec {
            depths: &depths, radial_dist_fn: &radial, angular_loss_fn: &angular,
            iso_tol,elev_min,elev_step, geo_fraction:0.375,
            ang_guard_delta:0.45, elev_ang_delta:0.50,
            iso_score_uses_geodesic:false, bridge_cap:0,
        };
        let built = VarGraph::build_with_quadri(ids.len(),config.degree,
            config.construction_width,config.alpha,entries.clone(),distance,Some(&compass))?;
        let mut offsets = Vec::with_capacity(ids.len()+1);
        let mut graph = Vec::new();
        offsets.push(0);
        for neighbors in built.neighbors {
            graph.extend(neighbors);
            offsets.push(u32::try_from(graph.len())
                .map_err(|_|invalid("warped graph exceeds u32 offset capacity"))?);
        }
        graph.shrink_to_fit();
        offsets.shrink_to_fit();
        meta.shrink_to_fit();
        // Farthest-direction selection over a bounded all-shell candidate sample.
        // No cold reads and no original landmark vectors retained.
        let count=ids.len().min(512);
        let candidates:Vec<u32>=(0..count).map(|i|(i*ids.len()/count) as u32).collect();
        let mut direction_landmarks=Vec::new();
        let mut max_cos=vec![-1.0_f64;count];
        if let Some(&first)=candidates.first() { direction_landmarks.push(first); }
        while direction_landmarks.len()<64.min(count) {
            let last=*direction_landmarks.last().unwrap() as usize;
            for (i,&node) in candidates.iter().enumerate() {
                max_cos[i]=max_cos[i].max(pair_cosine(&store,&meta,last,node as usize,dim));
            }
            let next=(0..count).filter(|&i|!direction_landmarks.contains(&candidates[i]))
                .min_by(|&a,&b|max_cos[a].total_cmp(&max_cos[b]).then(a.cmp(&b)));
            let Some(next)=next else {break;};
            direction_landmarks.push(candidates[next]);
        }
        store.shrink_to_fit();
        direction_landmarks.shrink_to_fit();
        // Empty means identity mapping; sparse external slots retain their exact values.
        let slots=if slots.iter().enumerate().all(|(i,&slot)|i==slot) {
            Vec::new()
        } else { slots.to_vec() };
        Ok(Self {dim,ids:ids.to_vec(),slots,meta,store,mean_axis,table,
            graph,offsets,entries,config,direction_landmarks,shell_landmarks:Vec::new(),
            retired:Vec::new()})
    }
    /// Converts further originals into this generation's frozen coordinates: the mean-axis
    /// transform and hot code of build(), with the radius the owner derives from the same
    /// original. Converted nodes form a flat tail that every search scores with the
    /// stage-0.5 proxy and reranks exactly inside the usual cold budget. The graph, entries,
    /// directories and proxy table are untouched, and a live node that carries a converted
    /// id is retired. All-or-nothing: a failed batch leaves the index unchanged.
    pub fn convert_batch<F>(&mut self, ids:&[u64], slots:&[usize], mut fill:F) -> io::Result<()>
    where F:FnMut(usize,&mut Vec<f32>)->Option<f32> {
        let chunks=self.store.chunks();
        if ids.len()!=slots.len()
            || ids.iter().collect::<std::collections::HashSet<_>>().len()!=ids.len() {
            return Err(invalid("invalid warped conversion contract"));
        }
        let mut meta=Vec::with_capacity(ids.len());
        let mut planes=[Vec::with_capacity(ids.len()*chunks),Vec::with_capacity(ids.len()*chunks)];
        let mut row=Vec::with_capacity(self.dim);
        for &slot in slots {
            row.clear();
            let Some(radius)=fill(slot,&mut row) else {
                return Err(invalid("warped conversion cold read failed"));
            };
            let unit=Self::transform(&row,&self.mean_axis,self.config.mean_subtract_beta)?;
            let (mut header,signature)=PolarNodeMeta::encode(&unit)?;
            header.depth=radius;
            meta.push(header);
            planes[0].extend_from_slice(&signature.pos[..chunks]);
            planes[1].extend_from_slice(&signature.strong[..chunks]);
        }
        self.push_converted(ids,slots,&meta,[&planes[0],&planes[1]])
    }
    /// Appends encoded nodes, all or nothing. The last node that carries an identity
    /// represents it and every earlier one retires, so replaying a whole tail gives the
    /// same retired set as the conversions that produced it.
    fn push_converted(&mut self, ids:&[u64], slots:&[usize], meta:&[PolarNodeMeta],
        planes:[&[u64];2]) -> io::Result<()> {
        let (first,total,chunks)=(self.ids.len(),self.ids.len()+ids.len(),self.store.chunks());
        // Slots that continue the identity layout need no table and no uniqueness scan.
        let identity=self.slots.is_empty() && slots.iter().enumerate().all(|(i,&slot)|slot==first+i);
        let mut all_slots=Vec::new();
        if !identity {
            all_slots.reserve_exact(total);
            if self.slots.is_empty() {all_slots.extend(0..first);} else {all_slots.extend_from_slice(&self.slots);}
            all_slots.extend_from_slice(slots);
        }
        if ids.len()!=slots.len() || ids.len()!=meta.len() || total>u32::MAX as usize
            || planes.iter().any(|plane|plane.len()!=ids.len()*chunks) || ids.contains(&0)
            || (!identity && all_slots.iter().collect::<std::collections::HashSet<_>>().len()!=total)
            || meta.iter().any(|m|!m.depth.is_finite() || m.depth<0.0
                || m.depth as f64>self.config.radius_max)
        { return Err(invalid("invalid warped conversion contract")); }
        let latest:std::collections::HashMap<u64,usize>=
            ids.iter().enumerate().map(|(i,&id)|(id,first+i)).collect();
        for node in 0..total {
            let id=if node<first {self.ids[node]} else {ids[node-first]};
            if latest.get(&id).is_some_and(|&last|last!=node) && !self.is_retired(node) {
                if self.retired.len()<total.div_ceil(64) { self.retired.resize(total.div_ceil(64),0); }
                self.retired[node>>6]|=1<<(node&63);
            }
        }
        // In-place growth at exact capacity: a small batch neither copies the trained
        // payload into a second buffer nor leaves it with slack.
        self.store.extend_exact(planes[0],planes[1]);
        self.meta.reserve_exact(ids.len());
        self.meta.extend_from_slice(meta);
        self.ids.reserve_exact(ids.len());
        self.ids.extend_from_slice(ids);
        if !identity { self.slots=all_slots; }
        Ok(())
    }
    /// True when every node is cold-read at the slot equal to its node number.
    pub fn identity_slots(&self) -> bool { self.slots.is_empty() }
    fn is_retired(&self, node: usize) -> bool {
        self.retired.get(node>>6).is_some_and(|word|word>>(node&63)&1==1)
    }
    pub fn retired_count(&self) -> usize {
        self.retired.iter().map(|word|word.count_ones() as usize).sum()
    }
    /// Nodes `[0, trained_len())` are the trained graph that the CSR offsets describe.
    /// `ids()[trained_len()..]` is the converted tail: the same frozen coordinates and
    /// hot codes, scored flat, never linked.
    pub fn trained_len(&self) -> usize { self.offsets.len()-1 }
    pub fn exact_distance(&self, query: &[f32], radius: f32, row: &[f32], node: usize) -> io::Result<f64> {
        if node >= self.ids.len() || !radius.is_finite() || radius < 0.0 || radius as f64 > self.config.radius_max {
            return Err(invalid("invalid warped exact endpoint"));
        }
        self.exact_distance_at_radius(query, radius, row, self.meta[node].depth)
    }
    /// Score a live delta endpoint in this generation's frozen coordinate system.
    /// Does not insert a node, change the mean axis or rebuild navigation.
    pub fn exact_distance_at_radius(&self, query: &[f32], radius: f32,
        row: &[f32], row_radius: f32) -> io::Result<f64> {
        if [radius, row_radius].iter().any(|&r|
            !r.is_finite() || r < 0.0 || r as f64 > self.config.radius_max) {
            return Err(invalid("invalid warped exact endpoint radius"));
        }
        let q = Self::transform(query,&self.mean_axis,self.config.mean_subtract_beta)?;
        let v = Self::transform(row,&self.mean_axis,self.config.mean_subtract_beta)?;
        let (qn,vn) = (checked_norm(&q)?,checked_norm(&v)?);
        let cosine = q.iter().zip(&v).map(|(&a,&b)| a as f64*b as f64).sum::<f64>()/qn/vn;
        Ok(clairaut_distance(self.config.geometry_profile()?,radius as f64,row_radius as f64,
            self.config.effective_cosine(cosine)))
    }
    /// Optional experiment directory. Does not rebuild or mutate graph edges.
    /// Eight equal-count radial bands; farthest-direction hot-code selection per band.
    pub fn build_shell_landmarks(&mut self) {
        let mut order:Vec<u32>=(0..self.trained_len() as u32).collect();
        order.sort_unstable_by(|&a,&b|self.meta[a as usize].depth
            .total_cmp(&self.meta[b as usize].depth).then(a.cmp(&b)));
        let mut landmarks=Vec::new();
        for band in 0..8 {
            let lo=band*order.len()/8;
            let hi=(band+1)*order.len()/8;
            let count=(hi-lo).min(512);
            if count==0 {continue;}
            let candidates:Vec<_>=(0..count).map(|i|order[lo+i*(hi-lo)/count]).collect();
            let mut selected=vec![false;count];
            let mut max_cos=vec![-1.0_f64;count];
            let mut next=0;
            for _ in 0..64.min(count) {
                selected[next]=true;
                let last=candidates[next];
                landmarks.push(last);
                for (i,&node) in candidates.iter().enumerate() {
                    max_cos[i]=max_cos[i].max(pair_cosine(&self.store,&self.meta,
                        last as usize,node as usize,self.dim));
                }
                let Some(pick)=(0..count).filter(|&i|!selected[i])
                    .min_by(|&a,&b|max_cos[a].total_cmp(&max_cos[b]).then(a.cmp(&b))) else {break;};
                next=pick;
            }
        }
        landmarks.shrink_to_fit();
        self.shell_landmarks=landmarks;
    }
    pub fn shell_landmark_count(&self)->usize {self.shell_landmarks.len()}
    pub fn ids(&self) -> &[u64] { &self.ids }
    pub fn configuration(&self) -> WarpedFieldConfig { self.config }

    fn cold_slot(&self, node: usize) -> usize {
        if self.slots.is_empty() { node } else { self.slots[node] }
    }

    pub fn hot_bytes(&self) -> usize {
        self.store.allocated_hot_bytes()+self.meta.capacity()*std::mem::size_of::<PolarNodeMeta>()
            +self.mean_axis.capacity()*8+self.table.hot_bytes()+self.ids.capacity()*8
            +self.slots.capacity()*std::mem::size_of::<usize>()+self.graph.capacity()*4
            +self.offsets.capacity()*std::mem::size_of::<u32>()+self.entries.capacity()*4
            +self.direction_landmarks.capacity()*4+self.shell_landmarks.capacity()*4
            +self.retired.capacity()*8
    }
    pub fn connectivity(&self) -> (usize,usize) {
        let n = self.trained_len();
        if n == 0 { return (0,0); }
        let mut seen = vec![false;n];
        let mut incoming = vec![0usize;n];
        for &v in &self.graph { incoming[v as usize]+=1; }
        let mut queue = std::collections::VecDeque::from([self.entries[0]]);
        seen[self.entries[0] as usize]=true;
        while let Some(u)=queue.pop_front() {
            for &v in &self.graph[self.offsets[u as usize] as usize..self.offsets[u as usize+1] as usize] {
                if !seen[v as usize] {seen[v as usize]=true;queue.push_back(v);}
            }
        }
        (seen.iter().filter(|&&x|x).count(),incoming.iter().filter(|&&x|x==0).count())
    }
    pub fn search<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_diagnosed(query,radius,config,WarpedSeedMode::LegacySample,None,exclude,fill)
    }
    pub fn search_diagnosed<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, trace:Option<&mut WarpedSearchTrace>,
        exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_with_navigation(query,radius,config,seed_mode,
            WarpedNavigationOptions::default(),trace,exclude,fill)
    }
    pub fn search_with_navigation<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, navigation:WarpedNavigationOptions,
        trace:Option<&mut WarpedSearchTrace>, exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_with_rerank(query,radius,config,seed_mode,navigation,
            WarpedRerankOptions::default(),trace,exclude,fill)
    }
    pub fn search_with_rerank<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, navigation:WarpedNavigationOptions, rerank:WarpedRerankOptions,
        trace:Option<&mut WarpedSearchTrace>, exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_experiment(query,radius,config,seed_mode,navigation,rerank,
            false,false,trace,exclude,fill)
    }
    /// Opt-in Phase 5C controls. Existing APIs retain the reference path.
    pub fn search_experiment<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, navigation:WarpedNavigationOptions, rerank:WarpedRerankOptions,
        shell_directory:bool,reuse_beam:bool,
        trace:Option<&mut WarpedSearchTrace>, exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_seed_policy(query,radius,config,seed_mode,navigation,rerank,
            shell_directory,reuse_beam,0,trace,exclude,fill)
    }
    /// Phase5D: 0=legacy; 1=union with 4 inner/16 total; 2=union plus cosine NMS .60.
    pub fn search_seed_policy<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, navigation:WarpedNavigationOptions, rerank:WarpedRerankOptions,
        shell_directory:bool,reuse_beam:bool,seed_policy:u8,
        trace:Option<&mut WarpedSearchTrace>, exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_budgeted(query,radius,config,seed_mode,navigation,rerank,
            shell_directory,reuse_beam,seed_policy,64,trace,exclude,fill)
    }

    /// Chunk-only bounded candidate export. Does not relax the Tag API's 64-row contract.
    pub fn search_chunks<F,E>(&self, query:&[f32], radius:f32,
        config:HyperbolicSearchConfig, trace:Option<&mut WarpedSearchTrace>,
        exclude:E, fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        self.search_budgeted(query,radius,config,WarpedSeedMode::DirectionLandmarks,
            WarpedNavigationOptions {asymmetric:true,compact_seeds:true},
            WarpedRerankOptions {reuse_transform:true,envelope_bound:true},
            true,true,1,2000,trace,exclude,fill)
    }

    fn search_budgeted<F,E>(&self, query:&[f32], radius:f32, config:HyperbolicSearchConfig,
        seed_mode:WarpedSeedMode, navigation:WarpedNavigationOptions, rerank:WarpedRerankOptions,
        shell_directory:bool,reuse_beam:bool,seed_policy:u8,cold_cap:usize,
        mut trace:Option<&mut WarpedSearchTrace>, exclude:E, mut fill:F) -> io::Result<HyperbolicOutput>
    where F:FnMut(usize,&mut Vec<f32>)->bool,E:Fn(u64)->bool {
        if seed_policy>2 || (seed_policy!=0 &&
            (!shell_directory || !navigation.compact_seeds || seed_mode!=WarpedSeedMode::DirectionLandmarks)) {
            return Err(invalid("invalid angular seed policy"));
        }
        if shell_directory && self.shell_landmarks.is_empty() {
            return Err(invalid("shell landmark directory is not built"));
        }
        if rerank.envelope_bound && !rerank.reuse_transform {
            return Err(invalid("envelope requires prepared exact cosine"));
        }
        if let Some(t)=trace.as_deref_mut() {*t=WarpedSearchTrace::default();}
        if config.width==0 || config.rerank_limit>cold_cap || config.rerank_limit<config.top_k {
            return Err(invalid("warped query requires top_k <= cold budget <= endpoint cap"));
        }
        let slice=self.table.checked_slice(radius as f64)?;
        let unit=Self::transform(query,&self.mean_axis,self.config.mean_subtract_beta)?;
        let (qmeta,sig)=PolarNodeMeta::encode(&unit)?;
        if config.top_k==0 || self.ids.is_empty() {
            return Ok(HyperbolicOutput {neighbors:Vec::new(),stats:Default::default()});
        }
        let asym=AsymQuerySm::encode(&unit)?;
        let evaluations=std::cell::Cell::new(0usize);
        let evaluate=|node:u32| {
            evaluations.set(evaluations.get()+1);
            let cosine=if navigation.asymmetric {
                let (p,h)=planes(&self.store,node as usize);
                asym.calibrated_cosine(p,h,self.meta[node as usize].sm(),AsymKernel::Auto)
            } else {
                query_cosine(&self.store,&self.meta,node as usize,&sig,qmeta.sm(),self.dim)
            };
            let c=self.config.effective_cosine(cosine);
            let r=self.meta[node as usize].depth;
            (slice.eval(r,c),1.0-c+0.20*(radius as f64-r as f64).abs())
        };
        let seed_started=std::time::Instant::now();
        let seed_cap=(config.width/2).min(config.max_visits/4);
        let mut seeds=self.entries.clone();
        // Bounded deterministic all-shell coverage, scored under the SAME table.
        match seed_mode {
            WarpedSeedMode::LegacySample => for i in 0..64.min(self.trained_len()) {
                seeds.push((i*self.trained_len()/64.min(self.trained_len())) as u32);
            },
            WarpedSeedMode::InnerOnly => {},
            WarpedSeedMode::DirectionLandmarks => seeds.extend_from_slice(
                if shell_directory {&self.shell_landmarks} else {&self.direction_landmarks}),
        }
        if seed_policy!=0 {seeds.extend_from_slice(&self.direction_landmarks);}
        seeds.sort_unstable();seeds.dedup();
        // Score each directory candidate once, not once per sort comparison.
        let mut scored:Vec<_>=seeds.iter().map(|&n|(evaluate(n).0,n)).collect();
        scored.sort_unstable_by(|a,b|a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let directory_candidates=scored.iter().filter(|(_,n)|!self.entries.contains(n)).count();
        let (directions,nms_comparisons,nms_rejections,nms_fills);
        if navigation.compact_seeds {
            let selected=select_direction_seeds(&self.entries,&scored,seed_cap.min(16),
                if seed_policy==0 {8} else {4},
                (seed_policy==2).then_some(0.60),
                |a,b|pair_cosine(&self.store,&self.meta,a as usize,b as usize,self.dim));
            seeds=selected.0;
            (directions,nms_comparisons,nms_rejections,nms_fills)=
                (selected.1,selected.2,selected.3,selected.4);
        } else {
            seeds=scored.into_iter().take(seed_cap).map(|p|p.1).collect();
            (directions,nms_comparisons,nms_rejections,nms_fills)=(Vec::new(),0,0,0);
        }
        if let Some(t)=trace.as_deref_mut() {
            t.directory_candidates=directory_candidates;
            t.nms_comparisons=nms_comparisons;t.nms_rejections=nms_rejections;t.nms_fills=nms_fills;
            t.direction_seeds=directions.iter().map(|&n|self.ids[n as usize]).collect();
            for (i,&a) in directions.iter().enumerate() {
                for &b in &directions[i+1..] {
                    t.direction_pairs.push((self.ids[a as usize],self.ids[b as usize],
                        pair_cosine(&self.store,&self.meta,a as usize,b as usize,self.dim)));
                }
            }
        }
        let seed_evaluations=evaluations.get();
        let seed_ms=seed_started.elapsed().as_secs_f64()*1000.0;
        let beam_started=std::time::Instant::now();
        let budget=BeamBudget {
            width:config.width,max_visits:config.max_visits,max_expansions:config.max_expansions};
        let neighbors=|n:u32| &self.graph[self.offsets[n as usize] as usize..self.offsets[n as usize+1] as usize];
        let admits=|n:u32|!self.is_retired(n as usize) && !exclude(self.ids[n as usize]);
        let beam=if reuse_beam {
            reusable_beam(self.trained_len(),&seeds,budget,neighbors,evaluate,admits,trace.is_some())
        } else {
            bounded_beam(self.trained_len(),&seeds,budget,neighbors,evaluate,admits)
        };
        let beam_ms=beam_started.elapsed().as_secs_f64()*1000.0;
        if let Some(t)=trace.as_deref_mut() {
            t.seed_evaluations=seed_evaluations;
            t.navigation_evaluations=evaluations.get()-seed_evaluations;
            t.workspace_bytes=beam.workspace_bytes;
            t.seed_ms=seed_ms;t.beam_ms=beam_ms;
            t.first_visit_rejection_expansion=beam.stats.first_visit_rejection_expansion;
            t.rejected_discoveries=beam.stats.rejected_discoveries;
            t.expansions_after_visit_limit=beam.stats.expansions_after_visit_limit;
            t.seeds=seeds.iter().map(|&n|self.ids[n as usize]).collect();
            t.visited=beam.visited_nodes.iter().map(|&n|self.ids[n as usize]).collect();
            t.retained=beam.candidates.iter().map(|&n|self.ids[n as usize]).collect();
        }
        let stage05_started=std::time::Instant::now();
        let reuse_scores=reuse_beam && navigation.asymmetric;
        let mut pool:Vec<_>=beam.candidates.iter().enumerate().map(|(i,&node)| {
            let distance=if reuse_scores {beam.candidate_scores[i]} else {
                let (p,h)=planes(&self.store,node as usize);
                let c=asym.calibrated_cosine(p,h,self.meta[node as usize].sm(),AsymKernel::Auto);
                slice.eval(self.meta[node as usize].depth,self.config.effective_cosine(c))
            };
            (distance,node)
        }).collect();
        // Converted tail: no navigation, the same proxy and cold budget as graph candidates.
        let graph_candidates=pool.len();
        for node in self.trained_len() as u32..self.ids.len() as u32 {
            if !admits(node) {continue;}
            let (p,h)=planes(&self.store,node as usize);
            let c=asym.calibrated_cosine(p,h,self.meta[node as usize].sm(),AsymKernel::Auto);
            pool.push((slice.eval(self.meta[node as usize].depth,self.config.effective_cosine(c)),node));
        }
        let converted_scored=pool.len()-graph_candidates;
        pool.sort_unstable_by(|a,b|a.0.total_cmp(&b.0).then(self.ids[a.1 as usize].cmp(&self.ids[b.1 as usize])));
        if let Some(t)=trace {
            t.stage05_top64=pool.iter().take(config.rerank_limit).map(|p|self.ids[p.1 as usize]).collect();
            t.stage05_evaluations=converted_scored+if reuse_scores {0} else {graph_candidates};
            t.stage05_ms=stage05_started.elapsed().as_secs_f64()*1000.0;
        }
        let mut stats=HyperbolicSearchStats {
            visited:beam.stats.visited,expanded:beam.stats.expanded,excluded_expanded:beam.stats.excluded_expanded,
            visit_limit_reached:beam.stats.visit_limit_reached,expansion_limit_reached:beam.stats.expansion_limit_reached,
            converged:beam.stats.converged,seeds:seeds.len(),valid_candidates:pool.len(),
            asymmetric_evals:converted_scored+if reuse_scores {0} else {graph_candidates},
            converted_scored,..Default::default()
        };
        let profile=self.config.geometry_profile()?;
        let query_norm=if rerank.reuse_transform {checked_norm(&unit)?} else {1.0};
        let mut scratch=if rerank.reuse_transform {vec![0.0_f64;self.dim]} else {Vec::new()};
        let mut candidate=if rerank.reuse_transform {vec![0.0_f32;self.dim]} else {Vec::new()};
        let mut row=Vec::with_capacity(self.dim);
        let mut exact:Vec<(u64,f64)>=Vec::with_capacity(config.top_k+1);
        for (_,node) in pool.into_iter().take(config.rerank_limit) {
            if config.radial_bound && exact.len()>=config.top_k
                && (radius as f64-self.meta[node as usize].depth as f64).abs()-1e-10>exact.last().unwrap().1 {
                stats.radial_rejections+=1;continue;
            }
            row.clear();stats.cold_reads+=1;
            if !fill(self.cold_slot(node as usize),&mut row) {continue;}
            let d=if rerank.reuse_transform {
                let cosine=self.prepared_cosine(&unit,query_norm,&row,&mut scratch,&mut candidate)?;
                let c=self.config.effective_cosine(cosine);
                if rerank.envelope_bound && exact.len()>=config.top_k {
                    let bound=super::warped_geometry::clairaut_lower_bound(
                        profile,radius as f64,self.meta[node as usize].depth as f64,c);
                    if bound>exact.last().unwrap().1 {
                        stats.exact_quad_skips+=1;
                        continue;
                    }
                }
                stats.exact_distance_evals+=1;
                clairaut_distance(profile,radius as f64,self.meta[node as usize].depth as f64,c)
            } else {
                stats.exact_distance_evals+=1;
                self.exact_distance(query,radius,&row,node as usize)?
            };
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
    fn prepared_table_preserves_complete_trained_index_and_search() {
        let n = 160;
        let dim = 768;
        let ids: Vec<_> = (100..100+n as u64).collect();
        let slots: Vec<_> = (0..n).collect();
        let radii: Vec<_> = (0..n).map(|i| 0.35 + 0.29 * (i % 31) as f32 / 30.0).collect();
        let mean = vec![0.01; dim];
        let config = WarpedFieldConfig {
            profile: WarpedProfile::Softening { alpha: 0.15 },
            radius_max: 0.65,
            throat_phi0: 1.5,
            angular_scale_kappa: 2.0,
            adaptive_compass: true,
            ..Default::default()
        };
        let fill = |s, out: &mut Vec<f32>| { *out = row(s, dim); true };
        let mut reference = WarpedFieldIndex::build_with_table(
            dim, &ids, &slots, &radii, &mean, config, fill,
            |profile, max_radius| Ok(WarpedProxyTable::build_impl(profile, max_radius, 64, 65, false)),
        ).unwrap();
        let mut optimized = WarpedFieldIndex::build(dim, &ids, &slots, &radii, &mean, config, fill).unwrap();
        reference.build_shell_landmarks();
        optimized.build_shell_landmarks();
        let bytes = optimized.snapshot_bytes();
        assert!(reference.snapshot_bytes() == bytes, "trained payload differs");
        let restored = WarpedFieldIndex::from_snapshot_bytes(&bytes).unwrap();
        let config = HyperbolicSearchConfig {
            top_k: 10, width: 128, rerank_limit: 64, max_visits: 1024,
            max_expansions: 256, radial_bound: true,
        };
        for (query_id, radius) in [(3, 0.35), (73, 0.47), (159, 0.64)] {
            let query = row(query_id, dim);
            let run = |index: &WarpedFieldIndex| index.search_with_rerank(
                &query, radius, config, WarpedSeedMode::DirectionLandmarks,
                WarpedNavigationOptions { asymmetric: true, compact_seeds: true },
                WarpedRerankOptions { reuse_transform: true, envelope_bound: true },
                None, |id| id % 7 == 0, fill,
            ).unwrap().neighbors.into_iter().map(|(id, d)| (id, d.to_bits())).collect::<Vec<_>>();
            let expected = run(&reference);
            assert!(!expected.is_empty());
            assert_eq!(run(&optimized), expected);
            assert_eq!(run(&restored), expected);
        }
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
            let mut trace=WarpedSearchTrace::default();
            let diagnosed=index.search_diagnosed(&q,radii[33],config,WarpedSeedMode::LegacySample,
                Some(&mut trace),|id|id<=10,|s,o|{*o=row((s-10)/3,dim);true}).unwrap();
            assert_eq!(diagnosed.neighbors,out.neighbors);
            assert_eq!(trace.visited.len(),diagnosed.stats.visited);
            assert!(trace.retained.iter().all(|id|trace.visited.contains(id) && *id>10));
            assert!(trace.stage05_top64.iter().all(|id|trace.retained.contains(id)));
            assert!(trace.seeds.iter().all(|id|trace.visited.contains(id)));
            for mode in [WarpedSeedMode::InnerOnly,WarpedSeedMode::DirectionLandmarks] {
                let checked=index.search_diagnosed(&q,radii[33],config,mode,Some(&mut trace),
                    |_|false,|s,o|{*o=row((s-10)/3,dim);true}).unwrap();
                assert!(checked.stats.cold_reads<=64);
                assert!(trace.seeds.len()<=config.max_visits/4);
            }
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

#[cfg(test)]
mod navigation_precision_tests {
    use super::*;
    #[test]
    fn compact_asymmetric_navigation_preserves_budget_and_excluded_bridges() {
        for dim in [65,384,768,1536,3072] {
            let n=48;
            let ids:Vec<_>=(1..=n as u64).collect();
            let slots:Vec<_>=(0..n).collect();
            let radii:Vec<_>=(0..n).map(|i|0.35+0.29*i as f32/(n-1) as f32).collect();
            let row=|i:usize| (0..dim).map(|j|((i*71+j*17+1) as f64*0.37).sin() as f32).collect::<Vec<_>>();
            let index=WarpedFieldIndex::build(dim,&ids,&slots,&radii,&vec![0.01;dim],
                WarpedFieldConfig {radius_max:0.65,throat_phi0:1.5,
                    adaptive_compass:true,degree:12,..Default::default()},
                |s,o|{*o=row(s);true}).unwrap();
            assert_eq!(index.connectivity(),(n,0));
            let options=WarpedNavigationOptions {asymmetric:true,compact_seeds:true};
            for visits in [0,1,3,4,16,48,1024] {
                let cfg=HyperbolicSearchConfig {top_k:10,width:128,rerank_limit:64,
                    max_visits:visits,max_expansions:256,radial_bound:true};
                let mut trace=WarpedSearchTrace::default();
                let mut reads=std::collections::HashSet::new();
                let out=index.search_with_navigation(&row(37),0.5,cfg,
                    WarpedSeedMode::DirectionLandmarks,options,Some(&mut trace),
                    |id|id<=8,|s,o|{
                        assert!(s>=8);
                        assert!(reads.insert(s));*o=row(s);true
                    }).unwrap();
                assert!(trace.seeds.len()<=16.min(visits/4));
                assert!(out.stats.visited<=visits);
                assert_eq!(out.stats.cold_reads,reads.len());
                assert!(reads.len()<=64);
                assert!(out.neighbors.iter().all(|p|p.0>8));
                let empty=index.search_with_navigation(&row(37),0.5,cfg,
                    WarpedSeedMode::DirectionLandmarks,options,None,
                    |_|true,|_,_|panic!("excluded cold read")).unwrap();
                assert!(empty.neighbors.is_empty());
                assert_eq!(empty.stats.cold_reads,0);
            }
        }
    }
}

#[cfg(test)]
mod rerank_envelope_tests {
    use super::*;
    use std::alloc::{GlobalAlloc,Layout,System};
    std::thread_local! {
        static ALLOCS:std::cell::Cell<Option<usize>>=const {std::cell::Cell::new(None)};
    }
    struct CountedAllocator;
    fn count_alloc() {
        let _=ALLOCS.try_with(|c|if let Some(n)=c.get() {c.set(Some(n+1));});
    }
    unsafe impl GlobalAlloc for CountedAllocator {
        unsafe fn alloc(&self,layout:Layout)->*mut u8 {
            count_alloc(); unsafe {System.alloc(layout)}
        }
        unsafe fn alloc_zeroed(&self,layout:Layout)->*mut u8 {
            count_alloc(); unsafe {System.alloc_zeroed(layout)}
        }
        unsafe fn realloc(&self,p:*mut u8,layout:Layout,size:usize)->*mut u8 {
            count_alloc(); unsafe {System.realloc(p,layout,size)}
        }
        unsafe fn dealloc(&self,p:*mut u8,layout:Layout) {
            unsafe {System.dealloc(p,layout)}
        }
    }
    #[global_allocator]
    static TEST_ALLOCATOR:CountedAllocator=CountedAllocator;
    fn row(i:usize,dim:usize)->Vec<f32> {
        (0..dim).map(|j|((i*71+j*17+1) as f64*0.37).sin() as f32).collect()
    }
    #[test]
    fn reused_transform_is_bit_exact_and_adjoint_rounding_is_measured() {
        let mut adjoint_worst=0.0_f64;
        for dim in [65,384,768,1536,3072] {
            let a:Vec<_>=(0..dim).map(|i|((i+1) as f64).sin()).collect();
            let an=a.iter().map(|x|x*x).sum::<f64>().sqrt();
            let axis:Vec<_>=a.iter().map(|x|x/an).collect();
            for beta in [0.0,0.7,1.0] {
                let q=WarpedFieldIndex::transform(&row(3,dim),&axis,beta).unwrap();
                let qn=checked_norm(&q).unwrap();
                let align=q.iter().zip(&axis).map(|(&x,&m)|x as f64/qn*m).sum::<f64>();
                let adjoint:Vec<_>=q.iter().zip(&axis).map(|(&x,&m)|x as f64/qn-beta*align*m).collect();
                let mut scratch=vec![0.0;dim];
                let mut candidate=vec![0.0;dim];
                for i in 0..24 {
                    let raw=row(i,dim);
                    let old=WarpedFieldIndex::transform(&raw,&axis,beta).unwrap();
                    ALLOCS.with(|c|c.set(Some(0)));
                    WarpedFieldIndex::transform_into(&raw,&axis,beta,&mut scratch,&mut candidate).unwrap();
                    let measured_norm=checked_norm(&candidate).unwrap();
                    let measured_cos=q.iter().zip(&candidate)
                        .map(|(&x,&y)|x as f64*y as f64).sum::<f64>()/qn/measured_norm;
                    std::hint::black_box(measured_cos);
                    let allocations=ALLOCS.with(|c|c.replace(None)).unwrap();
                    assert_eq!(allocations,0,"candidate direction computation allocated");
                    assert_eq!(old.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),
                        candidate.iter().map(|x|x.to_bits()).collect::<Vec<_>>());
                    let vn=checked_norm(&old).unwrap();
                    let expected=q.iter().zip(&old).map(|(&x,&y)|x as f64*y as f64).sum::<f64>()/qn/vn;
                    let got=q.iter().zip(&candidate).map(|(&x,&y)|x as f64*y as f64).sum::<f64>()/qn/checked_norm(&candidate).unwrap();
                    assert_eq!(expected.to_bits(),got.to_bits());
                    let norm=checked_norm(&raw).unwrap();
                    let a=raw.iter().zip(&axis).map(|(&x,&m)|x as f64/norm*m).sum::<f64>();
                    let rho=(1.0-beta*(2.0-beta)*a*a).sqrt();
                    let c=raw.iter().zip(&adjoint).map(|(&x,&y)|x as f64*y).sum::<f64>()/norm/rho;
                    adjoint_worst=adjoint_worst.max((expected-c).abs());
                }
            }
        }
        eprintln!("pure adjoint vs legacy rounded cosine max_abs_error={adjoint_worst:e}");
        assert!(adjoint_worst.is_finite());
    }
    #[test]
    fn rerank_envelope_preserves_distance_bits_and_unique_cold_reads() {
        assert_eq!(warped_size_budget(4096),(1024,256));
        assert_eq!(warped_size_budget(8192),(1536,384));
        assert_eq!(warped_size_budget(16384),(1536,384));
        assert_eq!(warped_size_budget(16385),(2048,512));
        assert_eq!(warped_size_budget(40602),(2048,512));
        let mut total_skips=0;
        for dim in [65,384,768,1536,3072] {
            let n=80;
            let ids:Vec<_>=(1..=n as u64).collect();
            let slots:Vec<_>=(0..n).collect();
            let radii:Vec<_>=(0..n).map(|i|0.35+0.29*i as f32/n as f32).collect();
            let index=WarpedFieldIndex::build(dim,&ids,&slots,&radii,&vec![0.01;dim],
                WarpedFieldConfig {radius_max:0.65,throat_phi0:1.5,angular_scale_kappa:2.0,
                    adaptive_compass:true,..Default::default()},|s,o|{*o=row(s,dim);true}).unwrap();
            assert!(index.slots.is_empty());
            assert_eq!(index.ids(),ids.as_slice());
            assert_eq!(index.graph.capacity(),index.graph.len());
            let cfg=HyperbolicSearchConfig {top_k:10,width:128,rerank_limit:64,
                max_visits:1024,max_expansions:256,radial_bound:false};
            let nav=WarpedNavigationOptions {asymmetric:true,compact_seeds:true};
            for excluded in [0,8,80] {
                let query=row(37,dim);
                let mut reference=None;
                let mut reference_reads=None;
                for opts in [WarpedRerankOptions::default(),
                    WarpedRerankOptions {reuse_transform:true,envelope_bound:false},
                    WarpedRerankOptions {reuse_transform:true,envelope_bound:true}] {
                    let mut reads=std::collections::BTreeSet::new();
                    let out=index.search_with_rerank(&query,0.425,cfg,
                        WarpedSeedMode::DirectionLandmarks,nav,opts,None,
                        |id|id<=excluded,|s,o|{
                            assert!(reads.insert(s));*o=row(s,dim);true
                        }).unwrap();
                    let bits:Vec<_>=out.neighbors.iter().map(|&(id,d)|(id,d.to_bits())).collect();
                    if let Some(r)=&reference {assert_eq!(&bits,r);} else {reference=Some(bits);}
                    if let Some(r)=&reference_reads {assert_eq!(&reads,r);} else {reference_reads=Some(reads);}
                    assert_eq!(out.stats.exact_distance_evals+out.stats.exact_quad_skips,out.stats.cold_reads);
                    total_skips+=out.stats.exact_quad_skips;
                }
            }
        }
        assert!(total_skips>0);
    }
}

#[cfg(test)]
mod shell_directory_and_reuse_tests {
    use super::*;
    #[test]
    fn shell_directory_and_reused_scores_preserve_exact_reference_per_directory() {
        for dim in [65,384,768,1536,3072] {
            let n=88;
            let row=|i:usize|(0..dim).map(|j|
                ((i*71+j*17+1) as f64*0.37).sin() as f32).collect::<Vec<_>>();
            let ids:Vec<_>=(1..=n as u64).collect();
            let slots:Vec<_>=(0..n).map(|i|i*3+11).collect();
            let radii:Vec<_>=(0..n).map(|i|0.35+0.29*i as f32/n as f32).collect();
            let mut index=WarpedFieldIndex::build(dim,&ids,&slots,&radii,&vec![0.01;dim],
                WarpedFieldConfig {radius_max:0.65,throat_phi0:1.5,
                    angular_scale_kappa:2.0,adaptive_compass:true,..Default::default()},
                |s,o|{*o=row((s-11)/3);true}).unwrap();
            let bytes=index.hot_bytes();
            let graph=index.graph.clone();
            index.build_shell_landmarks();
            assert_eq!(index.graph,graph);
            assert_eq!(index.shell_landmark_count(),n);
            assert_eq!(index.hot_bytes()-bytes,n*4);
            let initial=index.shell_landmarks.clone();
            index.build_shell_landmarks();
            assert_eq!(index.shell_landmarks,initial);
            let cfg=HyperbolicSearchConfig {top_k:10,width:128,rerank_limit:64,
                max_visits:2048,max_expansions:512,radial_bound:true};
            let rerank=WarpedRerankOptions {reuse_transform:true,envelope_bound:true};
            for asymmetric in [false,true] {
                for shell in [false,true] {
                    for excluded in [0,8,n] {
                        let mut reference=None;
                        for fast in [false,true] {
                            let mut reads=Vec::new();
                            let mut trace=WarpedSearchTrace::default();
                            let out=index.search_experiment(&row(37),0.425,cfg,
                                WarpedSeedMode::DirectionLandmarks,
                                WarpedNavigationOptions {asymmetric,compact_seeds:true},
                                rerank,shell,fast,Some(&mut trace),|id|id<=excluded as u64,
                                |s,o|{reads.push(s);*o=row((s-11)/3);true}).unwrap();
                            let bits:Vec<_>=out.neighbors.iter().map(|&(id,d)|(id,d.to_bits())).collect();
                            let key=(bits,reads,trace.seeds,trace.visited,trace.retained,
                                trace.stage05_top64,out.stats.visited,out.stats.expanded,
                                out.stats.converged,out.stats.exact_quad_skips);
                            if let Some(r)=&reference {assert_eq!(r,&key);} else {reference=Some(key);}
                            assert!(out.stats.cold_reads<=64);
                            if fast && asymmetric {assert_eq!(trace.stage05_evaluations,0);}
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod seed_policy_tests {
    use super::*;
    #[test]
    fn angular_nms_rejects_clumps_then_fills_without_duplicates() {
        let scored=vec![(0.,0),(1.,4),(2.,5),(3.,6),(4.,7),(5.,8)];
        let pair=|a:u32,b:u32|if a/2==b/2 {0.60} else {0.1};
        let (seeds,directions,compared,rejected,fills)=
            select_direction_seeds(&[0,1,2,3],&scored,7,4,Some(0.60),pair);
        assert_eq!(seeds,vec![0,1,2,3,4,6,8]);
        assert_eq!(directions,vec![4,6,8]);
        assert!(compared>0 && rejected==2);
        assert_eq!(fills,0);
        let (seeds,_,_,rejected,fills)=
            select_direction_seeds(&[0,1,2,3],&scored,9,4,Some(0.60),pair);
        assert_eq!(seeds,vec![0,1,2,3,4,6,8,5,7]);
        assert_eq!((rejected,fills),(2,2));
        for cap in 0..=4 {
            let (seeds,directions,_,_,_)=
                select_direction_seeds(&[0,1,2,3],&scored,cap,4,Some(0.60),pair);
            assert_eq!(seeds.len(),cap);
            assert!(directions.is_empty());
        }
        let (old,_,_,_,_)=select_direction_seeds(&[0,1,2,3],&scored,7,4,None,pair);
        assert_eq!(old,vec![0,1,2,3,4,5,6]);
    }
}

#[cfg(test)]
mod seed_budget_tests {
    use super::*;
    #[test]
    fn nms_query_budgets_exclusions_and_reused_distance_bits() {
        for dim in [65,384,768,1536,3072] {
            let n=40;
            let row=|i:usize|(0..dim).map(|j|
                ((i*71+j*17+1) as f64*0.37).sin() as f32).collect::<Vec<_>>();
            let ids:Vec<_>=(1..=n as u64).collect();
            let slots:Vec<_>=(0..n).collect();
            let radii:Vec<_>=(0..n).map(|i|0.35+0.29*i as f32/n as f32).collect();
            let mut index=WarpedFieldIndex::build(dim,&ids,&slots,&radii,&vec![0.01;dim],
                WarpedFieldConfig {radius_max:0.65,throat_phi0:1.5,
                    angular_scale_kappa:2.0,adaptive_compass:true,..Default::default()},
                |s,o|{*o=row(s);true}).unwrap();
            index.build_shell_landmarks();
            for policy in [1,2] {
                for visits in [0,1,3,4,16,40] {
                    for excluded in [0,4,n] {
                        let mut reference=None;
                        for reuse in [false,true] {
                            let cfg=HyperbolicSearchConfig {top_k:10,width:128,rerank_limit:64,
                                max_visits:visits,max_expansions:512,radial_bound:true};
                            let mut trace=WarpedSearchTrace::default();
                            let mut reads=Vec::new();
                            let out=index.search_seed_policy(&row(31),0.425,cfg,
                                WarpedSeedMode::DirectionLandmarks,
                                WarpedNavigationOptions {asymmetric:true,compact_seeds:true},
                                WarpedRerankOptions {reuse_transform:true,envelope_bound:true},
                                true,reuse,policy,Some(&mut trace),|id|id<=excluded as u64,
                                |s,o|{reads.push(s);*o=row(s);true}).unwrap();
                            assert!(out.stats.visited<=visits);
                            assert!(trace.seeds.len()<=16.min(visits/4));
                            assert!(out.stats.cold_reads<=64);
                            assert!(out.neighbors.iter().all(|p|p.0>excluded as u64));
                            let bits:Vec<_>=out.neighbors.iter().map(|p|(p.0,p.1.to_bits())).collect();
                            let key=(bits,reads,trace.seeds,trace.visited,trace.retained);
                            if let Some(r)=&reference {assert_eq!(r,&key);} else {reference=Some(key);}
                            if excluded==n {assert_eq!(out.stats.cold_reads,0);}
                        }
                    }
                }
            }
        }
    }
}
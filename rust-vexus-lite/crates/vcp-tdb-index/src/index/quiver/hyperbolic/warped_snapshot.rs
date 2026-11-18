//! Deterministic little-endian index payload. The owner supplies identity and CRC.
//! The snapshot holds the trained graph only; a converted tail is a separate payload.
use super::*;

fn put(out: &mut Vec<u8>, value: u64) { out.extend_from_slice(&value.to_le_bytes()); }
fn floats(out: &mut Vec<u8>, values: &[f32]) {
    put(out, values.len() as u64);
    for value in values { out.extend_from_slice(&value.to_le_bytes()); }
}
fn ints(out: &mut Vec<u8>, values: impl ExactSizeIterator<Item=u64>) {
    put(out, values.len() as u64);
    for value in values { put(out,value); }
}
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if n > self.0.len() { return Err(invalid("truncated warped snapshot")); }
        let (a,b)=self.0.split_at(n); self.0=b; Ok(a)
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn count(&mut self, width: usize) -> io::Result<usize> {
        let n=usize::try_from(self.u64()?).map_err(|_|invalid("snapshot count overflow"))?;
        if n > self.0.len()/width { return Err(invalid("snapshot length overflow")); }
        Ok(n)
    }
    fn ints(&mut self) -> io::Result<Vec<u64>> {
        let n=self.count(8)?;
        self.take(n*8)?.chunks_exact(8).map(|b|Ok(u64::from_le_bytes(b.try_into().unwrap()))).collect()
    }
    fn u32s(&mut self) -> io::Result<Vec<u32>> {
        let n=self.count(4)?;
        Ok(self.take(n*4)?.chunks_exact(4).map(|b|u32::from_le_bytes(b.try_into().unwrap())).collect())
    }
    fn floats(&mut self) -> io::Result<Vec<f32>> {
        let n=self.count(4)?;
        Ok(self.take(n*4)?.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect())
    }
    fn f64(&mut self) -> io::Result<f64> { Ok(f64::from_bits(self.u64()?)) }
    fn meta(&mut self, config: &WarpedFieldConfig, dim: usize) -> io::Result<PolarNodeMeta> {
        let data=self.take(32)?;
        let f=|i|f32::from_le_bytes(data[i..i+4].try_into().unwrap());
        let m=PolarNodeMeta {radius:f(0),boundary_factor:f(4),depth:f(8),
            sm_weak:f(12),sm_delta:f(16),sm_sigma:f(20),
            packed_strong_cone:u32::from_le_bytes(data[24..28].try_into().unwrap()),
            cone_alpha:f(28)};
        if [m.radius,m.boundary_factor,m.depth,m.sm_weak,m.sm_delta,m.sm_sigma,m.cone_alpha]
            .iter().any(|v|!v.is_finite() || *v<0.)
            || m.depth as f64>config.radius_max || m.sm_sigma<=0.
            || m.sm().strong_ones>dim as u32 {
            return Err(invalid("snapshot polar metadata"));
        }
        Ok(m)
    }
    fn planes(&mut self, dim: usize, meta: &PolarNodeMeta) -> io::Result<Bq2Signature> {
        let chunks=dim.div_ceil(64);
        let mask=if dim%64==0 {u64::MAX} else {(1u64<<(dim%64))-1};
        let mut sig=Bq2Signature::empty();
        for plane in [&mut sig.pos,&mut sig.strong] {
            for word in &mut plane[..chunks] { *word=self.u64()?; }
            if plane[chunks-1]&!mask!=0 { return Err(invalid("snapshot nonzero padding bits")); }
        }
        let count=sig.strong[..chunks].iter().map(|w|w.count_ones()).sum::<u32>();
        if count!=meta.sm().strong_ones { return Err(invalid("snapshot magnitude count")); }
        Ok(sig)
    }
}
fn put_meta(out: &mut Vec<u8>, m: &PolarNodeMeta) {
    for x in [m.radius,m.boundary_factor,m.depth,m.sm_weak,m.sm_delta,m.sm_sigma] {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.extend_from_slice(&m.packed_strong_cone.to_le_bytes());
    out.extend_from_slice(&m.cone_alpha.to_le_bytes());
}
fn put_planes(out: &mut Vec<u8>, store: &Bq2Store, node: usize, chunks: usize) {
    let sig=store.get_sig(node);
    for plane in [&sig.pos,&sig.strong] {
        for &word in &plane[..chunks] { put(out,word); }
    }
}

impl WarpedFieldIndex {
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        let mut out=Vec::with_capacity(self.hot_bytes());
        put(&mut out,1); put(&mut out,self.dim as u64);
        let (kind,a,b,c)=match self.config.profile {
            WarpedProfile::ConstantHyperbolic {curvature}=>(0,curvature,0.,0.),
            WarpedProfile::Softening {alpha}=>(1,alpha,0.,0.),
            WarpedProfile::Steepening {alpha}=>(2,alpha,0.,0.),
            WarpedProfile::ThroatSoftening {alpha,phi0,kappa}=>(3,alpha,phi0,kappa),
        };
        put(&mut out,kind);
        for x in [a,b,c,self.config.radius_max,self.config.mean_subtract_beta,
            self.config.throat_phi0,self.config.angular_scale_kappa,self.config.angular_tau,
            self.config.angular_eta,self.config.alpha] { put(&mut out,x.to_bits()); }
        put(&mut out,self.config.degree as u64);
        put(&mut out,self.config.construction_width as u64);
        put(&mut out,self.config.adaptive_compass as u64);
        let trained=self.trained_len();
        let slots=if self.slots.iter().take(trained).enumerate().all(|(i,&slot)|i==slot) {&[][..]}
            else {&self.slots[..trained]};
        ints(&mut out,self.ids[..trained].iter().copied());
        ints(&mut out,slots.iter().map(|&x|x as u64));
        ints(&mut out,self.mean_axis.iter().map(|x|x.to_bits()));
        floats(&mut out,self.table.snapshot_data());
        put(&mut out,trained as u64);
        for m in &self.meta[..trained] { put_meta(&mut out,m); }
        let chunks=self.dim.div_ceil(64);
        put(&mut out,(trained*chunks*2) as u64);
        for node in 0..trained { put_planes(&mut out,&self.store,node,chunks); }
        for array in [&self.graph,&self.offsets,&self.entries,
            &self.direction_landmarks,&self.shell_landmarks] {
            put(&mut out,array.len() as u64);
            for value in array {out.extend_from_slice(&value.to_le_bytes());}
        }
        out
    }

    pub fn from_snapshot_bytes(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len()>512*1024*1024 { return Err(invalid("warped snapshot size limit")); }
        let mut r=Reader(bytes);
        if r.u64()?!=1 { return Err(invalid("warped index snapshot version")); }
        let dim=usize::try_from(r.u64()?).map_err(|_|invalid("snapshot dimension"))?;
        if dim==0 || dim>crate::index::bq::MAX_BQ_DIM { return Err(invalid("snapshot dimension")); }
        let kind=r.u64()?;
        let (a,b,c)=(r.f64()?,r.f64()?,r.f64()?);
        let profile=match kind {
            0=>WarpedProfile::ConstantHyperbolic {curvature:a},
            1=>WarpedProfile::Softening {alpha:a},
            2=>WarpedProfile::Steepening {alpha:a},
            3=>WarpedProfile::ThroatSoftening {alpha:a,phi0:b,kappa:c},
            _=>return Err(invalid("snapshot profile")),
        };
        let config=WarpedFieldConfig {
            profile,radius_max:r.f64()?,mean_subtract_beta:r.f64()?,
            throat_phi0:r.f64()?,angular_scale_kappa:r.f64()?,
            angular_tau:r.f64()?,angular_eta:r.f64()?,alpha:r.f64()?,
            degree:usize::try_from(r.u64()?).map_err(|_|invalid("snapshot degree"))?,
            construction_width:usize::try_from(r.u64()?).map_err(|_|invalid("snapshot width"))?,
            adaptive_compass:match r.u64()? {0=>false,1=>true,_=>return Err(invalid("snapshot flag"))},
        };
        config.validate()?;
        let ids=r.ints()?;
        let n=ids.len();
        if n<2 || n>u32::MAX as usize || ids.contains(&0)
            || ids.iter().collect::<std::collections::HashSet<_>>().len()!=n {
            return Err(invalid("snapshot node identities"));
        }
        let slots:Vec<usize>=r.ints()?.into_iter().map(|v|usize::try_from(v)
            .map_err(|_|invalid("snapshot slot overflow"))).collect::<io::Result<_>>()?;
        if !slots.is_empty() && (slots.len()!=n
            || slots.iter().collect::<std::collections::HashSet<_>>().len()!=n) {
            return Err(invalid("snapshot slots"));
        }
        let mean_axis:Vec<f64>=r.ints()?.into_iter().map(f64::from_bits).collect();
        let norm=mean_axis.iter().map(|x|x*x).sum::<f64>();
        if mean_axis.len()!=dim || !norm.is_finite() || (norm!=0. && (norm-1.).abs()>1e-10) {
            return Err(invalid("snapshot mean axis"));
        }
        let table=WarpedProxyTable::from_snapshot(config.radius_max,r.floats()?)?;
        if r.count(32)?!=n { return Err(invalid("snapshot metadata length")); }
        let mut meta=Vec::with_capacity(n);
        for _ in 0..n { meta.push(r.meta(&config,dim)?); }
        let chunks=dim.div_ceil(64);
        if r.count(8)?!=n.checked_mul(chunks*2).ok_or_else(||invalid("snapshot plane overflow"))? {
            return Err(invalid("snapshot plane length"));
        }
        let mut store=Bq2Store::new(dim); store.reserve(n);
        for m in &meta { store.push_sig(&r.planes(dim,m)?); }
        let graph=r.u32s()?; let offsets=r.u32s()?; let entries=r.u32s()?;
        let direction_landmarks=r.u32s()?; let shell_landmarks=r.u32s()?;
        if !r.0.is_empty() || offsets.len()!=n+1 || offsets[0]!=0
            || offsets[n] as usize!=graph.len()
            || offsets.windows(2).any(|p|p[0]>p[1] || (p[1]-p[0]) as usize>config.degree)
            || entries.is_empty() || entries.len()>8 || direction_landmarks.len()>64
            || shell_landmarks.len()>512
            || [&graph,&entries,&direction_landmarks,&shell_landmarks].iter()
                .any(|a|a.iter().any(|&v|v as usize>=n)) {
            return Err(invalid("snapshot CSR or directory boundary"));
        }
        let index=Self {dim,ids,slots,meta,store,mean_axis,table,graph,offsets,entries,
            config,direction_landmarks,shell_landmarks,retired:Vec::new()};
        if index.connectivity()!=(n,0) { return Err(invalid("snapshot graph connectivity")); }
        Ok(index)
    }

    /// The converted tail in conversion order: identity, cold slot and hot code per node.
    pub fn converted_bytes(&self) -> Vec<u8> {
        let chunks=self.dim.div_ceil(64);
        let mut out=Vec::with_capacity(8+(self.ids.len()-self.trained_len())*(48+chunks*16));
        put(&mut out,(self.ids.len()-self.trained_len()) as u64);
        for node in self.trained_len()..self.ids.len() {
            put(&mut out,self.ids[node]);
            put(&mut out,self.cold_slot(node) as u64);
            put_meta(&mut out,&self.meta[node]);
            put_planes(&mut out,&self.store,node,chunks);
        }
        out
    }

    /// Replays a converted tail onto the trained snapshot it was taken from, which also
    /// reproduces the retired set. A rejected tail leaves the index unchanged.
    pub fn restore_converted(&mut self, bytes: &[u8]) -> io::Result<()> {
        let chunks=self.dim.div_ceil(64);
        let mut r=Reader(bytes);
        let count=r.count(48+chunks*16)?;
        if self.ids.len()!=self.trained_len() { return Err(invalid("converted tail is already present")); }
        let (mut ids,mut slots,mut meta)=(Vec::with_capacity(count),Vec::with_capacity(count),
            Vec::with_capacity(count));
        let mut planes=[Vec::with_capacity(count*chunks),Vec::with_capacity(count*chunks)];
        for _ in 0..count {
            ids.push(r.u64()?);
            slots.push(usize::try_from(r.u64()?).map_err(|_|invalid("snapshot slot overflow"))?);
            let header=r.meta(&self.config,self.dim)?;
            let signature=r.planes(self.dim,&header)?;
            planes[0].extend_from_slice(&signature.pos[..chunks]);
            planes[1].extend_from_slice(&signature.strong[..chunks]);
            meta.push(header);
        }
        if !r.0.is_empty() { return Err(invalid("trailing converted tail bytes")); }
        self.push_converted(&ids,&slots,&meta,[&planes[0],&planes[1]])
    }

    pub fn dimension(&self) -> usize { self.dim }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(dim:usize)->WarpedFieldIndex {
        WarpedFieldIndex::build(dim,&[1,2,3,4],&[0,1,2,3],&[0.4;4],&vec![0.;dim],
            WarpedFieldConfig::default(),|slot,out| {
                out.extend((0..dim).map(|j|((j*13+slot*7+1) as f32*0.17).sin()));
                true
            }).unwrap()
    }

    #[test]
    fn structural_corruption_is_rejected_without_panicking() {
        let index=fixture(65);
        let bytes=index.snapshot_bytes();
        assert_eq!(bytes,WarpedFieldIndex::from_snapshot_bytes(&bytes).unwrap().snapshot_bytes());
        for length in [0,7,127,bytes.len()-1] {
            assert!(WarpedFieldIndex::from_snapshot_bytes(&bytes[..length]).is_err());
        }
        let mut bad=fixture(65);bad.offsets[1]=u32::MAX;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        let mut bad=fixture(65);bad.graph[0]=4;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        let mut bad=fixture(65);bad.entries[0]=4;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        let mut bad=fixture(65);bad.meta[0].sm_sigma=f32::NAN;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        let mut bad=fixture(65);bad.mean_axis[0]=f64::NAN;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        let mut bad=fixture(65);
        let mut sig=bad.store.get_sig(0);sig.pos[1]|=2;
        let mut store=Bq2Store::new(65);
        store.push_sig(&sig);
        for i in 1..4 {store.push_sig(&bad.store.get_sig(i));}
        bad.store=store;
        assert!(WarpedFieldIndex::from_snapshot_bytes(&bad.snapshot_bytes()).is_err());
        for length in 0..512 {
            let bytes=vec![255;length];
            assert!(WarpedFieldIndex::from_snapshot_bytes(&bytes).is_err());
        }
    }

    #[test]
    fn large_synthetic_snapshot_load_reports_cost_without_quality_experiment() {
        let mut index=fixture(3072);
        let n=48_000usize;
        let meta=index.meta[0];
        let sig=index.store.get_sig(0);
        index.ids=(1..=n as u64).collect();
        index.meta=vec![meta;n];
        let mut store=Bq2Store::new(3072);store.reserve(n);
        for _ in 0..n {store.push_sig(&sig);}
        index.store=store;
        index.graph=(0..n).flat_map(|i|[((i+1)%n) as u32,((i+n-1)%n) as u32]).collect();
        index.offsets=(0..=n).map(|i|(i*2) as u32).collect();
        index.entries=vec![0];index.direction_landmarks=(0..64).collect();
        index.shell_landmarks=(0..512).collect();
        let bytes=index.snapshot_bytes();
        let mut timings=Vec::new();
        for _ in 0..5 {
            let start=std::time::Instant::now();
            let restored=WarpedFieldIndex::from_snapshot_bytes(&bytes).unwrap();
            timings.push(start.elapsed().as_secs_f64()*1000.);
            assert_eq!(restored.ids.len(),n);
        }
        timings.sort_by(f64::total_cmp);
        eprintln!("warped_synthetic_snapshot bytes={} nodes={} dimension=3072 decode_median_ms={:.3}",
            bytes.len(),n,timings[2]);
    }
}
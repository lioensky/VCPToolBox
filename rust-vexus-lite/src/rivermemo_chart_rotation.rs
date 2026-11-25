//! Rotate only the source/target plane in the orthogonal complement of pinned foci.
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a,b)| a*b).sum()
}
fn normalize(v: &mut [f64]) -> bool {
    let n = dot(v,v).sqrt();
    if !n.is_finite() || n < 1e-9 { return false; }
    v.iter_mut().for_each(|x| *x /= n);
    true
}
fn strip(v: &mut [f64], axes: &[Vec<f64>]) {
    for _ in 0..2 {
        for u in axes {
            let a = dot(v,u);
            for (x,y) in v.iter_mut().zip(u) { *x -= a*y; }
        }
    }
}
pub(super) fn rotate(q: &[f32], s: &[f32], t: &[f32], pinned: &[&[f32]], w: f64)
    -> Option<(Vec<f32>,f64)> {
    if !(0.0 < w && w <= 1.0) || q.is_empty() { return None; }
    let convert = |v: &[f32]| -> Option<Vec<f64>> {
        if v.len()!=q.len() { return None; }
        let mut x:Vec<_>=v.iter().map(|&a|f64::from(a)).collect();
        normalize(&mut x).then_some(x)
    };
    let mut axes=Vec::new();
    for v in pinned {
        let mut x=convert(v)?;
        strip(&mut x,&axes);
        if normalize(&mut x) { axes.push(x); }
    }
    let mut x=convert(s)?;
    let mut z=convert(t)?;
    strip(&mut x,&axes); strip(&mut z,&axes);
    if !normalize(&mut x) || !normalize(&mut z) { return None; }
    let d=dot(&x,&z).clamp(-1.0,1.0);
    for (v,u) in z.iter_mut().zip(&x) { *v-=d*u; }
    let sine=dot(&z,&z).sqrt();
    if !normalize(&mut z) { return None; }
    let angle=w*sine.atan2(d);
    let (sn,cs)=angle.sin_cos();
    let mut new=convert(q)?;
    let (a,b)=(dot(&new,&x),dot(&new,&z));
    if a.hypot(b)<1e-12 { return None; }
    for i in 0..new.len() {
        new[i]+=(a*(cs-1.0)-b*sn)*x[i]+(a*sn+b*(cs-1.0))*z[i];
    }
    Some((new.into_iter().map(|v|v as f32).collect(),angle))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotates_in_plane_and_preserves_pin() {
        let q=[0.6,0.0,0.8];
        let (r,angle)=rotate(&q,&[1.,0.,0.],&[0.,1.,0.],&[&[0.,0.,1.]],0.5).unwrap();
        assert!((angle-std::f64::consts::FRAC_PI_4).abs()<1e-12);
        assert!((r[0]-r[1]).abs()<1e-6 && (r[2]-0.8).abs()<1e-6);
        assert!((r.iter().map(|v|v*v).sum::<f32>()-1.).abs()<1e-6);
        assert!(rotate(&q,&q,&q,&[],1.).is_none());
        assert!(rotate(&q,&q,&q,&[],0.).is_none());
    }
}
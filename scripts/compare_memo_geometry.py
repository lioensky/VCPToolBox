"""Compile the actual geometry kernels in isolation; never touch production data."""
from pathlib import Path
import subprocess
import tempfile
import hashlib

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ["scripts/fixtures/memo_geometry_v2.rs", "rust-vexus-lite/src/memo_geometry.rs"]
HARNESS = r'''
use std::time::Instant;
use std::hint::black_box;
fn dot(a:&[f64], b:&[f64])->f64 { a.iter().zip(b).map(|(a,b)|a*b).sum() }
fn unit(v:&mut [f64]) { let n=dot(v,v).sqrt(); for x in v {*x/=n;} }
struct Rng(u64);
impl Rng { fn next(&mut self)->f64 {
    self.0=self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((self.0>>11) as f64)/((1u64<<53) as f64)-0.5
}}
struct Trace { ids:Vec<i64>, gains:Vec<f64>, axes:Vec<Vec<f64>>, residual:Option<f64> }
fn run(new:bool, explain:bool, v:&[Vec<f64>], t:&[f64], p:&[f64], k:usize, min:f64)->Trace {
    let refs:Vec<_>=v.iter().map(Vec::as_slice).collect();
    if new {
        let c:Vec<_>=p.iter().enumerate().map(|(i,p)|t2::AgsCandidate{id:i as i64,prior:*p}).collect();
        let target=if explain {t2::AgsTarget::Explain(t)} else {t2::AgsTarget::Span};
        let x=t2::anchored_gs(target,&c,&refs,k,min);
        Trace{ids:x.picked.iter().map(|x|x.0).collect(),gains:x.picked.iter().map(|x|x.1).collect(),axes:x.basis,residual:x.residual_norm}
    } else {
        let c:Vec<_>=p.iter().enumerate().map(|(i,p)|old::AgsCandidate{id:i as i64,prior:*p}).collect();
        let target=if explain {old::AgsTarget::Explain(t)} else {old::AgsTarget::Span};
        let x=old::anchored_gs(target,&c,&refs,k,min);
        Trace{ids:x.picked.iter().map(|x|x.0).collect(),gains:x.picked.iter().map(|x|x.1).collect(),axes:x.basis,residual:x.residual_norm}
    }
}
fn metrics(x:&Trace,t:&[f64])->(f64,f64,f64) {
    let mut orth:f64=0.0;
    for (i,a) in x.axes.iter().enumerate() { for (j,b) in x.axes.iter().enumerate() {
        orth=orth.max((dot(a,b)-if i==j {1.0}else{0.0}).abs());
    }}
    let mut r=t.to_vec(); let mut captured=0.0;
    for a in &x.axes { let c=dot(t,a); captured+=c*c; for (r,a) in r.iter_mut().zip(a) {*r-=c*a;} }
    let energy=dot(&r,&r);
    let err=x.residual.map_or(0.0,|r|(r-energy.sqrt()).abs());
    (orth,err,(dot(t,t)-captured-energy).abs())
}
fn dataset(r:&mut Rng,n:usize,d:usize,kind:&str)->(Vec<Vec<f64>>,Vec<f64>,Vec<f64>) {
    let shared:Vec<_>=(0..d).map(|_|r.next()).collect();
    let mut v:Vec<Vec<f64>>=(0..n).map(|j| {
        let mut x:Vec<_>=(0..d).map(|i| match kind {
            "low_rank" => if i<8 {r.next()}else{0.0},
            "near_1e-4" | "near_1e-5" | "near_1e-6" | "near_1e-7" =>
                1.0/(d as f64).sqrt()+if i==j%d {
                    match kind {"near_1e-4"=>1e-4,"near_1e-5"=>1e-5,"near_1e-6"=>1e-6,_=>1e-7}
                }else{0.0},
            "correlated" => shared[i]+r.next()*0.2,
            _ => r.next(),
        }).collect(); unit(&mut x); x
    }).collect();
    if kind=="duplicate" {v[1]=v[0].clone();}
    let mut t:Vec<_>=(0..d).map(|_|r.next()).collect(); unit(&mut t);
    if kind=="tiny_residual" {
        t=v[0].clone();
        let mut noise:Vec<_>=(0..d).map(|_|r.next()).collect();
        let c=dot(&noise,&t); for (x,t) in noise.iter_mut().zip(&t) {*x-=c*t;}
        unit(&mut noise); for (t,x) in t.iter_mut().zip(noise) {*t+=3e-7*x;} unit(&mut t);
    }
    let p=(0..n).map(|_|0.1+r.next()+0.5).collect();
    (v,t,p)
}
fn bench(new:bool,explain:bool,v:&[Vec<f64>],t:&[f64],p:&[f64],k:usize,reps:usize)->f64 {
    let refs:Vec<_>=v.iter().map(Vec::as_slice).collect();
    let start=Instant::now();
    if new {
        let c:Vec<_>=p.iter().enumerate().map(|(i,p)|t2::AgsCandidate{id:i as i64,prior:*p}).collect();
        for _ in 0..reps {
            let target=if explain {t2::AgsTarget::Explain(t)} else {t2::AgsTarget::Span};
            black_box(t2::bench(target,&c,&refs,k,if explain {0.015}else{0.02},!explain));
        }
    } else {
        let c:Vec<_>=p.iter().enumerate().map(|(i,p)|old::AgsCandidate{id:i as i64,prior:*p}).collect();
        for _ in 0..reps {
            let target=if explain {old::AgsTarget::Explain(t)} else {old::AgsTarget::Span};
            black_box(old::bench(target,&c,&refs,k,if explain {0.015}else{0.02},!explain));
        }
    }
    start.elapsed().as_secs_f64()*1e6/reps as f64
}
fn main() {
    println!("scenario,mode,cases,ids_equal,max_residual_delta,old_orth,t2_orth,old_residual_error,t2_residual_error,old_energy_defect,t2_energy_defect,old_rank_min,old_rank_max,t2_rank_min,t2_rank_max");
    let mut rng=Rng(0x2545f4914f6cdd1d);
    for kind in ["random","correlated","duplicate","low_rank","tiny_residual","near_1e-4","near_1e-5","near_1e-6","near_1e-7"] {
        for explain in [true,false] {
            let mut equal=0; let mut delta:f64=0.0; let mut worst=[0.0f64;6];
            let mut ranks=[usize::MAX,0,usize::MAX,0];
            for _ in 0..100 {
                let (n,d,k)=if kind.starts_with("near") {(12,256,12)}
                    else if kind=="low_rank" {(48,64,32)}else{(48,64,4)};
                let (v,t,mut p)=dataset(&mut rng,n,d,kind);
                if kind.starts_with("near") {p.fill(1.0);}
                if kind=="tiny_residual" {p[0]=1e6;}
                let a=run(false,explain,&v,&t,&p,k,0.0);
                let b=run(true,explain,&v,&t,&p,k,0.0);
                equal+=usize::from(a.ids==b.ids);
                if explain {delta=delta.max((a.residual.unwrap()-b.residual.unwrap()).abs());}
                let ma=metrics(&a,&t); let mb=metrics(&b,&t);
                for (i,x) in [ma.0,mb.0,ma.1,mb.1,ma.2,mb.2].iter().enumerate() {worst[i]=worst[i].max(*x);}
                ranks[0]=ranks[0].min(a.ids.len());ranks[1]=ranks[1].max(a.ids.len());
                ranks[2]=ranks[2].min(b.ids.len());ranks[3]=ranks[3].max(b.ids.len());
                assert!(mb.0<1e-12 && mb.1<1.01e-7 && mb.2<1e-12,"T2 invariant failure");
                assert!(b.gains.iter().all(|x|x.is_finite()));
            }
            println!("{kind},{},{},{equal},{delta:.6e},{:.6e},{:.6e},{:.6e},{:.6e},{:.6e},{:.6e},{},{},{},{}",
                if explain {"Explain"}else{"Span"},100,worst[0],worst[1],worst[2],worst[3],worst[4],worst[5],ranks[0],ranks[1],ranks[2],ranks[3]);
        }
    }
    for (label,v,t,p,k,min) in [
        ("tie",vec![vec![1.0,0.0],vec![0.0,1.0]],vec![0.6,0.8],vec![1.0,1.0],2,0.0),
        ("zero",vec![vec![0.0,0.0]],vec![0.6,0.8],vec![1.0],4,0.015),
        ("invalid_prior",vec![vec![1.0,0.0],vec![0.0,1.0]],vec![0.6,0.8],vec![f64::NAN,1.0],4,0.015),
        ("gain_stop",vec![vec![1.0,0.0]],vec![0.01,0.9999499987499375],vec![1.0],4,0.015),
        ("zero_limit",vec![vec![1.0,0.0]],vec![0.6,0.8],vec![1.0],0,0.0),
        ("empty",vec![],vec![3.0,4.0],vec![],4,0.0),
    ] {
        for explain in [true,false] {
            let a=run(false,explain,&v,&t,&p,k,min);
            let b=run(true,explain,&v,&t,&p,k,min);
            assert_eq!(a.ids,b.ids,"boundary {label}");
            if let (Some(a),Some(b))=(a.residual,b.residual) {assert!((a-b).abs()<1e-12);}
        }
        println!("boundary {label}: PASS");
    }
    for new in [false,true] {
        let v=vec![vec![2.0,0.0],vec![1e308,1e308],vec![0.0,4.0]];
        let x=run(new,false,&v,&[0.6,0.8],&[1.0,0.0,1.0],3,0.0);
        println!("overflow t2={new} ids={:?} axes_finite={}",x.ids,x.axes.iter().flatten().all(|x|x.is_finite()));
    }
    // Analytic cancellation case: the correct one-axis residual is exactly 3e-7.
    for new in [false,true] {
        let x=run(new,true,&[vec![1.0,0.0]],&[1.0,3e-7],&[1.0],1,0.0);
        println!("analytic t2={new} residual={:.17e} expected=3e-7",x.residual.unwrap());
    }
    println!("benchmark mode,n,dim,k,old_us,t2_us,speedup (median of 7, alternating order)");
    for (explain,n,d,k,reps) in [(true,48,64,4,1000),(true,48,1024,4,200),(true,256,1024,32,10),(false,512,64,32,10),(false,512,1024,32,3),(false,512,3072,32,2)] {
        let (v,t,p)=dataset(&mut rng,n,d,"random");
        let mut times=[Vec::new(),Vec::new()];
        for round in 0..7 {for new in if round%2==0 {[false,true]}else{[true,false]} {
            times[usize::from(new)].push(bench(new,explain,&v,&t,&p,k,reps));
        }}
        for x in &mut times {x.sort_by(f64::total_cmp);}
        println!("benchmark {},{n},{d},{k},{:.3},{:.3},{:.3}",if explain {"Explain"}else{"Span"},times[0][3],times[1][3],times[0][3]/times[1][3]);
    }
}
'''

def main():
    modules = []
    provenance = []
    for name, source in zip(["old", "t2"], SOURCES):
        path = ROOT / source
        provenance.append(f"{source}: sha256={hashlib.sha256(path.read_bytes()).hexdigest()}")
        text = path.read_text(encoding="utf-8-sig")
        kernel = text.split("use crate::storage::", 1)[0]
        kernel = "\n".join(line for line in kernel.splitlines()
                           if not line.lstrip().startswith("//!") and line.strip() != "use rayon::prelude::*;")
        wrapper = """
pub(crate) fn bench(t:AgsTarget<'_>,c:&[AgsCandidate],v:&[&[f64]],k:usize,m:f64,keep:bool)->AgsTrace {
    if keep { anchored_gs(t,c,v,k,m) } else { select_axes(t,c,v,k,m) }
}
"""
        modules.append(f"mod {name} {{\n{kernel}\n{wrapper}\n}}")
    with tempfile.TemporaryDirectory(prefix="memo-geometry-compare-") as temp:
        src = Path(temp) / "compare.rs"
        exe = Path(temp) / "compare.exe"
        src.write_text("\n".join(modules) + HARNESS, encoding="utf-8")
        subprocess.run(["rustc", "--edition=2021", "-O", "-A", "dead_code", str(src), "-o", str(exe)], check=True)
        result = subprocess.run([str(exe)], check=True, capture_output=True, text=True)
        compiler = subprocess.check_output(["rustc", "--version"], text=True).strip()
        report = compiler + "\n" + "\n".join(provenance) + "\n" + result.stdout
        print(report)
        output = ROOT / "scripts" / "memo_geometry_comparison_results.txt"
        output.write_text(report, encoding="utf-8")

if __name__ == "__main__":
    main()
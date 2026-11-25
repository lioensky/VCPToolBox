use super::WarpedFieldIndex;
use std::{fs, io::{BufWriter, Write}, path::Path};

fn export(idx: &WarpedFieldIndex, src: &Path, dst: &Path, rows: usize) {
    let d = 3072;
    let raw = fs::read(src).unwrap();
    assert_eq!(raw.len(), rows*d*4);
    let mut w = BufWriter::new(fs::OpenOptions::new().write(true).create_new(true).open(dst).unwrap());
    let mut scratch = vec![0.; d];
    let mut z = vec![0f32; d];
    for (i, row) in raw.chunks_exact(d*4).enumerate() {
        let x: Vec<_> = row.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        let beta = idx.config.mean_subtract_beta;
        WarpedFieldIndex::transform_into(&x,&idx.mean_axis,beta,&mut scratch,&mut z).unwrap();
        let other = WarpedFieldIndex::transform(&x,&idx.mean_axis,beta).unwrap();
        assert!(z.iter().zip(&other).all(|(a,b)| a.is_finite() && a.to_bits()==b.to_bits()), "row {i}");
        for v in &z { w.write_all(&v.to_le_bytes()).unwrap(); }
    }
    w.flush().unwrap();
}

#[test]
#[ignore = "requires pinned private fixture; run explicitly after SHA-256 verification"]
fn export_frozen_dev_z() {
    let root = std::env::temp_dir().join("lain-p0-qo_bvspm");
    let b = fs::read(root.join("path-b-inputs/knowledge_base.sqlite.chunks-warped-ef69682d1cbfd97b649211756ee1e4a3a79e2c2b5d18669ce220f17cccad8f58.vcpwc")).unwrap();
    assert_eq!(b.len(), 7707626);
    assert_eq!(&b[..8], b"VCPWC001");
    let n = usize::try_from(u64::from_le_bytes(b[8..16].try_into().unwrap())).unwrap();
    let idx = WarpedFieldIndex::from_snapshot_bytes(&b[16+n..b.len()-32]).unwrap();
    assert_eq!((idx.dim,idx.trained_len(),idx.ids.len()),(3072,6849,6849));
    assert_eq!(idx.config.mean_subtract_beta,0.7);
    assert_eq!(idx.retired_count(),0);
    let ids = fs::read(root.join("plate-a/ids.u64le")).unwrap();
    assert_eq!(ids.len(),6849*8);
    assert!(ids.chunks_exact(8).zip(idx.ids()).all(|(b,&id)|u64::from_le_bytes(b.try_into().unwrap())==id));
    let stage=root.join(format!("b1-z-build-{}",std::process::id()));
    let dest=root.join("path-b1-native-z-v1");
    assert!(!dest.exists(),"refusing overwrite");
    fs::create_dir(&stage).unwrap();
    export(&idx,&root.join("plate-a/vectors.f32le"),&stage.join("points.f32le"),6849);
    export(&idx,&root.join("queries-a/dev.f32le"),&stage.join("dev.f32le"),253);
    fs::rename(stage,dest).unwrap();
}
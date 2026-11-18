use super::*;

struct TestRoot(std::path::PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vcp-vec-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
fn identity(dim: usize) -> AssetIdentity {
    AssetIdentity { dimension: dim, scope: 1, model_hash: [7; 32], content_digest: [9; 32] }
}

#[test]
fn flat_asset_preserves_original_bits_and_rejects_wrong_identity() {
    let root = TestRoot::new();
    for dim in [3, 65, 768, 3072] {
        let path = root.0.join(format!("{dim}.vec"));
        let expected = identity(dim);
        let rows: Vec<Vec<f32>> = (0..3).map(|i| {
            let mut row: Vec<f32> = (0..dim).map(|j| (i * dim + j) as f32 * 3.25).collect();
            row[0] = -0.0;
            row[1] = f32::from_bits(1);
            row
        }).collect();
        write_staging(&path, &expected, &[5, 17, 99], &[], &[], |slot, buffer| {
            buffer.extend_from_slice(&rows[slot]);
            true
        }).unwrap();
        let asset = VectorAsset::open(&path, &expected).unwrap();
        assert_eq!(asset.len(), 3);
        assert_eq!(asset.vectors % 64, 0);
        assert_eq!(asset.id_for_slot(1), Some(17));
        assert_eq!(asset.id_for_slot(3), None);
        let mut actual = Vec::new();
        for (slot, original) in rows.iter().enumerate() {
            assert!(asset.fill_slot(slot, &mut actual));
            assert_eq!(actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                original.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        }
        assert!(!asset.fill_slot(3, &mut actual));
        let mut wrong = expected.clone();
        wrong.model_hash[0] ^= 1;
        assert!(VectorAsset::open(&path, &wrong).is_err());
        drop(asset);
        let before = std::fs::read(&path).unwrap();
        assert!(write_staging(&path, &expected, &[], &[], &[], |_, _| true).is_err());
        assert_eq!(before, std::fs::read(&path).unwrap());
    }
}

#[test]
fn graph_sections_crc_and_truncation_are_validated() {
    let root = TestRoot::new();
    let path = root.0.join("graph.vec");
    let expected = identity(3);
    write_staging(&path, &expected, &[1], b"graph", b"routing", |_, row| {
        row.extend_from_slice(&[1.0, 2.0, 3.0]); true
    }).unwrap();
    let asset = VectorAsset::open(&path, &expected).unwrap();
    assert_eq!(asset.graph_bytes(), b"graph");
    assert_eq!(asset.sm_bytes(), b"routing");
    drop(asset);
    let bytes = std::fs::read(&path).unwrap();
    let damaged = root.0.join("damaged.vec");
    for length in [0, 7, HEADER - 1, HEADER, bytes.len() - 1] {
        std::fs::write(&damaged, &bytes[..length]).unwrap();
        assert!(VectorAsset::open(&damaged, &expected).is_err());
    }
    for offset in [8, 24, 26, 96, 104, 112, 120, 128, 136, 144, HEADER, bytes.len() - 13] {
        let mut corrupted = bytes.clone();
        corrupted[offset] ^= 1;
        std::fs::write(&damaged, corrupted).unwrap();
        assert!(VectorAsset::open(&damaged, &expected).is_err(), "offset {offset}");
    }
}

#[test]
fn failed_staging_is_removed_and_duplicate_ids_never_read_source() {
    let root = TestRoot::new();
    let path = root.0.join("failed.vec");
    let expected = identity(3);
    assert!(write_staging(&path, &expected, &[1, 2], &[], &[], |slot, row| {
        if slot == 1 { return false; }
        row.extend_from_slice(&[1.0, 2.0, 3.0]); true
    }).is_err());
    assert!(!path.exists());
    assert!(write_staging(&path, &expected, &[1, 1], &[], &[], |_, _| {
        panic!("duplicate IDs must fail before reading source")
    }).is_err());
    assert!(!path.exists());
    write_staging(&path, &expected, &[], &[], &[], |_, _| {
        panic!("empty asset has no rows")
    }).unwrap();
    let asset = VectorAsset::open(&path, &expected).unwrap();
    assert!(asset.is_empty());
}
//! VCP-PATCH: immutable, SQL-rebuildable vector assets.
//! File publication and SQL endorsement belong to the host, not this module.
use crate::index::bq::MAX_BQ_DIM;
use memmap2::Mmap;
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;

#[cfg(test)]
#[path = "asset_tests.rs"]
mod tests;

pub const FORMAT_VERSION: u32 = 1;
const HEADER: usize = 192;
const FOOTER: usize = 12;
const MAGIC: &[u8; 8] = b"VCPVEC01";
const END: &[u8; 8] = b"VCPVCEND";

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdentity {
    pub dimension: usize,
    pub scope: u8,
    pub model_hash: [u8; 32],
    pub content_digest: [u8; 32],
}

pub struct VectorAsset {
    map: Mmap,
    identity: AssetIdentity,
    count: usize,
    vectors: usize,
    graph: std::ops::Range<usize>,
    sm: std::ops::Range<usize>,
}

fn u64_at(bytes: &[u8], offset: usize) -> io::Result<usize> {
    usize::try_from(u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()))
        .map_err(|_| invalid("asset offset exceeds address space"))
}

impl VectorAsset {
    /// The host must keep this file immutable while mapped (publish by rename).
    /// Never truncate or overwrite the inode underlying a live asset.
    pub fn open(path: &Path, expected: &AssetIdentity) -> io::Result<Self> {
        Self::open_impl(path, expected, true)
    }

    /// Only for a host-endorsed generation. Check its stored stamp against SQL
    /// before use; publication already performed the full CRC validation.
    pub fn open_endorsed(path: &Path, expected: &AssetIdentity) -> io::Result<Self> {
        Self::open_impl(path, expected, false)
    }

    fn open_impl(path: &Path, expected: &AssetIdentity, verify_crc: bool) -> io::Result<Self> {
        let mut file = File::open(path)?;
        // SAFETY: the host's immutable-asset protocol forbids in-place writes.
        let map = unsafe { Mmap::map(&file)? };
        if map.len() < HEADER + FOOTER || &map[..8] != MAGIC
            || &map[map.len() - 8..] != END
        {
            return Err(invalid("invalid vector asset envelope"));
        }
        let version = u32::from_le_bytes(map[8..12].try_into().unwrap());
        let dimension = u32::from_le_bytes(map[12..16].try_into().unwrap()) as usize;
        let count = u64_at(&map, 16)?;
        let scope = map[24];
        let layout = map[25];
        if version != FORMAT_VERSION || dimension == 0 || dimension > MAX_BQ_DIM
            || scope > 1 || layout > 1
            || map[26..32].iter().chain(map[144..HEADER].iter()).any(|v| *v != 0)
        {
            return Err(invalid("unsupported vector asset header"));
        }
        let identity = AssetIdentity {
            dimension, scope,
            model_hash: map[32..64].try_into().unwrap(),
            content_digest: map[64..96].try_into().unwrap(),
        };
        if &identity != expected {
            return Err(invalid("vector asset identity mismatch"));
        }
        let ids = u64_at(&map, 96)?;
        let vectors = u64_at(&map, 104)?;
        let graph_start = u64_at(&map, 112)?;
        let graph_len = u64_at(&map, 120)?;
        let sm_start = u64_at(&map, 128)?;
        let sm_len = u64_at(&map, 136)?;
        let ids_end = count.checked_mul(8).and_then(|v| HEADER.checked_add(v))
            .ok_or_else(|| invalid("asset IDs overflow"))?;
        let aligned = ids_end.checked_add(63).map(|v| v & !63)
            .ok_or_else(|| invalid("asset alignment overflow"))?;
        let vector_end = count.checked_mul(dimension).and_then(|v| v.checked_mul(4))
            .and_then(|v| vectors.checked_add(v))
            .ok_or_else(|| invalid("asset vectors overflow"))?;
        let graph_end = graph_start.checked_add(graph_len)
            .ok_or_else(|| invalid("asset graph overflow"))?;
        let sm_end = sm_start.checked_add(sm_len)
            .ok_or_else(|| invalid("asset SM overflow"))?;
        if ids != HEADER || vectors != aligned || graph_start != vector_end
            || sm_start != graph_end || sm_end != map.len() - FOOTER
            || (layout == 0 && (graph_len != 0 || sm_len != 0))
            || (layout == 1 && (graph_len == 0 || sm_len == 0))
        {
            return Err(invalid("invalid vector asset section layout"));
        }
        let crc = u32::from_le_bytes(map[sm_end..sm_end + 4].try_into().unwrap());
        // VCP-PATCH: validate through bounded ordinary I/O, not the retained
        // mapping. Hashing the mmap eagerly faults the entire cold f32 matrix
        // into this process's working set before the first candidate rerank.
        // Use the SAME open file as the mapping, not a reopened pathname.
        if verify_crc {
            let mut hasher = crc32fast::Hasher::new();
            let mut buffer = vec![0_u8; 256 * 1024];
            let mut remaining = sm_end;
            while remaining != 0 {
                let length = remaining.min(buffer.len());
                file.read_exact(&mut buffer[..length])?;
                hasher.update(&buffer[..length]);
                remaining -= length;
            }
            if hasher.finalize() != crc {
                return Err(invalid("vector asset CRC mismatch"));
            }
        }
        let mut seen = HashSet::with_capacity(count);
        for row in map[HEADER..ids_end].chunks_exact(8) {
            let id = u64::from_le_bytes(row.try_into().unwrap());
            if id == 0 || id > i64::MAX as u64 || !seen.insert(id) {
                return Err(invalid("invalid or duplicate vector asset ID"));
            }
        }
        Ok(Self { map, identity, count, vectors,
            graph: graph_start..graph_end, sm: sm_start..sm_end })
    }

    pub fn identity(&self) -> &AssetIdentity { &self.identity }
    pub fn len(&self) -> usize { self.count }
    pub fn is_empty(&self) -> bool { self.count == 0 }
    pub fn mapped_bytes(&self) -> usize { self.map.len() }
    /// Stored publication stamp; endorsed loads compare it with trusted SQL.
    pub fn file_stamp(&self) -> (u64, u32) {
        let end = self.map.len() - FOOTER;
        (self.map.len() as u64,
            u32::from_le_bytes(self.map[end..end + 4].try_into().unwrap()))
    }
    pub fn id_for_slot(&self, slot: usize) -> Option<u64> {
        if slot >= self.count { return None; }
        let start = HEADER + slot * 8;
        Some(u64::from_le_bytes(self.map[start..start + 8].try_into().unwrap()))
    }
    pub fn graph_bytes(&self) -> &[u8] { &self.map[self.graph.clone()] }
    pub fn sm_bytes(&self) -> &[u8] { &self.map[self.sm.clone()] }

    /// Raw f32 originals, exclusively for candidate reranking inside the index.
    pub(crate) fn fill_slot(&self, slot: usize, output: &mut Vec<f32>) -> bool {
        if slot >= self.count { return false; }
        let start = self.vectors + slot * self.identity.dimension * 4;
        output.clear();
        output.extend(self.map[start..start + self.identity.dimension * 4].chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap())));
        output.iter().all(|v| v.is_finite())
    }
}

/// Writes a NEW staging file only; never replaces an existing file.
/// Source rows must follow `ids` order. SQL remains the authoritative source.
pub fn write_staging<F>(
    path: &Path, identity: &AssetIdentity, ids: &[u64],
    graph: &[u8], sm: &[u8], mut fill: F,
) -> io::Result<()>
where F: FnMut(usize, &mut Vec<f32>) -> bool {
    let dim = identity.dimension;
    if dim == 0 || dim > MAX_BQ_DIM || identity.scope > 1
        || graph.is_empty() != sm.is_empty()
        || ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64)
        || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(invalid("invalid staging asset identity"));
    }
    let vectors = ids.len().checked_mul(8).and_then(|v| v.checked_add(HEADER + 63))
        .map(|v| v & !63).ok_or_else(|| invalid("staging IDs overflow"))?;
    let graph_start = ids.len().checked_mul(dim).and_then(|v| v.checked_mul(4))
        .and_then(|v| v.checked_add(vectors)).ok_or_else(|| invalid("staging vectors overflow"))?;
    let sm_start = graph_start.checked_add(graph.len()).ok_or_else(|| invalid("staging graph overflow"))?;
    sm_start.checked_add(sm.len()).and_then(|v| v.checked_add(FOOTER))
        .ok_or_else(|| invalid("staging SM overflow"))?;
    let mut header = [0_u8; HEADER];
    header[..8].copy_from_slice(MAGIC);
    header[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    header[12..16].copy_from_slice(&(dim as u32).to_le_bytes());
    header[16..24].copy_from_slice(&(ids.len() as u64).to_le_bytes());
    header[24] = identity.scope;
    header[25] = u8::from(!graph.is_empty());
    header[32..64].copy_from_slice(&identity.model_hash);
    header[64..96].copy_from_slice(&identity.content_digest);
    for (offset, value) in [(96, HEADER), (104, vectors), (112, graph_start),
        (120, graph.len()), (128, sm_start), (136, sm.len())] {
        header[offset..offset + 8].copy_from_slice(&(value as u64).to_le_bytes());
    }
    let file = File::options().write(true).create_new(true).open(path)?;
    let mut writer = BufWriter::new(file);
    let mut crc = crc32fast::Hasher::new();
    let result = (|| {
        let mut write = |bytes: &[u8]| -> io::Result<()> {
            writer.write_all(bytes)?;
            crc.update(bytes);
            Ok(())
        };
        write(&header)?;
        for id in ids { write(&id.to_le_bytes())?; }
        write(&vec![0; vectors - HEADER - ids.len() * 8])?;
        let mut row = Vec::with_capacity(dim);
        let mut bytes = Vec::with_capacity(dim * 4);
        for slot in 0..ids.len() {
            row.clear();
            if !fill(slot, &mut row) || row.len() != dim || row.iter().any(|v| !v.is_finite()) {
                return Err(invalid("cannot read staging source vector"));
            }
            bytes.clear();
            for value in &row { bytes.extend_from_slice(&value.to_le_bytes()); }
            write(&bytes)?;
        }
        write(graph)?;
        write(sm)?;
        writer.write_all(&crc.finalize().to_le_bytes())?;
        writer.write_all(END)?;
        writer.flush()?;
        writer.get_ref().sync_all()
    })();
    drop(writer);
    if result.is_err() { let _ = std::fs::remove_file(path); }
    result
}
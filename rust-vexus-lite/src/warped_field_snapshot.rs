//! Managed derived sidecars. Never writes SQLite facts.
use super::*;
use std::path::{Path,PathBuf};
use std::sync::{Arc,Mutex};
use std::io::Read;
use crate::rivermemo_topology_v3::{MemoRuntime,NativeArtifact};

const MAGIC:&[u8;8]=b"VCPWF001";
const MAX_BYTES:u64=512*1024*1024;
// Serialize staging names across VexusIndex instances in this process.
static SNAPSHOT_IO:Mutex<()>=Mutex::new(());

#[derive(serde::Serialize,serde::Deserialize)]
struct Header {
    identity:Identity,
    preset:Preset,
    dimension:usize,
    nodes:usize,
    active_tags:usize,
    ranked_tags:usize,
}

fn crc(bytes:&[u8])->u32 {
    let mut crc=flate2::Crc::new(); crc.update(bytes); crc.sum()
}

pub(super) fn path(database:&str, signature:&str, preset:Preset)->Option<PathBuf> {
    if database.is_empty() {return None;}
    let db=Path::new(database);
    let name=db.file_name()?.to_str()?;
    let digest=format!("{:x}",Sha256::digest(signature.as_bytes()));
    Some(db.with_file_name(format!("{name}.warped-{digest}-{}.vcpwf",preset.name())))
}

impl WarpedTagField {
    pub(crate) fn artifact_sig(&self)->&str {&self.identity.artifact}

    fn encode_snapshot(&self)->Result<Vec<u8>,String> {
        let header=serde_json::to_vec(&Header {
            identity:self.identity.clone(),preset:self.preset,dimension:self.dimension,
            nodes:self.ids().len(),active_tags:self.active_tags,ranked_tags:self.ranked_tags,
        }).map_err(|e|e.to_string())?;
        let payload=self.index.snapshot_bytes();
        let mut bytes=Vec::with_capacity(28+header.len()+self.inbound_quantiles.len()*4+payload.len());
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&header);
        for v in &self.inbound_quantiles {bytes.extend_from_slice(&v.to_le_bytes());}
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(&crc(&bytes).to_le_bytes());
        if bytes.len() as u64>MAX_BYTES {return Err("warped snapshot exceeds size limit".into());}
        Ok(bytes)
    }

    fn decode_snapshot(bytes:&[u8],connection:&Connection,signature:&str,
        preset:Preset,dimension:usize)->Result<Self,String> {
        let started=std::time::Instant::now();
        if bytes.len()<28 || bytes.len() as u64>MAX_BYTES || &bytes[..8]!=MAGIC {
            return Err("warped snapshot magic/length".into());
        }
        let end=bytes.len()-4;
        if crc(&bytes[..end])!=u32::from_le_bytes(bytes[end..].try_into().unwrap()) {
            return Err("warped snapshot CRC mismatch".into());
        }
        let h=usize::try_from(u64::from_le_bytes(bytes[8..16].try_into().unwrap()))
            .map_err(|_|"warped header overflow")?;
        let p=usize::try_from(u64::from_le_bytes(bytes[16..24].try_into().unwrap()))
            .map_err(|_|"warped payload overflow")?;
        if h>65536 || h>end-24 {return Err("warped header length".into());}
        let header:Header=serde_json::from_slice(&bytes[24..24+h]).map_err(|e|e.to_string())?;
        let q=header.nodes.checked_mul(4).ok_or("warped quantile overflow")?;
        let payload_start=24usize.checked_add(h).and_then(|v|v.checked_add(q))
            .ok_or("warped payload overflow")?;
        if payload_start.checked_add(p)!=Some(end) || header.preset!=preset
            || header.dimension!=dimension || header.identity.artifact!=signature {
            return Err("warped snapshot identity/shape mismatch".into());
        }
        let inbound_quantiles:Vec<f32>=bytes[24+h..payload_start].chunks_exact(4)
            .map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect();
        if inbound_quantiles.iter().any(|v|!v.is_finite() || !(0.0..=1.0).contains(v)) {
            return Err("warped snapshot invalid quantile".into());
        }
        let index=WarpedFieldIndex::from_snapshot_bytes(&bytes[payload_start..end])
            .map_err(|e|e.to_string())?;
        if index.configuration()!=preset.configuration()
            || header.nodes>header.ranked_tags || header.ranked_tags>header.active_tags
            || index.dimension()!=dimension || index.ids().len()!=header.nodes
            || index.ids().windows(2).any(|w|w[0]>=w[1])
            || index.ids().iter().any(|&id|id>i64::MAX as u64)
            || index.shell_landmark_count()==0 {
            return Err("warped snapshot index mismatch".into());
        }
        let field=Self {identity:header.identity,preset,inbound_quantiles,
            active_tags:header.active_tags,ranked_tags:header.ranked_tags,index,dimension,
            build_ms:started.elapsed().as_secs_f64()*1000.};
        if !field.current(connection,signature) {return Err("warped snapshot asset invalid".into());}
        Ok(field)
    }

    fn persist(&self)->Result<(),String> {
        let Some(target)=path(&self.identity.database,&self.identity.artifact,self.preset) else {return Ok(());};
        let bytes=self.encode_snapshot()?;
        let _io=SNAPSHOT_IO.lock().map_err(|e|e.to_string())?;
        let staging=crate::CheckpointStaging::new(&target).map_err(|e|e.to_string())?;
        std::fs::write(staging.path(),bytes).map_err(|e|e.to_string())?;
        crate::sync_index_file(staging.path()).map_err(|e|e.to_string())?;
        crate::publish_index_file(staging.path(),&target).map_err(|e|e.to_string())
    }
}

pub(crate) fn load_or_build(runtime:&MemoRuntime,connection:&Connection,signature:&str,
    artifact:&Arc<NativeArtifact>,dimension:usize,preset:Preset)
    ->Result<(Arc<WarpedTagField>,&'static str),String> {
    load_or_build_controlled(runtime,connection,signature,artifact,dimension,preset,false)
}

pub(super) fn load_or_build_controlled(runtime:&MemoRuntime,connection:&Connection,signature:&str,
    artifact:&Arc<NativeArtifact>,dimension:usize,preset:Preset,force:bool)
    ->Result<(Arc<WarpedTagField>,&'static str),String> {
    let cached=||->Result<Option<Arc<WarpedTagField>>,String> {
        if force {return Ok(None);}
        Ok(runtime.warped_fields.read().map_err(|e|e.to_string())?.get(&preset)
            .filter(|f|f.current(connection,signature)).cloned())
    };
    if let Some(field)=cached()? {return Ok((field,"memory"));}
    let _cold=runtime.warped_cold_load.lock().map_err(|e|e.to_string())?;
    if let Some(field)=cached()? {return Ok((field,"memory"));}
    crate::rivermemo_topology_v3::validate_artifact_with_connection(connection,signature)?;
    let ticket=runtime.warped_build_ticket();
    let database:String=connection.query_row("PRAGMA database_list",[],|r|r.get(2))
        .map_err(|e|e.to_string())?;
    let restored=path(&database,signature,preset).filter(|_|!force).and_then(|path| {
        let file=std::fs::File::open(path).ok()?;
        if file.metadata().ok()?.len()>MAX_BYTES {return None;}
        let mut bytes=Vec::new();
        file.take(MAX_BYTES+1).read_to_end(&mut bytes).ok()?;
        WarpedTagField::decode_snapshot(&bytes,connection,signature,preset,dimension).ok()
    });
    let (field,source)=match restored {
        Some(field)=>(field,"snapshot"),
        None=>{
            let initialized:bool=connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM tagmemo_artifacts WHERE asset_type='unified_geometry'
                 AND status='ready' AND model_sig=(SELECT model_sig FROM rivermemo_artifacts WHERE artifact_sig=?1))
                 AND EXISTS(SELECT 1 FROM kv_store WHERE key='epa_basis_cache')",
                [signature],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !initialized {return Err("WARPED_NOT_INITIALIZED: unified_geometry or epa_basis_cache unavailable".into());}
            let field=WarpedTagField::build(connection,signature,artifact,dimension,preset)?;
            field.persist()?;
            (field,"built")
        },
    };
    let field=Arc::new(field);
    // Old WAL requests may finish with their pinned historical field. They cannot
    // overwrite a newer active artifact, and never need to fall back to cosine.
    match runtime.publish_warped_field(ticket,signature,field.clone()) {
        Ok(())=>{},
        Err(e) if e=="warped construction invalidated before publication" && !force=>{},
        Err(e)=>return Err(e),
    }
    Ok((field,source))
}

pub(crate) fn prune_snapshots(connection:&Connection)->Result<usize,String> {
    let database:String=connection.query_row("PRAGMA database_list",[],|r|r.get(2))
        .map_err(|e|e.to_string())?;
    if database.is_empty() {return Ok(0);}
    let db=Path::new(&database);
    let name=db.file_name().and_then(|s|s.to_str()).ok_or("warped database filename")?;
    let prefix=format!("{name}.warped-");
    let mut statement=connection.prepare("SELECT artifact_sig FROM rivermemo_artifacts WHERE status='ready'")
        .map_err(|e|e.to_string())?;
    let signatures=statement.query_map([],|r|r.get::<_,String>(0))
        .map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e|e.to_string())?;
    let keep:HashSet<_>=signatures.iter().flat_map(|sig|[Preset::Locked0,Preset::Locked2]
        .into_iter().filter_map(|preset|path(&database,sig,preset))
        .filter_map(|p|p.file_name().map(|s|s.to_os_string()))).collect();
    let _io=SNAPSHOT_IO.lock().map_err(|e|e.to_string())?;
    let mut removed=0;
    for entry in std::fs::read_dir(db.parent().ok_or("warped database parent")?).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?;
        let filename=entry.file_name();
        let Some(s)=filename.to_str() else {continue;};
        let Some(suffix)=s.strip_prefix(&prefix) else {continue;};
        let temporary=suffix.ends_with(".vcpwf.tmp");
        let valid=suffix.len()>=64 && suffix.as_bytes()[..64].iter().all(|b|b.is_ascii_hexdigit())
            && ["-locked_0.vcpwf","-locked_2.vcpwf",
                "-locked_0.vcpwf.tmp","-locked_2.vcpwf.tmp"].contains(&&suffix[64..]);
        if valid && (temporary || !keep.contains(&filename)) {
            match std::fs::remove_file(entry.path()) {
                Ok(())=>removed+=1,
                Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},
                Err(e)=>return Err(e.to_string()),
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_roundtrip_identity_crc_and_deleted_candidate() {
        for preset in [Preset::Locked0,Preset::Locked2] {
            let (db,artifact)=super::super::tests::fixture();
            let field=WarpedTagField::build(&db,"a",&artifact,3,preset).unwrap();
            let bytes=field.encode_snapshot().unwrap();
            assert_eq!(bytes,field.encode_snapshot().unwrap());
            let restored=WarpedTagField::decode_snapshot(&bytes,&db,"a",preset,3).unwrap();
            assert_eq!(bytes,restored.encode_snapshot().unwrap());
            let run=|f:&WarpedTagField| f.search(&db,&[0.3,0.8,0.4],0.425,10,
                &HashSet::new(),&mut crate::storage::TagVectorPool::new()).unwrap().0;
            assert_eq!(run(&field),run(&restored));
            assert!(WarpedTagField::decode_snapshot(&bytes,&db,"other",preset,3).is_err());
            assert!(WarpedTagField::decode_snapshot(&bytes,&db,"a",preset,65).is_err());
            let other=if preset==Preset::Locked0 {Preset::Locked2} else {Preset::Locked0};
            assert!(WarpedTagField::decode_snapshot(&bytes,&db,"a",other,3).is_err());
            for position in [0,8,16,24,bytes.len()/2,bytes.len()-1] {
                let mut corrupt=bytes.clone();corrupt[position]^=0x80;
                assert!(WarpedTagField::decode_snapshot(&corrupt,&db,"a",preset,3).is_err());
            }
            for length in [0,7,23,27,bytes.len()-1] {
                assert!(WarpedTagField::decode_snapshot(&bytes[..length],&db,"a",preset,3).is_err());
            }
            let deleted=run(&field)[0];
            db.execute("DELETE FROM tags WHERE id=?1",[deleted]).unwrap();
            assert!(!run(&restored).contains(&deleted));
            assert!(restored.current(&db,"a"));
        }
    }

    #[test]
    fn persisted_restart_single_flight_and_prune() {
        let root=std::env::temp_dir().join(format!("warped-snapshot-{}-{}",
            std::process::id(),std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db_path=root.join("test.sqlite");
        let (source,artifact)=super::super::tests::fixture();
        source.execute_batch("COMMIT").unwrap();
        source.execute("VACUUM INTO ?1",[db_path.to_str().unwrap()]).unwrap();
        let db=Connection::open(&db_path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let artifact=Arc::new(artifact);
        let runtime=MemoRuntime::new();
        runtime.publish("a",artifact.clone()).unwrap();
        let (field,origin)=load_or_build(&runtime,&db,"a",&artifact,3,Preset::Locked2).unwrap();
        assert_eq!(origin,"built");
        runtime.clear().unwrap();
        runtime.publish("a",artifact.clone()).unwrap();
        std::thread::scope(|scope| {
            let workers:Vec<_>=(0..8).map(|_|scope.spawn(|| {
                let c=Connection::open_with_flags(&db_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                c.execute_batch("BEGIN").unwrap();
                load_or_build(&runtime,&c,"a",&artifact,3,Preset::Locked2).unwrap()
            })).collect();
            let loaded:Vec<_>=workers.into_iter().map(|w|w.join().unwrap()).collect();
            assert_eq!(loaded.iter().filter(|(_,source)|*source=="snapshot").count(),1);
            for (f,_) in &loaded {assert!(Arc::ptr_eq(f,&loaded[0].0));}
            assert_eq!(loaded[0].0.ids(),field.ids());
        });
        let (forced,origin)=load_or_build_controlled(&runtime,&db,"a",&artifact,3,Preset::Locked2,true).unwrap();
        assert_eq!(origin,"built");
        assert!(!Arc::ptr_eq(&forced,&field));
        let (active,origin)=load_or_build(&runtime,&db,"a",&artifact,3,Preset::Locked2).unwrap();
        assert_eq!(origin,"memory");
        assert!(Arc::ptr_eq(&active,&forced));
        let target=path(&field.identity.database,"a",Preset::Locked2).unwrap();
        let temporary=PathBuf::from(format!("{}.tmp",target.display()));
        std::fs::write(&temporary,b"interrupted-checkpoint").unwrap();
        let unrelated=root.join("test.sqlite.warped-不属于受控快照.vcpwf");
        std::fs::write(&unrelated,b"preserve").unwrap();
        assert_eq!(prune_snapshots(&db).unwrap(),1);
        assert!(!temporary.exists());
        assert!(target.exists() && unrelated.exists());
        db.execute("UPDATE rivermemo_artifacts SET status='retired'",[]).unwrap();
        assert_eq!(prune_snapshots(&db).unwrap(),1);
        assert!(!field.current(&db,"a"));
        drop(db);drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod large_snapshot_probe {
    use super::*;
    #[test]
    fn full_sidecar_synthetic_read_crc_validate_performance() {
        let (db,_)=super::super::tests::fixture();
        let dim=3072usize;
        let n=48_000usize;
        let config=Preset::Locked2.configuration();
        let small=WarpedFieldIndex::build(dim,&[1,2,3,4],&[0,1,2,3],&[0.4;4],
            &vec![0.;dim],config,|slot,out| {
                out.extend((0..dim).map(|j|((j*13+slot*7+1) as f32*0.17).sin()));true
            }).unwrap();
        let sample=small.snapshot_bytes();
        // Explicit V1 wire layout: repeated legal codes and a connected ring.
        // This avoids constructing an artificial 48k graph as a quality experiment.
        let mut cursor=128usize;
        let mut block=|width:usize| {
            let start=cursor;
            let count=u64::from_le_bytes(sample[cursor..cursor+8].try_into().unwrap()) as usize;
            cursor+=8+count*width;
            &sample[start..cursor]
        };
        let _ids=block(8);
        let _slots=block(8);
        let mean=block(8).to_vec();
        let table=block(4).to_vec();
        let metadata=block(32)[8..40].to_vec();
        let planes=block(8)[8..8+dim.div_ceil(64)*16].to_vec();
        let mut payload=sample[..128].to_vec();
        let put=|b:&mut Vec<u8>,v:u64|b.extend_from_slice(&v.to_le_bytes());
        put(&mut payload,n as u64);
        for id in 1..=n as u64 {put(&mut payload,id);}
        put(&mut payload,0);
        payload.extend(mean);payload.extend(table);
        put(&mut payload,n as u64);
        for _ in 0..n {payload.extend_from_slice(&metadata);}
        put(&mut payload,(n*dim.div_ceil(64)*2) as u64);
        for _ in 0..n {payload.extend_from_slice(&planes);}
        let u32s=|out:&mut Vec<u8>,values:Vec<u32>| {
            put(out,values.len() as u64);
            for v in values {out.extend_from_slice(&v.to_le_bytes());}
        };
        u32s(&mut payload,(0..n).flat_map(|i|[((i+1)%n) as u32,((i+n-1)%n) as u32]).collect());
        u32s(&mut payload,(0..=n).map(|i|(i*2) as u32).collect());
        u32s(&mut payload,vec![0]);
        u32s(&mut payload,(0..64).collect());
        u32s(&mut payload,(0..512).collect());
        let index=WarpedFieldIndex::from_snapshot_bytes(&payload).unwrap();
        let (identity,_)=identity(&db,"a").unwrap();
        let field=WarpedTagField {identity,preset:Preset::Locked2,
            inbound_quantiles:vec![0.5;n],active_tags:n,ranked_tags:n,index,
            dimension:dim,build_ms:0.};
        let bytes=field.encode_snapshot().unwrap();
        let target=std::env::temp_dir().join(format!("warped-large-probe-{}.vcpwf",std::process::id()));
        std::fs::write(&target,&bytes).unwrap();
        let mut times=Vec::new();
        for _ in 0..5 {
            let start=std::time::Instant::now();
            let bytes=std::fs::read(&target).unwrap();
            let loaded=WarpedTagField::decode_snapshot(&bytes,&db,"a",Preset::Locked2,dim).unwrap();
            times.push(start.elapsed().as_secs_f64()*1000.);
            assert_eq!(loaded.ids().len(),n);
        }
        times.sort_by(f64::total_cmp);
        eprintln!("warped_full_sidecar bytes={} nodes={} dim={} warm_file_read_crc_validate_median_ms={:.3}",
            bytes.len(),n,dim,times[2]);
        std::fs::remove_file(target).unwrap();
    }
}
//! Opt-in immutable AGS routing. SQL originals and the default cosine path remain authoritative.
use base64::Engine;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use vcp_tdb_index::index::quiver::hyperbolic::{
    HyperbolicSearchConfig, HyperbolicSearchStats, WarpedFieldConfig, WarpedFieldIndex,
    WarpedNavigationOptions, WarpedRerankOptions, WarpedSeedMode, warped_size_budget,
};
use vcp_tdb_index::index::quiver::hyperbolic::warped_geometry::WarpedProfile;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Deserialize)]
pub(crate) enum Preset {
    #[serde(rename = "locked_0")]
    Locked0,
    #[serde(rename = "locked_2")]
    Locked2,
}
impl Default for Preset { fn default() -> Self { Self::Locked0 } }

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub(crate) enum RadiusStrategy {
    LayerSchedule,
    EpaGuided,
}
impl Default for RadiusStrategy { fn default() -> Self { Self::LayerSchedule } }

pub(crate) fn query_radius(strategy: RadiusStrategy, level: usize, levels: usize,
    gate: f64, logic: f64, entropy: f64, available: bool) -> f32 {
    let finite = |v: f64| if v.is_finite() { v.clamp(0.0,1.0) } else { 0.0 };
    let position = if strategy == RadiusStrategy::EpaGuided && available {
        0.55 * finite(gate) * (1.0-finite(entropy)) + 0.30*finite(logic)
            + 0.15*level as f64/levels.max(1) as f64
    } else { 0.25+0.25*level as f64 };
    (0.35+0.30*position.clamp(0.0,1.0)) as f32
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    database: String,
    generation: u64,
    dependencies: crate::storage::DerivedDependencies,
    artifact: String,
    geometry: String,
    mean_hash: String,
    model: String,
}

fn metadata_identity(connection: &Connection, artifact: &str) -> Result<Identity, String> {
    if connection.is_autocommit() { return Err("warped field requires a read transaction".into()); }
    let generation = crate::storage::read_generation(connection)?;
    let database: String = connection.query_row("PRAGMA database_list", [], |r| r.get(2))
        .map_err(|e| e.to_string())?;
    // Historical artifacts may remain valid for cosine, but never silently feed this field.
    // Status follows a potentially huge payload in the table record. Read it
    // through the covering index rather than walking payload overflow pages.
    let status_sql="SELECT status,schema_version FROM rivermemo_artifacts
        INDEXED BY idx_rivermemo_validation WHERE artifact_sig=?1";
    let status:rusqlite::Result<(String,String)>=match connection.prepare_cached(status_sql) {
        Ok(mut statement)=>statement.query_row([artifact],|r|Ok((r.get(0)?,r.get(1)?))),
        Err(rusqlite::Error::SqliteFailure(_,Some(message))) if message.starts_with("no such index")=>
            connection.query_row("SELECT status,schema_version FROM rivermemo_artifacts WHERE artifact_sig=?1",
                [artifact],|r|Ok((r.get(0)?,r.get(1)?))),
        Err(error)=>Err(error),
    };
    let (status,schema)=status.map_err(|e|e.to_string())?;
    if status!="ready" || schema!="rivermemo-persisted-artifact-v2" {
        return Err("warped artifact format/status mismatch".into());
    }
    let (model, source_generation): (String,String) = connection.prepare_cached(
        "SELECT model_sig,database_generation FROM rivermemo_artifacts WHERE artifact_sig=?1")
        .map_err(|e|e.to_string())?.query_row(
        [artifact], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e| e.to_string())?;
    if source_generation.parse::<u64>().ok() != Some(generation) {
        return Err("warped artifact database generation is stale".into());
    }
    let dependencies = crate::storage::DerivedDependencies::capture(
        connection, crate::storage::MEMO_ARTIFACT_DEPENDENCIES)?;
    let mut expected = Vec::new();
    for key in crate::storage::MEMO_ARTIFACT_DEPENDENCIES {
        let (current,published): (String,String) = connection.query_row(
            "SELECT m.value,d.dependency_version FROM kbm_runtime_meta m
             JOIN kbm_artifact_dependencies d ON d.dependency_key=m.key
             WHERE m.key=?1 AND d.artifact_sig=?2",
            rusqlite::params![key,artifact], |r| Ok((r.get(0)?,r.get(1)?)))
            .map_err(|e| e.to_string())?;
        if current != published { return Err(format!("warped dependency {key} is stale")); }
        expected.push(current);
    }
    let (geometry,facts): (String,String) = connection.query_row(
        "SELECT artifact_sig,graph_generation FROM tagmemo_artifacts
         WHERE asset_type='unified_geometry' AND status='ready' AND model_sig=?1
         ORDER BY updated_at DESC,artifact_sig LIMIT 1",
        [&model], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e| e.to_string())?;
    if facts != format!("facts:{}",expected[0]) { return Err("warped geometry facts are stale".into()); }
    Ok(Identity { database,generation,dependencies,artifact:artifact.into(),geometry,
        mean_hash:String::new(),model })
}

fn identity(connection: &Connection, artifact: &str) -> Result<(Identity, Vec<f64>), String> {
    let mut identity=metadata_identity(connection,artifact)?;
    let raw: String = connection.query_row(
        "SELECT value FROM kv_store WHERE key='epa_basis_cache'",[],|r| r.get(0))
        .map_err(|e| e.to_string())?;
    let cache: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cache["artifactSig"].as_str() != Some(&identity.geometry) {
        return Err("warped EPA/geometry signature mismatch".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(
        cache["mean"].as_str().ok_or("warped EPA mean missing")?).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len()%4 != 0 { return Err("warped EPA mean shape".into()); }
    let mean: Vec<f64> = bytes.chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64).collect();
    if mean.iter().any(|v| !v.is_finite()) { return Err("warped EPA mean nonfinite".into()); }
    identity.mean_hash=format!("{:x}",Sha256::digest(raw.as_bytes()));
    Ok((identity,mean))
}

pub(crate) struct WarpedTagField {
    identity: Identity,
    pub(crate) preset: Preset,
    inbound_quantiles: Vec<f32>,
    pub(crate) active_tags: usize,
    pub(crate) ranked_tags: usize,
    pub(crate) index: WarpedFieldIndex,
    dimension: usize,
    pub(crate) build_ms: f64,
}

impl WarpedTagField {
    /// Managed payload estimate, not allocator overhead or RSS.
    pub(crate) fn hot_bytes(&self) -> usize {
        self.index.hot_bytes()
            + self.inbound_quantiles.capacity()*std::mem::size_of::<f32>()
            + self.identity.database.capacity()+self.identity.artifact.capacity()
            + self.identity.geometry.capacity()+self.identity.mean_hash.capacity()
            + self.identity.model.capacity()
    }
    pub(crate) fn ids(&self) -> &[u64] { self.index.ids() }

    pub(crate) fn inbound_quantile(&self, id: i64) -> Option<f64> {
        let id=u64::try_from(id).ok()?;
        self.ids().binary_search(&id).ok().map(|node|self.inbound_quantiles[node] as f64)
    }

    pub(crate) fn build(connection: &Connection, artifact_sig: &str,
        artifact: &crate::rivermemo_topology_v3::NativeArtifact, dimension: usize,
        preset: Preset) -> Result<Self,String> {
        let started=std::time::Instant::now();
        let (identity,mean) = identity(connection,artifact_sig)?;
        if mean.len()!=dimension { return Err("warped dimension/mean mismatch".into()); }
        let mut statement=connection.prepare("SELECT id FROM tags ORDER BY id").map_err(|e|e.to_string())?;
        let active:Vec<i64>=statement.query_map([],|r|r.get(0)).map_err(|e|e.to_string())?
            .collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?;
        let mut ranked:Vec<(f64,i64)>=Vec::new();
        for &id in &active {
            if let Some(&mass)=artifact.inbound.get(&id) {
                if !mass.is_finite() || mass<0.0 { return Err("warped invalid inbound".into()); }
                ranked.push((mass.ln_1p(),id));
            }
        }
        ranked.sort_by(|a,b|a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut inbound_quantiles=HashMap::new();
        let mut start=0;
        while start<ranked.len() {
            let mut end=start+1;
            while end<ranked.len() && ranked[end].0==ranked[start].0 { end+=1; }
            let q=if ranked.len()>1 {(start+end-1) as f64/(2.0*(ranked.len()-1) as f64)} else {0.5};
            for &(_,id) in &ranked[start..end] { inbound_quantiles.insert(id,q); }
            start=end;
        }
        let mut statement=connection.prepare(
            "SELECT t.id,r.raw_residual_ratio FROM tags t
             JOIN tag_intrinsic_residuals r ON r.tag_id=t.id
             WHERE r.model_sig=?1 AND r.artifact_sig=?2 AND r.status='computed'
             AND t.vector IS NOT NULL ORDER BY t.id").map_err(|e|e.to_string())?;
        let mut rows=statement.query(rusqlite::params![identity.model,identity.geometry]).map_err(|e|e.to_string())?;
        let mut ids=Vec::new();
        let mut radii=Vec::new();
        while let Some(row)=rows.next().map_err(|e|e.to_string())? {
            let id:i64=row.get(0).map_err(|e|e.to_string())?;
            let r:f64=row.get(1).map_err(|e|e.to_string())?;
            if id<=0 || !r.is_finite() || !(0.0..=1.0).contains(&r) {
                return Err("warped invalid residual metadata".into());
            }
            if let Some(&q)=inbound_quantiles.get(&id) {
                if !artifact.node_index.contains_key(&id) { continue; }
                ids.push(id);
                radii.push((0.35+0.30*(0.65*(1.0-q)+0.35*r).clamp(0.0,1.0).powf(1.15)) as f32);
            }
        }
        if ids.len()<2 { return Err("warped insufficient joint coverage".into()); }
        let config=WarpedFieldConfig {
            profile:WarpedProfile::Softening {alpha:0.15},radius_max:0.65,
            mean_subtract_beta:if preset==Preset::Locked0 {1.0} else {0.7},
            throat_phi0:1.5,angular_scale_kappa:2.0,adaptive_compass:true,..Default::default()
        };
        let kernel_ids:Vec<u64>=ids.iter().map(|&id|id as u64).collect();
        let slots:Vec<usize>=(0..ids.len()).collect();
        let mut source_error=None;
        let mut read=connection.prepare_cached("SELECT vector FROM tags WHERE id=?1")
            .map_err(|e|e.to_string())?;
        let index=WarpedFieldIndex::build(dimension,&kernel_ids,&slots,&radii,&mean,config,|slot,out| {
            let result=read.query_row([ids[slot]],|row|crate::index_source::decode_column_into(row,0,dimension,out));
            match result {
                Ok(valid)=>valid,
                Err(e)=>{source_error=Some(e.to_string());false}
            }
        }).map_err(|e|source_error.take().unwrap_or_else(||e.to_string()))?;
        if index.connectivity()!=(ids.len(),0) { return Err("warped graph connectivity failure".into()); }
        let inbound_quantiles:Vec<f32>=ids.iter().map(|id|inbound_quantiles[id] as f32).collect();
        Ok(Self {identity,preset,inbound_quantiles,active_tags:active.len(),
            ranked_tags:ranked.len(),index,dimension,build_ms:started.elapsed().as_secs_f64()*1000.0})
    }

    pub(crate) fn generation(&self) -> u64 { self.identity.generation }

    pub(crate) fn current(&self, connection:&Connection, signature:&str) -> bool {
        crate::memo_pipeline::epa_cache_digest(connection).is_ok_and(|digest|
            self.current_with_epa_digest(connection,signature,&digest))
    }

    /// Digest must come from EPA analysis on this same transaction.
    pub(crate) fn current_with_epa_digest(&self, connection:&Connection, signature:&str,
        digest:&str) -> bool {
        metadata_identity(connection,signature).is_ok_and(|mut id| {
            id.mean_hash=digest.into();
            id==self.identity
        })
    }

    pub(crate) fn search(&self, connection:&Connection, query:&[f32], radius:f32, k:usize,
        excluded:&HashSet<i64>, pool:&mut crate::storage::TagVectorPool)
        -> Result<(Vec<i64>,HyperbolicSearchStats,usize,usize),String> {
        self.search_budget(connection,query,radius,k,excluded,pool,false)
    }

    pub(crate) fn search_budget(&self, connection:&Connection, query:&[f32], radius:f32, k:usize,
        excluded:&HashSet<i64>, pool:&mut crate::storage::TagVectorPool, legacy_budget:bool)
        -> Result<(Vec<i64>,HyperbolicSearchStats,usize,usize),String> {
        self.search_controls(connection,query,radius,k,excluded,pool,legacy_budget,false,false)
    }

    pub(crate) fn search_controls(&self, connection:&Connection, query:&[f32], radius:f32, k:usize,
        excluded:&HashSet<i64>, pool:&mut crate::storage::TagVectorPool, legacy_budget:bool,
        shell_directory:bool,reuse_beam:bool)
        -> Result<(Vec<i64>,HyperbolicSearchStats,usize,usize),String> {
        self.search_policy(connection,query,radius,k,excluded,pool,legacy_budget,
            shell_directory,reuse_beam,0)
    }

    pub(crate) fn search_policy(&self, connection:&Connection, query:&[f32], radius:f32, k:usize,
        excluded:&HashSet<i64>, pool:&mut crate::storage::TagVectorPool, legacy_budget:bool,
        shell_directory:bool,reuse_beam:bool,seed_policy:u8)
        -> Result<(Vec<i64>,HyperbolicSearchStats,usize,usize),String> {
        if k==0 || k>64 { return Err("warped pyramid top_k must be 1..64".into()); }
        let (max_visits,max_expansions)=if legacy_budget && self.ids().len()>4096 {
            (1536,384)
        } else { warped_size_budget(self.ids().len()) };
        let mut read=connection.prepare_cached("SELECT vector FROM tags WHERE id=?1").map_err(|e|e.to_string())?;
        let mut error=None;
        let mut sql_reads=0;
        let mut cache_hits=0;
        let valid_original=|v:&[f32]| v.len()==self.dimension
            && v.iter().all(|x|x.is_finite())
            && v.iter().map(|&x|(x as f64)*(x as f64)).sum::<f64>()>1e-24;
        let output=self.index.search_seed_policy(query,radius,HyperbolicSearchConfig {
            top_k:k,width:128,rerank_limit:64,max_visits,max_expansions,radial_bound:true,
        },WarpedSeedMode::DirectionLandmarks,WarpedNavigationOptions {
            asymmetric:true,compact_seeds:true,
        },WarpedRerankOptions {reuse_transform:true,envelope_bound:true},
        shell_directory,reuse_beam,seed_policy,None,
        |id|excluded.contains(&(id as i64)),|slot,out| {
            let id=self.ids()[slot] as i64;
            if let Some(v)=pool.get(&id) {
                cache_hits+=1;
                if !valid_original(v) {
                    error=Some(format!("warped cached original invalid: {id}"));return false;
                }
                out.extend_from_slice(v);return true;
            }
            sql_reads+=1;
            #[cfg(test)]
            crate::storage::tag_read_audit::record("warped_rerank",id);
            match read.query_row([id],|row|crate::index_source::decode_column_into(row,0,self.dimension,out)).optional() {
                Ok(Some(true)) if valid_original(out)=>{
                    pool.insert(id,std::sync::Arc::from(out.clone()));true
                },
                Ok(_)=>{error=Some(format!("warped original missing/invalid: {id}"));false},
                Err(e)=>{error=Some(e.to_string());false},
            }
        }).map_err(|e|e.to_string())?;
        if let Some(error)=error {return Err(error);}
        Ok((output.neighbors.iter().map(|&(id,_)|id as i64).collect(),output.stats,sql_reads,cache_hits))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection,crate::rivermemo_topology_v3::NativeArtifact) {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);
             CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('database_generation','7'),('memo_tag_facts','9'),('derived_geometry','11');
             CREATE TABLE kbm_artifact_dependencies(artifact_sig TEXT,dependency_key TEXT,dependency_version TEXT);
             INSERT INTO kbm_artifact_dependencies VALUES ('a','memo_tag_facts','9'),('a','derived_geometry','11');
             CREATE TABLE rivermemo_artifacts(artifact_sig TEXT,model_sig TEXT,database_generation TEXT,status TEXT,schema_version TEXT);
             INSERT INTO rivermemo_artifacts VALUES ('a','m','7','ready','rivermemo-persisted-artifact-v2');
             CREATE TABLE tagmemo_artifacts(artifact_sig TEXT,graph_generation TEXT,asset_type TEXT,status TEXT,model_sig TEXT,updated_at INTEGER);
             INSERT INTO tagmemo_artifacts VALUES ('g','facts:9','unified_geometry','ready','m',1);
             CREATE TABLE kv_store(key TEXT,value TEXT);
             CREATE TABLE tag_intrinsic_residuals(tag_id INTEGER,raw_residual_ratio REAL,model_sig TEXT,artifact_sig TEXT,status TEXT);"
        ).unwrap();
        let mean=base64::engine::general_purpose::STANDARD.encode(
            [0.01_f32,0.0,0.0].iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>());
        db.execute("INSERT INTO kv_store VALUES ('epa_basis_cache',?1)",
            [serde_json::json!({"artifactSig":"g","mean":mean}).to_string()]).unwrap();
        let mut artifact=crate::rivermemo_topology_v3::NativeArtifact::default();
        for id in 1..=80_i64 {
            let t=id as f32*0.17;
            let v=[t.cos(),t.sin(),(t*0.37).cos()];
            let bytes:Vec<_>=v.iter().flat_map(|v|v.to_le_bytes()).collect();
            db.execute("INSERT INTO tags VALUES (?1,?2)",rusqlite::params![id,bytes]).unwrap();
            db.execute("INSERT INTO tag_intrinsic_residuals VALUES (?1,0.5,'m','g','computed')",[id]).unwrap();
            artifact.node_index.insert(id,artifact.node_ids.len());
            artifact.node_ids.push(id);
            artifact.inbound.insert(id,(id/4) as f64);
        }
        db.execute_batch("BEGIN").unwrap();
        (db,artifact)
    }

    #[test]
    fn pool_reuses_every_rerank_row_and_identity_rejects_generation_and_dependencies() {
        let (db,artifact)=fixture();
        let field=WarpedTagField::build(&db,"a",&artifact,3,Preset::Locked2).unwrap();
        assert!(field.current(&db,"a"));
        assert!(!field.current(&db,"other"));
        assert_eq!(field.index.connectivity(),(80,0));
        assert_eq!(field.inbound_quantile(4),field.inbound_quantile(5));
        assert!(field.inbound_quantile(-1).is_none());
        assert!(field.inbound_quantile(999).is_none());
        assert_eq!(field.inbound_quantiles.len(),field.ids().len());
        let mut pool=crate::storage::TagVectorPool::new();
        let q=[0.3,0.8,0.4];
        let (a,stats,reads,hits)=field.search(&db,&q,0.425,10,&HashSet::new(),&mut pool).unwrap();
        assert_eq!(reads,stats.cold_reads);
        assert_eq!(hits,0);
        let original=pool.clone();
        let (b,stats,reads,hits)=field.search(&db,&q,0.425,10,&HashSet::new(),&mut pool).unwrap();
        assert_eq!(a,b);
        assert_eq!(reads,0);
        assert_eq!(hits,stats.cold_reads);
        for (id,v) in original { assert!(std::sync::Arc::ptr_eq(&v,&pool[&id])); }
        let ids=pool.keys().copied().collect::<Vec<_>>();
        assert_eq!(crate::storage::ensure_tag_vectors_loaded(&db,&mut pool,&ids,3).unwrap().fetched_nodes,0);
        let all=field.ids().iter().map(|&id|id as i64).collect();
        let (ids,stats,reads,_)=field.search(&db,&q,0.425,10,&all,&mut pool).unwrap();
        assert!(ids.is_empty());
        assert_eq!((stats.cold_reads,reads),(0,0));
        db.execute("UPDATE kbm_runtime_meta SET value='8' WHERE key='database_generation'",[]).unwrap();
        assert!(!field.current(&db,"a"));
        db.execute("UPDATE kbm_runtime_meta SET value='7' WHERE key='database_generation'",[]).unwrap();
        db.execute("UPDATE kbm_runtime_meta SET value='12' WHERE key='derived_geometry'",[]).unwrap();
        assert!(!field.current(&db,"a"));
    }

    #[test]
    fn concurrent_instances_preserve_query_results_without_shared_controls() {
        std::thread::scope(|scope| {
            let workers:Vec<_>=[Preset::Locked0,Preset::Locked2].into_iter().map(|preset|scope.spawn(move || {
                let (db,artifact)=fixture();
                let field=std::sync::Arc::new(WarpedTagField::build(&db,"a",&artifact,3,preset).unwrap());
                let q=[0.3,0.8,0.4];
                let run=||field.search(&db,&q,0.425,10,&HashSet::from([1,2,3]),
                    &mut crate::storage::TagVectorPool::new()).unwrap().0;
                let expected=run();
                for _ in 0..8 { assert_eq!(expected,run()); }
                expected
            })).collect();
            for worker in workers { assert_eq!(worker.join().unwrap().len(),10); }
        });
    }

    #[test]
    fn shared_field_wal_snapshots_and_database_identity_are_isolated() {
        let root=std::env::temp_dir().join(format!("phase5-wal-{}-{}",
            std::process::id(),std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let path=root.join("a.sqlite");
        let other=root.join("b.sqlite");
        let (source,artifact)=fixture();
        source.execute_batch("COMMIT").unwrap();
        source.execute("VACUUM INTO ?1",[path.to_str().unwrap()]).unwrap();
        source.execute("VACUUM INTO ?1",[other.to_str().unwrap()]).unwrap();
        let writer=Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        let reader=Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let field=std::sync::Arc::new(
            WarpedTagField::build(&reader,"a",&artifact,3,Preset::Locked2).unwrap());
        let q=[0.3,0.8,0.4];
        let run=|db:&Connection|field.search(db,&q,0.425,10,&HashSet::new(),
            &mut crate::storage::TagVectorPool::new()).unwrap().0;
        let expected=run(&reader);
        std::thread::scope(|scope| {
            let workers:Vec<_>=(0..4).map(|_|scope.spawn(||{
                let db=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                db.execute_batch("BEGIN").unwrap();
                assert!(field.current(&db,"a"));
                for _ in 0..4 { assert_eq!(run(&db),expected); }
            })).collect();
            for worker in workers { worker.join().unwrap(); }
        });
        let separate=Connection::open(&other).unwrap();
        separate.execute_batch("BEGIN").unwrap();
        assert!(!field.current(&separate,"a"),"same metadata is not same database");
        writer.execute("UPDATE kbm_runtime_meta SET value='8' WHERE key='database_generation'",[]).unwrap();
        assert!(field.current(&reader,"a"),"old WAL snapshot must retain its identity");
        let fresh=Connection::open(&path).unwrap();
        fresh.execute_batch("BEGIN").unwrap();
        assert!(!field.current(&fresh,"a"),"new generation must reject old field");
        reader.execute_batch("ROLLBACK; BEGIN").unwrap();
        assert!(!field.current(&reader,"a"));
        drop(fresh); drop(separate); drop(reader); drop(writer); drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_cold_vectors_fail_without_publishing_bad_pool_entries() {
        for bytes in [vec![0_u8;4],vec![0_u8;12],
            [f32::NAN,0.0,0.0].iter().flat_map(|x|x.to_le_bytes()).collect()] {
            let (db,artifact)=fixture();
            let field=WarpedTagField::build(&db,"a",&artifact,3,Preset::Locked2).unwrap();
            db.execute("UPDATE tags SET vector=?1",[bytes]).unwrap();
            let mut pool=crate::storage::TagVectorPool::new();
            assert!(field.search(&db,&[0.3,0.8,0.4],0.425,10,&HashSet::new(),&mut pool).is_err());
            assert!(pool.is_empty());
        }
    }

    #[test]
    fn concurrent_invalidation_rejects_old_build_tickets_and_preserves_pinned_queries() {
        let (db,artifact)=fixture();
        let field=std::sync::Arc::new(WarpedTagField::build(&db,"a",&artifact,3,Preset::Locked2).unwrap());
        let runtime=crate::rivermemo_topology_v3::MemoRuntime::new();
        runtime.publish("a",std::sync::Arc::new(artifact)).unwrap();
        let old=runtime.warped_build_ticket();
        runtime.publish_warped_field(old,"a",field.clone()).unwrap();
        let barrier=std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker=scope.spawn(|| {
                barrier.wait();
                for _ in 0..100 { runtime.invalidate_warped_fields().unwrap(); }
            });
            barrier.wait();
            for _ in 0..100 {
                let pinned=runtime.warped_fields.read().unwrap().get(&Preset::Locked2).cloned();
                if let Some(pinned)=pinned { assert!(std::sync::Arc::ptr_eq(&pinned,&field)); }
            }
            worker.join().unwrap();
        });
        assert!(runtime.warped_fields.read().unwrap().is_empty());
        assert!(runtime.publish_warped_field(old,"a",field.clone()).is_err());
        assert_eq!(field.search(&db,&[0.3,0.8,0.4],0.425,10,&HashSet::new(),
            &mut crate::storage::TagVectorPool::new()).unwrap().0.len(),10);
        let fresh=runtime.warped_build_ticket();
        runtime.publish_warped_field(fresh,"a",field.clone()).unwrap();
        runtime.clear().unwrap();
        assert!(runtime.publish_warped_field(fresh,"a",field).is_err());
    }

    #[test]
    fn same_metadata_epa_replacement_is_rejected_without_version_trigger() {
        let (db,artifact)=fixture();
        let field=WarpedTagField::build(&db,"a",&artifact,3,Preset::Locked2).unwrap();
        assert!(field.current(&db,"a"));
        // Keep signatures and counters unchanged; full cache identity must still change.
        db.execute("UPDATE kv_store SET value=json_set(value,'$.extra',1)
            WHERE key='epa_basis_cache'",[]).unwrap();
        assert!(!field.current(&db,"a"));
        db.execute("DELETE FROM kv_store WHERE key='epa_basis_cache'",[]).unwrap();
        assert!(!field.current(&db,"a"));
    }

    #[test]
    fn epa_radius_is_bounded_and_missing_cache_restores_layer_schedule() {
        for level in 0..8 {
            let schedule=query_radius(RadiusStrategy::LayerSchedule,level,3,0.0,0.0,1.0,false);
            assert_eq!(schedule,query_radius(RadiusStrategy::EpaGuided,level,3,1.0,1.0,0.0,false));
            for (gate,logic,entropy) in [(0.0,0.0,1.0),(1.0,1.0,0.0),(f64::NAN,-1.0,2.0)] {
                let r=query_radius(RadiusStrategy::EpaGuided,level,3,gate,logic,entropy,true);
                assert!(r>=0.35_f32 && r<=0.65_f32);
            }
        }
    }
}
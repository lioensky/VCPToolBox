//! Short-lived, single-consumer handoff between geometry and graph construction.
use super::UnitVectorWorkspace;
use rusqlite::Connection;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const HANDOFF_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SnapshotKey {
    path: String,
    generation: u64,
    facts: String,
    model: String,
    dimension: usize,
}

impl SnapshotKey {
    pub(crate) fn capture(connection: &Connection, path: &str, model: &str, dimension: usize)
        -> Result<Self, String>
    {
        Ok(Self {
            path: crate::storage::normalized_path(path),
            generation: crate::storage::read_generation(connection)?,
            facts: connection.query_row(
                "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'", [], |row| row.get(0),
            ).map_err(|error| error.to_string())?,
            model: model.to_owned(),
            dimension,
        })
    }
}

pub(crate) struct PendingWorkspace {
    key: SnapshotKey,
    requested_ids: Vec<i64>,
    expires: Instant,
    workspace: UnitVectorWorkspace,
}

impl PendingWorkspace {
    pub(crate) fn reuse(self, key: &SnapshotKey, required_ids: &[i64]) -> Option<UnitVectorWorkspace> {
        // Requested IDs include invalid/absent vectors: absence must also come
        // from the same snapshot. Never infer coverage from valid mmap slots.
        if self.key == *key && Instant::now() < self.expires
            && required_ids.iter().all(|id| self.requested_ids.binary_search(id).is_ok())
        {
            Some(self.workspace)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct State {
    epoch: u64,
    pending: Option<PendingWorkspace>,
}

/// Owned by one registered storage instance, never by an artifact signature.
#[derive(Default)]
pub(crate) struct WorkspaceSlot {
    state: Mutex<State>,
    changed: Condvar,
}

impl WorkspaceSlot {
    #[cfg(test)]
    pub(crate) fn pending_path(&self) -> Option<std::path::PathBuf> {
        self.state.lock().unwrap().pending.as_ref().map(|entry| entry.workspace.path.clone())
    }

    pub(crate) fn begin(self: &Arc<Self>) -> WorkspaceLease {
        let (epoch, previous) = {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            state.epoch += 1;
            (state.epoch, state.pending.take())
        };
        self.changed.notify_all();
        drop(previous);
        WorkspaceLease { slot: self.clone(), epoch, offered: false }
    }

    pub(crate) fn clear(&self) {
        let previous = {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            state.epoch += 1;
            state.pending.take()
        };
        self.changed.notify_all();
        drop(previous);
    }

    pub(crate) fn take(&self) -> Option<PendingWorkspace> {
        let pending = {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            state.epoch += 1;
            state.pending.take()
        };
        self.changed.notify_all();
        pending.filter(|entry| Instant::now() < entry.expires)
    }

    fn discard_epoch(&self, epoch: u64) {
        let previous = {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.epoch != epoch { return; }
            state.epoch += 1;
            state.pending.take()
        };
        self.changed.notify_all();
        drop(previous);
    }
}

pub(crate) struct WorkspaceLease {
    slot: Arc<WorkspaceSlot>,
    epoch: u64,
    offered: bool,
}

impl WorkspaceLease {
    pub(crate) fn offer(self, key: SnapshotKey, ids: Vec<i64>, workspace: UnitVectorWorkspace) {
        self.offer_with_ttl(key, ids, workspace, HANDOFF_TTL);
    }

    fn offer_with_ttl(mut self, key: SnapshotKey, mut ids: Vec<i64>, workspace: UnitVectorWorkspace, ttl: Duration) {
        ids.sort_unstable();
        ids.dedup();
        let expires = Instant::now() + ttl;
        {
            let mut state = self.slot.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.epoch != self.epoch { return; }
            state.pending = Some(PendingWorkspace { key, requested_ids: ids, expires, workspace });
        }
        self.offered = true;
        let weak = Arc::downgrade(&self.slot);
        let epoch = self.epoch;
        // A real timer deletes an abandoned file without requiring another API
        // call. Claim/replace/shutdown wakes the timer so it exits immediately.
        if std::thread::Builder::new().name("memo-workspace-expiry".into()).spawn(move || {
            let Some(slot) = weak.upgrade() else { return; };
            let state = slot.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let (mut state, _) = slot.changed.wait_timeout_while(
                state, expires.saturating_duration_since(Instant::now()),
                |state| state.epoch == epoch && state.pending.is_some(),
            ).unwrap_or_else(std::sync::PoisonError::into_inner);
            let expired = if state.epoch == epoch {
                state.epoch += 1;
                state.pending.take()
            } else { None };
            drop(state);
            drop(expired);
        }).is_err() {
            // A handoff without a functioning expiry timer is not retained.
            self.slot.discard_epoch(self.epoch);
        }
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        if !self.offered { self.slot.discard_epoch(self.epoch); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Connection, SnapshotKey) {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);
             INSERT INTO tags VALUES (1,X'0000803F00000080'),(2,zeroblob(8)),(3,X'000000000000803F');
             CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('database_generation','7'),('memo_tag_facts','11');"
        ).unwrap();
        let key = SnapshotKey::capture(&connection, "handoff-test.sqlite", "model", 2).unwrap();
        (connection, key)
    }

    fn offer(slot: &Arc<WorkspaceSlot>, connection: &Connection, key: &SnapshotKey) -> std::path::PathBuf {
        let workspace = UnitVectorWorkspace::build(connection, &[1,2,3], 2).unwrap();
        let path = workspace.path.clone();
        slot.begin().offer(key.clone(), vec![1,2,3], workspace);
        path
    }

    #[test]
    fn handoff_preserves_bits_absence_and_single_consumption() {
        let (connection, key) = fixture();
        let slot = Arc::new(WorkspaceSlot::default());
        let path = offer(&slot, &connection, &key);
        let workspace = slot.take().unwrap().reuse(&key, &[3,2,1]).unwrap();
        assert!(slot.take().is_none());
        assert!(workspace.get(&2).is_none());
        let fresh = UnitVectorWorkspace::build(&connection, &[3,2,1], 2).unwrap();
        for id in [1,3] {
            assert_eq!(workspace.get(&id).unwrap().iter().map(|v|v.to_bits()).collect::<Vec<_>>(),
                       fresh.get(&id).unwrap().iter().map(|v|v.to_bits()).collect::<Vec<_>>());
        }
        #[cfg(windows)]
        assert!(path.exists());
        drop(workspace);
        assert!(!path.exists());
    }

    #[test]
    fn handoff_rejects_every_snapshot_mismatch_and_uncovered_id() {
        let (connection, key) = fixture();
        let slot = Arc::new(WorkspaceSlot::default());
        let mut keys = vec![key.clone(); 5];
        keys[0].path.push('x'); keys[1].generation += 1; keys[2].facts.push('x');
        keys[3].model.push('x'); keys[4].dimension += 1;
        for changed in keys {
            let path = offer(&slot, &connection, &key);
            assert!(slot.take().unwrap().reuse(&changed, &[1]).is_none());
            assert!(!path.exists());
        }
        let path = offer(&slot, &connection, &key);
        assert!(slot.take().unwrap().reuse(&key, &[4]).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn handoff_replacement_errors_shutdown_and_libraries_release_files() {
        let (connection, key) = fixture();
        let a = Arc::new(WorkspaceSlot::default());
        let b = Arc::new(WorkspaceSlot::default());
        let path_a = offer(&a, &connection, &key);
        let path_b = offer(&b, &connection, &key);
        let failed_geometry = a.begin();
        assert!(!path_a.exists());
        #[cfg(windows)]
        assert!(path_b.exists());
        drop(failed_geometry);
        assert!(a.take().is_none());
        // An error after claim (including invalid graph JSON) drops the owner.
        let claimed = b.take().unwrap();
        drop(claimed);
        assert!(!path_b.exists());
        let path = offer(&a, &connection, &key);
        a.clear();
        assert!(!path.exists());
        let old_geometry = a.begin();
        a.clear();
        let workspace = UnitVectorWorkspace::build(&connection, &[1], 2).unwrap();
        let path = workspace.path.clone();
        old_geometry.offer(key, vec![1], workspace);
        assert!(!path.exists());
        assert!(a.take().is_none());
    }

    #[test]
    fn handoff_old_completion_cannot_replace_new_geometry() {
        let (connection, key) = fixture();
        let slot = Arc::new(WorkspaceSlot::default());
        let old = slot.begin();
        let new_path = offer(&slot, &connection, &key);
        let workspace = UnitVectorWorkspace::build(&connection, &[1], 2).unwrap();
        let old_path = workspace.path.clone();
        old.offer(key.clone(), vec![1], workspace);
        assert!(!old_path.exists());
        #[cfg(windows)]
        assert!(new_path.exists());
        drop(slot.take().unwrap().reuse(&key, &[3]).unwrap());
        assert!(!new_path.exists());
    }

    #[test]
    fn handoff_timeout_deletes_without_another_call() {
        let (connection, key) = fixture();
        let slot = Arc::new(WorkspaceSlot::default());
        let workspace = UnitVectorWorkspace::build(&connection, &[1], 2).unwrap();
        let path = workspace.path.clone();
        slot.begin().offer_with_ttl(key, vec![1], workspace, Duration::from_millis(20));
        let deadline = Instant::now() + Duration::from_secs(2);
        // The expiry thread takes the owner under the mutex, then drops it
        // outside the mutex. An empty slot alone is not a completed file drop.
        while (slot.pending_path().is_some() || path.exists()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(slot.pending_path().is_none(), "expiry must not require a consuming API call");
        assert!(!path.exists());
        assert!(slot.take().is_none());
    }

    #[test]
    fn handoff_exit_child() {
        let Some(marker) = std::env::var_os("VCP_WORKSPACE_EXIT_TEST_MARKER") else { return; };
        let (connection, _) = fixture();
        let workspace = UnitVectorWorkspace::build(&connection, &[1,3], 2).unwrap();
        std::fs::write(marker, workspace.path.to_string_lossy().as_bytes()).unwrap();
        if std::env::var("VCP_WORKSPACE_EXIT_TEST_MODE").unwrap() == "exit" {
            std::process::exit(0);
        }
        loop { std::thread::park_timeout(Duration::from_secs(1)); }
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn handoff_process_exit_and_kill_leave_no_file() {
        use std::process::{Child, Command, Stdio};
        struct Reap(Child);
        impl Drop for Reap {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("memo-exit-{}-{nonce}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for mode in ["exit", "kill"] {
            let marker = root.join(mode);
            let mut child = Reap(Command::new(std::env::current_exe().unwrap())
                .args(["--exact","memo_geometry::workspace::tests::handoff_exit_child","--nocapture"])
                .env("VCP_WORKSPACE_EXIT_TEST_MARKER",&marker)
                .env("VCP_WORKSPACE_EXIT_TEST_MODE",mode)
                .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
            let deadline = Instant::now() + Duration::from_secs(5);
            while std::fs::metadata(&marker).map_or(true, |metadata| metadata.len() == 0)
                && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
            assert!(std::fs::metadata(&marker).is_ok_and(|metadata| metadata.len() > 0), "child did not create its workspace");
            if mode == "kill" { child.0.kill().unwrap(); }
            let status = child.0.wait().unwrap();
            if mode == "exit" { assert!(status.success()); }
            let path = std::path::PathBuf::from(std::fs::read_to_string(&marker).unwrap());
            assert!(!path.exists(), "OS must reclaim workspace even without Rust destructors");
        }
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
}

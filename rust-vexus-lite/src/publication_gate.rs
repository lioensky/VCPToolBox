use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};

#[derive(Default)]
struct Gate {
    active: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Default)]
struct GateState {
    held: Vec<(Vec<String>, bool)>,
    waiting: Vec<(u64, Vec<String>, bool)>,
    sequence: u64,
}

pub(crate) struct PublicationGuard {
    gate: Arc<Gate>,
    scopes: Vec<String>,
    exclusive: bool,
}

fn overlaps(left: &[String], right: &[String]) -> bool {
    left.iter().any(|scope| scope == "*")
        || right.iter().any(|scope| scope == "*")
        || left.iter().any(|scope| right.contains(scope))
}

/// 一次性申请全部作用域，避免多作用域请求反序逐锁死锁。
/// 通配请求用于跨作用域事实事务；互不相交的检查点与查询无需互相等待。
pub(crate) fn acquire(db_path: &str, scopes: &[String]) -> Result<PublicationGuard, String> {
    acquire_mode(db_path, scopes, true)
}

pub(crate) fn acquire_read(db_path: &str, scopes: &[String]) -> Result<PublicationGuard, String> {
    acquire_mode(db_path, scopes, false)
}

fn acquire_mode(db_path: &str, scopes: &[String], exclusive: bool) -> Result<PublicationGuard, String> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Weak<Gate>>>> = OnceLock::new();
    let identity = crate::storage::normalized_path(db_path);
    let gate = {
        let mut registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new())).lock()
            .map_err(|_| "Publication gate registry poisoned".to_string())?;
        registry.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = registry.get(&identity).and_then(Weak::upgrade) {
            gate
        } else {
            let gate = Arc::new(Gate::default());
            registry.insert(identity, Arc::downgrade(&gate));
            gate
        }
    };
    let mut scopes = scopes.to_vec();
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        scopes.push("*".to_string());
    }
    let mut active = gate.active.lock().map_err(|_| "Publication gate poisoned".to_string())?;
    let ticket = active.sequence;
    active.sequence = active.sequence.wrapping_add(1);
    active.waiting.push((ticket, scopes.clone(), exclusive));
    loop {
        let blocked = active.held.iter().any(|(held, held_exclusive)|
            (exclusive || *held_exclusive) && overlaps(held, &scopes))
            || active.waiting.iter().take_while(|(id, _, _)| *id != ticket)
                .any(|(_, earlier, earlier_exclusive)|
                    (exclusive || *earlier_exclusive) && overlaps(earlier, &scopes));
        if !blocked { break; }
        active = gate.changed.wait(active).map_err(|_| "Publication gate poisoned".to_string())?;
    }
    active.waiting.retain(|(id, _, _)| *id != ticket);
    active.held.push((scopes.clone(), exclusive));
    drop(active);
    Ok(PublicationGuard { gate, scopes, exclusive })
}

impl PublicationGuard {
    /// 不释放作用域即可进入共享查询阶段，写入者无法穿插在准备与读取之间。
    pub(crate) fn downgrade(&mut self) -> Result<(), String> {
        if !self.exclusive {
            return Ok(());
        }
        let mut active = self.gate.active.lock()
            .map_err(|_| "Publication gate poisoned".to_string())?;
        if let Some((_, exclusive)) = active.held.iter_mut()
            .find(|(held, exclusive)| *held == self.scopes && *exclusive)
        {
            *exclusive = false;
            self.exclusive = false;
        }
        self.gate.changed.notify_all();
        Ok(())
    }
}

impl Drop for PublicationGuard {
    fn drop(&mut self) {
        let mut active = self.gate.active.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(position) = active.held.iter().position(|(held, exclusive)| *held == self.scopes && *exclusive == self.exclusive) {
            active.held.swap_remove(position);
        }
        self.gate.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_readers_coexist_and_exclude_writer() {
        let scopes = ["diary:shared".to_string()];
        let mut first = acquire("shared-read-test.sqlite", &scopes).unwrap();
        first.downgrade().unwrap();
        let second = acquire_read("shared-read-test.sqlite", &scopes).unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _writer = acquire("shared-read-test.sqlite", &scopes).unwrap();
            sent.send(()).unwrap();
        });
        assert!(received.recv_timeout(std::time::Duration::from_millis(25)).is_err());
        drop(first);
        assert!(received.recv_timeout(std::time::Duration::from_millis(25)).is_err());
        drop(second);
        received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn disjoint_scopes_and_databases_do_not_block_each_other() {
        let _first = acquire("scope-test.sqlite", &["diary:a".into()]).unwrap();
        let _second = acquire("scope-test.sqlite", &["diary:b".into()]).unwrap();
        let _other = acquire("other-store.sqlite", &["*".into()]).unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _all = acquire("scope-test.sqlite", &["*".into()]).unwrap();
            sent.send(()).unwrap();
        });
        assert!(received.recv_timeout(std::time::Duration::from_millis(25)).is_err());
        drop(_first);
        assert!(received.recv_timeout(std::time::Duration::from_millis(25)).is_err());
        drop(_second);
        received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
    }
}
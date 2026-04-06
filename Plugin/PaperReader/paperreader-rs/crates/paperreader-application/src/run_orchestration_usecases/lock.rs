use super::super::*;

const RUN_STATE_LOCK_RETRY_LIMIT: usize = 500;
const RUN_STATE_LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);
const RUN_STATE_LOCK_STALE_AFTER: Duration = Duration::from_secs(30);

struct RunStateLockGuard {
    lock_path: PathBuf,
}

impl RunStateLockGuard {
    fn acquire(run_paths: &RunArtifactPaths) -> Result<Self> {
        let lock_path = run_state_lock_path(run_paths);
        for _ in 0..RUN_STATE_LOCK_RETRY_LIMIT {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut lock_file) => {
                    writeln!(
                        lock_file,
                        "pid={} acquired_at={}",
                        std::process::id(),
                        chrono::Utc::now().to_rfc3339()
                    )?;
                    drop(lock_file);
                    return Ok(Self { lock_path });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if is_stale_run_state_lock(&lock_path) {
                        let _ = std::fs::remove_file(&lock_path);
                        continue;
                    }
                    thread::sleep(RUN_STATE_LOCK_RETRY_DELAY);
                }
                Err(error) => return Err(error.into()),
            }
        }

        anyhow::bail!(
            "timed out acquiring run-state lock for {}",
            display_path(&run_paths.run_state)
        );
    }
}

impl Drop for RunStateLockGuard {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.lock_path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
}

fn run_state_lock_path(run_paths: &RunArtifactPaths) -> PathBuf {
    match run_paths
        .run_state
        .extension()
        .and_then(|value| value.to_str())
    {
        Some(extension) => run_paths
            .run_state
            .with_extension(format!("{extension}.lock")),
        None => run_paths.run_state.with_extension("lock"),
    }
}

fn is_stale_run_state_lock(lock_path: &Path) -> bool {
    std::fs::metadata(lock_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified_at| modified_at.elapsed().ok())
        .map(|elapsed| elapsed > RUN_STATE_LOCK_STALE_AFTER)
        .unwrap_or(false)
}

pub(super) fn read_run_state_locked(
    repo: &WorkspaceRepository,
    run_paths: &RunArtifactPaths,
) -> Result<RunState> {
    let _guard = RunStateLockGuard::acquire(run_paths)?;
    repo.read_json(&run_paths.run_state)
}

pub(super) fn mutate_run_state_locked<T>(
    repo: &WorkspaceRepository,
    run_paths: &RunArtifactPaths,
    update: impl FnOnce(&mut RunState) -> Result<T>,
) -> Result<(RunState, T)> {
    let _guard = RunStateLockGuard::acquire(run_paths)?;
    let mut run_state: RunState = repo.read_json(&run_paths.run_state)?;
    let result = update(&mut run_state)?;
    repo.write_json(&run_paths.run_state, &run_state)?;
    Ok((run_state, result))
}

pub(crate) fn mutate_run_state_if_active<T>(
    repo: &WorkspaceRepository,
    run_paths: &RunArtifactPaths,
    update: impl FnOnce(&mut RunState) -> Result<T>,
) -> Result<Option<(RunState, T)>> {
    let _guard = RunStateLockGuard::acquire(run_paths)?;
    let mut run_state: RunState = repo.read_json(&run_paths.run_state)?;
    if matches!(run_state.status, RunStatus::Aborted) {
        return Ok(None);
    }
    let result = update(&mut run_state)?;
    repo.write_json(&run_paths.run_state, &run_state)?;
    Ok(Some((run_state, result)))
}

use crate::schema;
use napi::bindgen_prelude::Result as NapiResult;
use napi::Error as NapiError;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

pub(crate) const MEMO_ARTIFACT_DEPENDENCIES: &[&str] = &["memo_tag_facts", "derived_geometry"];

const DEFAULT_READ_POOL_SIZE: usize = 4;
const MIN_READ_POOL_SIZE: usize = 2;
const MAX_READ_POOL_SIZE: usize = 8;
const BUSY_TIMEOUT_MS: u64 = 30_000;
const READ_CACHE_SIZE_KIB: i64 = -16_384;
const DEFAULT_MMAP_SIZE: i64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct StorageOptions {
    pub(crate) read_pool_size: usize,
    pub(crate) mmap_size: i64,
    pub(crate) busy_timeout_ms: u64,
    pub(crate) schema_version: i64,
}

impl Default for StorageOptions {
    fn default() -> Self {
        Self {
            read_pool_size: DEFAULT_READ_POOL_SIZE,
            mmap_size: DEFAULT_MMAP_SIZE,
            busy_timeout_ms: BUSY_TIMEOUT_MS,
            schema_version: 2,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StoreReady {
    pub(crate) db_path: String,
    pub(crate) schema_version: i64,
    pub(crate) database_generation: u64,
}

type WriteResult = Result<WriteReceipt, String>;
type WriteOperation = Box<dyn FnOnce(&Transaction<'_>) -> WriteResult + Send + 'static>;

struct WriteCommand {
    operation: WriteOperation,
    response: mpsc::Sender<WriteResult>,
}

#[derive(Debug, Clone)]
pub(crate) struct WriteReceipt {
    pub(crate) operation: String,
    pub(crate) database_generation: u64,
    pub(crate) facts_changed: bool,
}

struct LifecycleState {
    accepting: bool,
    active_reads: usize,
    active_writes: usize,
}

struct StorageInner {
    db_path: PathBuf,
    read_pool: Mutex<Vec<Connection>>,
    read_pool_changed: Condvar,
    write_sender: Mutex<Option<mpsc::SyncSender<WriteCommand>>>,
    writer_thread: Mutex<Option<thread::JoinHandle<()>>>,
    lifecycle: Mutex<LifecycleState>,
    lifecycle_changed: Condvar,
    closed: AtomicBool,
    shutdown_complete: AtomicBool,
    shutdown_result: Mutex<Option<Result<(), String>>>,
    database_generation: AtomicU64,
    schema_version: i64,
}

#[derive(Clone)]
pub(crate) struct SqliteStorageEngine {
    inner: Arc<StorageInner>,
}

static STORAGE_REGISTRY: OnceLock<Mutex<HashMap<String, SqliteStorageEngine>>> = OnceLock::new();

fn storage_registry() -> &'static Mutex<HashMap<String, SqliteStorageEngine>> {
    STORAGE_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn normalized_path(path: impl AsRef<Path>) -> String {
    let absolute = if path.as_ref().is_absolute() {
        path.as_ref().to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path.as_ref())
    };
    let normalized = std::fs::canonicalize(&absolute)
        .unwrap_or(absolute)
        .to_string_lossy()
        .replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        return normalized.to_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    {
        normalized
    }
}

pub(crate) fn register_storage(
    path: impl AsRef<Path>,
    storage: SqliteStorageEngine,
) -> Result<(), String> {
    let key = normalized_path(path);
    let mut registry = storage_registry()
        .lock()
        .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?;
    if registry.contains_key(&key) {
        return Err(format!("KNOWLEDGE_STORE_ALREADY_REGISTERED:{}", key));
    }
    registry.insert(key, storage);
    Ok(())
}

fn unregister_storage_if_same(
    path: impl AsRef<Path>,
    expected: &SqliteStorageEngine,
) -> Result<(), String> {
    let key = normalized_path(path);
    let mut registry = storage_registry()
        .lock()
        .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?;
    let should_remove = registry
        .get(&key)
        .map(|registered| Arc::ptr_eq(&registered.inner, &expected.inner))
        .unwrap_or(false);
    if should_remove {
        registry.remove(&key);
    }
    Ok(())
}

pub(crate) fn with_registered_read<T, F>(path: impl AsRef<Path>, operation: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let storage = storage_registry()
        .lock()
        .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?
        .get(&normalized_path(path))
        .cloned()
        .ok_or_else(|| "KNOWLEDGE_STORE_NOT_REGISTERED".to_string())?;
    storage.read(operation)
}

pub(crate) fn with_registered_read_transaction<T, F>(
    path: impl AsRef<Path>,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let storage = storage_registry()
        .lock()
        .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?
        .get(&normalized_path(path))
        .cloned()
        .ok_or_else(|| "KNOWLEDGE_STORE_NOT_REGISTERED".to_string())?;

    storage.read(|connection| {
        // RAII 保证错误返回和 panic 展开时均先回滚，再将连接归还 Read Pool。
        let transaction = connection.unchecked_transaction()
            .map_err(|error| format!("begin SQLite read transaction failed: {}", error))?;
        let value = operation(&transaction)?;
        transaction.commit()
            .map_err(|error| format!("commit SQLite read transaction failed: {}", error))?;
        Ok(value)
    })
}

pub(crate) fn with_registered_read_transaction_napi<T, F>(
    path: impl AsRef<Path>, operation: F,
) -> NapiResult<T>
where
    F: FnOnce(&Connection) -> NapiResult<T>,
{
    with_registered_read_transaction(path, |connection| {
        operation(connection).map_err(|error| error.reason)
    }).map_err(NapiError::from_reason)
}

pub(crate) fn with_registered_read_napi<T, F>(path: impl AsRef<Path>, operation: F) -> NapiResult<T>
where
    F: FnOnce(&Connection) -> NapiResult<T>,
{
    let storage = storage_registry()
        .lock()
        .map_err(|_| NapiError::from_reason("KNOWLEDGE_STORE_REGISTRY_POISONED".to_string()))?
        .get(&normalized_path(path))
        .cloned()
        .ok_or_else(|| NapiError::from_reason("KNOWLEDGE_STORE_NOT_REGISTERED".to_string()))?;

    storage
        .read(|connection| operation(connection).map_err(|error| error.reason.clone()))
        .map_err(NapiError::from_reason)
}

pub(crate) fn with_registered_write<F>(
    path: impl AsRef<Path>,
    operation: F,
) -> Result<WriteReceipt, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> WriteResult + Send + 'static,
{
    let storage = storage_registry()
        .lock()
        .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?
        .get(&normalized_path(path))
        .cloned()
        .ok_or_else(|| "KNOWLEDGE_STORE_NOT_REGISTERED".to_string())?;
    storage.submit_write(operation)
}

impl SqliteStorageEngine {
    pub(crate) fn open_and_init(
        db_path: impl AsRef<Path>,
        options: StorageOptions,
    ) -> Result<(Self, StoreReady), String> {
        static OPEN_GATE: OnceLock<Mutex<()>> = OnceLock::new();
        let _open_guard = OPEN_GATE.get_or_init(|| Mutex::new(())).lock()
            .map_err(|_| "KNOWLEDGE_STORE_OPEN_GATE_POISONED".to_string())?;
        let db_path = db_path.as_ref().to_path_buf();
        if storage_registry().lock()
            .map_err(|_| "KNOWLEDGE_STORE_REGISTRY_POISONED".to_string())?
            .contains_key(&normalized_path(&db_path))
        {
            return Err("KNOWLEDGE_STORE_ALREADY_REGISTERED".to_string());
        }
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create SQLite directory failed: {}", error))?;
        }

        match Self::open_and_init_once(&db_path, &options) {
            Ok(result) => Ok(result),
            Err(error) if is_corruption_error(&error) => {
                quarantine_database(&db_path)?;
                Self::open_and_init_once(&db_path, &options).map_err(|retry_error| {
                    format!(
                        "SQLite recovery rebuild failed after quarantining database: {}",
                        retry_error
                    )
                })
            }
            Err(error) => Err(error),
        }
    }

    fn open_and_init_once(
        db_path: &Path,
        options: &StorageOptions,
    ) -> Result<(Self, StoreReady), String> {
        let mut writer = open_writer_connection(
            db_path,
            options.mmap_size,
            options.busy_timeout_ms,
        )?;
        initialize_schema_metadata(&mut writer, options.schema_version)?;
        let actual_schema_version = schema::initialize_schema(&writer, options.schema_version)?;
        quick_check(&writer)?;

        let generation = read_generation(&writer)?;
        let pool_size = options
            .read_pool_size
            .clamp(MIN_READ_POOL_SIZE, MAX_READ_POOL_SIZE);
        let mut read_pool = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            read_pool.push(open_read_connection(
                db_path,
                options.mmap_size,
                options.busy_timeout_ms,
            )?);
        }

        let (sender, receiver) = mpsc::sync_channel::<WriteCommand>(128);
        let thread_generation = Arc::new(AtomicU64::new(generation));
        let thread_generation_ref = Arc::clone(&thread_generation);
        let writer_thread = thread::Builder::new()
            .name("kbm-sqlite-write-actor".to_string())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    let result = execute_write_command(
                        &mut writer,
                        command.operation,
                        &thread_generation_ref,
                    );
                    let _ = command.response.send(result);
                }
            })
            .map_err(|error| format!("spawn SQLite Write Actor failed: {}", error))?;

        let inner = Arc::new(StorageInner {
            db_path: db_path.to_path_buf(),
            read_pool: Mutex::new(read_pool),
            read_pool_changed: Condvar::new(),
            write_sender: Mutex::new(Some(sender)),
            writer_thread: Mutex::new(Some(writer_thread)),
            lifecycle: Mutex::new(LifecycleState {
                accepting: true,
                active_reads: 0,
                active_writes: 0,
            }),
            lifecycle_changed: Condvar::new(),
            closed: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            shutdown_result: Mutex::new(None),
            database_generation: AtomicU64::new(generation),
            schema_version: actual_schema_version,
        });

        let engine = Self { inner };
        if let Err(error) = register_storage(db_path, engine.clone()) {
            let _ = engine.shutdown();
            return Err(error);
        }
        let ready = StoreReady {
            db_path: db_path.to_string_lossy().replace('\\', "/"),
            schema_version: actual_schema_version,
            database_generation: generation,
        };
        Ok((engine, ready))
    }

    pub(crate) fn db_path(&self) -> &Path {
        &self.inner.db_path
    }

    pub(crate) fn read<T, F>(&self, operation: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        {
            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            if !lifecycle.accepting || self.inner.closed.load(Ordering::Acquire) {
                return Err("KNOWLEDGE_STORE_CLOSED".to_string());
            }
            lifecycle.active_reads = lifecycle.active_reads.saturating_add(1);
        }

        let mut pool = self
            .inner
            .read_pool
            .lock()
            .map_err(|_| {
                self.release_read_slot();
                "KNOWLEDGE_STORE_READ_POOL_POISONED".to_string()
            })?;

        loop {
            if let Some(connection) = pool.pop() {
                drop(pool);
                let guard = ReadConnectionGuard {
                    storage: self.clone(),
                    connection: Some(connection),
                };
                return operation(guard.connection());
            }

            if self.inner.closed.load(Ordering::Acquire) {
                drop(pool);
                self.release_read_slot();
                return Err("KNOWLEDGE_STORE_CLOSED".to_string());
            }

            let lifecycle = match self.inner.lifecycle.lock() {
                Ok(lifecycle) => lifecycle,
                Err(_) => {
                    drop(pool);
                    self.release_read_slot();
                    return Err("KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string());
                }
            };
            if !lifecycle.accepting {
                drop(lifecycle);
                drop(pool);
                self.release_read_slot();
                return Err("KNOWLEDGE_STORE_CLOSED".to_string());
            }
            drop(lifecycle);

            pool = match self.inner.read_pool_changed.wait(pool) {
                Ok(pool) => pool,
                Err(_) => {
                    self.release_read_slot();
                    return Err("KNOWLEDGE_STORE_READ_POOL_POISONED".to_string());
                }
            };
        }
    }

    fn release_read_slot(&self) {
        if let Ok(mut lifecycle) = self.inner.lifecycle.lock() {
            lifecycle.active_reads = lifecycle.active_reads.saturating_sub(1);
            self.inner.lifecycle_changed.notify_all();
        }
    }

    pub(crate) fn submit_write<F>(&self, operation: F) -> Result<WriteReceipt, String>
    where
        F: FnOnce(&Transaction<'_>) -> WriteResult + Send + 'static,
    {
        let (response_sender, response_receiver) = mpsc::channel();
        let command = WriteCommand {
            operation: Box::new(operation),
            response: response_sender,
        };

        {
            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            if !lifecycle.accepting || self.inner.closed.load(Ordering::Acquire) {
                return Err("KNOWLEDGE_STORE_CLOSED".to_string());
            }
            lifecycle.active_writes = lifecycle.active_writes.saturating_add(1);
        }
        let admission = WriteAdmission {
            storage: self.clone(),
        };

        let sender = self
            .inner
            .write_sender
            .lock()
            .map_err(|_| "KNOWLEDGE_STORE_WRITE_QUEUE_POISONED".to_string())?
            .as_ref()
            .cloned()
            .ok_or_else(|| "KNOWLEDGE_STORE_CLOSED".to_string())?;

        sender
            .send(command)
            .map_err(|_| "KNOWLEDGE_STORE_WRITE_ACTOR_STOPPED".to_string())?;
        let receipt = response_receiver
            .recv()
            .map_err(|_| "KNOWLEDGE_STORE_WRITE_ACTOR_STOPPED".to_string())??;

        let mut observed = self.inner.database_generation.load(Ordering::Acquire);
        while receipt.database_generation > observed {
            match self.inner.database_generation.compare_exchange(
                observed,
                receipt.database_generation,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => observed = actual,
            }
        }
        drop(admission);
        Ok(receipt)
    }

    pub(crate) fn database_generation(&self) -> u64 {
        self.inner.database_generation.load(Ordering::Acquire)
    }

    pub(crate) fn schema_version(&self) -> i64 {
        self.inner.schema_version
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            while !self.inner.shutdown_complete.load(Ordering::Acquire) {
                lifecycle = self
                    .inner
                    .lifecycle_changed
                    .wait(lifecycle)
                    .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            }
            drop(lifecycle);
            return self
                .inner
                .shutdown_result
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_SHUTDOWN_RESULT_POISONED".to_string())?
                .clone()
                .unwrap_or_else(|| Err("KNOWLEDGE_STORE_SHUTDOWN_INCOMPLETE".to_string()));
        }

        let result = (|| {
            {
                let mut lifecycle = self
                    .inner
                    .lifecycle
                    .lock()
                    .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
                lifecycle.accepting = false;
                self.inner.read_pool_changed.notify_all();
            }

            // 先关闭队列入口，让已接纳的命令排空后退出 Writer Actor；不能先等待
            // active_writes，否则满队列上的发送者会与关闭线程互相等待。
            let sender = self
                .inner
                .write_sender
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_WRITE_QUEUE_POISONED".to_string())?
                .take();
            drop(sender);

            if let Some(thread) = self
                .inner
                .writer_thread
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_WRITER_THREAD_POISONED".to_string())?
                .take()
            {
                thread
                    .join()
                    .map_err(|_| "KNOWLEDGE_STORE_WRITE_ACTOR_PANICKED".to_string())?;
            }

            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            while lifecycle.active_reads > 0 || lifecycle.active_writes > 0 {
                lifecycle = self
                    .inner
                    .lifecycle_changed
                    .wait(lifecycle)
                    .map_err(|_| "KNOWLEDGE_STORE_LIFECYCLE_POISONED".to_string())?;
            }
            drop(lifecycle);

            unregister_storage_if_same(&self.inner.db_path, self)?;
            self.inner
                .read_pool
                .lock()
                .map_err(|_| "KNOWLEDGE_STORE_READ_POOL_POISONED".to_string())?
                .clear();
            Ok(())
        })();

        if let Ok(mut shutdown_result) = self.inner.shutdown_result.lock() {
            *shutdown_result = Some(result.clone());
        }
        // 和等待方使用相同的互斥锁发布完成状态，避免检查条件与 wait
        // 之间丢失 notify，导致第二个 shutdown 调用永久等待。
        let _lifecycle = self.inner.lifecycle.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.inner.shutdown_complete.store(true, Ordering::Release);
        self.inner.lifecycle_changed.notify_all();
        result
    }
}

struct WriteAdmission {
    storage: SqliteStorageEngine,
}

impl Drop for WriteAdmission {
    fn drop(&mut self) {
        if let Ok(mut lifecycle) = self.storage.inner.lifecycle.lock() {
            lifecycle.active_writes = lifecycle.active_writes.saturating_sub(1);
            self.storage.inner.lifecycle_changed.notify_all();
        }
    }
}

struct ReadConnectionGuard {
    storage: SqliteStorageEngine,
    connection: Option<Connection>,
}

impl ReadConnectionGuard {
    fn connection(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("read connection guard must own a connection")
    }
}

impl Drop for ReadConnectionGuard {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            if let Ok(mut pool) = self.storage.inner.read_pool.lock() {
                pool.push(connection);
                self.storage.inner.read_pool_changed.notify_one();
            }
        }
        self.storage.release_read_slot();
        self.storage.inner.read_pool_changed.notify_all();
    }
}

fn open_writer_connection(
    path: &Path,
    mmap_size: i64,
    busy_timeout_ms: u64,
) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| format!("open SQLite writer failed: {}", error))?;
    configure_connection(&connection, false, mmap_size, busy_timeout_ms)?;
    Ok(connection)
}

fn open_read_connection(
    path: &Path,
    mmap_size: i64,
    busy_timeout_ms: u64,
) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open SQLite read connection failed: {}", error))?;
    configure_connection(&connection, true, mmap_size, busy_timeout_ms)?;
    Ok(connection)
}

fn configure_connection(
    connection: &Connection,
    readonly: bool,
    mmap_size: i64,
    busy_timeout_ms: u64,
) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_millis(busy_timeout_ms))
        .map_err(|error| format!("configure SQLite busy timeout failed: {}", error))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("configure SQLite foreign keys failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", if readonly { "ON" } else { "OFF" })
        .map_err(|error| format!("configure SQLite query_only failed: {}", error))?;
    connection
        .pragma_update(None, "cache_size", READ_CACHE_SIZE_KIB)
        .map_err(|error| format!("configure SQLite cache size failed: {}", error))?;
    connection
        .pragma_update(None, "mmap_size", mmap_size)
        .map_err(|error| format!("configure SQLite mmap size failed: {}", error))?;

    if !readonly {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("configure SQLite WAL failed: {}", error))?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| format!("configure SQLite synchronous mode failed: {}", error))?;
    }
    Ok(())
}

fn initialize_schema_metadata(
    connection: &mut Connection,
    schema_version: i64,
) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS kbm_runtime_meta (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("initialize KBM runtime metadata failed: {}", error))?;

    let existing: Option<i64> = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read KBM schema version failed: {}", error))?;

    if existing.is_none() {
        connection
            .execute(
                "INSERT INTO kbm_runtime_meta(key, value) VALUES ('schema_version', ?1)",
                [schema_version.to_string()],
            )
            .map_err(|error| format!("write KBM schema version failed: {}", error))?;
    }

    connection
        .execute(
            "INSERT OR IGNORE INTO kbm_runtime_meta(key, value) VALUES ('database_generation', '0')",
            [],
        )
        .map_err(|error| format!("initialize KBM database generation failed: {}", error))?;
    Ok(())
}

pub(crate) fn read_generation(connection: &Connection) -> Result<u64, String> {
    let value: String = connection
        .query_row(
            "SELECT value FROM kbm_runtime_meta WHERE key = 'database_generation'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read KBM database generation failed: {}", error))?;
    value
        .parse::<u64>()
        .map_err(|error| format!("invalid KBM database generation: {}", error))
}
pub(crate) fn ensure_generation(connection: &Connection, expected: u64) -> Result<(), String> {
    let current = read_generation(connection)?;
    if current != expected {
        return Err(format!(
            "KNOWLEDGE_STORE_DERIVED_GENERATION_CONFLICT: expected={}, current={}",
            expected, current
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DerivedDependencies(Vec<(String, u64)>);

impl DerivedDependencies {
    pub(crate) fn capture(connection: &Connection, keys: &[&str]) -> Result<Self, String> {
        let mut values = Vec::with_capacity(keys.len());
        for key in keys {
            let raw: String = connection.query_row(
                "SELECT value FROM kbm_runtime_meta WHERE key=?1", [key], |row| row.get(0),
            ).map_err(|error| format!("Read derived dependency {} failed: {}", key, error))?;
            values.push((key.to_string(), raw.parse::<u64>()
                .map_err(|error| format!("Invalid derived dependency {}: {}", key, error))?));
        }
        Ok(Self(values))
    }

    pub(crate) fn persist_for_artifact(&self, connection: &Connection, signature: &str) -> Result<(), String> {
        connection.execute("DELETE FROM kbm_artifact_dependencies WHERE artifact_sig=?1", [signature])
            .map_err(|error| format!("Clear artifact dependencies failed: {}", error))?;
        for (key, version) in &self.0 {
            connection.execute(
                "INSERT INTO kbm_artifact_dependencies(artifact_sig, dependency_key, dependency_version) VALUES (?1,?2,?3)",
                rusqlite::params![signature, key, version.to_string()],
            ).map_err(|error| format!("Persist artifact dependency failed: {}", error))?;
        }
        Ok(())
    }

    pub(crate) fn ensure_current(&self, connection: &Connection) -> Result<(), String> {
        let keys: Vec<&str> = self.0.iter().map(|(key, _)| key.as_str()).collect();
        let current = Self::capture(connection, &keys)?;
        if current != *self {
            return Err(format!(
                "KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: expected={:?}, current={:?}",
                self, current
            ));
        }
        Ok(())
    }
}

fn execute_write_command(
    connection: &mut Connection,
    operation: WriteOperation,
    generation: &AtomicU64,
) -> WriteResult {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("begin KBM Write Actor transaction failed: {}", error))?;

    let receipt = operation(&transaction)?;
    let current_generation = generation.load(Ordering::Acquire);
    let next_generation = if receipt.facts_changed {
        current_generation.saturating_add(1)
    } else {
        current_generation
    };
    if receipt.facts_changed {
        transaction
            .execute(
                "UPDATE kbm_runtime_meta SET value = ?1 WHERE key = 'database_generation'",
                [next_generation.to_string()],
            )
            .map_err(|error| format!("persist KBM database generation failed: {}", error))?;
        transaction
            .execute(
                "UPDATE kbm_index_states SET facts_generation = ?1
                 WHERE state = 'invalid' AND facts_generation = 0",
                [next_generation as i64],
            )
            .map_err(|error| format!("persist KBM pending index generation failed: {}", error))?;
        transaction
            .execute(
                "UPDATE kbm_operation_receipts
                 SET database_generation = ?1
                 WHERE status = 'committed' AND database_generation = 0",
                [next_generation as i64],
            )
            .map_err(|error| {
                format!("persist KBM operation receipt generation failed: {}", error)
            })?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit KBM Write Actor transaction failed: {}", error))?;
    generation.store(next_generation, Ordering::Release);

    Ok(WriteReceipt {
        operation: receipt.operation,
        database_generation: if !receipt.facts_changed && receipt.database_generation > 0 {
            receipt.database_generation
        } else {
            next_generation
        },
        facts_changed: receipt.facts_changed,
    })
}

fn quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite quick_check failed: {}", error))?;
    if result != "ok" {
        return Err(format!("SQLite quick_check returned {}", result));
    }
    Ok(())
}

fn is_corruption_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();

    // “quick_check returned …”表示 SQLite 已成功执行完整性检查并返回
    // 非 ok 结果，可以确认数据库内容损坏。相反，“quick_check failed”
    // 可能只是 busy、locked、IO 或句柄错误，不能触发隔离。
    normalized.contains("sqlite quick_check returned")
        || normalized.contains("database disk image is malformed")
        || normalized.contains("file is not a database")
        || normalized.contains("database corruption")
        || normalized.contains("not a database")
}

fn quarantine_database(db_path: &Path) -> Result<(), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let base = format!(
        "{}.startup-corrupt-{}-{}.bak",
        db_path.to_string_lossy(), std::process::id(), timestamp
    );
    let files = [
        (db_path.to_path_buf(), PathBuf::from(format!("{}", base))),
        (
            PathBuf::from(format!("{}-wal", db_path.to_string_lossy())),
            PathBuf::from(format!("{}-wal", base)),
        ),
        (
            PathBuf::from(format!("{}-shm", db_path.to_string_lossy())),
            PathBuf::from(format!("{}-shm", base)),
        ),
    ];

    // Inspect every source before moving any file. A later WAL/SHM inspection
    // failure must not leave an already moved main database behind.
    let mut existing = Vec::new();
    for (source, target) in files {
        match std::fs::metadata(&source) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!(
                "inspect quarantine source '{}' failed: {}", source.display(), error
            )),
        }
        match std::fs::symlink_metadata(&target) {
            Ok(_) => return Err(format!("quarantine target already exists: '{}'", target.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!(
                "inspect quarantine target '{}' failed: {}", target.display(), error
            )),
        }
        existing.push((source, target));
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (source, target) in existing {
        if let Err(error) = std::fs::rename(&source, &target) {
            let mut rollback_errors = Vec::new();
            for (moved_source, moved_target) in moved.iter().rev() {
                if let Err(rollback_error) = std::fs::rename(moved_target, moved_source) {
                    rollback_errors.push(format!(
                        "{} -> {}: {}",
                        moved_target.display(),
                        moved_source.display(),
                        rollback_error
                    ));
                }
            }
            let rollback_suffix = if rollback_errors.is_empty() {
                String::new()
            } else {
                format!("; rollback errors: {}", rollback_errors.join(", "))
            };
            return Err(format!(
                "quarantine SQLite file '{}' to '{}' failed: {}{}",
                source.display(),
                target.display(),
                error,
                rollback_suffix
            ));
        }
        moved.push((source, target));
    }

    let manifest = serde_json::json!({
        "schema": "kbm-quarantine-manifest-v1",
        "sourceDatabase": db_path.to_string_lossy(),
        "createdAtUnixNanos": timestamp.to_string(),
        "reason": "confirmed-startup-corruption",
        "files": moved.iter().map(|(source, target)| serde_json::json!({
            "source": source.to_string_lossy(),
            "backup": target.to_string_lossy(),
            "size": std::fs::metadata(target).ok().map(|metadata| metadata.len())
        })).collect::<Vec<_>>()
    });
    let manifest_path = PathBuf::from(format!("{}.manifest.json", base));
    let manifest_result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
            .open(&manifest_path)
            .map_err(|error| format!("create quarantine manifest failed: {}", error))?;
        file.write_all(&serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("serialize quarantine manifest failed: {}", error))?)
            .map_err(|error| format!("write quarantine manifest failed: {}", error))?;
        file.sync_all().map_err(|error| format!("sync quarantine manifest failed: {}", error))
    })();
    if let Err(error) = manifest_result {
        let mut rollback_errors = Vec::new();
        for (source, backup) in moved.iter().rev() {
            if let Err(rollback_error) = std::fs::rename(backup, source) {
                rollback_errors.push(rollback_error.to_string());
            }
        }
        let _ = std::fs::remove_file(&manifest_path);
        return Err(format!(
            "{}; quarantine rolled back; rollback errors: {:?}; backup prefix '{}'",
            error, rollback_errors, base
        ));
    }
    Ok(())
}

pub(crate) fn normalize_storage_options(options: Option<HashMap<String, i64>>) -> StorageOptions {
    let mut normalized = StorageOptions::default();
    if let Some(options) = options {
        if let Some(value) = options.get("readPoolSize") {
            normalized.read_pool_size = (*value).max(1) as usize;
        }
        if let Some(value) = options.get("mmapSize") {
            normalized.mmap_size = (*value).max(0);
        }
        if let Some(value) = options.get("busyTimeoutMs") {
            normalized.busy_timeout_ms = (*value).max(0) as u64;
        }
        if let Some(value) = options.get("schemaVersion") {
            normalized.schema_version = *value;
        }
    }
    normalized
}


/// Read authoritative FP32 rows without normalization or approximate reconstruction.
pub(crate) fn load_vectors_by_ids(
    connection: &Connection,
    table: &str,
    ids: &[i64],
    dimension: usize,
) -> Result<HashMap<i64, Vec<f32>>, String> {
    if !matches!(table, "tags" | "chunks") {
        return Err("vector source table must be tags or chunks".into());
    }
    let byte_len = dimension.checked_mul(4)
        .filter(|_| dimension > 0)
        .ok_or_else(|| "invalid vector dimension".to_string())?;
    let mut unique = ids.iter().copied().filter(|id| *id > 0).collect::<Vec<_>>();
    unique.sort_unstable();
    unique.dedup();
    let mut output = HashMap::with_capacity(unique.len());
    for batch in unique.chunks(128) {
        let placeholders = vec!["?"; batch.len()].join(",");
        let sql = format!("SELECT id, vector FROM {table} WHERE id IN ({placeholders}) AND vector IS NOT NULL");
        let mut statement = connection.prepare(&sql)
            .map_err(|error| format!("prepare authoritative vectors failed: {error}"))?;
        let mut rows = statement.query(rusqlite::params_from_iter(batch.iter()))
            .map_err(|error| format!("query authoritative vectors failed: {error}"))?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let (Ok(id), Ok(bytes)) = (row.get::<_, i64>(0), row.get::<_, Vec<u8>>(1)) else {
                // Preserve row-level fault isolation; query/I/O failures still propagate.
                continue;
            };
            if bytes.len() != byte_len {
                continue;
            }
            let vector = bytes.chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            if vector.iter().all(|value| value.is_finite()) {
                output.insert(id, vector);
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod generation_protocol_tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('database_generation', '7');
             CREATE TABLE kbm_index_states(
                 scope TEXT PRIMARY KEY, state TEXT, facts_generation INTEGER,
                 applied_generation INTEGER
             );
             INSERT INTO kbm_index_states VALUES ('diary:test', 'ready', 7, 7);
             CREATE TABLE kbm_operation_receipts(
                 operation_id TEXT PRIMARY KEY, status TEXT, database_generation INTEGER
             );"
        ).unwrap();
        connection
    }

    #[test]
    fn facts_and_pending_index_generation_commit_atomically() {
        let mut connection = database();
        let generation = AtomicU64::new(7);
        let receipt = execute_write_command(
            &mut connection,
            Box::new(|tx| {
                tx.execute(
                    "UPDATE kbm_index_states SET state='invalid', facts_generation=0",
                    [],
                ).map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO kbm_operation_receipts VALUES ('op', 'committed', 0)",
                    [],
                ).map_err(|error| error.to_string())?;
                Ok(WriteReceipt {
                    operation: "test".to_string(),
                    database_generation: 0,
                    facts_changed: true,
                })
            }),
            &generation,
        ).unwrap();
        assert_eq!(receipt.database_generation, 8);
        let state: (i64, i64) = connection.query_row(
            "SELECT facts_generation, applied_generation FROM kbm_index_states",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(state, (8, 7));
        let stored: i64 = connection.query_row(
            "SELECT database_generation FROM kbm_operation_receipts",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(stored, 8);
    }

    #[test]
    fn corrupt_startup_preserves_original_bytes_and_manifest() {
        let root = std::env::temp_dir().join(format!(
            "kbm-corrupt-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("test.sqlite");
        let original = b"deliberately invalid SQLite content";
        std::fs::write(&path, original).unwrap();
        let (storage, _) = SqliteStorageEngine::open_and_init(
            &path, StorageOptions::default(),
        ).unwrap();
        let manifests: Vec<_> = std::fs::read_dir(&root).unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.to_string_lossy().ends_with(".manifest.json"))
            .collect();
        assert_eq!(manifests.len(), 1);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&manifests[0]).unwrap()
        ).unwrap();
        let backup = manifest["files"][0]["backup"].as_str().unwrap();
        assert_eq!(std::fs::read(backup).unwrap(), original);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn idempotent_receipt_preserves_historical_generation() {
        let mut connection = database();
        let generation = AtomicU64::new(7);
        let receipt = execute_write_command(
            &mut connection,
            Box::new(|_| Ok(WriteReceipt {
                operation: "idempotent".to_string(),
                database_generation: 3,
                facts_changed: false,
            })),
            &generation,
        ).unwrap();
        assert_eq!(receipt.database_generation, 3);
        assert_eq!(generation.load(Ordering::Acquire), 7);
    }

    #[test]
    fn failed_command_rolls_back_pending_state() {
        let mut connection = database();
        let generation = AtomicU64::new(7);
        let result = execute_write_command(
            &mut connection,
            Box::new(|tx| {
                tx.execute(
                    "UPDATE kbm_index_states SET state='invalid', facts_generation=0",
                    [],
                ).map_err(|error| error.to_string())?;
                Err("injected failure".to_string())
            }),
            &generation,
        );
        assert!(result.is_err());
        let state: String = connection.query_row(
            "SELECT state FROM kbm_index_states", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(state, "ready");
        assert_eq!(generation.load(Ordering::Acquire), 7);
    }
}


#[cfg(test)]
mod audit_generation_tests {
    use super::*;

    #[test]
    fn stale_derived_publish_is_rejected_before_overwriting_ready_value() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('database_generation','9');
             CREATE TABLE result(value TEXT);
             INSERT INTO result VALUES ('healthy');"
        ).unwrap();
        let result = execute_write_command(&mut connection, Box::new(|tx| {
            ensure_generation(tx, 8)?;
            tx.execute("UPDATE result SET value='stale'", [])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "derived".into(), database_generation: 0, facts_changed: false })
        }), &AtomicU64::new(9));
        assert!(result.unwrap_err().contains("DERIVED_GENERATION_CONFLICT"));
        let value: String = connection.query_row("SELECT value FROM result", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "healthy");
    }
}


#[cfg(test)]
mod snapshot_dependency_tests {
    use super::*;

    #[test]
    fn derived_changes_conflict_without_fact_generation_change() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version','1'),('database_generation','7');"
        ).unwrap();
        crate::schema::initialize_schema(&connection, 1).unwrap();
        let snapshot = DerivedDependencies::capture(
            &connection, MEMO_ARTIFACT_DEPENDENCIES,
        ).unwrap();
        connection.execute(
            "INSERT INTO tag_intrinsic_residuals(tag_id,residual_energy,neighbor_count) VALUES (1,1,3)", [],
        ).unwrap();
        assert_eq!(read_generation(&connection).unwrap(), 7);
        assert!(snapshot.ensure_current(&connection).unwrap_err().contains("DEPENDENCY_CONFLICT"));
        let snapshot = DerivedDependencies::capture(&connection, &["derived_geometry"]).unwrap();
        connection.execute(
            "INSERT INTO kv_store(key,value) VALUES ('epa_basis_cache','{}')", [],
        ).unwrap();
        assert!(snapshot.ensure_current(&connection).is_err());
    }

    #[test]
    fn registered_read_transaction_keeps_snapshot_across_writer_commit() {
        let root = std::env::temp_dir().join(format!(
            "kbm-read-snapshot-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("test.sqlite");
        let (storage, _) = SqliteStorageEngine::open_and_init(&path, StorageOptions::default()).unwrap();
        with_registered_read_transaction(&path, |connection| {
            assert_eq!(read_generation(connection)?, 0);
            storage.submit_write(|tx| {
                tx.execute("INSERT INTO tags(name) VALUES ('later')", [])
                    .map_err(|error| error.to_string())?;
                Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
            })?;
            assert_eq!(read_generation(connection)?, 0);
            let count: i64 = connection.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        }).unwrap();
        assert_eq!(with_registered_read(&path, read_generation).unwrap(), 1);
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<(), String> = with_registered_read_transaction(&path, |_| panic!("injected"));
        }));
        assert!(panic.is_err());
        with_registered_read_transaction(&path, |connection| {
            assert!(!connection.is_autocommit());
            Ok(())
        }).unwrap();
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod authoritative_vector_tests {
    use super::*;

    #[test]
    fn sql_vectors_preserve_f32_bits_and_isolate_invalid_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY, vector BLOB);"
        ).unwrap();
        let original = [3.25_f32, -0.0, f32::from_bits(1)];
        let bytes = original.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
        connection.execute("INSERT INTO tags VALUES (1,?1)", [&bytes]).unwrap();
        connection.execute("INSERT INTO chunks VALUES (1,?1)", [&bytes]).unwrap();
        connection.execute("INSERT INTO tags VALUES (2,?1)", [vec![0_u8; 4]]).unwrap();
        let nonfinite = [f32::NAN, 0.0, 1.0].iter()
            .flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
        connection.execute("INSERT INTO tags VALUES (3,?1)", [nonfinite]).unwrap();
        connection.execute_batch("INSERT INTO tags VALUES (4,NULL),(5,'invalid');").unwrap();
        let rows = load_vectors_by_ids(&connection, "tags", &[5,4,3,2,1,1,-1,999], 3).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[&1].iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            original.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        assert_eq!(load_vectors_by_ids(&connection, "chunks", &[1], 3).unwrap()[&1], original);
        assert!(load_vectors_by_ids(&connection, "tags; DROP TABLE tags", &[1], 3).is_err());
        assert!(load_vectors_by_ids(&connection, "tags", &[1], 0).is_err());
        assert!(load_vectors_by_ids(&connection, "tags", &[], 3).unwrap().is_empty());
    }
}

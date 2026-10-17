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
    pub(crate) schema_version: i64,
}

impl Default for StorageOptions {
    fn default() -> Self {
        Self {
            read_pool_size: DEFAULT_READ_POOL_SIZE,
            mmap_size: DEFAULT_MMAP_SIZE,
            schema_version: 1,
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

fn normalized_path(path: impl AsRef<Path>) -> String {
    let normalized = std::fs::canonicalize(path.as_ref())
        .unwrap_or_else(|_| path.as_ref().to_path_buf())
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
        connection
            .execute_batch("BEGIN DEFERRED TRANSACTION")
            .map_err(|error| format!("begin SQLite read transaction failed: {}", error))?;

        match operation(connection) {
            Ok(value) => {
                connection
                    .execute_batch("COMMIT")
                    .map_err(|error| format!("commit SQLite read transaction failed: {}", error))?;
                Ok(value)
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
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
        let db_path = db_path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create SQLite directory failed: {}", error))?;
        }

        let mut writer = open_writer_connection(&db_path, options.mmap_size)?;
        initialize_schema_metadata(&mut writer, options.schema_version)?;
        let actual_schema_version = schema::initialize_schema(&writer, options.schema_version)?;
        quick_check(&writer)?;

        let generation = read_generation(&writer)?;
        let pool_size = options
            .read_pool_size
            .clamp(MIN_READ_POOL_SIZE, MAX_READ_POOL_SIZE);
        let mut read_pool = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            read_pool.push(open_read_connection(&db_path, options.mmap_size)?);
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
            db_path: db_path.clone(),
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
        if let Err(error) = register_storage(&db_path, engine.clone()) {
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

fn open_writer_connection(path: &Path, mmap_size: i64) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| format!("open SQLite writer failed: {}", error))?;
    configure_connection(&connection, false, mmap_size)?;
    Ok(connection)
}

fn open_read_connection(path: &Path, mmap_size: i64) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open SQLite read connection failed: {}", error))?;
    configure_connection(&connection, true, mmap_size)?;
    Ok(connection)
}

fn configure_connection(
    connection: &Connection,
    readonly: bool,
    mmap_size: i64,
) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
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

fn read_generation(connection: &Connection) -> Result<u64, String> {
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
    }
    transaction
        .commit()
        .map_err(|error| format!("commit KBM Write Actor transaction failed: {}", error))?;
    generation.store(next_generation, Ordering::Release);

    Ok(WriteReceipt {
        operation: receipt.operation,
        database_generation: next_generation,
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

pub(crate) fn normalize_storage_options(options: Option<HashMap<String, i64>>) -> StorageOptions {
    let mut normalized = StorageOptions::default();
    if let Some(options) = options {
        if let Some(value) = options.get("readPoolSize") {
            normalized.read_pool_size = (*value).max(1) as usize;
        }
        if let Some(value) = options.get("mmapSize") {
            normalized.mmap_size = (*value).max(0);
        }
        if let Some(value) = options.get("schemaVersion") {
            normalized.schema_version = *value;
        }
    }
    normalized
}

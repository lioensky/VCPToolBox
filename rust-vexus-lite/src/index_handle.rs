use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LockResult, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use crate::retrieval_index::RetrievalIndex as Index;

/// 所有索引写入口共用守卫，成功、错误及展开退出均刷新轻量统计。
pub(crate) struct IndexHandle {
    inner: RwLock<Index>,
    pub(crate) maintenance: std::sync::Mutex<()>,
    count: AtomicU64,
    capacity: AtomicU64,
    memory: AtomicU64,
    mmap: AtomicU64,
    tombstones: AtomicU64,
}

impl IndexHandle {
    pub(crate) fn new(index: Index) -> Self {
        Self {
            count: AtomicU64::new(index.size() as u64),
            capacity: AtomicU64::new(index.capacity() as u64),
            memory: AtomicU64::new(index.memory_usage() as u64),
            mmap: AtomicU64::new(index.mmap_bytes() as u64),
            tombstones: AtomicU64::new(index.tombstones() as u64),
            inner: RwLock::new(index),
            maintenance: std::sync::Mutex::new(()),
        }
    }

    pub(crate) fn read(&self) -> LockResult<RwLockReadGuard<'_, Index>> {
        self.inner.read()
    }

    pub(crate) fn write(&self) -> LockResult<IndexWriteGuard<'_>> {
        match self.inner.write() {
            Ok(guard) => Ok(IndexWriteGuard { owner: self, guard }),
            Err(error) => Err(PoisonError::new(IndexWriteGuard {
                owner: self, guard: error.into_inner(),
            })),
        }
    }

    pub(crate) fn cached_asset_stats(&self) -> (u64, u64) {
        (
            self.mmap.load(Ordering::Acquire),
            self.tombstones.load(Ordering::Acquire),
        )
    }

    pub(crate) fn cached_stats(&self) -> (u64, u64, u64) {
        (
            self.count.load(Ordering::Acquire),
            self.capacity.load(Ordering::Acquire),
            self.memory.load(Ordering::Acquire),
        )
    }
}

pub(crate) struct IndexWriteGuard<'a> {
    owner: &'a IndexHandle,
    guard: RwLockWriteGuard<'a, Index>,
}

impl Deref for IndexWriteGuard<'_> {
    type Target = Index;
    fn deref(&self) -> &Index { &self.guard }
}

impl DerefMut for IndexWriteGuard<'_> {
    fn deref_mut(&mut self) -> &mut Index { &mut self.guard }
}

impl Drop for IndexWriteGuard<'_> {
    fn drop(&mut self) {
        self.owner.count.store(self.guard.size() as u64, Ordering::Release);
        self.owner.capacity.store(self.guard.capacity() as u64, Ordering::Release);
        self.owner.memory.store(self.guard.memory_usage() as u64, Ordering::Release);
        self.owner.mmap.store(self.guard.mmap_bytes() as u64, Ordering::Release);
        self.owner.tombstones.store(self.guard.tombstones() as u64, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statistics_do_not_wait_for_index_lock() {
        let mut index = Index::empty(2).unwrap();
        index.reserve(16).unwrap();
        let handle = IndexHandle::new(index);
        {
            let mut guard = handle.write().unwrap();
            guard.add(1, &[1.0_f32, 0.0]).unwrap();
            assert_eq!(handle.cached_stats().0, 0);
        }
        assert_eq!(handle.cached_stats().0, 1);
        {
            let mut guard = handle.write().unwrap();
            guard.remove(1).unwrap();
        }
        assert_eq!(handle.cached_stats().0, 0);
    }
}
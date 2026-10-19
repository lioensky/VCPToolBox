//! Isolated TriviumDB 0.8.9 retrieval kernels.
//!
//! VCP-PATCH: SQL remains authoritative; this crate owns derived retrieval
//! state only. Upstream database, memtable, WAL and query language are excluded.

pub mod asset;
pub mod engine;
pub mod vector;
pub use vector::VectorType;

pub mod index {
    pub mod bq;
    pub mod quiver;
}

pub use index::quiver::{QuIVer, QuIVerConfig, QuIVerSearchConfig};
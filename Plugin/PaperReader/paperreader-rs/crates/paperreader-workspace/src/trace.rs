use crate::prelude::*;

// =============================================================================
// Trace Store
// =============================================================================

/// Trace事件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TraceEvent {
    pub timestamp: String,
    pub run_id: String,
    pub node_id: Option<String>,
    pub event_type: String,
    pub input_refs: Vec<PathBuf>,
    pub output_refs: Vec<PathBuf>,
    pub budget_delta: Option<BudgetConsumed>,
    pub note: Option<String>,
}

/// Trace存储
pub struct TraceStore {
    traces_dir: PathBuf,
}

impl TraceStore {
    pub fn new(traces_dir: PathBuf) -> Self {
        Self { traces_dir }
    }

    pub fn trace_path(&self, run_id: &str) -> PathBuf {
        self.traces_dir.join(run_id).with_extension("jsonl")
    }

    pub fn append_event(&self, run_id: &str, event: &TraceEvent) -> anyhow::Result<()> {
        let trace_file = self.trace_path(run_id);
        if let Some(parent) = trace_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        use std::io::Write;
        let line = serde_json::to_string(event)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(trace_file)?;
        writeln!(file, "{line}")?;
        Ok(())
    }

    pub fn read_events(
        &self,
        run_id: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<(Vec<TraceEvent>, usize, bool)> {
        let trace_file = self.trace_path(run_id);
        if !trace_file.exists() {
            return Ok((Vec::new(), cursor, true));
        }

        let data = std::fs::read_to_string(trace_file)?;
        let parsed = data
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str::<TraceEvent>)
            .collect::<Result<Vec<_>, _>>()?;
        let start = cursor.min(parsed.len());
        let take = limit.max(1);
        let end = (start + take).min(parsed.len());
        let next_cursor = end;
        let end_of_stream = next_cursor >= parsed.len();
        Ok((parsed[start..end].to_vec(), next_cursor, end_of_stream))
    }
}

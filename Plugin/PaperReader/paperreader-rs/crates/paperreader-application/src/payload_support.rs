use super::*;

impl PaperReaderApplication {
    pub(crate) fn resolve_workspace_root(&self, payload: &Value) -> PathBuf {
        payload
            .get("workspace_root")
            .and_then(|value| value.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.config.workspace_root.clone())
    }
}

pub(crate) fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

pub(crate) fn required_string(payload: &Value, key: &str) -> Result<String> {
    payload_string(payload, key).with_context(|| format!("missing required payload field: {key}"))
}

pub(crate) fn required_document_ids(payload: &Value, key: &str) -> Result<Vec<DocumentId>> {
    let values = payload
        .get(key)
        .and_then(|value| value.as_array())
        .with_context(|| format!("missing required payload field: {key}"))?;
    let mut document_ids = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .as_str()
            .with_context(|| format!("payload field {key} must be an array of strings"))?;
        document_ids.push(DocumentId::new(id));
    }
    Ok(document_ids)
}

pub(crate) fn display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    let parts = trimmed
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if let Some(index) = parts.iter().rposition(|part| {
        matches!(
            *part,
            "documents" | "collections" | "runs" | "shared" | "indexes"
        )
    }) {
        return parts[index..].join("/");
    }
    if let Some(index) = parts.iter().rposition(|part| *part == "workspace-rs") {
        let suffix = parts[index + 1..].join("/");
        return if suffix.is_empty() {
            ".".to_string()
        } else {
            suffix
        };
    }
    if path.is_absolute() {
        trimmed.to_string()
    } else {
        parts.join("/")
    }
}

pub(crate) fn guess_display_name(source_ref: &str) -> Option<String> {
    Path::new(source_ref)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
}

pub(crate) fn snippet(text: &str) -> String {
    const LIMIT: usize = 220;
    if text.len() <= LIMIT {
        text.to_string()
    } else {
        format!("{}...", &text[..LIMIT])
    }
}

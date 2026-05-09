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

/// Resolve `payload[key]` as a `Vec<Value>`, accepting either:
///   - a real JSON array (the canonical form), or
///   - a JSON-encoded string of an array (the form produced by VCP's text
///     protocol `「始」…「末」`, which collapses every field value to a string).
///
/// Returns `None` when the field is absent, null, or cannot be coerced into
/// an array. Whitespace-only strings are treated as absent.
pub(crate) fn payload_array(payload: &Value, key: &str) -> Option<Vec<Value>> {
    match payload.get(key)? {
        Value::Null => None,
        Value::Array(items) => Some(items.clone()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            // Tolerate values like `["a","b"]` arriving as a string. We only
            // accept top-level JSON arrays here; any other JSON shape is
            // rejected so callers can surface a typed error.
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Array(items)) => Some(items),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(crate) fn required_document_ids(payload: &Value, key: &str) -> Result<Vec<DocumentId>> {
    let values = payload_array(payload, key)
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
        let mut end = LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &text[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payload_array_accepts_native_array() {
        let payload = json!({ "document_ids": ["a", "b", "c"] });
        let parsed = payload_array(&payload, "document_ids").expect("array should be parsed");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].as_str(), Some("a"));
    }

    #[test]
    fn payload_array_accepts_json_string_array() {
        // VCP's `「始」…「末」` text protocol collapses field values to strings.
        // The plugin must still understand `[..]` arriving as a JSON string.
        let payload = json!({
            "document_ids": "[\"Genshin_Vol_1_Execute\", \"Genshin_Vol_2_Execute\"]"
        });
        let parsed = payload_array(&payload, "document_ids").expect("string array should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].as_str(), Some("Genshin_Vol_2_Execute"));
    }

    #[test]
    fn payload_array_rejects_non_array_string() {
        let payload = json!({ "document_ids": "not-an-array" });
        assert!(payload_array(&payload, "document_ids").is_none());
    }

    #[test]
    fn payload_array_rejects_object() {
        let payload = json!({ "document_ids": { "x": 1 } });
        assert!(payload_array(&payload, "document_ids").is_none());
    }

    #[test]
    fn payload_array_treats_missing_or_null_as_none() {
        let missing = json!({});
        assert!(payload_array(&missing, "document_ids").is_none());

        let null_value = json!({ "document_ids": null });
        assert!(payload_array(&null_value, "document_ids").is_none());

        let blank = json!({ "document_ids": "   " });
        assert!(payload_array(&blank, "document_ids").is_none());
    }

    #[test]
    fn required_document_ids_accepts_string_form() {
        let payload = json!({
            "document_ids": "[\"doc-a\", \"doc-b\"]"
        });
        let ids = required_document_ids(&payload, "document_ids")
            .expect("string-form document_ids should parse");
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0].0, "doc-a");
        assert_eq!(ids[1].0, "doc-b");
    }

    #[test]
    fn required_document_ids_reports_missing_on_unparseable_string() {
        let payload = json!({ "document_ids": "doc-a, doc-b" });
        let err = required_document_ids(&payload, "document_ids")
            .expect_err("unparseable strings must not be silently accepted");
        let message = format!("{err:#}");
        assert!(message.contains("missing required payload field: document_ids"));
    }

    #[test]
    fn required_document_ids_rejects_non_string_items() {
        let payload = json!({ "document_ids": [1, 2, 3] });
        let err = required_document_ids(&payload, "document_ids")
            .expect_err("numeric items must be rejected");
        let message = format!("{err:#}");
        assert!(message.contains("must be an array of strings"));
    }
}

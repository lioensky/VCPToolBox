use crate::*;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};
use zip::ZipArchive;

/// MinerU Cloud API (v4) gateway (blocking).
///
/// The implementation follows the historic Node adapter in this repo:
/// `Backups/.../Plugin/PaperReader/lib/mineru-client.js`.
///
/// Notes:
/// - We intentionally keep this gateway synchronous to match the current ingestion API.
/// - The gateway bridges MinerU zip output (Markdown) into `MinerURawResult` via
///   `build_raw_result_from_text`, so downstream normalizer/reading can stay unchanged.
#[derive(Debug, Clone)]
pub struct MinerUHttpGateway {
    base_url: String,
    token: String,
    timeout: Duration,
    poll_interval: Duration,
    model_version: ModelVersion,
    client: Client,
}

impl MinerUHttpGateway {
    pub fn new(
        config: MinerUGatewayConfig,
        poll_interval: Duration,
        model_version: ModelVersion,
    ) -> Result<Self, IngestionError> {
        if config.token.trim().is_empty() {
            return Err(IngestionError::parse_request_failed(
                "MinerU token must not be empty",
            ));
        }
        let timeout = Duration::from_secs(config.timeout_seconds.max(1));
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
        Ok(Self {
            base_url: config.base_url.trim_end_matches('/').to_string(),
            token: config.token,
            timeout,
            poll_interval,
            model_version,
            client,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        if path.starts_with('/') {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}/{}", self.base_url, path)
        }
    }

    fn auth_value(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn post_file_urls_batch(
        &self,
        file_name: &str,
    ) -> Result<MinerUFileUrlsBatchData, IngestionError> {
        let url = self.endpoint("file-urls/batch");
        let body = json!({
            "files": [{ "name": file_name, "data_id": format!("pr_{}", chrono::Utc::now().timestamp_millis()) }],
            "enable_formula": true,
            "enable_table": true,
            "model_version": self.model_version.as_api_value(),
        });

        let resp = self
            .client
            .post(url)
            .header("Authorization", self.auth_value())
            .json(&body)
            .send()
            .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;

        let status = resp.status();
        let payload: MinerUApiEnvelope<MinerUFileUrlsBatchData> = resp
            .json()
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;

        if !status.is_success() {
            return Err(IngestionError::parse_request_failed(format!(
                "MinerU file-urls/batch failed: http_status={status}"
            )));
        }
        payload.into_result()
    }

    fn upload_file_to_presigned_url(
        &self,
        upload_url: &str,
        file_path: &Path,
    ) -> Result<(), IngestionError> {
        let bytes = std::fs::read(file_path)
            .map_err(|err| IngestionError::upload_failed(err.to_string(), true))?;

        // Important: Pre-signed URL uploads can be sensitive to additional headers.
        // We only set Content-Length explicitly.
        let resp = self
            .client
            .put(upload_url)
            .header("Content-Length", bytes.len())
            .body(bytes)
            .send()
            .map_err(|err| IngestionError::upload_failed(err.to_string(), true))?;

        if !resp.status().is_success() {
            return Err(IngestionError::upload_failed(
                format!("Upload failed: http_status={}", resp.status()),
                true,
            ));
        }
        Ok(())
    }

    fn poll_batch_result(
        &self,
        batch_id: &str,
    ) -> Result<MinerUBatchExtractResult, IngestionError> {
        let url = self.endpoint(format!("extract-results/batch/{batch_id}").as_str());
        let started = Instant::now();

        while started.elapsed() < self.timeout {
            let resp = self
                .client
                .get(url.clone())
                .header("Authorization", self.auth_value())
                .send()
                .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;

            let status = resp.status();
            let payload: MinerUApiEnvelope<MinerUBatchExtractResultsData> = resp
                .json()
                .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;

            if !status.is_success() {
                return Err(IngestionError::parse_request_failed(format!(
                    "MinerU extract-results/batch poll failed: http_status={status}"
                )));
            }

            let data = payload.into_result()?;
            if let Some(first) = data.extract_result.into_iter().next() {
                match first.state.as_str() {
                    "done" => return Ok(first),
                    "failed" => {
                        return Err(IngestionError::parse_failed(
                            batch_id.to_string(),
                            first.err_msg.unwrap_or_else(|| "unknown".to_string()),
                        ));
                    }
                    _ => {}
                }
            }

            std::thread::sleep(self.poll_interval);
        }

        Err(IngestionError::parse_timeout(batch_id.to_string()))
    }

    fn download_zip_markdown(&self, zip_url: &str) -> Result<String, IngestionError> {
        let mut resp = self
            .client
            .get(zip_url)
            .send()
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
        if !resp.status().is_success() {
            return Err(IngestionError::malformed_mineru_result(format!(
                "Zip download failed: http_status={}",
                resp.status()
            )));
        }

        let mut bytes = Vec::new();
        resp.read_to_end(&mut bytes)
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;

        let cursor = std::io::Cursor::new(bytes);
        let mut archive = ZipArchive::new(cursor)
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
            let name = file.name().to_string();
            if name.to_lowercase().ends_with(".md") {
                let mut content = String::new();
                file.read_to_string(&mut content)
                    .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
                return Ok(content);
            }
        }

        Err(IngestionError::malformed_mineru_result(
            "Zip archive did not contain a Markdown file",
        ))
    }

    fn parse_file(&self, file_path: &Path, title: &str) -> Result<MinerURawResult, IngestionError> {
        let file_name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document.pdf");
        let upload = self.post_file_urls_batch(file_name)?;
        let upload_url = upload
            .file_urls
            .first()
            .cloned()
            .ok_or_else(|| IngestionError::malformed_mineru_result("Missing file_urls"))?;
        let batch_id = upload.batch_id.clone();

        self.upload_file_to_presigned_url(&upload_url, file_path)?;
        let result = self.poll_batch_result(&batch_id)?;

        let zip_url = result.full_zip_url.clone().ok_or_else(|| {
            IngestionError::malformed_mineru_result("No full_zip_url in batch result")
        })?;

        let markdown = self.download_zip_markdown(&zip_url)?;
        let mut raw = build_raw_result_from_text(title, &markdown);
        raw.version = "mineru-v4-zip-bridge-1.0".to_string();
        if let Some(page_count) = result.page_count {
            raw.document_info.page_count = page_count;
        }
        raw.metadata
            .insert("mineru_batch_id".to_string(), json!(batch_id));
        raw.metadata
            .insert("mineru_full_zip_url".to_string(), json!(zip_url));
        raw.metadata
            .insert("mineru_state".to_string(), json!(result.state));
        Ok(raw)
    }
}

impl MinerUGateway for MinerUHttpGateway {
    fn generate_raw_result(
        &self,
        source_type: ImportSourceType,
        source_ref: &str,
        display_name: Option<String>,
    ) -> Result<MinerURawResult, IngestionError> {
        let title = display_name
            .or_else(|| {
                if source_ref.trim().is_empty() {
                    None
                } else {
                    Some(source_ref.to_string())
                }
            })
            .unwrap_or_else(|| "Untitled".to_string());

        match source_type {
            ImportSourceType::RawText | ImportSourceType::Snapshot => {
                Ok(build_raw_result_from_text(&title, source_ref))
            }
            ImportSourceType::File => self.parse_file(Path::new(source_ref), &title),
            ImportSourceType::Url => {
                // Best-effort fallback: fetch URL body and bridge to text blocks.
                // A full MinerU URL task flow can be added later without breaking the contract.
                let resp = self
                    .client
                    .get(source_ref)
                    .send()
                    .map_err(|err| IngestionError::parse_request_failed(err.to_string()))?;
                let status = resp.status();
                let body = resp
                    .text()
                    .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
                if !status.is_success() {
                    return Err(IngestionError::parse_request_failed(format!(
                        "Failed to fetch URL: http_status={status}"
                    )));
                }
                Ok(build_raw_result_from_text(&title, &body))
            }
        }
    }

    fn submit_url_task(
        &self,
        _url: &str,
        _model_version: ModelVersion,
    ) -> Result<String, IngestionError> {
        Err(IngestionError::parse_request_failed(
            "submit_url_task is not implemented for MinerUHttpGateway yet",
        ))
    }

    fn get_task_status(&self, task_id: &str) -> Result<MinerUTaskStatus, IngestionError> {
        Err(IngestionError::parse_request_failed(format!(
            "get_task_status is not implemented for task_id={task_id}"
        )))
    }

    fn submit_batch_url_tasks(
        &self,
        _urls: &[&str],
        _model_version: ModelVersion,
    ) -> Result<String, IngestionError> {
        Err(IngestionError::parse_request_failed(
            "submit_batch_url_tasks is not implemented for MinerUHttpGateway yet",
        ))
    }

    fn get_batch_results(&self, batch_id: &str) -> Result<Vec<MinerUTaskResult>, IngestionError> {
        Err(IngestionError::parse_request_failed(format!(
            "get_batch_results is not implemented for batch_id={batch_id}"
        )))
    }

    fn download_result(&self, result_url: &str) -> Result<MinerURawResult, IngestionError> {
        let resp = self
            .client
            .get(result_url)
            .send()
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(IngestionError::malformed_mineru_result(format!(
                "download_result failed: http_status={status}"
            )));
        }

        // Prefer JSON raw results when available.
        let text = resp
            .text()
            .map_err(|err| IngestionError::malformed_mineru_result(err.to_string()))?;
        if let Ok(raw) = serde_json::from_str::<MinerURawResult>(&text) {
            return Ok(raw);
        }

        // Fall back to plain text bridge (e.g. markdown-only endpoints).
        Ok(build_raw_result_from_text("Downloaded", &text))
    }
}

#[derive(Debug, Clone, Deserialize)]
struct MinerUApiEnvelope<T> {
    code: i64,
    msg: Option<String>,
    data: Option<T>,
    #[serde(rename = "error")]
    _error: Option<Value>,
}

impl<T> MinerUApiEnvelope<T> {
    fn into_result(self) -> Result<T, IngestionError> {
        if self.code != 0 {
            return Err(IngestionError::parse_request_failed(format!(
                "MinerU API error: code={}, msg={}",
                self.code,
                self.msg.unwrap_or_default()
            )));
        }
        self.data
            .ok_or_else(|| IngestionError::malformed_mineru_result("Missing data field"))
    }
}

#[derive(Debug, Clone, Deserialize)]
struct MinerUFileUrlsBatchData {
    batch_id: String,
    file_urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinerUBatchExtractResultsData {
    #[serde(default)]
    extract_result: Vec<MinerUBatchExtractResult>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinerUBatchExtractResult {
    state: String,
    #[serde(default)]
    err_msg: Option<String>,
    #[serde(default)]
    full_zip_url: Option<String>,
    #[serde(default)]
    page_count: Option<u32>,
}

impl ModelVersion {
    fn as_api_value(&self) -> &'static str {
        match self {
            ModelVersion::Pipeline => "pipeline",
            ModelVersion::Vlm => "vlm",
            ModelVersion::MinerUHtml => "MinerU-HTML",
        }
    }
}

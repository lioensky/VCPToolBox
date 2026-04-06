use super::*;

pub(crate) struct StaticMinerUGateway;

impl MinerUGateway for StaticMinerUGateway {
    fn generate_raw_result(
        &self,
        source_type: ImportSourceType,
        source_ref: &str,
        display_name: Option<String>,
    ) -> Result<MinerURawResult, IngestionError> {
        let text = match source_type {
            ImportSourceType::RawText => source_ref.to_string(),
            ImportSourceType::File => read_file_for_local_gateway(source_ref)?,
            ImportSourceType::Url => format!("Fetched URL placeholder for {source_ref}"),
            ImportSourceType::Snapshot => source_ref.to_string(),
        };
        let title = display_name
            .or_else(|| guess_display_name(source_ref))
            .unwrap_or_else(|| "Untitled".to_string());
        Ok(paperreader_ingestion::build_raw_result_from_text(
            &title, &text,
        ))
    }

    fn submit_url_task(
        &self,
        _url: &str,
        _model_version: ModelVersion,
    ) -> Result<String, IngestionError> {
        Ok("fake-url-task".to_string())
    }

    fn get_task_status(
        &self,
        task_id: &str,
    ) -> Result<paperreader_ingestion::MinerUTaskStatus, IngestionError> {
        Ok(paperreader_ingestion::MinerUTaskStatus {
            task_id: task_id.to_string(),
            state: paperreader_ingestion::MinerUTaskState::Done,
            progress_percent: Some(100),
            error_message: None,
            result_url: Some("fake://result".to_string()),
            full_zip_url: None,
        })
    }

    fn submit_batch_url_tasks(
        &self,
        _urls: &[&str],
        _model_version: ModelVersion,
    ) -> Result<String, IngestionError> {
        Ok("fake-batch".to_string())
    }

    fn get_batch_results(
        &self,
        _batch_id: &str,
    ) -> Result<Vec<paperreader_ingestion::MinerUTaskResult>, IngestionError> {
        Ok(Vec::new())
    }

    fn download_result(&self, _result_url: &str) -> Result<MinerURawResult, IngestionError> {
        Ok(paperreader_ingestion::build_raw_result_from_text(
            "Downloaded",
            "Downloaded placeholder content",
        ))
    }
}

pub(crate) struct DeterministicLlmClient;

impl LlmClient for DeterministicLlmClient {
    fn generate(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, LlmError>> + Send + '_>> {
        let response = build_segment_reader_response(prompt);
        Box::pin(async move { Ok(response) })
    }

    fn generate_with_context(
        &self,
        prompt: &str,
        _context: &[paperreader_reading::ContextMessage],
    ) -> Pin<Box<dyn Future<Output = Result<String, LlmError>> + Send + '_>> {
        self.generate(prompt)
    }
}

fn build_segment_reader_response(prompt: &str) -> String {
    if prompt.contains("[number]|SUPPORT|confidence")
        && prompt.contains("[number]|CONTRADICT|confidence")
    {
        return (1..=50)
            .map(|idx| format!("{idx}|SUPPORT|0.9"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let text = prompt
        .split("Text Segment:\n")
        .nth(1)
        .unwrap_or(prompt)
        .lines()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    let summary = snippet(&text);
    let first_sentence = text
        .split('.')
        .find(|sentence| !sentence.trim().is_empty())
        .unwrap_or(text.as_str())
        .trim()
        .to_string();
    format!(
        "SUMMARY: {summary}\nKEY_POINTS:\n- {first_sentence}\nCLAIMS:\n- {first_sentence} (confidence: high)\nOPEN_QUESTIONS:\n- What follow-up evidence supports this section?"
    )
}

fn read_file_for_local_gateway(source_ref: &str) -> Result<String, IngestionError> {
    let path = Path::new(source_ref);
    if !path.exists() {
        return Ok(format!(
            "Synthetic content for missing source: {source_ref}"
        ));
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .to_string();

    match ext.as_str() {
        "txt" | "md" | "html" | "json" => std::fs::read_to_string(path)
            .map_err(|err| IngestionError::local_parse_failed(err.to_string())),
        "pdf" => match extract_pdf_text_with_pdf_parse(path) {
            Ok(text) if !text.trim().is_empty() => Ok(text),
            _ => Ok(format!("Binary PDF ingested from {}", path.display())),
        },
        _ => Ok(format!("Binary source ingested from {}", path.display())),
    }
}

fn extract_pdf_text_with_pdf_parse(path: &Path) -> Result<String, IngestionError> {
    let script = r#"
const fs = require('fs');
const pdf = require('pdf-parse');

(async () => {
  const buf = fs.readFileSync(process.argv[1]);
  const data = await pdf(buf);
  process.stdout.write((data && data.text) ? data.text : '');
})().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
"#;

    let output = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(path.as_os_str())
        .output()
        .map_err(|err| IngestionError::local_parse_failed(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(IngestionError::local_parse_failed(format!(
            "pdf-parse failed: {}",
            snippet(&stderr)
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

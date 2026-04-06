use anyhow::Result;
use paperreader_api::{ResponseEnvelope, handle_request};
use paperreader_application::PaperReaderApplication;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn make_request_id() -> String {
    // Stable-enough for single-process stdio usage.
    format!("vcp-{}", now_millis())
}

fn to_envelope_value(input: &Value) -> Result<Value> {
    if input.get("protocol_version").is_some() && input.get("payload").is_some() {
        return Ok(input.clone());
    }

    let command = input
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let request_id = input
        .get("request_id")
        .and_then(|value| value.as_str())
        .or_else(|| input.get("requestId").and_then(|value| value.as_str()))
        .map(ToString::to_string)
        .unwrap_or_else(make_request_id);

    let client = input.get("client").cloned();
    let workspace = input.get("workspace").cloned();
    let execution = input.get("execution").cloned();
    let idempotency_key = input.get("idempotency_key").cloned();
    let execution_mode = input.get("execution_mode").cloned();
    let client_info = input.get("client_info").cloned();

    // For VCP-style flat payloads, treat the remaining keys as `payload`.
    let mut payload = input.clone();
    if let Some(map) = payload.as_object_mut() {
        map.remove("protocol_version");
        map.remove("command");
        map.remove("request_id");
        map.remove("requestId");
        map.remove("client");
        map.remove("workspace");
        map.remove("execution");
        map.remove("idempotency_key");
        map.remove("execution_mode");
        map.remove("client_info");
        map.remove("payload");
    }

    let mut envelope = serde_json::Map::new();
    envelope.insert("protocol_version".to_string(), json!("1.0"));
    envelope.insert("command".to_string(), json!(command));
    envelope.insert("request_id".to_string(), json!(request_id));
    envelope.insert("payload".to_string(), payload);

    if let Some(value) = client {
        envelope.insert("client".to_string(), value);
    }
    if let Some(value) = workspace {
        envelope.insert("workspace".to_string(), value);
    }
    if let Some(value) = execution {
        envelope.insert("execution".to_string(), value);
    }
    if let Some(value) = idempotency_key {
        envelope.insert("idempotency_key".to_string(), value);
    }
    if let Some(value) = execution_mode {
        envelope.insert("execution_mode".to_string(), value);
    }
    if let Some(value) = client_info {
        envelope.insert("client_info".to_string(), value);
    }

    Ok(Value::Object(envelope))
}

fn maybe_run_worker_mode() -> Result<bool> {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        return Ok(false);
    };
    if mode != "--worker-run" {
        return Ok(false);
    }

    let workspace_root = args.next().unwrap_or_else(|| "./workspace-rs".to_string());
    let run_id = args.next().unwrap_or_default();
    if run_id.trim().is_empty() {
        return Ok(true);
    }

    let runtime = tokio::runtime::Runtime::new()?;
    let app = PaperReaderApplication::from_env()?;
    let _ = runtime.block_on(async {
        app.resume_research_graph(&json!({
            "workspace_root": workspace_root,
            "run_id": run_id,
        }))
        .await
    });
    Ok(true)
}

fn maybe_spawn_async_worker(input: &Value, response: &mut ResponseEnvelope) {
    if input.get("command").and_then(|value| value.as_str()) != Some("run_research_graph") {
        return;
    }
    let execution_mode = input
        .get("execution")
        .and_then(|value| value.get("mode"))
        .and_then(|value| value.as_str())
        .or_else(|| input.get("execution_mode").and_then(|value| value.as_str()));
    if execution_mode != Some("async") {
        return;
    }
    if response.status != "accepted" {
        return;
    }

    let Some(data) = response.data.as_mut() else {
        return;
    };
    let Some(run_id) = data.get("run_id").and_then(|value| value.as_str()) else {
        return;
    };
    let workspace_root = input
        .get("workspace")
        .and_then(|value| value.get("root"))
        .and_then(|value| value.as_str())
        .or_else(|| input.get("workspace_root").and_then(|value| value.as_str()))
        .unwrap_or("./workspace-rs");
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };

    let mut command = Command::new(current_exe);
    command
        .arg("--worker-run")
        .arg(workspace_root)
        .arg(run_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(0x0000_0008);
    }
    if command.spawn().is_ok() {
        data["degrade_mode"] = json!("background_worker_spawned");
        data["worker_mode"] = json!("detached_resume_process");
    }
}

fn main() -> Result<()> {
    if maybe_run_worker_mode()? {
        return Ok(());
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let input: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let transport = json!({
                    "status": "error",
                    "error": format!("Invalid JSON: {error}"),
                });
                writeln!(stdout, "{}", serde_json::to_string(&transport)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let envelope = to_envelope_value(&input)?;
        let raw_envelope = serde_json::to_string(&envelope)?;

        let mut response = match handle_request(&raw_envelope) {
            Ok(response) => response,
            Err(error) => {
                let transport = json!({
                    "status": "error",
                    "error": error,
                });
                writeln!(stdout, "{}", serde_json::to_string(&transport)?)?;
                stdout.flush()?;
                continue;
            }
        };
        maybe_spawn_async_worker(&envelope, &mut response);

        let is_error = response.status == "error";
        let transport = if is_error {
            let message = response
                .errors
                .first()
                .map(|error| error.message.clone())
                .unwrap_or_else(|| "Unknown error".to_string());
            json!({
                "status": "error",
                "error": message,
            })
        } else {
            json!({
                "status": "success",
                "result": response,
            })
        };

        writeln!(stdout, "{}", serde_json::to_string(&transport)?)?;
        stdout.flush()?;
    }

    Ok(())
}

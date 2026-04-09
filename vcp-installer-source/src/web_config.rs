//! VCP Web 配置向导 — HTTP 服务与配置生成
//! 
//! TUI安装完成后启动临时Web服务，用户在浏览器中填写配置，
//! 自动生成 config.env 并链接 VCPChat 前后端。
//!
//! 零额外依赖：std::net::TcpListener + std::process::Command

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::web_config_html::CONFIG_PAGE_HTML;

// ==========================================
//  公开接口
// ==========================================

/// 启动 Web 配置向导
///
/// - `install_dir`: 安装根目录（包含 VCPToolBox/ 和 VCPChat/ 子目录）
/// - 返回：用户完成配置后 Ok(())
pub fn start_web_config(install_dir: &Path) -> Result<()> {
    // 绑定随机端口
    let listener = TcpListener::bind("127.0.0.1:0")
        .context("无法绑定本地端口")?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{}", port);

    println!();
    println!("  ╔══════════════════════════════════════════╗");
    println!("  ║     VCP 配置向导已启动                    ║");
    println!("  ║     请在浏览器中完成配置                  ║");
    println!("  ╠══════════════════════════════════════════╣");
    println!("  ║  地址: {:<33} ║", url);
    println!("  ║  按 Ctrl+C 可取消                        ║");
    println!("  ╚══════════════════════════════════════════╝");
    println!();

    // 准备 HTML（替换动态占位符）
    let system_info = get_system_info();
    let vchat_path = install_dir.join("VCPChat").display().to_string();
    let html = CONFIG_PAGE_HTML
        .replace("{{SYSTEM_INFO}}", &system_info)
        .replace("{{VCHAT_PATH}}", &vchat_path);

    // 延迟打开浏览器，确保 accept 循环已就绪
    let url_clone = url.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", &url_clone])
            .spawn();
    });

    // 请求循环
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                match handle_request(&mut stream, &html, install_dir) {
                    Ok(should_exit) => {
                        if should_exit {
                            println!("  [VCP] 配置已保存。可关闭浏览器，按 Ctrl+C 退出。");
                        }
                    }
                    Err(e) => {
                        eprintln!("  [VCP] 请求处理错误: {}", e);
                        let _ = write_http_response(
                            &mut stream,
                            500,
                            "application/json",
                            &format!(r#"{{"success":false,"error":"{}"}}"#, e),
                        );
                    }
                }
            }
            Err(e) => eprintln!("  [VCP] 连接错误: {}", e),
        }
    }

    Ok(())
}

// ==========================================
//  HTTP 请求处理
// ==========================================

/// 处理单个 HTTP 请求，返回是否应退出服务
fn handle_request(
    stream: &mut std::net::TcpStream,
    html: &str,
    install_dir: &Path,
) -> Result<bool> {
    let mut reader = BufReader::new(stream.try_clone()?);

    // 读取请求行
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(false);
    }
    let method = parts[0];
    let path = parts[1];

    // 读取所有头部
    let mut content_length: usize = 0;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        let lower = header.to_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(val) = lower.split(':').nth(1) {
                content_length = val.trim().parse().unwrap_or(0);
            }
        }
    }

    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => {
            write_http_response(stream, 200, "text/html; charset=utf-8", html)?;
            Ok(false)
        }
        ("POST", "/submit") => {
            // 读取 body
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body)?;
            let body_str = String::from_utf8_lossy(&body);

            // 解析 JSON
            let fields: HashMap<String, String> = serde_json::from_str(&body_str)
                .context("JSON 解析失败")?;

            // 执行配置生成
            match generate_all_config(install_dir, &fields) {
                Ok(summary) => {
                    let escaped = summary
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('\n', "<br>")
                        .replace('\r', "")
                        .replace('\t', "\\t");
                    let resp = format!(
                        r#"{{"success":true,"summary":"{}"}}"#,
                        escaped
                    );
                    write_http_response(stream, 200, "application/json", &resp)?;
                    Ok(false) // 配置已保存，但不退出服务，避免TCP RST导致前端Failed to fetch
                }
                Err(e) => {
                    let err_escaped = format!("{:#}", e)
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('\n', " ")
                        .replace('\r', "");
                    let resp = format!(
                        r#"{{"success":false,"error":"{}"}}"#,
                        err_escaped
                    );
                    write_http_response(stream, 200, "application/json", &resp)?;
                    Ok(false) // 出错不退出，让用户修改重试
                }
            }
        }
        ("OPTIONS", _) => {
            // CORS preflight
            write_http_response(stream, 200, "text/plain", "")?;
            Ok(false)
        }
        _ => {
            write_http_response(stream, 404, "text/plain", "Not Found")?;
            Ok(false)
        }
    }
}

fn write_http_response(
    stream: &mut std::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<()> {
    let status_text = match status {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        status,
        status_text,
        content_type,
        body.len(),
        body,
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

// ==========================================
//  配置生成
// ==========================================

/// 生成 config.env + 更新 settings.json
fn generate_all_config(
    install_dir: &Path,
    fields: &HashMap<String, String>,
) -> Result<String> {
    let toolbox_dir = install_dir.join("VCPToolBox");
    let vchat_dir = install_dir.join("VCPChat");

    // ---- 1. 生成 config.env ----
    let config_env_path = generate_config_env(&toolbox_dir, fields)?;

    // ---- 2. 更新 VCPChat settings.json ----
    let settings_updated = if vchat_dir.exists() {
        update_vchat_settings(&vchat_dir, fields)?;
        true
    } else {
        false
    };

    // ---- 3. 注册 Nova 默认 Agent ----
    let nova_status = register_nova(&toolbox_dir, &vchat_dir, fields)
        .unwrap_or_else(|e| format!("Nova 注册失败: {}", e));

    // ---- 4. 生成摘要 ----
    let port = fields.get("PORT").map(|s| s.as_str()).unwrap_or("6005");
    let key = fields.get("Key").map(|s| s.as_str()).unwrap_or("");
    let vcp_key = fields.get("VCP_Key").map(|s| s.as_str()).unwrap_or("");
    let admin_user = fields.get("AdminUsername").map(|s| s.as_str()).unwrap_or("admin");
    let admin_pass = fields.get("AdminPassword").map(|s| s.as_str()).unwrap_or("");

    let mut summary = String::new();
    summary.push_str(&format!(
        "<span class='key'>config.env</span> → <span class='val'>{}</span>\n",
        config_env_path.display()
    ));
    summary.push_str(&format!(
        "<span class='key'>VCP 服务地址</span> → <span class='val'>http://127.0.0.1:{}</span>\n",
        port
    ));
    summary.push_str(&format!(
        "<span class='key'>管理面板</span> → <span class='val'>http://127.0.0.1:{}/admin</span>\n",
        port
    ));
    summary.push_str(&format!(
        "<span class='key'>管理员</span> → <span class='val'>{} / {}</span>\n",
        admin_user, admin_pass
    ));

    if settings_updated {
        summary.push_str(&format!(
            "<span class='key'>VCPChat 链接</span> → <span class='val'>已自动配置</span>\n"
        ));
        summary.push_str(&format!(
            "<span class='key'>  vcpApiKey</span> → <span class='val'>{}...{}</span>\n",
            &key[..key.len().min(4)],
            &key[key.len().saturating_sub(4)..]
        ));
        summary.push_str(&format!(
            "<span class='key'>  vcpLogKey</span> → <span class='val'>{}...{}</span>\n",
            &vcp_key[..vcp_key.len().min(4)],
            &vcp_key[vcp_key.len().saturating_sub(4)..]
        ));
    } else {
        summary.push_str(
            "<span class='key'>VCPChat</span> → <span class='val'>未检测到，跳过前端链接</span>\n"
        );
    }

    // Nova 注册状态
    for line in nova_status.lines() {
        summary.push_str(&format!(
            "<span class='key'>Nova</span> → <span class='val'>{}</span>\n",
            line
        ));
    }

    Ok(summary)
}

/// 基于 config.env.example 模板生成 config.env
fn generate_config_env(
    toolbox_dir: &Path,
    fields: &HashMap<String, String>,
) -> Result<std::path::PathBuf> {
    let example_path = toolbox_dir.join("config.env.example");
    let target_path = toolbox_dir.join("config.env");

    // 备份已有 config.env
    if target_path.exists() {
        let backup_path = toolbox_dir.join(format!(
            "config.env.{}.bak",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        ));
        fs::copy(&target_path, &backup_path)
            .with_context(|| format!("备份 config.env 失败"))?;
    }

    let mut content = if example_path.exists() {
        fs::read_to_string(&example_path)
            .with_context(|| format!("读取 config.env.example 失败"))?
    } else {
        bail!("未找到 config.env.example，请确认 VCPToolBox 已正确克隆");
    };

    // 定义所有需要替换的字段
    let env_fields = [
        // P0 - API 核心
        "API_URL", "API_Key",
        // P1 - 安全
        "Key", "Image_Key", "File_Key", "VCP_Key", "AdminUsername", "AdminPassword",
        // P2 - 个人信息
        "VarCity", "VarUser", "VarUserInfo", "VarSystemInfo", "VarHome", "VarVchatPath", "VarTeam",
        // P3 - 扩展功能
        "WeatherKey", "WeatherUrl", "BILIBILI_COOKIE", "TavilyKey", "SILICONFLOW_API_KEY",
    ];

    for key in &env_fields {
        if let Some(value) = fields.get(*key) {
            let sanitized = value.replace('\r', "").replace('\n', "");
            if !sanitized.is_empty() {
                content = replace_env_value(&content, key, &sanitized);
            }
        }
    }

    fs::write(&target_path, &content)
        .with_context(|| format!("写入 config.env 失败: {}", target_path.display()))?;

    Ok(target_path)
}

/// 更新 VCPChat 的 settings.json，链接前后端
fn update_vchat_settings(
    vchat_dir: &Path,
    fields: &HashMap<String, String>,
) -> Result<()> {
    let settings_path = vchat_dir.join("AppData").join("settings.json");

    // 如果 AppData 目录不存在则创建
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // 读取现有 settings 或创建新的
    let mut settings: serde_json::Value = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path)
            .with_context(|| "读取 settings.json 失败")?;
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let obj = settings.as_object_mut()
        .context("settings.json 格式异常")?;

    // 获取端口（默认6005）
    let port = fields.get("PORT")
        .map(|s| s.as_str())
        .unwrap_or("6005");

    // 设置 VCP 连接信息
    obj.insert(
        "vcpServerUrl".to_string(),
        serde_json::Value::String(format!("http://127.0.0.1:{}/v1/chat/completions", port)),
    );

    if let Some(key) = fields.get("Key") {
        obj.insert(
            "vcpApiKey".to_string(),
            serde_json::Value::String(key.clone()),
        );
    }

    obj.insert(
        "vcpLogUrl".to_string(),
        serde_json::Value::String(format!("ws://127.0.0.1:{}", port)),
    );

    if let Some(vcp_key) = fields.get("VCP_Key") {
        obj.insert(
            "vcpLogKey".to_string(),
            serde_json::Value::String(vcp_key.clone()),
        );
    }

    // 设置用户名（如果有）
    if let Some(user) = fields.get("VarUser") {
        if !user.is_empty() {
            obj.insert(
                "userName".to_string(),
                serde_json::Value::String(user.clone()),
            );
        }
    }

    // 写回
    let pretty = serde_json::to_string_pretty(&settings)
        .context("序列化 settings.json 失败")?;
    fs::write(&settings_path, pretty)
        .with_context(|| format!("写入 settings.json 失败: {}", settings_path.display()))?;

    Ok(())
}

// ==========================================
//  工具函数
// ==========================================

/// 在 config.env 内容中替换指定 key 的值
/// 支持 `KEY=val`、`#KEY=val`、`# KEY=val` 三种格式
fn replace_env_value(content: &str, key: &str, value: &str) -> String {
    let mut result = String::new();
    let mut replaced = false;

    for line in content.lines() {
        let trimmed = line.trim_start();
        let is_target = trimmed.starts_with(&format!("{}=", key))
            || trimmed.starts_with(&format!("#{}=", key))
            || trimmed.starts_with(&format!("# {}=", key));

        if is_target {
            if !replaced {
                result.push_str(&format!("{}={}\n", key, value));
                replaced = true;
            }
            // 跳过重复行
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    // 如果没找到该 key，追加到末尾
    if !replaced {
        result.push_str(&format!("{}={}\n", key, value));
    }

    result
}

/// 获取系统信息字符串
fn get_system_info() -> String {
    let info = os_info::get();
    format!("{} {} {}", info.os_type(), info.version(), std::env::consts::ARCH)
}// ==========================================
//  Nova Agent 注册
// ==========================================

/// 注册 Nova 默认 Agent（后端 agent_map.json + 前端 VCPChat Agent 目录）
fn register_nova(
    toolbox_dir: &Path,
    vchat_dir: &Path,
    _fields: &HashMap<String, String>,
) -> Result<String> {
    let mut status_lines: Vec<String> = Vec::new();

    // ======== 后端：更新 agent_map.json ========
    let map_path = toolbox_dir.join("agent_map.json");
    let nova_txt_path = toolbox_dir.join("Agent").join("Nova.txt");

    if nova_txt_path.exists() {
        // 读取或创建 agent_map.json
        let mut map: serde_json::Map<String, serde_json::Value> = if map_path.exists() {
            let raw = fs::read_to_string(&map_path)
                .with_context(|| "读取 agent_map.json 失败")?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            serde_json::Map::new()
        };

        // 添加 Nova 映射（如果不存在）
        if !map.contains_key("Nova") {
            map.insert(
                "Nova".to_string(),
                serde_json::Value::String("Nova.txt".to_string()),
            );
            let pretty = serde_json::to_string_pretty(&map)
                .context("序列化 agent_map.json 失败")?;
            fs::write(&map_path, &pretty)
                .with_context(|| "写入 agent_map.json 失败")?;
            status_lines.push("后端: agent_map.json 已添加 Nova 映射".to_string());
        } else {
            status_lines.push("后端: Nova 映射已存在，跳过".to_string());
        }
    } else {
        status_lines.push("后端: Agent/Nova.txt 未找到，跳过后端注册".to_string());
    }

    // ======== 前端：创建 VCPChat Agent 目录 ========
    if vchat_dir.exists() {
        let agents_base = vchat_dir.join("AppData").join("Agents");
        let userdata_base = vchat_dir.join("AppData").join("UserData");

        // 检查是否已经注册过 Nova（搜索已有的 Nova_* 目录）
        let already_registered = if agents_base.exists() {
            fs::read_dir(&agents_base)?
                .filter_map(|e| e.ok())
                .any(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.starts_with("Nova_") || name == "Nova"
                })
        } else {
            false
        };

        if already_registered {
            status_lines.push("前端: Nova Agent 已注册，跳过".to_string());
        } else {
            // 生成 agentId
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let agent_id = format!("Nova_{}", timestamp);

            // 创建目录
            let agent_dir = agents_base.join(&agent_id);
            let topic_dir = userdata_base.join(&agent_id).join("topics").join("default");
            fs::create_dir_all(&agent_dir)
                .with_context(|| format!("创建 Agent 目录失败: {}", agent_dir.display()))?;
            fs::create_dir_all(&topic_dir)
                .with_context(|| format!("创建 Topic 目录失败: {}", topic_dir.display()))?;

            // systemPrompt 使用 {{Nova}} 占位符，VCP messageProcessor 会自动注入 Agent/Nova.txt 内容
            let system_prompt = "{{Nova}}";

            // 创建 config.json
            let config = serde_json::json!({
                "name": "Nova",
                "systemPrompt": system_prompt,
                "model": "gemini-2.5-flash-preview-05-20",
                "temperature": 0.7,
                "contextTokenLimit": 1000000,
                "maxOutputTokens": 60000,
                "topics": [{
                    "id": "default",
                    "name": "主要对话",
                    "createdAt": timestamp
                }],
                "disableCustomColors": true,
                "useThemeColorsInChat": true
            });

            let config_pretty = serde_json::to_string_pretty(&config)
                .context("序列化 Nova config.json 失败")?;
            fs::write(agent_dir.join("config.json"), &config_pretty)
                .with_context(|| "写入 Nova config.json 失败")?;

            // 创建空的 history.json
            fs::write(topic_dir.join("history.json"), "[]")
                .with_context(|| "写入 Nova history.json 失败")?;

            status_lines.push(format!("前端: Nova Agent 已注册 (ID: {})", agent_id));
        }
    } else {
        status_lines.push("前端: VCPChat 目录不存在，跳过前端注册".to_string());
    }

    Ok(status_lines.join("\n"))
}
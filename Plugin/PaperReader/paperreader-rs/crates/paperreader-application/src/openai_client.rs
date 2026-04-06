use super::*;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

#[derive(Debug)]
pub(crate) struct OpenAiChatCompletionsClient {
    api_url: String,
    api_key: String,
    model: String,
    max_output_tokens: u32,
    semaphore: Semaphore,
    http: Client,
}

impl OpenAiChatCompletionsClient {
    pub(crate) fn new(
        api_url: String,
        api_key: String,
        model: String,
        max_output_tokens: u32,
        max_concurrent: usize,
    ) -> Result<Self> {
        let api_url = normalize_chat_completions_url(&api_url)?;
        let http = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .context("failed to build reqwest client")?;
        Ok(Self {
            api_url,
            api_key,
            model,
            max_output_tokens,
            semaphore: Semaphore::new(max_concurrent.max(1)),
            http,
        })
    }

    async fn send_chat(&self, messages: Vec<ChatMessage>) -> Result<String, LlmError> {
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| LlmError::Network("LLM semaphore closed".to_string()))?;

        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages,
            max_tokens: self.max_output_tokens,
        };

        let resp = self
            .http
            .post(&self.api_url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await
            .map_err(|err| LlmError::Network(err.to_string()))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|err| LlmError::Network(err.to_string()))?;

        if !status.is_success() {
            return Err(LlmError::Network(format!(
                "chat/completions failed: http_status={status}, body={}",
                snippet(&body)
            )));
        }

        let parsed: ChatCompletionResponse =
            serde_json::from_str(&body).map_err(|err| LlmError::Other(err.to_string()))?;
        parsed
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .ok_or_else(|| LlmError::Other("missing choices[0].message.content".to_string()))
    }
}

impl LlmClient for OpenAiChatCompletionsClient {
    fn generate(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, LlmError>> + Send + '_>> {
        let prompt = prompt.to_string();
        Box::pin(async move { self.send_chat(vec![ChatMessage::user(prompt)]).await })
    }

    fn generate_with_context(
        &self,
        prompt: &str,
        context: &[paperreader_reading::ContextMessage],
    ) -> Pin<Box<dyn Future<Output = Result<String, LlmError>> + Send + '_>> {
        let prompt = prompt.to_string();
        let mut messages = context
            .iter()
            .map(ChatMessage::from_context)
            .collect::<Vec<_>>();
        messages.push(ChatMessage::user(prompt));
        Box::pin(async move { self.send_chat(messages).await })
    }
}

#[derive(Debug, Clone, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(rename = "max_tokens")]
    max_tokens: u32,
}

#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

impl ChatMessage {
    fn user(content: String) -> Self {
        Self {
            role: "user".to_string(),
            content,
        }
    }

    fn from_context(message: &paperreader_reading::ContextMessage) -> Self {
        let role = match message.role {
            paperreader_reading::MessageRole::System => "system",
            paperreader_reading::MessageRole::User => "user",
            paperreader_reading::MessageRole::Assistant => "assistant",
        };
        Self {
            role: role.to_string(),
            content: message.content.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: ChatChoiceMessage,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

fn normalize_chat_completions_url(api_url: &str) -> Result<String> {
    let trimmed = api_url.trim();
    if trimmed.is_empty() {
        anyhow::bail!("API_URL must not be empty");
    }
    let url = trimmed.trim_end_matches('/');
    if url.ends_with("/chat/completions") {
        return Ok(url.to_string());
    }
    if url.ends_with("/v1") {
        return Ok(format!("{url}/chat/completions"));
    }
    Ok(format!("{url}/v1/chat/completions"))
}

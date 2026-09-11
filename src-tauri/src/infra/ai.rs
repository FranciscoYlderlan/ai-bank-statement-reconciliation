//! Motor de IA (backend nativo). Toda a extracao de transacoes passa por aqui:
//! o WebView manda prompts + documento; este modulo le a API key do cofre
//! (Credential Manager) e chama o provedor por HTTP (reqwest). A key NUNCA
//! transita pelo WebView nem aparece em logs/erros.
//!
//! Retorno: o TEXTO bruto da resposta do modelo (esperado: JSON). A validacao
//! de schema e o mapeamento para o dominio sao feitos no TS (adapters/ai).
//!
//! Erros seguem o formato "<categoria>: <mensagem>" para o TS traduzir em
//! mensagens claras: invalid_key | rate_limit | timeout | network | no_key | unknown.

use serde_json::{json, Value};
use std::time::Duration;

use crate::infra::secrets;

const REQUEST_TIMEOUT_SECS: u64 = 120;

fn secret_key_for(provider: &str) -> String {
    format!("ai.apikey.{provider}")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("unknown: falha ao criar cliente HTTP ({e})"))
}

fn api_key(provider: &str) -> Result<String, String> {
    match secrets::get(&secret_key_for(provider))? {
        Some(k) if !k.trim().is_empty() => Ok(k),
        _ => Err("no_key: nenhuma API key configurada para este provedor.".into()),
    }
}

/// Traduz status HTTP + corpo em uma categoria de erro estavel.
fn classify_http(status: u16, body: &str) -> String {
    match status {
        401 | 403 => "invalid_key: a API key foi recusada pelo provedor.".into(),
        429 => "rate_limit: limite de requisicoes atingido. Tente novamente em instantes.".into(),
        408 | 504 => "timeout: o provedor demorou para responder.".into(),
        500..=599 => format!("network: o provedor retornou erro {status}."),
        _ => {
            // nunca ecoa a key; corpo pode conter detalhes uteis do provedor
            let snippet: String = body.chars().take(300).collect();
            format!("unknown: resposta {status} do provedor. {snippet}")
        }
    }
}

fn map_reqwest_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout: o provedor demorou para responder.".into()
    } else if e.is_connect() {
        "network: nao foi possivel conectar ao provedor (verifique a internet).".into()
    } else {
        format!("network: falha de rede ({e}).")
    }
}

/// Requisicao unificada. `document_base64`/`document_mime` presentes = manda o
/// arquivo como documento nativo; ausentes = so texto (ja embutido no user_prompt).
pub struct CompleteArgs {
    pub provider: String,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub document_base64: Option<String>,
    pub document_mime: Option<String>,
    /// JSON Schema estrito para Structured Outputs "na fonte" (formato
    /// { name, strict, schema }). Usado hoje no OpenAI (response_format
    /// json_schema). Ausente = modo json_object generico. Sempre validado
    /// tambem no TS (adapters/ai/schema.ts) como rede de seguranca.
    pub response_schema: Option<Value>,
    /// forca resposta curta (usado no teste de conexao).
    pub ping: bool,
}

/// Logging (opcional) da resposta CRUA do modelo para diagnostico. Ligado por
/// variavel de ambiente CONCILIADOR_AI_DEBUG=1 (StdErr; nunca vaza a API key).
fn ai_debug_enabled() -> bool {
    matches!(std::env::var("CONCILIADOR_AI_DEBUG"), Ok(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

fn log_raw(provider: &str, model: &str, content: &str) {
    if ai_debug_enabled() {
        let snippet: String = content.chars().take(4000).collect();
        eprintln!("[ai:raw] {provider}/{model} => {snippet}");
    }
}

pub async fn complete(args: CompleteArgs) -> Result<String, String> {
    let key = api_key(&args.provider)?;
    let http = client()?;
    match args.provider.as_str() {
        "openai" => openai(&http, &key, &args).await,
        "anthropic" => anthropic(&http, &key, &args).await,
        "gemini" => gemini(&http, &key, &args).await,
        other => Err(format!("unknown: provedor nao suportado: {other}")),
    }
}

// ─────────────────────────────── OpenAI ───────────────────────────────

async fn openai(http: &reqwest::Client, key: &str, a: &CompleteArgs) -> Result<String, String> {
    let mut user_content = vec![json!({ "type": "text", "text": a.user_prompt })];
    if let (Some(b64), Some(mime)) = (&a.document_base64, &a.document_mime) {
        let data_url = format!("data:{mime};base64,{b64}");
        if mime.starts_with("image/") {
            user_content.push(json!({ "type": "image_url", "image_url": { "url": data_url } }));
        } else {
            user_content
                .push(json!({ "type": "file", "file": { "filename": "extrato.pdf", "file_data": data_url } }));
        }
    }
    // Structured Outputs "na fonte": quando ha schema (e nao e ping), forca
    // response_format json_schema strict; senao, json_object generico.
    let response_format = match (&a.response_schema, a.ping) {
        (Some(schema), false) => json!({ "type": "json_schema", "json_schema": schema }),
        _ => json!({ "type": "json_object" }),
    };
    let body = json!({
        "model": a.model,
        "temperature": 0,
        "response_format": response_format,
        "max_completion_tokens": if a.ping { 16 } else { 8192 },
        "messages": [
            { "role": "system", "content": a.system_prompt },
            { "role": "user", "content": user_content }
        ]
    });
    let resp = http
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(map_reqwest_error)?;
    if status != 200 {
        return Err(classify_http(status, &text));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("unknown: resposta OpenAI ilegivel ({e})"))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "bad_schema: OpenAI nao retornou conteudo de texto.".to_string())?;
    log_raw("openai", &a.model, content);
    Ok(content.to_string())
}

// ────────────────────────────── Anthropic ─────────────────────────────

async fn anthropic(http: &reqwest::Client, key: &str, a: &CompleteArgs) -> Result<String, String> {
    let mut content = vec![json!({ "type": "text", "text": a.user_prompt })];
    if let (Some(b64), Some(mime)) = (&a.document_base64, &a.document_mime) {
        if mime.starts_with("image/") {
            content.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": mime, "data": b64 }
            }));
        } else {
            content.push(json!({
                "type": "document",
                "source": { "type": "base64", "media_type": "application/pdf", "data": b64 }
            }));
        }
    }
    let body = json!({
        "model": a.model,
        "max_completion_tokens": if a.ping { 16 } else { 8192 },
        "temperature": 0,
        "system": a.system_prompt,
        "messages": [ { "role": "user", "content": content } ]
    });
    let resp = http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(map_reqwest_error)?;
    if status != 200 {
        return Err(classify_http(status, &text));
    }
    // NOTA: schema estrito no Anthropic exigiria tool-calling (tool_choice
    // forcando um tool cujo input_schema = schema). Mantido em json-via-prompt
    // por ora; a validacao estrita do TS cobre a rede de seguranca. `response_schema`
    // fica disponivel em CompleteArgs para essa evolucao futura.
    let _ = &a.response_schema;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("unknown: resposta Anthropic ilegivel ({e})"))?;
    let content = v["content"][0]["text"]
        .as_str()
        .ok_or_else(|| "bad_schema: Anthropic nao retornou conteudo de texto.".to_string())?;
    log_raw("anthropic", &a.model, content);
    Ok(content.to_string())
}

// ─────────────────────────────── Gemini ───────────────────────────────

async fn gemini(http: &reqwest::Client, key: &str, a: &CompleteArgs) -> Result<String, String> {
    let mut parts = vec![json!({ "text": a.user_prompt })];
    if let (Some(b64), Some(mime)) = (&a.document_base64, &a.document_mime) {
        parts.push(json!({ "inline_data": { "mime_type": mime, "data": b64 } }));
    }
    let body = json!({
        "system_instruction": { "parts": [ { "text": a.system_prompt } ] },
        "contents": [ { "role": "user", "parts": parts } ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "maxOutputTokens": if a.ping { 16 } else { 8192 }
        }
    });
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        a.model,
        urlencoding::encode(key)
    );
    let resp = http
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(map_reqwest_error)?;
    if status != 200 {
        return Err(classify_http(status, &text));
    }
    // NOTA: Gemini aceita responseSchema, mas num subconjunto OpenAPI que nao
    // cobre os union-null (["number","null"]) usados aqui. Mantido em
    // responseMimeType=application/json; validacao estrita fica no TS.
    let _ = &a.response_schema;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("unknown: resposta Gemini ilegivel ({e})"))?;
    let content = v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .ok_or_else(|| "bad_schema: Gemini nao retornou conteudo de texto.".to_string())?;
    log_raw("gemini", &a.model, content);
    Ok(content.to_string())
}

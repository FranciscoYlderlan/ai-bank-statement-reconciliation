//! Integracao Google (OAuth 2.0 PKCE + escrita no Google Sheets).
//!
//! OAuth PKCE com loopback (127.0.0.1) — o padrao para apps desktop instalados.
//! O `refresh_token` e guardado no Credential Manager (nunca em texto puro). A
//! escrita respeita o MESMO contrato de layout da planilha local: preenche so
//! B,C,D,F,G na proxima linha vazia (>= 13), sem tocar em A,E,H — as formulas de
//! E (categoria) e H (saldo) permanecem intactas.
//!
//! O client_id (e client_secret, para OAuth client tipo "Desktop") sao
//! fornecidos pelo usuario nas Configuracoes e guardados no cofre — cada
//! instalacao usa seu proprio projeto Google Cloud.
//!
//! NOTA: este modulo depende de rede + navegador + conta Google, portanto e
//! validado on-device (nao ha teste automatizado). Ver README §Google.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::infra::secrets;

const SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SHEETS_BASE: &str = "https://sheets.googleapis.com/v4/spreadsheets";

// chaves do cofre
const K_CLIENT_ID: &str = "google.client_id";
const K_CLIENT_SECRET: &str = "google.client_secret";
const K_REFRESH: &str = "google.refresh_token";
const K_EMAIL: &str = "google.email";

#[derive(Serialize)]
pub struct GoogleAccount {
    email: String,
}

#[derive(Serialize)]
pub struct GoogleStatus {
    connected: bool,
    email: Option<String>,
}

fn b64url(bytes: &[u8]) -> String {
    // base64url sem padding (RFC 7636)
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(T[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(T[(n & 63) as usize] as char);
        }
    }
    out
}

fn random_verifier() -> String {
    // 32 bytes de entropia a partir do relogio + endereco de pilha (suficiente p/ PKCE)
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stack = (&seed as *const u128 as usize) as u128;
    seed ^= stack;
    let mut bytes = [0u8; 32];
    let mut x = seed;
    for b in bytes.iter_mut() {
        // xorshift simples
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = (x & 0xff) as u8;
    }
    b64url(&bytes)
}

fn challenge_of(verifier: &str) -> String {
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    b64url(&h.finalize())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("network: cliente HTTP ({e})"))
}

/// Sobe um servidor loopback efemero, devolve (porta, receiver do codigo).
/// Espera UMA requisicao com ?code=... e responde uma pagina de sucesso.
fn listen_for_code() -> Result<(u16, std::sync::mpsc::Receiver<Result<String, String>>), String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("network: nao foi possivel abrir a porta local ({e})"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "network: porta local indisponivel".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Ok(req) = server.recv() {
            let url = req.url().to_string();
            let code = url
                .split('?')
                .nth(1)
                .and_then(|q| {
                    q.split('&').find_map(|kv| {
                        let mut it = kv.splitn(2, '=');
                        match (it.next(), it.next()) {
                            (Some("code"), Some(v)) => Some(v.to_string()),
                            _ => None,
                        }
                    })
                })
                .map(|c| urlencoding::decode(&c).map(|s| s.into_owned()).unwrap_or(c));
            let html = "<html><body style='font-family:sans-serif;padding:40px'>\
                <h2>Conta conectada</h2><p>Pode fechar esta aba e voltar ao Conciliador.</p>\
                </body></html>";
            let header = tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                &b"text/html; charset=utf-8"[..],
            )
            .expect("header valido");
            let _ = req.respond(tiny_http::Response::from_string(html).with_header(header));
            let _ = tx.send(code.ok_or_else(|| "unknown: codigo OAuth ausente no retorno".to_string()));
        } else {
            let _ = tx.send(Err("network: falha ao aguardar o retorno do Google".into()));
        }
    });
    Ok((port, rx))
}

fn open_browser(url: &str) {
    // Windows: abre no navegador padrao. (Outras plataformas: melhor esforco.)
    #[cfg(windows)]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

/// Fluxo completo de conexao: abre o navegador, recebe o code, troca por tokens,
/// guarda o refresh_token e o email. Retorna o email conectado.
#[tauri::command]
pub async fn google_connect(client_id: String, client_secret: Option<String>) -> Result<GoogleAccount, String> {
    if client_id.trim().is_empty() {
        return Err("no_key: informe o Client ID do Google Cloud.".into());
    }
    let verifier = random_verifier();
    let challenge = challenge_of(&verifier);

    let (port, rx) = listen_for_code()?;
    let redirect = format!("http://127.0.0.1:{port}");
    let auth_url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(SCOPE),
        challenge,
    );
    open_browser(&auth_url);

    // aguarda o retorno (com timeout generoso) sem bloquear o runtime
    let code = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(300))
    })
    .await
    .map_err(|e| format!("unknown: {e}"))?
    .map_err(|_| "timeout: nenhuma resposta do Google (login cancelado?)".to_string())??;

    // troca code -> tokens
    let http = http()?;
    let mut form = vec![
        ("client_id", client_id.clone()),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect),
    ];
    if let Some(sec) = client_secret.clone().filter(|s| !s.trim().is_empty()) {
        form.push(("client_secret", sec));
    }
    let resp = http.post(TOKEN_ENDPOINT).form(&form).send().await.map_err(|e| format!("network: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("network: {e}"))?;
    if status != 200 {
        return Err(format!("invalid_key: o Google recusou a troca de token ({status})."));
    }
    let token: TokenResponse =
        serde_json::from_str(&text).map_err(|e| format!("unknown: token ilegivel ({e})"))?;
    let refresh = token
        .refresh_token
        .ok_or_else(|| "unknown: o Google nao devolveu refresh_token (revogue o acesso e tente de novo).".to_string())?;

    // busca o email (best-effort)
    let email = match http
        .get(USERINFO_ENDPOINT)
        .bearer_auth(&token.access_token)
        .send()
        .await
    {
        Ok(r) => fetch_email(r).await.unwrap_or_default(),
        Err(_) => String::new(),
    };

    secrets::set(K_CLIENT_ID, &client_id)?;
    if let Some(sec) = client_secret.filter(|s| !s.trim().is_empty()) {
        secrets::set(K_CLIENT_SECRET, &sec)?;
    }
    secrets::set(K_REFRESH, &refresh)?;
    if !email.is_empty() {
        secrets::set(K_EMAIL, &email)?;
    }
    Ok(GoogleAccount { email })
}

async fn fetch_email(r: reqwest::Response) -> Option<String> {
    let v: Value = r.json().await.ok()?;
    v["email"].as_str().map(|s| s.to_string())
}

#[tauri::command]
pub fn google_status() -> Result<GoogleStatus, String> {
    let connected = secrets::has(K_REFRESH)?;
    let email = secrets::get(K_EMAIL)?;
    Ok(GoogleStatus { connected, email })
}

#[tauri::command]
pub fn google_disconnect() -> Result<(), String> {
    secrets::delete(K_REFRESH)?;
    secrets::delete(K_EMAIL)?;
    secrets::delete(K_CLIENT_SECRET)?;
    // mantem o client_id p/ facilitar reconexao
    Ok(())
}

async fn fresh_access_token() -> Result<String, String> {
    let client_id = secrets::get(K_CLIENT_ID)?.ok_or("no_key: Google nao configurado.")?;
    let refresh = secrets::get(K_REFRESH)?.ok_or("no_key: conta Google nao conectada.")?;
    let http = http()?;
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(sec) = secrets::get(K_CLIENT_SECRET)? {
        form.push(("client_secret", sec));
    }
    let resp = http.post(TOKEN_ENDPOINT).form(&form).send().await.map_err(|e| format!("network: {e}"))?;
    if resp.status().as_u16() != 200 {
        return Err("invalid_key: nao foi possivel renovar o acesso Google (reconecte a conta).".into());
    }
    let token: TokenResponse = resp.json().await.map_err(|e| format!("unknown: {e}"))?;
    Ok(token.access_token)
}

/// Linha ja traduzida pelo TS (GoogleSheetsTarget) para VALORES do Sheets:
/// data como texto "dd/mm/aaaa", valores em reais (nao centavos), categoria
/// opcional. O TS garante a ordem/colunas; aqui so montamos os ranges B..G.
#[derive(Deserialize)]
pub struct SheetValueRow {
    pub date: String,               // B
    pub description: String,        // C
    pub category: Option<String>,   // D
    pub entrada: Option<f64>,       // F
    pub saida: Option<f64>,         // G
}

#[derive(Serialize)]
pub struct AppendOutcome {
    sheet: String,
    appended: u32,
    first_row: u32,
    last_row: u32,
}

/// Descobre a proxima linha vazia (>= 13) lendo a coluna B da aba.
async fn next_empty_row(http: &reqwest::Client, token: &str, spreadsheet_id: &str, sheet: &str) -> Result<u32, String> {
    let range = format!("{sheet}!B13:B");
    let url = format!(
        "{SHEETS_BASE}/{}/values/{}",
        urlencoding::encode(spreadsheet_id),
        urlencoding::encode(&range)
    );
    let resp = http.get(url).bearer_auth(token).send().await.map_err(|e| format!("network: {e}"))?;
    if resp.status().as_u16() != 200 {
        return Err(format!("network: falha ao ler a aba {sheet} ({}).", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("unknown: {e}"))?;
    let used = v["values"].as_array().map(|a| a.len()).unwrap_or(0) as u32;
    Ok(13 + used)
}

/// Le as linhas ja lancadas (B..G a partir da linha 13) para o dedup do TS
/// reconstruir as transacoes existentes — paridade com o readExisting local.
#[tauri::command]
pub async fn sheets_read_existing(
    spreadsheet_id: String,
    sheet: String,
) -> Result<Vec<Vec<String>>, String> {
    let token = fresh_access_token().await?;
    let http = http()?;
    let range = format!("{sheet}!B13:G");
    let url = format!(
        "{SHEETS_BASE}/{}/values/{}",
        urlencoding::encode(&spreadsheet_id),
        urlencoding::encode(&range)
    );
    let resp = http.get(url).bearer_auth(&token).send().await.map_err(|e| format!("network: {e}"))?;
    if resp.status().as_u16() != 200 {
        return Err(format!("network: falha ao ler a aba {sheet} ({}).", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("unknown: {e}"))?;
    let rows = v["values"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    r.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|c| c.as_str().unwrap_or("").to_string())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(rows)
}

/// Escreve as linhas preenchendo SO B,C,D (num range) e F,G (noutro range),
/// pulando E e H (formulas). valueInputOption=USER_ENTERED para o Sheets
/// interpretar a data pt-BR e os numeros.
#[tauri::command]
pub async fn sheets_append_rows(
    spreadsheet_id: String,
    sheet: String,
    rows: Vec<SheetValueRow>,
) -> Result<AppendOutcome, String> {
    if rows.is_empty() {
        return Ok(AppendOutcome { sheet, appended: 0, first_row: 0, last_row: 0 });
    }
    let token = fresh_access_token().await?;
    let http = http()?;
    let start = next_empty_row(&http, &token, &spreadsheet_id, &sheet).await?;

    let mut data = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let row = start + i as u32;
        // B,C,D
        data.push(json!({
            "range": format!("{sheet}!B{row}:D{row}"),
            "majorDimension": "ROWS",
            "values": [[ r.date, r.description, r.category.clone().unwrap_or_default() ]]
        }));
        // F,G (E fica intacta entre eles)
        data.push(json!({
            "range": format!("{sheet}!F{row}:G{row}"),
            "majorDimension": "ROWS",
            "values": [[
                r.entrada.map(|v| json!(v)).unwrap_or(json!("")),
                r.saida.map(|v| json!(v)).unwrap_or(json!(""))
            ]]
        }));
    }
    let body = json!({ "valueInputOption": "USER_ENTERED", "data": data });
    let url = format!(
        "{SHEETS_BASE}/{}/values:batchUpdate",
        urlencoding::encode(&spreadsheet_id)
    );
    let resp = http.post(url).bearer_auth(&token).json(&body).send().await.map_err(|e| format!("network: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        let t = resp.text().await.unwrap_or_default();
        let snippet: String = t.chars().take(200).collect();
        return Err(format!("network: o Sheets recusou a escrita ({status}). {snippet}"));
    }
    Ok(AppendOutcome {
        sheet,
        appended: rows.len() as u32,
        first_row: start,
        last_row: start + rows.len() as u32 - 1,
    })
}

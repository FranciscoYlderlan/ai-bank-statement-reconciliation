//! Composicao / wiring do app desktop (Tauri v2). Rust cuida do I/O nativo,
//! backup imutavel e validacao do contrato de layout; o motor de conciliacao
//! (parsing, dedup, escrita cirurgica, dashboard) roda no WebView (TS testado)
//! e sera portado 1:1 para os use cases em `application/` na Fase 2.

pub mod domain;
pub mod application;
pub mod infra;

use serde::Serialize;
use std::fs;
use std::path::Path;

use domain::layout::{DONA_MARI_LAYOUT, EXPECTED_HEADER};
use infra::ai::{self, CompleteArgs};
use infra::backup::backup_file;
use infra::secrets;
use infra::xlsx_inspect::{header_row, sheet_names};

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Falha ao ler {path}: {e}"))
}

#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &bytes).map_err(|e| format!("Falha ao gravar {path}: {e}"))
}

/// T-BACKUP: backup imutavel ANTES de qualquer escrita. Se falhar, o front-end
/// NAO deve prosseguir com a gravacao.
#[tauri::command]
fn backup_before_write(path: String) -> Result<String, String> {
    backup_file(Path::new(&path)).map(|p| p.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct LayoutValidation {
    ok: bool,
    missing_sheets: Vec<String>,
    header_ok: bool,
    header_found: Vec<String>,
    message: String,
}

/// Contrato de Layout (§12.0): 12 abas de mes + `Categorias` + cabecalho na
/// linha 12. Bloqueia a importacao se divergir.
#[tauri::command]
fn validate_layout_contract(path: String) -> Result<LayoutValidation, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let names = sheet_names(&bytes).map_err(|e| e.to_string())?;

    let meses = [
        "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO",
        "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
    ];
    let mut missing: Vec<String> = meses
        .iter()
        .filter(|m| !names.iter().any(|n| n == *m))
        .map(|m| m.to_string())
        .collect();
    if !names.iter().any(|n| n == "Categorias") {
        missing.push("Categorias".to_string());
    }

    let sample = meses.iter().find(|m| names.iter().any(|n| n == **m));
    let (header_ok, header_found) = match sample {
        Some(m) => {
            let h = header_row(&bytes, m, DONA_MARI_LAYOUT.header_row).unwrap_or_default();
            let ok = EXPECTED_HEADER.iter().all(|e| h.iter().any(|c| c.trim() == *e));
            (ok, h)
        }
        None => (false, vec![]),
    };

    let ok = missing.is_empty() && header_ok;
    Ok(LayoutValidation {
        ok,
        missing_sheets: missing.clone(),
        header_ok,
        header_found,
        message: if ok {
            "Planilha compativel com o contrato de layout.".into()
        } else {
            format!(
                "Divergencia: abas ausentes {missing:?}; cabecalho {}.",
                if header_ok { "ok" } else { "fora do padrao na linha 12" }
            )
        },
    })
}

// ───────────────────────── Fase 2 — Segredos (Credential Manager) ─────────────

/// Grava/atualiza um segredo (ex.: API key de IA) no cofre do SO.
#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

/// Informa se um segredo existe — NUNCA devolve o valor.
#[tauri::command]
fn secret_has(key: String) -> Result<bool, String> {
    secrets::has(&key)
}

/// Remove um segredo (idempotente).
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
}

// ───────────────────────────── Fase 2 — Motor de IA ───────────────────────────

/// Extrai transacoes via IA. A key e lida do cofre no backend; retorna o TEXTO
/// (JSON) do modelo, validado depois no TS. Erros no formato "<categoria>: msg".
#[tauri::command]
async fn ai_complete(
    provider: String,
    model: String,
    system_prompt: String,
    user_prompt: String,
    document_base64: Option<String>,
    document_mime: Option<String>,
    response_schema: Option<serde_json::Value>,
) -> Result<String, String> {
    ai::complete(CompleteArgs {
        provider,
        model,
        system_prompt,
        user_prompt,
        document_base64,
        document_mime,
        response_schema,
        ping: false,
    })
    .await
}

#[derive(Serialize)]
pub struct AiTestResult {
    ok: bool,
    message: String,
}

/// Testa a conexao real com o provedor/modelo usando a key salva (ping curto).
#[tauri::command]
async fn ai_test_connection(provider: String, model: String) -> Result<AiTestResult, String> {
    let res = ai::complete(CompleteArgs {
        provider,
        model: model.clone(),
        system_prompt: "Responda apenas com o JSON {\"ok\":true}.".into(),
        user_prompt: "ping".into(),
        document_base64: None,
        document_mime: None,
        response_schema: None,
        ping: true,
    })
    .await;
    match res {
        Ok(_) => Ok(AiTestResult {
            ok: true,
            message: format!("Conectado ao modelo {model}."),
        }),
        Err(e) => {
            // devolve como sucesso-de-comando com ok=false p/ a UI mostrar a causa
            let msg = e
                .splitn(2, ':')
                .nth(1)
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| e.clone());
            Ok(AiTestResult { ok: false, message: msg })
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            backup_before_write,
            validate_layout_contract,
            secret_set,
            secret_has,
            secret_delete,
            ai_complete,
            ai_test_connection,
            infra::rules_store::store_read,
            infra::rules_store::store_write,
            infra::google::google_connect,
            infra::google::google_status,
            infra::google::google_disconnect,
            infra::google::sheets_append_rows,
            infra::google::sheets_read_existing,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o app Tauri");
}

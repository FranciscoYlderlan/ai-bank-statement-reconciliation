//! Armazenamento seguro de segredos (API keys de IA, tokens Google).
//!
//! No Windows, delega ao Credential Manager do SO via `keyring` (criptografia
//! por-usuario com DPAPI). A chave NUNCA e gravada em texto puro em disco, nem
//! em JSON, nem em localStorage/Zustand persistido — cumprindo o requisito
//! nao-funcional de seguranca (Fase 1/2).
//!
//! Escolha documentada: preferimos o Credential Manager ao Stronghold porque
//! nao exige uma "senha-mestra" do usuario final (a Cantina Bom Prato nao precisa
//! decorar mais uma senha) — o SO cuida da criptografia por conta do usuario
//! logado.

use keyring::Entry;

const SERVICE: &str = "com.bomprato.conciliador";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("unknown: cofre indisponivel ({e})"))
}

/// Grava (ou substitui) um segredo.
pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("unknown: falha ao gravar segredo ({e})"))
}

/// Retorna o valor do segredo (uso INTERNO no backend — nunca exposto ao WebView).
pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("unknown: falha ao ler segredo ({e})")),
    }
}

/// Apenas informa se existe — NAO devolve o valor.
pub fn has(key: &str) -> Result<bool, String> {
    Ok(get(key)?.is_some())
}

/// Remove o segredo (idempotente: apagar inexistente e sucesso).
pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("unknown: falha ao remover segredo ({e})")),
    }
}

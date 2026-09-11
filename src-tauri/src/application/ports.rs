//! Portas (traits) — a fronteira testavel. Nenhum use case importa rusqlite,
//! reqwest, zip ou windows: recebe estas traits por injecao.
use crate::domain::competence::Competence;
use crate::domain::layout::SheetRowLayout;
use crate::domain::transaction::Transaction;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PortError {
    #[error("parse: {0}")]
    Parse(String),
    #[error("write: {0}")]
    Write(String),
    #[error("repo: {0}")]
    Repo(String),
    #[error("backup: {0}")]
    Backup(String),
    #[error("io: {0}")]
    Io(String),
}

pub struct RawStatement {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// Porta de ENTRADA — extracao (parser deterministico ou IA).
pub trait StatementParser {
    fn id(&self) -> &str;
    fn parse(&self, input: &RawStatement) -> Result<Vec<Transaction>, PortError>;
}

pub struct SheetRow {
    pub date_serial: i64,
    pub description: String,
    pub category: Option<String>,
    pub entrada_cents: Option<i64>,
    pub saida_cents: Option<i64>,
}

pub struct AppendOutcome {
    pub sheet: String,
    pub appended: usize,
    pub first_row: u32,
    pub last_row: u32,
}

/// Porta de SAIDA — XLSX local (COM/lib) e Google Sheets.
pub trait SpreadsheetTarget {
    fn sheet_names(&self) -> Result<Vec<String>, PortError>;
    fn read_existing(
        &self,
        sheet: &str,
        layout: &SheetRowLayout,
    ) -> Result<Vec<Transaction>, PortError>;
    fn append_rows(
        &mut self,
        sheet: &str,
        rows: &[SheetRow],
        layout: &SheetRowLayout,
    ) -> Result<AppendOutcome, PortError>;
}

/// Cache/historico local (SQLite).
pub trait LedgerRepository {
    fn known_hashes(&self, comp: &Competence) -> Result<HashSet<String>, PortError>;
    fn append_ledger(&mut self, hashes: &[String], comp: &Competence) -> Result<(), PortError>;
}

/// Backup imutavel antes de qualquer escrita (§13 / T-BACKUP).
pub trait BackupService {
    fn backup(&self, file_id: &str) -> Result<PathBuf, PortError>;
}

pub trait Clock {
    fn now_iso(&self) -> String;
}

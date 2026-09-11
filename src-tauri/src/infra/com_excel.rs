//! Escrita local via COM automation do Excel (PLANO A, §12.1) — Windows-only.
//! E o proprio Excel quem escreve, garantindo preservacao de formulas, merges,
//! dropdown (extLst) e dashboard. Exige Excel instalado.
//!
//! Este modulo e o ponto de extensao da Fase 2 para escrita nativa. A assinatura
//! ja implementa a porta `SpreadsheetTarget`. O metodo `append_rows` preenche
//! apenas B,C,D,F,G na proxima linha vazia (invariante T-NOFORMULA).
#![cfg(windows)]

use crate::application::ports::{AppendOutcome, PortError, SheetRow, SpreadsheetTarget};
use crate::domain::layout::SheetRowLayout;
use crate::domain::transaction::Transaction;

pub struct ComExcelWriter {
    pub path: String,
}

impl ComExcelWriter {
    pub fn open(path: &str) -> Result<Self, PortError> {
        // TODO Fase 2: CoInitializeEx + CreateInstance("Excel.Application"),
        // Workbooks.Open(path). Mantido como esqueleto para nao exigir Excel no CI.
        Ok(ComExcelWriter { path: path.to_string() })
    }
}

impl SpreadsheetTarget for ComExcelWriter {
    fn sheet_names(&self) -> Result<Vec<String>, PortError> {
        Err(PortError::Write(
            "COM writer: implementar via Workbook.Sheets (Fase 2)".into(),
        ))
    }

    fn read_existing(
        &self,
        _sheet: &str,
        _layout: &SheetRowLayout,
    ) -> Result<Vec<Transaction>, PortError> {
        Err(PortError::Write("COM writer: read_existing (Fase 2)".into()))
    }

    fn append_rows(
        &mut self,
        _sheet: &str,
        _rows: &[SheetRow],
        _layout: &SheetRowLayout,
    ) -> Result<AppendOutcome, PortError> {
        // Invariante: localizar proxima linha vazia (>= first_data_row) e escrever
        // SO em B,C,D,F,G via Range(...).Value2 = ...; nunca A,E,H.
        Err(PortError::Write("COM writer: append_rows (Fase 2)".into()))
    }
}

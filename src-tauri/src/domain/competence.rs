//! Competencia = mes/ano ao qual a transacao pertence (pela sua data).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Competence {
    pub year: i32,
    pub month: u8, // 1..=12
}

impl Competence {
    pub fn key(&self) -> String {
        format!("{:04}-{:02}", self.year, self.month)
    }
}

const MESES: [&str; 12] = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO",
    "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

/// MonthSheetResolver — numero do mes -> nome da aba PT-BR (C1).
pub fn month_sheet_name(c: &Competence) -> &'static str {
    MESES[(c.month as usize) - 1]
}

pub const SUPPORT_SHEETS: [&str; 3] = ["Categorias", "FLUXO DE CAIXA  SIMPLIFICADO", "ANÁLISE"];

pub fn is_support_sheet(name: &str) -> bool {
    SUPPORT_SHEETS
        .iter()
        .any(|s| s.eq_ignore_ascii_case(name.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapeia_mes_para_aba() {
        assert_eq!(month_sheet_name(&Competence { year: 2026, month: 7 }), "JULHO");
        assert_eq!(month_sheet_name(&Competence { year: 2026, month: 8 }), "AGOSTO");
    }

    #[test]
    fn chave_de_competencia() {
        assert_eq!(Competence { year: 2026, month: 7 }.key(), "2026-07");
    }
}

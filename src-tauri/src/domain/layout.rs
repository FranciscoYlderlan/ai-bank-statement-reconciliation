//! Contrato de Layout da aba de mes (§12.0) — constantes que dirigem escrita/testes.

pub struct Columns {
    pub date: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub flow: &'static str,
    pub entrada: &'static str,
    pub saida: &'static str,
    pub saldo: &'static str,
}

pub struct SheetRowLayout {
    pub header_row: u32,
    pub first_data_row: u32,
    pub columns: Columns,
    pub forbidden_columns: [&'static str; 3],
    pub writable_columns: [&'static str; 5],
}

/// Layout observado na planilha real Cantina Bom Prato.
pub const DONA_MARI_LAYOUT: SheetRowLayout = SheetRowLayout {
    header_row: 12,
    first_data_row: 13,
    columns: Columns {
        date: "B",
        description: "C",
        category: "D",
        flow: "E",
        entrada: "F",
        saida: "G",
        saldo: "H",
    },
    forbidden_columns: ["A", "E", "H"],
    writable_columns: ["B", "C", "D", "F", "G"],
};

pub const EXPECTED_HEADER: [&str; 7] = [
    "Data",
    "Descrição",
    "Categoria",
    "Fluxo de Caixa",
    "Entrada",
    "Saída",
    "Saldo",
];

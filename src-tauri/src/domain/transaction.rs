//! Transaction — entidade central (C2: valor absoluto + direcao separada).
use super::competence::Competence;
use super::money::{Direction, Money};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct PlainDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

#[derive(Debug, Clone)]
pub struct AccountRef {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct Transaction {
    pub date: PlainDate,
    pub description: String,
    pub direction: Direction,
    pub amount: Money,
    pub category: Option<String>, // None no MVP (§3.1)
    pub account: AccountRef,
    pub balance_after: Option<Money>,
    pub source_order: u32,   // desempatador de dedup (C4)
    pub raw_line: String,
}

impl Transaction {
    pub fn competence(&self) -> Competence {
        Competence {
            year: self.date.year,
            month: self.date.month,
        }
    }
}

/// Hash de deduplicacao (C4/§11) com desempatador `ordinal_no_dia`.
pub fn transaction_hash(tx: &Transaction, ordinal_no_dia: u32) -> String {
    let dir = match tx.direction {
        Direction::Credit => "credit",
        Direction::Debit => "debit",
    };
    let payload = format!(
        "{}-{}-{}|{}|{}|{}|{}|{}",
        tx.date.year,
        tx.date.month,
        tx.date.day,
        dir,
        tx.amount.cents,
        tx.description.trim().to_uppercase(),
        tx.account.id,
        ordinal_no_dia
    );
    let mut h = Sha256::new();
    h.update(payload.as_bytes());
    format!("{:x}", h.finalize())
}

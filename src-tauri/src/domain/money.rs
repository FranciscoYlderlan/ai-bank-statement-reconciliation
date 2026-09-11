//! Money — dinheiro como `Decimal`/centavos, NUNCA f64 (T-MONEY).
use rust_decimal::Decimal;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Credit, // Entrada
    Debit,  // Saida
}

/// Valor monetario sempre positivo; a direcao fica na Transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Money {
    pub cents: i64,
}

impl Money {
    pub fn from_cents(c: i64) -> Self {
        Money { cents: c.abs() }
    }

    pub fn from_reais(d: Decimal) -> Self {
        let cents = (d * Decimal::from(100)).round();
        Money {
            cents: cents.to_string().parse::<i64>().unwrap_or(0).abs(),
        }
    }

    pub fn format_pt_br(&self) -> String {
        let int = self.cents / 100;
        let dec = (self.cents % 100).abs();
        format!("R$ {},{:02}", thousands(int), dec)
    }
}

fn thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push('.');
        }
        out.push(ch);
    }
    let rev: String = out.chars().rev().collect();
    if n < 0 {
        format!("-{rev}")
    } else {
        rev
    }
}

/// Parse de "R$ 1.234,56", "- R$ 24,00", "R$ 0,56" -> (Money, direcao pelo sinal).
pub fn parse_money_pt_br(raw: &str) -> Result<(Money, Option<Direction>), String> {
    let is_neg = raw.trim_start().starts_with('-') || raw.contains("-R$") || raw.contains("- R$");
    let cleaned: String = raw
        .replace("R$", "")
        .replace(['(', ')'], "")
        .replace(['-', ' '], "")
        .replace('.', "")
        .replace(',', ".");
    if cleaned.is_empty() {
        return Err(format!("valor vazio: {raw}"));
    }
    let dec = Decimal::from_str(&cleaned).map_err(|e| format!("valor invalido {raw}: {e}"))?;
    let money = Money::from_reais(dec);
    Ok((money, if is_neg { Some(Direction::Debit) } else { None }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valores_pt_br() {
        assert_eq!(parse_money_pt_br("R$ 1.234,56").unwrap().0.cents, 123456);
        let (m, d) = parse_money_pt_br("- R$ 24,00").unwrap();
        assert_eq!(m.cents, 2400);
        assert_eq!(d, Some(Direction::Debit));
        assert_eq!(parse_money_pt_br("R$ 0,56").unwrap().0.cents, 56);
    }

    #[test]
    fn soma_sem_erro_de_float() {
        let a = Money::from_cents(10);
        let b = Money::from_cents(20);
        assert_eq!(Money::from_cents(a.cents + b.cents).cents, 30);
    }

    #[test]
    fn formata_pt_br() {
        assert_eq!(Money::from_cents(123456).format_pt_br(), "R$ 1.234,56");
        assert_eq!(Money::from_cents(49446).format_pt_br(), "R$ 494,46");
    }
}

/**
 * Money — valor monetario representado SEMPRE como inteiro de centavos.
 * Nunca usa `number` de ponto flutuante para armazenar dinheiro (evita erro de
 * arredondamento). Requisito nao-funcional T-MONEY da especificacao.
 */
export class Money {
  /** valor absoluto em centavos, sempre >= 0 */
  readonly cents: number;

  private constructor(cents: number) {
    if (!Number.isInteger(cents)) {
      throw new Error(`Money exige inteiro de centavos, recebido: ${cents}`);
    }
    this.cents = Math.abs(cents);
  }

  static fromCents(cents: number): Money {
    return new Money(cents);
  }

  /** Cria a partir de reais (ex.: 1234.56 -> 123456 centavos), arredondando. */
  static fromReais(reais: number): Money {
    return new Money(Math.round(reais * 100));
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  get reais(): number {
    return this.cents / 100;
  }

  /** Formata em pt-BR: 123456 -> "R$ 1.234,56" */
  format(): string {
    const neg = this.cents < 0;
    const abs = Math.abs(this.cents);
    const int = Math.floor(abs / 100).toString();
    const dec = (abs % 100).toString().padStart(2, "0");
    const withThousands = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${neg ? "-" : ""}R$ ${withThousands},${dec}`;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}

export type Direction = "credit" | "debit"; // credit = Entrada, debit = Saida

export interface ParsedAmount {
  money: Money;
  /** direcao inferida pelo sinal, quando presente. undefined = indeterminado. */
  signDirection?: Direction;
}

/**
 * Faz o parse de um valor monetario em formato pt-BR.
 * Aceita: "R$ 1.234,56", "- R$ 24,00", "R$ 32,00", "1.234,56", "-1234,56",
 *         "R$ 0,56", "1234.56" (fallback ponto decimal).
 * O sinal negativo (prefixo "-" antes de R$ ou do numero) indica Debito.
 */
export function parseMoneyPtBr(raw: string): ParsedAmount {
  const trimmed = raw.trim();
  const isNegative = /^-|\(\s*R\$/.test(trimmed) || /-\s*R\$/.test(trimmed);

  // remove "R$", espacos e o sinal, ficando so com digitos, ponto e virgula
  let numeric = trimmed
    .replace(/R\$/gi, "")
    .replace(/[()]/g, "")
    .replace(/\s/g, "")
    .replace(/^-/, "")
    .replace(/-/g, "");

  if (numeric === "") {
    throw new Error(`Valor monetario vazio: "${raw}"`);
  }

  let cents: number;
  if (numeric.includes(",")) {
    // formato pt-BR: ponto = milhar, virgula = decimal
    const normalized = numeric.replace(/\./g, "").replace(",", ".");
    cents = Math.round(parseFloat(normalized) * 100);
  } else if (/\.\d{2}$/.test(numeric)) {
    // fallback: ponto decimal "1234.56"
    cents = Math.round(parseFloat(numeric) * 100);
  } else {
    // apenas digitos, sem decimais -> reais inteiros
    cents = parseInt(numeric.replace(/\./g, ""), 10) * 100;
  }

  if (Number.isNaN(cents)) {
    throw new Error(`Nao foi possivel interpretar o valor: "${raw}"`);
  }

  return {
    money: Money.fromCents(cents),
    signDirection: isNegative ? "debit" : undefined,
  };
}

import { describe, it, expect } from "vitest";
import { Money, parseMoneyPtBr } from "../src/domain/money";
import { parseDatePtBr, toExcelSerial, toIso } from "../src/domain/dateptbr";
import { competenceOf, competenceKey, monthSheetName } from "../src/domain/competence";
import { normalizeDescription, comparisonKey } from "../src/domain/normalize";
import { sha256Hex } from "../src/domain/sha256";
import {
  Transaction,
  withDedupHashes,
  competence,
} from "../src/domain/transaction";
import { PlainDate } from "../src/domain/dateptbr";

const acc = { id: "stone-892952680", label: "Stone" };
function tx(over: Partial<Transaction> & { date: PlainDate }): Transaction {
  return {
    description: "PIX",
    direction: "credit",
    amount: Money.fromReais(25),
    account: acc,
    sourceOrder: 0,
    rawLine: "",
    ...over,
  };
}

describe("Money / parseMoneyPtBr (T-MONEY)", () => {
  it("armazena dinheiro como centavos inteiros, nunca float", () => {
    expect(Money.fromReais(1234.56).cents).toBe(123456);
    expect(Money.fromCents(56).cents).toBe(56);
  });

  it("parseia 'R$ 1.234,56' -> 123456 centavos, credito", () => {
    const r = parseMoneyPtBr("R$ 1.234,56");
    expect(r.money.cents).toBe(123456);
    expect(r.signDirection).toBeUndefined();
  });

  it("parseia '- R$ 24,00' -> 2400 centavos, debito", () => {
    const r = parseMoneyPtBr("- R$ 24,00");
    expect(r.money.cents).toBe(2400);
    expect(r.signDirection).toBe("debit");
  });

  it("parseia 'R$ 0,56' (tarifa) corretamente", () => {
    expect(parseMoneyPtBr("R$ 0,56").money.cents).toBe(56);
  });

  it("somatorio de centavos bate centavo a centavo (sem erro de f64)", () => {
    // 0.1 + 0.2 em float daria 0.30000000000000004
    const soma = Money.fromReais(0.1).add(Money.fromReais(0.2));
    expect(soma.cents).toBe(30);
    expect(soma.format()).toBe("R$ 0,30");
  });

  it("formata em pt-BR", () => {
    expect(Money.fromCents(123456).format()).toBe("R$ 1.234,56");
    expect(Money.fromCents(49446).format()).toBe("R$ 494,46");
  });
});

describe("Datas pt-BR", () => {
  it("dd/mm/aa assume seculo 20xx", () => {
    expect(toIso(parseDatePtBr("07/08/26"))).toBe("2026-08-07");
  });
  it("dd/mm/aaaa completo", () => {
    expect(toIso(parseDatePtBr("17/07/2026"))).toBe("2026-07-17");
  });
  it("rejeita mes invalido", () => {
    expect(() => parseDatePtBr("07/13/26")).toThrow();
  });
  it("numero de serie Excel correto", () => {
    // 2026-07-07 -> serial conhecido
    expect(toExcelSerial(parseDatePtBr("07/07/2026"))).toBe(46210);
  });
});

describe("Competencia (C5)", () => {
  it("deriva da data da transacao, nao do arquivo", () => {
    const c = competenceOf(parseDatePtBr("07/08/26"));
    expect(competenceKey(c)).toBe("2026-08");
  });
  it("mapeia numero do mes -> nome da aba PT-BR (C1)", () => {
    expect(monthSheetName({ year: 2026, month: 7 })).toBe("JULHO");
    expect(monthSheetName({ year: 2026, month: 8 })).toBe("AGOSTO");
    expect(monthSheetName({ year: 2026, month: 3 })).toBe("MARÇO");
  });
});

describe("Normalizacao (§7.1)", () => {
  it("junta contraparte multi-linha", () => {
    expect(normalizeDescription("MARIA DE FATIMA ROCHA\nCARVALHO", "Transferência | Pix")).toBe(
      "MARIA DE FATIMA ROCHA CARVALHO Transferência | Pix",
    );
  });
  it("chave de comparacao remove acento e caixa", () => {
    expect(comparisonKey("Transferência | Pix")).toBe("TRANSFERENCIA | PIX");
  });
});

describe("SHA-256 puro", () => {
  it("hash conhecido de 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("hash de string vazia", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("Deduplicacao com ordinalNoDia (C4)", () => {
  it("3 Pix identicos no mesmo dia geram 3 hashes distintos", () => {
    const d = parseDatePtBr("04/08/26");
    const txs = [
      tx({ date: d, sourceOrder: 0 }),
      tx({ date: d, sourceOrder: 1 }),
      tx({ date: d, sourceOrder: 2 }),
    ];
    const hashes = withDedupHashes(txs).map((x) => x.hash);
    expect(new Set(hashes).size).toBe(3);
    expect(withDedupHashes(txs).map((x) => x.ordinalNoDia)).toEqual([0, 1, 2]);
  });

  it("mesmo arquivo processado 2x gera os MESMOS hashes (idempotencia)", () => {
    const d = parseDatePtBr("04/08/26");
    const txs = [tx({ date: d, sourceOrder: 0 }), tx({ date: d, sourceOrder: 1 })];
    const run1 = withDedupHashes(txs).map((x) => x.hash);
    const run2 = withDedupHashes(txs).map((x) => x.hash);
    expect(run1).toEqual(run2);
  });

  it("competence() usa a data da transacao", () => {
    expect(competenceKey(competence(tx({ date: parseDatePtBr("15/07/2026") })))).toBe("2026-07");
  });
});

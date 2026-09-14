import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isPagBankStatement,
  readHeader,
  parsePagBankPages,
  isTrustworthy,
  rejectionReason,
  PAGBANK_PARSER_ID,
} from "../src/adapters/parsers/pagbankPdf";
import { HybridStatementParser, MemoPageTextExtractor, StrategyInfo } from "../src/adapters/parsers/hybrid";
import { RawStatement, StatementParser } from "../src/application/ports";
import { Transaction } from "../src/domain/transaction";
import { competenceKey, competenceOf } from "../src/domain/competence";

/**
 * Extrato PagBank/PagSeguro — leitura DETERMINISTICA, conferida pela cadeia de
 * "Saldo do dia". A fixture e o texto que o pdf.js produz para um extrato real
 * de 2 paginas (15/07 a 14/08), com a virada de pagina caindo no meio do dia
 * 10/08: os lancamentos terminam numa pagina e o saldo do dia abre a seguinte.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pages: string[] = JSON.parse(
  readFileSync(join(here, "fixtures", "pagbank_pages.json"), "utf-8"),
);
const texto = pages.join("\n");

/** PDF minimo so para o roteador reconhecer a assinatura %PDF. */
const pdfRaw: RawStatement = {
  fileName: "15072026_14082026.pdf",
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
};

describe("reconhecimento do layout PagBank", () => {
  it("reconhece o extrato real", () => {
    expect(isPagBankStatement(texto)).toBe(true);
  });

  it("exige emissor + documento + colunas juntos (uma marca solta nao basta)", () => {
    expect(isPagBankStatement("PagSeguro Internet S/A")).toBe(false);
    expect(isPagBankStatement("Extrato da conta\nData Descrição Valor")).toBe(false);
    expect(isPagBankStatement("Stone\nExtrato\nData Descrição Valor")).toBe(false);
  });

  it("le instituicao, agencia, conta e periodo do cabecalho", () => {
    const h = readHeader(texto);
    expect(h.instituicao).toContain("PagSeguro");
    expect(h.agencia).toBe("0001");
    expect(h.conta).toBe("99887766-3");
    expect(h.periodoInicio).toEqual({ year: 2026, month: 7, day: 15 });
    expect(h.periodoFim).toEqual({ year: 2026, month: 8, day: 14 });
  });
});

describe("extracao deterministica do extrato real", () => {
  const r = parsePagBankPages(pages);

  it("le os 22 lancamentos e descarta as 15 linhas de saldo do dia", () => {
    expect(r.transactions.length).toBe(22);
    expect(r.transactions.some((t) => /saldo do dia/i.test(t.description))).toBe(false);
    expect(r.unread).toEqual([]);
  });

  it("valor negativo vira saida; o resto, entrada", () => {
    const saidas = r.transactions.filter((t) => t.direction === "debit");
    expect(saidas.map((t) => t.amount.cents)).toEqual([45600, 40000, 30000]);
    expect(saidas.every((t) => t.amount.cents > 0)).toBe(true); // valor sempre positivo
    const pix = r.transactions.find((t) => t.description.includes("Bumba Acai"))!;
    expect(pix.direction).toBe("credit");
    expect(pix.amount.cents).toBe(45000);
  });

  it("le centavos sem perder precisao", () => {
    const rendimento = r.transactions.find((t) => t.description.startsWith("Rendimento"))!;
    expect(rendimento.amount.cents).toBe(2); // R$ 0,02
  });

  it("preserva a ordem do arquivo, inclusive atravessando a pagina", () => {
    expect(r.transactions.map((t) => t.sourceOrder)).toEqual(
      r.transactions.map((_, i) => i),
    );
    const ultimaP1 = r.transactions[15];
    expect(ultimaP1.date).toEqual({ year: 2026, month: 8, day: 10 });
    expect(r.transactions[16].description).toContain("Bumba Acai");
  });

  it("a conta e a mesma que a extracao por IA produziria (dedup consistente)", () => {
    expect(r.transactions[0].account.id).toBe("pagseguro-998877663");
    expect(r.transactions[0].account.label).toContain("Conta 99887766-3");
  });

  it("cobre as duas competencias do periodo", () => {
    const comps = r.transactions.map((t) => competenceKey(competenceOf(t.date)));
    expect(comps.filter((c) => c === "2026-07").length).toBe(7);
    expect(comps.filter((c) => c === "2026-08").length).toBe(15);
  });
});

describe("conferencia pela cadeia de saldo — a prova de que a leitura fechou", () => {
  it("todos os dias do extrato real fecham", () => {
    const r = parsePagBankPages(pages);
    expect(r.audit.divergentes).toBe(0);
    expect(r.audit.foraDoPeriodo).toBe(0);
    expect(r.audit.conferidos).toBeGreaterThan(10);
    expect(isTrustworthy(r)).toBe(true);
    expect(rejectionReason(r)).toBeNull();
  });

  it("lancamento FALTANDO quebra a conferencia (nao passa em silencio)", () => {
    // remove uma das duas vendas de 05/08 sem mexer no saldo daquele dia
    const mutiladas = pages.map((p) =>
      p.split("\n").filter((l) => !l.includes("05/08/2026 Vendas - Disponivel DEBITO VISA")).join("\n"),
    );
    const r = parsePagBankPages(mutiladas);
    expect(r.audit.divergentes).toBeGreaterThan(0);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/cadeia de saldo/i);
  });

  it("lancamento DUPLICADO tambem quebra a conferencia", () => {
    const infladas = [...pages];
    infladas[1] = infladas[1].replace(
      "11/08/2026 Pix recebido - Bumba Acai R$ 450,00",
      "11/08/2026 Pix recebido - Bumba Acai R$ 450,00\n11/08/2026 Pix recebido - Bumba Acai R$ 450,00",
    );
    const r = parsePagBankPages(infladas);
    expect(r.transactions.length).toBe(23);
    expect(isTrustworthy(r)).toBe(false);
  });

  it("linha que o parser nao entende invalida a leitura", () => {
    const comRuido = [...pages];
    comRuido[1] += "\n13/08/2026 Transferência agendada para 3x de";
    const r = parsePagBankPages(comRuido);
    expect(r.unread.length).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/não reconhecida/i);
  });

  it("sem saldo do dia nenhum, a leitura nao e aceita (nada a conferir)", () => {
    const semSaldo = pages.map((p) =>
      p.split("\n").filter((l) => !/saldo do dia/i.test(l)).join("\n"),
    );
    const r = parsePagBankPages(semSaldo);
    expect(r.transactions.length).toBe(22);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/saldo do dia/i);
  });
});

/* ── roteamento deterministico → IA ─────────────────────────────────────── */

function fakeAi(txs: Transaction[] = []): StatementParser & { chamado: boolean } {
  const p = {
    id: "ai",
    chamado: false,
    canParse: () => true,
    parse: async () => {
      p.chamado = true;
      return txs;
    },
  };
  return p;
}

const extractor = (p: string[]) => ({ extractPages: async () => p });

describe("HybridStatementParser — determinístico primeiro, IA para o resto", () => {
  it("layout conhecido e conferido: a leitura provada decide, e a IA nao e a leitura", async () => {
    const ai = fakeAi();
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai,
      pdfText: extractor(pages),
      onStrategy: (i) => (info = i),
      // a conferencia por IA tem teste proprio (T-ARBITRAGEM); aqui o que
      // interessa e que o deterministico decidiu sozinho
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() } as never,
    });
    const txs = await h.parse(pdfRaw);
    expect(txs.length).toBe(22);
    expect(ai.chamado).toBe(false);
    expect(info?.kind).toBe("deterministic");
    expect(info?.parserId).toBe(PAGBANK_PARSER_ID);
    expect(info?.nivel).toBe("provada");
  });

  it("layout desconhecido: entrega para a IA", async () => {
    const ai = fakeAi([{ ...parsePagBankPages(pages).transactions[0] }]);
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai,
      pdfText: extractor(["Stone Instituicao de Pagamento\nExtrato\n01/07/2026 algo 10,00"]),
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() } as never,
    });
    const txs = await h.parse(pdfRaw);
    expect(ai.chamado).toBe(true);
    expect(txs.length).toBe(1);
    expect(info?.kind).toBe("ai");
    expect(info?.reason).toBeUndefined(); // nem tentou: nao e layout conhecido
  });

  it("layout conhecido MAS com conferencia furada: cai para a IA, com o motivo", async () => {
    const mutiladas = pages.map((p) =>
      p.split("\n").filter((l) => !l.includes("05/08/2026 Vendas - Disponivel DEBITO VISA")).join("\n"),
    );
    const ai = fakeAi([]);
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai,
      pdfText: extractor(mutiladas),
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() } as never,
    });
    await h.parse(pdfRaw);
    expect(ai.chamado).toBe(true);
    expect(info?.kind).toBe("ai");
    expect(info?.reason).toMatch(/cadeia de saldo/i);
  });

  it("arquivo que nao e PDF (OFX/CSV) vai direto para a IA", async () => {
    const ai = fakeAi([]);
    const h = new HybridStatementParser({ ai, pdfText: extractor(pages) });
    await h.parse({
      fileName: "extrato.csv",
      bytes: new TextEncoder().encode("Data;Descricao;Valor\n07/07/2026;Venda;32,00"),
    });
    expect(ai.chamado).toBe(true);
  });

  it("PDF sem texto extraivel (escaneado) vai para a IA", async () => {
    const ai = fakeAi([]);
    const h = new HybridStatementParser({ ai, pdfText: extractor([""]) });
    await h.parse(pdfRaw);
    expect(ai.chamado).toBe(true);
  });
});

describe("MemoPageTextExtractor — o PDF nao e renderizado duas vezes", () => {
  it("chamadas repetidas para os mesmos bytes reusam a extracao", async () => {
    let chamadas = 0;
    const memo = new MemoPageTextExtractor({
      extractPages: async () => {
        chamadas++;
        return pages;
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await Promise.all([memo.extractPages(bytes), memo.extractPages(bytes)]);
    await memo.extractPages(bytes);
    expect(chamadas).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { partitionByCompetence } from "../src/application/partitionByCompetence";
import { deduplicate } from "../src/application/deduplicate";
import { toSheetRows } from "../src/application/writeToSpreadsheet";
import { importStatement } from "../src/application/importStatement";
import { DONA_MARI_LAYOUT } from "../src/domain/layout";
import { Money } from "../src/domain/money";
import { parseDatePtBr } from "../src/domain/dateptbr";
import { Transaction } from "../src/domain/transaction";
import { withDedupHashes } from "../src/domain/transaction";
import {
  MockSpreadsheet,
  MemoryLedger,
  RecordingBackup,
  FixedClock,
  StubParser,
} from "./mocks";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (f: string) => JSON.parse(readFileSync(join(here, "fixtures", f), "utf-8"));

/**
 * Conjunto real de 358 transacoes do extrato Stone, CONGELADO em fixture
 * (stone_transactions.json) na migracao para IA. Estes testes exercitam o
 * ORQUESTRADOR e o DOMINIO (que nao mudaram), independentes de como as
 * transacoes foram extraidas. Gerado uma vez a partir do extrato real.
 */
interface SerTx {
  date: Transaction["date"];
  description: string;
  direction: Transaction["direction"];
  amountCents: number;
  account: { id: string; label: string };
  sourceOrder: number;
  balanceAfterCents: number | null;
}
const stoneTxs = (): Transaction[] =>
  (readJson("stone_transactions.json") as SerTx[]).map((s) => ({
    date: s.date,
    description: s.description,
    direction: s.direction,
    amount: Money.fromCents(s.amountCents),
    account: s.account,
    sourceOrder: s.sourceOrder,
    rawLine: "",
    ...(s.balanceAfterCents !== null
      ? { balanceAfter: Money.fromCents(s.balanceAfterCents) }
      : {}),
  }));

const acc = { id: "stone-x", label: "Stone" };
const tx = (over: Partial<Transaction> & { date: Transaction["date"] }): Transaction => ({
  description: "PIX",
  direction: "credit",
  amount: Money.fromReais(25),
  account: acc,
  sourceOrder: 0,
  rawLine: "",
  ...over,
});

describe("PartitionByCompetence (T-ROUTE)", () => {
  it("roteia julho->JULHO (286) e agosto->AGOSTO (72)", () => {
    const parts = partitionByCompetence(stoneTxs());
    const jul = parts.find((p) => p.key === "2026-07")!;
    const aug = parts.find((p) => p.key === "2026-08")!;
    expect(jul.targetSheet).toBe("JULHO");
    expect(jul.transactions.length).toBe(286);
    expect(aug.targetSheet).toBe("AGOSTO");
    expect(aug.transactions.length).toBe(72);
  });
});

describe("Deduplicate (idempotencia + C4)", () => {
  it("separa novos de duplicados por hash conhecido", () => {
    const txs = stoneTxs();
    const known = new Set(withDedupHashes(txs).slice(0, 100).map((h) => h.hash));
    const r = deduplicate(txs, known);
    expect(r.duplicados.length).toBe(100);
    expect(r.novos.length).toBe(txs.length - 100);
  });

  it("T-IDEM: reprocessar tudo com todos os hashes conhecidos => 0 novos", () => {
    const txs = stoneTxs();
    const allKnown = new Set(withDedupHashes(txs).map((h) => h.hash));
    const r = deduplicate(txs, allKnown);
    expect(r.novos.length).toBe(0);
    expect(r.duplicados.length).toBe(txs.length);
  });

  it("3 Pix identicos no mesmo dia sao todos NOVOS (nao colapsam)", () => {
    const d = parseDatePtBr("04/08/26");
    const three = [
      tx({ date: d, sourceOrder: 0 }),
      tx({ date: d, sourceOrder: 1 }),
      tx({ date: d, sourceOrder: 2 }),
    ];
    const r = deduplicate(three, new Set());
    expect(r.novos.length).toBe(3);
  });

  // Contrato alterado a pedido: a identidade de um lancamento e data + valor +
  // direcao + ordem. O nome nao entra na decisao — mas divergencia de nome e
  // registrada para auditoria em vez de bloquear a importacao.
  it("mesma data/valor/direcao com descricao divergente e duplicata, e fica registrada", () => {
    const d = parseDatePtBr("04/08/26");
    const novo = tx({ date: d, description: "FULANO PIX" });
    const existing = [tx({ date: d, description: "BELTRANO PIX" })];
    const r = deduplicate([novo], new Set(), existing);
    expect(r.duplicados.length).toBe(1);
    expect(r.novos.length).toBe(0);
    expect(r.inconsistencias.length).toBe(0); // nao bloqueia mais
    expect(r.duplicadosNomeDivergente.length).toBe(1);
    expect(r.duplicadosNomeDivergente[0].naPlanilha).toBe("BELTRANO PIX");
  });
});

describe("WriteToSpreadsheet (T-NOFORMULA)", () => {
  it("SheetRow so carrega B,C,D,F,G — nunca A,E,H", () => {
    const rows = toSheetRows(withDedupHashes(stoneTxs().slice(0, 5)));
    for (const r of rows) {
      // a data viaja em duas formas (serial + texto) porque o writer escolhe
      // qual gravar pela convencao da aba — mas nenhuma coluna de formula entra
      expect(Object.keys(r).sort()).toEqual(
        ["category", "dateSerial", "dateText", "description", "entradaCents", "saidaCents"].sort(),
      );
      // uma direcao preenchida, a outra null (nunca ambas)
      expect(r.entradaCents === null || r.saidaCents === null).toBe(true);
    }
  });

  it("credito preenche entrada; debito preenche saida", () => {
    const d = parseDatePtBr("07/08/26");
    const rows = toSheetRows(
      withDedupHashes([
        tx({ date: d, direction: "credit", amount: Money.fromReais(32) }),
        tx({ date: d, direction: "debit", amount: Money.fromReais(24) }),
      ]),
    );
    const cred = rows.find((r) => r.entradaCents !== null)!;
    const deb = rows.find((r) => r.saidaCents !== null)!;
    expect(cred.entradaCents).toBe(3200);
    expect(cred.saidaCents).toBeNull();
    expect(deb.saidaCents).toBe(2400);
    expect(deb.entradaCents).toBeNull();
  });
});

describe("ImportStatement — orquestrador", () => {
  const layout = DONA_MARI_LAYOUT;
  const raw = { fileName: "extrato.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) };

  it("escreve julho e agosto nas abas certas e conta novos", async () => {
    const local = new MockSpreadsheet();
    const rep = await importStatement(raw, {
      parser: new StubParser(stoneTxs()),
      local,
      ledger: new MemoryLedger(),
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout,
      localFileId: "fluxo.xlsx",
    });
    expect(rep.competences.map((c) => c.targetSheet).sort()).toEqual(["AGOSTO", "JULHO"]);
    const jul = rep.competences.find((c) => c.targetSheet === "JULHO")!;
    expect(jul.novos.length).toBe(286);
    expect(jul.writtenToLocal).toBe(true);
    // escreveu nas duas abas
    expect(local.appended.map((a) => a.sheet).sort()).toEqual(["AGOSTO", "JULHO"]);
  });

  it("T-BACKUP: backup ocorre ANTES de qualquer escrita", async () => {
    const timeline: string[] = [];
    const local = new MockSpreadsheet();
    local.timeline = timeline;
    await importStatement(raw, {
      parser: new StubParser(stoneTxs()),
      local,
      ledger: new MemoryLedger(),
      backup: new RecordingBackup(timeline),
      clock: new FixedClock(),
      layout,
      localFileId: "fluxo.xlsx",
    });
    expect(timeline[0]).toBe("backup");
    expect(timeline.includes("append")).toBe(true);
    expect(timeline.indexOf("backup")).toBeLessThan(timeline.indexOf("append"));
  });

  it("T-IDEM: rodar o MESMO extrato 2x insere 0 na segunda vez", async () => {
    const local = new MockSpreadsheet();
    const ledger = new MemoryLedger();
    const deps = {
      parser: new StubParser(stoneTxs()),
      local,
      ledger,
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout,
      localFileId: "fluxo.xlsx",
    };
    const r1 = await importStatement(raw, deps);
    const r2 = await importStatement(raw, deps);
    expect(r1.totals.novos).toBe(358);
    expect(r2.totals.novos).toBe(0);
  });

  it("T-INDEP: se o Sheets falha, o local ainda grava (e o relatorio indica)", async () => {
    const local = new MockSpreadsheet();
    const sheets = new MockSpreadsheet();
    sheets.failOnAppend = true;
    const rep = await importStatement(raw, {
      parser: new StubParser(stoneTxs()),
      local,
      sheets,
      ledger: new MemoryLedger(),
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout,
      localFileId: "fluxo.xlsx",
    });
    const jul = rep.competences.find((c) => c.targetSheet === "JULHO")!;
    expect(jul.writtenToLocal).toBe(true);
    expect(jul.writtenToSheets).toBe(false);
    expect(rep.sheetsError).toBeTruthy();
    expect(local.appended.length).toBeGreaterThan(0);
  });

  it("aba inexistente para a competencia vira inconsistencia (nao escreve)", async () => {
    const local = new MockSpreadsheet(["JULHO", "Categorias"]); // sem AGOSTO
    const rep = await importStatement(raw, {
      parser: new StubParser(stoneTxs()),
      local,
      ledger: new MemoryLedger(),
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout,
      localFileId: "fluxo.xlsx",
    });
    const aug = rep.competences.find((c) => c.targetSheet === "AGOSTO")!;
    expect(aug.sheetExists).toBe(false);
    expect(aug.inconsistencias.some((i) => /aba inexistente/.test(i.motivo))).toBe(true);
    // nao deve ter escrito AGOSTO
    expect(local.appended.some((a) => a.sheet === "AGOSTO")).toBe(false);
  });
});

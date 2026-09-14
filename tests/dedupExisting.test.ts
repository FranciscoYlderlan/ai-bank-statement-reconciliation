import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deduplicate } from "../src/application/deduplicate";
import { importStatement } from "../src/application/importStatement";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import { DONA_MARI_LAYOUT, SheetRow } from "../src/domain/layout";
import { Money } from "../src/domain/money";
import { Transaction } from "../src/domain/transaction";
import { MemoryLedger, RecordingBackup, FixedClock, StubParser } from "./mocks";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

/** Arquivo XML da aba dentro do .xlsx real (ordem das abas do template). */
const SHEET_FILES: Record<string, string> = {
  MAIO: "xl/worksheets/sheet8.xml",
  JULHO: "xl/worksheets/sheet10.xml",
};
const sheetFileOf = (name: string) => SHEET_FILES[name];

async function sheetXmlOf(bytes: Uint8Array, file: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(file)!.async("string");
}

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

const d = { year: 2026, month: 8, day: 4 };

/**
 * O defeito relatado: fornecendo a planilha ja atualizada como base, o mesmo
 * extrato era gravado de novo. A causa eram duas — as linhas ja existentes na
 * aba nunca entravam no dedup, e a data delas era lida errado (indice de
 * sharedString tratado como serial do Excel). Estes testes cobrem as duas.
 */
describe("Deduplicate contra o que JA esta na aba", () => {
  it("lancamento identico ao que ja esta na planilha nao volta como novo", () => {
    const existente = [tx({ date: d, description: "FULANO DE TAL | Pix" })];
    const r = deduplicate([tx({ date: d, description: "FULANO DE TAL | Pix" })], new Set(), existente);
    expect(r.novos.length).toBe(0);
    expect(r.duplicados.length).toBe(1);
  });

  it("a MESMA contraparte escrita de outro jeito e reconhecida (sufixo societario)", () => {
    const existente = [tx({ date: d, description: "JOAO SILVA COMERCIO | Pix" })];
    const r = deduplicate(
      [tx({ date: d, description: "JOAO SILVA COMERCIO LTDA | Pix" })],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(1);
    expect(r.novos.length).toBe(0);
  });

  it("a MESMA contraparte com e sem o tipo do lancamento tambem casa", () => {
    // a planilha do usuario guarda so o nome; a extracao escreve "NOME | TIPO"
    const existente = [tx({ date: d, description: "Lucas Freire Tavares Braga" })];
    const r = deduplicate(
      [tx({ date: d, description: "LUCAS FREIRE TAVARES | Transferência Pix" })],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(1);
  });
});

/**
 * IDENTIDADE = data + valor (ao centavo) + direcao + ordem. O nome NAO decide.
 *
 * O que protege contra fundir coisa distinta e a CONTAGEM, nao o nome: cada
 * linha existente absorve no maximo um lancamento. Estes testes fixam as duas
 * pontas — o que passa a ser duplicata, e o que continua entrando como novo.
 */
describe("identidade por data + valor + direcao + ordem (nome nao decide)", () => {
  it("nome diferente, mas mesmo dia/valor/direcao: e o MESMO lancamento", () => {
    const existente = [tx({ date: d, description: "MARIA DA SILVA SANTOS" })];
    const r = deduplicate([tx({ date: d, description: "MARIA DA SILVA SOUZA" })], new Set(), existente);
    expect(r.duplicados.length).toBe(1);
    expect(r.novos.length).toBe(0);
  });

  it("divergencia de nome nao bloqueia, mas fica registrada para auditoria", () => {
    const existente = [tx({ date: d, description: "ANA PEREIRA" })];
    const r = deduplicate([tx({ date: d, description: "ANA RODRIGUES" })], new Set(), existente);
    expect(r.duplicados.length).toBe(1);
    expect(r.inconsistencias.length).toBe(0);
    expect(r.duplicadosNomeDivergente.length).toBe(1);
    expect(r.duplicadosNomeDivergente[0].tx.description).toBe("ANA RODRIGUES");
    expect(r.duplicadosNomeDivergente[0].naPlanilha).toBe("ANA PEREIRA");
  });

  it("nome que BATE nao entra na lista de auditoria", () => {
    const existente = [tx({ date: d, description: "JOAO SILVA | Pix" })];
    const r = deduplicate([tx({ date: d, description: "JOAO SILVA LTDA" })], new Set(), existente);
    expect(r.duplicados.length).toBe(1);
    expect(r.duplicadosNomeDivergente.length).toBe(0);
  });

  it("A CONTAGEM e a protecao: 1 na planilha e 2 nomes distintos no extrato => 1 novo", () => {
    // exatamente o cenario de dois clientes pagando o mesmo valor no mesmo dia:
    // a segunda venda NAO some, porque nao sobra slot livre para ela
    const existente = [tx({ date: d, description: "MARIA SILVA", sourceOrder: 0 })];
    const r = deduplicate(
      [
        tx({ date: d, description: "MARIA SILVA", sourceOrder: 0 }),
        tx({ date: d, description: "ANA SOUZA", sourceOrder: 1 }),
      ],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(1);
    expect(r.novos.length).toBe(1);
    expect(r.novos[0].tx.description).toBe("ANA SOUZA");
    // o slot foi consumido pelo nome que bate, entao nao ha alarme falso
    expect(r.duplicadosNomeDivergente.length).toBe(0);
  });

  it("o pareamento prefere o nome certo mesmo com o extrato fora de ordem", () => {
    const existente = [
      tx({ date: d, description: "MARIA SILVA", sourceOrder: 0 }),
      tx({ date: d, description: "ANA SOUZA", sourceOrder: 1 }),
    ];
    const r = deduplicate(
      [
        tx({ date: d, description: "ANA SOUZA", sourceOrder: 0 }),
        tx({ date: d, description: "MARIA SILVA", sourceOrder: 1 }),
      ],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(2);
    expect(r.duplicadosNomeDivergente.length).toBe(0);
  });

  it("nome IDENTICO mas em DIA diferente e outra transacao (nao duplicata)", () => {
    const existente = [tx({ date: d, description: "FULANO DE TAL | Pix" })];
    const r = deduplicate(
      [tx({ date: { ...d, day: 5 }, description: "FULANO DE TAL | Pix" })],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(0);
    expect(r.novos.length).toBe(1);
  });

  it("nome IDENTICO e mesmo dia, mas VALOR diferente, e outra transacao", () => {
    const existente = [tx({ date: d, description: "FULANO DE TAL | Pix" })];
    const r = deduplicate(
      [tx({ date: d, description: "FULANO DE TAL | Pix", amount: Money.fromReais(30) })],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(0);
    expect(r.novos.length).toBe(1);
  });

  it("nome IDENTICO, mesmo dia e mesmo valor, mas DIRECAO oposta, e outra transacao", () => {
    const existente = [tx({ date: d, description: "FULANO DE TAL | Pix", direction: "credit" })];
    const r = deduplicate(
      [tx({ date: d, description: "FULANO DE TAL | Pix", direction: "debit" })],
      new Set(),
      existente,
    );
    expect(r.duplicados.length).toBe(0);
    expect(r.novos.length).toBe(1);
  });

  it("casamento POR CONSUMO: 2 na planilha e 3 no extrato => 1 novo", () => {
    const existente = [
      tx({ date: d, description: "PIX RECEBIDO", sourceOrder: 0 }),
      tx({ date: d, description: "PIX RECEBIDO", sourceOrder: 1 }),
    ];
    const entrando = [
      tx({ date: d, description: "PIX RECEBIDO", sourceOrder: 0 }),
      tx({ date: d, description: "PIX RECEBIDO", sourceOrder: 1 }),
      tx({ date: d, description: "PIX RECEBIDO", sourceOrder: 2 }),
    ];
    const r = deduplicate(entrando, new Set(), existente);
    expect(r.duplicados.length).toBe(2);
    expect(r.novos.length).toBe(1);
  });

  it("transacao realmente nova continua entrando mesmo com a aba cheia", () => {
    const existente = [tx({ date: d, description: "FULANO | Pix" })];
    const r = deduplicate(
      [tx({ date: d, description: "MERCADO CENTRAL | Boleto", amount: Money.fromReais(987.65) })],
      new Set(),
      existente,
    );
    expect(r.novos.length).toBe(1);
  });
});

describe("XlsxSurgicalWriter.readExisting — leitura fiel da planilha real", () => {
  it("le as datas gravadas como TEXTO (sharedString), nao como serial", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const existentes = await w.readExisting("MAIO", DONA_MARI_LAYOUT);
    expect(existentes.length).toBeGreaterThan(100);
    // todas dentro da competencia da propria aba — se o indice da sharedString
    // fosse tratado como serial, cairiam em 1900.
    for (const t of existentes.slice(0, 50)) {
      expect(t.date.year).toBe(2026);
      expect(t.date.month).toBe(5);
    }
    expect(existentes.some((t) => t.amount.cents > 0)).toBe(true);
  });
});

/**
 * T-DATA: a data tem de aparecer como DATA na planilha, nao como serial cru.
 *
 * Defeito observado no arquivo entregue ao usuario:
 *   09/05/2026   Transferência saldo conta PF   ...   (linha que ja existia)
 *   46169        Visa Electron / Débito         ...   (linha gravada por nos)
 *
 * Duas causas somadas, ambas so aparecem nas abas que o usuario JA usou:
 *  a) a coluna de data guarda TEXTO "dd/mm/aaaa", e gravavamos serial;
 *  b) na primeira linha livre dessas abas a celula B nem existe, entao a celula
 *     nascia SEM estilo — General — e o serial virava numero na tela.
 */
describe("T-DATA: a data gravada aparece como data, nunca como serial", () => {
  const row = (over: Partial<SheetRow> = {}): SheetRow => ({
    dateSerial: 46169,
    dateText: "27/05/2026",
    description: "Visa Electron / Débito",
    category: null,
    entradaCents: null,
    saidaCents: 2451,
    ...over,
  });

  it("aba que guarda data como TEXTO recebe dd/mm/aaaa, nao o serial", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows("MAIO", [row()], DONA_MARI_LAYOUT);
    const xml = await sheetXmlOf(await w.toBytes(), sheetFileOf("MAIO"));
    const r = outcome.firstRow;
    const cel = xml.match(new RegExp(`<c r="B${r}"[^>]*(?:/>|>[\\s\\S]*?</c>)`))![0];
    expect(cel).toContain("27/05/2026");
    expect(cel).not.toContain("46169");
  });

  it("a data gravada volta legivel na releitura (fecha o ciclo com o dedup)", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows("MAIO", [row()], DONA_MARI_LAYOUT);
    const relidas = await w.readExisting("MAIO", DONA_MARI_LAYOUT);
    const nossa = relidas.find((t) => t.description === "Visa Electron / Débito")!;
    expect(nossa).toBeTruthy();
    expect(nossa.date).toEqual({ year: 2026, month: 5, day: 27 });
    expect(nossa.amount.cents).toBe(2451);
  });

  it("aba com estilo de data (numFmt) continua recebendo serial de verdade", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows("JULHO", [row({ dateSerial: 46210, dateText: "07/07/2026" })], DONA_MARI_LAYOUT);
    const xml = await sheetXmlOf(await w.toBytes(), sheetFileOf("JULHO"));
    const cel = xml.match(new RegExp(`<c r="B${outcome.firstRow}"[^>]*(?:/>|>[\\s\\S]*?</c>)`))![0];
    expect(cel).toContain("<v>46210</v>");
    expect(cel).toContain('s="74"'); // estilo com numFmtId=14 (data)
  });

  it("celula inexistente na linha de destino herda o estilo da coluna", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows("MAIO", [row()], DONA_MARI_LAYOUT);
    const xml = await sheetXmlOf(await w.toBytes(), sheetFileOf("MAIO"));
    const cel = xml.match(new RegExp(`<c r="B${outcome.firstRow}"[^>]*(?:/>|>[\\s\\S]*?</c>)`))![0];
    // sem herança a celula sairia sem s="..." e o valor apareceria sem formato
    expect(cel).toMatch(/\ss="\d+"/);
  });
});

describe("T-IDEM-BASE: reimportar sobre a planilha ja atualizada nao duplica", () => {
  const raw = { fileName: "extrato.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) };

  it("os lancamentos que ja estao na aba voltam como duplicados; so o inedito entra", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const jaNaPlanilha = await w.readExisting("MAIO", DONA_MARI_LAYOUT);
    expect(jaNaPlanilha.length).toBeGreaterThan(20);

    // o extrato traz de volta 20 lancamentos que ja estao la + 1 inedito
    const relidos = jaNaPlanilha.slice(0, 20).map((t, i) => ({
      ...t,
      account: acc, // outra conta de origem: nao pode mascarar a duplicata
      sourceOrder: i,
      rawLine: "",
    }));
    const inedito = tx({
      date: { year: 2026, month: 5, day: 20 },
      description: "LANCAMENTO INEDITO PARA O TESTE",
      amount: Money.fromCents(777_77),
      sourceOrder: 20,
    });

    const rep = await importStatement(raw, {
      parser: new StubParser([...relidos, inedito]),
      local: w,
      ledger: new MemoryLedger(), // ledger vazio: e a ABA que tem de barrar
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout: DONA_MARI_LAYOUT,
      localFileId: "fluxo.xlsx",
    });

    const maio = rep.competences.find((c) => c.targetSheet === "MAIO")!;
    expect(maio.duplicados).toBe(20);
    expect(maio.novos.length).toBe(1);
    expect(maio.novos[0].description).toBe("LANCAMENTO INEDITO PARA O TESTE");
  });
});
